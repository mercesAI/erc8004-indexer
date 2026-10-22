import { createServer } from "node:http";
import { envInt, getPool, log } from "@merces/shared";
import { gateways, ipfsPath, IPFS_URI_SQL_PATTERN, isTerminalFetchError, resolveUri, RETRY_MS, TERMINAL_FETCH_ERRORS, THROTTLE_RETRY_MS, type ParsedRegistration } from "./fetchUri.js";

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
 * Agents that need a fetch, sized per host so a pass takes about what each host can answer in one
 * target window, and no platform starves another.
 *
 * $1 watermark: only agents the indexer wrote after this time are considered, plus every file whose
 *    retry is due. That keeps a pass to a few index lookups instead of a scan of every agent.
 * $2 terminal errors: final for the URI they were recorded against. A new on-chain URI is tried again.
 * $3 data: URIs per chain (decoded locally, no network). $4 network fetches per chain. $5 overall limit.
 * $6 hard cap on one host's rows per chain. $7 learned share per host, JSON {host: rows}; a paused host
 *    has 0 and selects nothing. $8 share of a host not seen yet. $9 the IPFS test: every IPFS URI counts
 *    under the host 'ipfs', whose share is the sum of the gateways' shares.
 */
const DUE_SET = `
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
             WHEN a.agent_uri ~* $9 THEN 'ipfs'
             ELSE lower(substring(a.agent_uri from '^https?://([^/]+)'))
           END AS host,
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
  )`;

const DUE_AGENTS = `${DUE_SET},
  by_host AS (
    -- Rank within each host first, so a chain's share interleaves its hosts instead of taking
    -- the newest rows, which would all belong to whichever platform registered most recently.
    SELECT due.*,
           row_number() OVER (
             PARTITION BY chain_id, host
             ORDER BY priority, registered_at DESC NULLS LAST
           ) AS host_rn,
           count(*) OVER () AS queue_depth
    FROM due
  ),
  ranked AS (
    -- Each host contributes what it can answer this pass. data: URIs cost no network and are not sized.
    SELECT b.*,
           row_number() OVER (
             PARTITION BY b.chain_id, (b.agent_uri LIKE 'data:%')
             ORDER BY b.host_rn, b.priority, b.registered_at DESC NULLS LAST
           ) AS rn
    FROM by_host b
    LEFT JOIN jsonb_each_text($7::jsonb) AS share(host, n) ON share.host = b.host
    WHERE b.agent_uri LIKE 'data:%' OR b.host_rn <= LEAST($6::int, COALESCE(share.n::int, $8::int))
  )
  SELECT chain_id, agent_id, agent_uri, attempts, queue_depth::text AS queue_depth
  FROM ranked
  WHERE (agent_uri LIKE 'data:%' AND rn <= $3)
     OR (agent_uri NOT LIKE 'data:%' AND rn <= $4)
  -- rn first, so the overall limit interleaves chains and hosts instead of taking one host's retries first.
  ORDER BY (agent_uri LIKE 'data:%') DESC, rn, priority
  LIMIT $5
`;

/** How many agents are due, for a pass that selected none: every host with work may be paused. */
const DUE_COUNT = `${DUE_SET.replace("$9", "$3")}
  SELECT count(*)::text AS n FROM due
`;

/**
 * Per-pass budget. The SQL caps are upper bounds on what a pass may look at; each host's real
 * share and concurrency are learned (see hostShare and learnHosts). The defaults are gentle; a
 * server with a backlog runs with ENRICH_NETWORK_PER_CHAIN=12000 ENRICH_NETWORK_PER_HOST=12000
 * ENRICH_DATA_PER_CHAIN=3000 ENRICH_PASS_LIMIT=12000 ENRICH_CONCURRENCY=64 ENRICH_PER_HOST_CONCURRENCY=16.
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
 * answered last time. A host that returns 429s or times out loses concurrency, and one that mostly
 * refuses is paused for a while; a clean host gains concurrency, up to ENRICH_PER_HOST_CONCURRENCY.
 * A pass gives each host about ENRICH_PASS_TARGET_SEC worth of work at its measured rate, so a slow
 * platform never holds the others back. IPFS files are spread over the configured gateways the same
 * way: each is a host of its own, and a file goes to the gateway with the most of its share left.
 */
