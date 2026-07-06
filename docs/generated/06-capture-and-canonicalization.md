> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Capture and Canonicalization

This document maps the capture-first spine of the kernel: how every business
fact is journaled verbatim into the append-only `observations` journal before
any parsing, and how a minutely sweep replays those observations into gapless,
content-deduped `domain_events` that projections consume. It covers the
`insertObservation` claim-then-write protocol, the complete producer catalog,
the client-capture ingest lane, the canonicalization driver and every
canonicalizer family, the per-account sequence and content-hash dedup mechanics,
the full domain-event catalog, and the three projections. Sources are anchored
to `file:line` in the repo. Two observation sources — `operator` and
`readthrough` — are captured but have no canonicalizer and never become domain
events.

## 1. Capture-first doctrine (the observations journal)

The journal is append-only by construction: `insertObservation`
(`packages/db/src/repositories/observations.ts:41`) exposes inserts only, with
no update or delete surface (header lines 1-8). The insert follows a three-step
claim-then-write protocol (decision #64):

1. **Pre-allocate the identity id** via
   `nextval(pg_get_serial_sequence('observations','id'))`
   (`observations.ts:45`).
2. **Claim `(source, idempotency_key)`** in the unpartitioned companion table
   `observation_keys` with `ON CONFLICT DO NOTHING` (`observations.ts:54`).
3. **Only then write the journal row** into the partitioned `observations`
   table with `OVERRIDING SYSTEM VALUE` (`observations.ts:71`).

A lost claim (the `INSERT ... RETURNING` comes back empty) is the duplicate
signal: no journal row is written and the call returns
`{inserted: false, observationId}` after looking up the existing id
(`observations.ts:61-68`). The protocol is composable inside a caller's
transaction (e.g. the webhook receiver runs it inside its own tx). On a
journal-insert failure in autocommit, the code deletes exactly its own claim
scoped by `observation_id` and rethrows the original error
(`observations.ts:92-112`). Identity-sequence gaps from duplicates are
harmless.

`received_at` is stamped once (`observations.ts:52`) so the key row and the
journal row always agree — the key's `received_at` is how lookups reach the
right monthly partition. Partitions are provisioned by
`ensureObservationPartitions` (`observations.ts:281`). The payload is stored as
`jsonb`; `payload_hash` is stored as `bytea` (sha256 of the raw bytes the
producer received).

**Payload/row shape** — `ObservationInsertInput`
(`observations.ts:15-35`): `source` (an `ObservationSource` enum), `producer`,
`platform?`, `accountId?`, `nativeAccountRef?`, `kind`, `payload: unknown`,
`payloadHash: Buffer`, `idempotencyKey`, `observedAt?`, `actorPrincipalId?`, and
`receivedAt?` (used only by tests and bounded backfill; producers never set it).

## 2. Observation producer catalog

Every caller of `insertObservation` (the "Stage 7 producers"), with the
idempotency key each mints:

| # | Source | Producer | Caller (file:line) | Idempotency key |
|---|--------|----------|--------------------|-----------------|
| 1 | `webhook` | `ofapi:webhook` | `ofapi-webhooks.ts:187` — runs inside the same tx as `insertOfapiWebhookEvent`, journals the full envelope, `nativeAccountRef = account_id`, hash over raw bytes | OFAPI idempotency key |
| 2 | `pull` (ok) | `sync:<platform>:<stream>` | `sync/shared.ts:111` (`persistRawPayload` dual-writes raw_payloads + observation) | `<accountId>:<stream>:<runId\|"norun">:<requestSeq\|uuid>` (`shared.ts:119-124`) |
| 3 | `pull` (fail) | `sync:<platform>:<stream>` | `sync/shared.ts:395` (`persistFailedSyncPayload`), kind `<endpoint>:failed` | `<accountId>:<endpoint>:failed:<runId>:<requestSeq\|uuid>` |
| 4 | `command_result` | `ofapi:command-executor` | `ofapi-command-executor.ts:124`, kind `command.<state>` | `cmd:<commandId>:<state>` (dedupes the direct-confirm / webhook-confirm race) |
| 5 | `operator` | `api:admin` | `auth.ts:226` (audit choke-point dual-write), kind = eventType | `op:<uuid>` |
| 6 | `readthrough` | `read-gateway` | `ofapi-read-gateway-capture.ts:95` (async queue drain), kind = operation | `rg:<uuid>` |
| 7 | `client_capture` | `desktop@<ver>` / `desktop-harvest@<ver>` | `ingest-observations.ts:162` | `<principalUserId>:<clientEventId>` (`ingest-observations.ts:170`) |

The `operator` and `readthrough` sources have **no canonicalizer family** (see
§4): they are captured and retained but never turned into domain events.

## 3. The client-capture ingest lane

`ingestClientObservations` (`ingest-observations.ts:89`) is the ingest path for
desktop/harvest client facts; its sole caller is `modules/ingest/index.ts:60`.
Behaviors:

- **Validate-before-write:** every `observedAt` in the batch is parsed first;
  an invalid one raises `InvalidIngestEventError`, which becomes a whole-batch
  400 (`ingest-observations.ts:106`, `:71`).
- **Whole-batch transaction:** the entire batch runs in one `app.db.transaction`
  (`ingest-observations.ts:150`) — atomic. Any failure rolls back every claim
  and the client resends the whole batch.
- **Kind gating** (`ingestKindFor`, `ingest-observations.ts:61`):
  - `INGEST_KIND_ALLOWLIST` (`ai_acceptance`, `guard_audit`, `send_audit`,
    `ai_spend`, `credit_spend`, `data_purge_notice`;
    `ingest-observations.ts:21`) → journaled as prefixed `desktop.<kind>`.
  - `HARVEST_KIND_ALLOWLIST` (`harvest.messages`, `harvest.fan_transactions`,
    `harvest.outbox`, `harvest.message_guard_events`, `harvest.usage_events`,
    `harvest.ai_spend_log`, `harvest.credit_log`;
    `ingest-observations.ts:34`) → journaled **verbatim**, but only when the
    producer is a harvest producer (the `x-client-version` header starts with
    `harvest-`, mapping producer to `desktop-harvest@<ver>`;
    `ingest-observations.ts:47-55`).
  - Everything else → `desktop.unknown:<kind>` (never dropped).
- **Account attribution:** the page label is resolved once per batch via
  `findPageByLabel`, gated by the `allowedPageIds` scope (owner = `null` =
  unrestricted; otherwise `principal.assignedPageIds`;
  `modules/ingest/index.ts:64`). An out-of-scope or unknown label yields a NULL
  account — still journaled, but it can never canonicalize. Harvest events carry
  no label; they resolve by `payload.ofapiAccountId` against
  `pages.ofapi_account_id` through `listOfapiMappedPages`
  (`ingest-observations.ts:141-148`).
- **Hashing:** `payloadHash = sha256(JSON.stringify(payload))`
  (`ingest-observations.ts:169`). The function returns `{accepted, duplicates}`.
- **Route:** `POST /api/v1/ingest/observations` — bearer-only, `bodyLimit`
  1 MiB, `rateLimit` 120/min, requires the `x-client-version` header
  (`modules/ingest/index.ts:39-58`).

## 4. Canonicalization: the minutely replay sweep

The driver in `services/canonicalize-driver.ts` is both the scheduled sweep and
the replay executor (header lines 1-7). Queue `canonicalize.sweep`
(`canonicalize-driver.ts:24`), policy `exclusive`, cron `* * * * *`
(`canonicalize-driver.ts:42`).

- `runCanonicalization` (`canonicalize-driver.ts:176`) iterates
  `CANONICALIZER_FAMILIES` (`:211`) with a per-family try/catch so one family's
  structural failure does not stall the others (`:214-222`).
- A per-run context is built once (`:191-210`):
  `nativeAccountRefByAccountId` (page → its own native ref, used for Fansly DM
  direction) and `accountIdByNativeRef` keyed `<platform>:<ref>` over both the
  `platform_account_id` and `ofapi_account_id` columns (the inverse resolution
  that maps capture-first webhook rows, which journal only the vendor ref, back
  to an account).
- `runFamily` (`canonicalize-driver.ts:77`): keyset pagination by `afterId`,
  `SWEEP_PAGE_SIZE = 200` (`:26`), `SWEEP_MAX_PAGES_PER_FAMILY = 20` (`:27`).
  The version floor is `options.belowParseVersion ?? family.version` (`:95`);
  `listObservationsForReplay` filters `parse_version < belowParseVersion` plus
  source and kinds (`domain-events.ts:271`).
- **Per row** (`canonicalize-driver.ts:115-167`): a fault-isolated try/catch
  means one poison row costs only its own stamp (`afterId` has already
  advanced). `family.canonicalize(row, runContext)` returns drafts. Account
  resolution is
  `row.accountId ?? accountIdByNativeRef.get('<platform>:<nativeAccountRef>')`
  (`:129-132`). If there are drafts but the account is still null, the row is
  counted `skippedUnmapped` and left below the version floor so it self-heals
  once the mapping arrives (`:139-144`). Otherwise
  `appendDomainEvents(db, accountId, drafts + observationId)` runs, then
  `markObservationParsed` applies a forward-only stamp (`:146-160`). Errors are
  counted `errored`, left unstamped, and retried on the next sweep (`:161-167`).
- **Result counters:** `scanned, appended, deduped, stamped, skippedUnmapped,
  errored, maxLagSeconds` (`canonicalize-driver.ts:45-61`).
- The `events:replay` CLI runs the same engine with narrowing filters
  (`kinds / accountId / from / to / belowParseVersion / dryRun`;
  `canonicalize-driver.ts:63-75`).

The registry `CANONICALIZER_FAMILIES` lives at
`services/canonicalize/index.ts:37` (source → kinds → version → fn), with
`familyForObservation` at `:66`. `markObservationParsed`
(`domain-events.ts:333`) is forward-only (guarded by `parse_version < N`). The
pure-function seam between a canonicalizer and the appender is
`CanonicalEventDraft` (`canonicalize/types.ts:18`).

### Canonicalizer families

| Family / file | Source | Version | Input observation kinds → emitted domain-event types (dedupKey) |
|---|---|---|---|
| **ofapi-webhook** (`services/canonicalize/ofapi-webhook.ts`) | `webhook` | 2 (`:18`) | Reads the journaled envelope at `payload.payload` (`:38`). `messages.received` → `message.received`, `msg:received:<msgId>` (`:82`, counterpart = fromUser); `messages.sent` → `message.sent`, `msg:sent:<msgId>` (`:84`, counterpart = toUser); `messages.deleted` → `message.deleted`, `msg:deleted:<msgId>` (`:87`); `messages.ppv.unlocked` → `message.ppv_unlocked`, `ppv:<notificationId>` (`:103`); `tips.received` → `tip.received`, `tip:<notificationId>` (`:132`, tipper = `payload.user.id`; separate NOTIFICATION type so money from `transaction.posted` is never double-counted, `:135-138`); `transactions.new` → `transaction.posted`, `txn:<transactionId>` (`:165`); `subscriptions.new` → `subscription.started`, `sub:started:<fanId>:<occurredAt ISO>` (`:196`); `users.online`/`users.offline` → `presence.online`/`presence.offline`, `presence:<state>:<fanId>:<occurredAt ISO>` (time-series by design, `:220`); `accounts.connected\|reconnected\|session_expired\|authentication_failed\|otp_code_required\|face_otp_required` → `account.auth_changed`, `auth:<status>:<occurredAt ISO>` (`:250`) |
| **sync-pull** (`services/canonicalize/sync-pull.ts`) | `pull` | 3 (`:28`) | Reads journaled page payloads (kind = fetch endpoint), kinds `:38-48`. `earnings_transactions` (fansly) → `transaction.posted` per `data[]` item, `txn:<transactionId>` (`:50-88`); `dm_messages` — onlyfans via `ofapiRestMessages` over `payload.items[]`, `message.received`/`sent` by `isSentByMe`, `msg:<direction>:<msgId>` (key collides with the webhook event **by design** — cross-producer dedup, `:90-131`); fansly via `fanslyDmMessages` over `payload.messages[]`, direction by comparing `senderId` to the page's own native ref from run context, tip in mills, `msg:<direction>:<msgId>` (`:133-182`); `fan_earnings_stats` (fansly) → `fan.earnings_observed` window `lifetime`, `fan_earnings:<fan>:<window>:<stableHash(aggregate)>` (`:196`, `:242`); `fan_earnings_monthly` (fansly) → `fan.earnings_observed` window `YYYY-MM`, same dedup shape (`:198`); `purchase_history` (fansly) → `message.ppv_unlocked`, `ppv:<fan>:<mediaRef>:<occurredAt ISO>` (no order id in the shape, `:308-348`) |
| **command-result** (`services/canonicalize/command-result.ts`) | `command_result` | 1 | `kinds = null` (all, prefix `command.`). Every `command.<state>` → a single `command.settled` (the state travels in `data`), `cmd:<commandId>:<state>` (`:33-46`) |
| **client-capture** (`services/canonicalize/client-capture.ts`) | `client_capture` | 2 (`:27`) | Mostly registration + validation, kinds `:32-50`. Only `harvest.messages` (and only when the producer is harvest, `:108`) emits events via `harvestMessageEvents` (`:55`): `message.<direction>`, `msg:<direction>:<msgId>` (Stage 8 parity, so kernel-seen messages collapse) plus `message.deleted` when `row.deleted` (`:72-97`). All other client kinds (`ai_acceptance`, `guard_audit`, `send_audit`, `ai_spend`, `credit_spend`, `data_purge_notice`, `harvest.fan_transactions`, etc.) emit **zero events by design** (`:101-114`); they stamp `parse_version` and wait for Stage 29 replay |

**Content-hash dedup mechanics** (`stableHash`, `sync-pull.ts:229-238`):
`canonicalJson` makes a deep, key-sorted recursive copy (`:216-227`) so nested
fields like `breakdown[].type` are included, then `JSON.stringify` feeds a
32-bit rolling hash (`hash*31 + charCode`) rendered as hex. It is
order-independent: an unchanged snapshot re-fetch produces the same dedup key
and dedupes to nothing.

## 5. Gapless per-account sequence + content-hash dedup

`appendDomainEvents` (`domain-events.ts:41`, append protocol header 1-9) writes
a canonicalizer's drafts under one account in a single `db.transaction`
(`domain-events.ts:51`):

1. Upsert the `domain_event_seq` row, then `SELECT next_seq ... FOR UPDATE` to
   lock the counter for the whole batch (`:56-60`). Concurrent appenders
   serialize on this lock, so `account_seq` comes out gapless `1..K`.
2. Per event: allocate the identity id (`:66`); claim `(account_id, dedup_key)`
   in `domain_event_keys` with `ON CONFLICT DO NOTHING` (`:71`); a lost claim
   increments `deduped` and `continue`s **without** advancing the sequence
   (`:77-80`); otherwise insert into `domain_events` with
   `OVERRIDING SYSTEM VALUE` and `account_seq = nextSeq` (`:82`), then
   `nextSeq++`.
3. After the batch, if anything was appended:
   `UPDATE domain_event_seq SET next_seq` and, on commit,
   `pg_notify('domain_events_appended', '<accountId>:<nextSeq-1>')` (`:107-118`).

The **dedup key is the content-hash surface** — it is constructed inside each
canonicalizer (see §4); there is no separate payload hash for dedup.

## 6. Domain-event catalog (complete)

Every `type:` literal emitted by a canonicalizer, with the source families that
mint it. No domain events are emitted outside the canonicalizers (broad grep
confirmed).

| Domain-event type | Source families |
|---|---|
| `message.received` | ofapi-webhook, sync-pull, client-capture (harvest) |
| `message.sent` | ofapi-webhook, sync-pull, client-capture (harvest) |
| `message.deleted` | ofapi-webhook, client-capture (harvest) |
| `message.ppv_unlocked` | ofapi-webhook, sync-pull (`purchase_history`) |
| `tip.received` | ofapi-webhook |
| `transaction.posted` | ofapi-webhook, sync-pull (`earnings_transactions`) |
| `subscription.started` | ofapi-webhook |
| `presence.online` | ofapi-webhook |
| `presence.offline` | ofapi-webhook |
| `account.auth_changed` | ofapi-webhook |
| `fan.earnings_observed` | sync-pull (`fan_earnings_stats` / `fan_earnings_monthly`) |
| `command.settled` | command-result |

**Intentional cross-producer dedup:** the OFAPI webhook `messages.*` family, the
OFAPI REST `dm_messages` pull, and desktop `harvest.messages` all mint the dedup
key `msg:<direction>:<id>` on the same platform id space, so the same message
seen by multiple producers collapses to a single domain event
(`sync-pull.ts:5-9`, `client-capture.ts:19-27`).

## 7. Projections (`services/projections/`)

Watermark plumbing is shared: `projection_seq_watermarks(projection,
account_id)`, accessed via `getProjectionWatermark` / `setProjectionWatermark`;
accounts come from `listEventAccounts`; events are read with
`listEventsSince(accountId, afterSeq, limit)`.

- **message-archive** (`projections/message-archive.ts`, Stage 10). Queue
  `projections.message-archive.sweep` (`:21`), cron `* * * * *` (`:43`).
  Consumes `message.received | sent | deleted` (`MESSAGE_EVENT_TYPES`, `:24`).
  Per account it resolves the platform via `getPageTransactionsWriterInfo` (a
  null platform parks the watermark, `:83-87`), pages events (500), filters to
  message types, and runs `applyMessageEventsToArchive({accountId, platform,
  events})` → writing `dm_message_archive` (inserted/tombstoned counts, `:112`)
  and advancing the watermark by `accountSeq`. **Rebuild:**
  `rebuildMessageArchiveProjection` = `resetMessageArchiveProjection` + re-run
  from seq 0 (`:130`). Also `runMessageArchiveBackfills` (`:139`) from two
  idempotent sources (`backfillArchiveFromDmMessageArchive`,
  `backfillArchiveFromHotTable`).
- **fan-earnings** (`projections/fan-earnings.ts`, Stage 16 v3). Projection name
  `fan_earnings_stats` (`:18`). Consumes `fan.earnings_observed` (`:52`).
  Upserts `fans` on demand (platform `fansly`, `platformUserId =
  fanIdentityRef`, `:61`), then
  `upsertFanEarningsStat({accountId, fanId, window, grossMills, netMills,
  observedAt, sourceEventId})` → table `fan_earnings_stats` (`:65`). Per-account
  seq watermark. **Rebuild:** `rebuildFanEarningsProjection` (`:87`) =
  `delete from fan_earnings_stats` (scoped or all) + delete watermark rows +
  re-run. CLI `projection:rebuild fan_earnings_stats`.
- **ai-acceptance** (`projections/ai-acceptance.ts`, Stage 29). Projection
  `ai_acceptance_events` (`:21`). This projection is **not** account-seq driven:
  it walks `desktop.ai_acceptance` observations **by id**
  (`listObservationsByKindAfterId`, `:48`) with the watermark stored under the
  sentinel `account_id = 0` (`:45`, `:99`). Field mapping is tolerant for
  `generationRef` / lifecycle (`:60-68`); `LIFECYCLES = shown | copied |
  inserted | edited | sent` (`:25`). `insertAiAcceptanceEvent` is idempotent on
  `(generation_ref, lifecycle, occurred_at)` plus the watermark (`:73`); a
  companion `edited` row is written when the lifecycle is `sent` and
  `payload.edited` is set (`:85`). Rows without a ref are counted
  `skippedNoRef` and stay in the journal for later replay. There is no rebuild
  function in this file (the re-walk is idempotent).

### Notable invariants / traps

- `operator` and `readthrough` observation sources are captured but have no
  canonicalizer family, so they never become domain events.
- Multiple `ORDER BY` / `::text` alias traps are documented and avoided by
  qualifying columns (`observations.ts:339`, `domain-events.ts:236`).
