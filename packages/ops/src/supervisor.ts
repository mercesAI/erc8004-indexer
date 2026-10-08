import { enabledChains, getPool } from "@merces/shared";
import { startServer } from "./api.js";
import { startLogWriter } from "./logs.js";
import { ProcessManager, reclaimIndexerPorts } from "./proc.js";
import { startSanitySchedule } from "./sanity.js";
import { ponderPort } from "./schemas.js";
import { startMetrics } from "./scrape.js";

const ready = await getPool().query<{ name: string | null }>("SELECT to_regclass('ops.worker_control') AS name");
if (!ready.rows[0]?.name) {
  console.error("ops schema is missing. Run pnpm db:init");
  process.exit(1);
}

const manager = new ProcessManager();
await reclaimIndexerPorts([42071, 42072, ...enabledChains().map((_, index) => ponderPort(index))]);
startLogWriter();
startMetrics();
startSanitySchedule();
startServer(manager);
manager.startAll();

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await manager.stopAll();
  process.exit(code);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGHUP", () => {
  void shutdown();
});
process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ level: "error", msg: "unhandled rejection", error: String(reason) }));
});
process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({ level: "error", msg: "uncaught exception", error: error.message }));
  void shutdown(1);
});
