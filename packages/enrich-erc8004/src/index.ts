import { createServer } from "node:http";
import { envInt, getPool, log } from "@merces/shared";
import { isTerminalFetchError, resolveUri, RETRY_MS, type ParsedRegistration } from "./fetchUri.js";

type AgentTarget = {
  chain_id: number;
  agent_id: string;
  agent_uri: string;
  attempts: number;
};

type PassStats = {
  at: string;
  selected: number;
  fetched: number;
  failed: number;
  durationMs: number;
};

const state = {
  paused: false,
  queueDepth: 0,
  lastPass: null as PassStats | null,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPaused(): Promise<boolean> {
  const result = await getPool().query<{ paused: boolean }>(
    "SELECT paused FROM ops.worker_control WHERE worker = 'enrich'",
  );
  state.paused = result.rows[0]?.paused ?? false;
  return state.paused;
}

const DUE_AGENTS = `
  WITH due AS (
    SELECT a.chain_id,
           a.agent_id::text AS agent_id,
           a.agent_uri,
           a.registered_at,
           CASE
             WHEN r.agent_id IS NULL OR r.agent_uri IS DISTINCT FROM a.agent_uri THEN 0
             ELSE COALESCE(r.attempts, 0)
           END AS attempts,
           CASE
             WHEN r.fetch_status = 'error' AND r.agent_uri IS NOT DISTINCT FROM a.agent_uri THEN 0
             WHEN r.agent_id IS NOT NULL AND r.agent_uri IS DISTINCT FROM a.agent_uri THEN 1
             ELSE 2
           END AS priority
    FROM erc8004.agents a
    LEFT JOIN enrich.registration_files r
      ON r.chain_id = a.chain_id AND r.agent_id = a.agent_id
    WHERE a.agent_uri <> ''
      AND COALESCE(r.error, '') NOT IN (
        'unsupported uri scheme', 'invalid json', 'blocked address', 'unstorable content', 'HTTP 404', 'HTTP 410'
      )
      AND (
        r.agent_id IS NULL
        OR r.agent_uri IS DISTINCT FROM a.agent_uri
        OR (r.fetch_status = 'error' AND r.next_retry_at IS NOT NULL AND r.next_retry_at <= now())
      )
  ),
  ranked AS (
    SELECT *, row_number() OVER (
      PARTITION BY chain_id, (agent_uri LIKE 'data:%')
      ORDER BY priority, registered_at DESC NULLS LAST
    ) AS rn
    FROM due
  )
  SELECT chain_id, agent_id, agent_uri, attempts
  FROM ranked
  WHERE (agent_uri LIKE 'data:%' AND rn <= 200)
     OR (agent_uri NOT LIKE 'data:%' AND rn <= 40)
  ORDER BY (agent_uri LIKE 'data:%') DESC, priority, registered_at DESC NULLS LAST
  LIMIT 500
`;

async function queueDepth(): Promise<number> {
  try {
    const dueOnly = DUE_AGENTS.slice(0, DUE_AGENTS.indexOf(",\n  ranked AS"));
    const result = await getPool().query<{ count: string }>(`${dueOnly}\nSELECT count(*)::text AS count FROM due`);
    state.queueDepth = Number(result.rows[0]?.count ?? 0);
  } catch {
    state.queueDepth = 0;
  }
  return state.queueDepth;
}

async function writeResult(agent: AgentTarget, result: Awaited<ReturnType<typeof resolveUri>>, attempts: number): Promise<void> {
  if (result.ok) {
    const parsed: ParsedRegistration = result.parsed;
    await getPool().query(
      `INSERT INTO enrich.registration_files (
         chain_id, agent_id, agent_uri, content_hash, raw, name, description, image, active,
         x402_support, supported_trust, fetch_status, http_status, error, fetched_at, next_retry_at, attempts
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9,
         $10, $11, 'ok', $12, NULL, now(), NULL, 0
       )
       ON CONFLICT (chain_id, agent_id) DO UPDATE SET
         agent_uri = EXCLUDED.agent_uri,
         content_hash = EXCLUDED.content_hash,
         raw = EXCLUDED.raw,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         image = EXCLUDED.image,
         active = EXCLUDED.active,
         x402_support = EXCLUDED.x402_support,
         supported_trust = EXCLUDED.supported_trust,
         fetch_status = 'ok',
         http_status = EXCLUDED.http_status,
         error = NULL,
         fetched_at = now(),
         next_retry_at = NULL,
         attempts = 0`,
      [
        agent.chain_id,
        agent.agent_id,
        agent.agent_uri,
        result.hash,
        result.body,
        parsed.name,
        parsed.description,
        parsed.image,
        parsed.active,
        parsed.x402Support,
        parsed.supportedTrust,
        result.httpStatus,
      ],
    );
    await getPool().query("DELETE FROM enrich.agent_services WHERE chain_id = $1 AND agent_id = $2", [
      agent.chain_id,
      agent.agent_id,
    ]);
    for (const service of parsed.services) {
      await getPool().query(
        `INSERT INTO enrich.agent_services (chain_id, agent_id, name, endpoint, version, extra)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (chain_id, agent_id, name, endpoint) DO UPDATE SET
           version = EXCLUDED.version, extra = EXCLUDED.extra`,
        [agent.chain_id, agent.agent_id, service.name, service.endpoint, service.version, JSON.stringify(service.extra)],
      );
    }
    return;
  }
  const terminal = isTerminalFetchError(result.error);
  const delay = terminal ? null : (RETRY_MS[Math.min(Math.max(attempts, 1) - 1, RETRY_MS.length - 1)] ?? RETRY_MS[3]);
  await getPool().query(
    `DELETE FROM enrich.agent_services
     WHERE chain_id = $1 AND agent_id = $2
       AND EXISTS (
         SELECT 1 FROM enrich.registration_files existing
         WHERE existing.chain_id = $1 AND existing.agent_id = $2 AND existing.agent_uri IS DISTINCT FROM $3
       )`,
    [agent.chain_id, agent.agent_id, agent.agent_uri],
  );
  await getPool().query(
    `INSERT INTO enrich.registration_files (
       chain_id, agent_id, agent_uri, fetch_status, http_status, error, fetched_at, next_retry_at, attempts
     ) VALUES (
       $1, $2, $3, 'error', $4, $5, now(),
       CASE WHEN $6::text IS NULL THEN NULL ELSE now() + ($6::text || ' milliseconds')::interval END,
       $7
     )
     ON CONFLICT (chain_id, agent_id) DO UPDATE SET
       agent_uri = EXCLUDED.agent_uri,
       fetch_status = 'error',
       http_status = EXCLUDED.http_status,
       error = EXCLUDED.error,
       fetched_at = now(),
       next_retry_at = EXCLUDED.next_retry_at,
       attempts = EXCLUDED.attempts,
       raw = CASE WHEN enrich.registration_files.agent_uri IS NOT DISTINCT FROM EXCLUDED.agent_uri THEN enrich.registration_files.raw ELSE NULL END,
       content_hash = CASE WHEN enrich.registration_files.agent_uri IS NOT DISTINCT FROM EXCLUDED.agent_uri THEN enrich.registration_files.content_hash ELSE NULL END,
       name = CASE WHEN enrich.registration_files.agent_uri IS NOT DISTINCT FROM EXCLUDED.agent_uri THEN enrich.registration_files.name ELSE NULL END,
       description = CASE WHEN enrich.registration_files.agent_uri IS NOT DISTINCT FROM EXCLUDED.agent_uri THEN enrich.registration_files.description ELSE NULL END,
       image = CASE WHEN enrich.registration_files.agent_uri IS NOT DISTINCT FROM EXCLUDED.agent_uri THEN enrich.registration_files.image ELSE NULL END,
       active = CASE WHEN enrich.registration_files.agent_uri IS NOT DISTINCT FROM EXCLUDED.agent_uri THEN enrich.registration_files.active ELSE NULL END,
       x402_support = CASE WHEN enrich.registration_files.agent_uri IS NOT DISTINCT FROM EXCLUDED.agent_uri THEN enrich.registration_files.x402_support ELSE NULL END,
       supported_trust = CASE WHEN enrich.registration_files.agent_uri IS NOT DISTINCT FROM EXCLUDED.agent_uri THEN enrich.registration_files.supported_trust ELSE NULL END`,
    [agent.chain_id, agent.agent_id, agent.agent_uri, result.httpStatus, result.error, delay == null ? null : String(delay), attempts],
  );
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      if (!current) break;
      await fn(current);
    }
  });
  await Promise.all(workers);
}

