import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { envInt, envList } from "@merces/shared";

const FETCH_USER_AGENT = "merces-indexer/1.0";
/** Public gateways whose URLs are read as IPFS paths and fetched through IPFS_GATEWAY instead. */
const PUBLIC_IPFS_GATEWAY_HOSTS = ["ipfs.io", "dweb.link", "gateway.pinata.cloud", "cloudflare-ipfs.com", "nftstorage.link", "w3s.link", "4everland.io"];
const GATEWAY_HOSTS_PATTERN = PUBLIC_IPFS_GATEWAY_HOSTS.map((host) => host.replaceAll(".", "\\.")).join("|");
const PUBLIC_IPFS_GATEWAY = new RegExp(`^https?://(?:${GATEWAY_HOSTS_PATTERN})/ipfs/(.+)$`, "i");
/** The same test for Postgres (`~*`): true for every URI that is fetched through a gateway. */
export const IPFS_URI_SQL_PATTERN = `^(ipfs://|https?://(${GATEWAY_HOSTS_PATTERN})/ipfs/)`;

const MAX_BYTES = 256 * 1024;

export type ServiceRow = {
  name: string;
  endpoint: string;
  version: string | null;
  extra: Record<string, unknown>;
};

export type ParsedRegistration = {
  name: string | null;
  description: string | null;
  image: string | null;
  active: boolean | null;
  x402Support: boolean | null;
  supportedTrust: string[] | null;
  services: ServiceRow[];
};

export type FetchResult = {
  ok: true;
  body: string;
  httpStatus: number | null;
  /** Host the body came from after redirects: a gateway for IPFS, null for a data: URI. */
  finalHost: string | null;
  hash: string;
  parsed: ParsedRegistration;
} | {
  ok: false;
  error: string;
  httpStatus: number | null;
};

const blockedNets = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedNets.addSubnet(address, prefix, "ipv4");
}
blockedNets.addAddress("::", "ipv6");
blockedNets.addAddress("::1", "ipv6");
blockedNets.addSubnet("fc00::", 7, "ipv6");
blockedNets.addSubnet("fe80::", 10, "ipv6");
// Transition forms that embed an IPv4 address: NAT64, 6to4, and IPv4-compatible.
blockedNets.addSubnet("64:ff9b::", 96, "ipv6");
blockedNets.addSubnet("2002::", 16, "ipv6");
blockedNets.addSubnet("::", 96, "ipv6");

export { onGateway as gatewayUrlForTest };

export function sanitizeStoredText(value: string): string {
  return value
    .replaceAll("\u0000", "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeStoredText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeStoredText(key)] = sanitizeValue(child);
    }
    return out;
  }
  return value;
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

function literalIpv4(hostname: string): string | null {
  if (/^\d+$/.test(hostname)) {
    const value = Number(hostname);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) return null;
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
  }
  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    const value = Number(hostname);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) return null;
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
  }
  return null;
}

function mappedIpv4(address: string): string | null {
  const dotted = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) return dotted[1];
  const hex = address.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex?.[1] || !hex[2]) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join(".");
}

function isBlockedAddress(address: string): boolean {
  const mapped = mappedIpv4(address);
  if (mapped) return blockedNets.check(mapped, "ipv4");
  const family = isIP(address);
  if (family === 4) return blockedNets.check(address, "ipv4");
  if (family === 6) return blockedNets.check(address, "ipv6");
  return true;
}

async function publicAddresses(hostname: string): Promise<{ address: string; family: number }[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (blockedHostname(host)) throw new Error("blocked address");
  const literal = literalIpv4(host);
  const candidates = literal ? [literal] : isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((item) => item.address);
  if (candidates.length === 0 || candidates.some((address) => isBlockedAddress(address))) {
    throw new Error("blocked address");
  }
  return candidates.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
}

function publicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("unsupported uri scheme");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported uri scheme");
  if (url.username || url.password) throw new Error("blocked address");
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (port !== 80 && port !== 443) throw new Error("blocked address");
  return url;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "blocked address" || message === "unsupported uri scheme" || message === "invalid json") return message;
  if (message === "body exceeds 256KB" || message === "too many redirects") return message;
  if (message.startsWith("HTTP ") && /^HTTP \d{3}$/.test(message)) return message;
  if (message.includes("timeout") || message.includes("aborted") || message === "TimeoutError") return "timeout";
  return "fetch failed";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseRegistration(value: unknown): ParsedRegistration {
  const record = asRecord(value) ?? {};
  const trust = record.supportedTrust ?? record.supported_trust;
  const servicesRaw = Array.isArray(record.services) ? record.services : [];
  const services = servicesRaw.flatMap((item) => {
    const service = asRecord(item);
    if (!service) return [];
    const name = typeof service.name === "string" ? sanitizeStoredText(service.name) : "unknown";
    const endpoint = typeof service.endpoint === "string" ? sanitizeStoredText(service.endpoint) : "";
    const version = typeof service.version === "string" ? sanitizeStoredText(service.version) : null;
    const extra = sanitizeValue({ ...service }) as Record<string, unknown>;
    delete extra.name;
    delete extra.endpoint;
    delete extra.version;
    return [{ name, endpoint, version, extra }];
  });
  const x402 = record.x402Support ?? record.x402_support;
  return {
    name: typeof record.name === "string" ? sanitizeStoredText(record.name) : null,
    description: typeof record.description === "string" ? sanitizeStoredText(record.description) : null,
    image: typeof record.image === "string" ? sanitizeStoredText(record.image) : null,
    active: typeof record.active === "boolean" ? record.active : null,
    x402Support: typeof x402 === "boolean" ? x402 : null,
    supportedTrust: Array.isArray(trust)
      ? trust.filter((item): item is string => typeof item === "string").map(sanitizeStoredText)
      : null,
    services,
  };
}

/** Total time one URI may take, redirects included. The per-socket idle timeout alone lets a slow drip run for days. */
function fetchDeadline(): number {
  return Date.now() + 3 * envInt("FETCH_TIMEOUT_MS", 8000);
}

async function httpGet(raw: string, deadline: number, hops = 0): Promise<{ body: string; httpStatus: number; url: string }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("timeout");
  const url = publicUrl(raw);
  const addresses = await publicAddresses(url.hostname);
  const first = addresses.find((item) => item.family === 4) ?? addresses[0];
  if (!first) throw new Error("blocked address");
  const result = await new Promise<{ status: number; location: string | null; body: string }>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json,text/plain,*/*",
          "user-agent": FETCH_USER_AGENT,
          host: url.host,
        },
        servername: url.hostname,
        lookup: (hostname: string, options: unknown, callback: unknown) => {
          void hostname;
          if (typeof options === "function") {
            (options as (err: null, address: string, family: number) => void)(null, first.address, first.family);
            return;
          }
          const all = typeof options === "object" && options !== null && "all" in options && Boolean((options as { all?: boolean }).all);
          if (all) {
            (callback as (err: null, addresses: { address: string; family: number }[]) => void)(null, [
              { address: first.address, family: first.family },
            ]);
            return;
          }
          (callback as (err: null, address: string, family: number) => void)(null, first.address, first.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_BYTES) {
            res.destroy();
            reject(new Error("body exceeds 256KB"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const location = res.headers.location;
          resolve({
            status: res.statusCode ?? 0,
            location: Array.isArray(location) ? location[0] ?? null : location ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", () => reject(new Error("fetch failed")));
      },
    );
    req.setTimeout(envInt("FETCH_TIMEOUT_MS", 8000), () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    const killer = setTimeout(() => {
      req.destroy();
      reject(new Error("timeout"));
    }, remaining);
    req.on("close", () => clearTimeout(killer));
    req.on("error", () => reject(new Error("fetch failed")));
    req.end();
  });
  if (result.status >= 300 && result.status < 400) {
    if (hops >= 3) throw new Error("too many redirects");
    if (!result.location) throw new Error("fetch failed");
    return httpGet(new URL(result.location, url).href, deadline, hops + 1);
  }
  if (result.status < 200 || result.status >= 300) {
    const error = new Error(`HTTP ${result.status}`) as Error & { httpStatus: number };
    error.httpStatus = result.status;
    throw error;
  }
  return { body: result.body, httpStatus: result.status, url: url.href };
}

/** The gateways in IPFS_GATEWAY, comma-separated, each ending in a slash. */
export function gateways(): string[] {
  return envList("IPFS_GATEWAY").map((gateway) => (gateway.endsWith("/") ? gateway : `${gateway}/`));
}

