import { useEffect, useState } from "react";
import { api, formatWhen } from "../api";

type SanityRow = {
  check: string;
  chain: string;
  subject: string;
  status: "pass" | "warn" | "fail";
  fields: Record<string, { left: string; right: string }>;
  detail: string;
};

type Report = { ts: string; summary: { pass: number; warn: number; fail: number }; rows: SanityRow[] };

export function SanityPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [history, setHistory] = useState<{ id: number; ts: string; pass: number; warn: number; fail: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [latest, past] = await Promise.all([
      api<Report | null>("/api/sanity/latest"),
      api<typeof history>("/api/sanity/history"),
    ]);
    if (latest && "result" in (latest as object)) {
      setReport((latest as unknown as { result: Report }).result);
    } else {
      setReport(latest);
    }
    setHistory(past);
  }

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    const id = setInterval(() => {
      load().catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setReport(await api<Report>("/api/sanity", { method: "POST" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const groups = new Map<string, SanityRow[]>();
  for (const row of report?.rows ?? []) {
    const list = groups.get(row.check) ?? [];
    list.push(row);
    groups.set(row.check, list);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Sanity</h1>
        <button className="btn" type="button" disabled={busy} onClick={() => void run()}>{busy ? "Running" : "Run now"}</button>
      </div>
      {error && <p className="fail">{error}</p>}
      {report && (
        <p>
          {formatWhen(report.ts)} · <span className="pass">{report.summary.pass} pass</span> · <span className="warn">{report.summary.warn} warn</span> · <span className="fail">{report.summary.fail} fail</span>
        </p>
      )}
      {[...groups.entries()].map(([check, rows]) => (
        <section className="card overflow-auto" key={check}>
          <h2 className="mb-2 font-medium">{check}</h2>
          <table>
            <thead><tr><th>Status</th><th>Subject</th><th>Compared</th><th>Detail</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.check}:${row.subject}:${row.detail}`}>
                  <td className={row.status}>{row.status}</td>
                  <td className="mono">{row.subject}</td>
                  <td className="mono">
                    {Object.entries(row.fields).map(([name, field]) => (
                      <div key={name}>{name}: {field.left} ↔ {field.right}</div>
                    ))}
                  </td>
                  <td>{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <section className="card">
        <h2 className="mb-2 font-medium">History</h2>
        <ul className="text-sm">
          {history.map((item) => (
            <li key={item.id}>{formatWhen(item.ts)} · {item.pass} pass · {item.warn} warn · {item.fail} fail</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
