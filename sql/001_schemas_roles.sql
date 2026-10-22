-- Schemas and the read-only role for the app repo.
-- Ownership: erc8004 is created here so grants exist before Ponder, but only Ponder writes it.
-- mirror: importer-subgraph. enrich: enrich-erc8004. ops: the supervisor.
-- app_ro starts with these grants. sql/002_app_read.sql revokes them.
-- After both files, app_ro can SELECT schema read only. It cannot read ops.
-- db:init replaces __APP_RO_PASSWORD__ with a SCRAM-SHA-256 verifier of APP_RO_PASSWORD before applying this file.

CREATE SCHEMA IF NOT EXISTS erc8004;
CREATE SCHEMA IF NOT EXISTS mirror;
CREATE SCHEMA IF NOT EXISTS enrich;
CREATE SCHEMA IF NOT EXISTS ops;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN
    CREATE ROLE app_ro LOGIN PASSWORD '__APP_RO_PASSWORD__';
  ELSE
    ALTER ROLE app_ro WITH LOGIN PASSWORD '__APP_RO_PASSWORD__';
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_ro', current_database());
END
$$;

GRANT USAGE ON SCHEMA erc8004, enrich, mirror TO app_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA erc8004 TO app_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA enrich TO app_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA mirror TO app_ro;

ALTER DEFAULT PRIVILEGES IN SCHEMA erc8004 GRANT SELECT ON TABLES TO app_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA enrich GRANT SELECT ON TABLES TO app_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA mirror GRANT SELECT ON TABLES TO app_ro;

REVOKE ALL ON SCHEMA ops FROM app_ro;

-- Importer mirror. Full subgraph entity lives in raw; columns are what sanity compares.

CREATE TABLE IF NOT EXISTS mirror.cursors (
  chain text NOT NULL,
  entity text NOT NULL,
  cursor text NOT NULL DEFAULT '',
  mode text NOT NULL DEFAULT 'backfill',
  watermark text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, entity)
);

