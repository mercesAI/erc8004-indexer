import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chainDisplayName, enabledChains, findRepoRoot, getPool, knownChains, reloadEnv, type EnabledChain } from "@merces/shared";
import { recordLine } from "./logs.js";

const VIEW_TABLES = ["agents", "agent_metadata", "feedback", "feedback_responses", "validations", "raw_events"];

export function chainSchema(chainKey: string): string {
  if (!/^[a-z0-9_]+$/.test(chainKey)) throw new Error(`Unsafe chain key ${chainKey}`);
  return `erc8004_${chainKey}`;
}

export function ponderPort(index: number): number {
  const first = Number(process.env.PONDER_PORT ?? 42069);
  return index === 0 ? first : 42080 + index;
}

export function chainLabel(chainId: number): string {
  return `${chainDisplayName(chainId)} (${chainId})`;
}

function quoteIdent(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error(`Unsafe identifier ${value}`);
  return `"${value}"`;
}

function indexingSourceHash(): string {
  const root = findRepoRoot();
  const ponderDir = join(root, "packages/ponder-erc8004");
  const sharedAbi = join(root, "packages/shared/src/abis");
  const files = [
    join(ponderDir, "ponder.schema.ts"),
    ...readdirSync(join(ponderDir, "src"))
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => join(ponderDir, "src", name)),
    ...readdirSync(join(ponderDir, "src/api"))
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => join(ponderDir, "src/api", name)),
    ...readdirSync(sharedAbi)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(sharedAbi, name)),
  ];
  const hash = createHash("sha256");
  for (const file of files) hash.update(readFileSync(file));
  return hash.digest("hex");
}

