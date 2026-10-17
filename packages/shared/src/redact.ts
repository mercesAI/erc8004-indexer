/**
 * Strip credentials that show up inside error text before it is stored or shown.
 *
 * Two layers. By shape: a key as a path segment after /v2/ or /v3/ (Alchemy, Infura), The Graph's
 * /api/<key>/subgraphs, a key in a query string, and user:password@ in a connection string. By value:
 * every configured URL with a path or query (RPC_*, IPFS_GATEWAY, ...) is reduced to its origin, and
 * every configured value whose name says KEY, TOKEN, SECRET, or PASSWORD is replaced wherever it
 * appears, which covers providers that put the token in a bare path segment (QuickNode, Ankr).
 */
type Known = { urls: { full: string; origin: string }[]; values: string[] };

let known: Known | undefined;

function configured(): Known {
  if (known) return known;
  const urls: Known["urls"] = [];
  const values: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (value.includes("://")) {
      try {
        const url = new URL(value);
        if (url.pathname.length > 1 || url.search || url.username) urls.push({ full: value, origin: `${url.protocol}//${url.host}` });
      } catch {
        // Not a URL; nothing to learn from it.
      }
      continue;
    }
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name) && value.length >= 12 && !/^[a-z-]+$/.test(value)) values.push(value);
  }
  // Longest first, so a value that contains another is replaced whole.
  urls.sort((a, b) => b.full.length - a.full.length);
  values.sort((a, b) => b.length - a.length);
  known = { urls, values };
  return known;
}

/** Forget the cached configuration, for tests and after `reloadEnv()`. */
export function resetRedaction(): void {
  known = undefined;
}

export function redactSecrets(text: string): string {
  let out = text;
  const { urls, values } = configured();
  for (const url of urls) out = out.split(url.full).join(`${url.origin}/***`);
  for (const value of values) out = out.split(value).join("***");
  return out
    .replace(/\/v[0-9]\/[A-Za-z0-9_-]{8,}/g, "/v*/***")
    .replace(/\/api\/[A-Za-z0-9_-]{16,}\/subgraphs/g, "/api/***/subgraphs")
    .replace(/([?&][A-Za-z_]*(?:key|token|secret)[A-Za-z_]*=)[^&\s"']+/gi, "$1***")
    .replace(/\/\/([^/\s:@]+):([^@\s/]+)@/g, "//$1:***@");
}
