import { getPool } from "@merces/shared";
import { startServer } from "./api.js";
import { recordLine, startLogWriter } from "./logs.js";
import { PROC_NAMES, ProcessManager, healthPort, reclaimIndexerPorts } from "./proc.js";
import { startSanitySchedule } from "./sanity.js";
import { ensureReadModel } from "./schemas.js";
import { startMetrics } from "./scrape.js";

const ready = await getPool().query<{ ops: string | null; tables: string | null; kind: string | null }>(`
  SELECT to_regclass('ops.worker_control')::text AS ops,
         to_regclass('erc8004.cursors')::text AS tables,
         (SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'erc8004' AND c.relname = 'agents') AS kind
`);
const state = ready.rows[0];
if (!state?.ops) {
  console.error("ops schema is missing. Run pnpm db:init");
  process.exit(1);
}
if (state.kind === "v") {
  console.error("erc8004.agents is still the old Ponder view. Run pnpm migrate:ponder once, then start again.");
  process.exit(1);
}
if (!state.tables) {
  console.error("erc8004 tables are missing. Run pnpm db:init");
  process.exit(1);
}

try {
  const { rebuilt } = await ensureReadModel();
  if (rebuilt) recordLine("ops", "info", "rebuilt the read views");
} catch (error) {
  // Usually a lock timeout while the app holds a view open. The metrics tick retries.
  recordLine("ops", "error", `read views not rebuilt yet: ${error instanceof Error ? error.message : String(error)}`);
}

const manager = new ProcessManager();
// Bind the dashboard first: if another supervisor holds the port, stop here instead of taking over its children.
try {
  await startServer(manager);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
await reclaimIndexerPorts(PROC_NAMES.map(healthPort));
startLogWriter();
startMetrics();
startSanitySchedule();
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
