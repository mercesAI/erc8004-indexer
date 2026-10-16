# Deploying the merces data collectors

This repo is one Node supervisor (`pnpm start`) plus Postgres. There is no Docker and no Redis. The dashboard stays on localhost. Reach it through an SSH tunnel.

## What it costs to run

**RPC.** The indexer polls each chain every 5 minutes (Monad every hour) with one `eth_blockNumber` and one `eth_getLogs` per 2,000 new blocks. It never downloads blocks. With five chains that is a few million Alchemy compute units a month, a few dollars on pay-as-you-go. A full history for a new chain, or a re-read of an old one, is one `eth_getLogs` per 2,000 blocks: about 5,500 calls for Base, about 24,000 for BNB. The README's "RPC cost" section has the table.

The free Alchemy plan rejects `eth_getLogs` wider than 10 blocks. The indexer halves a rejected range until it fits, so it still works there, but every range then costs 200 calls instead of one. Use a paid plan with `ETH_GET_LOGS_BLOCK_RANGE=2000`, and set a monthly usage limit in Alchemy's billing settings so a mistake cannot run up a bill.

Enrichment (registration files over HTTPS and IPFS) does not use Alchemy. IPFS gateway slowness is its limit, and it retries on its own. The subgraph importer is off unless `SUBGRAPH_MIRROR_CHAINS` is set; it uses The Graph, not Alchemy.

**Machine.** CPU and RAM needs are small. Disk is the database: about 3 GB for five chains in October 2026, growing by roughly 1 GB a month at that month's event rate. A 2 vCPU, 4 GB RAM, 40 GB SSD host is enough to start.

## Host layout

```text
VPS
  PostgreSQL 16+     merces_data, role merces (CREATEROLE, owner)
  Node 22 + pnpm     /opt/merces-data
  systemd            NODE_ENV=production  pnpm start
  listeners          127.0.0.1:42070  ops dashboard
                     127.0.0.1:42071  importer health (only when enabled)
                     127.0.0.1:42072  enrich health
                     127.0.0.1:42073  indexer health
```

Do not publish those ports. The dashboard has no login. It only listens on localhost, and its Stop and Restart buttons require a header a normal browser page on another site cannot send.

The user-facing app is a different repo. It connects as `app_ro` and may `SELECT` from schema `read` only. The contract is `docs/app-data-contract.md`.

## One-time setup

```bash
# packages
sudo apt update
sudo apt install -y postgresql postgresql-contrib git curl
# Node 22 from NodeSource or your preferred installer, then:
corepack enable
corepack prepare pnpm@10.18.0 --activate

sudo -u postgres psql <<'SQL'
CREATE ROLE merces LOGIN PASSWORD 'replace-me' CREATEROLE;
CREATE DATABASE merces_data OWNER merces;
SQL

sudo useradd --system --create-home --shell /usr/sbin/nologin merces || true
sudo git clone https://github.com/0xVitalii/merces-data.git /opt/merces-data
sudo chown -R merces:merces /opt/merces-data
cd /opt/merces-data
sudo -u merces cp .env.example .env
```

Fill `.env` on the server. Minimum:

```text
DATABASE_URL=postgres://merces:...@127.0.0.1:5432/merces_data
APP_RO_PASSWORD=...
ALCHEMY_API_KEY=...
CHAINS=base,bnb,ethereum,polygon,monad
START_BLOCK_BASE=41663783          # deploy blocks are in packages/shared/src/chains.ts
INDEX_INTERVAL_SEC=300
INDEX_INTERVAL_SEC_MONAD=3600
ETH_GET_LOGS_BLOCK_RANGE=2000
ALCHEMY_MAX_RPS=20
OPS_PORT=42070
IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/
```

Registry addresses and RPC URLs are already in `.env.example`. RPC URLs may use `${ALCHEMY_API_KEY}`; the process expands that.

```bash
sudo -u merces corepack enable
sudo -u merces corepack prepare pnpm@10.18.0 --activate
sudo -u merces pnpm install --frozen-lockfile
sudo -u merces pnpm db:init
sudo -u merces pnpm ops:build
```

`pnpm db:init` creates the schemas, the chain tables, and the `app_ro` role. Confirm the read-only login before pointing the app at it:

```text
postgres://app_ro:<APP_RO_PASSWORD>@127.0.0.1:5432/merces_data
```

If the app runs on another machine, allow that host in `pg_hba.conf` for `app_ro` only, require TLS, and do not open the ops ports.

## Process manager

`/etc/systemd/system/merces-data.service`:

```ini
[Unit]
Description=Merces data collectors
After=network.target postgresql.service

[Service]
Type=simple
User=merces
WorkingDirectory=/opt/merces-data
Environment=NODE_ENV=production
Environment=PATH=/usr/bin:/usr/local/bin
ExecStart=/usr/bin/pnpm start
Restart=on-failure
RestartSec=5
# How long systemd waits for the process to exit after stop. Not an RPC retry.
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now merces-data
sudo journalctl -u merces-data -f
```

`pnpm start` runs the supervisor without rebuilding the dashboard. `pnpm ops` is the local command: it builds the UI, then starts the same supervisor. A restart resumes every chain from `erc8004.cursors`. Adding a chain to `CHAINS` starts it at its `START_BLOCK`; the other chains are not touched. Changing `START_BLOCK` for a chain that already has a cursor changes nothing; `pnpm reindex --chain <key>` re-reads it.

## Dashboard

From a laptop:

```bash
ssh -L 42070:127.0.0.1:42070 user@your-vps
```

Open `http://127.0.0.1:42070`. There is no login prompt.

A new chain shows "backfill" until it reaches the head, then "live". Lag on a live chain is the confirmation window plus up to one interval of blocks; it never reaches zero.

## Backups

Everything worth keeping is small now, so back up the whole database:

```bash
pg_dump "$DATABASE_URL" -Fc -f /var/backups/merces-data-$(date +%F).dump
find /var/backups -name 'merces-data-*.dump' -mtime +14 -delete
```

Put that in cron. The `erc8004` tables can be rebuilt from the RPC for a few dollars with `pnpm reindex`; `enrich` would take days of HTTP fetching to rebuild, which is the main reason for the backup. Restoring:

```bash
pg_restore -d merces_data --clean --if-exists /var/backups/merces-data-YYYY-MM-DD.dump
```

Also keep a copy of `.env`. It is not in git.

## Moving a local database to the server

1. Stop `pnpm ops` on the local machine.
2. If the local database is still from the Ponder version, run `pnpm migrate:ponder`, check it, then `pnpm cleanup:ponder`. That drops about 9 GB you would otherwise copy.
3. Dump the whole database: `pg_dump "$DATABASE_URL" -Fc -f merces_data.dump`.
4. Restore it into the empty server database, then run `pnpm db:init` there (it is safe to re-run).
5. Start systemd on the server. Every chain resumes from its cursor.

If you would rather start clean on the server, skip the dump and let the indexer read full history; that is cheap. You will lose the local `enrich` rows unless you dump at least `-n enrich`.

## Sanity check after deploy

```bash
cd /opt/merces-data
pnpm sanity
```

Exit code 0 means no failed comparisons against Alchemy at the indexed block. Warnings against 8004scan and against feedback counts for agents registered before `START_BLOCK` are expected. The supervisor already runs the same check every 6 hours and stores it in `ops.sanity_runs` for the Sanity page. The cron line below only adds an exit-code alert:

```text
0 4 * * * cd /opt/merces-data && /usr/bin/pnpm sanity >> /var/log/merces-sanity.log 2>&1
```
