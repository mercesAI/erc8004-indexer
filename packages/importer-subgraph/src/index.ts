import { createServer } from "node:http";
import { envInt, envList, fetchIdPage, getPool, log, subgraphQuery } from "@merces/shared";

type Cursor = {
  chain: string;
  entity: string;
  cursor: string;
  mode: "backfill" | "incremental";
  watermark: string | null;
};

type AgentRow = {
  id: string;
  chainId: string;
  agentId: string;
  owner: string;
  agentURI: string | null;
  createdAt: string;
  totalFeedback: string;
  updatedAt: string;
};

type FileRow = {
  id: string;
  agentId: string;
  name: string | null;
  mcpEndpoint: string | null;
  a2aEndpoint: string | null;
  createdAt: string;
};

type FeedbackRow = {
  id: string;
  value: string;
  tag1: string | null;
  tag2: string | null;
  clientAddress: string;
  isRevoked: boolean;
  createdAt: string;
  revokedAt: string | null;
  feedbackIndex: string;
};

type ValidationRow = {
  id: string;
  validatorAddress: string;
  response: number | null;
  status: string;
  agent: { id: string } | null;
  updatedAt: string | null;
  createdAt: string | null;
};

const state = {
  paused: false,
  lastPass: null as null | {
    at: string;
    durationMs: number;
    counts: Record<string, number>;
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paused(): Promise<boolean> {
  const result = await getPool().query<{ paused: boolean }>(
    "SELECT paused FROM ops.worker_control WHERE worker = 'importer'",
  );
  state.paused = result.rows[0]?.paused ?? false;
  return state.paused;
}

async function waitWhilePaused(): Promise<void> {
  while (await paused()) await sleep(2000);
}

async function readCursor(chain: string, entity: string): Promise<Cursor> {
  const result = await getPool().query<Cursor>(
    "SELECT chain, entity, cursor, mode, watermark FROM mirror.cursors WHERE chain = $1 AND entity = $2",
    [chain, entity],
  );
  return (
    result.rows[0] ?? {
      chain,
      entity,
      cursor: "",
      mode: "backfill",
      watermark: null,
    }
  );
}

async function saveCursor(cursor: Cursor): Promise<void> {
  await getPool().query(
    `INSERT INTO mirror.cursors (chain, entity, cursor, mode, watermark, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (chain, entity) DO UPDATE
     SET cursor = EXCLUDED.cursor, mode = EXCLUDED.mode, watermark = EXCLUDED.watermark, updated_at = now()`,
    [cursor.chain, cursor.entity, cursor.cursor, cursor.mode, cursor.watermark],
  );
}

function num(value: string | null | undefined): string | null {
  return value == null ? null : value;
}

async function upsertAgent(chain: string, row: AgentRow): Promise<void> {
  await getPool().query(
    `INSERT INTO mirror.agents
      (id, chain_id, agent_id, owner, agent_uri, created_at, total_feedback, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       chain_id = EXCLUDED.chain_id,
       agent_id = EXCLUDED.agent_id,
       owner = EXCLUDED.owner,
       agent_uri = EXCLUDED.agent_uri,
       created_at = EXCLUDED.created_at,
       total_feedback = EXCLUDED.total_feedback,
       raw = EXCLUDED.raw`,
    [
      row.id,
      num(row.chainId),
      num(row.agentId),
      row.owner.toLowerCase(),
      row.agentURI,
      num(row.createdAt),
      num(row.totalFeedback),
      JSON.stringify(row),
    ],
  );
  await getPool().query(
    `UPDATE mirror.agents a
     SET name = r.name, mcp_endpoint = r.mcp_endpoint, a2a_endpoint = r.a2a_endpoint
     FROM mirror.registration_files r
     WHERE a.id = $1 AND r.agent_ref = $1 AND a.name IS NULL`,
    [row.id],
  );
  void chain;
}

async function upsertFile(row: FileRow): Promise<void> {
  const [chainId, agentId] = row.agentId.split(":");
  await getPool().query(
    `INSERT INTO mirror.registration_files
      (id, agent_ref, chain_id, agent_id, name, mcp_endpoint, a2a_endpoint, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       agent_ref = EXCLUDED.agent_ref,
       name = EXCLUDED.name,
       mcp_endpoint = EXCLUDED.mcp_endpoint,
       a2a_endpoint = EXCLUDED.a2a_endpoint,
       raw = EXCLUDED.raw`,
    [row.id, row.agentId, num(chainId), num(agentId), row.name, row.mcpEndpoint, row.a2aEndpoint, JSON.stringify(row)],
  );
  await getPool().query(
    `UPDATE mirror.agents
     SET name = COALESCE($2, name),
         mcp_endpoint = COALESCE($3, mcp_endpoint),
         a2a_endpoint = COALESCE($4, a2a_endpoint)
     WHERE id = $1`,
    [row.agentId, row.name, row.mcpEndpoint, row.a2aEndpoint],
  );
}

async function upsertFeedback(row: FeedbackRow): Promise<void> {
  const [chainId, agentId, clientFromId] = row.id.split(":");
  const client = (row.clientAddress || clientFromId || "").toLowerCase();
  await getPool().query(
    `INSERT INTO mirror.feedback
      (id, chain_id, agent_id, client_address, value, tag1, tag2, is_revoked, created_at, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       value = EXCLUDED.value,
       tag1 = EXCLUDED.tag1,
       tag2 = EXCLUDED.tag2,
       is_revoked = EXCLUDED.is_revoked,
       client_address = EXCLUDED.client_address,
       raw = EXCLUDED.raw`,
    [
      row.id,
      num(chainId),
      num(agentId),
      client,
      row.value,
      row.tag1,
      row.tag2,
      row.isRevoked,
      num(row.createdAt),
      JSON.stringify(row),
    ],
  );
}

async function upsertValidation(row: ValidationRow): Promise<void> {
  const agentRef = row.agent?.id ?? "";
  const [chainId, agentId] = agentRef.split(":");
  await getPool().query(
    `INSERT INTO mirror.validations
      (id, chain_id, agent_id, validator_address, response, status, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       validator_address = EXCLUDED.validator_address,
       response = EXCLUDED.response,
       status = EXCLUDED.status,
       raw = EXCLUDED.raw`,
    [
      row.id,
      num(chainId),
      num(agentId),
      row.validatorAddress.toLowerCase(),
      row.response,
      row.status,
      JSON.stringify(row),
    ],
  );
}

const AGENT_FIELDS = "id chainId agentId owner agentURI createdAt totalFeedback updatedAt";
const FILE_FIELDS = "id agentId name mcpEndpoint a2aEndpoint createdAt";
const FEEDBACK_FIELDS = "id value tag1 tag2 clientAddress isRevoked createdAt revokedAt feedbackIndex";
const VALIDATION_FIELDS = "id validatorAddress response status updatedAt createdAt agent { id }";

async function backfill<T extends { id: string; updatedAt?: string | null; createdAt?: string | null }>(
  chain: string,
  entity: string,
  field: string,
  selection: string,
  upsert: (row: T) => Promise<void>,
): Promise<number> {
  const cursor = await readCursor(chain, entity);
  if (cursor.mode === "incremental") return 0;
  let count = 0;
  let lastId = cursor.cursor;
  let maxMark = BigInt(cursor.watermark ?? "0");
  for (;;) {
    if (await paused()) break;
    const page = await fetchIdPage<T>({ chain, field, selection, lastId });
    for (const row of page) {
      await upsert(row);
      const stamp = row.updatedAt ?? row.createdAt;
      if (stamp && BigInt(stamp) > maxMark) maxMark = BigInt(stamp);
    }
    count += page.length;
    cursor.watermark = maxMark.toString();
    if (page.length === 0 || page.length < 1000) {
      cursor.mode = "incremental";
      if (page.length > 0) cursor.cursor = page[page.length - 1]?.id ?? lastId;
      await saveCursor(cursor);
      break;
    }
    lastId = page[page.length - 1]?.id ?? lastId;
    cursor.cursor = lastId;
    await saveCursor(cursor);
  }
  return count;
}

async function incremental(
  chain: string,
  entity: string,
  query: string,
  field: string,
  upsert: (row: { id: string }) => Promise<void>,
  stamp: (row: { id: string }) => string | null,
): Promise<number> {
  const cursor = await readCursor(chain, entity);
  if (cursor.mode !== "incremental") return 0;
  let watermark = cursor.watermark ?? "0";
  let count = 0;
  for (let pageNo = 0; pageNo < 50; pageNo++) {
    if (await paused()) break;
    const data = await subgraphQuery<Record<string, { id: string }[]>>(chain, query, { ts: watermark });
    const page = data[field] ?? [];
    for (const row of page) await upsert(row);
    count += page.length;
    if (page.length === 0) break;
    const lastStamp = stamp(page[page.length - 1]) ?? watermark;
    if (lastStamp === watermark) {
      watermark = (BigInt(watermark) + 1n).toString();
    } else {
      watermark = lastStamp;
    }
    cursor.watermark = watermark;
    await saveCursor(cursor);
    if (page.length < 1000) break;
  }
  return count;
}

async function syncChain(chain: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  counts.agents =
    (await backfill(chain, "agents", "agents", AGENT_FIELDS, (row) => upsertAgent(chain, row as AgentRow))) +
    (await incremental(
      chain,
      "agents",
      `query ($ts: BigInt!) { agents(first: 1000, where: { updatedAt_gt: $ts }, orderBy: updatedAt, orderDirection: asc) { ${AGENT_FIELDS} } }`,
      "agents",
      (row) => upsertAgent(chain, row as AgentRow),
      (row) => (row as AgentRow).updatedAt,
    ));
  counts.registration_files =
    (await backfill(chain, "registration_files", "agentRegistrationFiles", FILE_FIELDS, (row) => upsertFile(row as FileRow))) +
    (await incremental(
      chain,
      "registration_files",
      `query ($ts: BigInt!) { agentRegistrationFiles(first: 1000, where: { createdAt_gt: $ts }, orderBy: createdAt, orderDirection: asc) { ${FILE_FIELDS} } }`,
      "agentRegistrationFiles",
      (row) => upsertFile(row as FileRow),
      (row) => (row as FileRow).createdAt,
    ));
  counts.feedback =
    (await backfill(chain, "feedback", "feedbacks", FEEDBACK_FIELDS, (row) => upsertFeedback(row as FeedbackRow))) +
    (await incremental(
      chain,
      "feedback",
      `query ($ts: BigInt!) { feedbacks(first: 1000, where: { createdAt_gt: $ts }, orderBy: createdAt, orderDirection: asc) { ${FEEDBACK_FIELDS} } }`,
      "feedbacks",
      (row) => upsertFeedback(row as FeedbackRow),
      (row) => (row as FeedbackRow).createdAt,
    ));
  counts.validations =
    (await backfill(chain, "validations", "validations", VALIDATION_FIELDS, (row) => upsertValidation(row as ValidationRow))) +
    (await incremental(
      chain,
      "validations",
      `query ($ts: BigInt!) { validations(first: 1000, where: { updatedAt_gt: $ts }, orderBy: updatedAt, orderDirection: asc) { ${VALIDATION_FIELDS} } }`,
      "validations",
      (row) => upsertValidation(row as ValidationRow),
      (row) => (row as ValidationRow).updatedAt ?? (row as ValidationRow).createdAt,
    ));
  return counts;
}

function startHealth(): void {
  const port = envInt("HEALTH_PORT", 42071);
  createServer((req, res) => {
    if (req.url?.startsWith("/health")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, paused: state.paused, lastPass: state.lastPass }));
      return;
    }
    res.statusCode = 404;
    res.end();
  }).listen(port, "127.0.0.1");
}

