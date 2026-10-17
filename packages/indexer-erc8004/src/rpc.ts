import { alchemyMaxRps, redactSecrets } from "@merces/shared";

/** A JSON-RPC error returned by the node. `code` is the JSON-RPC error code when there is one. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly httpStatus: number | null,
  ) {
    super(message);
  }
}

export type RawLog = {
  address: string;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: `0x${string}`;
  blockTimestamp?: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: `0x${string}`;
  removed?: boolean;
};

export type ChainCounters = { requests: number; errors: number };

// One limiter for the whole process, so every chain together stays under ALCHEMY_MAX_RPS.
let nextSlot = 0;
async function takeSlot(): Promise<void> {
  const gap = 1000 / Math.max(1, alchemyMaxRps());
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One JSON-RPC call. Retries rate limits (HTTP 429), server errors, and network failures twice with
 * backoff. A JSON-RPC error in the body is not retried here: the caller decides, because a
 * "range too large" error needs a smaller range, not the same request again.
 */
export async function rpcCall<T>(url: string, method: string, params: unknown[], counters: ChainCounters): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);
    await takeSlot();
    counters.requests += 1;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      counters.errors += 1;
      lastError = new RpcError(`${method} network error: ${error instanceof Error ? error.message : String(error)}`, null, null);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      counters.errors += 1;
      const body = redactSecrets((await response.text().catch(() => "")).slice(0, 300));
      lastError = new RpcError(`${method} HTTP ${response.status} ${body}`.trim(), null, response.status);
      continue;
    }
    const body = (await response.json().catch(() => null)) as {
      result?: T;
      error?: { code?: number; message?: string; data?: unknown };
    } | null;
    if (body?.error) {
      counters.errors += 1;
      const data = body.error.data === undefined ? "" : ` (${JSON.stringify(body.error.data).slice(0, 200)})`;
      throw new RpcError(redactSecrets(`${method}: ${body.error.message ?? "error"}${data}`), body.error.code ?? null, response.status);
    }
    if (!body || !response.ok || body.result === undefined) {
      // A 401/403 from the provider, an HTML error page, or a proxy answer. Not retryable.
      counters.errors += 1;
      throw new RpcError(`${method} HTTP ${response.status} without a JSON-RPC result`, null, response.status);
    }
    return body.result;
  }
  throw lastError instanceof Error ? lastError : new RpcError(`${method} failed`, null, null);
}

export async function blockNumber(url: string, counters: ChainCounters): Promise<number> {
  return Number(BigInt(await rpcCall<string>(url, "eth_blockNumber", [], counters)));
}

/**
 * Errors that mean "ask for fewer blocks". Measured against Alchemy: code -32008 "Response is too big"
 * when a range holds too many logs. Infura and others answer "query returned more than 10000 results"
 * with -32005, and some nodes reject wide ranges with -32602 / -32600 and a "block range" message.
 * Rate-limit and quota errors also talk about limits, so they are excluded by name.
 */
const SHRINK_MESSAGE = /too (big|many|large)|response size|block range|limited to .*range|returned more than|exceed(s|ed)? (the )?(max(imum)? )?(limit|size)|10,?000 (logs|results)/i;
const TIMEOUT_MESSAGE = /timeout|timed out|aborted/i;
const QUOTA_MESSAGE = /capacity|compute unit|rate ?limit|per second|throughput|quota|billing/i;

export function shouldShrinkRange(error: unknown): boolean {
  if (!(error instanceof RpcError) || error.httpStatus === 429) return false;
  if (QUOTA_MESSAGE.test(error.message)) return false;
  if (error.code === -32008 || error.code === -32005) return true;
  return SHRINK_MESSAGE.test(error.message);
}

/**
 * Logs for `addresses` in [from, to]. When the provider says the range holds too much, the range is
 * halved and both halves are fetched, down to a single block. A client-side timeout (30 s with no
 * answer) halves once, in case the answer was simply too large to arrive in time; a half that times
 * out again fails the cycle, so an outage does not turn into thousands of single-block requests.
 * Returns logs in chain order.
 */
export async function getLogs(
  url: string,
  addresses: string[],
  from: number,
  to: number,
  counters: ChainCounters,
  splitOnTimeout = true,
): Promise<RawLog[]> {
  try {
    const logs = await rpcCall<RawLog[]>(
      url,
      "eth_getLogs",
      [{ address: addresses, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
      counters,
    );
    return logs.filter((log) => !log.removed);
  } catch (error) {
    if (from >= to) throw error;
    const timeout = error instanceof RpcError && error.httpStatus === null && error.code === null && TIMEOUT_MESSAGE.test(error.message);
    if (!shouldShrinkRange(error) && !(timeout && splitOnTimeout)) throw error;
    const middle = Math.floor((from + to) / 2);
    const left = await getLogs(url, addresses, from, middle, counters, false);
    const right = await getLogs(url, addresses, middle + 1, to, counters, false);
    return [...left, ...right];
  }
}

/**
 * Alchemy, Erigon and Reth include `blockTimestamp` in every log. Providers that do not get one
 * eth_getBlockByNumber (without transactions) per distinct block, which is the cheapest way to
 * learn the time. The logs are updated in place.
 */
export async function fillBlockTimestamps(url: string, logs: RawLog[], counters: ChainCounters): Promise<number> {
  const missing = new Set<string>();
  for (const log of logs) if (!log.blockTimestamp) missing.add(log.blockNumber);
  if (missing.size === 0) return 0;
  const stamps = new Map<string, `0x${string}`>();
  for (const number of missing) {
    const header = await rpcCall<{ timestamp?: `0x${string}` } | null>(url, "eth_getBlockByNumber", [number, false], counters);
    if (!header?.timestamp) throw new RpcError(`eth_getBlockByNumber(${number}) returned no timestamp`, null, null);
    stamps.set(number, header.timestamp);
  }
  for (const log of logs) if (!log.blockTimestamp) log.blockTimestamp = stamps.get(log.blockNumber);
  return missing.size;
}
