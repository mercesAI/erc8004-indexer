import { getAddress } from "viem";
import {
  IdentityRegistryAbi,
  envInt,
  ReputationRegistryAbi,
  countScanAgents,
  enabledChains,
  getPool,
  getPublicClient,
  getScanAgent,
  hasSubgraph,
  registryAddress,
  sameAddress,
  redactSecrets,
  subgraphQuery,
  type EnabledChain,
} from "@merces/shared";

export type SanityStatus = "pass" | "warn" | "fail";

export type SanityRow = {
  check: string;
  chain: string;
  subject: string;
  status: SanityStatus;
  fields: Record<string, { left: string; right: string }>;
  detail: string;
};

export type SanityReport = {
  ts: string;
  summary: { pass: number; warn: number; fail: number };
  rows: SanityRow[];
};

type AgentSample = {
  agent_id: string;
  owner: string;
  agent_uri: string;
  agent_wallet: string | null;
  registered_block: string | null;
  feedback_count: number;
};

type FeedbackSample = {
  agent_id: string;
  client_address: string;
  feedback_index: string;
  value: string;
  value_decimals: number;
  tag1: string;
  tag2: string;
  is_revoked: boolean;
};

function text(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

function blank(value: string | null | undefined): string {
  return value ?? "";
}

let running = false;

export async function runSanity(): Promise<SanityReport> {
  if (running) throw new Error("a sanity run is already in progress");
  running = true;
  try {
    const rows: SanityRow[] = [];
    const sample = Math.max(1, envInt("SANITY_SAMPLE", 10));
    for (const chain of enabledChains()) {
      rows.push(await lagRow(chain));
      const agents = await sampleAgents(chain.chainId, sample);
      const feedback = await sampleFeedback(chain.chainId, sample);
      const indexed = await indexedBlock(chain);
      for (const agent of agents) rows.push(await agentChainRow(chain, agent, indexed));
      for (const row of feedback) rows.push(await feedbackChainRow(chain, row, indexed));
      if (hasSubgraph(chain.key)) {
        for (const agent of agents) rows.push(await agentSubgraphRow(chain, agent));
      }
      for (const agent of agents) rows.push(await agentScanRow(chain, agent));
      rows.push(await countsRow(chain));
    }
    const summary = {
      pass: rows.filter((row) => row.status === "pass").length,
      warn: rows.filter((row) => row.status === "warn").length,
      fail: rows.filter((row) => row.status === "fail").length,
    };
    const report: SanityReport = { ts: new Date().toISOString(), summary, rows };
    await getPool().query(
      "INSERT INTO ops.sanity_runs (pass, warn, fail, result) VALUES ($1, $2, $3, $4::jsonb)",
      [summary.pass, summary.warn, summary.fail, JSON.stringify(report)],
    );
    return report;
  } finally {
    running = false;
  }
}

export function startSanitySchedule(): void {
  const sixHours = 6 * 60 * 60 * 1000;
  setInterval(() => {
    runSanity().catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", msg: "scheduled sanity failed", error: String(error) }));
    });
  }, sixHours);
}

/** The newest block the indexer has fully applied for this chain. Sanity reads the chain at this block. */
async function indexedBlock(chain: EnabledChain): Promise<bigint | null> {
  const result = await getPool().query<{ n: string | null }>(
    "SELECT last_block::text AS n FROM erc8004.cursors WHERE chain = $1",
    [chain.key],
  );
  const value = result.rows[0]?.n;
  return value == null || Number(value) < chain.startBlock ? null : BigInt(value);
}

