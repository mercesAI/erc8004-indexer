import type pg from "pg";
import { decodeEventLog, type Abi } from "viem";
import {
  IdentityRegistryAbi,
  ReputationRegistryAbi,
  ValidationRegistryAbi,
  ZERO_ADDRESS,
  registryAddress,
  type RegistryKind,
} from "@merces/shared";
import type { RawLog } from "./rpc.js";

/** The events this indexer stores, and which registry must have emitted each one. */
const HANDLED: Record<string, RegistryKind> = {
  Registered: "identity",
  Transfer: "identity",
  URIUpdated: "identity",
  MetadataSet: "identity",
  NewFeedback: "reputation",
  FeedbackRevoked: "reputation",
  ResponseAppended: "reputation",
  ValidationRequest: "validation",
  ValidationResponse: "validation",
};

const ABIS: Record<RegistryKind, Abi> = {
  identity: IdentityRegistryAbi as Abi,
  reputation: ReputationRegistryAbi as Abi,
  validation: ValidationRegistryAbi as Abi,
};

export function registryAddresses(): Record<RegistryKind, string> {
  return {
    identity: registryAddress("identity"),
    reputation: registryAddress("reputation"),
    validation: registryAddress("validation"),
  };
}

export type ChainEvent = {
  name: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  blockTime: bigint;
  logIndex: number;
  txHash: string;
};

/**
 * Decode raw logs from the three registries. Logs of events this indexer does not store
 * (Approval, Upgraded, ...) are skipped. Throws if a log has no block timestamp, because every
 * table needs one and fetching block headers is exactly the cost this indexer exists to avoid.
 */
export function decodeLogs(logs: RawLog[], addresses: Record<RegistryKind, string>): { events: ChainEvent[]; skipped: number } {
  const kindByAddress = new Map<string, RegistryKind>(
    (Object.entries(addresses) as [RegistryKind, string][]).map(([kind, address]) => [address, kind]),
  );
  const events: ChainEvent[] = [];
  let skipped = 0;
  for (const log of logs) {
    const kind = kindByAddress.get(log.address.toLowerCase());
    if (!kind) {
      skipped += 1;
      continue;
    }
    let decoded: { eventName: string; args: unknown };
    try {
      decoded = decodeEventLog({ abi: ABIS[kind], data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
    } catch {
      skipped += 1;
      continue;
    }
    if (HANDLED[decoded.eventName] !== kind) {
      skipped += 1;
      continue;
    }
    if (!log.blockTimestamp) throw new Error(`eth_getLogs returned no blockTimestamp (block ${BigInt(log.blockNumber)})`);
    events.push({
      name: decoded.eventName,
      args: decoded.args as Record<string, unknown>,
      blockNumber: BigInt(log.blockNumber),
      blockTime: BigInt(log.blockTimestamp),
      logIndex: Number(BigInt(log.logIndex)),
      txHash: log.transactionHash.toLowerCase(),
    });
  }
  events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  return { events, skipped };
}

/** Postgres text cannot hold NUL. Strings from the chain occasionally contain one. */
function text(value: unknown): string {
  return String(value ?? "").replaceAll("\u0000", "");
}

function addr(value: unknown): string {
  return text(value).toLowerCase();
}

function num(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

function jsonArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string") return value.replaceAll("\u0000", "");
    return value;
  });
}

export function decodeAgentWallet(value: string): string | null {
  const body = value.toLowerCase().replace(/^0x/, "");
  let address: string | null = null;
  if (body.length === 40) address = `0x${body}`;
  else if (body.length >= 64) address = `0x${body.slice(-40)}`;
  if (!address || address === ZERO_ADDRESS || !/^0x[0-9a-f]{40}$/.test(address)) return null;
  return address;
}

export const EVENTS_RETENTION_DAYS = 7;

const SEED_AGENT = `
  INSERT INTO erc8004.agents (chain_id, agent_id, owner, agent_uri, feedback_count)
  VALUES ($1, $2, '${ZERO_ADDRESS}', '', 0)
  ON CONFLICT (chain_id, agent_id) DO NOTHING`;

/**
 * Apply events in chain order inside the caller's transaction. Every statement is an upsert, so
 * replaying a range that was already applied leaves the tables unchanged.
 */
