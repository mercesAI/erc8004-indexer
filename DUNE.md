# Dune dashboards for ERC-8004

Dune sees the chain and nothing else: registrations, transfers, URI changes, reviews, validations. It does not fetch registration files, so names, images, service endpoints and the verified publisher attribution from this indexer are not on Dune unless we upload them (section 1.4). That split is the plan: the chain-side charts live on Dune, where anyone can check the SQL; the file-side data lives in this repo's database and gets uploaded to Dune as a small table.

The first dashboard covers Base, where most of the activity is. The same queries become multi-chain later (section 3).

Registry addresses, the same on every chain:

| Registry | Address | First Base block |
| --- | --- | --- |
| Identity | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | 41,663,783 |
| Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | |
| Validation | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` | |

## 1. Prep and contribution

### 1.1 Account and team

Sign up at dune.com and create a team (suggested handle `merces`). The team handle becomes the namespace of uploaded tables (`dune.merces.dataset_...`) and the owner of the dashboard. Free plan is enough for one chain; the paid team plan is needed for multi-chain decoding and for API batch submissions (section 1.2).

### 1.2 Get the registries decoded

This is the "submit the contract addresses" step. Dune only has raw `base.logs` for a contract until someone submits its address and ABI; after that Dune creates one table per event, with the parameters as columns, and backfills history. Decoded tables are what make the queries below short and cheap.

1. Check first whether someone already submitted the registries: in the Dune data explorer, search for `8004` and for the Identity address. If decoded tables exist, use their namespace instead of submitting again; a second submission under a different name creates duplicate tables that Dune has to remove by hand.
2. Submit at `dune.com/contracts/new`, one contract at a time on the free plan:
   - Blockchain: Base. Contract address: the Identity registry. Project name: `erc8004` (this becomes the table namespace). Contract name: `IdentityRegistry`.
   - The registries are UUPS proxies (they emit `Upgraded` and `Initialized`). Dune's rule for proxies: submit the proxy address but give it the implementation's ABI, which Basescan shows under "Read as Proxy". Dune fetches a verified ABI by itself; if it cannot, paste the ABI from this repo: `packages/shared/src/abis/IdentityRegistry.ts`, `ReputationRegistry.ts`, `ValidationRegistry.ts` (the array literal in each file is the JSON ABI).
   - Leave the "several instances" and "created by a factory" boxes unchecked: there is one registry of each kind per chain.
   - Repeat for `ReputationRegistry` and `ValidationRegistry` with the same project name.
3. Wait. Approval comes by email and the status shows under Contracts in the account settings; Dune's docs put full decoding, history included, at a few hours to about a day after approval, and the tables can be visible but empty before that. Then the tables exist:

```
erc8004_base.IdentityRegistry_evt_Registered       (agentId, agentURI, owner)
erc8004_base.IdentityRegistry_evt_Transfer         ("from", "to", tokenId)
erc8004_base.IdentityRegistry_evt_URIUpdated       (agentId, newURI, updatedBy)
erc8004_base.IdentityRegistry_evt_MetadataSet      (agentId, indexedMetadataKey, metadataKey, metadataValue)
erc8004_base.ReputationRegistry_evt_NewFeedback    (agentId, clientAddress, feedbackIndex, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)
erc8004_base.ReputationRegistry_evt_FeedbackRevoked (agentId, clientAddress, feedbackIndex)
erc8004_base.ReputationRegistry_evt_ResponseAppended (agentId, clientAddress, feedbackIndex, responder, responseURI, responseHash)
erc8004_base.ValidationRegistry_evt_ValidationRequest  (validatorAddress, agentId, requestURI, requestHash)
erc8004_base.ValidationRegistry_evt_ValidationResponse (validatorAddress, agentId, requestHash, response, responseURI, responseHash, tag)
```

   Every decoded event table also carries `evt_block_time`, `evt_block_number`, `evt_tx_hash`, `evt_index` and `contract_address`; newer tables add `evt_tx_from` and `evt_tx_to`, and when they are missing the raw `base.logs` table has `tx_from` and `tx_to` for the same purpose (Q6 uses it). Check with `SELECT count(*) FROM erc8004_base.IdentityRegistry_evt_Registered`; the number should be close to the indexer's agent count for Base (section 2.4).

4. Multi-chain, later. "Submit on Multiple Chains" (paid team plan) decodes the same ABI on several chains into one table per event, `erc8004_multichain.IdentityRegistry_evt_Registered`, with a `chain` column. On the free plan, submit each chain separately and `UNION ALL` the per-chain tables in the queries. The API endpoint `POST /v1/contracts/decode` takes up to 100 contracts per call; batches and resubmissions also need the paid plan.

Until decoding lands, the raw-log queries in section 2.3 work on `base.logs` with the event signature hashes below. They are slower and need a date filter, but they give the headline counts on day one.

| Event | topic0 |
| --- | --- |
| Registered | `0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a` |
| Transfer | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |
| URIUpdated | `0x3a2c7fffc2cba7582c690e3b82c453ea02a308326a98a3ad7576c606336409fb` |
| MetadataSet | `0x2c149ed548c6d2993cd73efe187df6eccabe4538091b33adbd25fafdb8a1468b` |
| NewFeedback | `0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc` |
| FeedbackRevoked | `0x25156fd3288212246d8b008d5921fde376c71ed14ac2e072a506eb06fde6d09d` |
| ResponseAppended | `0xb1c6be0b5b8aef6539e2fac0fd131a2faa7b49edf8e505b5eb0ad487d56051d4` |
| ValidationRequest | `0x530436c3634a98e1e626b0898be2f1e9980cc1bd2a78c07a0aba52d0a48a5059` |
| ValidationResponse | `0xafddf629e874ccc3963b6a888c477bd464a6c8525024fc88759ea3b2326349ae` |

### 1.3 Spellbook, optional and later

Spellbook (`github.com/duneanalytics/spellbook`) is Dune's dbt repository of curated tables such as `dex.trades` and `nft.trades`. A spell for ERC-8004, say `erc8004.agents` and `erc8004.feedback` across chains, would give every Dune user a clean table and put the standard in Dune's catalog. It is not needed for our dashboard, and it is a slower path: Dune accepts contributions selectively now. The process, if we want it after the dashboard is live:

1. Open a GitHub issue in the Spellbook repo with the `[CONTRIBUTION]` prefix describing the models before writing code. Non-customer pull requests are accepted case by case.
2. New spells go into the `dbt_subprojects/daily_spellbook` sub-project (refreshed daily), under a project folder, for example `models/_projects/erc8004/base/erc8004_base_agents.sql` plus a `_schema.yml` with uniqueness tests and a `sources` file naming the decoded tables from 1.2. Each sub-project has its own dbt project; `dbt deps` and `dbt compile` there produce plain SQL that can be test-run on dune.com.
3. CI runs the models on a slice of data; a Dune engineer reviews. Expect weeks, not days.

The decoded tables are the prerequisite for a spell anyway, so 1.2 comes first in every case.

### 1.4 Uploading what the chain does not know

Publishers (verified or claimed), agent names and images come from registration files, which this indexer fetches. Dune can hold that as an uploaded table and join it to the decoded events.

- Export from the indexer database (Base only for the first dashboard; the same query without the chain filter for the multi-chain one):

```sql
\copy (SELECT chain_id, agent_id, publisher_key, publisher_name, publisher_status AS status, publisher_proof AS proof,
              left(name, 80) AS name, registered_at
       FROM read.publisher_agents WHERE chain_id = 8453 ORDER BY chain_id, agent_id)
  TO '/tmp/erc8004_publishers_base.csv' CSV HEADER
