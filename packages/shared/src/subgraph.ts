import { getChain } from "./chains.js";
import { envString } from "./env.js";
import { log } from "./logger.js";

/** Sent to The Graph and 8004scan. Identifies this indexer honestly; both accept it. */
export const HTTP_USER_AGENT = "merces-erc8004-indexer/1.0 (+https://github.com/mercesAI/erc8004-indexer)";

const PAGE_FIELDS = new Set(["agents", "agentRegistrationFiles", "feedbacks", "validations"]);

export function subgraphUrl(chain: string): string {
  const spec = getChain(chain);
  const id = process.env[spec.subgraphEnvVar];
  if (!id) throw new Error(`No subgraph id in ${spec.subgraphEnvVar} for ${chain}`);
  const key = envString("GRAPH_API_KEY");
  return `https://gateway.thegraph.com/api/${key}/subgraphs/id/${id}`;
}

export function hasSubgraph(chain: string): boolean {
  try {
    const spec = getChain(chain);
    return Boolean(process.env[spec.subgraphEnvVar]);
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function subgraphQuery<T>(
  chain: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const url = subgraphUrl(chain);
  let delay = 500;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": HTTP_USER_AGENT,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`subgraph HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        data?: T;
        errors?: { message: string }[];
      };
      if (body.errors?.length) {
        throw new Error(body.errors.map((error) => error.message).join("; "));
      }
      if (!body.data) throw new Error("subgraph response had no data");
      return body.data;
    } catch (error) {
      lastError = error;
      log("warn", "subgraph request failed", {
        chain,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delay + Math.floor(Math.random() * 200));
      delay = Math.min(delay * 2, 15_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchIdPage<T extends { id: string }>(options: {
  chain: string;
  field: string;
  selection: string;
  lastId: string;
}): Promise<T[]> {
  if (!PAGE_FIELDS.has(options.field)) {
    throw new Error(`Refusing to paginate unknown subgraph field ${options.field}`);
  }
  const query = `query ($lastId: String!) {
    ${options.field}(first: 1000, where: { id_gt: $lastId }, orderBy: id, orderDirection: asc) {
      ${options.selection}
    }
  }`;
  const data = await subgraphQuery<Record<string, T[]>>(options.chain, query, {
    lastId: options.lastId,
  });
  return data[options.field] ?? [];
}
