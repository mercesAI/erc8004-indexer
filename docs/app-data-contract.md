# App data contract

This is the only interface for the user-facing app. The app is a different repository. It connects to this Postgres database as `app_ro` and reads schema `read`. It does not write.

Connection string, with the password from this repo's `APP_RO_PASSWORD`:

```text
postgres://app_ro:<APP_RO_PASSWORD>@127.0.0.1:5432/merces_data
```

On the machine that runs the collectors, the host is `127.0.0.1` and the port is the one in `DATABASE_URL`. Do not connect as `merces`. Do not open the ops dashboard from the app.

Check the boundary with `pnpm verify:read` in this repo. It must show `app_ro` can count `read.agents`, and permission denied for `mirror`, `erc8004`, `enrich`, and `ops`.

## Identity

An agent is the pair `(chain_id, agent_id)`.

`chain_id` is an integer. `agent_id` is a numeric token id. In JSON, send `agent_id` as a string so a large id cannot be rounded. Current ids fit in a JavaScript number, and the string is still the right type.

There is no surrogate id. Do not invent one.

| chain_key | chain_name | chain_id |
| --- | --- | --- |
| ethereum | Ethereum | 1 |
| optimism | Optimism | 10 |
| bnb | BNB | 56 |
| gnosis | Gnosis | 100 |
| polygon | Polygon | 137 |
| monad | Monad | 143 |
| soneium | Soneium | 1868 |
| abstract | Abstract | 2741 |
| tempo | Tempo | 4217 |
| robinhood | Robinhood | 4663 |
| mantle | Mantle | 5000 |
| arc | Arc | 5042 |
| base | Base | 8453 |
| arbitrum | Arbitrum | 42161 |
| celo | Celo | 42220 |
| avalanche | Avalanche | 43114 |
| linea | Linea | 59144 |
| scroll | Scroll | 534352 |

`read.chains` lists those eighteen names. A row there does not mean the chain has been indexed, and there is no readiness column anywhere in `read`. A chain is present in the product only when `read.agents` has rows for that `chain_id`; the "Chains that actually have agents" query below is how to find them. A chain that is still backfilling appears with a partial, growing agent count, and nothing in the data marks it as unfinished. As of 15 Oct 2026 all five indexed chains were at head: Base (`8453`), BNB (`56`), Ethereum (`1`), Polygon (`137`), and Monad (`143`). Monad is read hourly, so its newest hour is missing until the next cycle.

Every product row also carries `chain_key` and `chain_name`. You do not need a local chain table.

## Views

All of these are views. `SELECT` only. They update as the collectors run. A query is allowed to see an agent before its registration file has been fetched.

| View | One row is | Key |
| --- | --- | --- |
| `read.chains` | a known chain name | `chain_id` |
| `read.agents` | the agent the UI should open | `(chain_id, agent_id)` |
| `read.services` | one service from the registration file | `(chain_id, agent_id, name, endpoint)` |
| `read.feedback` | one on-chain review | `(chain_id, agent_id, client_address, feedback_index)` |
| `read.feedback_responses` | one reply appended to a review | `(chain_id, tx_hash, log_index)` |
| `read.validations` | one validator request | `(chain_id, request_hash)` |
| `read.registration_files` | the fetched file, including JSON | `(chain_id, agent_id)` |
| `read.agent_metadata` | one on-chain metadata key | `(chain_id, agent_id, key)` |

`read.agents` is the list and the header of a detail page. Join the other views on `chain_id` and `agent_id` when you need them. Do not `SELECT *` from `read.registration_files` in a list. Column `raw` is the whole file.

### `read.agents`

| Column | Type | Meaning |
| --- | --- | --- |
| `chain_id` | integer | Chain id |
| `chain_key` | text | `base`, `bnb`, `polygon`, … |
| `chain_name` | text | `Base`, `BNB`, `Polygon`, … |
| `agent_id` | numeric | Token id |
| `owner` | text | Lowercase address. This is the current owner, not a history |
| `agent_uri` | text | Whatever the chain stored. It is often not a URL |
| `uri_kind` | text | `empty`, `ipfs`, `https`, `http`, `data`, or `invalid` |
| `agent_wallet` | text or null | Lowercase address when the chain set one |
| `registered_block` | numeric or null | Block of the registration |
| `registered_at` | timestamptz or null | When it was registered, UTC |
| `last_transfer_at` | timestamptz or null | Last owner change |
| `uri_updated_at` | timestamptz or null | Last URI change |
| `feedback_count` | integer | Non-revoked reviews. Revoked reviews are not included |
| `last_feedback_at` | timestamptz or null | Newest non-revoked review |
| `name` | text or null | From the file. Null until a fetch succeeds and the file has a name |
| `description` | text or null | From the file |
| `image` | text or null | From the file. Often a URL or another `ipfs://` URI |
| `active` | boolean or null | From the file, when the file has a boolean |
| `x402_support` | boolean or null | From the file |
| `supported_trust` | text[] or null | From the file |
| `fetch_status` | text or null | Null means not fetched yet. `ok` or `error` after a fetch |
| `fetch_error` | text or null | Set when `fetch_status` is `error` |
| `fetched_at` | timestamptz or null | Last fetch attempt |
| `content_hash` | text or null | Hash of the file body when the fetch succeeded |

