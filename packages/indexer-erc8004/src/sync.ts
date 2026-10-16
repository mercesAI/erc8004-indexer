import { confirmationsFor, envInt, getPool, log, type EnabledChain, type RegistryKind } from "@merces/shared";
import { applyEvents, decodeLogs } from "./apply.js";
import { blockNumber, getLogs, type ChainCounters } from "./rpc.js";

/** At most this many eth_getLogs chunks per cycle. A chain further behind continues on the next cycle at once. */
const MAX_CHUNKS_PER_CYCLE = 250;
/** eth_getLogs requests in flight per chain during a catch-up. The process-wide rate limit still applies. */
const PREFETCH = 4;

export type ChainState = {
  key: string;
  chainId: number;
  url: string;
  startBlock: number;
  intervalSec: number;
  confirmations: number;
  lastBlock: number | null;
  headBlock: number | null;
  lastRunAt: string | null;
  lastError: string | null;
  catchingUp: boolean;
  events: number;
  counters: ChainCounters;
};

export function intervalFor(key: string): number {
  return envInt(`INDEX_INTERVAL_SEC_${key.toUpperCase()}`, envInt("INDEX_INTERVAL_SEC", 300));
}

function logRange(): number {
  const value = envInt("ETH_GET_LOGS_BLOCK_RANGE", 2000);
  if (!Number.isInteger(value) || value < 1) throw new Error("ETH_GET_LOGS_BLOCK_RANGE must be an integer >= 1");
  return value;
}

export function newState(chain: EnabledChain): ChainState {
  return {
    key: chain.key,
    chainId: chain.chainId,
    url: chain.rpcUrl,
    startBlock: chain.startBlock,
    intervalSec: intervalFor(chain.key),
    confirmations: confirmationsFor(chain.key),
    lastBlock: null,
    headBlock: null,
    lastRunAt: null,
    lastError: null,
    catchingUp: true,
    events: 0,
    counters: { requests: 0, errors: 0 },
  };
}

/**
 * Create the cursor for a chain seen for the first time, starting just before START_BLOCK.
 * An existing cursor is never moved here: changing START_BLOCK later does not re-index anything.
 * `pnpm reindex --chain <key>` does that on purpose.
 */
export async function ensureCursor(state: ChainState): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO erc8004.cursors (chain, chain_id, start_block, last_block)
     VALUES ($1, $2, $3, $4) ON CONFLICT (chain) DO NOTHING`,
    [state.key, state.chainId, state.startBlock, state.startBlock - 1],
  );
  const row = await pool.query<{ start_block: string; last_block: string }>(
    "SELECT start_block::text, last_block::text FROM erc8004.cursors WHERE chain = $1",
    [state.key],
  );
  const stored = row.rows[0];
  if (stored && Number(stored.start_block) !== state.startBlock) {
    log("warn", "START_BLOCK differs from the stored cursor; nothing was re-indexed", {
      chain: state.key,
      env: state.startBlock,
      stored: Number(stored.start_block),
    });
  }
  state.lastBlock = stored ? Number(stored.last_block) : null;
}

/** Thrown when the cursor changed under a running cycle, for example by `pnpm reindex`. */
class CursorMoved extends Error {}

/**
 * Bring one chain up to (head - confirmations). Each chunk's events and the cursor move commit in
 * one transaction, so a crash leaves the tables and the cursor consistent.
 */
export async function runCycle(state: ChainState, addresses: Record<RegistryKind, string>): Promise<void> {
  const pool = getPool();
  const addressList = Object.values(addresses);
  const range = logRange();
  const head = await blockNumber(state.url, state.counters);
  state.headBlock = head;
  const target = head - state.confirmations;
  const cursor = await pool.query<{ last_block: string }>("SELECT last_block::text FROM erc8004.cursors WHERE chain = $1", [state.key]);
  let last = Number(cursor.rows[0]?.last_block ?? state.startBlock - 1);
  let chunks = 0;
  let cycleEvents = 0;
  // Up to PREFETCH ranges are requested ahead; they are still applied strictly in block order.
  const ranges: [number, number][] = [];
  for (let from = last + 1; from <= target && ranges.length < MAX_CHUNKS_PER_CYCLE; from += range) {
    ranges.push([from, Math.min(from + range - 1, target)]);
  }
  const pending: Promise<Awaited<ReturnType<typeof getLogs>>>[] = [];
  const request = (index: number) => {
    const next = ranges[index];
    if (!next) return;
    const promise = getLogs(state.url, addressList, next[0], next[1], state.counters);
    // A prefetched range may fail after an earlier one already ended the cycle; keep that from being unhandled.
    promise.catch(() => undefined);
    pending[index] = promise;
  };
  for (let index = 0; index < Math.min(PREFETCH, ranges.length); index++) request(index);
  try {
    for (let index = 0; index < ranges.length; index++) {
      const [from, to] = ranges[index] as [number, number];
      const logs = await (pending[index] as Promise<Awaited<ReturnType<typeof getLogs>>>);
      request(index + PREFETCH);
      const { events } = decodeLogs(logs, addresses);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query<{ last_block: string }>(
          "SELECT last_block::text FROM erc8004.cursors WHERE chain = $1 FOR UPDATE",
          [state.key],
        );
        if (Number(locked.rows[0]?.last_block) !== from - 1) throw new CursorMoved(`cursor for ${state.key} moved`);
        await applyEvents(client, state.chainId, events);
        await client.query(
          `UPDATE erc8004.cursors
           SET last_block = $2, head_block = $3, last_run_at = now(), last_error = NULL, updated_at = now()
           WHERE chain = $1`,
          [state.key, to, head],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      last = to;
      chunks += 1;
      cycleEvents += events.length;
    }
  } catch (error) {
    if (error instanceof CursorMoved) {
      log("info", "cursor moved during the cycle; starting over next cycle", { chain: state.key });
      state.catchingUp = true;
      return;
    }
    throw error;
  } finally {
    state.lastBlock = last;
    state.events += cycleEvents;
  }
  if (chunks === 0) {
    await pool.query("UPDATE erc8004.cursors SET head_block = $2, last_run_at = now(), last_error = NULL WHERE chain = $1", [
      state.key,
      head,
    ]);
  }
  state.catchingUp = last < target;
  state.lastRunAt = new Date().toISOString();
  state.lastError = null;
  if (cycleEvents > 0 || state.catchingUp) {
    log("info", "cycle", {
      chain: state.key,
      events: cycleEvents,
      chunks,
      lastBlock: last,
      behind: Math.max(0, target - last),
    });
  }
}
