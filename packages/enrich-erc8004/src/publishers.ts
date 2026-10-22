import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { findRepoRoot, getPool, log } from "@merces/shared";

/**
 * Publishers: the platform that registered an agent on someone's behalf. The rules are publishers.yaml
 * at the repo root. An agent is `verified` for a publisher only through something nobody else can
 * produce: a file on the publisher's own host that names this agent (registrations), a file on that
 * host that names the on-chain minter (owner_field), or a mint by one of the publisher's addresses
 * (minters). Everything else a registrant could copy, so it gives `claimed` at most.
 *
 * runPublishers() runs after every enrich pass: the first time, and whenever the rules change, over
 * every agent; otherwise over the agents the indexer or the fetcher touched since the previous run.
 */

export const PUBLISHERS_FILE = "publishers.yaml";

/** Bump when attribute() changes meaning, so the next run recomputes every agent. */
export const ATTRIBUTION_VERSION = 2;

export type Proof = "registrations" | "owner_field";

export type Claims = {
  description_prefix?: string[];
  name?: string[];
  name_prefix?: string[];
  trust?: string[];
  service_names?: string[];
  endpoint_hosts?: string[];
  image_hosts?: string[];
};

const CLAIM_FIELDS = ["description_prefix", "name", "name_prefix", "trust", "service_names", "endpoint_hosts", "image_hosts"] as const;

export type Publisher = {
  key: string;
  name: string;
  website?: string;
  kind?: string;
  hosts: string[];
  proof?: Proof;
  minters: string[];
  claims: Claims;
};

export type Attribution = {
  key: string;
  status: "verified" | "claimed";
  proof: "registrations" | "owner_field" | "minter" | "host" | "content";
};

