import { useEffect, useState } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { api, formatNum, formatUptime, formatWhen } from "../api";
import { LongText } from "../LongText";

type Process = {
  name: string;
  status: string;
  uptimeSec: number | null;
  lastError: string | null;
};

type Chain = {
  chain: string;
  lag: number | null;
  progressPct: number | null;
  eventsPerSec: number;
  indexedBlock: number | null;
  headBlock: number | null;
  status: string;
  lastRunAt?: string | null;
  lastError?: string | null;
};

type Overview = {
  processes: Process[];
  metrics: { chains?: Chain[]; counts?: Record<string, number> } | null;
};

type Series = { ts: string; chains: { chain: string; eventsPerSec: number }[] };

export function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [series, setSeries] = useState<Series[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const [overview, indexing] = await Promise.all([
        api<Overview>("/api/overview"),
        api<{ points: Series[] }>("/api/indexing?hours=1"),
      ]);
      setData(overview);
      setSeries(indexing.points);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, []);

  async function control(name: string, action: string) {
    setBusy(`${name}:${action}`);
    try {
      await api(`/api/processes/${name}/${action}`, { method: "POST" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const counts = data?.metrics?.counts;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Overview</h1>
      <p className="muted text-sm">
        The indexer polls each chain's registry logs on a schedule (every 5 minutes by default) and writes the tables in erc8004.
        It stays a few blocks behind the head, so the progress line is never exactly 100% live.
        Enrich downloads registration files into enrich. The importer copies the Agent0 subgraph into mirror and only runs when SUBGRAPH_MIRROR_CHAINS is set.
      </p>
      <p className="muted text-sm">
        Stop halts that process. Start brings it back from its checkpoint. Restart is stop, then start.
        Start is disabled while the process is already running.
      </p>
      {error && <p className="fail">{error}</p>}
      <div className="grid gap-3 md:grid-cols-3">
        {data?.processes.map((process) => (
          <section className="card" key={process.name}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-medium capitalize">{process.name}</h2>
              <span className={`pill ${process.status === "running" ? "pass" : process.status === "failed" ? "fail" : "warn"}`}>
                {process.status}
              </span>
            </div>
            <p className="muted text-sm">
              {process.name === "indexer" && "Registry logs via Alchemy, one eth_getLogs per 2,000 blocks. Primary data: agents, feedback, validations."}
              {process.name === "importer" && "Agent0 subgraph copy. Off unless SUBGRAPH_MIRROR_CHAINS is set. Not a source of truth."}
              {process.name === "enrich" && "Off-chain registration files (HTTPS, IPFS, data URIs). Kept across re-indexes."}
            </p>
            <p className="mt-2 text-sm">Uptime {formatUptime(process.uptimeSec)}</p>
            <p className="muted mt-1 min-h-10 text-sm">{process.lastError ? <LongText text={process.lastError} max={100} /> : "No error"}</p>
            <div className="mt-3 flex gap-2">
              <button className="btn" type="button" disabled={busy !== null || process.status === "running" || process.status === "starting"} onClick={() => void control(process.name, "start")}>Start</button>
              <button className="btn" type="button" disabled={busy !== null || process.status === "stopped"} onClick={() => void control(process.name, "stop")}>Stop</button>
              <button className="btn" type="button" disabled={busy !== null} onClick={() => void control(process.name, "restart")}>Restart</button>
            </div>
          </section>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {data?.metrics?.chains?.map((chain) => (
          <section className="card" key={chain.chain}>
            <div className="mb-2 flex justify-between">
              <h2 className="font-medium">{chain.chain}</h2>
              <span className={`text-sm ${chain.lastError ? "fail" : chain.status === "backfill" ? "warn" : "muted"}`}>
                {chain.lastError ? "last run failed" : chain.status === "backfill" ? "catching up" : `ran ${formatWhen(chain.lastRunAt ?? null)}`}
              </span>
            </div>
            <div className="bar" aria-valuenow={chain.progressPct ?? 0} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${Math.max(0, Math.min(100, chain.progressPct ?? 0))}%` }} />
            </div>
            <p className="muted mt-2 text-sm">
              {formatNum(chain.progressPct, 1)}% · {formatNum(chain.lag)} blocks behind · indexed {formatNum(chain.indexedBlock)} / head {formatNum(chain.headBlock)}
            </p>
            <div className="mt-2 h-12">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series.map((point) => ({ v: point.chains.find((item) => item.chain === chain.chain)?.eventsPerSec ?? 0 }))}>
                  <Line type="monotone" dataKey="v" stroke="var(--accent)" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
        ))}
      </div>
      <p className="text-sm">
        From the indexer: agents {formatNum(counts?.agents)} · feedback {formatNum(counts?.feedback)} · validations {formatNum(counts?.validations)}. From enrich: registration files {formatNum(counts?.registrationFiles)}.
      </p>
    </div>
  );
}