async function fetchGroup(uri: string, agents: AgentTarget[]): Promise<"ok" | "error"> {
  const result = await resolveUri(uri);
  let outcome: "ok" | "error" = result.ok ? "ok" : "error";
  for (const agent of agents) {
    const attempts = result.ok ? 0 : agent.attempts + 1;
    try {
      await writeResult(agent, result, attempts);
    } catch {
      outcome = "error";
      try {
        await writeResult(
          agent,
          { ok: false, error: "unstorable content", httpStatus: result.httpStatus },
          Math.max(attempts, 1),
        );
      } catch {
        // A single bad file must not stop the rest of the pass.
      }
    }
  }
  return outcome;
}

async function selectAgents(): Promise<AgentTarget[]> {
  const result = await getPool().query<AgentTarget>(DUE_AGENTS);
  return result.rows;
}

async function runPass(): Promise<PassStats> {
  const started = Date.now();
  const agents = await selectAgents();
  const byUri = new Map<string, AgentTarget[]>();
  for (const agent of agents) {
    const group = byUri.get(agent.agent_uri) ?? [];
    group.push(agent);
    byUri.set(agent.agent_uri, group);
  }
  let fetched = 0;
  let failed = 0;
  const concurrency = envInt("ENRICH_CONCURRENCY", 5);
  await mapPool([...byUri.entries()], concurrency, async ([uri, group]) => {
    if (await isPaused()) return;
    const outcome = await fetchGroup(uri, group);
    if (outcome === "ok") fetched += group.length;
    else failed += group.length;
  });
  await queueDepth();
  return {
    at: new Date().toISOString(),
    selected: agents.length,
    fetched,
    failed,
    durationMs: Date.now() - started,
  };
}