`uri_kind` decides what the screen can promise:

- `empty` means the chain registered the agent with a blank URI. There is no file. This is normal. `fetch_status` stays null.
- `ipfs`, `https`, and `http` are fetched as URLs. `fetch_status` null means that has not happened yet.
- `data` means the URI starts with `data:`. The enricher only parses `data:application/json` with a `;base64,` payload. Any other `data:` URI becomes `fetch_status = 'error'` and `fetch_error = 'unsupported uri scheme'`.
- `invalid` means the token URI is not a file. The enricher still attempts it, then stores `fetch_status = 'error'` with `unsupported uri scheme`. Show the URI string. That error means the fetcher refused the string, not that the chain row is wrong.

`fetch_status` null is not a failure. On a chain that just started indexing, most rows look like that. Show the owner and the URI kind, and leave the name blank.

A later failed fetch does not wipe an earlier success. If `fetch_status` is `error` and `name` is still set, the name is from the previous good file. Prefer fields from a row whose `fetch_status` is `ok`. There is no `read.registration_files` row until the first attempt, so a missing row means "not tried yet", which is different from `fetch_status` null on the agent only when the join has not matched. On `read.agents`, null `fetch_status` means no attempt row.

Six `fetch_error` values are final for the URI they were recorded against and are not retried while that URI stays: `unsupported uri scheme`, `invalid json`, `blocked address`, `unstorable content`, `HTTP 404`, `HTTP 410`. Every other error retries after 1 hour, then 6 hours, 1 day, and then every 7 days. When an agent gets a new on-chain URI, the fetcher tries it on the next pass regardless of the old result; until then `read.registration_files.agent_uri` still names the old URI.

### Other views

`read.services.name` is free text from the file. Frequent values include `A2A`, `MCP`, `web`, `Termix Platform`, and `unknown`. Do not treat the name as an enum. `endpoint` may be an empty string. `version` is text or null. `extra` is jsonb: the service object with `name`, `endpoint`, and `version` removed.

`read.feedback` includes revoked rows. `is_revoked` is the flag. `value` is numeric, `value_decimals` is an integer, and `value_norm` is `value / 10^value_decimals` as a float for display, not for money. Also present: `tag1`, `tag2`, `endpoint`, `feedback_uri`, `feedback_hash`, `block_number`, `tx_hash`. `block_time` is timestamptz. `client_address` is lowercase. A revoked row keeps its original values when the revoke was indexed after the feedback; when only the revoke event was inside the indexed range, the row has zero value, empty tags, and `is_revoked` true.

`read.feedback_responses` joins to a review by `(chain_id, agent_id, client_address, feedback_index)`, not by `tx_hash`. The reply itself is `responder`, `response_uri`, `response_hash`, and `block_time`.

`read.validations.status` is the text `pending` or `completed`. `response` is the integer score, null while pending and set when completed. Also present: `validator_address`, `agent_id`, `request_uri`, `response_uri`, `response_hash`, `tag`, `requested_at` (nullable timestamptz), and `last_update`. There are very few of these.

`read.registration_files` has one row per agent that has been attempted, not one row per agent. `raw` is jsonb when `fetch_status` is `ok`. On `error` it is the last good file when the URI has not changed since that success, and null otherwise. Also present: `http_status`, `next_retry_at`, and `attempts`. `fetch_error` is the same text as on the agent, for example `HTTP 403`.

`read.agent_metadata.value_hex` is the on-chain bytes as lowercase hex, including the `0x` prefix. `updated_at` is timestamptz. `key` is free text. `agentWallet` is the common key, and that address is already decoded onto `read.agents.agent_wallet` (a later transfer clears the agent column and does not delete the metadata row). Other keys, such as `displayName` or `profileURL`, are still whatever bytes the chain stored. Do not assume `value_hex` is UTF-8 text.

