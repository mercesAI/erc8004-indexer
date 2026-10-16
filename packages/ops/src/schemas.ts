import { createHash } from "node:crypto";
import { chainDisplayName, getPool, knownChains } from "@merces/shared";

/**
 * Schema `read`: the app contract (docs/app-data-contract.md). Views over the erc8004 tables
 * written by packages/indexer-erc8004 and the enrich tables.
 *
 * The views are rebuilt only when their signature changes. The signature is a hash of the SQL below
 * plus the chain list, so editing a view here is enough to redeploy it on the next supervisor start,
 * `pnpm db:init`, or `pnpm verify:read`.
 */

export function chainLabel(chainId: number): string {
  return `${chainDisplayName(chainId)} (${chainId})`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const CHAIN_COLUMNS = (alias: string) => `
      COALESCE(c.chain_key, 'chain-' || ${alias}.chain_id::text) AS chain_key,
      COALESCE(c.chain_name, 'Chain ' || ${alias}.chain_id::text) AS chain_name`;

const READ_VIEWS = [
  "read.agents",
  "read.registration_files",
  "read.services",
  "read.feedback",
  "read.feedback_responses",
  "read.validations",
  "read.agent_metadata",
  "read.chains",
];

function readModelStatements(): string[] {
  const known = knownChains()
    .map((chain) => `(${chain.chainId}::integer, ${sqlLiteral(chain.key)}::text, ${sqlLiteral(chain.name)}::text)`)
    .join(", ");
  return [
    // Inlined by the planner to to_timestamp(x::double precision), which is the expression the index
    // erc8004.agents_chain_registered_at holds. Keep the two identical or list queries stop using it.
    `CREATE OR REPLACE FUNCTION read.unix_seconds(seconds numeric)
     RETURNS timestamptz
     LANGUAGE sql IMMUTABLE AS $$
       SELECT to_timestamp(seconds::double precision)
     $$`,
    `CREATE OR REPLACE FUNCTION read.uri_kind(uri text)
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
     $$`,
    `REVOKE ALL ON FUNCTION read.unix_seconds(numeric) FROM PUBLIC`,
    `REVOKE ALL ON FUNCTION read.uri_kind(text) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION read.unix_seconds(numeric) TO app_ro`,
    `GRANT EXECUTE ON FUNCTION read.uri_kind(text) TO app_ro`,
    `CREATE VIEW read.chains AS
     SELECT chain_id, chain_key, chain_name
     FROM (VALUES ${known}) AS known(chain_id, chain_key, chain_name)`,
    // feedback_count and last_feedback_at are stored on erc8004.agents and count non-revoked feedback only.
    `CREATE VIEW read.agents AS
     SELECT
       a.chain_id,${CHAIN_COLUMNS("a")},
       a.agent_id,
       a.owner,
       a.agent_uri,
       read.uri_kind(a.agent_uri) AS uri_kind,
       a.agent_wallet,
       a.registered_block,
       read.unix_seconds(a.registered_at) AS registered_at,
       read.unix_seconds(a.last_transfer_at) AS last_transfer_at,
       read.unix_seconds(a.uri_updated_at) AS uri_updated_at,
       a.feedback_count,
       read.unix_seconds(a.last_feedback_at) AS last_feedback_at,
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
     LEFT JOIN enrich.registration_files r
       ON r.chain_id = a.chain_id AND r.agent_id = a.agent_id`,
    `CREATE VIEW read.registration_files AS
     SELECT
       r.chain_id,${CHAIN_COLUMNS("r")},
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
     LEFT JOIN read.chains c ON c.chain_id = r.chain_id`,
    `CREATE VIEW read.services AS
     SELECT
       s.chain_id,${CHAIN_COLUMNS("s")},
       s.agent_id,
       s.name,
       s.endpoint,
       s.version,
       s.extra
     FROM enrich.agent_services s
     LEFT JOIN read.chains c ON c.chain_id = s.chain_id`,
    `CREATE VIEW read.feedback AS
     SELECT
       f.chain_id,${CHAIN_COLUMNS("f")},
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
     LEFT JOIN read.chains c ON c.chain_id = f.chain_id`,
    `CREATE VIEW read.feedback_responses AS
     SELECT
       r.chain_id,${CHAIN_COLUMNS("r")},
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
     LEFT JOIN read.chains c ON c.chain_id = r.chain_id`,
    `CREATE VIEW read.validations AS
     SELECT
       v.chain_id,${CHAIN_COLUMNS("v")},
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
     LEFT JOIN read.chains c ON c.chain_id = v.chain_id`,
    `CREATE VIEW read.agent_metadata AS
     SELECT
       m.chain_id,${CHAIN_COLUMNS("m")},
       m.agent_id,
       m.key,
       '0x' || encode(m.value, 'hex') AS value_hex,
       read.unix_seconds(m.updated_at) AS updated_at
     FROM erc8004.agent_metadata m
     LEFT JOIN read.chains c ON c.chain_id = m.chain_id`,
    `GRANT USAGE ON SCHEMA read TO app_ro`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA read TO app_ro`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA read GRANT SELECT ON TABLES TO app_ro`,
    `REVOKE ALL ON SCHEMA erc8004 FROM app_ro`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA erc8004 FROM app_ro`,
    `REVOKE ALL ON SCHEMA enrich FROM app_ro`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA enrich FROM app_ro`,
    `REVOKE ALL ON SCHEMA mirror FROM app_ro`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA mirror FROM app_ro`,
    `REVOKE ALL ON SCHEMA ops FROM app_ro`,
  ];
}

function signatureOf(statements: string[]): string {
  const hash = createHash("sha256");
  for (const statement of statements) hash.update(statement).update("\n;\n");
  return hash.digest("hex");
}

const VIEW_LOCK = 842004;

/** Rebuild the `read` views if their SQL changed or they are missing. Safe to call often. */
export async function ensureReadModel(): Promise<{ rebuilt: boolean }> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [VIEW_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS ops.view_signature (id integer PRIMARY KEY, signature text NOT NULL)`);
    const statements = readModelStatements();
    const signature = signatureOf(statements);
    const stored = await client.query<{ signature: string }>("SELECT signature FROM ops.view_signature WHERE id = 1");
    const present = await client.query<{ rel: string | null }>("SELECT to_regclass('read.agents')::text AS rel");
    if (present.rows[0]?.rel && stored.rows[0]?.signature === signature) return { rebuilt: false };
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("CREATE SCHEMA IF NOT EXISTS read");
      await client.query(`DROP VIEW IF EXISTS ${READ_VIEWS.join(", ")} CASCADE`);
      for (const statement of statements) await client.query(statement);
      await client.query(
        `INSERT INTO ops.view_signature (id, signature) VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET signature = EXCLUDED.signature`,
        [signature],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    return { rebuilt: true };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [VIEW_LOCK]).catch(() => undefined);
    client.release();
  }
}
