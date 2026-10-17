import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closePool, findRepoRoot, getPool, loadEnv } from "../packages/shared/src/index.ts";
import { ensureReadModel } from "../packages/ops/src/schemas.ts";

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

/**
 * Postgres accepts a precomputed SCRAM-SHA-256 verifier in place of a password. Sending the verifier
 * keeps the password itself out of the server log, which records DDL under log_statement.
 */
function scramVerifier(password: string): string {
  const iterations = 4096;
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const root = findRepoRoot();
const files = ["sql/001_schemas_roles.sql", "sql/002_app_read.sql", "sql/003_chain_tables.sql"];
const pool = getPool();
const legacy = await pool.query<{ relkind: string }>(
  `SELECT c.relkind::text AS relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'erc8004' AND c.relname = 'agents'`,
);
if (legacy.rows[0]?.relkind === "v") {
  console.error("erc8004.agents is still the old Ponder view. Stop the supervisor and run pnpm migrate:ponder once.");
  process.exit(1);
}
for (const file of files) {
  let sql = readFileSync(join(root, file), "utf8");
  if (file.endsWith("001_schemas_roles.sql")) {
    sql = sql.replaceAll("__APP_RO_PASSWORD__", scramVerifier(password));
  }
  await pool.query(sql);
  console.log(`Applied ${file}`);
}
await ensureReadModel();
console.log("Refreshed read views");
await closePool();
