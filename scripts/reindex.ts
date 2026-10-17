import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { closePool, envInt, getChain, getPool, isChainKey, loadEnv } from "../packages/shared/src/index.ts";

/**
 * Re-read a chain from the RPC.
 *   pnpm reindex --chain base               delete that chain's rows, start again from its start block
 *   pnpm reindex --chain base --from 4100000 keep the rows, replay logs from that block (handlers are idempotent)
 * The running indexer notices the moved cursor and continues from there. enrich rows are kept.
 * Cost: one eth_getLogs (60 compute units) per 2,000 blocks. Full Base history is about 5,500 calls.
 */

loadEnv();
const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const chain = arg("--chain");
const fromArg = arg("--from");
if (!chain || !isChainKey(chain) || (fromArg != null && !/^\d+$/.test(fromArg))) {
  console.error("Usage: pnpm reindex --chain <key> [--from <block>]");
  process.exit(1);
}
const pool = getPool();
const cursor = await pool.query<{ chain_id: number; start_block: string; last_block: string }>(
  "SELECT chain_id, start_block::text, last_block::text FROM erc8004.cursors WHERE chain = $1",
  [chain],
);
const row = cursor.rows[0];
if (!row) {
  console.error(`No cursor for ${chain}. Add it to CHAINS and start the supervisor; it begins at START_BLOCK on its own.`);
  process.exit(1);
}
const spec = getChain(chain);
const chainId = spec.chainId;
// Full mode begins at the configured start block (empty START_BLOCK_<CHAIN> means the registry's deploy block).
const configuredStart = envInt(spec.startBlockEnvVar, spec.identityDeployBlock);
const replayFrom = fromArg != null ? Number(fromArg) : configuredStart;
if (replayFrom > Number(row.last_block) + 1) {
  console.error(`--from ${replayFrom} is ahead of the cursor (${row.last_block}); that would skip blocks. Use a block at or below ${Number(row.last_block) + 1}.`);
  process.exit(1);
}
const plan = fromArg != null
  ? `replay ${chain} from block ${replayFrom} (now at ${row.last_block}); rows are kept`
  : `delete every ${chain} row in erc8004 and re-read from block ${replayFrom}`;
if (!input.isTTY) {
  console.error("Run pnpm reindex in a terminal.");
  process.exit(1);
}
const rl = readline.createInterface({ input, output });
const answer = await rl.question(`This will ${plan}. Type yes: `);
rl.close();
if (answer.trim() !== "yes") {
  console.error("Aborted");
  process.exit(1);
}
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT 1 FROM erc8004.cursors WHERE chain = $1 FOR UPDATE", [chain]);
  if (fromArg == null) {
    for (const table of ["agents", "agent_metadata", "feedback", "feedback_responses", "validations", "events"]) {
      const result = await client.query(`DELETE FROM erc8004.${table} WHERE chain_id = $1`, [chainId]);
      console.log(`Deleted ${result.rowCount} rows from erc8004.${table}`);
    }
  }
  await client.query(
    "UPDATE erc8004.cursors SET last_block = $2, start_block = $3, last_error = NULL, updated_at = now() WHERE chain = $1",
    [chain, replayFrom - 1, configuredStart],
  );
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}
console.log(`Cursor for ${chain} is now ${replayFrom - 1}. The running indexer picks it up on its next cycle.`);
await closePool();
