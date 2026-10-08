import { createPublicClient, http, type PublicClient } from "viem";
import { getChain, type ChainKey } from "./chains.js";
import { envInt } from "./env.js";

const clients = new Map<string, PublicClient>();

export function rpcUrlFor(key: string): string {
  const spec = getChain(key);
  const url = process.env[spec.rpcEnvVar];
  if (!url) throw new Error(`Set ${spec.rpcEnvVar} for ${key}`);
  return url;
}

export function getPublicClient(key: string): PublicClient {
  const existing = clients.get(key);
  if (existing) return existing;
  const spec = getChain(key);
  const url = rpcUrlFor(key);
  const client = createPublicClient({
    chain: {
      ...spec.viemChain,
      rpcUrls: { default: { http: [url] } },
    },
    transport: http(url, { timeout: 20_000 }),
  });
  clients.set(key, client);
  return client;
}

export function alchemyMaxRps(): number {
  return envInt("ALCHEMY_MAX_RPS", 20);
}

export type ChainKeyName = ChainKey;
