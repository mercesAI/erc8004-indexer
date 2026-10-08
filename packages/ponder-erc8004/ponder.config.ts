import { createConfig, rateLimit } from "ponder";
import { http } from "viem";
import {
  IdentityRegistryAbi,
  ReputationRegistryAbi,
  ValidationRegistryAbi,
  alchemyMaxRps,
  enabledChains,
  envInt,
  registryAddress,
} from "@merces/shared";

function logRange(): number {
  const value = envInt("ETH_GET_LOGS_BLOCK_RANGE", 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("ETH_GET_LOGS_BLOCK_RANGE must be an integer >= 1");
  }
  return value;
}

const enabled = enabledChains();
const requestsPerSecond = alchemyMaxRps();

const chains = Object.fromEntries(
  enabled.map((chain) => [
    chain.key,
    {
      id: chain.chainId,
      // maxRequestsPerSecond is deprecated in current Ponder. rateLimit applies ALCHEMY_MAX_RPS.
      rpc: rateLimit(http(chain.rpcUrl), { requestsPerSecond, browser: false }),
      pollingInterval: 2_000,
      // Alchemy's free tier rejects eth_getLogs ranges above 10 blocks.
      ethGetLogsBlockRange: logRange(),
    },
  ]),
);

const chain = Object.fromEntries(enabled.map((item) => [item.key, { startBlock: item.startBlock }]));

const identity = registryAddress("identity");
const reputation = registryAddress("reputation");
const validation = registryAddress("validation");

export default createConfig({
  database: {
    kind: "postgres",
    connectionString: process.env.DATABASE_URL,
  },
  chains,
  contracts: {
    IdentityRegistry: {
      abi: IdentityRegistryAbi,
      address: identity,
      chain,
    },
    ReputationRegistry: {
      abi: ReputationRegistryAbi,
      address: reputation,
      chain,
    },
    ValidationRegistry: {
      abi: ValidationRegistryAbi,
      address: validation,
      chain,
    },
  },
});
