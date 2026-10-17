import { useEffect, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, formatWhen } from "../api";

type Point = {
  ts: string;
  chains: {
    chain: string;
    lag: number | null;
    eventsPerSec: number;
    rpcPerSec: number;
    errorCount: number;
  }[];
};

export function IndexingPage() {
  const [points, setPoints] = useState<Point[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      api<{ points: Point[]; alchemyMaxRps: number }>("/api/indexing?hours=6")
        .then((body) => {
          setPoints(body.points);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const chains = [...new Set(points.flatMap((point) => point.chains.map((chain) => chain.chain)))];
  const rows = points.map((point) => {
    const row: Record<string, string | number | null> = { ts: formatWhen(point.ts) };
    for (const chain of point.chains) {
      // The indexer works in bursts once per interval, so per-minute rates read better than per-second.
      row[`${chain.chain}:behind`] = chain.lag;
      row[`${chain.chain}:events`] = Math.round(chain.eventsPerSec * 60);
      row[`${chain.chain}:rpc`] = Math.round(chain.rpcPerSec * 60);
      row[`${chain.chain}:errors`] = chain.errorCount;
    }
    return row;
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Indexing</h1>
      <p className="muted text-sm">
        Per chain over the last 6 hours. "behind" is head minus the applied block and never reaches zero: the indexer stays a
        confirmation window behind and moves once per interval. Events and requests are per minute, from the indexer's counters.
      </p>
      {error && <p className="fail">{error}</p>}
      {chains.map((chain) => (
        <section className="card" key={chain}>
          <h2 className="mb-2 font-medium">{chain}</h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows}>
                <CartesianGrid stroke="var(--line)" />
                <XAxis dataKey="ts" hide />
                <YAxis stroke="var(--muted)" />
                <Tooltip />
                <Legend />
                <Line dataKey={`${chain}:behind`} name="blocks behind" stroke="var(--fail)" dot={false} />
                <Line dataKey={`${chain}:events`} name="events/min" stroke="var(--pass)" dot={false} />
                <Line dataKey={`${chain}:rpc`} name="requests/min" stroke="var(--accent)" dot={false} />
                <Line dataKey={`${chain}:errors`} name="rpc errors" stroke="var(--muted)" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      ))}
      {chains.length === 0 && <p className="muted">Waiting for the first metrics snapshot.</p>}
    </div>
  );
}
