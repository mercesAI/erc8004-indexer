import { envString } from "./env.js";
import { log } from "./logger.js";
import { HTTP_USER_AGENT } from "./subgraph.js";

export type ScanAgent = {
  chainId: number;
  agentId: string;
  owner: string | null;
  agentUri: string | null;
  feedbackCount: number | null;
  raw: unknown;
};

type RateState = {
  waitUntil: number;
};

const rate: RateState = { waitUntil: 0 };

function baseUrl(): string {
  return envString("SCAN8004_BASE_URL", "https://api.8004scan.io/api/v1").replace(/\/$/, "");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function noteRateLimit(response: Response): void {
  const remaining = Number(
    response.headers.get("x-ratelimit-remaining-minute") ??
      response.headers.get("x-ratelimit-remaining") ??
      "1",
  );
  if (response.status !== 429 && remaining > 0) return;
  const retryAfter = response.headers.get("retry-after");
  let waitMs = 60_000;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) waitMs = Math.max(1000, seconds * 1000);
  }
  rate.waitUntil = Date.now() + waitMs;
}

async function scanGet(path: string): Promise<{ status: number; body: unknown }> {
  const wait = rate.waitUntil - Date.now();
  if (wait > 0) await sleep(wait);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": HTTP_USER_AGENT,
  };
  const apiKey = process.env.SCAN8004_API_KEY;
  if (apiKey) headers["X-API-Key"] = apiKey;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(`${baseUrl()}${path}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    noteRateLimit(response);
    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`8004scan HTTP ${response.status}`);
      log("warn", "8004scan retry", { path, status: response.status, attempt });
      await sleep(1000 * attempt);
      continue;
    }
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { status: response.status, body };
  }
  throw lastError instanceof Error ? lastError : new Error("8004scan request failed");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseScanAgent(body: unknown, chainId: number, agentId: string): ScanAgent {
  const record = asRecord(body) ?? {};
  const metadata = asRecord(record.raw_metadata);
  const owner = record.owner_address ?? record.owner;
  const uri = metadata?.offchain_uri ?? record.agent_uri ?? record.agentUri ?? record.token_uri;
  const feedback = record.total_feedbacks ?? record.feedback_count ?? record.feedbackCount;
  return {
    chainId,
    agentId,
    owner: typeof owner === "string" ? owner.toLowerCase() : null,
    agentUri: typeof uri === "string" ? uri : null,
    feedbackCount: typeof feedback === "number" ? feedback : feedback == null ? null : Number(feedback),
    raw: body,
  };
}

export async function getScanAgent(chainId: number, agentId: string | bigint): Promise<ScanAgent | null> {
  const { status, body } = await scanGet(`/agents/${chainId}/${agentId}`);
  if (status === 404) return null;
  if (status >= 400) throw new Error(`8004scan agent HTTP ${status}`);
  return parseScanAgent(body, chainId, String(agentId));
}

export async function getScanFeedbacks(params: Record<string, string> = {}): Promise<unknown> {
  const query = new URLSearchParams(params).toString();
  const { status, body } = await scanGet(`/feedbacks${query ? `?${query}` : ""}`);
  if (status >= 400) throw new Error(`8004scan feedbacks HTTP ${status}`);
  return body;
}

export async function getScanChains(): Promise<unknown> {
  const { status, body } = await scanGet("/chains");
  if (status >= 400) throw new Error(`8004scan chains HTTP ${status}`);
  return body;
}

export async function getScanGlobalStats(): Promise<unknown> {
  const { status, body } = await scanGet("/stats/global");
  if (status >= 400) throw new Error(`8004scan stats HTTP ${status}`);
  return body;
}

export async function countScanAgents(params: Record<string, string>): Promise<number | null> {
  const query = new URLSearchParams({ ...params, limit: "1" }).toString();
  const { status, body } = await scanGet(`/agents?${query}`);
  if (status >= 400) throw new Error(`8004scan agents HTTP ${status}`);
  const record = asRecord(body);
  const total = record?.total;
  return typeof total === "number" ? total : null;
}
