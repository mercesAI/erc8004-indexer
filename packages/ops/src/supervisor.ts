import { getPool } from "@merces/shared";
import { startServer } from "./api.js";
import { startLogWriter } from "./logs.js";
import { ProcessManager } from "./proc.js";
import { startSanitySchedule } from "./sanity.js";
import { startMetrics } from "./scrape.js";

const ready = await getPool().query<{ name: string | null }>("SELECT to_regclass('ops.worker_control') AS name");
if (!ready.rows[0]?.name) {
  console.error("ops schema is missing. Run pnpm db:init");
  process.exit(1);
}

const manager = new ProcessManager();
startLogWriter();
startMetrics();
startSanitySchedule();
startServer(manager);
manager.startAll();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await manager.stopAll();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
