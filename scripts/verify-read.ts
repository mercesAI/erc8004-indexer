import { spawnSync } from "node:child_process";
import { closePool, getPool, loadEnv } from "../packages/shared/src/index.ts";
import { ensureReadModel } from "../packages/ops/src/schemas.ts";

loadEnv();
await ensureReadModel();

const admin = getPool();
function asApp(sql: string): { ok: boolean; text: string } {
  const adminUrl = new URL(String(process.env.DATABASE_URL).replace(/^postgres(ql)?:/, "http:"));
  const result = spawnSync(
    "psql",
    [
      "-h",
      adminUrl.hostname,
      "-p",
      adminUrl.port,
      "-U",
      "app_ro",
      "-d",
      adminUrl.pathname.replace(/^\//, ""),
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    {
      env: { ...process.env, PGPASSWORD: process.env.APP_RO_PASSWORD ?? "" },
      encoding: "utf8",
    },
  );
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, text };
}

const counts = await admin.query(`
  SELECT
    (SELECT count(*)::int FROM erc8004.agents) AS chain_agents,
    (SELECT count(*)::int FROM read.agents) AS read_agents,
    (SELECT count(*)::int FROM read.feedback) AS read_feedback,
    (SELECT count(*)::int FROM read.services) AS read_services,
    (SELECT count(*)::int FROM read.registration_files) AS read_files,
    (SELECT count(*)::int FROM read.validations) AS read_validations,
    (SELECT count(*)::int FROM read.agent_metadata) AS read_metadata,
    (SELECT count(*)::int FROM read.feedback_responses) AS read_responses,
    (SELECT count(*)::int FROM read.chains) AS read_chains
`);
console.log("counts", counts.rows[0]);

const kinds = await admin.query(
  "SELECT uri_kind, count(*)::int AS n FROM read.agents GROUP BY 1 ORDER BY 2 DESC",
);
console.log("uri_kind", kinds.rows);

const drift = await admin.query(`
  SELECT count(*)::int AS drift
  FROM read.agents r
  JOIN LATERAL (
    SELECT count(*) FILTER (WHERE NOT is_revoked)::int AS n
    FROM erc8004.feedback f
    WHERE f.chain_id = r.chain_id AND f.agent_id = r.agent_id
  ) f ON true
  WHERE r.feedback_count <> f.n
`);
console.log("feedback_drift", drift.rows[0]);

const types = await admin.query(`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_schema = 'read' AND table_name = 'agents'
    AND column_name IN ('registered_at', 'feedback_count', 'uri_kind', 'fetch_status', 'chain_key')
  ORDER BY column_name
`);
console.log("types", types.rows);

const sample = await admin.query(`
  SELECT chain_key, chain_name, agent_id::text AS agent_id, uri_kind, feedback_count, fetch_status, registered_at
  FROM read.agents
  WHERE chain_id = 8453 AND name IS NOT NULL
  ORDER BY registered_at DESC NULLS LAST
  LIMIT 1
`);
console.log("sample", sample.rows[0]);

const explain = await admin.query(`
  EXPLAIN (FORMAT TEXT)
  SELECT agent_id, name, feedback_count, registered_at
  FROM read.agents
  WHERE chain_id = 8453
  ORDER BY registered_at DESC NULLS LAST
  LIMIT 25
`);
console.log("explain");
for (const row of explain.rows as { "QUERY PLAN": string }[]) console.log(row["QUERY PLAN"]);

const appCount = asApp("SELECT count(*)::int AS n FROM read.agents");
console.log("app_ro agents", appCount.ok ? appCount.text : appCount.text);
for (const rel of ["mirror.agents", "erc8004.agents", "erc8004.events", "enrich.registration_files", "ops.logs"]) {
  const result = asApp(`SELECT 1 FROM ${rel} LIMIT 1`);
  const line = result.text.split("\n").find((item) => item.startsWith("ERROR") || item.includes("(1 row)")) ?? result.text.split("\n")[0];
  console.log(result.ok ? "ALLOW" : "DENY", rel, line);
}

await closePool();
