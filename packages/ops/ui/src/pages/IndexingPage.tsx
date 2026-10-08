import { useEffect, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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
  const [rps, setRps] = useState(20);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      api<{ points: Point[]; alchemyMaxRps: number }>("/api/indexing?hours=6")
        .then((body) => {
          setPoints(body.points);
          setRps(body.alchemyMaxRps);
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
      row[`${chain.chain}:lag`] = chain.lag;
      row[`${chain.chain}:events`] = Number(chain.eventsPerSec.toFixed(2));
      row[`${chain.chain}:rpc`] = Number(chain.rpcPerSec.toFixed(2));
      row[`${chain.chain}:errors`] = chain.errorCount;
    }
    return row;
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Indexing</h1>
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
                <ReferenceLine y={rps} stroke="var(--warn)" strokeDasharray="4 4" label="Alchemy cap" />
                <Line dataKey={`${chain}:lag`} name="lag" stroke="var(--fail)" dot={false} />
                <Line dataKey={`${chain}:events`} name="events/s" stroke="var(--pass)" dot={false} />
                <Line dataKey={`${chain}:rpc`} name="rpc/s" stroke="var(--accent)" dot={false} />
                <Line dataKey={`${chain}:errors`} name="errors" stroke="var(--muted)" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      ))}
      {chains.length === 0 && <p className="muted">Waiting for the first metrics snapshot.</p>}
    </div>
  );
}
