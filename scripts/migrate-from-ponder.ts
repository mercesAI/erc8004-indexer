import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closePool, findRepoRoot, getPool, loadEnv } from "../packages/shared/src/index.ts";
import { ensureReadModel } from "../packages/ops/src/schemas.ts";

/**
 * One-time move from Ponder to packages/indexer-erc8004.
 *
 * Before: erc8004.* are UNION ALL views over Ponder's per-chain schemas erc8004_<chain>.
 * After:  erc8004.* are real tables for every chain, and erc8004.cursors holds each chain's
 *         last applied block, taken from Ponder's checkpoint.
 *
 * Nothing Ponder wrote is dropped. erc8004_<chain> and ponder_sync stay until you remove them with
 * `pnpm cleanup:ponder`, so this can be rolled back by checking out the previous commit.
 * Run it with the supervisor stopped.
 */

loadEnv();

if (!process.argv.includes("--no-process-check")) try {
  const running = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes("ponder/dist/esm/bin/ponder.js") || line.includes("packages/ops/src/supervisor.ts"));
  if (running.length > 0) {
    console.error("Stop the supervisor (and every Ponder process) before migrating:");
    for (const line of running) console.error(`  ${line.slice(0, 160)}`);
    process.exit(1);
  }
} catch {
  // ps is unavailable; trust the operator.
}

const pool = getPool();
const kind = await pool.query<{ relkind: string }>(
  `SELECT c.relkind::text AS relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'erc8004' AND c.relname = 'agents'`,
);
if (kind.rows[0]?.relkind !== "v") {
  console.error("erc8004.agents is not the Ponder view. Nothing to migrate.");
  process.exit(1);
}
const other = await pool.query<{ name: string; relkind: string }>(
  `SELECT c.relname AS name, c.relkind::text AS relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'erc8004' AND c.relkind NOT IN ('v')`,
);
if (other.rows.length > 0) {
  console.error(`Schema erc8004 holds more than views (${other.rows.map((row) => row.name).join(", ")}). Refusing to drop it.`);
  process.exit(1);
}

const schemas = await pool.query<{ schema: string; chain: string; chain_id: string; checkpoint: string }>(`
  SELECT n.nspname AS schema, substr(n.nspname, 9) AS chain
  FROM pg_namespace n
  WHERE n.nspname LIKE 'erc8004\\_%' ESCAPE '\\'
  ORDER BY 1
`);
const chains: { schema: string; chain: string; chainId: number; lastBlock: number }[] = [];
for (const row of schemas.rows) {
  if (!/^[a-z0-9_]+$/.test(row.schema)) throw new Error(`Unexpected schema name ${row.schema}`);
  const checkpoint = await pool.query<{ chain_id: string; latest: string }>(
    `SELECT chain_id::text, latest_checkpoint AS latest FROM "${row.schema}"._ponder_checkpoint LIMIT 1`,
  );
  const latest = checkpoint.rows[0];
  if (!latest) throw new Error(`${row.schema} has no Ponder checkpoint`);
  // Ponder checkpoint: 10 digits block timestamp, 16 digits chain id, 16 digits block number, then event position.
  const lastBlock = Number(latest.latest.slice(26, 42));
  if (!Number.isSafeInteger(lastBlock) || lastBlock <= 0) throw new Error(`Cannot read the block from ${row.schema} checkpoint ${latest.latest}`);
  chains.push({ schema: row.schema, chain: row.chain, chainId: Number(latest.chain_id), lastBlock });
}
const startBlocks = new Map(
  (await pool.query<{ chain: string; start_block: string }>("SELECT chain, start_block::text FROM ops.chain_index").catch(() => ({ rows: [] }))).rows.map(
    (row) => [row.chain, Number(row.start_block)],
  ),
);

console.log("Chains to migrate:");
for (const chain of chains) console.log(`  ${chain.chain} (${chain.chainId}) from ${chain.schema}, resume after block ${chain.lastBlock}`);