async function ensureOpsTables(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops.chain_index (
      chain text PRIMARY KEY,
      start_block bigint NOT NULL,
      schema_name text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops.indexer_build (
      id integer PRIMARY KEY,
      source_hash text NOT NULL
    )
  `);
}

async function legacyAgentsAreATable(): Promise<boolean> {
  const result = await getPool().query<{ relkind: string }>(
    `SELECT c.relkind
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'erc8004' AND c.relname = 'agents'`,
  );
  return result.rows[0]?.relkind === "r";
}

async function moveLegacySchema(): Promise<void> {
  if (!(await legacyAgentsAreATable())) return;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA IF NOT EXISTS erc8004_base");
    const objects = await client.query<{ kind: string; name: string }>(`
      SELECT c.relkind AS kind, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'erc8004' AND c.relkind IN ('r', 'p', 'S')
    `);
    for (const object of objects.rows) {
      const relation = object.kind === "S" ? "SEQUENCE" : "TABLE";
      await client.query(`ALTER ${relation} erc8004.${quoteIdent(object.name)} SET SCHEMA erc8004_base`);
    }
    const enums = await client.query<{ name: string }>(`
      SELECT t.typname AS name
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'erc8004' AND t.typtype = 'e'
    `);
    for (const item of enums.rows) {
      await client.query(`ALTER TYPE erc8004.${quoteIdent(item.name)} SET SCHEMA erc8004_base`);
    }
    const functions = await client.query<{ signature: string }>(`
      SELECT p.oid::regprocedure::text AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'erc8004'
    `);
    for (const item of functions.rows) {
      await client.query(`ALTER FUNCTION ${item.signature} SET SCHEMA erc8004_base`);
    }
    await client.query(`
      UPDATE erc8004_base._ponder_meta
      SET value = jsonb_set(value::jsonb, '{is_dev}', '0'::jsonb)
      WHERE key = 'app'
    `).catch((error: { code?: string }) => {
      if (error.code !== "42P01") throw error;
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function dropSchema(schema: string): Promise<void> {
  await getPool().query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
}

const VIEW_LOCK = 842004;
let viewRefresh: Promise<void> = Promise.resolve();

export function refreshChainViews(): Promise<void> {
  const run = viewRefresh.then(() => refreshChainViewsLocked());
  viewRefresh = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readModelSignature(client: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<string> {
  const columns = await client.query(
    `SELECT table_schema, table_name, column_name, udt_schema, ordinal_position::text
     FROM information_schema.columns
     WHERE table_schema LIKE 'erc8004\\_%' ESCAPE '\\'
       AND table_name = ANY($1::text[])
     ORDER BY 1, 2, 5`,
    [VIEW_TABLES],
  );
  const hash = createHash("sha256");
  hash.update("read-model-v2");
  hash.update(JSON.stringify(columns.rows));
  hash.update(knownChains().map((chain) => `${chain.chainId}:${chain.key}:${chain.name}`).join(","));
  return hash.digest("hex");
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function refreshChainViewsLocked(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [VIEW_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ops.view_signature (
        id integer PRIMARY KEY,
        signature text NOT NULL
      )
    `);
    const signature = await readModelSignature(client);
    const stored = await client.query<{ signature: string }>("SELECT signature FROM ops.view_signature WHERE id = 1");
    const current = await relationExists(client, "read.agents");
    if (current && stored.rows[0]?.signature === signature) return;
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS erc8004");
      await client.query("CREATE SCHEMA IF NOT EXISTS read");
      await client.query(`
        DROP VIEW IF EXISTS
          read.agents,
          read.registration_files,
          read.services,
          read.feedback,
          read.feedback_responses,
          read.validations,
          read.agent_metadata,
          read.chains
        CASCADE
      `);
      for (const table of VIEW_TABLES) {
        const found = await client.query<{ table_schema: string }>(
          `SELECT table_schema
           FROM information_schema.tables
           WHERE table_name = $1
             AND table_type = 'BASE TABLE'
             AND table_schema LIKE 'erc8004\\_%' ESCAPE '\\'
           ORDER BY table_schema`,
          [table],
        );
        if (found.rows.length === 0) continue;
        const columns = await client.query<{ column_name: string; udt_schema: string }>(
          `SELECT column_name, udt_schema
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [found.rows[0]?.table_schema, table],
        );
        const selectList = columns.rows
          .map((column) => {
            const name = quoteIdent(column.column_name);
            // Each chain schema has its own copy of an enum, and UNION ALL cannot mix them.
            return column.udt_schema === "pg_catalog" ? name : `${name}::text`;
          })
          .join(", ");
        const union = found.rows
          .map((row) => `SELECT ${selectList} FROM ${quoteIdent(row.table_schema)}.${quoteIdent(table)}`)
          .join(" UNION ALL ");
        const view = `erc8004.${quoteIdent(table)}`;
        await client.query(`DROP VIEW IF EXISTS ${view} CASCADE`);
        await client.query(`CREATE VIEW ${view} AS ${union}`);
      }
      await replaceReadModel(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    await client.query(
      `INSERT INTO ops.view_signature (id, signature) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET signature = EXCLUDED.signature`,
      [signature],
    );
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [VIEW_LOCK]).catch(() => undefined);
    client.release();
  }
}

async function relationExists(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { rel: string | null }[] }> }, name: string): Promise<boolean> {
  const result = await client.query("SELECT to_regclass($1)::text AS rel", [name]);
  return result.rows[0]?.rel != null;
}

async function replaceReadModel(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { rel: string | null }[] }> }): Promise<void> {
  const hasAgents = await relationExists(client, "erc8004.agents");
  const known = knownChains()
    .map((chain) => `(${chain.chainId}::integer, ${sqlLiteral(chain.key)}::text, ${sqlLiteral(chain.name)}::text)`)
    .join(", ");
  await client.query(`
    CREATE OR REPLACE FUNCTION read.unix_seconds(seconds numeric)
    RETURNS timestamptz
    LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN seconds IS NULL THEN NULL ELSE to_timestamp(seconds::double precision) END
    $$
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION read.uri_kind(uri text)
    RETURNS text
    LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE
        WHEN uri IS NULL OR btrim(uri) = '' THEN 'empty'
        WHEN uri ILIKE 'ipfs://%' THEN 'ipfs'
        WHEN uri ILIKE 'https://%' THEN 'https'
        WHEN uri ILIKE 'http://%' THEN 'http'
        WHEN uri ILIKE 'data:%' THEN 'data'
        ELSE 'invalid'
      END
    $$
  `);
  await client.query(`
    REVOKE ALL ON FUNCTION read.unix_seconds(numeric) FROM PUBLIC;
    REVOKE ALL ON FUNCTION read.uri_kind(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION read.unix_seconds(numeric) TO app_ro;
    GRANT EXECUTE ON FUNCTION read.uri_kind(text) TO app_ro;
  `);
  await client.query(`
    CREATE VIEW read.chains AS
    SELECT chain_id, chain_key, chain_name
    FROM (VALUES ${known}) AS known(chain_id, chain_key, chain_name)
  `);
  if (!hasAgents) {
    await grantReadSchema(client);
    return;
  }
  await client.query(`
    CREATE VIEW read.agents AS
    SELECT
      a.chain_id,
      COALESCE(c.chain_key, 'chain-' || a.chain_id::text) AS chain_key,
      COALESCE(c.chain_name, 'Chain ' || a.chain_id::text) AS chain_name,
      a.agent_id,
      a.owner,
      a.agent_uri,
      read.uri_kind(a.agent_uri) AS uri_kind,
      a.agent_wallet,
      a.registered_block,
      read.unix_seconds(a.registered_at) AS registered_at,
      read.unix_seconds(a.last_transfer_at) AS last_transfer_at,
      read.unix_seconds(a.uri_updated_at) AS uri_updated_at,
      COALESCE(fb.feedback_count, 0)::integer AS feedback_count,
      read.unix_seconds(fb.last_feedback_at) AS last_feedback_at,
      r.name,
      r.description,
      r.image,
      r.active,
      r.x402_support,
      r.supported_trust,
      r.fetch_status,
      r.error AS fetch_error,
      r.fetched_at,
      r.content_hash
    FROM erc8004.agents a
    LEFT JOIN read.chains c ON c.chain_id = a.chain_id
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE NOT f.is_revoked)::integer AS feedback_count,
        max(f.block_time) FILTER (WHERE NOT f.is_revoked) AS last_feedback_at
      FROM erc8004.feedback f
      WHERE f.chain_id = a.chain_id AND f.agent_id = a.agent_id
    ) fb ON true
    LEFT JOIN enrich.registration_files r
      ON r.chain_id = a.chain_id AND r.agent_id = a.agent_id
  `);
  await client.query(`
    CREATE VIEW read.registration_files AS
    SELECT
      r.chain_id,
      COALESCE(c.chain_key, 'chain-' || r.chain_id::text) AS chain_key,
      COALESCE(c.chain_name, 'Chain ' || r.chain_id::text) AS chain_name,
      r.agent_id,
      r.agent_uri,
      read.uri_kind(r.agent_uri) AS uri_kind,
      r.content_hash,
      r.raw,
      r.name,
      r.description,
      r.image,
      r.active,
      r.x402_support,
      r.supported_trust,
      r.fetch_status,
      r.http_status,
      r.error AS fetch_error,
      r.fetched_at,
      r.next_retry_at,
      r.attempts
    FROM enrich.registration_files r
    LEFT JOIN read.chains c ON c.chain_id = r.chain_id
  `);
  await client.query(`
    CREATE VIEW read.services AS
    SELECT
      s.chain_id,
      COALESCE(c.chain_key, 'chain-' || s.chain_id::text) AS chain_key,
      COALESCE(c.chain_name, 'Chain ' || s.chain_id::text) AS chain_name,
      s.agent_id,
      s.name,
      s.endpoint,
      s.version,
      s.extra
    FROM enrich.agent_services s
    LEFT JOIN read.chains c ON c.chain_id = s.chain_id
  `);
  await client.query(`
    CREATE VIEW read.feedback AS
    SELECT
      f.chain_id,
      COALESCE(c.chain_key, 'chain-' || f.chain_id::text) AS chain_key,
      COALESCE(c.chain_name, 'Chain ' || f.chain_id::text) AS chain_name,
      f.agent_id,
      f.client_address,
      f.feedback_index,
      f.value,
      f.value_decimals,
      f.value_norm,
      f.tag1,
      f.tag2,
      f.endpoint,
      f.feedback_uri,
      f.feedback_hash,
      f.is_revoked,
      f.block_number,
      read.unix_seconds(f.block_time) AS block_time,
      f.tx_hash
    FROM erc8004.feedback f
    LEFT JOIN read.chains c ON c.chain_id = f.chain_id
  `);
  await client.query(`
    CREATE VIEW read.feedback_responses AS
    SELECT
      r.chain_id,
      COALESCE(c.chain_key, 'chain-' || r.chain_id::text) AS chain_key,
      COALESCE(c.chain_name, 'Chain ' || r.chain_id::text) AS chain_name,
      r.tx_hash,
      r.log_index,
      r.agent_id,
      r.client_address,
      r.feedback_index,
      r.responder,
      r.response_uri,
      r.response_hash,
      read.unix_seconds(r.block_time) AS block_time
    FROM erc8004.feedback_responses r
    LEFT JOIN read.chains c ON c.chain_id = r.chain_id
  `);
  await client.query(`
    CREATE VIEW read.validations AS
    SELECT
      v.chain_id,
      COALESCE(c.chain_key, 'chain-' || v.chain_id::text) AS chain_key,
      COALESCE(c.chain_name, 'Chain ' || v.chain_id::text) AS chain_name,
      v.request_hash,
      v.validator_address,
      v.agent_id,
      v.request_uri,
      v.response,
      v.response_uri,
      v.response_hash,
      v.tag,
      v.status,
      read.unix_seconds(v.requested_at) AS requested_at,
      read.unix_seconds(v.last_update) AS last_update
    FROM erc8004.validations v
    LEFT JOIN read.chains c ON c.chain_id = v.chain_id
  `);
  await client.query(`
    CREATE VIEW read.agent_metadata AS
    SELECT
      m.chain_id,
      COALESCE(c.chain_key, 'chain-' || m.chain_id::text) AS chain_key,
      COALESCE(c.chain_name, 'Chain ' || m.chain_id::text) AS chain_name,
      m.agent_id,
      m.key,
      CASE
        WHEN m.value IS NULL THEN NULL
        WHEN octet_length(m.value) >= 2 AND substr(m.value, 1, 2) = decode('3078', 'hex') THEN convert_from(m.value, 'UTF8')
        ELSE '0x' || encode(m.value, 'hex')
      END AS value_hex,
      read.unix_seconds(m.updated_at) AS updated_at
    FROM erc8004.agent_metadata m
    LEFT JOIN read.chains c ON c.chain_id = m.chain_id
  `);
  await grantReadSchema(client);
}

async function grantReadSchema(client: {
  query: (sql: string) => Promise<{ rows: { rel: string | null }[] }>;
}): Promise<void> {
  await client.query(`
    GRANT USAGE ON SCHEMA read TO app_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA read TO app_ro;
    ALTER DEFAULT PRIVILEGES IN SCHEMA read GRANT SELECT ON TABLES TO app_ro;
    REVOKE ALL ON SCHEMA erc8004 FROM app_ro;
    REVOKE ALL ON ALL TABLES IN SCHEMA erc8004 FROM app_ro;
    REVOKE ALL ON SCHEMA enrich FROM app_ro;
    REVOKE ALL ON ALL TABLES IN SCHEMA enrich FROM app_ro;
    REVOKE ALL ON SCHEMA mirror FROM app_ro;
    REVOKE ALL ON ALL TABLES IN SCHEMA mirror FROM app_ro;
    REVOKE ALL ON SCHEMA ops FROM app_ro;
  `);
  const schemas = await client.query("SELECT nspname AS rel FROM pg_namespace WHERE nspname LIKE 'erc8004\\_%' ESCAPE '\\'");
  for (const schema of schemas.rows) {
    if (!schema.rel) continue;
    await client.query(`REVOKE ALL ON SCHEMA ${quoteIdent(schema.rel)} FROM app_ro`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${quoteIdent(schema.rel)} FROM app_ro`);
  }
}

