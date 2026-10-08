import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import {
  CHAINS,
  enabledChains,
  envInt,
  findRepoRoot,
  getChain,
  getPool,
  registryAddress,
} from "@merces/shared";
import { chainLabel } from "./schemas.js";
import { tailLogs } from "./logs.js";
import type { ProcessManager, ProcName } from "./proc.js";
import { runSanity } from "./sanity.js";

const SECRET = /KEY|PASSWORD|PRIVATE|SECRET|DATABASE_URL|RPC_|GRAPH_API/;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function mask(key: string, value: string): string {
  if (!SECRET.test(key)) return value;
  if (value.includes("://")) {
    return value
      .replace(/\/\/([^:/]+):([^@]+)@/, "//$1:***@")
      .replace(/\/v2\/[^/?#]+/g, "/v2/***")
      .replace(/\/api\/[^/]+\/subgraphs/g, "/api/***/subgraphs");
  }
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

const requireAuth: MiddlewareHandler = async (c, next) => {
  const user = process.env.OPS_USER ?? "admin";
  const password = process.env.OPS_PASSWORD ?? "change-me";
  const header = c.req.header("authorization") ?? "";
  const encoded = header.startsWith("Basic ") ? header.slice(6) : "";
  const decoded = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
  const split = decoded.indexOf(":");
  const gotUser = split === -1 ? "" : decoded.slice(0, split);
  const gotPass = split === -1 ? "" : decoded.slice(split + 1);
  if (!encoded || !safeEqual(gotUser, user) || !safeEqual(gotPass, password)) {
    c.header("WWW-Authenticate", 'Basic realm="merces-ops"');
    return c.text("Unauthorized", 401);
  }
  await next();
};

async function latestSnapshot(): Promise<Record<string, unknown> | null> {
  const result = await getPool().query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM ops.metrics_snapshots ORDER BY ts DESC LIMIT 1",
  );
  return result.rows[0]?.payload ?? null;
}

export function startServer(manager: ProcessManager): void {
  const root = findRepoRoot();
  const uiRoot = join(root, "packages/ops/dist/ui");
  const app = new Hono();
  // Basic auth is off while the dashboard stays on localhost. Restore with app.use("*", requireAuth).
  // A custom header stops another website from submitting the stop/restart buttons.
  void requireAuth;
  app.use("/api/*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return c.json({ error: "bad host" }, 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-merces-ops") !== "1") {
      return c.json({ error: "missing x-merces-ops" }, 403);
    }
    await next();
  });

  app.get("/api/overview", async (c) => {
    const snapshot = await latestSnapshot();
    return c.json({ processes: manager.snapshot(), metrics: snapshot });
  });

  app.get("/api/indexing", async (c) => {
    const hours = Math.min(168, Math.max(1, Number(c.req.query("hours") ?? "6")));
    const result = await getPool().query<{ ts: string; payload: { chains?: unknown; alchemyMaxRps?: number } }>(
      "SELECT ts, payload FROM ops.metrics_snapshots WHERE ts > now() - ($1 || ' hours')::interval ORDER BY ts ASC",
      [String(hours)],
    );
    const step = Math.max(1, Math.floor(result.rows.length / 240));
    const points = result.rows.filter((_, index) => index % step === 0 || index === result.rows.length - 1);
    return c.json({
      alchemyMaxRps: alchemyNumber(),
      points: points.map((row) => ({ ts: row.ts, chains: row.payload.chains ?? [] })),
    });
  });

  app.post("/api/processes/:name/:action", async (c) => {
    const name = c.req.param("name") as ProcName;
    const action = c.req.param("action");
    if (!["ponder", "importer", "enrich"].includes(name)) return c.json({ error: "unknown process" }, 400);
    if (action === "start") manager.start(name);
    else if (action === "stop") await manager.stop(name);
    else if (action === "restart") await manager.restart(name);
    else return c.json({ error: "unknown action" }, 400);
    return c.json({ processes: manager.snapshot() });
  });

  app.get("/api/workers", async (c) => c.json(await workersPayload()));

  app.post("/api/workers/:name/:action", async (c) => {
    const name = c.req.param("name");
    const action = c.req.param("action");
    if (!["importer", "enrich"].includes(name) || !["pause", "resume"].includes(action)) {
      return c.json({ error: "unknown worker control" }, 400);
    }
    await getPool().query(
      `INSERT INTO ops.worker_control (worker, paused, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (worker) DO UPDATE SET paused = EXCLUDED.paused, updated_at = now()`,
      [name, action === "pause"],
    );
    return c.json(await workersPayload());
  });

  app.post("/api/importer/cursor/reset", async (c) => {
    const body = await c.req.json<{ chain?: string; entity?: string }>();
    if (!body.chain || !body.entity) return c.json({ error: "chain and entity are required" }, 400);
    await getPool().query("DELETE FROM mirror.cursors WHERE chain = $1 AND entity = $2", [body.chain, body.entity]);
    return c.json({ ok: true });
  });

  app.post("/api/jobs/refetch", async (c) => {
    const body = await c.req.json<{ chainId?: number; agentId?: string }>();
    if (!body.chainId || !body.agentId) return c.json({ error: "chainId and agentId are required" }, 400);
    const result = await getPool().query<{ id: string }>(
      "INSERT INTO ops.jobs (kind, payload) VALUES ('refetch_registration', $1::jsonb) RETURNING id::text",
      [JSON.stringify({ chainId: body.chainId, agentId: String(body.agentId) })],
    );
    return c.json({ id: result.rows[0]?.id });
  });

  app.post("/api/sanity", async (c) => c.json(await runSanity()));
  app.get("/api/sanity/latest", async (c) => {
    const result = await getPool().query("SELECT ts, pass, warn, fail, result FROM ops.sanity_runs ORDER BY ts DESC LIMIT 1");
    return c.json(result.rows[0] ?? null);
  });
  app.get("/api/sanity/history", async (c) => {
    const result = await getPool().query(
      "SELECT id, ts, pass, warn, fail FROM ops.sanity_runs ORDER BY ts DESC LIMIT 30",
    );
    return c.json(result.rows);
  });

  app.get("/api/data", async (c) => c.json(await dataPayload(c.req.query("owners") ?? "all")));
  app.get("/api/explorer/agents", async (c) =>
    c.json(await searchAgents(c.req.query("chain") ?? "", c.req.query("q") ?? "", Number(c.req.query("offset") ?? "0"))),
  );
  app.get("/api/explorer/feedback", async (c) => {
    const chainId = Number(c.req.query("chainId"));
    const agentId = c.req.query("agentId") ?? "";
    const result = await getPool().query(
      `SELECT agent_id::text, client_address, feedback_index::text, value::text, value_decimals, tag1, tag2,
              endpoint, feedback_uri, is_revoked, block_time::text, tx_hash
       FROM erc8004.feedback
       WHERE chain_id = $1 AND agent_id = $2
       ORDER BY block_time DESC LIMIT 100`,
      [chainId, agentId],
    );
    return c.json(result.rows);
  });

  app.get("/api/logs", (c) =>
    c.json(
      tailLogs({
        process: c.req.query("process"),
        level: c.req.query("level"),
        q: c.req.query("q"),
        after: Number(c.req.query("after") ?? "0"),
      }),
    ),
  );

  app.get("/api/settings", (c) => c.json({ entries: settingsEntries() }));

  app.use("/assets/*", serveStatic({ root: uiRoot }));
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api")) return c.json({ error: "not found" }, 404);
    const html = await readFile(join(uiRoot, "index.html"), "utf8");
    return c.html(html);
  });

  const port = envInt("OPS_PORT", 42070);
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  console.log(JSON.stringify({ level: "info", msg: "ops listening", url: `http://127.0.0.1:${port}` }));
}