async function lagRow(chain: EnabledChain): Promise<SanityRow> {
  const indexed = await indexedBlock(chain);
  let head: bigint | null = null;
  try {
    head = await getPublicClient(chain.key).getBlockNumber();
  } catch (error) {
    return row("lag", chain.key, chain.key, "warn", {}, error instanceof Error ? error.message : String(error));
  }
  if (indexed == null || head == null) {
    return row("lag", chain.key, chain.key, "warn", {}, "indexed block is not available yet");
  }
  const lag = head - indexed;
  // The indexer polls on a schedule and stays `confirmations` blocks behind, so allow two intervals of blocks.
  const updated = await getPool().query<{ age: string | null }>(
    "SELECT extract(epoch FROM now() - last_run_at)::text AS age FROM erc8004.cursors WHERE chain = $1",
    [chain.key],
  );
  const age = Number(updated.rows[0]?.age ?? Infinity);
  const allowed = 2 * envInt(`INDEX_INTERVAL_SEC_${chain.key.toUpperCase()}`, envInt("INDEX_INTERVAL_SEC", 300));
  const stale = !(age <= allowed);
  return row(
    "lag",
    chain.key,
    chain.key,
    stale ? "warn" : "pass",
    { lag: { left: indexed.toString(), right: head.toString() } },
    stale ? `last indexer run ${Number.isFinite(age) ? `${Math.round(age)}s` : "never"} ago; ${lag.toString()} blocks behind` : `${lag.toString()} blocks behind, indexer ran ${Math.round(age)}s ago`,
  );
}

async function sampleAgents(chainId: number, limit: number): Promise<AgentSample[]> {
  const result = await getPool().query<AgentSample>(
    `SELECT agent_id::text, owner, agent_uri, agent_wallet, registered_block::text, feedback_count
     FROM erc8004.agents WHERE chain_id = $1 ORDER BY random() LIMIT $2`,
    [chainId, limit],
  );
  return result.rows;
}

async function sampleFeedback(chainId: number, limit: number): Promise<FeedbackSample[]> {
  const result = await getPool().query<FeedbackSample>(
    `SELECT agent_id::text, client_address, feedback_index::text, value::text, value_decimals, tag1, tag2, is_revoked
     FROM erc8004.feedback WHERE chain_id = $1 AND is_revoked = false ORDER BY random() LIMIT $2`,
    [chainId, limit],
  );
  return result.rows;
}

const NO_ARCHIVE = /missing trie node|state (is )?not available|historical state|archive|pruned|block not found|header not found/i;

/**
 * Read a contract at the indexed block. A provider without archive state cannot serve old blocks;
 * then read at the head instead and say so, which is a warning rather than a failure.
 */
async function readAt<T>(reader: (blockNumber: bigint | undefined) => Promise<T>, blockNumber: bigint): Promise<{ value: T; atHead: boolean }> {
  try {
    return { value: await reader(blockNumber), atHead: false };
  } catch (error) {
    if (!NO_ARCHIVE.test(error instanceof Error ? error.message : String(error))) throw error;
    return { value: await reader(undefined), atHead: true };
  }
}

async function agentChainRow(chain: EnabledChain, agent: AgentSample, blockNumber: bigint | null): Promise<SanityRow> {
  const subject = `${chain.chainId}:${agent.agent_id}`;
  if (blockNumber == null) return row("agent_chain", chain.key, subject, "warn", {}, "no indexed block");
  try {
    const client = getPublicClient(chain.key);
    const address = registryAddress("identity");
    const args = [BigInt(agent.agent_id)] as const;
    const { value: [owner, uri, wallet], atHead } = await readAt(
      (at) =>
        Promise.all([
          client.readContract({ address, abi: IdentityRegistryAbi, functionName: "ownerOf", args, blockNumber: at }),
          client.readContract({ address, abi: IdentityRegistryAbi, functionName: "tokenURI", args, blockNumber: at }),
          client.readContract({ address, abi: IdentityRegistryAbi, functionName: "getAgentWallet", args, blockNumber: at }),
        ]),
      blockNumber,
    );
    const fields = {
      owner: { left: agent.owner, right: String(owner).toLowerCase() },
      agentUri: { left: agent.agent_uri, right: String(uri) },
      agentWallet: { left: blank(agent.agent_wallet), right: String(wallet).toLowerCase() },
    };
    const ok =
      fields.owner.left === fields.owner.right &&
      fields.agentUri.left === fields.agentUri.right &&
      sameAddress(fields.agentWallet.left, fields.agentWallet.right);
    if (atHead) return row("agent_chain", chain.key, subject, ok ? "pass" : "warn", fields, `${ok ? "matches" : "differs from"} the chain head; the RPC has no archive state for the indexed block`);
    return row("agent_chain", chain.key, subject, ok ? "pass" : "fail", fields, ok ? "matches chain" : "mismatch");
  } catch (error) {
    return row("agent_chain", chain.key, subject, "fail", {}, error instanceof Error ? error.message : String(error));
  }
}