async function claimJobs(): Promise<{ id: string; payload: { chainId?: number; agentId?: string } }[]> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string; payload: { chainId?: number; agentId?: string } }>(
      `UPDATE ops.jobs SET status = 'running', updated_at = now()
       WHERE id IN (
         SELECT id FROM ops.jobs
         WHERE kind = 'refetch_registration' AND status = 'pending'
         ORDER BY id
         LIMIT 5
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id::text, payload`,
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function finishJob(id: string, status: "done" | "failed", error: string | null): Promise<void> {
  await getPool().query("UPDATE ops.jobs SET status = $2, error = $3, updated_at = now() WHERE id = $1", [
    id,
    status,
    error,
  ]);
}

async function runJobs(): Promise<void> {
  const jobs = await claimJobs();
  for (const job of jobs) {
    try {
      const chainId = Number(job.payload.chainId);
      const agentId = String(job.payload.agentId ?? "");
      const found = await getPool().query<AgentTarget>(
        `SELECT chain_id, agent_id::text AS agent_id, agent_uri, 0 AS attempts
         FROM erc8004.agents WHERE chain_id = $1 AND agent_id = $2`,
        [chainId, agentId],
      );
      const agent = found.rows[0];
      if (!agent || !agent.agent_uri) {
        await finishJob(job.id, "failed", "agent not found or uri empty");
        continue;
      }
      const outcome = await fetchGroup(agent.agent_uri, [agent]);
      await finishJob(job.id, outcome === "ok" ? "done" : "failed", outcome === "ok" ? null : "fetch failed");
    } catch (error) {
      await finishJob(job.id, "failed", error instanceof Error ? error.message : String(error));
    }
  }
}

function startHealth(): void {
  const port = envInt("HEALTH_PORT", 42072);
  createServer((req, res) => {
    if (req.url?.startsWith("/health")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          paused: state.paused,
          queueDepth: state.queueDepth,
          lastPass: state.lastPass,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  }).listen(port, "127.0.0.1");
}

async function main(): Promise<void> {
  startHealth();
  let failures = 0;
  for (;;) {
    try {
      await runJobs();
      if (await isPaused()) {
        await sleep(2000);
        continue;
      }
      const stats = await runPass();
      state.lastPass = stats;
      log("info", "pass", stats);
      failures = 0;
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        await runJobs();
        if (await isPaused()) break;
        await sleep(2000);
      }
    } catch (error) {
      failures += 1;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
      log("error", "pass failed", {
        error: error instanceof Error ? error.message : String(error),
        retryInMs: delay,
      });
      await sleep(delay);
    }
  }
}

void main();