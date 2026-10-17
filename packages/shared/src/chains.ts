import { defineChain, type Chain } from "viem";
import * as viemChains from "viem/chains";
import { envInt, envList, envString } from "./env.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type ChainKey =
  | "ethereum"
  | "base"
  | "bnb"
  | "avalanche"
  | "mantle"
  | "arbitrum"
  | "optimism"
  | "polygon"
  | "scroll"
  | "gnosis"
  | "celo"
  | "linea"
  | "abstract"
  | "soneium"
  | "monad"
  | "robinhood"
  | "arc"
  | "tempo";

export type ChainSpec = {
  key: ChainKey;
  chainId: number;
  viemChain: Chain;
  rpcEnvVar: string;
  startBlockEnvVar: string;
  subgraphEnvVar: string;
  identityDeployBlock: number;
  explorerUrl: string;
};

type SpecInput = Omit<ChainSpec, "viemChain">;

const SPECS: SpecInput[] = [
  { key: "ethereum", chainId: 1, rpcEnvVar: "RPC_ETHEREUM", startBlockEnvVar: "START_BLOCK_ETHEREUM", subgraphEnvVar: "SUBGRAPH_ID_ETHEREUM", identityDeployBlock: 24_339_871, explorerUrl: "https://etherscan.io" },
  { key: "base", chainId: 8453, rpcEnvVar: "RPC_BASE", startBlockEnvVar: "START_BLOCK_BASE", subgraphEnvVar: "SUBGRAPH_ID_BASE", identityDeployBlock: 41_663_783, explorerUrl: "https://basescan.org" },
  { key: "bnb", chainId: 56, rpcEnvVar: "RPC_BNB", startBlockEnvVar: "START_BLOCK_BNB", subgraphEnvVar: "SUBGRAPH_ID_BNB", identityDeployBlock: 79_027_268, explorerUrl: "https://bscscan.com" },
  { key: "avalanche", chainId: 43_114, rpcEnvVar: "RPC_AVALANCHE", startBlockEnvVar: "START_BLOCK_AVALANCHE", subgraphEnvVar: "SUBGRAPH_ID_AVALANCHE", identityDeployBlock: 77_389_037, explorerUrl: "https://snowtrace.io" },
  { key: "mantle", chainId: 5000, rpcEnvVar: "RPC_MANTLE", startBlockEnvVar: "START_BLOCK_MANTLE", subgraphEnvVar: "SUBGRAPH_ID_MANTLE", identityDeployBlock: 91_333_846, explorerUrl: "https://mantlescan.xyz" },
  { key: "arbitrum", chainId: 42_161, rpcEnvVar: "RPC_ARBITRUM", startBlockEnvVar: "START_BLOCK_ARBITRUM", subgraphEnvVar: "SUBGRAPH_ID_ARBITRUM", identityDeployBlock: 428_895_443, explorerUrl: "https://arbiscan.io" },
  { key: "optimism", chainId: 10, rpcEnvVar: "RPC_OPTIMISM", startBlockEnvVar: "START_BLOCK_OPTIMISM", subgraphEnvVar: "SUBGRAPH_ID_OPTIMISM", identityDeployBlock: 147_514_947, explorerUrl: "https://optimistic.etherscan.io" },
  { key: "polygon", chainId: 137, rpcEnvVar: "RPC_POLYGON", startBlockEnvVar: "START_BLOCK_POLYGON", subgraphEnvVar: "SUBGRAPH_ID_POLYGON", identityDeployBlock: 82_458_484, explorerUrl: "https://polygonscan.com" },
  { key: "scroll", chainId: 534_352, rpcEnvVar: "RPC_SCROLL", startBlockEnvVar: "START_BLOCK_SCROLL", subgraphEnvVar: "SUBGRAPH_ID_SCROLL", identityDeployBlock: 29_432_417, explorerUrl: "https://scrollscan.com" },
  { key: "gnosis", chainId: 100, rpcEnvVar: "RPC_GNOSIS", startBlockEnvVar: "START_BLOCK_GNOSIS", subgraphEnvVar: "SUBGRAPH_ID_GNOSIS", identityDeployBlock: 44_505_010, explorerUrl: "https://gnosisscan.io" },
  { key: "celo", chainId: 42_220, rpcEnvVar: "RPC_CELO", startBlockEnvVar: "START_BLOCK_CELO", subgraphEnvVar: "SUBGRAPH_ID_CELO", identityDeployBlock: 58_396_724, explorerUrl: "https://celoscan.io" },
  { key: "linea", chainId: 59_144, rpcEnvVar: "RPC_LINEA", startBlockEnvVar: "START_BLOCK_LINEA", subgraphEnvVar: "SUBGRAPH_ID_LINEA", identityDeployBlock: 28_662_553, explorerUrl: "https://lineascan.build" },
  { key: "abstract", chainId: 2741, rpcEnvVar: "RPC_ABSTRACT", startBlockEnvVar: "START_BLOCK_ABSTRACT", subgraphEnvVar: "SUBGRAPH_ID_ABSTRACT", identityDeployBlock: 39_596_871, explorerUrl: "https://abscan.org" },
  { key: "soneium", chainId: 1868, rpcEnvVar: "RPC_SONEIUM", startBlockEnvVar: "START_BLOCK_SONEIUM", subgraphEnvVar: "SUBGRAPH_ID_SONEIUM", identityDeployBlock: 18_879_198, explorerUrl: "https://soneium.blockscout.com" },
  { key: "monad", chainId: 143, rpcEnvVar: "RPC_MONAD", startBlockEnvVar: "START_BLOCK_MONAD", subgraphEnvVar: "SUBGRAPH_ID_MONAD", identityDeployBlock: 52_952_790, explorerUrl: "https://monadscan.com" },
  { key: "robinhood", chainId: 4663, rpcEnvVar: "RPC_ROBINHOOD", startBlockEnvVar: "START_BLOCK_ROBINHOOD", subgraphEnvVar: "SUBGRAPH_ID_ROBINHOOD", identityDeployBlock: 12_058_809, explorerUrl: "https://robinhoodchain.blockscout.com" },
  { key: "arc", chainId: 5042, rpcEnvVar: "RPC_ARC", startBlockEnvVar: "START_BLOCK_ARC", subgraphEnvVar: "SUBGRAPH_ID_ARC", identityDeployBlock: 13_344_062, explorerUrl: "https://explorer.arc.io" },
  { key: "tempo", chainId: 4217, rpcEnvVar: "RPC_TEMPO", startBlockEnvVar: "START_BLOCK_TEMPO", subgraphEnvVar: "SUBGRAPH_ID_TEMPO", identityDeployBlock: 13_955_753, explorerUrl: "https://explore.tempo.xyz" },
];

