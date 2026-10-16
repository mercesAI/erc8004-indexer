import { useEffect, useState } from "react";
import { api } from "../api";

export function SettingsPage() {
  const [entries, setEntries] = useState<{ key: string; value: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ entries: { key: string; value: string }[] }>("/api/settings")
      .then((body) => setEntries(body.entries))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="muted text-sm">Effective config. Secrets are masked. This view does not edit anything.</p>
      {error && <p className="fail">{error}</p>}
      <section className="card overflow-auto">
        <table>
          <thead><tr><th>Key</th><th>Value</th></tr></thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.key}><td>{entry.key}</td><td className="mono wrap">{entry.value || "—"}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