function alchemyNumber(): number {
  return Number(process.env.ALCHEMY_MAX_RPS ?? "20");
}

async function workersPayload(): Promise<Record<string, unknown>> {
  const control = await getPool().query("SELECT worker, paused, updated_at FROM ops.worker_control ORDER BY worker");
  const cursors = await getPool().query(
    "SELECT chain, entity, cursor, mode, watermark, updated_at FROM mirror.cursors ORDER BY chain, entity",
  );
  const enrich = await getPool().query<{ status: string; n: string }>(
    `SELECT fetch_status AS status, count(*)::text AS n FROM enrich.registration_files GROUP BY fetch_status`,
  );
  const pending = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM enrich.registration_files
     WHERE fetch_status = 'error' AND next_retry_at IS NOT NULL AND next_retry_at > now()`,
  );
  const success = await getPool().query(
    `SELECT date_trunc('hour', fetched_at) AS hour,
            count(*) FILTER (WHERE fetch_status = 'ok')::int AS ok,
            count(*) FILTER (WHERE fetch_status = 'error')::int AS error
     FROM enrich.registration_files
     WHERE fetched_at > now() - interval '7 days'
     GROUP BY 1 ORDER BY 1`,
  );
  const health = await latestSnapshot();
  return {
    control: control.rows,
    cursors: cursors.rows,
    enrich: {
      byStatus: enrich.rows,
      pendingRetry: Number(pending.rows[0]?.n ?? 0),
      success: success.rows,
    },
    health: (health?.workers as unknown) ?? null,
    chains: enabledChains().map((chain) => chain.key),
  };
}

function chainsInData(ids: number[]): { key: string; chainId: number; label: string }[] {
  const byId = new Map<number, string>();
  for (const spec of Object.values(CHAINS)) byId.set(spec.chainId, spec.key);
  for (const chain of enabledChains()) byId.set(chain.chainId, chain.key);
  for (const id of ids) if (!byId.has(id)) byId.set(id, "");
  return [...byId.entries()]
    .filter(([id]) => ids.includes(id) || enabledChains().some((chain) => chain.chainId === id))
    .map(([chainId, key]) => ({ key, chainId, label: chainLabel(chainId) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

async function dataPayload(ownersChain: string): Promise<Record<string, unknown>> {
  const tables = ["agents", "agent_metadata", "feedback", "feedback_responses", "validations", "raw_events"];
  const counts = [];
  const seenChainIds: number[] = [];
  for (const table of tables) {
    const result = await getPool().query<{ chain_id: number; n: string }>(
      `SELECT chain_id, count(*)::text AS n FROM erc8004.${table} GROUP BY chain_id ORDER BY chain_id`,
    );
    for (const row of result.rows) {
      seenChainIds.push(row.chain_id);
      counts.push({ table, chainId: row.chain_id, chainLabel: chainLabel(row.chain_id), rows: Number(row.n) });
    }
  }
  const ownerChainId = ownersChain && ownersChain !== "all" ? getChain(ownersChain).chainId : null;
  const owners = await getPool().query(
    `SELECT owner, count(*)::int AS agents
     FROM erc8004.agents
     WHERE ($1::int IS NULL OR chain_id = $1)
     GROUP BY owner
     ORDER BY agents DESC
     LIMIT 20`,
    [ownerChainId],
  );
  const activity = await getPool().query(
    `SELECT
       count(*) FILTER (WHERE registered_at >= extract(epoch FROM now() - interval '1 day'))::int AS agents_24h,
       count(*) FILTER (WHERE registered_at >= extract(epoch FROM now() - interval '7 days'))::int AS agents_7d,
       (SELECT count(*)::int FROM erc8004.feedback WHERE block_time >= extract(epoch FROM now() - interval '1 day')) AS feedback_24h,
       (SELECT count(*)::int FROM erc8004.feedback WHERE block_time >= extract(epoch FROM now() - interval '7 days')) AS feedback_7d
     FROM erc8004.agents`,
  );
  const actions = await getPool().query(
    `SELECT chain_id, event_name, block_number::text AS block_number, block_time::text AS block_time, tx_hash
     FROM erc8004.raw_events
     ORDER BY block_time DESC NULLS LAST, log_index DESC
     LIMIT 15`,
  );
  const growth = await getPool().query(
    `SELECT ts, payload->'counts' AS counts
     FROM ops.metrics_snapshots
     WHERE ts > now() - interval '24 hours'
     ORDER BY ts ASC`,
  );
  const step = Math.max(1, Math.floor(growth.rows.length / 200));
  const coverage = await getPool().query(
    `SELECT count(*)::int AS agents,
            count(*) FILTER (WHERE r.fetch_status = 'ok')::int AS with_registration,
            count(*) FILTER (WHERE a.feedback_count > 0)::int AS with_feedback
     FROM erc8004.agents a
     LEFT JOIN enrich.registration_files r ON r.chain_id = a.chain_id AND r.agent_id = a.agent_id`,
  );
  return {
    counts,
    chains: chainsInData(seenChainIds),
    growth: growth.rows.filter((_, index) => index % step === 0),
    topOwners: owners.rows,
    ownersChain,
    activity: activity.rows[0] ?? { agents_24h: 0, agents_7d: 0, feedback_24h: 0, feedback_7d: 0 },
    recent: actions.rows.map((row: { chain_id: number }) => ({ ...row, chainLabel: chainLabel(row.chain_id) })),
    coverage: coverage.rows[0] ?? { agents: 0, with_registration: 0, with_feedback: 0 },
  };
}

async function searchAgents(chain: string, q: string, offset: number): Promise<Record<string, unknown>> {
  const chainId = chain ? getChain(chain).chainId : enabledChains()[0]?.chainId;
  const query = q.trim();
  const limit = 25;
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const total = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n
     FROM erc8004.agents a
     LEFT JOIN enrich.registration_files r ON r.chain_id = a.chain_id AND r.agent_id = a.agent_id
     WHERE a.chain_id = $1
       AND ($2 = '' OR a.agent_id::text = $2 OR a.owner = lower($2) OR r.name ILIKE '%' || $2 || '%')`,
    [chainId, query],
  );
  const result = await getPool().query(
    `SELECT a.chain_id, a.agent_id::text, a.owner, a.agent_uri, a.agent_wallet, a.feedback_count,
            a.registered_at::text, r.name
     FROM erc8004.agents a
     LEFT JOIN enrich.registration_files r ON r.chain_id = a.chain_id AND r.agent_id = a.agent_id
     WHERE a.chain_id = $1
       AND ($2 = '' OR a.agent_id::text = $2 OR a.owner = lower($2) OR r.name ILIKE '%' || $2 || '%')
     ORDER BY a.registered_at DESC NULLS LAST
     LIMIT $3 OFFSET $4`,
    [chainId, query, limit, start],
  );
  const identity = registryAddress("identity");
  const items = result.rows.map((row: Record<string, unknown>) => {
    const spec = Object.values(CHAINS).find((item) => item.chainId === row.chain_id);
    const agentId = String(row.agent_id);
    return {
      ...row,
      explorer: spec ? `${spec.explorerUrl}/nft/${identity}/${agentId}` : null,
      scan: spec ? `https://8004scan.io/agents/${spec.key}/${agentId}` : `https://8004scan.io/agents/${row.chain_id}/${agentId}`,
    };
  });
  return { items, total: Number(total.rows[0]?.n ?? 0), limit, offset: start };
}

function settingsEntries(): { key: string; value: string }[] {
  const keys = [
    "CHAINS",
    "DATABASE_SCHEMA",
    "DATABASE_URL",
    "PONDER_PORT",
    "OPS_PORT",
    "OPS_USER",
    "OPS_PASSWORD",
    "ALCHEMY_MAX_RPS",
    "SUBGRAPH_MIRROR_CHAINS",
    "IMPORTER_INTERVAL_SEC",
    "ENRICH_CONCURRENCY",
    "SCAN8004_BASE_URL",
    "SCAN8004_API_KEY",
    "SANITY_SAMPLE",
    "METRICS_INTERVAL_SEC",
    "IPFS_GATEWAY",
    "FETCH_TIMEOUT_MS",
    "GRAPH_API_KEY",
    "IDENTITY_REGISTRY",
    "REPUTATION_REGISTRY",
    "VALIDATION_REGISTRY",
    "NODE_ENV",
  ];
  for (const chain of Object.values(CHAINS)) {
    keys.push(chain.rpcEnvVar, chain.startBlockEnvVar, chain.subgraphEnvVar);
  }
  return keys
    .filter((key, index) => keys.indexOf(key) === index)
    .map((key) => ({ key, value: mask(key, process.env[key] ?? "") }));
}