CREATE TABLE IF NOT EXISTS mirror.agents (
  id text PRIMARY KEY,
  chain_id numeric,
  agent_id numeric,
  owner text,
  agent_uri text,
  created_at numeric,
  total_feedback numeric,
  name text,
  mcp_endpoint text,
  a2a_endpoint text,
  raw jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS mirror_agents_chain_created
  ON mirror.agents (chain_id, created_at);

CREATE TABLE IF NOT EXISTS mirror.registration_files (
  id text PRIMARY KEY,
  agent_ref text,
  chain_id numeric,
  agent_id numeric,
  name text,
  mcp_endpoint text,
  a2a_endpoint text,
  raw jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS mirror_registration_agent_ref
  ON mirror.registration_files (agent_ref);

CREATE TABLE IF NOT EXISTS mirror.feedback (
  id text PRIMARY KEY,
  chain_id numeric,
  agent_id numeric,
  client_address text,
  value text,
  tag1 text,
  tag2 text,
  is_revoked boolean,
  created_at numeric,
  raw jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS mirror_feedback_chain_agent
  ON mirror.feedback (chain_id, agent_id);

CREATE TABLE IF NOT EXISTS mirror.validations (
  id text PRIMARY KEY,
  chain_id numeric,
  agent_id numeric,
  validator_address text,
  response integer,
  status text,
  raw jsonb NOT NULL
);

-- Enrichment. Keyed by agent so a Ponder rebuild does not wipe HTTP results.
-- attempts is the retry counter for the 1h, 6h, 1d, 7d schedule.

CREATE TABLE IF NOT EXISTS enrich.registration_files (
  chain_id integer NOT NULL,
  agent_id numeric NOT NULL,
  agent_uri text NOT NULL,
  content_hash text,
  raw jsonb,
  name text,
  description text,
  image text,
  active boolean,
  x402_support boolean,
  supported_trust text[],
  fetch_status text NOT NULL,
  http_status integer,
  error text,
  fetched_at timestamptz,
  next_retry_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, agent_id)
);

CREATE INDEX IF NOT EXISTS enrich_registration_retry
  ON enrich.registration_files (fetch_status, next_retry_at);

CREATE TABLE IF NOT EXISTS enrich.agent_services (
  chain_id integer NOT NULL,
  agent_id numeric NOT NULL,
  name text NOT NULL,
  endpoint text NOT NULL DEFAULT '',
  version text,
  extra jsonb,
  PRIMARY KEY (chain_id, agent_id, name, endpoint)
);

-- final_host is where the file actually came from after redirects. refetches counts fetches of an
-- unchanged URI after its first success; the publisher job schedules one while a file on a
-- publisher's host does not yet prove its agent. next_retry_at on an 'ok' row is such a re-fetch.
ALTER TABLE enrich.registration_files ADD COLUMN IF NOT EXISTS final_host text;
ALTER TABLE enrich.registration_files ADD COLUMN IF NOT EXISTS refetches integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS enrich_registration_due
  ON enrich.registration_files (next_retry_at) WHERE next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS enrich_registration_fetched_at
  ON enrich.registration_files (fetched_at);

-- Publishers: the platform that registered an agent on someone's behalf. The rules are publishers.yaml
-- at the repo root; packages/enrich-erc8004/src/publishers.ts evaluates them and writes these tables.

CREATE TABLE IF NOT EXISTS enrich.publishers (
  key text PRIMARY KEY,
  name text NOT NULL,
  website text,
  kind text,
  position integer NOT NULL,
  rules jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per agent that matched a publisher. status is 'verified' or 'claimed'; proof names the rule
-- (registrations, owner_field, minter, host, content). registered_at is copied from the agent so the
-- list index below serves "newest agents of one publisher on one chain".
CREATE TABLE IF NOT EXISTS enrich.agent_publishers (
  chain_id integer NOT NULL,
  agent_id numeric NOT NULL,
  publisher_key text NOT NULL,
  status text NOT NULL,
  proof text NOT NULL,
  registered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, agent_id)
);

CREATE INDEX IF NOT EXISTS agent_publishers_list
  ON enrich.agent_publishers (publisher_key, chain_id, registered_at DESC);

CREATE TABLE IF NOT EXISTS enrich.publisher_counts (
  publisher_key text NOT NULL,
  chain_id integer NOT NULL,
  verified integer NOT NULL,
  claimed integer NOT NULL,
  reviews bigint NOT NULL,
  first_registered_at timestamptz,
  last_registered_at timestamptz,
  PRIMARY KEY (publisher_key, chain_id)
);

CREATE TABLE IF NOT EXISTS enrich.publisher_runs (
  id integer PRIMARY KEY,
  rules_hash text NOT NULL,
  ran_at timestamptz NOT NULL,
  full_run_at timestamptz
);

-- Ops control plane.

CREATE TABLE IF NOT EXISTS ops.worker_control (
  worker text PRIMARY KEY,
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.worker_control (worker)
VALUES ('importer'), ('enrich')
ON CONFLICT (worker) DO NOTHING;

CREATE TABLE IF NOT EXISTS ops.jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_jobs_pending
  ON ops.jobs (status, id);

CREATE TABLE IF NOT EXISTS ops.logs (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  process text NOT NULL,
  level text NOT NULL,
  line text NOT NULL
);

CREATE INDEX IF NOT EXISTS ops_logs_ts ON ops.logs (ts);
CREATE INDEX IF NOT EXISTS ops_logs_process ON ops.logs (process, id DESC);

CREATE TABLE IF NOT EXISTS ops.metrics_snapshots (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS ops_metrics_ts ON ops.metrics_snapshots (ts);

CREATE TABLE IF NOT EXISTS ops.sanity_runs (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  pass integer NOT NULL,
  warn integer NOT NULL,
  fail integer NOT NULL,
  result jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS ops_sanity_ts ON ops.sanity_runs (ts DESC);
