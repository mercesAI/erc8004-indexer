/** Strip credentials that show up inside error text before it is stored or shown. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\/v2\/[A-Za-z0-9_-]{8,}/g, "/v2/***")
    .replace(/\/api\/[A-Za-z0-9_-]{16,}\/subgraphs/g, "/api/***/subgraphs")
    .replace(/\/\/([^/\s:@]+):([^@\s/]+)@/g, "//$1:***@");
}
