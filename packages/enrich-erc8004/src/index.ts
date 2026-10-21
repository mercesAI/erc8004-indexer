import { createServer } from "node:http";
import { envInt, envString, getPool, log } from "@merces/shared";
import { isTerminalFetchError, resolveUri, RETRY_MS, TERMINAL_FETCH_ERRORS, type ParsedRegistration } from "./fetchUri.js";

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
  /** True when more agents were due than this pass could take; the next pass starts at once. */
  backlog: boolean;
};

const state = {
  paused: false,
  queueDepth: 0,
  lastPass: null as PassStats | null,
  /**
   * Agents written by the indexer after this instant are candidates for a fetch. It starts at the
   * epoch, so the first pass after a restart looks at every agent once, and then only moves forward
   * when a pass had capacity to spare. A backlog keeps it where it is until the backlog drains.
   */
  watermark: new Date(0),
};

/** How far the watermark trails the scan, so an indexer transaction that committed late is still seen. */
const WATERMARK_LAG_MS = 2 * 60_000;

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

/**
 * Agents that need a fetch, in priority order, limited per chain so one chain cannot starve the
 * others: up to 200 data: URIs (decoded locally, no network) and up to 40 network fetches each.
 *
 * $1 watermark: only agents the indexer wrote after this time are considered, plus every file whose
 *    retry is due. That keeps a pass to a few index lookups instead of a scan of every agent.
 * $2 terminal errors: final for the URI they were recorded against. A new on-chain URI is tried again.
 */
const DUE_AGENTS = `
  WITH candidates AS (
    SELECT chain_id, agent_id FROM erc8004.agents WHERE updated_at > $1 AND agent_uri <> ''
    UNION
    SELECT chain_id, agent_id FROM enrich.registration_files
    WHERE fetch_status = 'error' AND next_retry_at IS NOT NULL AND next_retry_at <= now()
  ),
  due AS (
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
    FROM candidates c
    JOIN erc8004.agents a ON a.chain_id = c.chain_id AND a.agent_id = c.agent_id
    LEFT JOIN enrich.registration_files r
      ON r.chain_id = a.chain_id AND r.agent_id = a.agent_id
    WHERE a.agent_uri <> ''
      AND (
        r.agent_id IS NULL
        OR r.agent_uri IS DISTINCT FROM a.agent_uri
        OR (r.fetch_status = 'error' AND r.next_retry_at IS NOT NULL AND r.next_retry_at <= now())
      )
      AND NOT (COALESCE(r.error, '') = ANY($2::text[]) AND r.agent_uri IS NOT DISTINCT FROM a.agent_uri)
  ),
  ranked AS (
    SELECT *,
           row_number() OVER (
             PARTITION BY chain_id, (agent_uri LIKE 'data:%')
             ORDER BY priority, registered_at DESC NULLS LAST
           ) AS rn,
           -- A pass lasts as long as its slowest host. Capping each host keeps one slow platform
           -- from holding every other platform's fetches back.
           row_number() OVER (
             PARTITION BY chain_id, substring(agent_uri from '^https?://([^/]+)')
             ORDER BY priority, registered_at DESC NULLS LAST
           ) AS host_rn,
           count(*) OVER () AS queue_depth
    FROM due
  )
  SELECT chain_id, agent_id, agent_uri, attempts, queue_depth::text AS queue_depth
  FROM ranked
  WHERE (agent_uri LIKE 'data:%' AND rn <= $3)
     OR (agent_uri NOT LIKE 'data:%' AND rn <= $4 AND host_rn <= $6)
  ORDER BY (agent_uri LIKE 'data:%') DESC, priority, registered_at DESC NULLS LAST
  LIMIT $5
`;

/**
 * Per-pass budget. The SQL caps are upper bounds on what a pass may look at; each host's real
 * share and concurrency are learned (see hostShare and learnHosts). The defaults are gentle; a
 * server with a backlog runs with ENRICH_NETWORK_PER_CHAIN=3000 ENRICH_NETWORK_PER_HOST=3000
 * ENRICH_DATA_PER_CHAIN=3000 ENRICH_PASS_LIMIT=12000 ENRICH_CONCURRENCY=24 ENRICH_PER_HOST_CONCURRENCY=8.
 */
function budget() {
  return {
    dataPerChain: envInt("ENRICH_DATA_PER_CHAIN", 200),
    networkPerChain: envInt("ENRICH_NETWORK_PER_CHAIN", 40),
    networkPerHost: envInt("ENRICH_NETWORK_PER_HOST", 40),
    passLimit: envInt("ENRICH_PASS_LIMIT", 500),
    concurrency: envInt("ENRICH_CONCURRENCY", 5),
    perHost: envInt("ENRICH_PER_HOST_CONCURRENCY", 4),
  };
}

