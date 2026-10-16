import { useEffect, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, formatNum, formatWhen } from "../api";
import { LongText } from "../LongText";

type Workers = {
  control: { worker: string; paused: boolean; updated_at: string }[];
  cursors: { chain: string; entity: string; cursor: string; mode: string; watermark: string | null; updated_at: string }[];
  enrich: {
    byStatus: { status: string; n: string }[];
    pendingRetry: number;
    success: { hour: string; ok: number; error: number }[];
  };
  health: {
    indexer?: { paused?: boolean; chains?: Record<string, IndexerChain> };
    importer?: { lastPass?: Record<string, unknown> };
    enrich?: { queueDepth?: number };
  } | null;
  chains: string[];
  importerEnabled: boolean;
};

type IndexerChain = {
  lastBlock: number | null;
  headBlock: number | null;
  confirmations: number;
  intervalSec: number;
  catchingUp: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  events: number;
  rpcRequests: number;
  rpcErrors: number;
};

function every(seconds: number): string {
  return seconds % 3600 === 0 ? `${seconds / 3600}h` : seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
}

function formatPass(pass: Record<string, unknown> | undefined): string {
  if (!pass) return "No completed pass yet.";
  const counts = pass.counts;
  const countText =
    counts && typeof counts === "object"
      ? Object.entries(counts as Record<string, number>)
          .map(([name, value]) => `${name} ${value}`)
          .join(" · ")
      : "";
  const duration = typeof pass.durationMs === "number" ? `${Math.round(pass.durationMs / 1000)}s` : "";
  const at = formatWhen(typeof pass.at === "string" || typeof pass.at === "number" ? pass.at : null);
  return `Last pass ${at} · ${duration}${countText ? ` · ${countText}` : ""}`;
}

export function WorkersPage() {
  const [data, setData] = useState<Workers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chain, setChain] = useState("base");
  const [entity, setEntity] = useState("agents");

  async function load() {
    try {
      const body = await api<Workers>("/api/workers");
      setData(body);
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

  async function toggle(worker: string, paused: boolean) {
    await api(`/api/workers/${worker}/${paused ? "resume" : "pause"}`, { method: "POST" });
    await load();
  }

  async function resetCursor() {
    await api("/api/importer/cursor/reset", {
      method: "POST",
      body: JSON.stringify({ chain, entity }),
    });
    await load();
  }

  const indexer = data?.control.find((row) => row.worker === "indexer");
  const indexerChains = Object.entries(data?.health?.indexer?.chains ?? {});
  const importer = data?.control.find((row) => row.worker === "importer");
  const enrich = data?.control.find((row) => row.worker === "enrich");
  const enrichHealth = data?.health?.enrich;
  const importerHealth = data?.health?.importer;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Workers</h1>
      {error && <p className="fail">{error}</p>}
      <section className="card">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Indexer</h2>
          <button className="btn" type="button" onClick={() => indexer && void toggle("indexer", indexer.paused)}>
            {indexer?.paused ? "Resume" : "Pause"}
          </button>
        </div>
        <p className="muted text-sm">
          One eth_blockNumber and one eth_getLogs per 2,000 blocks per cycle. Behind is head minus the last applied block;
          it includes the confirmation window, so it is never zero.
        </p>
        <div className="overflow-x-auto">
          <table className="mt-3">
            <thead>
              <tr><th>Chain</th><th>Every</th><th>Applied block</th><th>Head</th><th>Behind</th><th>Last run</th><th>Events</th><th>Requests</th><th>Last error</th></tr>
            </thead>
            <tbody>
              {indexerChains.map(([key, item]) => (
                <tr key={key}>
                  <td>{key}{item.catchingUp && <span className="warn"> · catching up</span>}</td>
                  <td>{every(item.intervalSec)}</td>
                  <td className="mono">{formatNum(item.lastBlock)}</td>
                  <td className="mono">{formatNum(item.headBlock)}</td>
                  <td className="mono">{item.lastBlock != null && item.headBlock != null ? formatNum(item.headBlock - item.lastBlock) : "—"}</td>
                  <td>{formatWhen(item.lastRunAt)}</td>
                  <td className="mono">{formatNum(item.events)}</td>
                  <td className="mono">{formatNum(item.rpcRequests)}{item.rpcErrors > 0 && <span className="fail"> · {item.rpcErrors} err</span>}</td>
                  <td className="fail">{item.lastError ? <LongText text={item.lastError} max={60} /> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {indexerChains.length === 0 && <p className="muted text-sm">Waiting for the indexer's first health report.</p>}
        <p className="muted mt-2 text-xs">Counters restart from zero when the indexer restarts.</p>
      </section>
      {data && !data.importerEnabled ? (
        <section className="card">
          <h2 className="font-medium">Importer</h2>
          <p className="muted text-sm">Off. Set SUBGRAPH_MIRROR_CHAINS and restart to mirror the Agent0 subgraph into schema mirror.</p>
        </section>
      ) : (
      <section className="card">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-medium">Importer</h2>
            <button className="btn" type="button" onClick={() => importer && void toggle("importer", importer.paused)}>
              {importer?.paused ? "Resume" : "Pause"}
            </button>
          </div>
          <p className="text-sm">{formatPass(importerHealth?.lastPass)}</p>
          <table className="mt-3">
            <thead>
              <tr><th>Chain</th><th>Entity</th><th>Mode</th><th>Cursor</th><th>Watermark</th></tr>
            </thead>
            <tbody>
              {data?.cursors.map((cursor) => (
                <tr key={`${cursor.chain}:${cursor.entity}`}>
                  <td>{cursor.chain}</td>
                  <td>{cursor.entity}</td>
                  <td>{cursor.mode}</td>
                  <td className="mono">{cursor.cursor.slice(0, 24)}</td>
                  <td className="mono">{cursor.watermark}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex gap-2">
            <label>
              Chain
              <select className="btn ml-2" value={chain} onChange={(event) => setChain(event.target.value)}>
                {(data?.chains ?? ["base"]).map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label>
              Entity
              <select className="btn ml-2" value={entity} onChange={(event) => setEntity(event.target.value)}>
                {["agents", "registration_files", "feedback", "validations"].map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <button className="btn" type="button" onClick={() => void resetCursor()}>Reset cursor</button>
          </div>
        </section>
      )}
      <section className="card">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Enrich</h2>
          <button className="btn" type="button" onClick={() => enrich && void toggle("enrich", enrich.paused)}>
            {enrich?.paused ? "Resume" : "Pause"}
          </button>
        </div>
        <p className="text-sm">
          Queue {enrichHealth?.queueDepth ?? "—"} · pending retry {data?.enrich.pendingRetry ?? 0}
          {data?.enrich.byStatus.map((row) => ` · ${row.status} ${row.n}`).join("")}
        </p>
        <div className="mt-3 h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={(data?.enrich.success ?? []).map((row) => ({ ...row, when: formatWhen(row.hour) }))}>
              <XAxis dataKey="when" hide />
              <YAxis stroke="var(--muted)" />
              <Tooltip />
              <Bar dataKey="ok" fill="var(--pass)" />
              <Bar dataKey="error" fill="var(--fail)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
