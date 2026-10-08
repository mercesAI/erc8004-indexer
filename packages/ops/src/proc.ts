import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { enabledChains, findRepoRoot } from "@merces/shared";
import { recordLine } from "./logs.js";
import { chainSchema, ponderPort, prepareChainIndexes } from "./schemas.js";

export type ProcName = "ponder" | "importer" | "enrich";

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

type ChainIndexer = {
  chain: string;
  port: number;
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
  private readonly runtimes: Record<ProcName, Runtime>;
  private readonly indexers = new Map<string, ChainIndexer>();
  private ponderDesired: "running" | "stopped" = "stopped";

  constructor() {
    this.runtimes = {
      ponder: this.blank("ponder"),
      importer: this.blank("importer"),
      enrich: this.blank("enrich"),
    };
  }

  startAll(): void {
    this.start("ponder");
    this.start("importer");
    this.start("enrich");
  }

  async stopAll(): Promise<void> {
    await Promise.all([this.stop("ponder"), this.stop("importer"), this.stop("enrich")]);
  }

  snapshot(): ProcView[] {
    return (Object.values(this.runtimes) as Runtime[]).map((runtime) => {
      if (runtime.name !== "ponder") {
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
      }
      const indexers = [...this.indexers.values()];
      const startedAt = indexers.reduce<number | null>((earliest, indexer) => {
        if (indexer.startedAt == null) return earliest;
        return earliest == null ? indexer.startedAt : Math.min(earliest, indexer.startedAt);
      }, null);
      const errors = indexers.map((indexer) => indexer.lastError).filter((error): error is string => Boolean(error));
      return {
        name: "ponder",
        status: this.ponderStatus(),
        desired: this.ponderDesired,
        pid: indexers.find((indexer) => indexer.child?.pid)?.child?.pid ?? null,
        startedAt,
        uptimeSec: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null,
        restarts: indexers.reduce((total, indexer) => total + indexer.restarts.length, 0),
        lastError: errors[0] ?? null,
      };
    });
  }

  start(name: ProcName): void {
    if (name === "ponder") {
      this.startPonderSoon();
      return;
    }
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
    if (name === "ponder") {
      await this.stopPonder();
      return;
    }
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

  private ponderStatus(): ProcView["status"] {
    const indexers = [...this.indexers.values()];
    if (this.ponderDesired === "stopped" && indexers.every((indexer) => indexer.child == null)) return "stopped";
    if (indexers.some((indexer) => indexer.status === "failed")) return "failed";
    if (indexers.length > 0 && indexers.every((indexer) => indexer.status === "running")) return "running";
    if (indexers.some((indexer) => indexer.status === "starting" || indexer.status === "backoff" || indexer.status === "running")) {
      return "starting";
    }
    return this.ponderDesired === "running" ? "starting" : "stopped";
  }

  private startPonderSoon(attempt = 0): void {
    void this.startPonder().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      recordLine("ponder", "error", message);
      if (this.ponderDesired !== "running" || attempt >= 4) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      setTimeout(() => {
        if (this.ponderDesired === "running") this.startPonderSoon(attempt + 1);
      }, delay);
    });
  }

  private async startPonder(): Promise<void> {
    this.ponderDesired = "running";
    const plan = await prepareChainIndexes();
    const wanted = new Set<string>(plan.chains.map((chain) => chain.key));
    const blocked = new Map(plan.blocked.map((block) => [block.chain, block.reason]));
    for (const [key, indexer] of this.indexers) {
      if (!wanted.has(key)) await this.stopIndexer(indexer);
    }
    enabledChains().forEach((chain, index) => {
      const reason = blocked.get(chain.key);
      if (reason) {
        const indexer = this.indexerFor(chain.key, index);
        indexer.status = "failed";
        indexer.lastError = reason;
        return;
      }
      if (!wanted.has(chain.key)) return;
      const indexer = this.indexerFor(chain.key, index);
      if (indexer.child) return;
      indexer.restarts = [];
      indexer.lastError = null;
      this.spawnIndexer(indexer);
    });
  }

  private indexerFor(chain: string, index: number): ChainIndexer {
    const existing = this.indexers.get(chain);
    const indexer: ChainIndexer = existing ?? {
      chain,
      port: ponderPort(index),
      status: "stopped",
      child: null,
      startedAt: null,
      restarts: [],
      lastError: null,
      timer: null,
    };
    indexer.port = ponderPort(index);
    this.indexers.set(chain, indexer);
    return indexer;
  }

  private async stopPonder(): Promise<void> {
    this.ponderDesired = "stopped";
    await Promise.all([...this.indexers.values()].map((indexer) => this.stopIndexer(indexer)));
  }

  private spawnIndexer(indexer: ChainIndexer): void {
    const cwd = join(this.root, "packages/ponder-erc8004");
    const command = resolveBin(this.root, "ponder", cwd);
    const child = spawn(
      command,
      [
        "--log-format",
        "json",
        "start",
        "--port",
        String(indexer.port),
        "--hostname",
        "127.0.0.1",
        "--schema",
        chainSchema(indexer.chain),
      ],
      {
        cwd,
        env: {
          ...process.env,
          PROCESS_NAME: "ponder",
          CHAINS: indexer.chain,
          // .env reload inside the child must not expand this process back to every chain.
          INDEX_CHAIN: indexer.chain,
          DATABASE_SCHEMA: chainSchema(indexer.chain),
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    indexer.child = child;
    indexer.startedAt = Date.now();
    indexer.status = "running";
    const consume = (fallback: string) => (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) recordLine("ponder", fallback, `[${indexer.chain}] ${line}`);
      }
    };
    child.stdout?.on("data", consume("info"));
    child.stderr?.on("data", consume("error"));
    child.on("error", (error) => {
      indexer.lastError = `${indexer.chain}: ${error.message}`;
      recordLine("ponder", "error", `[${indexer.chain}] ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (indexer.child !== child) return;
      indexer.child = null;
      indexer.startedAt = null;
      if (this.ponderDesired === "stopped") {
        indexer.status = "stopped";
        return;
      }
      const now = Date.now();
      indexer.restarts = indexer.restarts.filter((stamp) => now - stamp < 10 * 60 * 1000);
      indexer.restarts.push(now);
      indexer.lastError = `${indexer.chain} exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      if (indexer.restarts.length > 5) {
        indexer.status = "failed";
        recordLine("ponder", "error", `${indexer.chain} failed after 5 restarts in 10 minutes`);
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** (indexer.restarts.length - 1));
      indexer.status = "backoff";
      indexer.timer = setTimeout(() => {
        if (this.ponderDesired === "running" && !indexer.child) this.spawnIndexer(indexer);
      }, delay);
    });
  }

  private async stopIndexer(indexer: ChainIndexer): Promise<void> {
    if (indexer.timer) clearTimeout(indexer.timer);
    const child = indexer.child;
    if (!child?.pid) {
      indexer.status = "stopped";
      return;
    }
    killGroup(child.pid, "SIGTERM");
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(indexer.child !== child), 4000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited && indexer.child?.pid) killGroup(indexer.child.pid, "SIGKILL");
    indexer.status = "stopped";
    indexer.startedAt = null;
  }

  private command(name: ProcName): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
    const env: NodeJS.ProcessEnv = { ...process.env, PROCESS_NAME: name };
    const dir = name === "importer" ? "importer-subgraph" : "enrich-erc8004";
    const cwd = join(this.root, "packages", dir);
    env.HEALTH_PORT = name === "importer" ? "42071" : "42072";
    return {
      command: resolveBin(this.root, "tsx", cwd),
      args: ["src/index.ts"],
      cwd,
      env,
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
      runtime.child = null;
      runtime.startedAt = null;
      if (runtime.desired === "stopped") {
        runtime.status = "stopped";
        return;
      }
      const now = Date.now();
      runtime.restarts = runtime.restarts.filter((stamp) => now - stamp < 10 * 60 * 1000);
      runtime.restarts.push(now);
      runtime.lastError = `exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      if (runtime.restarts.length > 5) {
        runtime.status = "failed";
        recordLine(runtime.name, "error", `${runtime.name} failed after 5 restarts in 10 minutes`);
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** (runtime.restarts.length - 1));
      runtime.status = "backoff";
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
