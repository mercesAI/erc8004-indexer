import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { closePool, getPool, loadEnv } from "../packages/shared/src/index.ts";

/** After `pnpm migrate:ponder`: drop what Ponder left behind (its per-chain schemas, its RPC cache, its guards). */

loadEnv();
const pool = getPool();
const kind = await pool.query<{ relkind: string }>(
  `SELECT c.relkind::text AS relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'erc8004' AND c.relname = 'agents'`,
);
if (kind.rows[0]?.relkind !== "r") {
  console.error("erc8004.agents is not a table yet. Run pnpm migrate:ponder first.");
  process.exit(1);
}
const targets = await pool.query<{ name: string; size: string }>(`
  SELECT n.nspname AS name,
         pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint) AS size
  FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'm')
  WHERE n.nspname LIKE 'erc8004\\_%' ESCAPE '\\' OR n.nspname = 'ponder_sync'
  GROUP BY 1 ORDER BY 1`);
if (targets.rows.length === 0) {
  console.log("Nothing left from Ponder.");
  await closePool();
  process.exit(0);
}
console.log("This drops:");
for (const row of targets.rows) console.log(`  schema ${row.name} (${row.size})`);
console.log("  tables ops.chain_index and ops.indexer_build");
if (!input.isTTY) {
  console.error("Refusing to drop schemas without a terminal.");
  process.exit(1);
}
const rl = readline.createInterface({ input, output });
const answer = await rl.question("erc8004, enrich and mirror stay. Type yes: ");
rl.close();
if (answer.trim() !== "yes") {
  console.error("Aborted");
  process.exit(1);
}
for (const row of targets.rows) {
  if (!/^[a-z0-9_]+$/.test(row.name)) throw new Error(`Unexpected schema ${row.name}`);
  await pool.query(`DROP SCHEMA "${row.name}" CASCADE`);
  console.log(`Dropped ${row.name}`);
}
await pool.query("DROP TABLE IF EXISTS ops.chain_index, ops.indexer_build");
console.log("Done. Run VACUUM or wait for autovacuum; the files are already released by DROP.");
await closePool();