type HostStats = {
  concurrency: number;
  /** Seconds one fetch takes on this host, averaged over the last pass that used it. */
  latency: number | null;
  /** Set while the host is left alone after answering mostly 429, 503, or timeouts. */
  pausedUntil: number;
  pauses: number;
  lastPass: { done: number; throttled: number; latency: number } | null;
};

/** Files per second this host can deliver at its current concurrency. */
function hostRate(stats: HostStats): number | null {
  return stats.latency == null ? null : stats.concurrency / Math.max(0.05, stats.latency);
}

const hosts = new Map<string, HostStats>();
const hostSlots = new Map<string, { active: number; waiting: (() => void)[] }>();

function hostStats(host: string): HostStats {
  let stats = hosts.get(host);
  if (!stats) {
    // Two to begin with: a platform that limits requests by the minute is found before it is flooded.
    stats = { concurrency: Math.max(1, Math.min(2, budget().perHost)), latency: null, pausedUntil: 0, pauses: 0, lastPass: null };
    hosts.set(host, stats);
  }
  return stats;
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

/** Rows a host gets before its pace is known. */
function firstShare(): number {
  return Math.max(10, envInt("ENRICH_PASS_TARGET_SEC", 60));
}

/** How many URI groups of `host` this pass takes: about one target window at the measured rate. */
function hostShare(host: string): number {
  if (host === "data:" || host === "invalid") return Number.POSITIVE_INFINITY;
  const stats = hostStats(host);
  if (stats.pausedUntil > Date.now()) return 0;
  const rate = hostRate(stats);
  if (rate == null) return firstShare();
  return Math.max(10, Math.round(rate * envInt("ENRICH_PASS_TARGET_SEC", 60)));
}

/** The share of every host seen so far, for the selection. IPFS files count under 'ipfs', the gateways' total. */
function hostShares(): Record<string, number> {
  const gatewayHosts = new Set(gateways().map((gateway) => new URL(gateway).host));
  const shares: Record<string, number> = { ipfs: 0 };
  for (const host of gatewayHosts) shares.ipfs += hostShare(host);
  for (const host of hosts.keys()) {
    if (host === "data:" || host === "invalid" || gatewayHosts.has(host)) continue;
    shares[host] = hostShare(host);
  }
  return shares;
}

type Plan = { host: string; gateway?: string };

/**
 * Where a fetch of `uri` goes: for an IPFS file the gateway with the most of its share still free,
 * for http(s) the URL's host, "data:" for an inline file, "invalid" for anything else. `assigned`
 * counts the IPFS files already given to each gateway this pass.
 */
function planFetch(uri: string, assigned: Map<string, number>): Plan {
  if (uri.startsWith("data:")) return { host: "data:" };
  try {
    const path = ipfsPath(uri);
    if (path == null) return { host: new URL(uri).host };
    const gateway = pickGateway(assigned);
    return gateway ? { host: new URL(gateway).host, gateway } : { host: "invalid" };
  } catch {
    return { host: "invalid" };
  }
}

function pickGateway(assigned: Map<string, number>): string | null {
  const list = gateways();
  const live = list.filter((gateway) => hostShare(new URL(gateway).host) > 0);
  if (live.length === 0) {
    // Every gateway is paused. Name the one that resumes first; its share of 0 leaves the file due.
    return list.sort((a, b) => hostStats(new URL(a).host).pausedUntil - hostStats(new URL(b).host).pausedUntil)[0] ?? null;
  }
  let best = live[0] as string;
  let bestFree = Number.NEGATIVE_INFINITY;
  for (const gateway of live) {
    const share = hostShare(new URL(gateway).host);
    const free = (share - (assigned.get(gateway) ?? 0)) / share;
    if (free > bestFree) {
      best = gateway;
      bestFree = free;
    }
  }
  assigned.set(best, (assigned.get(best) ?? 0) + 1);
  return best;
}

const THROTTLE_ERRORS = new Set(["HTTP 429", "HTTP 503", "timeout"]);

/** One pass on one host: answered fetches, refusals, and the time the answered ones took. */
type Seen = { done: number; throttled: number; busyMs: number };

/** After a pass: record each host's latency, and move its concurrency toward what it tolerates. */
function learnHosts(seen: Map<string, Seen>): void {
  const max = Math.max(1, budget().perHost);
  for (const [host, s] of seen) {
    if (host === "data:" || host === "invalid") continue;
    const stats = hostStats(host);
    const attempts = s.done + s.throttled;
    // Latency comes from answered fetches only: a refusal arrives in milliseconds and says nothing about pace.
    const latency = s.done > 0 ? s.busyMs / s.done / 1000 : stats.latency ?? 1;
    stats.lastPass = { done: s.done, throttled: s.throttled, latency: Math.round(latency * 100) / 100 };
    if (s.done >= 5) stats.latency = latency;
    const throttleRatio = s.throttled / Math.max(1, attempts);
    if (attempts >= 10 && throttleRatio >= 0.5) {
      // The host is refusing us. Leave it alone for a while, longer each time it happens in a row.
      stats.concurrency = 1;
      stats.pauses = Math.min(stats.pauses + 1, 6);
      stats.pausedUntil = Date.now() + 5 * 60_000 * 2 ** (stats.pauses - 1);
      log("warn", "host is throttling; pausing it", { host, minutes: 5 * 2 ** (stats.pauses - 1), throttled: s.throttled, done: s.done });
    } else if (attempts >= 10 && throttleRatio > 0.2) {
      stats.concurrency = Math.max(1, Math.floor(stats.concurrency / 2));
    } else if (s.throttled === 0) {
      stats.pauses = 0;
      if (stats.concurrency < max) stats.concurrency += 1;
    }
  }
}

export function hostReport(): Record<string, { concurrency: number; perSec: number | null; pausedUntil: string | null; lastPass: HostStats["lastPass"] }> {
  return Object.fromEntries(
    [...hosts.entries()].map(([host, stats]) => {
      const rate = hostRate(stats);
      return [
        host,
        {
          concurrency: stats.concurrency,
          perSec: rate == null ? null : Math.round(rate * 10) / 10,
          pausedUntil: stats.pausedUntil > Date.now() ? new Date(stats.pausedUntil).toISOString() : null,
          lastPass: stats.lastPass,
        },
      ];
    }),
  );
}

type Work = { uri: string; agents: AgentTarget[]; host: string; gateway?: string };

/**
 * Run a pass: `concurrency` workers pick the next URI from any host that still has a free slot,
 * so nobody queues behind one busy platform. Picking stops at `deadline`; fetches already running
 * finish, and whatever was not started stays due for the next pass. Returns what was left.
 */
async function runWork(
  work: Work[],
  concurrency: number,
  deadline: number,
  onDone: (host: string, outcome: "ok" | "error" | "throttled", ms: number, agents: number) => void,
): Promise<number> {
  const queues = new Map<string, Work[]>();
  for (const entry of work) {
    const queue = queues.get(entry.host) ?? [];
    queue.push(entry);
    queues.set(entry.host, queue);
  }
  const order = [...queues.keys()];
  const active = new Map<string, number>();
  let cursor = 0;
  let waiters: (() => void)[] = [];
  const wake = () => {
    const list = waiters;
    waiters = [];
    for (const resolve of list) resolve();
  };
  const pick = (): Work | null => {
    for (let i = 0; i < order.length; i++) {
      const host = order[(cursor + i) % order.length] as string;
      const queue = queues.get(host) as Work[];
      if (queue.length === 0) continue;
      const limit = host === "data:" || host === "invalid" ? Number.POSITIVE_INFINITY : hostStats(host).concurrency;
      if ((active.get(host) ?? 0) >= limit) continue;
      cursor = (cursor + i + 1) % order.length;
      return queue.shift() as Work;
    }
    return null;
  };
  const remaining = () => {
    let n = 0;
    for (const queue of queues.values()) for (const entry of queue) n += entry.agents.length;
    return n;
  };
  let picks = 0;
  const worker = async () => {
    while (Date.now() < deadline) {
      const next = pick();
      if (!next) {
        if (remaining() === 0) return;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 1000);
        });
        continue;
      }
      picks += 1;
      if (picks % 20 === 0 && (await isPaused())) return;
      active.set(next.host, (active.get(next.host) ?? 0) + 1);
      const begun = Date.now();
      try {
        const outcome = await fetchGroup(next);
        onDone(next.host, outcome, Date.now() - begun, next.agents.length);
      } finally {
        active.set(next.host, (active.get(next.host) ?? 0) - 1);
        wake();
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, work.length) }, worker));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return remaining();
}