```

- Upload with the "Upload Data" button in the Dune menu (choose the file, name the table, add a description, save) or with the API: `POST https://api.dune.com/api/v1/uploads/csv` with `table_name = erc8004_publishers`, a description, and the CSV in `data`. The table appears as `dune.merces.dataset_erc8004_publishers`. Uploading a file with the same name replaces the table, so a nightly cron on the server (export, then one `curl`) keeps it current. Keep the Dune API key in the server's `.env` as `DUNE_API_KEY`, never in git.
- Limits from Dune's docs: 200 MB per file in the web app and 500 MB through the API, 100 MB of total storage on the free plan (1 GB on Analyst, 15 GB on Plus), and uploads are public unless the team is on Enterprise. The Base export is roughly 750,000 rows and under 40 MB without names, so it fits the free tier; the all-chains export of about 1.2 million rows fits as well if names are left out.
- Column names cannot start with a digit or a special character. `agent_id` is uploaded as a plain integer and cast to `uint256` in the joins.

### 1.5 Keeping it cheap

Dune meters query executions in credits. Decoded tables are far cheaper than `base.logs`; raw-log queries must always filter on `block_date` or `block_number`. Set the dashboard to refresh a few times a day rather than on every view, and keep the heavy queries (per-owner distribution, time to first review) on a daily schedule. Materialized views are a paid feature; the queries below do not need them.

