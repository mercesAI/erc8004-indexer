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
      error?: { code?: number; message?: string };
    } | null;
    if (!body) {
      counters.errors += 1;
      throw new RpcError(`${method} HTTP ${response.status} with no JSON body`, null, response.status);
    }
    if (body.error) {
      counters.errors += 1;
      throw new RpcError(redactSecrets(`${method}: ${body.error.message ?? "error"}`), body.error.code ?? null, response.status);
    }
    return body.result as T;
  }
  throw lastError instanceof Error ? lastError : new RpcError(`${method} failed`, null, null);
}

export async function blockNumber(url: string, counters: ChainCounters): Promise<number> {
  return Number(BigInt(await rpcCall<string>(url, "eth_blockNumber", [], counters)));
}

const RANGE_ERROR = /range|limit|too many|exceed|10000|10,000|response size|block range|query returned more/i;

/**
 * Logs for `addresses` in [from, to]. On a "too many results" or "range too large" error the range is
 * halved and retried, down to a single block. Returns logs in chain order.
 */
export async function getLogs(
  url: string,
  addresses: string[],
  from: number,
  to: number,
  counters: ChainCounters,
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
    if (!(error instanceof RpcError) || error.httpStatus === 429 || from >= to) throw error;
    if (error.code !== -32005 && error.code !== -32602 && !RANGE_ERROR.test(error.message)) throw error;
    const middle = Math.floor((from + to) / 2);
    const left = await getLogs(url, addresses, from, middle, counters);
    const right = await getLogs(url, addresses, middle + 1, to, counters);
    return [...left, ...right];
  }
}
