import { useEffect, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, formatNum, formatWhen } from "../api";

type ChainOption = { key: string; chainId: number; label: string };

type DataResponse = {
  counts: { table: string; chainId: number; chainLabel: string; rows: number }[];
  chains: ChainOption[];
  growth: { ts: string; counts: { agents: number; feedback: number; validations: number; registrationFiles: number } }[];
  topOwners: { owner: string; agents: number }[];
  ownersChain: string;
  activity: { agents_24h: number; agents_7d: number; feedback_24h: number; feedback_7d: number };
  recent: { chain_id: number; chainLabel: string; event_name: string; block_number: string; block_time: string; tx_hash: string }[];
  coverage: { agents: number; with_registration: number; with_feedback: number };
};

export function DataPage() {
  const [data, setData] = useState<DataResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownersChain, setOwnersChain] = useState("all");

  useEffect(() => {
    const load = () => {
      api<DataResponse>(`/api/data?owners=${encodeURIComponent(ownersChain)}`)
        .then((body) => { setData(body); setError(null); })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [ownersChain]);

  const coverage = data?.coverage;
  const agents = coverage?.agents || 0;
  const activity = data?.activity;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Data</h1>
      {error && <p className="fail">{error}</p>}
      <section className="grid gap-3 md:grid-cols-4">
        <article className="card">
          <h2 className="muted text-sm">New agents, 24h</h2>
          <p className="mt-1 text-2xl">{formatNum(activity?.agents_24h)}</p>
        </article>
        <article className="card">
          <h2 className="muted text-sm">New agents, 7 days</h2>
          <p className="mt-1 text-2xl">{formatNum(activity?.agents_7d)}</p>
        </article>
        <article className="card">
          <h2 className="muted text-sm">Feedback, 24h</h2>
          <p className="mt-1 text-2xl">{formatNum(activity?.feedback_24h)}</p>
        </article>
        <article className="card">
          <h2 className="muted text-sm">Feedback, 7 days</h2>
          <p className="mt-1 text-2xl">{formatNum(activity?.feedback_7d)}</p>
        </article>
      </section>
      <section className="card overflow-auto">
        <table>
          <thead><tr><th>Table</th><th>Chain</th><th>Rows</th></tr></thead>
          <tbody>
            {data?.counts.map((row) => (
              <tr key={`${row.table}:${row.chainId}`}>
                <td>{row.table}</td><td>{row.chainLabel}</td><td>{formatNum(row.rows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2 className="mb-2 font-medium">Growth, last 24 hours</h2>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={(data?.growth ?? []).map((row) => ({ ...row.counts, ts: formatWhen(row.ts) }))}>
              <XAxis dataKey="ts" hide />
              <YAxis stroke="var(--muted)" />
              <Tooltip />
              <Line dataKey="agents" stroke="var(--accent)" dot={false} />
              <Line dataKey="feedback" stroke="var(--pass)" dot={false} />
              <Line dataKey="validations" stroke="var(--warn)" dot={false} />
              <Line dataKey="registrationFiles" stroke="var(--muted)" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
      <section className="card">
        <p>
          Resolvable registration files {agents ? formatNum((100 * (coverage?.with_registration ?? 0)) / agents, 1) : "0"}%
          · at least one feedback {agents ? formatNum((100 * (coverage?.with_feedback ?? 0)) / agents, 1) : "0"}%
        </p>
      </section>
      <section className="card">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="font-medium">Top owners</h2>
          <label>
            Chain
            <select className="btn ml-2" value={ownersChain} onChange={(event) => setOwnersChain(event.target.value)}>
              <option value="all">All chains</option>
              {(data?.chains ?? []).map((chain) => (
                <option key={chain.key || chain.chainId} value={chain.key || chain.chainId}>{chain.label}</option>
              ))}
            </select>
          </label>
        </div>
        <table>
          <thead><tr><th>Owner</th><th>Agents</th></tr></thead>
          <tbody>
            {data?.topOwners.map((row) => (
              <tr key={row.owner}><td className="mono">{row.owner}</td><td>{row.agents}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card overflow-auto">
        <h2 className="mb-2 font-medium">Latest events</h2>
        <table>
          <thead><tr><th>When</th><th>Chain</th><th>Event</th><th>Block</th><th>Transaction</th></tr></thead>
          <tbody>
            {data?.recent.map((row) => (
              <tr key={`${row.tx_hash}:${row.event_name}:${row.block_number}`}>
                <td>{formatWhen(row.block_time)}</td>
                <td>{row.chainLabel}</td>
                <td>{row.event_name}</td>
                <td className="mono">{row.block_number}</td>
                <td className="mono">{row.tx_hash.slice(0, 14)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

