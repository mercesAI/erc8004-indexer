export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(await response.text());
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function formatUptime(seconds: number | null): string {
  if (seconds == null) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

export function formatNum(value: number | null | undefined, digits = 0): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function formatWhen(value: string | number | Date | null | undefined, now = Date.now()): string {
  const date = asDate(value);
  if (!date) return "—";
  const delta = now - date.getTime();
  if (Math.abs(delta) < 45_000) return "now";
  if (delta >= 0 && delta < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.round(delta / 60_000));
    return minutes === 1 ? "1 min ago" : `${minutes} min ago`;
  }
  const clock = formatClock(date);
  const current = new Date(now);
  if (sameDay(date, current)) return `today at ${clock}`;
  const yesterday = new Date(current);
  yesterday.setDate(current.getDate() - 1);
  if (sameDay(date, yesterday)) return `yesterday at ${clock}`;
  const month = date.toLocaleString(undefined, { month: "short" });
  if (date.getFullYear() === current.getFullYear()) return `${month} ${date.getDate()} at ${clock}`;
  return `${month} ${date.getDate()}, ${date.getFullYear()} at ${clock}`;
}

function asDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return fromEpoch(value);
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return fromEpoch(Number(trimmed));
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function fromEpoch(value: number): Date | null {
  if (!Number.isFinite(value)) return null;
  const millis = value < 1e12 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function formatClock(date: Date): string {
  const suffix = date.getHours() >= 12 ? "pm" : "am";
  const hour = date.getHours() % 12 || 12;
  const minute = date.getMinutes().toString().padStart(2, "0");
  return `${hour}:${minute}${suffix}`;
}
