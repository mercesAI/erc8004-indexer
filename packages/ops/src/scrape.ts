import { alchemyMaxRps, enabledChains, envInt, getPool } from "@merces/shared";
import { pruneOpsRows } from "./logs.js";
import { healthPort } from "./proc.js";
import { ensureReadModel } from "./schemas.js";

/**
 * Every METRICS_INTERVAL_SEC the supervisor reads the workers' health endpoints and the row counts,
 * and stores one ops.metrics_snapshots row. It makes no RPC calls: the indexer already records the
 * chain head it saw on every cycle.
 */

type ChainHealth = {
  chainId: number;
  startBlock: number;
  lastBlock: number | null;
  headBlock: number | null;
  catchingUp: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  events: number;
  rpcRequests: number;
  rpcErrors: number;
};

type ChainPoint = {
  chain: string;
  chainId: number;
  indexedBlock: number | null;
  headBlock: number | null;
  lag: number | null;
  progressPct: number | null;
  eventsPerSec: number;
  rpcPerSec: number;
  errorCount: number;
  status: "backfill" | "live" | "unknown";
  lastRunAt: string | null;
  lastError: string | null;
};

export type MetricsPayload = {
  chains: ChainPoint[];
  counts: { agents: number; feedback: number; validations: number; registrationFiles: number };
  workers: Record<string, unknown>;
  alchemyMaxRps: number;
};

const previous = new Map<string, { at: number; events: number; rpc: number }>();

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

async function count(sql: string): Promise<number> {
  try {
    const result = await getPool().query<{ n: string }>(sql);
    return Number(result.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

function chainPoint(key: string, chainId: number, startBlock: number, health: ChainHealth | undefined): ChainPoint {
  const now = Date.now();
  const events = health?.events ?? 0;
  const rpc = health?.rpcRequests ?? 0;
  const prev = previous.get(key);
  const dt = prev ? Math.max(1, (now - prev.at) / 1000) : 0;
  // Counters restart from zero when the indexer restarts; a negative delta counts as zero.
  const eventsPerSec = prev && dt ? Math.max(0, (events - prev.events) / dt) : 0;
  const rpcPerSec = prev && dt ? Math.max(0, (rpc - prev.rpc) / dt) : 0;
  previous.set(key, { at: now, events, rpc });
  const indexed = health?.lastBlock ?? null;
  const head = health?.headBlock ?? null;
  let progressPct: number | null = null;
  if (indexed != null && head != null && head > startBlock) {
    progressPct = Math.min(100, Math.max(0, ((indexed - startBlock) / (head - startBlock)) * 100));
  }
  return {
    chain: key,
    chainId,
    indexedBlock: indexed,
    headBlock: head,
    lag: indexed != null && head != null ? Math.max(0, head - indexed) : null,
    progressPct,
    eventsPerSec,
    rpcPerSec,
    errorCount: health?.rpcErrors ?? 0,
    status: !health || health.lastRunAt == null ? "unknown" : health.catchingUp ? "backfill" : "live",
    lastRunAt: health?.lastRunAt ?? null,
    lastError: health?.lastError ?? null,
  };
}

export async function scrapeOnce(): Promise<MetricsPayload> {
  // One hash and two lookups when nothing changed; a rebuild that failed at startup is retried here.
  await ensureReadModel({ wait: false }).catch((error: unknown) => {
    console.error(JSON.stringify({ level: "error", msg: "read views not rebuilt yet", error: String(error) }));
  });
  const workers: Record<string, unknown> = {};
  for (const name of ["indexer", "importer", "enrich"] as const) {
    try {
      workers[name] = await getJson(`http://127.0.0.1:${healthPort(name)}/health`);
    } catch (error) {
      workers[name] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const indexerChains = ((workers.indexer as { chains?: Record<string, ChainHealth> })?.chains ?? {}) as Record<string, ChainHealth>;
  const chains = enabledChains().map((chain) => chainPoint(chain.key, chain.chainId, chain.startBlock, indexerChains[chain.key]));
  const payload: MetricsPayload = {
    chains,
    counts: {
      agents: await count("SELECT count(*)::text AS n FROM erc8004.agents"),
      feedback: await count("SELECT count(*)::text AS n FROM erc8004.feedback"),
      validations: await count("SELECT count(*)::text AS n FROM erc8004.validations"),
      registrationFiles: await count("SELECT count(*)::text AS n FROM enrich.registration_files WHERE fetch_status = 'ok'"),
    },
    workers,
    alchemyMaxRps: alchemyMaxRps(),
  };
  await getPool().query("INSERT INTO ops.metrics_snapshots (payload) VALUES ($1::jsonb)", [JSON.stringify(payload)]);
  await pruneOpsRows();
  return payload;
}

export function startMetrics(): void {
  const interval = Math.max(1, envInt("METRICS_INTERVAL_SEC", 15)) * 1000;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    scrapeOnce()
      .catch((error: unknown) => {
        console.error(JSON.stringify({ level: "error", msg: "metrics scrape failed", error: String(error) }));
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  setInterval(tick, interval);
}
