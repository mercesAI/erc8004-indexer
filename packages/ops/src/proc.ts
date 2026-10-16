import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { envList, findRepoRoot } from "@merces/shared";
import { recordLine } from "./logs.js";

export type ProcName = "indexer" | "importer" | "enrich";

export const PROC_NAMES: ProcName[] = ["indexer", "importer", "enrich"];

const PROC_SPEC: Record<ProcName, { dir: string; healthPort: number }> = {
  indexer: { dir: "indexer-erc8004", healthPort: 42073 },
  importer: { dir: "importer-subgraph", healthPort: 42071 },
  enrich: { dir: "enrich-erc8004", healthPort: 42072 },
};

export function healthPort(name: ProcName): number {
  return PROC_SPEC[name].healthPort;
}

export type ProcView = {
  name: ProcName;
  status: "running" | "stopped" | "starting" | "backoff" | "failed";
  desired: "running" | "stopped";
  pid: number | null;
  startedAt: number | null;
  uptimeSec: number | null;
  restarts: number;
  lastError: string | null;
};

type Runtime = {
  name: ProcName;
  desired: "running" | "stopped";
  status: ProcView["status"];
  child: ChildProcess | null;
  startedAt: number | null;
  restarts: number[];
  lastError: string | null;
  timer: NodeJS.Timeout | null;
};

function resolveBin(root: string, name: string, pkgDir: string): string {
  const candidates = [join(pkgDir, "node_modules", ".bin", name), join(root, "node_modules", ".bin", name)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot find the ${name} binary. Run pnpm install.`);
}

const execFileAsync = promisify(execFile);

function retryDelay(failures: number): number {
  return Math.min(5 * 60_000, 1000 * 2 ** Math.min(Math.max(failures, 1) - 1, 8));
}

function noteRestart(restarts: number[], startedAt: number | null): number[] {
  const now = Date.now();
  const stable = startedAt != null && now - startedAt >= 10 * 60 * 1000;
  const kept = stable ? [] : restarts.filter((stamp) => now - stamp < 10 * 60 * 1000);
  kept.push(now);
  return kept;
}

// The children run as `tsx src/index.ts` with the package directory as cwd, so the command line alone
// does not name the package. The supervisor passes the package name as an extra argument for this check.
const OWNED_PROCESS = ["indexer-erc8004", "importer-subgraph", "enrich-erc8004"];

export async function reclaimIndexerPorts(ports: number[]): Promise<void> {
  for (const port of ports) {
    let pid = 0;
    try {
      const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
      pid = Number(stdout.trim().split("\n")[0]);
    } catch {
      continue;
    }
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
    let command = "";
    try {
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
      command = stdout;
    } catch {
      continue;
    }
    if (!OWNED_PROCESS.some((part) => command.includes(part))) {
      recordLine("ops", "error", `port ${port} is used by another process; leaving it`);
      continue;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The leftover process is already gone.
      }
    }
    recordLine("ops", "info", `stopped leftover indexer ${pid} on port ${port}`);
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process is already gone.
    }
  }
}

export class ProcessManager {
  private readonly root = findRepoRoot();
  private readonly runtimes: Record<ProcName, Runtime> = {
    indexer: this.blank("indexer"),
    importer: this.blank("importer"),
    enrich: this.blank("enrich"),
  };

  /** The importer only runs when SUBGRAPH_MIRROR_CHAINS names a chain; it can still be started from the dashboard. */
  startAll(): void {
    this.start("indexer");
    this.start("enrich");
    if (envList("SUBGRAPH_MIRROR_CHAINS").length > 0) this.start("importer");
  }

  async stopAll(): Promise<void> {
    await Promise.all(PROC_NAMES.map((name) => this.stop(name)));
  }

  snapshot(): ProcView[] {
    return PROC_NAMES.map((name) => {
      const runtime = this.runtimes[name];
      return {
        name: runtime.name,
        status: runtime.status,
        desired: runtime.desired,
        pid: runtime.child?.pid ?? null,
        startedAt: runtime.startedAt,
        uptimeSec: runtime.startedAt ? Math.floor((Date.now() - runtime.startedAt) / 1000) : null,
        restarts: runtime.restarts.length,
        lastError: runtime.lastError,
      };
    });
  }

  start(name: ProcName): void {
    const runtime = this.runtimes[name];
    runtime.desired = "running";
    runtime.restarts = [];
    runtime.lastError = null;
    if (runtime.timer) clearTimeout(runtime.timer);
    if (runtime.child) return;
    runtime.status = "starting";
    this.spawn(runtime);
  }

  async stop(name: ProcName): Promise<void> {
    const runtime = this.runtimes[name];
    runtime.desired = "stopped";
    if (runtime.timer) clearTimeout(runtime.timer);
    const child = runtime.child;
    if (!child?.pid) {
      runtime.status = "stopped";
      return;
    }
    killGroup(child.pid, "SIGTERM");
    const exited = await this.waitExit(runtime, child, 4000);
    if (!exited && runtime.child?.pid) killGroup(runtime.child.pid, "SIGKILL");
    await this.waitExit(runtime, child, 1000);
    runtime.status = "stopped";
    runtime.startedAt = null;
  }

  async restart(name: ProcName): Promise<void> {
    await this.stop(name);
    this.start(name);
  }

  private blank(name: ProcName): Runtime {
    return {
      name,
      desired: "stopped",
      status: "stopped",
      child: null,
      startedAt: null,
      restarts: [],
      lastError: null,
      timer: null,
    };
  }

  private command(name: ProcName): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
    const spec = PROC_SPEC[name];
    const cwd = join(this.root, "packages", spec.dir);
    return {
      command: resolveBin(this.root, "tsx", cwd),
      args: ["src/index.ts", `--process=${spec.dir}`],
      cwd,
      env: { ...process.env, PROCESS_NAME: name, HEALTH_PORT: String(spec.healthPort) },
    };
  }

  private spawn(runtime: Runtime): void {
    let spec: ReturnType<ProcessManager["command"]>;
    try {
      spec = this.command(runtime.name);
    } catch (error) {
      runtime.status = "failed";
      runtime.lastError = error instanceof Error ? error.message : String(error);
      return;
    }
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runtime.child = child;
    runtime.startedAt = Date.now();
    runtime.status = "running";
    const consume = (fallback: string) => (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) recordLine(runtime.name, fallback, line);
      }
    };
    child.stdout?.on("data", consume("info"));
    child.stderr?.on("data", consume("error"));
    child.on("error", (error) => {
      runtime.lastError = error.message;
      recordLine(runtime.name, "error", error.message);
    });
    child.on("exit", (code, signal) => {
      if (runtime.child !== child) return;
      const startedAt = runtime.startedAt;
      runtime.child = null;
      runtime.startedAt = null;
      if (runtime.desired === "stopped") {
        runtime.status = "stopped";
        return;
      }
      runtime.restarts = noteRestart(runtime.restarts, startedAt);
      runtime.lastError = `exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      const delay = retryDelay(runtime.restarts.length);
      runtime.status = "backoff";
      if (runtime.restarts.length > 5) {
        recordLine(runtime.name, "error", `${runtime.name} still failing; retrying in ${Math.round(delay / 1000)}s`);
      }
      runtime.timer = setTimeout(() => {
        if (runtime.desired === "running" && !runtime.child) this.spawn(runtime);
      }, delay);
    });
  }

  private waitExit(runtime: Runtime, child: ChildProcess, ms: number): Promise<boolean> {
    if (runtime.child !== child) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(runtime.child !== child), ms);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