/** Path part of an IPFS URI or public-gateway URL, or null when the URI is neither. */
export function ipfsPath(uri: string): string | null {
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    if (!path) throw new Error("unsupported uri scheme");
    return path;
  }
  const match = uri.match(PUBLIC_IPFS_GATEWAY);
  return match?.[1] ?? null;
}

/**
 * The URL for an IPFS path on `gateway`. The path is resolved against the gateway the way a browser
 * would, then required to still sit under the gateway's own path, so `..`, `%2e%2e`, or an absolute
 * path cannot steer the request elsewhere on the gateway host.
 */
function onGateway(gateway: string, path: string): string {
  const base = new URL(gateway);
  let target: URL;
  try {
    target = new URL(path, base);
  } catch {
    throw new Error("unsupported uri scheme");
  }
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.pathname.length <= base.pathname.length) {
    throw new Error("unsupported uri scheme");
  }
  return target.href;
}

/**
 * Fetch and parse one registration file. An IPFS path is fetched from `gateway`, one of `gateways()`,
 * or from the first configured gateway when the caller does not choose.
 */
export async function resolveUri(uri: string, gateway?: string): Promise<FetchResult> {
  try {
    let body: string;
    let httpStatus: number | null = null;
    let finalHost: string | null = null;
    const path = ipfsPath(uri);
    if (path != null) {
      const base = gateway ?? gateways()[0];
      if (!base) throw new Error("IPFS_GATEWAY is empty");
      const fetched = await httpGet(onGateway(base, path), fetchDeadline());
      body = fetched.body;
      httpStatus = fetched.httpStatus;
      finalHost = new URL(fetched.url).hostname.toLowerCase();
    } else if (uri.startsWith("https://") || uri.startsWith("http://")) {
      const fetched = await httpGet(uri, fetchDeadline());
      body = fetched.body;
      httpStatus = fetched.httpStatus;
      finalHost = new URL(fetched.url).hostname.toLowerCase();
    } else if (uri.startsWith("data:application/json") && uri.includes(";base64,")) {
      const encoded = uri.slice(uri.indexOf(";base64,") + ";base64,".length);
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length > MAX_BYTES) throw new Error("body exceeds 256KB");
      body = decoded.toString("utf8");
    } else {
      throw new Error("unsupported uri scheme");
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(body);
    } catch {
      throw new Error("invalid json");
    }
    const stored = JSON.stringify(sanitizeValue(parsedJson));
    return {
      ok: true,
      body: stored,
      httpStatus,
      finalHost,
      hash: createHash("sha256").update(stored).digest("hex"),
      parsed: parseRegistration(parsedJson),
    };
  } catch (error) {
    return {
      ok: false,
      error: safeError(error),
      httpStatus: error instanceof Error && "httpStatus" in error && typeof error.httpStatus === "number" ? error.httpStatus : null,
    };
  }
}

export const RETRY_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000];
/** A 429, 503, or timeout says nothing about the file; it is tried again soon, whatever its step. */
export const THROTTLE_RETRY_MS = 15 * 60 * 1000;

export const TERMINAL_FETCH_ERRORS = [
  "unsupported uri scheme",
  "invalid json",
  "blocked address",
  "unstorable content",
  "HTTP 404",
  "HTTP 410",
] as const;

export function isTerminalFetchError(error: string): boolean {
  return (TERMINAL_FETCH_ERRORS as readonly string[]).includes(error);
}
