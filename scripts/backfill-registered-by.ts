import { closePool, enabledChains, envInt, getPool, loadEnv, log } from "../packages/shared/src/index.ts";
import { decodeLogs, registryAddresses } from "../packages/indexer-erc8004/src/apply.ts";
import { blockNumber, getLogs, type ChainCounters } from "../packages/indexer-erc8004/src/rpc.ts";

/**
 * Fill erc8004.agents.registered_by, the address register() was called from, for agents indexed
 * before the column existed. Reads the Registered events again in ETH_GET_LOGS_BLOCK_RANGE windows,
 * but only the windows that still hold an agent without registered_by, so a run after an interruption
 * costs only what is left. Cost: one eth_getLogs (60 compute units) per window; full Base history is
 * about 5,700 windows. Set a lower ALCHEMY_MAX_RPS while the indexer runs on the same key. A window
 * that fails is reported and skipped; the exit code is 1 when any did, and a second run picks it up.
 *
 *   pnpm backfill:registered-by
 */

loadEnv();
const range = envInt("ETH_GET_LOGS_BLOCK_RANGE", 2000);
const pool = getPool();
const addresses = registryAddresses();

for (const chain of enabledChains()) {
  const windows = await pool.query<{ window: string; n: string }>(
    `SELECT floor(registered_block / $2)::bigint::text AS window, count(*)::text AS n
     FROM erc8004.agents
     WHERE chain_id = $1 AND registered_by IS NULL AND registered_block IS NOT NULL
     GROUP BY 1 ORDER BY 1`,
    [chain.chainId, range],
  );
  const missing = windows.rows.reduce((sum, row) => sum + Number(row.n), 0);
  log("info", "backfill registered_by", { chain: chain.key, windows: windows.rows.length, agents: missing });
  const counters: ChainCounters = { requests: 0, errors: 0 };
  // The last window reaches past the head, which the provider refuses; windows stop at the head.
  const head = windows.rows.length > 0 ? await blockNumber(chain.rpcUrl, counters) : 0;
  let filled = 0;
  let failedWindows = 0;
  for (const [index, row] of windows.rows.entries()) {
    const from = Number(row.window) * range;
    const to = Math.min(from + range - 1, head);
    try {
      const logs = await getLogs(chain.rpcUrl, [addresses.identity], from, to, counters);
      const registered = decodeLogs(logs, addresses).events.filter((event) => event.name === "Registered");
      if (registered.length > 0) {
        // updated_at moves so the publisher job looks at these agents again.
        const result = await pool.query(
          `UPDATE erc8004.agents a
           SET registered_by = u.minter, updated_at = now()
           FROM unnest($2::numeric[], $3::text[]) AS u(agent_id, minter)
           WHERE a.chain_id = $1 AND a.agent_id = u.agent_id AND a.registered_by IS NULL`,
          [chain.chainId, registered.map((event) => String(event.args.agentId)), registered.map((event) => String(event.args.owner).toLowerCase())],
        );
        filled += result.rowCount ?? 0;
      }
    } catch (error) {
      failedWindows += 1;
      log("error", "backfill window failed", { chain: chain.key, from, to, error: error instanceof Error ? error.message : String(error) });
    }
    if ((index + 1) % 100 === 0 || index + 1 === windows.rows.length) {
      log("info", "backfill progress", {
        chain: chain.key,
        windows: `${index + 1}/${windows.rows.length}`,
        filled,
        failedWindows,
        requests: counters.requests,
        errors: counters.errors,
      });
    }
  }
  const left = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM erc8004.agents WHERE chain_id = $1 AND registered_by IS NULL", [chain.chainId]);
  log("info", "backfill done", { chain: chain.key, filled, failedWindows, stillMissing: Number(left.rows[0]?.n ?? 0) });
  if (failedWindows > 0) process.exitCode = 1;
}
await closePool();
