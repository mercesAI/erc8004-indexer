import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { closePool, getPool, isChainKey, loadEnv } from "../packages/shared/src/index.ts";
import { chainSchema, dropSchema, refreshChainViews } from "../packages/ops/src/schemas.ts";

loadEnv();

const chainFlag = process.argv.indexOf("--chain");
const chainArg = chainFlag >= 0 ? process.argv[chainFlag + 1] : undefined;
const all = process.argv.includes("--all");

if (all === Boolean(chainArg) || (chainArg != null && !isChainKey(chainArg))) {
  console.error("Usage: pnpm reset:ponder --chain <key>");
  console.error("       pnpm reset:ponder --all");
  process.exit(1);
}

if (!input.isTTY) {
  console.error("Refusing to drop chain data without a terminal. Run pnpm reset:ponder in a TTY.");
  process.exit(1);
}

const target = all ? "every chain schema" : `schema ${chainSchema(chainArg ?? "")}`;
const rl = readline.createInterface({ input, output });
const answer = await rl.question(`This drops ${target}. enrich and mirror stay. Type yes: `);
rl.close();
if (answer.trim() !== "yes") {
  console.error("Aborted");
  process.exit(1);
}

const pool = getPool();
if (all) {
  const schemas = await pool.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'erc8004\\_%' ESCAPE '\\'",
  );
  for (const schema of schemas.rows) await dropSchema(schema.nspname);
  await pool.query("DELETE FROM ops.chain_index");
  await pool.query("DELETE FROM ops.indexer_build");
  console.log(`Dropped ${schemas.rows.length} chain schemas`);
} else if (chainArg) {
  await dropSchema(chainSchema(chainArg));
  await pool.query("DELETE FROM ops.chain_index WHERE chain = $1", [chainArg]);
  console.log(`Dropped ${chainSchema(chainArg)}`);
}
await refreshChainViews();
console.log("Refreshed read views. Restart pnpm ops so Ponder starts that chain from its checkpoint block.");
await closePool();