## 2. First dashboard: ERC-8004 on Base

Name: `ERC-8004 on Base`. Description: "Trustless Agents (ERC-8004) on Base: registrations, owners, reviews, validations and the platforms behind them. Chain data from the decoded registries; publisher attribution from the merces indexer (github.com/mercesAI/erc8004-indexer)." Link the app and the repo in the header text widget.

### 2.1 Layout

Rows, top to bottom. Each widget names the query from 2.2.

1. **Counters** (six small tiles): Agents (Q1 `agents`), Registered last 24h (Q1 `agents_24h`), Registered last 7 days (Q1 `agents_7d`), Reviews (Q1 `reviews`), Reviewers (Q1 `reviewers`), Agents with a review (Q1 `reviewed_agents`).
2. **Growth**: daily registrations with the cumulative line (Q2, bar + line on a second axis); daily reviews and reviewers (Q8, bars + line); new vs returning registering accounts per week (Q16, stacked bars).
3. **Publishers**: weekly registrations by registration-file host (Q3, stacked area); top hosts (Q4, table with share); how agents are minted, direct call vs smart-account EntryPoint vs other contracts (Q6, pie); verified publishers from the uploaded table (Q5, bar). A text widget explains that a host is where the agent's file is served, that only the uploaded `verified` column is proof of a platform, and links to the README section on publishers.
4. **Insights**: top agents by reviews (Q9, table); reviewer concentration (Q10, table with share of all reviews); score distribution (Q11, bar); time from registration to first review (Q12, counters for median and p90); agents per owner (Q7, bar); URI kinds (Q13, pie).
5. **Registries**: transfers that are not mints per day (Q14, bars); URI updates and metadata keys (Q15, table); validations (Q17, counters and table by validator).
6. **Method**: a text widget: data sources, that `agentURI` and the host are self-declared on-chain strings, counts the indexer shows for cross-checking (2.4), the refresh schedule, and the decoding date.

### 2.2 Queries

All queries are DuneSQL (Trino). Addresses are `varbinary` literals written as `0x...` without quotes. Replace the `erc8004_base` namespace if the decoded tables ended up under another one. The `reviews` CTE that removes revoked feedback appears in several queries; Dune has no shared CTEs, so it is repeated.

**Q1. Headline counters** (one query, each counter widget picks a column)

```sql
WITH reviews AS (
  SELECT f.agentId, f.clientAddress
  FROM erc8004_base.ReputationRegistry_evt_NewFeedback f
  LEFT JOIN erc8004_base.ReputationRegistry_evt_FeedbackRevoked r
    ON r.agentId = f.agentId AND r.clientAddress = f.clientAddress AND r.feedbackIndex = f.feedbackIndex
  WHERE r.agentId IS NULL
)
SELECT
  (SELECT count(*) FROM erc8004_base.IdentityRegistry_evt_Registered) AS agents,
  (SELECT count(*) FROM erc8004_base.IdentityRegistry_evt_Registered WHERE evt_block_time > now() - interval '1' day) AS agents_24h,
  (SELECT count(*) FROM erc8004_base.IdentityRegistry_evt_Registered WHERE evt_block_time > now() - interval '7' day) AS agents_7d,
  (SELECT count(DISTINCT owner) FROM erc8004_base.IdentityRegistry_evt_Registered) AS registering_accounts,
  (SELECT count(*) FROM reviews) AS reviews,
  (SELECT count(DISTINCT clientAddress) FROM reviews) AS reviewers,
  (SELECT count(DISTINCT agentId) FROM reviews) AS reviewed_agents
```

**Q2. Daily registrations and cumulative agents** (bar for `registered`, line for `cumulative` on the right axis)

```sql
SELECT date_trunc('day', evt_block_time) AS day,
       count(*) AS registered,
       sum(count(*)) OVER (ORDER BY date_trunc('day', evt_block_time)) AS cumulative
FROM erc8004_base.IdentityRegistry_evt_Registered
GROUP BY 1
ORDER BY 1
```

