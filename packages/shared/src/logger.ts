export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    process: process.env.PROCESS_NAME ?? "shared",
    msg,
    ...fields,
  });
  process.stdout.write(`${line}\n`);
}
