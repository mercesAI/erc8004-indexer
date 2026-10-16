# Deploying to a server

This guide puts the whole stack on one Linux server, starting from an empty database: Postgres, the indexer, the enrich worker, and the dashboard. The indexer reads every chain from the ERC-8004 registry's deploy block. The app connects to Postgres over the internet with the read-only role `app_ro`, encrypted, and can read schema `read` only.

There is no Docker. Everything runs under one systemd service.

## What it costs and how long it takes

| | Typical |
| --- | --- |
| Server | A small VPS: 2 to 4 shared vCPUs, 8 GB RAM, 80 GB disk |
| Alchemy, first full history of 5 chains | About 68,000 `eth_getLogs`, about 4M compute units, under $2 |
| Alchemy, ongoing | About 3.4M compute units a month, about $1.50 |
| Time to index full history | One to two hours. BNB takes longest |
| Time to fetch every registration file | About a day. Enrich fetches at most a few hundred files a minute and retries slow hosts later |

The app can read agents as soon as the indexer has written them. Names, descriptions, and services fill in as enrich catches up.

## 1. Create the server

Any Ubuntu 24.04 VPS works. The steps below use Hetzner Cloud.

1. **Location.** Put the server in the same region as the app, because every query crosses that distance. An app on Vercel's default region, Washington D.C., pairs with Hetzner Ashburn. An app in Europe pairs with Falkenstein, Nuremberg, or Helsinki, which are also cheaper.
2. **Type.** Pick the cheapest type available in that location with at least 2 vCPUs, 8 GB RAM, and 40 GB disk. Shared vCPUs are fine; dedicated vCPUs (CCX) are not needed. Hetzner raised prices in 2026 and stock varies, so check the console rather than a list.
3. **Image.** Ubuntu 24.04. It ships Postgres 16.
4. **SSH key.** Add your laptop's public key (`cat ~/.ssh/id_ed25519.pub`). Do not use a root password.
5. **Backups.** Turn on Hetzner's daily server backups. They cost 20% of the server price and restore the whole machine.
6. **Firewall.** Create a Hetzner Cloud Firewall with two inbound rules and attach it to the server:
   - TCP 22 from your own IP address, for SSH.
   - TCP 5432 from the app's outgoing IP addresses, for Postgres. If the app has no fixed IPs, which is the case on Vercel's standard plans, allow any address. TLS, a long password, and the limits on `app_ro` protect it.

Optional but useful: point a DNS name such as `db.example.com` at the server's IP. The app then connects to a name, and moving servers later only changes DNS.

## 2. Prepare the machine

Log in as root with your key, then:

```bash
apt update && apt upgrade -y
apt install -y git curl unattended-upgrades postgresql postgresql-contrib
dpkg-reconfigure -f noninteractive unattended-upgrades   # security updates install on their own

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
corepack enable                                          # provides /usr/bin/pnpm

# The service account. It owns the code and runs the service. It cannot log in.
useradd --system --create-home --shell /usr/sbin/nologin merces
```

Turn off SSH password logins if your provider left them on: set `PasswordAuthentication no` in `/etc/ssh/sshd_config`, then `systemctl restart ssh`. Check you can still log in from a second terminal before closing the first.

## 3. Create the database

Generate two passwords. Hex only, so they never need escaping in a connection string:

```bash
openssl rand -hex 24   # for the merces role
openssl rand -hex 24   # for app_ro, the app's read-only role
```

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE merces LOGIN PASSWORD '<merces password>' CREATEROLE;
CREATE DATABASE merces_data OWNER merces;
SQL
```

`merces` writes the data and creates `app_ro` in step 5. It needs `CREATEROLE` and must own the database.

## 4. Get the code

While the GitHub repository is private, give the server a read-only deploy key:

```bash
sudo -u merces ssh-keygen -t ed25519 -N "" -f /home/merces/.ssh/id_ed25519
cat /home/merces/.ssh/id_ed25519.pub
```

Add that key in GitHub under the repository's Settings, Deploy keys, without write access. Then:

```bash
mkdir -p /opt/merces-data && chown merces:merces /opt/merces-data
sudo -u merces git clone git@github.com:0xVitalii/merces-data.git /opt/merces-data
```

Once the repository is public, `git clone https://github.com/0xVitalii/merces-data.git` works without a key.

## 5. Configure and initialize

```bash
cd /opt/merces-data
sudo -u merces cp .env.example .env
sudo -u merces nano .env
```

Set at least these. Leave every `START_BLOCK_<CHAIN>` empty: empty means full history from the registry's deploy block.

```text
DATABASE_URL=postgres://merces:<merces password>@127.0.0.1:5432/merces_data
APP_RO_PASSWORD=<app_ro password>
ALCHEMY_API_KEY=<your key>
CHAINS=base,bnb,ethereum,polygon,monad
INDEX_INTERVAL_SEC=300
INDEX_INTERVAL_SEC_MONAD=3600
ETH_GET_LOGS_BLOCK_RANGE=2000
SUBGRAPH_MIRROR_CHAINS=
```

