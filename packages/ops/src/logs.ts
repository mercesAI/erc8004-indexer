import { getPool, redactSecrets } from "@merces/shared";

export type LogRow = {
  id: number;
  ts: string;
  process: string;
  level: string;
  line: string;
};

const ring: LogRow[] = [];
let nextId = 1;
const pending: LogRow[] = [];

export function recordLine(processName: string, fallbackLevel: string, line: string): void {
  const row: LogRow = {
    id: nextId++,
    ts: new Date().toISOString(),
    process: processName,
    level: levelOf(line, fallbackLevel),
    line: redactSecrets(line).slice(0, 8000),
  };
  ring.push(row);
  if (ring.length > 5000) ring.shift();
  pending.push(row);
}

function levelOf(line: string, fallback: string): string {
  try {
    const parsed = JSON.parse(line) as { level?: string | number };
    if (typeof parsed.level === "string") return parsed.level;
    if (typeof parsed.level === "number") {
      if (parsed.level >= 50) return "error";
      if (parsed.level >= 40) return "warn";
      if (parsed.level >= 30) return "info";
      return "debug";
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function tailLogs(filter: { process?: string; level?: string; q?: string; after?: number }): LogRow[] {
  return ring.filter((row) => {
    if (filter.after && row.id <= filter.after) return false;
    if (filter.process && filter.process !== "all" && row.process !== filter.process) return false;
    if (filter.level && filter.level !== "all" && row.level !== filter.level) return false;
    if (filter.q && !row.line.toLowerCase().includes(filter.q.toLowerCase())) return false;
    return true;
  }).slice(-400);
}

export function startLogWriter(): void {
  setInterval(() => {
    void flushLogs();
  }, 1000);
}

async function flushLogs(): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending.splice(0, 400);
  const values: string[] = [];
  const params: unknown[] = [];
  batch.forEach((row, index) => {
    const offset = index * 4;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
    params.push(row.ts, row.process, row.level, row.line);
  });
  try {
    await getPool().query(
      `INSERT INTO ops.logs (ts, process, level, line) VALUES ${values.join(",")}`,
      params,
    );
  } catch (error) {
    pending.unshift(...batch);
    if (pending.length > 5000) pending.splice(0, pending.length - 5000);
    console.error(JSON.stringify({ level: "error", msg: "log insert failed", error: String(error) }));
  }
}

export async function pruneOpsRows(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM ops.logs WHERE id IN (
      SELECT id FROM ops.logs WHERE ts < now() - interval '7 days' LIMIT 5000
    )`,
  );
  await pool.query("DELETE FROM ops.metrics_snapshots WHERE ts < now() - interval '7 days'");
}