/**
 * Every host gets its own concurrency and its own share of a pass, both learned from how it
 * answered last time. A host that returns 429s or times out loses concurrency; a clean host gains
 * it, up to ENRICH_PER_HOST_CONCURRENCY. A pass gives each host about ENRICH_PASS_TARGET_SEC worth
 * of work at its measured rate, so a slow platform never holds the others back.
 */
type HostStats = {
  concurrency: number;
  /** Files per second seen in the last pass that fetched from this host. */
  rate: number | null;
  lastPass: { done: number; throttled: number; seconds: number } | null;
};

const hosts = new Map<string, HostStats>();
const hostSlots = new Map<string, { active: number; waiting: (() => void)[] }>();

function hostStats(host: string): HostStats {
  let stats = hosts.get(host);
  if (!stats) {
    stats = { concurrency: Math.max(1, Math.min(2, budget().perHost)), rate: null, lastPass: null };
    hosts.set(host, stats);
  }
  return stats;
}

function hostOf(uri: string): string {
  if (uri.startsWith("data:")) return "data:";
  try {
    return new URL(uri.startsWith("ipfs://") ? envString("IPFS_GATEWAY") : uri).host;
  } catch {
    return "invalid";
  }
}

async function withHostSlot<T>(host: string, fn: () => Promise<T>): Promise<T> {
  if (host === "data:" || host === "invalid") return fn();
  const slot = hostSlots.get(host) ?? { active: 0, waiting: [] };
  hostSlots.set(host, slot);
  while (slot.active >= hostStats(host).concurrency) await new Promise<void>((resolve) => slot.waiting.push(resolve));
  slot.active += 1;
  try {
    return await fn();
  } finally {
    slot.active -= 1;
    const next = slot.waiting.shift();
    if (next) next();
    if (slot.active === 0 && slot.waiting.length === 0) hostSlots.delete(host);
  }
}

/** How many URI groups of `host` this pass takes: about one target window at the measured rate. */
function hostShare(host: string): number {
  if (host === "data:" || host === "invalid") return Number.POSITIVE_INFINITY;
  const target = envInt("ENRICH_PASS_TARGET_SEC", 60);
  const stats = hostStats(host);
  // An unmeasured host gets a modest first share; its rate is known after one pass.
  const rate = stats.rate ?? 1;
  return Math.max(10, Math.round(rate * target));
}

const THROTTLE_ERRORS = new Set(["HTTP 429", "HTTP 503", "timeout"]);

/** After a pass: record each host's rate, and move its concurrency toward what it tolerates. */
function learnHosts(seen: Map<string, { done: number; throttled: number; firstAt: number; lastAt: number }>): void {
  const max = Math.max(1, budget().perHost);
  for (const [host, s] of seen) {
    if (host === "data:" || host === "invalid") continue;
    const stats = hostStats(host);
    const seconds = Math.max(1, (s.lastAt - s.firstAt) / 1000);
    stats.lastPass = { done: s.done, throttled: s.throttled, seconds };
    if (s.done >= 5) stats.rate = s.done / seconds;
    const throttleRatio = s.throttled / Math.max(1, s.done + s.throttled);
    if (throttleRatio > 0.1) stats.concurrency = Math.max(1, Math.floor(stats.concurrency / 2));
    else if (s.throttled === 0 && stats.concurrency < max) stats.concurrency += 1;
  }
}

export function hostReport(): Record<string, { concurrency: number; perSec: number | null; lastPass: HostStats["lastPass"] }> {
  return Object.fromEntries(
    [...hosts.entries()].map(([host, stats]) => [host, { concurrency: stats.concurrency, perSec: stats.rate == null ? null : Math.round(stats.rate * 10) / 10, lastPass: stats.lastPass }]),
  );
}