export async function applyEvents(client: pg.PoolClient, chainId: number, events: ChainEvent[]): Promise<void> {
  const feedbackAgents = new Set<string>();
  for (const event of events) {
    const a = event.args;
    const time = event.blockTime.toString();
    switch (event.name) {
      case "Registered":
        await client.query(
          `INSERT INTO erc8004.agents (chain_id, agent_id, owner, agent_uri, registered_block, registered_at, feedback_count)
           VALUES ($1, $2, $3, $4, $5, $6, 0)
           ON CONFLICT (chain_id, agent_id) DO UPDATE SET
             owner = EXCLUDED.owner, agent_uri = EXCLUDED.agent_uri,
             registered_block = EXCLUDED.registered_block, registered_at = EXCLUDED.registered_at`,
          [chainId, num(a.agentId), addr(a.owner), text(a.agentURI), event.blockNumber.toString(), time],
        );
        break;
      case "Transfer": {
        const from = addr(a.from);
        if (from === ZERO_ADDRESS) {
          await client.query(
            `INSERT INTO erc8004.agents (chain_id, agent_id, owner, agent_uri, feedback_count)
             VALUES ($1, $2, $3, '', 0) ON CONFLICT (chain_id, agent_id) DO NOTHING`,
            [chainId, num(a.tokenId), addr(a.to)],
          );
          break;
        }
        await client.query(
          `INSERT INTO erc8004.agents (chain_id, agent_id, owner, agent_uri, last_transfer_at, feedback_count)
           VALUES ($1, $2, $3, '', $4, 0)
           ON CONFLICT (chain_id, agent_id) DO UPDATE SET
             owner = EXCLUDED.owner, agent_wallet = NULL, last_transfer_at = EXCLUDED.last_transfer_at`,
          [chainId, num(a.tokenId), addr(a.to), time],
        );
        break;
      }
      case "URIUpdated":
        await client.query(
          `INSERT INTO erc8004.agents (chain_id, agent_id, owner, agent_uri, uri_updated_at, feedback_count)
           VALUES ($1, $2, '${ZERO_ADDRESS}', $3, $4, 0)
           ON CONFLICT (chain_id, agent_id) DO UPDATE SET
             agent_uri = EXCLUDED.agent_uri, uri_updated_at = EXCLUDED.uri_updated_at`,
          [chainId, num(a.agentId), text(a.newURI), time],
        );
        break;
      case "MetadataSet": {
        const hex = String(a.metadataValue ?? "0x");
        await client.query(
          `INSERT INTO erc8004.agent_metadata (chain_id, agent_id, key, value, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (chain_id, agent_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [chainId, num(a.agentId), text(a.metadataKey), Buffer.from(hex.replace(/^0x/, ""), "hex"), time],
        );
        if (a.metadataKey === "agentWallet") {
          await client.query(SEED_AGENT, [chainId, num(a.agentId)]);
          await client.query("UPDATE erc8004.agents SET agent_wallet = $3 WHERE chain_id = $1 AND agent_id = $2", [
            chainId,
            num(a.agentId),
            decodeAgentWallet(hex),
          ]);
        }
        break;
      }
      case "NewFeedback": {
        const value = BigInt(a.value as bigint);
        const decimals = Number(a.valueDecimals);
        await client.query(
          `INSERT INTO erc8004.feedback (chain_id, agent_id, client_address, feedback_index, value, value_decimals, value_norm,
             tag1, tag2, endpoint, feedback_uri, feedback_hash, is_revoked, block_number, block_time, tx_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, $13, $14, $15)
           ON CONFLICT (chain_id, agent_id, client_address, feedback_index) DO UPDATE SET
             value = EXCLUDED.value, value_decimals = EXCLUDED.value_decimals, value_norm = EXCLUDED.value_norm,
             tag1 = EXCLUDED.tag1, tag2 = EXCLUDED.tag2, endpoint = EXCLUDED.endpoint, feedback_uri = EXCLUDED.feedback_uri,
             feedback_hash = EXCLUDED.feedback_hash, is_revoked = false, block_number = EXCLUDED.block_number,
             block_time = EXCLUDED.block_time, tx_hash = EXCLUDED.tx_hash`,
          [
            chainId, num(a.agentId), addr(a.clientAddress), num(a.feedbackIndex), value.toString(), decimals,
            Number(value) / 10 ** decimals, text(a.tag1), text(a.tag2), text(a.endpoint), text(a.feedbackURI),
            addr(a.feedbackHash), event.blockNumber.toString(), time, event.txHash,
          ],
        );
        feedbackAgents.add(num(a.agentId));
        break;
      }
      case "FeedbackRevoked":
        await client.query(
          `INSERT INTO erc8004.feedback (chain_id, agent_id, client_address, feedback_index, value, value_decimals, value_norm,
             tag1, tag2, endpoint, feedback_uri, feedback_hash, is_revoked, block_number, block_time, tx_hash)
           VALUES ($1, $2, $3, $4, 0, 0, 0, '', '', '', '', '0x${"0".repeat(64)}', true, $5, $6, $7)
           ON CONFLICT (chain_id, agent_id, client_address, feedback_index) DO UPDATE SET is_revoked = true`,
          [chainId, num(a.agentId), addr(a.clientAddress), num(a.feedbackIndex), event.blockNumber.toString(), time, event.txHash],
        );
        feedbackAgents.add(num(a.agentId));
        break;
      case "ResponseAppended":
        await client.query(
          `INSERT INTO erc8004.feedback_responses (chain_id, tx_hash, log_index, agent_id, client_address, feedback_index,
             responder, response_uri, response_hash, block_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
          [
            chainId, event.txHash, event.logIndex, num(a.agentId), addr(a.clientAddress), num(a.feedbackIndex),
            addr(a.responder), text(a.responseURI), addr(a.responseHash), time,
          ],
        );
        break;
      case "ValidationRequest":
        await client.query(
          `INSERT INTO erc8004.validations (chain_id, request_hash, validator_address, agent_id, request_uri, status, requested_at, last_update)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6)
           ON CONFLICT (chain_id, request_hash) DO UPDATE SET
             validator_address = EXCLUDED.validator_address, agent_id = EXCLUDED.agent_id, request_uri = EXCLUDED.request_uri,
             requested_at = COALESCE(erc8004.validations.requested_at, EXCLUDED.requested_at)`,
          [chainId, addr(a.requestHash), addr(a.validatorAddress), num(a.agentId), text(a.requestURI), time],
        );
        break;
      case "ValidationResponse":
        await client.query(
          `INSERT INTO erc8004.validations (chain_id, request_hash, validator_address, agent_id, response, response_uri,
             response_hash, tag, status, last_update)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', $9)
           ON CONFLICT (chain_id, request_hash) DO UPDATE SET
             validator_address = EXCLUDED.validator_address, agent_id = EXCLUDED.agent_id, response = EXCLUDED.response,
             response_uri = EXCLUDED.response_uri, response_hash = EXCLUDED.response_hash, tag = EXCLUDED.tag,
             status = 'completed', last_update = EXCLUDED.last_update`,
          [
            chainId, addr(a.requestHash), addr(a.validatorAddress), num(a.agentId), Number(a.response),
            text(a.responseURI), addr(a.responseHash), text(a.tag), time,
          ],
        );
        break;
    }
  }

  if (feedbackAgents.size > 0) {
    const ids = [...feedbackAgents];
    for (const id of ids) await client.query(SEED_AGENT, [chainId, id]);
    await client.query(
      `UPDATE erc8004.agents a
       SET feedback_count = s.n, last_feedback_at = s.last
       FROM (
         SELECT agent_id,
                count(*) FILTER (WHERE NOT is_revoked)::int AS n,
                max(block_time) FILTER (WHERE NOT is_revoked) AS last
         FROM erc8004.feedback
         WHERE chain_id = $1 AND agent_id = ANY($2::numeric[])
         GROUP BY agent_id
       ) s
       WHERE a.chain_id = $1 AND a.agent_id = s.agent_id`,
      [chainId, ids],
    );
  }

  // erc8004.events keeps 7 days. A catch-up over old blocks does not fill it with rows that would be pruned.
  const recentFrom = BigInt(Math.floor(Date.now() / 1000) - EVENTS_RETENTION_DAYS * 86_400);
  const recent = events.filter((event) => event.blockTime >= recentFrom);
  if (recent.length > 0) {
    const rows = recent.map((event) => [
      chainId, event.blockNumber.toString(), event.logIndex, event.txHash, event.blockTime.toString(), event.name, jsonArgs(event.args),
    ]);
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = rows.slice(offset, offset + 500);
      const values = batch.map((_, index) => `($${index * 7 + 1}, $${index * 7 + 2}, $${index * 7 + 3}, $${index * 7 + 4}, $${index * 7 + 5}, $${index * 7 + 6}, $${index * 7 + 7}::jsonb)`);
      await client.query(
        `INSERT INTO erc8004.events (chain_id, block_number, log_index, tx_hash, block_time, event_name, args)
         VALUES ${values.join(", ")} ON CONFLICT (chain_id, block_number, log_index) DO NOTHING`,
        batch.flat(),
      );
    }
  }
}