function viemChainFor(spec: SpecInput): Chain {
  for (const value of Object.values(viemChains)) {
    if (value && typeof value === "object" && "id" in value && (value as Chain).id === spec.chainId) {
      return value as Chain;
    }
  }
  return defineChain({
    id: spec.chainId,
    name: spec.key,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1"] } },
  });
}

export const CHAINS: Record<ChainKey, ChainSpec> = Object.fromEntries(
  SPECS.map((spec) => [spec.key, { ...spec, viemChain: viemChainFor(spec) }]),
) as Record<ChainKey, ChainSpec>;

const CHAIN_NAMES: Record<ChainKey, string> = {
  ethereum: "Ethereum",
  base: "Base",
  bnb: "BNB",
  avalanche: "Avalanche",
  mantle: "Mantle",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  polygon: "Polygon",
  scroll: "Scroll",
  gnosis: "Gnosis",
  celo: "Celo",
  linea: "Linea",
  abstract: "Abstract",
  soneium: "Soneium",
  monad: "Monad",
  robinhood: "Robinhood",
  arc: "Arc",
  tempo: "Tempo",
};

export function knownChains(): { chainId: number; key: ChainKey; name: string }[] {
  return Object.values(CHAINS).map((spec) => ({
    chainId: spec.chainId,
    key: spec.key,
    name: CHAIN_NAMES[spec.key],
  }));
}

export function chainDisplayName(chainId: number): string {
  return knownChains().find((chain) => chain.chainId === chainId)?.name ?? "Chain";
}

export function isChainKey(value: string): value is ChainKey {
  return Object.prototype.hasOwnProperty.call(CHAINS, value);
}

export function getChain(key: string): ChainSpec {
  if (!isChainKey(key)) throw new Error(`Unknown chain "${key}"`);
  return CHAINS[key];
}

export type EnabledChain = ChainSpec & { startBlock: number; rpcUrl: string };

export function enabledChains(): EnabledChain[] {
  const keys = envList("CHAINS");
  if (keys.length === 0) throw new Error("CHAINS is empty");
  return keys.map((key) => {
    const spec = getChain(key);
    const rpcUrl = process.env[spec.rpcEnvVar];
    if (!rpcUrl) throw new Error(`Set ${spec.rpcEnvVar} to enable ${key}`);
    return {
      ...spec,
      // Empty START_BLOCK_<CHAIN> means full history: the Identity registry's deploy block.
      startBlock: envInt(spec.startBlockEnvVar, spec.identityDeployBlock),
      rpcUrl,
    };
  });
}

/**
 * Blocks the indexer stays behind the head. Logs inside this window are not read yet, so a
 * reorg shallower than this never reaches the tables and the indexer has no reorg handling.
 */
const CONFIRMATIONS: Partial<Record<ChainKey, number>> = {
  ethereum: 32,
  polygon: 64,
  arbitrum: 240,
};

export function confirmationsFor(key: ChainKey): number {
  return CONFIRMATIONS[key] ?? 30;
}

export type RegistryKind = "identity" | "reputation" | "validation";

const REGISTRY_ENV: Record<RegistryKind, string> = {
  identity: "IDENTITY_REGISTRY",
  reputation: "REPUTATION_REGISTRY",
  validation: "VALIDATION_REGISTRY",
};

export function registryAddress(kind: RegistryKind): `0x${string}` {
  const value = envString(REGISTRY_ENV[kind]).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${REGISTRY_ENV[kind]} is not an address`);
  }
  return value as `0x${string}`;
}

export function lowerAddress(value: string | null | undefined): string {
  return (value ?? ZERO_ADDRESS).toLowerCase();
}

export function sameAddress(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalize = (value: string | null | undefined) => {
    if (!value) return null;
    const lowered = value.toLowerCase();
    return lowered === ZERO_ADDRESS ? null : lowered;
  };
  return normalize(left) === normalize(right);
}