## Queries

Newest agents on one chain:

```sql
SELECT chain_id, chain_key, agent_id::text AS agent_id, owner, name,
       uri_kind, feedback_count, fetch_status, registered_at
FROM read.agents
WHERE chain_id = 8453
  AND registered_at IS NOT NULL
ORDER BY registered_at DESC, agents.agent_id DESC
LIMIT 25;
```

Always filter `chain_id` on a list. `feedback_count` and `last_feedback_at` are stored per agent and kept current by the indexer, so the list query below uses an index on `(chain_id, registered_at, agent_id)`.

`agents.agent_id` in `ORDER BY` names the numeric column. A bare `agent_id` there would sort by the `agent_id::text` alias in the select list, where `'9'` sorts after `'10'`, and the cursor below would then skip or repeat rows.

The next page uses the last row you showed. Both cursor values must be non-null. A row comparison with NULL does not match, so do not use a null `registered_at` as a cursor.

```sql
SELECT chain_id, chain_key, agent_id::text AS agent_id, owner, name,
       uri_kind, feedback_count, fetch_status, registered_at
FROM read.agents
WHERE chain_id = 8453
  AND registered_at IS NOT NULL
  AND (registered_at, agent_id) < ($registered_at, $agent_id)
ORDER BY registered_at DESC, agents.agent_id DESC
LIMIT 25;
```

Agents with `registered_at` null were seen through feedback or a transfer before the registration event. Query them on their own with `WHERE chain_id = $1 AND registered_at IS NULL`. Do not mix them into the cursor above. The current database has none of these rows. The column is still nullable.

One agent:

```sql
SELECT *
FROM read.agents
WHERE chain_id = 8453 AND agent_id = 25975;
```

Its file, services, and reviews:

```sql
SELECT raw, fetch_status, fetch_error, fetched_at
FROM read.registration_files
WHERE chain_id = 8453 AND agent_id = 25975;

SELECT name, endpoint, version
FROM read.services
WHERE chain_id = 8453 AND agent_id = 25975
ORDER BY name, endpoint;

SELECT client_address, feedback_index::text, value_norm, tag1, is_revoked, block_time
FROM read.feedback
WHERE chain_id = 8453 AND agent_id = 25975
ORDER BY block_time DESC;
```

Name prefix on one chain. The search string is the user's text with `%` and `_` stripped:

```sql
SELECT chain_id, agent_id::text AS agent_id, name, registered_at
FROM read.agents
WHERE chain_id = 8453
  AND lower(name) LIKE lower($1) || '%'
ORDER BY registered_at DESC NULLS LAST
LIMIT 25;
```

Chains that actually have agents:

```sql
SELECT chain_id, chain_key, chain_name, count(*)::int AS agents
FROM read.agents
GROUP BY 1, 2, 3
ORDER BY agents DESC;
```

## What not to do

- Do not read `erc8004`, `enrich`, `mirror`, or `ops`. `app_ro` is denied those schemas. `mirror` is a subgraph copy and runs ahead of the chain indexer, so its counts are a different population.
- Do not assume a name, a description, an image, or a service. Trust those fields when `fetch_status` is `ok`. If status is `error` and a name is still present, it is left over from an earlier success.
- Do not treat `uri_kind = 'empty'` or `'invalid'` as a collector bug.
- Do not paginate with a large `OFFSET`. Use the `(registered_at, agent_id)` cursor above.
- Do not cache a chain's full agent list for a long time. Indexing appends rows, and a manual `pnpm reindex` removes one chain and fills it again from its start block. `enrich` rows survive that.

## How fresh the data is

Collectors in this repo write on a schedule:

- The indexer reads each chain's registry logs every 5 minutes, and Monad every hour. It stays a few blocks behind the head so that a chain reorganization does not reach the tables. A new on-chain event appears in `read` within about 6 minutes on most chains and about an hour on Monad. A restart resumes where it stopped.
- Enrich downloads registration files in the background. A new agent can sit with `fetch_status` null for a while.
- The subgraph mirror is optional and only for checks inside this repo. The app never sees it.

Changing indexer code or `START_BLOCK` does not touch existing rows. Someone re-reads a chain on purpose with `pnpm reindex --chain <key>` in this repo. During that re-read the chain's rows disappear and come back in block order over several minutes. The app should keep reading whatever rows are there.