async function feedbackChainRow(chain: EnabledChain, item: FeedbackSample, blockNumber: bigint | null): Promise<SanityRow> {
  const subject = `${chain.chainId}:${item.agent_id}:${item.client_address}:${item.feedback_index}`;
  if (blockNumber == null) return row("feedback_chain", chain.key, subject, "warn", {}, "no indexed block");
  try {
    const { value: result, atHead } = await readAt(
      (at) =>
        getPublicClient(chain.key).readContract({
          address: registryAddress("reputation"),
          abi: ReputationRegistryAbi,
          functionName: "readFeedback",
          args: [BigInt(item.agent_id), getAddress(item.client_address), BigInt(item.feedback_index)],
          blockNumber: at,
        }),
      blockNumber,
    );
    const parsed = parseFeedback(result);
    const fields = {
      value: { left: item.value, right: parsed.value.toString() },
      valueDecimals: { left: String(item.value_decimals), right: String(parsed.valueDecimals) },
      tag1: { left: blank(item.tag1), right: parsed.tag1 },
      tag2: { left: blank(item.tag2), right: parsed.tag2 },
      isRevoked: { left: String(item.is_revoked), right: String(parsed.isRevoked) },
    };
    const ok = Object.values(fields).every((field) => field.left === field.right);
    if (atHead) return row("feedback_chain", chain.key, subject, ok ? "pass" : "warn", fields, `${ok ? "matches" : "differs from"} the chain head; the RPC has no archive state for the indexed block`);
    return row("feedback_chain", chain.key, subject, ok ? "pass" : "fail", fields, ok ? "matches chain" : "mismatch");
  } catch (error) {
    return row("feedback_chain", chain.key, subject, "fail", {}, error instanceof Error ? error.message : String(error));
  }
}

function parseFeedback(value: unknown): {
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  isRevoked: boolean;
} {
  if (Array.isArray(value)) {
    return {
      value: BigInt(value[0] as bigint),
      valueDecimals: Number(value[1]),
      tag1: text(value[2]),
      tag2: text(value[3]),
      isRevoked: Boolean(value[4]),
    };
  }
  const record = value as Record<string, unknown>;
  return {
    value: BigInt(record.value as bigint),
    valueDecimals: Number(record.valueDecimals),
    tag1: text(record.tag1),
    tag2: text(record.tag2),
    isRevoked: Boolean(record.isRevoked),
  };
}

async function agentSubgraphRow(chain: EnabledChain, agent: AgentSample): Promise<SanityRow> {
  const subject = `${chain.chainId}:${agent.agent_id}`;
  try {
    const data = await subgraphQuery<{
      agent: { owner: string; agentURI: string | null; totalFeedback: string } | null;
    }>(chain.key, `query ($id: ID!) { agent(id: $id) { owner agentURI totalFeedback } }`, { id: subject });
    if (!data.agent) return row("agent_subgraph", chain.key, subject, "warn", {}, "not in the subgraph yet; it lags the chain by minutes");
    const fields = {
      owner: { left: agent.owner, right: data.agent.owner.toLowerCase() },
      agentUri: { left: agent.agent_uri, right: data.agent.agentURI ?? "" },
      feedbackCount: { left: String(agent.feedback_count), right: String(Number(data.agent.totalFeedback)) },
    };
    const identityOk = fields.owner.left === fields.owner.right && fields.agentUri.left === fields.agentUri.right;
    const countOk = fields.feedbackCount.left === fields.feedbackCount.right;
    // Owner and URI are facts of the chain. Feedback counts depend on what each side counts (revoked
    // feedback, the subgraph's own start block), so a difference is a warning, not a failure.
    const status: SanityStatus = !identityOk ? "fail" : !countOk ? "warn" : "pass";
    return row("agent_subgraph", chain.key, subject, status, fields, !identityOk ? "mismatch" : !countOk ? "feedback count differs" : "matches subgraph");
  } catch (error) {
    return row("agent_subgraph", chain.key, subject, "warn", {}, error instanceof Error ? error.message : String(error));
  }
}

