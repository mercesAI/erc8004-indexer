# Deploying the merces data collectors

This repo is one Node supervisor (`pnpm ops`) plus Postgres. There is no Docker and no Redis. The dashboard stays on localhost. Reach it through an SSH tunnel.

## What “everything” costs

Two different jobs:

| Job | What it is | Where it stands |
| --- | --- | --- |
| Live tail | Index from `START_BLOCK_*` to the chain head, then follow new blocks | Base and Polygon are at the head. BNB is still backfilling. |
| Full on-chain history | `START_BLOCK_*` is the Identity deploy block | Already how these chains were started. Changing that value later does not rebuild anything. |

The Agent0 mirror is separate from Ponder. On Base it has already walked full history (agents and feedback) and is in incremental mode. A Ponder rebuild does not delete `mirror` or `enrich`.

### The bottleneck is Alchemy, not the machine

The free Alchemy plan rejects `eth_getLogs` wider than 10 blocks and throttles compute units per second. Ponder has to read three registries (identity, reputation, validation), so a full Base backfill is on the order of:

- about 10.5 million blocks / 10 × 3 contracts ≈ 3.2 million RPC calls
- at `ALCHEMY_MAX_RPS=8`, that is roughly 4 to 5 days of continuous RPC, before retries

A paid Alchemy plan that allows ranges of a few thousand blocks changes the same backfill to tens of thousands of calls. At that point it is hours, and the limit becomes disk and Postgres, not the CPU. Set:

```text
ETH_GET_LOGS_BLOCK_RANGE=2000
ALCHEMY_MAX_RPS=20
```

only after a test `eth_getLogs` of that width succeeds. Leave the free-tier values (`10` and `8`) until then.

Enrichment (registration files over HTTPS and IPFS) and the subgraph mirror do not use Alchemy. They are fine on the free plan. IPFS gateway slowness is the enrich limit, and it retries on its own.

### Local or a server

Finishing locally is realistic.

- The laptop is already enough for the live tail. That part is done for the current chunk.
- Full history on the free plan is also realistic locally if the machine stays awake for several days. Sleep, a closed lid, or a dead Wi-Fi session is what actually stops it. The CPU and RAM are not the constraint.
- A small VPS is the right place once the database should stay up for the app, or once a multi-day backfill should not depend on a laptop. It does not need to be large for Base alone.

Suggested first host: 2 vCPU, 4 GB RAM, 80 GB SSD. Add disk before turning on more chains. Full history across many chains is a disk problem, not a CPU problem.

## Host layout

```text
VPS
  PostgreSQL 16+     merces_data, role merces (CREATEROLE, owner)
  Node 22 + pnpm     /opt/merces-data
  systemd            NODE_ENV=production  pnpm start
  listeners          127.0.0.1:42069  first chain's Ponder
                     127.0.0.1:42081+ later chains
                     127.0.0.1:42070  ops dashboard
                     127.0.0.1:42071  importer health
                     127.0.0.1:42072  enrich health
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
CHAINS=base
START_BLOCK_BASE=41663783          # full history, or a recent chunk
ETH_GET_LOGS_BLOCK_RANGE=10        # 2000+ only on a plan that allows it
ALCHEMY_MAX_RPS=8                  # raise with the paid plan
# Ignored by pnpm start. Each chain uses erc8004_<chain>. Do not run ponder dev.
PONDER_PORT=42069
OPS_PORT=42070
SUBGRAPH_MIRROR_CHAINS=base
GRAPH_API_KEY=...
SUBGRAPH_ID_BASE=...
IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs/
```

Registry addresses and RPC URLs are already documented in `.env.example`. RPC URLs may use `${ALCHEMY_API_KEY}`; the process expands that.

```bash
sudo -u merces corepack enable
sudo -u merces corepack prepare pnpm@10.18.0 --activate
sudo -u merces pnpm install --frozen-lockfile
sudo -u merces pnpm db:init
sudo -u merces pnpm ops:build
```

`pnpm db:init` creates the schemas and the `app_ro` role. Confirm the read-only login before pointing the app at it:

```text
postgres://app_ro:<APP_RO_PASSWORD>@127.0.0.1:5432/merces_data
```

If the app runs on another machine, allow that host in `pg_hba.conf` for `app_ro` only, and do not open the ops ports.

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

`pnpm start` runs the supervisor without rebuilding the dashboard. `pnpm ops` is the local command: it builds the UI, then starts the same supervisor. The supervisor runs `ponder start`, one process per chain, schema `erc8004_<chain>`. The first chain listens on `PONDER_PORT` (42069). The next chains listen on 42081, 42082, and so on. A restart resumes each chain's checkpoint. Adding a chain does not drop the others. Changing `START_BLOCK` or the indexing code does not rebuild anything. That chain refuses to start until `pnpm reset:ponder --chain <key>` or `pnpm reset:ponder --all`. `enrich` and `mirror` survive a reset.

## Dashboard

From a laptop:

```bash
ssh -L 42070:127.0.0.1:42070 user@your-vps
```

Open `http://127.0.0.1:42070`. There is no login prompt.

Watch the Base card until lag stays under a few dozen blocks. That is the signal the backfill is finished and the process is only following the head.

## Backups

Ponder can rebuild `erc8004` from the chain. Nightly, dump only the schemas a re-index does not recreate:

```bash
pg_dump "$DATABASE_URL" -n enrich -n mirror -Fc \
  -f /var/backups/merces-enrich-mirror-$(date +%F).dump
find /var/backups -name 'merces-enrich-mirror-*.dump' -mtime +14 -delete
```

Put that in cron. Restoring:

```bash
pg_restore -d merces_data --clean --if-exists /var/backups/merces-enrich-mirror-YYYY-MM-DD.dump
```

Also keep a copy of `.env`. It is not in git.

## Moving the laptop database to the server

Do this before the server starts its own Ponder, or you will index the same range twice.

1. Stop `pnpm ops` on the laptop.
2. Dump the whole database: `pg_dump "$DATABASE_URL" -Fc -f merces_data.dump`.
3. Restore it into the empty server database.
4. Start systemd on the server with the same `START_BLOCK_*` the laptop used, so Ponder resumes the checkpoint inside `erc8004` instead of rebuilding.

If you would rather start clean on the server, skip the dump. Set `START_BLOCK_BASE` to the deploy block, run `pnpm db:init`, and let Ponder backfill there. You will lose the laptop’s `enrich` rows unless you dump at least `-n enrich -n mirror`.

## Full history on the host

1. Raise Alchemy until a 2,000-block `eth_getLogs` works. Set `ETH_GET_LOGS_BLOCK_RANGE` and `ALCHEMY_MAX_RPS` to match.
2. Set `START_BLOCK_BASE=41663783` (and the matching deploy block for any other chain).
3. Run `pnpm reset:ponder --chain base` and type `yes`. Changing `START_BLOCK` alone keeps the old rows and refuses to start that chain.
4. `sudo systemctl restart merces-data`. Leave the box up until lag is small.

Adding Ethereum or another chain is `CHAINS=base,ethereum`, a `START_BLOCK_ETHEREUM`, and a restart. Each extra chain multiplies Alchemy traffic. Turn chains on one at a time.

## Sanity check after deploy

```bash
cd /opt/merces-data
pnpm sanity
```

Exit code 0 means no failed comparisons against Alchemy at the indexed block. Warnings against 8004scan and against feedback counts for agents registered before `START_BLOCK` are expected. Run it from cron if you want a nightly non-zero alert:

```text
0 4 * * * cd /opt/merces-data && /usr/bin/pnpm sanity >> /var/log/merces-sanity.log 2>&1
```