async function main(): Promise<void> {
  startHealth();
  const intervalMs = envInt("IMPORTER_INTERVAL_SEC", 300) * 1000;
  const chains = envList("SUBGRAPH_MIRROR_CHAINS");
  let failures = 0;
  for (;;) {
    try {
      await waitWhilePaused();
      const started = Date.now();
      const counts: Record<string, number> = {};
      for (const chain of chains) {
        const chainCounts = await syncChain(chain);
        for (const [key, value] of Object.entries(chainCounts)) {
          counts[`${chain}.${key}`] = value;
        }
      }
      const durationMs = Date.now() - started;
      state.lastPass = { at: new Date().toISOString(), durationMs, counts };
      log("info", "pass", { counts, durationMs });
      failures = 0;
      await sleep(intervalMs);
    } catch (error) {
      failures += 1;
      const delay = Math.min(300_000, 1000 * 2 ** Math.min(failures, 8));
      log("error", "pass failed", {
        error: error instanceof Error ? error.message : String(error),
        retryInMs: delay,
      });
      await sleep(delay);
    }
  }
}

main().catch((error: unknown) => {
  log("error", "importer crashed", { error: error instanceof Error ? error.message : String(error) });
  setTimeout(() => {
    main().catch(() => undefined);
  }, 5000);
});
