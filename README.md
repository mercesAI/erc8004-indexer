# Merces data

Collectors for merces.ai. This repo writes protocol data to Postgres. The user-facing app is a different repo and connects with the read-only role `app_ro`. The first collector is ERC-8004 on Base. The layout leaves room for x402, MCP catalogs, and ERC-3643; only ERC-8004 is built.

There is no Docker and no Redis. Postgres is the local server in `DATABASE_URL`. `pnpm ops` starts one supervisor, which starts Ponder, the subgraph importer, and the enrichment worker.

Ponder 0.17 requires Node 22 or newer.

## Schemas

| Schema | Writer | Who reads it |
| --- | --- | --- |
| `read` | Views over the chain tables and enrich | The app, as `app_ro`. This is the only schema the app may use. See `docs/app-data-contract.md`. |
| `erc8004` | Views. Ponder writes `erc8004_<chain>` underneath | The supervisor. Not the app. |
| `enrich` | `enrich-erc8004` | The supervisor, and the `read` views. A Ponder re-index does not delete these rows. |
| `mirror` | `importer-subgraph` | Sanity checks. Not the app. It can be ahead of Ponder during a backfill. |
| `ops` | the supervisor | The dashboard. Not the app. |

## Setup

Create the role and database (the role needs `CREATEROLE` and must own the database):

```sql
CREATE ROLE merces LOGIN PASSWORD '...' CREATEROLE;
CREATE DATABASE merces_data OWNER merces;
```

Copy `.env.example` to `.env` and fill in Alchemy, The Graph, and `DATABASE_URL`. Set `APP_RO_PASSWORD`.

```bash
pnpm install
pnpm db:init
pnpm block-at --chain base --days-ago 14
```

Paste the printed block into `START_BLOCK_BASE`. That is the chunk, not the Identity deploy block. Deploy blocks are in `packages/shared/src/chains.ts` (Base is 41663783).

Alchemy's free plan only serves `eth_getLogs` for 10 blocks at a time (`ETH_GET_LOGS_BLOCK_RANGE`). A 14-day Base chunk is about 600,000 blocks, which takes hours on that plan. For a first run that finishes in minutes, set `START_BLOCK_BASE` about 15,000 blocks behind the head (`pnpm block-at --chain base --days-ago 0` and subtract, or use a smaller `--days-ago`). Raise `ETH_GET_LOGS_BLOCK_RANGE` and `ALCHEMY_MAX_RPS` when the RPC plan allows larger ranges.

```bash
pnpm ops
```

The dashboard is at `http://localhost:42070` (basic auth from `OPS_USER` / `OPS_PASSWORD`). Ponder's GraphQL is at `http://localhost:42069/graphql`.

The app repo should use:

```text
postgres://app_ro:<APP_RO_PASSWORD>@localhost:5433/merces_data
```

## What `pnpm ops` runs

The supervisor starts:

- Ponder (`ponder start`, one process per chain)
- the Agent0 importer
- the registration-file enricher

Stop halts a process. Start resumes it from its checkpoint. Each chain is indexed into its own schema (`erc8004_base`, `erc8004_bnb`, …). Adding a chain does not erase the others. Changing `START_BLOCK` or the indexing code does not erase anything either. Ponder refuses to start that chain until you rebuild it on purpose:

```bash
pnpm reset:ponder --chain base
pnpm reset:ponder --all
```

Pause on the Workers page sleeps the importer or enrich loop without killing the process.

## Add a chain

```text
CHAINS=base,ethereum
START_BLOCK_ETHEREUM=<block from pnpm block-at --chain ethereum --days-ago 14>
```

Restart Ponder from the dashboard. Subgraph mirror chains are separate: `SUBGRAPH_MIRROR_CHAINS=base,ethereum` and `SUBGRAPH_ID_ETHEREUM`.

## Full history

Set `START_BLOCK_<CHAIN>` to the Identity deploy block from `chains.ts`. Restarting Ponder keeps the existing rows and blocks that chain until you run `pnpm reset:ponder --chain <key>`. `enrich` and `mirror` stay either way.

## Scripts

- `pnpm db:init` applies `sql/001_schemas_roles.sql` and `sql/002_app_read.sql`, then refreshes `read`
- `pnpm block-at --chain <key> --days-ago <n>` prints a block number
- `pnpm ops` starts the supervisor and dashboard
- `pnpm ops:build` typechecks packages and builds the dashboard
- `pnpm sanity` prints a sanity report and exits non-zero on any fail
- `pnpm verify:read` checks that `app_ro` can read `read` and cannot read the collector schemas
- `pnpm reset:ponder --chain <key>` drops that chain's schema after you type `yes`
- `pnpm reset:ponder --all` drops every chain schema after you type `yes`

## Production

On a VDS, a systemd unit runs `pnpm ops` with `NODE_ENV=production`. Reach the dashboard through an SSH tunnel (`ssh -L 42070:127.0.0.1:42070`). Nightly, dump the schemas a re-index cannot rebuild:

```ini
[Service]
WorkingDirectory=/opt/merces-data
Environment=NODE_ENV=production
ExecStart=/usr/bin/pnpm ops
Restart=on-failure
```

```bash
pg_dump "$DATABASE_URL" -n enrich -n mirror -Fc -f /var/backups/merces-enrich-mirror.dump
```

## Sanity

`pnpm sanity`, the Sanity page, and a run every 6 hours sample agents and feedback from Postgres and compare them with Alchemy (at the indexed block), the Agent0 subgraph, and 8004scan. Chain mismatches fail. Subgraph feedback counts warn when the agent was registered before `START_BLOCK`. 8004scan and the count comparison are warnings.
