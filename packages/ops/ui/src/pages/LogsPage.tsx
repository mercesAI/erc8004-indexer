import { useEffect, useRef, useState } from "react";
import { api, formatWhen } from "../api";

type LogRow = { id: number; ts: string; process: string; level: string; line: string };

export function LogsPage() {
  const [processName, setProcessName] = useState("all");
  const [level, setLevel] = useState("all");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<LogRow[]>([]);
  const [follow, setFollow] = useState(true);
  const end = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const load = () => {
      const params = new URLSearchParams({ process: processName, level, q });
      api<LogRow[]>(`/api/logs?${params.toString()}`).then(setRows).catch(() => undefined);
    };
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [processName, level, q]);

  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: "end" });
  }, [rows, follow]);

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold">Logs</h1>
      <div className="flex flex-wrap gap-2">
        <select className="btn" aria-label="Process" value={processName} onChange={(event) => setProcessName(event.target.value)}>
          {["all", "ponder", "importer", "enrich"].map((item) => <option key={item}>{item}</option>)}
        </select>
        <select className="btn" aria-label="Level" value={level} onChange={(event) => setLevel(event.target.value)}>
          {["all", "error", "warn", "info", "debug"].map((item) => <option key={item}>{item}</option>)}
        </select>
        <input className="btn min-w-64" aria-label="Filter log text" value={q} onChange={(event) => setQ(event.target.value)} placeholder="filter" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          Follow
        </label>
      </div>
      <pre className="card mono max-h-[70vh] overflow-auto whitespace-pre-wrap">
        {rows.map((row) => (
          <div key={row.id} className={row.level === "error" ? "fail" : row.level === "warn" ? "warn" : ""}>
            {formatWhen(row.ts)} {row.process} {row.level} {row.line}
          </div>
        ))}
        <div ref={end} />
      </pre>
    </div>
  );
}
