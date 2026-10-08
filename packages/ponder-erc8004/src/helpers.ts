import { rawEvent, agent } from "ponder:schema";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type LogEvent = {
  args: object;
  log: { logIndex: number };
  block: { number: bigint; timestamp: bigint };
  transaction: { hash: `0x${string}` };
};

export function serializeArgs(args: object): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(args, (_key, value: unknown) => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
      if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
      return value;
    }),
  ) as Record<string, unknown>;
}

export async function writeRaw(
  db: {
    insert: (table: typeof rawEvent) => {
      values: (values: Record<string, unknown>) => { onConflictDoNothing: () => Promise<unknown> };
    };
  },
  chainId: number,
  event: LogEvent,
  contract: string,
  eventName: string,
): Promise<void> {
  await db.insert(rawEvent).values({
    chainId,
    txHash: event.transaction.hash.toLowerCase(),
    logIndex: event.log.logIndex,
    blockNumber: event.block.number,
    blockTime: event.block.timestamp,
    contract,
    eventName,
    args: serializeArgs(event.args),
  }).onConflictDoNothing();
}

export function agentSeed(chainId: number, agentId: bigint, patch: Record<string, unknown> = {}) {
  return {
    chainId,
    agentId,
    owner: ZERO_ADDRESS,
    agentUri: "",
    agentWallet: null,
    registeredBlock: null,
    registeredAt: null,
    lastTransferAt: null,
    uriUpdatedAt: null,
    feedbackCount: 0,
    lastFeedbackAt: null,
    ...patch,
  };
}

export function valueNorm(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

export function decodeAgentWallet(value: `0x${string}`): string | null {
  const body = value.toLowerCase().slice(2);
  let address: string | null = null;
  if (body.length === 40) address = `0x${body}`;
  else if (body.length >= 64) address = `0x${body.slice(-40)}`;
  if (!address || address === ZERO_ADDRESS) return null;
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  return address;
}

export { agent };
