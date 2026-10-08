export { ZERO_ADDRESS, CHAINS, chainDisplayName, enabledChains, getChain, isChainKey, knownChains, lowerAddress, registryAddress, sameAddress } from "./chains.js";
export type { ChainKey, ChainSpec, EnabledChain, RegistryKind } from "./chains.js";
export { getPool, closePool } from "./db.js";
export { envInt, envList, envString, findRepoRoot, loadEnv, reloadEnv } from "./env.js";
export { redactSecrets } from "./redact.js";
export { log } from "./logger.js";
export type { LogLevel } from "./logger.js";
export { alchemyMaxRps, getPublicClient, rpcUrlFor } from "./rpc.js";
export { countScanAgents, getScanAgent, getScanChains, getScanFeedbacks, getScanGlobalStats, parseScanAgent } from "./scan8004.js";
export type { ScanAgent } from "./scan8004.js";
export { fetchIdPage, hasSubgraph, HTTP_USER_AGENT, subgraphQuery, subgraphUrl } from "./subgraph.js";
export { IdentityRegistryAbi } from "./abis/IdentityRegistry.js";
export { ReputationRegistryAbi } from "./abis/ReputationRegistry.js";
export { ValidationRegistryAbi } from "./abis/ValidationRegistry.js";

import { loadEnv } from "./env.js";

loadEnv();