export type IndexBlock = { chain: string; reason: string };

export type IndexPlan = {
  chains: EnabledChain[];
  blocked: IndexBlock[];
};

/**
 * Each chain is a separate Ponder schema. Nothing is dropped from here.
 * A start-block change or an indexing-code change blocks that chain until
 * `pnpm reset:ponder --chain <key>` or `--all`. Adding a chain leaves the others in place.
 */
export async function prepareChainIndexes(): Promise<IndexPlan> {
  reloadEnv();
  await ensureOpsTables();
  await moveLegacySchema();
  const pool = getPool();
  const hash = indexingSourceHash();
  const previous = await pool.query<{ source_hash: string }>("SELECT source_hash FROM ops.indexer_build WHERE id = 1");
  const sourceChanged = previous.rows[0] != null && previous.rows[0].source_hash !== hash;
  const configured = enabledChains();
  const blocked: IndexBlock[] = [];
  if (sourceChanged) {
    const reason =
      "Indexing code changed. Existing chain data was kept. Run pnpm reset:ponder --all when you mean to reindex every chain.";
    for (const chain of configured) blocked.push({ chain: chain.key, reason });
    recordLine("ponder", "error", reason);
  } else {
    await pool.query(
      `INSERT INTO ops.indexer_build (id, source_hash) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET source_hash = EXCLUDED.source_hash`,
      [hash],
    );
  }
  const ready: EnabledChain[] = [];
  if (!sourceChanged) {
    for (const chain of configured) {
      const stored = await pool.query<{ start_block: string }>(
        "SELECT start_block::text FROM ops.chain_index WHERE chain = $1",
        [chain.key],
      );
      const previousBlock = stored.rows[0]?.start_block;
      if (previousBlock != null && Number(previousBlock) !== chain.startBlock) {
        const reason = `START_BLOCK for ${chain.key} changed from ${previousBlock} to ${chain.startBlock}. Data was kept. Run pnpm reset:ponder --chain ${chain.key} to reindex that chain.`;
        blocked.push({ chain: chain.key, reason });
        recordLine("ponder", "error", reason);
        continue;
      }
      await pool.query(
        `INSERT INTO ops.chain_index (chain, start_block, schema_name, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (chain) DO UPDATE
         SET start_block = EXCLUDED.start_block, schema_name = EXCLUDED.schema_name, updated_at = now()`,
        [chain.key, chain.startBlock, chainSchema(chain.key)],
      );
      ready.push(chain);
    }
  }
  try {
    await refreshChainViews();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordLine("ponder", "error", `read model refresh failed: ${message}`);
  }
  return { chains: ready, blocked };
}