const root = findRepoRoot();
const ddl = readFileSync(join(root, "sql/003_chain_tables.sql"), "utf8");
const client = await pool.connect();
const started = Date.now();
try {
  await client.query("BEGIN");
  await client.query(
    "DROP VIEW IF EXISTS read.agents, read.registration_files, read.services, read.feedback, read.feedback_responses, read.validations, read.agent_metadata, read.chains CASCADE",
  );
  await client.query("DROP SCHEMA erc8004 CASCADE");
  await client.query(ddl);
  for (const { schema, chain, chainId, lastBlock } of chains) {
    const q = (sql: string) => client.query(sql.replaceAll("$S", `"${schema}"`));
    await q(`INSERT INTO erc8004.agents
             SELECT chain_id, agent_id, owner, agent_uri, agent_wallet, registered_block, registered_at, last_transfer_at,
                    uri_updated_at, 0, NULL FROM $S.agents`);
    // Ponder stored metadata as the UTF-8 text of a hex string. Store the real bytes.
    await q(`INSERT INTO erc8004.agent_metadata
             SELECT chain_id, agent_id, key,
                    CASE WHEN octet_length(value) >= 2 AND substr(value, 1, 2) = decode('3078', 'hex')
                         THEN decode(substr(convert_from(value, 'UTF8'), 3), 'hex') ELSE value END,
                    updated_at
             FROM $S.agent_metadata`);
    await q(`INSERT INTO erc8004.feedback SELECT * FROM $S.feedback`);
    await q(`INSERT INTO erc8004.feedback_responses SELECT * FROM $S.feedback_responses`);
    await q(`INSERT INTO erc8004.validations
             SELECT chain_id, request_hash, validator_address, agent_id, request_uri, response, response_uri, response_hash, tag,
                    status::text, requested_at, last_update FROM $S.validations`);
    await q(`INSERT INTO erc8004.events (chain_id, block_number, log_index, tx_hash, block_time, event_name, args)
             SELECT chain_id, block_number, log_index, tx_hash, block_time, event_name,
                    regexp_replace(args::text, '\\\\u0000', '', 'g')::jsonb
             FROM $S.raw_events WHERE block_time >= extract(epoch FROM now() - interval '7 days')
             ON CONFLICT DO NOTHING`);
    await client.query(
      `INSERT INTO erc8004.cursors (chain, chain_id, start_block, last_block) VALUES ($1, $2, $3, $4)`,
      [chain, chainId, startBlocks.get(chain) ?? lastBlock, lastBlock],
    );
  }
  // feedback_count and last_feedback_at count non-revoked feedback only (Ponder counted revoked rows too).
  await client.query(`
    UPDATE erc8004.agents a SET feedback_count = s.n, last_feedback_at = s.last
    FROM (SELECT chain_id, agent_id, count(*) FILTER (WHERE NOT is_revoked)::int AS n,
                 max(block_time) FILTER (WHERE NOT is_revoked) AS last
          FROM erc8004.feedback GROUP BY 1, 2) s
    WHERE a.chain_id = s.chain_id AND a.agent_id = s.agent_id`);
  await client.query("CREATE TABLE IF NOT EXISTS ops.view_signature (id integer PRIMARY KEY, signature text NOT NULL)");
  await client.query("DELETE FROM ops.view_signature");
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Migration failed and was rolled back:", error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  client.release();
}

await ensureReadModel();
const counts = await pool.query(`
  SELECT (SELECT count(*) FROM erc8004.agents)::int AS agents,
         (SELECT count(*) FROM erc8004.agent_metadata)::int AS metadata,
         (SELECT count(*) FROM erc8004.feedback)::int AS feedback,
         (SELECT count(*) FROM erc8004.feedback_responses)::int AS responses,
         (SELECT count(*) FROM erc8004.validations)::int AS validations,
         (SELECT count(*) FROM erc8004.events)::int AS recent_events`);
console.log(`Migrated in ${Math.round((Date.now() - started) / 1000)}s`, counts.rows[0]);
console.log("Ponder's schemas are still there. After checking the new tables, run: pnpm cleanup:ponder");
await closePool();
