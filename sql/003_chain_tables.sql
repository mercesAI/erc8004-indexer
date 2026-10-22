-- Chain tables written by packages/indexer-erc8004. One table per entity, every chain in it.
-- Column names and types match what Ponder wrote, so the `read` views and the app contract are unchanged.
-- Timestamps are Unix seconds. Addresses and hashes are lowercase 0x text.
-- This file is safe to re-run. scripts/db-init.ts refuses to run it while erc8004.agents is still
-- the old Ponder union view; run `pnpm migrate:ponder` once first.

CREATE SCHEMA IF NOT EXISTS erc8004;

CREATE TABLE IF NOT EXISTS erc8004.agents (
  chain_id integer NOT NULL,
  agent_id numeric(78,0) NOT NULL,
  owner text NOT NULL,
  agent_uri text NOT NULL,
  agent_wallet text,
  -- The address register() was called from: the minter, from the Registered event. Transfers change
  -- owner but never this, so publisher rules that name a minting contract cannot be fooled by a gift.
  registered_by text,
  registered_block numeric(78,0),
  registered_at numeric(78,0),
  last_transfer_at numeric(78,0),
  uri_updated_at numeric(78,0),
  -- Non-revoked feedback only. Recomputed from erc8004.feedback for every agent a batch touches.
  feedback_count integer NOT NULL DEFAULT 0,
  last_feedback_at numeric(78,0),
  PRIMARY KEY (chain_id, agent_id)
);

-- When this row was last written by the indexer (database time, not chain time). The enrich worker
-- uses it to find agents whose URI may have changed without scanning the whole table.
ALTER TABLE erc8004.agents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE erc8004.agents ADD COLUMN IF NOT EXISTS registered_by text;

CREATE INDEX IF NOT EXISTS agents_owner ON erc8004.agents (owner);
CREATE INDEX IF NOT EXISTS agents_updated_at ON erc8004.agents (updated_at);
-- Serves the app's newest-first list: read.agents orders by read.unix_seconds(registered_at), which the planner
-- inlines to exactly this expression.
DROP INDEX IF EXISTS erc8004.agents_chain_registered;
CREATE INDEX IF NOT EXISTS agents_chain_registered_at
  ON erc8004.agents (chain_id, to_timestamp(registered_at::double precision) DESC, agent_id DESC);

CREATE TABLE IF NOT EXISTS erc8004.agent_metadata (
  chain_id integer NOT NULL,
  agent_id numeric(78,0) NOT NULL,
  key text NOT NULL,
  -- The raw on-chain bytes.
  value bytea NOT NULL,
  updated_at numeric(78,0) NOT NULL,
  PRIMARY KEY (chain_id, agent_id, key)
);

CREATE TABLE IF NOT EXISTS erc8004.feedback (
  chain_id integer NOT NULL,
  agent_id numeric(78,0) NOT NULL,
  client_address text NOT NULL,
  feedback_index numeric(78,0) NOT NULL,
  value numeric(78,0) NOT NULL,
  value_decimals integer NOT NULL,
  value_norm double precision NOT NULL,
  tag1 text NOT NULL,
  tag2 text NOT NULL,
  endpoint text NOT NULL,
  feedback_uri text NOT NULL,
  feedback_hash text NOT NULL,
  is_revoked boolean NOT NULL,
  block_number numeric(78,0) NOT NULL,
  block_time numeric(78,0) NOT NULL,
  tx_hash text NOT NULL,
  PRIMARY KEY (chain_id, agent_id, client_address, feedback_index)
);

CREATE INDEX IF NOT EXISTS feedback_client ON erc8004.feedback (client_address);
CREATE INDEX IF NOT EXISTS feedback_chain_time ON erc8004.feedback (chain_id, block_time DESC);

CREATE TABLE IF NOT EXISTS erc8004.feedback_responses (
  chain_id integer NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  agent_id numeric(78,0) NOT NULL,
  client_address text NOT NULL,
  feedback_index numeric(78,0) NOT NULL,
  responder text NOT NULL,
  response_uri text NOT NULL,
  response_hash text NOT NULL,
  block_time numeric(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS feedback_responses_review
  ON erc8004.feedback_responses (chain_id, agent_id, client_address, feedback_index);

CREATE TABLE IF NOT EXISTS erc8004.validations (
  chain_id integer NOT NULL,
  request_hash text NOT NULL,
  validator_address text NOT NULL,
  agent_id numeric(78,0) NOT NULL,
  request_uri text,
  response integer,
  response_uri text,
  response_hash text,
  tag text,
  status text NOT NULL CHECK (status IN ('pending', 'completed')),
  requested_at numeric(78,0),
  last_update numeric(78,0) NOT NULL,
  PRIMARY KEY (chain_id, request_hash)
);

-- Rolling 7-day log of handled events, for the dashboard and for debugging. Not a source of truth:
-- a re-index fetches logs from the RPC again, which is cheap (one eth_getLogs per 2,000 blocks).
CREATE TABLE IF NOT EXISTS erc8004.events (
  chain_id integer NOT NULL,
  block_number bigint NOT NULL,
  log_index integer NOT NULL,
  tx_hash text NOT NULL,
  block_time bigint NOT NULL,
  event_name text NOT NULL,
  args jsonb NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS events_time ON erc8004.events (block_time DESC);

-- One row per chain. last_block is the newest block whose logs are fully applied.
CREATE TABLE IF NOT EXISTS erc8004.cursors (
  chain text PRIMARY KEY,
  chain_id integer NOT NULL,
  start_block bigint NOT NULL,
  last_block bigint NOT NULL,
  head_block bigint,
  last_run_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.worker_control (worker)
VALUES ('indexer')
ON CONFLICT (worker) DO NOTHING;

-- Adding updated_at stamps every existing row at once, which autovacuum does not count as a change.
-- Fresh statistics let the enrich worker's selection use the new index right away.
ANALYZE erc8004.agents;