The RPC URLs in `.env.example` already use `${ALCHEMY_API_KEY}`. The 2,000-block range needs a paid Alchemy plan; set a monthly usage limit in Alchemy's billing settings while you are there.

```bash
chmod 600 .env
sudo -u merces COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
sudo -u merces pnpm db:init       # schemas, tables, the app_ro role, the read views
sudo -u merces pnpm ops:build     # typecheck everything and build the dashboard
```

`pnpm db:init` is safe to run again after an update.

## 6. Run it as a service

Create `/etc/systemd/system/merces-data.service`:

```ini
[Unit]
Description=ERC-8004 indexer, enrich worker, and dashboard
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=merces
WorkingDirectory=/opt/merces-data
Environment=NODE_ENV=production
Environment=COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ExecStart=/usr/bin/pnpm start
Restart=on-failure
RestartSec=5
# How long systemd waits for the children to stop.
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now merces-data
journalctl -u merces-data -f      # Ctrl+C to stop watching; the service keeps running
```

You should see `indexer started` and then `cycle` lines with a `behind` count that shrinks.

## 7. Watch the backfill

The dashboard listens on the server's localhost only. Reach it through an SSH tunnel from your laptop:

```bash
ssh -L 42070:127.0.0.1:42070 root@<server ip>
```

Open `http://127.0.0.1:42070`.

- **Workers.** The Indexer table shows each chain's applied block, the head, and how far behind it is. A chain says "catching up" until it reaches the head, then runs on its schedule.
- **Overview.** Progress per chain, and whether each process is running.
- **Logs.** Anything that failed.

Once every chain has caught up, run the comparison against the chain itself:

```bash
cd /opt/merces-data && sudo -u merces pnpm sanity
```

Exit code 0 means no mismatches. Warnings about 8004scan counts are normal. 8004scan is a third party and counts differently.

## 8. Let the app connect

Postgres only listens on localhost until you open it.

1. In `/etc/postgresql/16/main/postgresql.conf`, set:

   ```text
   listen_addresses = '*'
   ```

   Ubuntu's Postgres has TLS on by default with a self-signed certificate. Confirm with `sudo -u postgres psql -c "show ssl"`, which should print `on`.

2. At the end of `/etc/postgresql/16/main/pg_hba.conf`, allow only `app_ro`, only this database, only over TLS:

   ```text
   hostssl  merces_data  app_ro  0.0.0.0/0  scram-sha-256
   hostssl  merces_data  app_ro  ::/0       scram-sha-256
   ```

   If the app has fixed IPs, put them in place of `0.0.0.0/0`. The `merces` role stays local-only because no line allows it from outside.

3. `systemctl restart postgresql`. The service reconnects on its own.

4. Test from your laptop:

   ```bash
   psql "postgresql://app_ro:<app_ro password>@<server ip or db.example.com>:5432/merces_data?sslmode=require" \
     -c "select chain_key, count(*) from read.agents group by 1"
   ```

The app uses that same connection string. `sslmode=require` encrypts the connection. The certificate is self-signed, so the app does not verify it. For full verification, put a real certificate on `db.example.com`, for example from Let's Encrypt, and use `sslmode=verify-full`.

`app_ro` can hold at most 30 connections, and any query over 10 seconds is cancelled (`sql/002_app_read.sql`). A serverless app should keep its pool small, one to three connections per instance.

`pnpm verify:read` on the server confirms `app_ro` can read `read` and nothing else.

## 9. Backups

Hetzner's server backups from step 1 cover the machine. Add a nightly database dump so a single bad day can be undone without restoring the whole server:

```bash
mkdir -p /var/backups/merces && chown merces /var/backups/merces
crontab -u merces -e
```

```text
15 3 * * * pg_dump "postgres://merces:<merces password>@127.0.0.1:5432/merces_data" -Fc -f /var/backups/merces/merces-$(date +\%F).dump && find /var/backups/merces -name '*.dump' -mtime +7 -delete
```

The chain tables can be rebuilt from the RPC for a few dollars. The `enrich` tables take a day of fetching to rebuild, which is the main reason for the dump. Restoring:

```bash
pg_restore -d merces_data --clean --if-exists /var/backups/merces/merces-YYYY-MM-DD.dump
```

Keep a copy of `.env` somewhere safe. It is not in git.

## Updating

```bash
cd /opt/merces-data
sudo -u merces git pull
sudo -u merces pnpm install --frozen-lockfile
sudo -u merces pnpm db:init
sudo -u merces pnpm ops:build
systemctl restart merces-data
```

A restart resumes every chain from its cursor. Nothing is re-downloaded. If a change alters what the indexer stores, re-read the affected chain with `sudo -u merces pnpm reindex --chain <key>`, which asks you to type `yes`.

## Optional: a nightly alert

The supervisor already runs sanity every 6 hours for the dashboard. To get a non-zero exit code you can alert on, add this to the `merces` crontab (`crontab -u merces -e`):

```text
0 4 * * * cd /opt/merces-data && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 /usr/bin/pnpm sanity >> /home/merces/sanity.log 2>&1
```