**Q3. Weekly registrations by registration-file host** (stacked area; the six biggest hosts, the rest as `other`)

```sql
WITH reg AS (
  SELECT date_trunc('week', evt_block_time) AS week,
         CASE WHEN agentURI LIKE 'data:%' THEN 'data: (inline file)'
              WHEN agentURI LIKE 'ipfs://%' THEN 'ipfs://'
              WHEN agentURI = '' THEN '(no URI)'
              ELSE coalesce(lower(regexp_extract(agentURI, '^https?://([^/:]+)', 1)), '(other)') END AS host
  FROM erc8004_base.IdentityRegistry_evt_Registered
),
top_hosts AS (
  SELECT host FROM reg GROUP BY host ORDER BY count(*) DESC LIMIT 6
)
SELECT week,
       CASE WHEN host IN (SELECT host FROM top_hosts) THEN host ELSE 'other' END AS host,
       count(*) AS registered
FROM reg
GROUP BY 1, 2
ORDER BY 1, 3 DESC
```

**Q4. Top registration-file hosts** (table)

```sql
WITH reg AS (
  SELECT evt_block_time,
         CASE WHEN agentURI LIKE 'data:%' THEN 'data: (inline file)'
              WHEN agentURI LIKE 'ipfs://%' THEN 'ipfs://'
              WHEN agentURI = '' THEN '(no URI)'
              ELSE coalesce(lower(regexp_extract(agentURI, '^https?://([^/:]+)', 1)), '(other)') END AS host
  FROM erc8004_base.IdentityRegistry_evt_Registered
)
SELECT host,
       count(*) AS agents,
       round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS share_pct,
       min(evt_block_time) AS first_seen,
       max(evt_block_time) AS last_seen,
       count(*) FILTER (WHERE evt_block_time > now() - interval '7' day) AS last_7d
FROM reg
GROUP BY 1
ORDER BY 2 DESC
LIMIT 25
```

**Q5. Verified publishers** (bar; needs the uploaded table from 1.4)

```sql
SELECT p.publisher_name,
       count(*) AS verified_agents,
       count(*) FILTER (WHERE r.evt_block_time > now() - interval '7' day) AS registered_last_7d
FROM dune.merces.dataset_erc8004_publishers p
JOIN erc8004_base.IdentityRegistry_evt_Registered r ON r.agentId = cast(p.agent_id AS uint256)
WHERE p.chain_id = 8453 AND p.status = 'verified'
GROUP BY 1
ORDER BY 2 DESC
```

**Q6. How agents are minted** (pie). Central City and Virtuals register through ERC-4337 smart accounts, AlphaArc and the art drops through their own contracts, most others by calling the registry directly. This one reads the raw logs because it needs the transaction's target, `tx_to`.

```sql
SELECT CASE WHEN tx_to = 0x8004a169fb4a3325136eb29fa0ceb6d2e539a432 THEN 'direct call to the registry'
            WHEN tx_to IN (0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789, 0x0000000071727de22e5e9d8baf0edac6f37da032) THEN 'ERC-4337 EntryPoint (smart accounts)'
            ELSE 'another contract (factory, drop, multicall)' END AS path,
       count(*) AS agents,
       count(DISTINCT topic2) AS registering_accounts
FROM base.logs
WHERE contract_address = 0x8004a169fb4a3325136eb29fa0ceb6d2e539a432
  AND topic0 = 0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a
  AND block_date >= date '2026-02-01'
GROUP BY 1
ORDER BY 2 DESC
```