async function writeResult(agent: AgentTarget, result: Awaited<ReturnType<typeof resolveUri>>, attempts: number, throttled = false): Promise<void> {
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
      const delay = terminal ? null : throttled ? THROTTLE_RETRY_MS : (RETRY_MS[Math.min(Math.max(attempts, 1) - 1, RETRY_MS.length - 1)] ?? RETRY_MS[3]);
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

/**
 * Only a Postgres data error means the file itself cannot be stored (an odd string, a value out of
 * range). Anything else, such as a dropped connection or a full pool, is the database's moment,
 * not the file's, so the pass fails and the agent stays due.
 */
function isUnstorable(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && (code.startsWith("22") || code.startsWith("54"));
}

async function fetchGroup({ uri, agents, host, gateway }: Work): Promise<"ok" | "error" | "throttled"> {
  const result = await withHostSlot(host, () => resolveUri(uri, gateway));
  let outcome: "ok" | "error" | "throttled" = result.ok ? "ok" : THROTTLE_ERRORS.has(result.error) ? "throttled" : "error";
  for (const agent of agents) {
    // A refusal says nothing about the file: it goes back to the first step and is retried soon.
    const attempts = result.ok ? 0 : outcome === "throttled" ? 1 : agent.attempts + 1;
    try {
      await writeResult(agent, result, attempts, outcome === "throttled");
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
    JSON.stringify(hostShares()),
    firstShare(),
    IPFS_URI_SQL_PATTERN,
  ]);
  if (result.rows.length === 0) {
    // Nothing selected does not mean nothing due: a paused host's rows are left out. Count them.
    const count = await getPool().query<{ n: string }>(DUE_COUNT, [since, [...TERMINAL_FETCH_ERRORS], IPFS_URI_SQL_PATTERN]);
    return { agents: [], queueDepth: Number(count.rows[0]?.n ?? 0) };
  }
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
  // The selection is already sized per host; this trims a host whose share shrank since it ran.
  const taken = new Map<string, number>();
  const assigned = new Map<string, number>();
  const work: Work[] = [];
  let left = 0;
  for (const [uri, group] of byUri) {
    const plan = planFetch(uri, assigned);
    const n = taken.get(plan.host) ?? 0;
    if (n < hostShare(plan.host)) {
      taken.set(plan.host, n + 1);
      work.push({ uri, agents: group, ...plan });
    } else {
      left += group.length;
    }
  }
  let fetched = 0;
  let failed = 0;
  const seen = new Map<string, Seen>();
  const deadline = started + envInt("ENRICH_PASS_TARGET_SEC", 60) * 1000;
  const notStarted = await runWork(work, budget().concurrency, deadline, (host, outcome, ms, agents) => {
    const s = seen.get(host) ?? { done: 0, throttled: 0, busyMs: 0 };
    if (outcome === "throttled") {
      s.throttled += 1;
    } else {
      s.done += 1;
      s.busyMs += ms;
    }
    seen.set(host, s);
    if (outcome === "ok") fetched += agents;
    else failed += agents;
  });
  left += notStarted;
  const selected = agents.length - left;
  learnHosts(seen);
  // Everything due was taken and written: later passes only need what the indexer writes from here on.
  // Otherwise the backlog is re-scanned next pass, which is the full scan until it drains.
  if (left === 0 && queueDepth <= agents.length) state.watermark = new Date(started - WATERMARK_LAG_MS);
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
      const outcome = await fetchGroup({ uri: agent.agent_uri, agents: [agent], ...planFetch(agent.agent_uri, new Map()) });
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