async function agentScanRow(chain: EnabledChain, agent: AgentSample): Promise<SanityRow> {
  const subject = `${chain.chainId}:${agent.agent_id}`;
  try {
    const remote = await getScanAgent(chain.chainId, agent.agent_id);
    if (!remote) return row("agent_8004scan", chain.key, subject, "warn", {}, "not found");
    const fields = {
      owner: { left: agent.owner, right: remote.owner ?? "" },
      agentUri: { left: agent.agent_uri, right: remote.agentUri ?? "" },
      feedbackCount: { left: String(agent.feedback_count), right: remote.feedbackCount == null ? "" : String(remote.feedbackCount) },
    };
    const ok = Object.values(fields).every((field) => field.left === field.right);
    return row("agent_8004scan", chain.key, subject, ok ? "pass" : "warn", fields, ok ? "matches 8004scan" : "third-party difference");
  } catch (error) {
    return row("agent_8004scan", chain.key, subject, "warn", {}, error instanceof Error ? error.message : String(error));
  }
}

async function countsRow(chain: EnabledChain): Promise<SanityRow> {
  try {
    const client = getPublicClient(chain.key);
    const header = await client.getBlock({ blockNumber: BigInt(chain.startBlock) });
    const pg = await getPool().query<{ n: string }>(
      "SELECT count(*)::text AS n FROM erc8004.agents WHERE chain_id = $1 AND registered_block >= $2",
      [chain.chainId, chain.startBlock],
    );
    let scan = "n/a";
    try {
      const total = await countScanAgents({
        chain_id: String(chain.chainId),
        created_after: new Date(Number(header.timestamp) * 1000).toISOString(),
      });
      scan = total == null ? "n/a" : String(total);
    } catch (error) {
      scan = error instanceof Error ? error.message : "error";
    }
    const postgres = pg.rows[0]?.n ?? "0";
    const scanCount = /^\d+$/.test(scan) ? Number(scan) : null;
    // 8004scan is a third party with its own lag and filters. Fewer agents there is their business;
    // more agents there means this indexer may have missed some.
    const missing = scanCount != null && scanCount > Number(postgres);
    return row(
      "counts",
      chain.key,
      chain.key,
      missing ? "warn" : "pass",
      { agents: { left: postgres, right: scan } },
      scanCount == null
        ? `${postgres} agents registered since the start block; 8004scan unavailable (${scan})`
        : missing
          ? `8004scan lists ${scanCount - Number(postgres)} more agents than this indexer`
          : `${postgres} agents registered since the start block; 8004scan lists ${scan}`,
    );
  } catch (error) {
    return row("counts", chain.key, chain.key, "warn", {}, error instanceof Error ? error.message : String(error));
  }
}

function row(
  check: string,
  chain: string,
  subject: string,
  status: SanityStatus,
  fields: Record<string, { left: string; right: string }>,
  detail: string,
): SanityRow {
  const cleanFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      { left: redactSecrets(value.left), right: redactSecrets(value.right) },
    ]),
  );
  return { check, chain, subject, status, fields: cleanFields, detail: redactSecrets(detail) };
}
