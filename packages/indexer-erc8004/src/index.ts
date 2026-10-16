import { createServer } from "node:http";
import { enabledChains, envInt, getPool, log, redactSecrets } from "@merces/shared";
import { EVENTS_RETENTION_DAYS, registryAddresses } from "./apply.js";
import { ensureCursor, newState, runCycle, type ChainState } from "./sync.js";

/**
 * ERC-8004 indexer. Each enabled chain is polled on its own schedule (INDEX_INTERVAL_SEC, default 300,
 * per chain INDEX_INTERVAL_SEC_<CHAIN>). A cycle costs one eth_blockNumber plus one eth_getLogs per
 * 2,000 new blocks for all three registries together. No blocks or transactions are downloaded:
 * eth_getLogs returns blockTimestamp, which is the only block field the tables use.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let paused = false;
let stopping = false;

async function isPaused(): Promise<boolean> {
  const result = await getPool().query<{ paused: boolean }>("SELECT paused FROM ops.worker_control WHERE worker = 'indexer'");
  paused = result.rows[0]?.paused ?? false;
  return paused;
}

async function recordError(state: ChainState, message: string): Promise<void> {
  state.lastError = message;
  await getPool()
    .query("UPDATE erc8004.cursors SET last_error = $2, updated_at = now() WHERE chain = $1", [state.key, message.slice(0, 2000)])
    .catch(() => undefined);
}

async function chainLoop(state: ChainState, addresses: ReturnType<typeof registryAddresses>): Promise<void> {
  let failures = 0;
  while (!stopping) {
    if (await isPaused().catch(() => false)) {
      await sleep(5000);
      continue;
    }
    try {
      await runCycle(state, addresses);
      failures = 0;
    } catch (error) {
      failures += 1;
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      await recordError(state, message);
      const delay = Math.min(state.intervalSec * 1000, 5000 * 2 ** Math.min(failures, 6));
      log("error", "cycle failed", { chain: state.key, error: message, retryInMs: delay });
      await sleep(delay);
      continue;
    }
    if (!state.catchingUp) await sleep(state.intervalSec * 1000);
  }
}

async function pruneEvents(): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - EVENTS_RETENTION_DAYS * 86_400;
  await getPool().query("DELETE FROM erc8004.events WHERE block_time < $1", [cutoff]);
}

function startHealth(states: ChainState[]): void {
  const port = envInt("HEALTH_PORT", 42073);
  createServer((req, res) => {
    if (!req.url?.startsWith("/health")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        paused,
        chains: Object.fromEntries(
          states.map((state) => [
            state.key,
            {
              chainId: state.chainId,
              startBlock: state.startBlock,
              lastBlock: state.lastBlock,
              headBlock: state.headBlock,
              confirmations: state.confirmations,
              intervalSec: state.intervalSec,
              catchingUp: state.catchingUp,
              lastRunAt: state.lastRunAt,
              lastError: state.lastError,
              events: state.events,
              rpcRequests: state.counters.requests,
              rpcErrors: state.counters.errors,
            },
          ]),
        ),
      }),
    );
  }).listen(port, "127.0.0.1");
}

async function main(): Promise<void> {
  const ready = await getPool().query<{ rel: string | null }>("SELECT to_regclass('erc8004.cursors')::text AS rel");
  if (!ready.rows[0]?.rel) throw new Error("erc8004.cursors is missing. Run pnpm db:init (or pnpm migrate:ponder once).");
  const addresses = registryAddresses();
  const states = enabledChains().map(newState);
  for (const state of states) await ensureCursor(state);
  startHealth(states);
  log("info", "indexer started", {
    chains: states.map((state) => ({ chain: state.key, everySec: state.intervalSec, lastBlock: state.lastBlock })),
  });
  setInterval(() => {
    pruneEvents().catch((error: unknown) => log("warn", "event prune failed", { error: String(error) }));
  }, 60 * 60 * 1000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopping = true;
      setTimeout(() => process.exit(0), 200);
    });
  }
  await Promise.all(states.map((state) => chainLoop(state, addresses)));
}

main().catch((error: unknown) => {
  log("error", "indexer crashed", { error: redactSecrets(error instanceof Error ? error.message : String(error)) });
  process.exit(1);
});