async function writeResult(agent: AgentTarget, result: Awaited<ReturnType<typeof resolveUri>>, attempts: number): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (result.ok) {
      const parsed: ParsedRegistration = result.parsed;
      await client.query(
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
      await client.query("DELETE FROM enrich.agent_services WHERE chain_id = $1 AND agent_id = $2", [agent.chain_id, agent.agent_id]);
      for (const service of parsed.services) {
        await client.query(
          `INSERT INTO enrich.agent_services (chain_id, agent_id, name, endpoint, version, extra)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (chain_id, agent_id, name, endpoint) DO UPDATE SET
             version = EXCLUDED.version, extra = EXCLUDED.extra`,
          [agent.chain_id, agent.agent_id, service.name, service.endpoint, service.version, JSON.stringify(service.extra)],
        );
      }
    } else {
      const terminal = isTerminalFetchError(result.error);
      const delay = terminal ? null : (RETRY_MS[Math.min(Math.max(attempts, 1) - 1, RETRY_MS.length - 1)] ?? RETRY_MS[3]);
      // The services of a previous good fetch stay while the URI is unchanged. A new URI that fails drops them.
      await client.query(
        `DELETE FROM enrich.agent_services
         WHERE chain_id = $1 AND agent_id = $2
           AND EXISTS (
             SELECT 1 FROM enrich.registration_files existing
             WHERE existing.chain_id = $1 AND existing.agent_id = $2 AND existing.agent_uri IS DISTINCT FROM $3
           )`,
        [agent.chain_id, agent.agent_id, agent.agent_uri],
      );
      await client.query(
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Run `fn` over `items` with bounded concurrency. Every worker finishes before the first error is rethrown. */
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
  const results = await Promise.allSettled(workers);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

/**
 * Only a Postgres data error means the file itself cannot be stored (an odd string, a value out of
 * range). Anything else, such as a dropped connection or a full pool, is the database's moment,
 * not the file's, so the pass fails and the agent stays due.
 */
function isUnstorable(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && (code.startsWith("22") || code.startsWith("54"));
}

async function fetchGroup(uri: string, agents: AgentTarget[]): Promise<"ok" | "error" | "throttled"> {
  const result = await withHostSlot(hostOf(uri), () => resolveUri(uri));
  let outcome: "ok" | "error" | "throttled" = result.ok ? "ok" : THROTTLE_ERRORS.has(result.error) ? "throttled" : "error";
  for (const agent of agents) {
    const attempts = result.ok ? 0 : agent.attempts + 1;
    try {
      await writeResult(agent, result, attempts);
    } catch (error) {
      if (!isUnstorable(error)) throw error;
      outcome = "error";
      await writeResult(agent, { ok: false, error: "unstorable content", httpStatus: result.httpStatus }, Math.max(attempts, 1));
    }
  }
  return outcome;
}

type Selection = { agents: AgentTarget[]; queueDepth: number };

async function selectAgents(since: Date): Promise<Selection> {
  const b = budget();
  const result = await getPool().query<AgentTarget & { queue_depth: string }>(DUE_AGENTS, [
    since,
    [...TERMINAL_FETCH_ERRORS],
    b.dataPerChain,
    b.networkPerChain,
    b.passLimit,
    b.networkPerHost,
  ]);
  const queueDepth = Number(result.rows[0]?.queue_depth ?? 0);
  return { agents: result.rows.map(({ queue_depth: _depth, ...agent }) => agent), queueDepth };
}

async function runPass(): Promise<PassStats> {
  const started = Date.now();
  const { agents, queueDepth } = await selectAgents(state.watermark);
  state.queueDepth = queueDepth;
  const byUri = new Map<string, AgentTarget[]>();
  for (const agent of agents) {
    const group = byUri.get(agent.agent_uri) ?? [];
    group.push(agent);
    byUri.set(agent.agent_uri, group);
  }
  // Each host gets about one target window of work at its measured rate; the rest stays due.
  const taken = new Map<string, number>();
  const work: [string, AgentTarget[]][] = [];
  let left = 0;
  for (const entry of byUri) {
    const host = hostOf(entry[0]);
    const n = taken.get(host) ?? 0;
    if (n < hostShare(host)) {
      taken.set(host, n + 1);
      work.push(entry);
    } else {
      left += entry[1].length;
    }
  }
  const selected = agents.length - left;
  let fetched = 0;
  let failed = 0;
  let groups = 0;
  let skipped = 0;
  const seen = new Map<string, { done: number; throttled: number; firstAt: number; lastAt: number }>();
  const concurrency = budget().concurrency;
  await mapPool(work, concurrency, async ([uri, group]) => {
    groups += 1;
    if (groups % 10 === 1 && (await isPaused())) {
      skipped += group.length;
      return;
    }
    const host = hostOf(uri);
    const begun = Date.now();
    const outcome = await fetchGroup(uri, group);
    const s = seen.get(host) ?? { done: 0, throttled: 0, firstAt: begun, lastAt: begun };
    if (outcome === "throttled") s.throttled += 1;
    else s.done += 1;
    s.lastAt = Date.now();
    seen.set(host, s);
    if (outcome === "ok") fetched += group.length;
    else failed += group.length;
  });
  learnHosts(seen);
  // Everything due was taken and written: later passes only need what the indexer writes from here on.
  // Otherwise the backlog is re-scanned next pass, which is the full scan until it drains.
  if (skipped === 0 && left === 0 && queueDepth <= agents.length) state.watermark = new Date(started - WATERMARK_LAG_MS);
  return {
    at: new Date().toISOString(),
    selected,
    fetched,
    failed,
    durationMs: Date.now() - started,
    backlog: left > 0 || queueDepth > agents.length,
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
          watermark: state.watermark.toISOString(),
          hosts: hostReport(),
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  })
    .on("error", (error: NodeJS.ErrnoException) => {
      log("error", "health server failed", { port, error: error.message });
      process.exit(1);
    })
    .listen(port, "127.0.0.1");
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
      // With a backlog, go straight to the next pass; otherwise look again in a minute.
      const until = Date.now() + (stats.backlog ? 2000 : 60_000);
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