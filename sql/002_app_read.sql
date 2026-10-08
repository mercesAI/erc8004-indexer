-- The app role reads schema read and nothing else.
-- Views in read are created by the supervisor (packages/ops/src/schemas.ts).
-- This file is safe to re-run.

CREATE SCHEMA IF NOT EXISTS read;

GRANT USAGE ON SCHEMA read TO app_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA read TO app_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA read GRANT SELECT ON TABLES TO app_ro;

REVOKE ALL ON SCHEMA erc8004 FROM app_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA erc8004 FROM app_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA erc8004 REVOKE SELECT ON TABLES FROM app_ro;

REVOKE ALL ON SCHEMA enrich FROM app_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA enrich FROM app_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA enrich REVOKE SELECT ON TABLES FROM app_ro;

REVOKE ALL ON SCHEMA mirror FROM app_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA mirror FROM app_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA mirror REVOKE SELECT ON TABLES FROM app_ro;

REVOKE ALL ON SCHEMA ops FROM app_ro;

CREATE INDEX IF NOT EXISTS enrich_registration_name_lower
  ON enrich.registration_files (lower(name));

CREATE INDEX IF NOT EXISTS enrich_services_name
  ON enrich.agent_services (name);
