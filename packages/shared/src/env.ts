import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

export function findRepoRoot(): string {
  const starts = [process.cwd()];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // import.meta.url is always available in ESM; ignore if a test runner hides it.
  }
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("Could not find the repo root (pnpm-workspace.yaml)");
}

function expand(value: string, depth = 0): string {
  if (depth > 8) return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) =>
    expand(process.env[name] ?? "", depth + 1),
  );
}

let loaded = false;

export function reloadEnv(): string {
  loaded = false;
  return loadEnv();
}

export function loadEnv(): string {
  const root = findRepoRoot();
  if (!loaded) {
    // Override inherited values so a stale shell export cannot shadow .env.
    loadDotenv({ path: join(root, ".env"), override: true });
    loaded = true;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.includes("${")) {
      process.env[key] = expand(value);
    }
  }
  return root;
}

export function envString(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

export function envInt(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable ${name}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} is not a number`);
  return value;
}

export function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
