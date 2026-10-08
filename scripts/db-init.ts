import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closePool, findRepoRoot, getPool, loadEnv } from "../packages/shared/src/index.ts";
import { refreshChainViews } from "../packages/ops/src/schemas.ts";

loadEnv();

const password = process.env.APP_RO_PASSWORD;
if (!password) {
  console.error("Set APP_RO_PASSWORD before running pnpm db:init");
  process.exit(1);
}
if (password.includes("\0") || password.includes("\n")) {
  console.error("APP_RO_PASSWORD cannot contain newlines");
  process.exit(1);
}

const root = findRepoRoot();
const files = ["sql/001_schemas_roles.sql", "sql/002_app_read.sql"];
const pool = getPool();
for (const file of files) {
  let sql = readFileSync(join(root, file), "utf8");
  if (file.endsWith("001_schemas_roles.sql")) {
    sql = sql.replaceAll("__APP_RO_PASSWORD__", password.replaceAll("'", "''"));
  }
  await pool.query(sql);
  console.log(`Applied ${file}`);
}
await refreshChainViews();
console.log("Refreshed read views");
await closePool();
