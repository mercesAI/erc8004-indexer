/**
 * STUB: endpoint probing is not part of enrich v1.
 * A later version will dial MCP and A2A endpoints stored in enrich.agent_services
 * and record reachability. The fetch loop must not call this.
 */
export function probeEndpoints(): void {
  return;
}
