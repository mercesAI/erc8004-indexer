import { alchemyMaxRps, enabledChains, getPool, getPublicClient, type EnabledChain } from "@merces/shared";
import { pruneOpsRows, recordLine } from "./logs.js";
import { ponderPort, refreshChainViews } from "./schemas.js";

type Metric = { name: string; labels: Record<string, string>; value: number };

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
};

export type MetricsPayload = {
  chains: ChainPoint[];
  counts: { agents: number; feedback: number; validations: number; registrationFiles: number };
  workers: Record<string, unknown>;
  alchemyMaxRps: number;
};

const previous = new Map<string, { at: number; events: number; rpc: number }>();

function parsePrometheus(text: string): Metric[] {
  const metrics: Metric[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([a-zA-Z_:][\w:]*)(\{([^}]*)\})?\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i);
    if (!match) continue;
    const labels: Record<string, string> = {};
    if (match[3]) {
      for (const part of match[3].split(",")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        labels[part.slice(0, eq).trim()] = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
      }
    }
    metrics.push({ name: match[1] ?? "", labels, value: Number(match[4]) });
  }
  return metrics;
}

function sum(metrics: Metric[], name: string, chain?: string): number {
  return metrics
    .filter((metric) => metric.name === name)
    .filter((metric) => {
      if (!chain) return true;
      const label = metric.labels.chain ?? metric.labels.chain_name ?? metric.labels.network;
      return !label || label === chain;
    })
    .reduce((total, metric) => total + metric.value, 0);
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function count(sql: string): Promise<number> {
  try {
    const result = await getPool().query<{ n: string }>(sql);
    return Number(result.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

async function maxBlock(chainId: number): Promise<number | null> {
  try {
    const result = await getPool().query<{ n: string | null }>(
      "SELECT max(block_number)::text AS n FROM erc8004.raw_events WHERE chain_id = $1",
      [chainId],
    );
    return result.rows[0]?.n == null ? null : Number(result.rows[0].n);
  } catch {
    return null;
  }
}

async function chainPoint(chain: EnabledChain, statusBody: Record<string, unknown>, metrics: Metric[]): Promise<ChainPoint> {
  const status = statusBody[chain.key] as { block?: { number?: number } | null } | undefined;
  const liveBlock = status?.block?.number ?? null;
  const dbBlock = await maxBlock(chain.chainId);
  const indexedBlock = liveBlock ?? dbBlock;
  let headBlock: number | null = null;
  try {
    headBlock = Number(await getPublicClient(chain.key).getBlockNumber());
  } catch {
    headBlock = null;
  }
  const historicalTotal = sum(metrics, "ponder_historical_total_blocks", chain.key);
  const historicalDone = sum(metrics, "ponder_historical_completed_blocks", chain.key);
  let progressPct: number | null = null;
  if (liveBlock != null && headBlock != null && headBlock > chain.startBlock) {
    progressPct = Math.min(100, Math.max(0, ((liveBlock - chain.startBlock) / (headBlock - chain.startBlock)) * 100));
  } else if (historicalTotal > 0) {
    progressPct = Math.min(100, (historicalDone / historicalTotal) * 100);
  } else if (indexedBlock != null && headBlock != null && headBlock > chain.startBlock) {
    progressPct = Math.min(100, Math.max(0, ((indexedBlock - chain.startBlock) / (headBlock - chain.startBlock)) * 100));
  }
  const now = Date.now();
  const events = sum(metrics, "ponder_indexing_completed_events", chain.key);
  const rpc = sum(metrics, "ponder_rpc_request_duration_count", chain.key);
  const prev = previous.get(chain.key);
  const dt = prev ? Math.max(1, (now - prev.at) / 1000) : 0;
  const eventsPerSec = prev && dt ? Math.max(0, (events - prev.events) / dt) : 0;
  const rpcPerSec = prev && dt ? Math.max(0, (rpc - prev.rpc) / dt) : 0;
  previous.set(chain.key, { at: now, events, rpc });
  const errorCount =
    sum(metrics, "ponder_rpc_request_error_total", chain.key) +
    sum(metrics, "ponder_indexing_function_error_total", chain.key);
  return {
    chain: chain.key,
    chainId: chain.chainId,
    indexedBlock,
    headBlock,
    lag: indexedBlock != null && headBlock != null ? headBlock - indexedBlock : null,
    progressPct,
    eventsPerSec,
    rpcPerSec,
    errorCount,
    status: liveBlock != null ? "live" : indexedBlock != null ? "backfill" : "unknown",
  };
}

export async function scrapeOnce(): Promise<MetricsPayload> {
  await refreshChainViews().catch((error: unknown) => {
    recordLine("ops", "error", `view refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const enabled = enabledChains();
  const workers: Record<string, unknown> = {};
  for (const [name, healthPort] of [["importer", "42071"], ["enrich", "42072"]] as const) {
    try {
      workers[name] = await getJson(`http://127.0.0.1:${healthPort}/health`);
    } catch (error) {
      workers[name] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const chains = [];
  for (const [index, chain] of enabled.entries()) {
    let statusBody: Record<string, unknown> = {};
    let metrics: Metric[] = [];
    const port = ponderPort(index);
    try {
      statusBody = (await getJson(`http://127.0.0.1:${port}/status`)) as Record<string, unknown>;
    } catch {
      statusBody = {};
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(4000) });
      if (response.ok) metrics = parsePrometheus(await response.text());
    } catch {
      metrics = [];
    }
    chains.push(await chainPoint(chain, statusBody, metrics));
  }
  const payload: MetricsPayload = {
    chains,
    counts: {
      agents: await count("SELECT count(*)::text AS n FROM erc8004.agents"),
      feedback: await count("SELECT count(*)::text AS n FROM erc8004.feedback"),
      validations: await count("SELECT count(*)::text AS n FROM erc8004.validations"),
      registrationFiles: await count(
        "SELECT count(*)::text AS n FROM enrich.registration_files WHERE fetch_status = 'ok'",
      ),
    },
    workers,
    alchemyMaxRps: alchemyMaxRps(),
  };
  await getPool().query("INSERT INTO ops.metrics_snapshots (payload) VALUES ($1::jsonb)", [JSON.stringify(payload)]);
  await pruneOpsRows();
  return payload;
}

export function startMetrics(): void {
  const interval = Number(process.env.METRICS_INTERVAL_SEC ?? "15") * 1000;
  const tick = () => {
    scrapeOnce().catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", msg: "metrics scrape failed", error: String(error) }));
    });
  };
  tick();
  setInterval(tick, interval);
}