**Q7. Agents per current owner** (bar; owners are the `to` of each token's last transfer, mints included)

```sql
WITH current_owner AS (
  SELECT tokenId, "to" AS owner
  FROM (
    SELECT tokenId, "to",
           row_number() OVER (PARTITION BY tokenId ORDER BY evt_block_number DESC, evt_index DESC) AS rn
    FROM erc8004_base.IdentityRegistry_evt_Transfer
  ) t
  WHERE rn = 1
),
per_owner AS (SELECT owner, count(*) AS n FROM current_owner GROUP BY 1)
SELECT CASE WHEN n = 1 THEN '1 agent' WHEN n <= 5 THEN '2-5' WHEN n <= 20 THEN '6-20'
            WHEN n <= 100 THEN '21-100' ELSE '100+' END AS bucket,
       count(*) AS owners,
       sum(n) AS agents
FROM per_owner
GROUP BY 1
ORDER BY min(n)
```

**Q8. Daily reviews** (bars for `reviews`, lines for `reviewers` and `agents_reviewed`)

```sql
WITH reviews AS (
  SELECT f.agentId, f.clientAddress, f.evt_block_time
  FROM erc8004_base.ReputationRegistry_evt_NewFeedback f
  LEFT JOIN erc8004_base.ReputationRegistry_evt_FeedbackRevoked r
    ON r.agentId = f.agentId AND r.clientAddress = f.clientAddress AND r.feedbackIndex = f.feedbackIndex
  WHERE r.agentId IS NULL
)
SELECT date_trunc('day', evt_block_time) AS day,
       count(*) AS reviews,
       count(DISTINCT clientAddress) AS reviewers,
       count(DISTINCT agentId) AS agents_reviewed
FROM reviews
GROUP BY 1
ORDER BY 1
```

**Q9. Top agents by reviews** (table). `value / 10^valueDecimals` is the score as the reviewer meant it.

```sql
WITH reviews AS (
  SELECT f.agentId, f.clientAddress, f.value, f.valueDecimals, f.evt_block_time
  FROM erc8004_base.ReputationRegistry_evt_NewFeedback f
  LEFT JOIN erc8004_base.ReputationRegistry_evt_FeedbackRevoked r
    ON r.agentId = f.agentId AND r.clientAddress = f.clientAddress AND r.feedbackIndex = f.feedbackIndex
  WHERE r.agentId IS NULL
),
agg AS (
  SELECT agentId,
         count(*) AS reviews,
         count(DISTINCT clientAddress) AS reviewers,
         avg(cast(value AS double) / power(10, valueDecimals)) AS avg_score,
         max(evt_block_time) AS last_review
  FROM reviews
  GROUP BY 1
)
SELECT a.agentId,
       coalesce(lower(regexp_extract(r.agentURI, '^https?://([^/:]+)', 1)), left(r.agentURI, 20)) AS host,
       a.reviews, a.reviewers, round(a.avg_score, 2) AS avg_score, a.last_review,
       r.evt_block_time AS registered
FROM agg a
JOIN erc8004_base.IdentityRegistry_evt_Registered r ON r.agentId = a.agentId
ORDER BY a.reviews DESC
LIMIT 25
```

**Q10. Reviewer concentration** (table; how much of all feedback the biggest reviewers write)

```sql
WITH reviews AS (
  SELECT f.agentId, f.clientAddress, f.evt_block_time
  FROM erc8004_base.ReputationRegistry_evt_NewFeedback f
  LEFT JOIN erc8004_base.ReputationRegistry_evt_FeedbackRevoked r
    ON r.agentId = f.agentId AND r.clientAddress = f.clientAddress AND r.feedbackIndex = f.feedbackIndex
  WHERE r.agentId IS NULL
)
SELECT clientAddress AS reviewer,
       count(*) AS reviews,
       count(DISTINCT agentId) AS agents_reviewed,
       round(100.0 * count(*) / (SELECT count(*) FROM reviews), 2) AS share_of_all_reviews_pct,
       min(evt_block_time) AS first_review,
       max(evt_block_time) AS last_review
FROM reviews
GROUP BY 1
ORDER BY 2 DESC
LIMIT 20
```

**Q11. Score distribution** (bar; scores bucketed by tens, most reviewers use 0 to 100)

```sql
WITH reviews AS (
  SELECT cast(f.value AS double) / power(10, f.valueDecimals) AS score
  FROM erc8004_base.ReputationRegistry_evt_NewFeedback f
  LEFT JOIN erc8004_base.ReputationRegistry_evt_FeedbackRevoked r
    ON r.agentId = f.agentId AND r.clientAddress = f.clientAddress AND r.feedbackIndex = f.feedbackIndex
  WHERE r.agentId IS NULL
)
SELECT CASE WHEN score < 0 THEN 'below 0'
            WHEN score > 100 THEN 'above 100'
            ELSE cast(cast(floor(score / 10) * 10 AS integer) AS varchar) || '-' || cast(cast(floor(score / 10) * 10 + 9 AS integer) AS varchar) END AS score_bucket,
       count(*) AS reviews
FROM reviews
GROUP BY 1
ORDER BY min(score)
```

**Q12. Time from registration to first review** (counters: median and p90, in hours)

```sql
WITH first_review AS (
  SELECT agentId, min(evt_block_time) AS at
  FROM erc8004_base.ReputationRegistry_evt_NewFeedback
  GROUP BY 1
),
waits AS (
  SELECT date_diff('minute', r.evt_block_time, f.at) / 60.0 AS hours
  FROM first_review f
  JOIN erc8004_base.IdentityRegistry_evt_Registered r ON r.agentId = f.agentId
)
SELECT round(approx_percentile(hours, 0.5), 1) AS median_hours,
       round(approx_percentile(hours, 0.9), 1) AS p90_hours,
       count(*) AS agents_with_reviews
FROM waits
```

**Q13. URI kinds** (pie; what the registration points at)

```sql
SELECT CASE WHEN agentURI LIKE 'https://%' THEN 'https'
            WHEN agentURI LIKE 'http://%' THEN 'http'
            WHEN agentURI LIKE 'ipfs://%' THEN 'ipfs'
            WHEN agentURI LIKE 'data:%' THEN 'data (inline)'
            WHEN agentURI = '' THEN 'empty'
            ELSE 'other' END AS uri_kind,
       count(*) AS agents
FROM erc8004_base.IdentityRegistry_evt_Registered
GROUP BY 1
ORDER BY 2 DESC
```

**Q14. Transfers that are not mints, per day** (bars; a market or a hand-over of agents)

```sql
SELECT date_trunc('day', evt_block_time) AS day,
       count(*) AS transfers,
       count(DISTINCT tokenId) AS agents_moved,
       count(DISTINCT "to") AS receivers
FROM erc8004_base.IdentityRegistry_evt_Transfer
WHERE "from" <> 0x0000000000000000000000000000000000000000
GROUP BY 1
ORDER BY 1
```

**Q15. URI updates and metadata keys** (two tables, or one with a `kind` column)

```sql
SELECT 'URIUpdated' AS kind, 'newURI' AS key, count(*) AS events, count(DISTINCT agentId) AS agents
FROM erc8004_base.IdentityRegistry_evt_URIUpdated
UNION ALL
SELECT 'MetadataSet', metadataKey, count(*), count(DISTINCT agentId)
FROM erc8004_base.IdentityRegistry_evt_MetadataSet
GROUP BY metadataKey
ORDER BY events DESC
LIMIT 20
```

**Q16. New vs returning registering accounts per week** (stacked bars; is growth new people or the same accounts registering more)

```sql
WITH first_seen AS (
  SELECT owner, min(evt_block_time) AS first_at
  FROM erc8004_base.IdentityRegistry_evt_Registered
  GROUP BY 1
)
SELECT date_trunc('week', r.evt_block_time) AS week,
       count(DISTINCT CASE WHEN date_trunc('week', f.first_at) = date_trunc('week', r.evt_block_time) THEN r.owner END) AS new_accounts,
       count(DISTINCT CASE WHEN date_trunc('week', f.first_at) < date_trunc('week', r.evt_block_time) THEN r.owner END) AS returning_accounts,
       count(*) AS registrations
FROM erc8004_base.IdentityRegistry_evt_Registered r
JOIN first_seen f ON f.owner = r.owner
GROUP BY 1
ORDER BY 1
```

**Q17. Validations** (counters plus a table by validator; there are few of these so far)

```sql
WITH req AS (SELECT validatorAddress, agentId, requestHash, evt_block_time FROM erc8004_base.ValidationRegistry_evt_ValidationRequest),
     res AS (SELECT validatorAddress, requestHash, response, evt_block_time FROM erc8004_base.ValidationRegistry_evt_ValidationResponse)
SELECT req.validatorAddress AS validator,
       count(*) AS requests,
       count(res.requestHash) AS responses,
       round(avg(cast(res.response AS double)), 1) AS avg_response,
       count(DISTINCT req.agentId) AS agents,
       max(req.evt_block_time) AS last_request
FROM req
LEFT JOIN res ON res.requestHash = req.requestHash AND res.validatorAddress = req.validatorAddress
GROUP BY 1
ORDER BY 2 DESC
```

### 2.3 Before decoding: the same counts from raw logs

These run on `base.logs` and are the fallback on day one. The date filter matters for cost.

**Events by type**

```sql
SELECT CASE topic0
         WHEN 0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a THEN 'Registered'
         WHEN 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef THEN 'Transfer'
         WHEN 0x3a2c7fffc2cba7582c690e3b82c453ea02a308326a98a3ad7576c606336409fb THEN 'URIUpdated'
         WHEN 0x2c149ed548c6d2993cd73efe187df6eccabe4538091b33adbd25fafdb8a1468b THEN 'MetadataSet'
         WHEN 0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc THEN 'NewFeedback'
         WHEN 0x25156fd3288212246d8b008d5921fde376c71ed14ac2e072a506eb06fde6d09d THEN 'FeedbackRevoked'
         WHEN 0xb1c6be0b5b8aef6539e2fac0fd131a2faa7b49edf8e505b5eb0ad487d56051d4 THEN 'ResponseAppended'
         WHEN 0x530436c3634a98e1e626b0898be2f1e9980cc1bd2a78c07a0aba52d0a48a5059 THEN 'ValidationRequest'
         WHEN 0xafddf629e874ccc3963b6a888c477bd464a6c8525024fc88759ea3b2326349ae THEN 'ValidationResponse'
         ELSE 'other' END AS event,
       count(*) AS events
FROM base.logs
WHERE contract_address IN (0x8004a169fb4a3325136eb29fa0ceb6d2e539a432,
                           0x8004baa17c55a88189ae136b182e5fda19de9b63,
                           0x8004cc8439f36fd5f9f049d9ff86523df6daab58)
  AND block_date >= date '2026-02-01'
GROUP BY 1
ORDER BY 2 DESC
```

**Recent registrations with the agent URI decoded by hand.** `topic1` is the agent id, `topic2` the owner padded to 32 bytes; `data` holds the string as offset, length, bytes, so the text starts at byte 65 and its length sits in bytes 33 to 64. Dune's varbinary functions count bytes from 1.

```sql
SELECT block_time,
       varbinary_to_uint256(topic1) AS agent_id,
       varbinary_substring(topic2, 13, 20) AS owner,
       from_utf8(varbinary_substring(data, 65, varbinary_to_bigint(varbinary_ltrim(varbinary_substring(data, 33, 32))))) AS agent_uri
FROM base.logs
WHERE contract_address = 0x8004a169fb4a3325136eb29fa0ceb6d2e539a432
  AND topic0 = 0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a
  AND block_date >= current_date - interval '7' day
ORDER BY block_time DESC
LIMIT 100
```

### 2.4 Numbers to check against

From this indexer's database for Base on 22 Oct 2026, 23:40 UTC. Dune's counts should match within the few hours of lag between the two.

| Measure | Indexer |
| --- | --- |
| Agents (Registered events) | 754,189 |
| Distinct current owners | 702,545 |
| Reviews, non-revoked | 624,833 (130 revoked) |
| Reviewers | 87,878 |
| Agents with at least one review | 104,235 |
| Agents with an `agentWallet` | 101,251 |
| Agents whose URI was updated | 11,440 |
| Validations | 15 requests, 10 answered |
| URI kinds | https 708,937, empty 23,564, data 16,084, ipfs 4,143, other 1,461 |
| Biggest hosts | centralcity.ai 650,419; Termix S3 bucket 28,142; ipfs.io 9,721; arweave.net 7,827 |
| Registrations on 22 Oct | 255,287 (103,386 on the 20th, 113,750 on the 21st) |

Owners in the indexer differ slightly from Dune's `count(DISTINCT owner)` on `Registered`: the indexer applies transfers, Q1 counts registering accounts. Q7 uses the last transfer, which is the indexer's definition.

### 2.5 Publishing

Make every query public, build the dashboard, set the description and tags (`erc8004`, `agents`, `base`), and publish. Add the dashboard link to the README and the app. Refresh schedule: the counters and daily charts every six hours; the per-owner and reviewer queries daily.

## 3. Next

- More chains: BNB, Ethereum, Polygon, Monad and the rest, either with multi-chain decoding (paid plan, one `erc8004_multichain` table per event with a `chain` column and a `{{chain}}` dashboard parameter) or with per-chain tables joined by `UNION ALL`.
- The all-chains dashboard: the same layout with a chain filter, a chain comparison row (agents, reviews, growth per chain), and the publisher table from the full upload.
- Per-publisher pages: a Central City dashboard (daily registrations, smart-account mints, review activity) once the platform is comfortable with it.
- x402 and the payment side, when the indexer covers it.