function strings(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${where} must be a list of non-empty strings`);
  }
  return value as string[];
}

/** Parse and validate the rules file. Throws on the first problem, naming the publisher. */
export function parsePublishers(text: string): Publisher[] {
  const raw = parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${PUBLISHERS_FILE} must be a list of publishers`);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`publisher #${index + 1} is not a mapping`);
    const p = item as Record<string, unknown>;
    const key = typeof p.key === "string" ? p.key : "";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error(`publisher #${index + 1}: key must be lowercase letters, digits and dashes`);
    if (seen.has(key)) throw new Error(`publisher ${key} is listed twice`);
    seen.add(key);
    const where = `publisher ${key}`;
    if (typeof p.name !== "string" || p.name.length === 0) throw new Error(`${where}: name is required`);
    const hosts = strings(p.hosts, `${where}: hosts`).map((host) => host.toLowerCase());
    for (const host of hosts) {
      if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..") || host.startsWith(".")) throw new Error(`${where}: host ${host} must be a bare host name`);
    }
    const proof = p.proof;
    if (proof !== undefined && proof !== "registrations" && proof !== "owner_field") throw new Error(`${where}: proof must be registrations or owner_field`);
    if (proof !== undefined && hosts.length === 0) throw new Error(`${where}: proof needs hosts`);
    const minters = strings(p.minters, `${where}: minters`).map((address) => address.toLowerCase());
    for (const address of minters) if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${where}: minter ${address} is not an address`);
    const claimsRaw = p.claims ?? {};
    if (typeof claimsRaw !== "object" || Array.isArray(claimsRaw)) throw new Error(`${where}: claims must be a mapping`);
    const claims: Claims = {};
    for (const field of Object.keys(claimsRaw as Record<string, unknown>)) {
      if (!(CLAIM_FIELDS as readonly string[]).includes(field)) throw new Error(`${where}: unknown claim ${field}`);
    }
    for (const field of CLAIM_FIELDS) {
      const list = strings((claimsRaw as Record<string, unknown>)[field], `${where}: claims.${field}`);
      if (list.length > 0) claims[field] = field.endsWith("hosts") ? list.map((host) => host.toLowerCase()) : list;
    }
    if (hosts.length === 0 && minters.length === 0 && Object.keys(claims).length === 0) throw new Error(`${where}: needs hosts, minters, or claims`);
    const publisher: Publisher = { key, name: p.name, hosts, minters, claims };
    if (typeof p.website === "string" && p.website) publisher.website = p.website;
    if (typeof p.kind === "string" && p.kind) publisher.kind = p.kind;
    if (proof !== undefined) publisher.proof = proof;
    return publisher;
  });
}

/** The rules file, and a hash of what it means (not of its text, so a comment does not force a full run). */
export function loadPublishers(): { publishers: Publisher[]; hash: string } {
  const text = readFileSync(join(findRepoRoot(), PUBLISHERS_FILE), "utf8");
  const publishers = parsePublishers(text);
  const hash = createHash("sha256").update(String(ATTRIBUTION_VERSION)).update(JSON.stringify(publishers)).digest("hex");
  return { publishers, hash };
}

/** What the evaluation needs about one agent: chain row, and the fetched file when there is one. */
export type AgentRow = {
  chain_id: number;
  agent_id: string;
  agent_uri: string;
  owner: string;
  registered_by: string | null;
  registered_at: string | null;
  fetch_status: string | null;
  final_host: string | null;
  registrations: unknown;
  file_owner: string | null;
  name: string | null;
  description: string | null;
  image: string | null;
  supported_trust: string[] | null;
  services: unknown;
};

function hostOf(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * True when the file's `registrations` list names this agent: the same id, and not another chain. The
 * spec's form is `{ agentId, agentRegistry: "eip155:<chainId>:<address>" }`. The chain is checked when
 * it is there; the address is not, because some platforms put another address in it and there is one
 * registry per chain anyway. A copied pointer names someone else's id; a file reused on another chain
 * names that chain.
 */
export function namesAgent(registrations: unknown, chainId: number, agentId: string): boolean {
  if (!Array.isArray(registrations)) return false;
  return registrations.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    const id = typeof e.agentId === "number" || typeof e.agentId === "string" ? String(e.agentId).trim() : null;
    if (id === null || !/^\d+$/.test(id) || BigInt(id) !== BigInt(agentId)) return false;
    const where = typeof e.agentRegistry === "string" ? e.agentRegistry.trim().toLowerCase() : "";
    const chain = where.match(/^eip155:(\d+)(?::|$)/);
    return chain === null || chain[1] === String(chainId);
  });
}

function matchesClaims(row: AgentRow, claims: Claims): boolean {
  if (row.fetch_status !== "ok") return false;
  const lower = (value: string) => value.toLowerCase();
  const name = lower(row.name ?? "");
  const description = lower(row.description ?? "");
  if (claims.description_prefix?.some((prefix) => description.startsWith(lower(prefix)))) return true;
  if (claims.name?.some((value) => name === lower(value))) return true;
  if (claims.name_prefix?.some((prefix) => name.startsWith(lower(prefix)))) return true;
  if (claims.trust && row.supported_trust?.some((marker) => claims.trust?.some((want) => lower(want) === lower(marker)))) return true;
  if (claims.image_hosts?.includes(hostOf(row.image) ?? "")) return true;
  if ((claims.service_names || claims.endpoint_hosts) && Array.isArray(row.services)) {
    for (const service of row.services) {
      if (!service || typeof service !== "object") continue;
      const s = service as Record<string, unknown>;
      if (typeof s.name === "string" && claims.service_names?.some((want) => lower(want) === lower(s.name as string))) return true;
      if (typeof s.endpoint === "string" && claims.endpoint_hosts?.includes(hostOf(s.endpoint) ?? "")) return true;
    }
  }
  return false;
}

/**
 * The publisher of one agent, or null. Publishers are tried in file order; the first verified match
 * wins, then the first claimed one.
 *
 * A host match needs the file to have come from that host too (final_host, when known), so an open
 * redirect on the publisher's domain cannot lend its name to a file served elsewhere. The minter and
 * owner-field proofs use registered_by only: the current owner can be anyone an agent was gifted to.
 */
export function attribute(row: AgentRow, publishers: Publisher[]): Attribution | null {
  const uriHost = hostOf(row.agent_uri);
  const finalHost = row.final_host?.toLowerCase() ?? null;
  const minter = row.registered_by?.toLowerCase() ?? null;
  const fileOk = row.fetch_status === "ok";
  let claimed: Attribution | null = null;
  for (const p of publishers) {
    if (minter && p.minters.includes(minter)) return { key: p.key, status: "verified", proof: "minter" };
    const onHost = uriHost !== null && p.hosts.includes(uriHost);
    const served = onHost && fileOk && (finalHost === null || p.hosts.includes(finalHost));
    if (served && p.proof === "registrations" && namesAgent(row.registrations, row.chain_id, row.agent_id)) {
      return { key: p.key, status: "verified", proof: "registrations" };
    }
    if (served && p.proof === "owner_field" && minter && row.file_owner && row.file_owner.toLowerCase() === minter) {
      return { key: p.key, status: "verified", proof: "owner_field" };
    }
    if (!claimed && onHost) claimed = { key: p.key, status: "claimed", proof: "host" };
    if (!claimed && matchesClaims(row, p.claims)) claimed = { key: p.key, status: "claimed", proof: "content" };
  }
  return claimed;
}

/**
 * A good file on a publisher's host that does not prove its agent yet is fetched again later: some
 * platforms write the file before the chain has given the agent its id. True when such a re-fetch
 * could change the answer.
 */
export function wantsRefetch(row: AgentRow, result: Attribution | null, publishers: Map<string, Publisher>): boolean {
  if (!result || result.status !== "claimed" || result.proof !== "host" || row.fetch_status !== "ok") return false;
  const proof = publishers.get(result.key)?.proof;
  if (proof === "registrations") return true;
  return proof === "owner_field" && row.registered_by !== null;
}

const BATCH = 5000;

/** When a run would touch more than this share of all agents, one ordered scan beats a million lookups. */
const FULL_RUN_SHARE = 0.25;

const SELECT_COLUMNS = `
  a.chain_id, a.agent_id::text AS agent_id, a.agent_uri, a.owner, a.registered_by, a.registered_at::text AS registered_at,
  r.fetch_status, r.final_host, r.raw->'registrations' AS registrations, r.raw->>'owner' AS file_owner,
  r.name, r.description, r.image, r.supported_trust, r.raw->'services' AS services`;

/** One page of every agent, in primary-key order: the planner walks the index, nothing to misjudge. */
const ALL_AGENTS = `
  SELECT ${SELECT_COLUMNS}
  FROM erc8004.agents a
  LEFT JOIN enrich.registration_files r ON r.chain_id = a.chain_id AND r.agent_id = a.agent_id
  WHERE (a.chain_id, a.agent_id) > ($1::int, $2::numeric)
  ORDER BY a.chain_id, a.agent_id
  LIMIT ${BATCH}`;

/** Agents the indexer or the fetcher touched after an instant. Both halves are index scans. */
const TOUCHED = `
  SELECT chain_id, agent_id FROM erc8004.agents WHERE updated_at > $1
  UNION
  SELECT chain_id, agent_id FROM enrich.registration_files WHERE fetched_at > $1`;

const TOUCHED_COUNT = `SELECT count(*)::text AS n FROM (${TOUCHED}) t`;
const TOUCHED_KEYS = `SELECT chain_id, agent_id::text AS agent_id FROM (${TOUCHED}) t ORDER BY chain_id, agent_id`;

/** The rows for a list of keys: primary-key lookups, so a join against a changing set cannot go wrong. */
const AGENTS_BY_KEY = `
  SELECT ${SELECT_COLUMNS}
  FROM unnest($1::int[], $2::numeric[]) AS k(chain_id, agent_id)
  JOIN erc8004.agents a ON a.chain_id = k.chain_id AND a.agent_id = k.agent_id
  LEFT JOIN enrich.registration_files r ON r.chain_id = a.chain_id AND r.agent_id = a.agent_id`;

export const publisherState = {
  lastRun: null as string | null,
  full: false,
  scanned: 0,
  changed: 0,
  publishers: 0,
  error: null as string | null,
};

async function syncPublishers(publishers: Publisher[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const [index, p] of publishers.entries()) {
      await client.query(
        `INSERT INTO enrich.publishers (key, name, website, kind, position, rules, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET
           name = EXCLUDED.name, website = EXCLUDED.website, kind = EXCLUDED.kind, position = EXCLUDED.position,
           rules = EXCLUDED.rules, updated_at = now()`,
        [p.key, p.name, p.website ?? null, p.kind ?? null, index, JSON.stringify(p)],
      );
    }
    await client.query("DELETE FROM enrich.publishers WHERE key <> ALL($1::text[])", [publishers.map((p) => p.key)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type Upsert = { chain: number; agent: string; key: string; status: string; proof: string; registeredAt: string | null };
type Ref = { chain: number; agent: string };

/** Write one batch; returns how many agent_publishers rows changed. */
async function writeBatch(upserts: Upsert[], deletes: Ref[], refetch: Ref[]): Promise<number> {
  const pool = getPool();
  let changed = 0;
  if (upserts.length > 0) {
    const result = await pool.query(
      `INSERT INTO enrich.agent_publishers (chain_id, agent_id, publisher_key, status, proof, registered_at, updated_at)
       SELECT u.chain, u.agent, u.key, u.status, u.proof, to_timestamp(u.registered_at::double precision), now()
       FROM unnest($1::int[], $2::numeric[], $3::text[], $4::text[], $5::text[], $6::text[])
         AS u(chain, agent, key, status, proof, registered_at)
       ON CONFLICT (chain_id, agent_id) DO UPDATE SET
         publisher_key = EXCLUDED.publisher_key, status = EXCLUDED.status, proof = EXCLUDED.proof,
         registered_at = EXCLUDED.registered_at, updated_at = now()
       WHERE (enrich.agent_publishers.publisher_key, enrich.agent_publishers.status, enrich.agent_publishers.proof)
         IS DISTINCT FROM (EXCLUDED.publisher_key, EXCLUDED.status, EXCLUDED.proof)`,
      [
        upserts.map((u) => u.chain),
        upserts.map((u) => u.agent),
        upserts.map((u) => u.key),
        upserts.map((u) => u.status),
        upserts.map((u) => u.proof),
        upserts.map((u) => u.registeredAt),
      ],
    );
    changed += result.rowCount ?? 0;
  }
  if (deletes.length > 0) {
    const result = await pool.query(
      `DELETE FROM enrich.agent_publishers ap
       USING unnest($1::int[], $2::numeric[]) AS u(chain, agent)
       WHERE ap.chain_id = u.chain AND ap.agent_id = u.agent`,
      [deletes.map((d) => d.chain), deletes.map((d) => d.agent)],
    );
    changed += result.rowCount ?? 0;
  }
  if (refetch.length > 0) {
    // 1 hour after the fetch, then 6 hours, 1 day, 7 days; four re-fetches at most for one URI.
    await pool.query(
      `UPDATE enrich.registration_files r
       SET next_retry_at = GREATEST(now(), r.fetched_at + CASE r.refetches
         WHEN 0 THEN interval '1 hour' WHEN 1 THEN interval '6 hours' WHEN 2 THEN interval '1 day' ELSE interval '7 days' END)
       FROM unnest($1::int[], $2::numeric[]) AS u(chain, agent)
       WHERE r.chain_id = u.chain AND r.agent_id = u.agent
         AND r.fetch_status = 'ok' AND r.next_retry_at IS NULL AND r.refetches < 4`,
      [refetch.map((d) => d.chain), refetch.map((d) => d.agent)],
    );
  }
  return changed;
}

async function refreshCounts(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM enrich.publisher_counts");
    await client.query(
      `INSERT INTO enrich.publisher_counts
         (publisher_key, chain_id, verified, claimed, reviews, first_registered_at, last_registered_at)
       SELECT ap.publisher_key, ap.chain_id,
              count(*) FILTER (WHERE ap.status = 'verified'),
              count(*) FILTER (WHERE ap.status = 'claimed'),
              COALESCE(sum(a.feedback_count), 0),
              min(ap.registered_at), max(ap.registered_at)
       FROM enrich.agent_publishers ap
       JOIN erc8004.agents a ON a.chain_id = ap.chain_id AND a.agent_id = ap.agent_id
       GROUP BY ap.publisher_key, ap.chain_id`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Evaluate one page of agents and write what changed. */
async function processRows(rows: AgentRow[], publishers: Publisher[], byKey: Map<string, Publisher>): Promise<number> {
  const upserts: Upsert[] = [];
  const deletes: Ref[] = [];
  const refetch: Ref[] = [];
  for (const row of rows) {
    const found = attribute(row, publishers);
    if (found) upserts.push({ chain: row.chain_id, agent: row.agent_id, key: found.key, status: found.status, proof: found.proof, registeredAt: row.registered_at });
    else deletes.push({ chain: row.chain_id, agent: row.agent_id });
    if (wantsRefetch(row, found, byKey)) refetch.push({ chain: row.chain_id, agent: row.agent_id });
  }
  return writeBatch(upserts, deletes, refetch);
}

/**
 * Attribute agents to publishers. Every agent when the rules changed, nothing has run yet, or most
 * agents were touched since the previous run (a backfill); otherwise just the agents the indexer or
 * the fetcher touched since then. Refreshes the per-chain counts when anything changed.
 */
export async function runPublishers(): Promise<void> {
  const started = Date.now();
  const { publishers, hash } = loadPublishers();
  const pool = getPool();
  const previous = (await pool.query<{ rules_hash: string; ran_at: Date }>("SELECT rules_hash, ran_at FROM enrich.publisher_runs WHERE id = 1")).rows[0];
  const startedAt = (await pool.query<{ now: Date }>("SELECT now() AS now")).rows[0]?.now ?? new Date();
  let full = !previous || previous.rules_hash !== hash;
  let keys: Ref[] = [];
  if (!full && previous) {
    const touched = Number((await pool.query<{ n: string }>(TOUCHED_COUNT, [previous.ran_at])).rows[0]?.n ?? 0);
    const total = Number((await pool.query<{ n: string }>("SELECT reltuples::bigint::text AS n FROM pg_class WHERE oid = 'erc8004.agents'::regclass")).rows[0]?.n ?? 0);
    if (touched > FULL_RUN_SHARE * Math.max(total, 1)) full = true;
    else if (touched > 0) {
      const result = await pool.query<{ chain_id: number; agent_id: string }>(TOUCHED_KEYS, [previous.ran_at]);
      keys = result.rows.map((row) => ({ chain: row.chain_id, agent: row.agent_id }));
    }
  }
  if (full) await syncPublishers(publishers);
  const byKey = new Map(publishers.map((p) => [p.key, p]));
  let changed = 0;
  let scanned = 0;
  if (full) {
    let last: Ref = { chain: -1, agent: "-1" };
    for (;;) {
      const rows = (await pool.query<AgentRow>(ALL_AGENTS, [last.chain, last.agent])).rows;
      if (rows.length === 0) break;
      changed += await processRows(rows, publishers, byKey);
      scanned += rows.length;
      const tail = rows[rows.length - 1] as AgentRow;
      last = { chain: tail.chain_id, agent: tail.agent_id };
      if (rows.length < BATCH) break;
    }
  } else {
    for (let offset = 0; offset < keys.length; offset += BATCH) {
      const slice = keys.slice(offset, offset + BATCH);
      const rows = (await pool.query<AgentRow>(AGENTS_BY_KEY, [slice.map((k) => k.chain), slice.map((k) => k.agent)])).rows;
      changed += await processRows(rows, publishers, byKey);
      scanned += rows.length;
    }
  }
  if (full || changed > 0) await refreshCounts();
  await pool.query(
    `INSERT INTO enrich.publisher_runs (id, rules_hash, ran_at, full_run_at)
     VALUES (1, $1, $2::timestamptz, CASE WHEN $3::boolean THEN $2::timestamptz ELSE NULL END)
     ON CONFLICT (id) DO UPDATE SET
       rules_hash = EXCLUDED.rules_hash, ran_at = EXCLUDED.ran_at,
       full_run_at = COALESCE(EXCLUDED.full_run_at, enrich.publisher_runs.full_run_at)`,
    [hash, startedAt, full],
  );
  Object.assign(publisherState, { lastRun: new Date().toISOString(), full, scanned, changed, publishers: publishers.length, error: null });
  if (full || changed > 0) log("info", "publishers", { full, scanned, changed, durationMs: Date.now() - started });
}
