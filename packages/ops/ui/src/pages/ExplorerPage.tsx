import { useEffect, useState, type ReactNode } from "react";
import { LongText } from "../LongText";
import { api } from "../api";

type Agent = {
  chain_id: number;
  agent_id: string;
  owner: string;
  agent_uri: string;
  name: string | null;
  feedback_count: number;
  explorer: string | null;
  scan: string;
};

type Page = { items: Agent[]; total: number; limit: number; offset: number };

type Feedback = {
  client_address: string;
  feedback_index: string;
  value: string;
  tag1: string;
  is_revoked: boolean;
  tx_hash: string;
};

export function ExplorerPage() {
  const [chain, setChain] = useState("base");
  const [chains, setChains] = useState<{ key: string; label: string; chainId: number }[]>([]);

  useEffect(() => {
    api<{ key: string; label: string; chainId: number }[]>("/api/chains")
      .then((list) => {
        setChains(list);
        if (list.length > 0 && !list.some((item) => item.key === chain)) setChain(list[0]?.key ?? "base");
      })
      .catch(() => undefined);
  }, []);
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [refetchId, setRefetchId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function search(nextOffset = offset) {
    try {
      setPage(await api<Page>(`/api/explorer/agents?chain=${encodeURIComponent(chain)}&q=${encodeURIComponent(q)}&offset=${nextOffset}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void search(offset);
  }, [chain, offset]);

  async function open(agent: Agent) {
    setSelected(agent);
    setFeedback(await api<Feedback[]>(`/api/explorer/feedback?chainId=${agent.chain_id}&agentId=${agent.agent_id}`));
  }

  async function refetch(event: { preventDefault: () => void }) {
    event.preventDefault();
    await api("/api/jobs/refetch", {
      method: "POST",
      body: JSON.stringify({
        chainId: selected?.chain_id ?? chains.find((item) => item.key === chain)?.chainId,
        agentId: refetchId || selected?.agent_id,
      }),
    });
  }

  const total = page?.total ?? 0;
  const limit = page?.limit ?? 25;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Explorer</h1>
      <p className="muted text-sm">Internal lookup for agents and feedback. This is not the public product.</p>
      {error && <p className="fail">{error}</p>}
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setOffset(0); void search(0); }}>
        <label>
          Chain
          <select className="btn ml-2" value={chain} onChange={(event) => { setChain(event.target.value); setOffset(0); }}>
            {(chains.length > 0 ? chains : [{ key: "base", label: "Base (8453)", chainId: 8453 }]).map((item) => (
              <option key={item.key} value={item.key}>{item.label}</option>
            ))}
          </select>
        </label>
        <input className="btn min-w-80" aria-label="Search agents" value={q} onChange={(event) => setQ(event.target.value)} placeholder="agent id, owner, or name" />
        <button className="btn" type="submit">Search</button>
      </form>
      <section className="card overflow-auto">
        <table>
          <thead><tr><th>Id</th><th>Name</th><th>Owner</th><th>Feedback</th><th>Links</th></tr></thead>
          <tbody>
            {page?.items.map((agent) => (
              <tr key={agent.agent_id}>
                <td><button className="btn" type="button" onClick={() => void open(agent)}>{agent.agent_id}</button></td>
                <td className="wrap">{agent.name}</td>
                <td className="mono">{agent.owner}</td>
                <td>{agent.feedback_count}</td>
                <td className="flex gap-2">
                  {agent.explorer && <IconLink href={agent.explorer} label="Block explorer"><ExplorerIcon /></IconLink>}
                  <IconLink href={agent.scan} label="8004scan"><ScanIcon /></IconLink>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex items-center gap-3 text-sm">
          <span className="muted">{from}–{to} of {total}</span>
          <button className="btn" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button>
          <button className="btn" type="button" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>Next</button>
        </div>
      </section>
      {selected && (
        <section className="card">
          <h2 className="font-medium">Agent {selected.agent_id}</h2>
          <p className="mono text-sm"><LongText text={selected.agent_uri || "(empty URI)"} max={140} /></p>
          <form className="mt-2 flex gap-2" onSubmit={(event) => void refetch(event)}>
            <input className="btn" aria-label="Agent id to refetch" value={refetchId} onChange={(event) => setRefetchId(event.target.value)} placeholder={selected.agent_id} />
            <button className="btn" type="submit">Refetch registration</button>
          </form>
          <table className="mt-3">
            <thead><tr><th>Client</th><th>Index</th><th>Value</th><th>Tag</th><th>Revoked</th><th>Tx</th></tr></thead>
            <tbody>
              {feedback.map((row) => (
                <tr key={`${row.client_address}:${row.feedback_index}`}>
                  <td className="mono">{row.client_address}</td>
                  <td>{row.feedback_index}</td>
                  <td>{row.value}</td>
                  <td>{row.tag1}</td>
                  <td>{String(row.is_revoked)}</td>
                  <td className="mono">{row.tx_hash.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function IconLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a className="inline-flex rounded-md border border-[var(--line)] p-1" href={href} target="_blank" rel="noreferrer" aria-label={label} title={label}>
      {children}
    </a>
  );
}

function ExplorerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2.5 L9.2 8 L8 7.2 L6.8 8 Z" fill="currentColor" />
    </svg>
  );
}

function ScanIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 12.5h5M11.5 10v5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
