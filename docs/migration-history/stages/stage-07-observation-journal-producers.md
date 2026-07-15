# Stage 7 — Observation journal + server-side producers

**Repo(s):** core · **Depends on:** 1 (retention stand-down deployed) · soft: after 3 ·
**Passport:** roadmap.md §4, stage 7

**Status header — one design elaboration (flag for sign-off):** the target (§3.1) prescribes
`UNIQUE (source, idempotency_key)` on a table `PARTITION BY RANGE (received_at)`. **PostgreSQL
requires unique constraints on partitioned tables to include the partition key** — the target's
constraint cannot be declared as written. This spec resolves it with a companion unpartitioned
key table `observation_keys (source, idempotency_key) PK → observation ref`, inserted in the same
transaction (narrow rows; dedup enforcement + fast duplicate lookup), keeping the journal itself
partitioned. Fallback considered and rejected: widening the unique to include `received_at`
(weakens dedup semantics). Same pattern recurs in Stage 8 for `domain_events` uniques.

## 1. Context

The kernel's worst structural fact: capture is a side effect scattered across handlers, gated by
flags, and scheduled for deletion. This stage creates the universal append-only `observations`
journal and makes every **server-side** producer write it: webhook receivers (producer 1), pull
sync (producer 2), command results (producer 5), operator actions (producer 6). Producers 3
(clients) and 4 (read gateway) are Stages 11 and 9. Journaling is unconditional — no capture
flags, by construction. Nothing consumes the journal yet (Stage 8 canonicalizes); this stage is
pure capture.

**Entry criteria restated as facts to verify:**
- Stage 1 deployed: journal purge inert, raw payloads forever, DM raw persistence live (else the
  ramp destroys what it should be journaling).
- VPS disk headroom re-checked (was 32 GB free of 79 GB on 2026-07-04; volumes are tens of
  MB/day — fine, but confirm) + Stage 1's disk alert armed.
- Partition management validated on a staging copy (create/attach/pre-create job drill).
- Verified at spec time: **no `observations`/`domain_events` table or code exists** (grep clean);
  Postgres is **16** (`docker-compose.yml:3`); migrations run per-file in their own transaction
  under `pg_advisory_lock(31415, 27182)` (`packages/db/src/migrate-runner.ts:10-11,130-138`);
  highest migration is `0051_*`.

**Deliverable:** `observations` in production, partitioned monthly with pre-created partitions +
a loud pre-creation job; all four server-side producer classes writing it; row rate reconciling
against webhook receive rate + sync fetch counts; p95 webhook settle latency unchanged.

## 2. Changes

**core — `packages/db`:** new schema objects (§3); new repository `repositories/observations.ts`
(`insertObservation`, `insertObservations` (batch), `findObservationByKey`, monthly-partition
helpers); `schema.ts` additions follow the house style (pgTable + second-arg index callback).

**core — producer 1, webhook receiver** (`services/ofapi-webhooks.ts`): inside
`receiveOfapiWebhook` (`:104`), after HMAC verify (`verifyOfapiSignature` `:74-86`, rotation
grace `:120-129`) and in the **same transaction** as `insertOfapiWebhookEvent` (`:158`): insert
the observation — `source='webhook'`, `producer='ofapi:webhook'`, `platform='onlyfans'`,
`native_account_ref=<ofapi account id>`, `kind=<event_type>`, `payload` = the full envelope,
`idempotency_key` = the `x-ofapi-idempotency-key` header (the existing dedup key),
`payload_hash=sha256(rawBody)`. Duplicate key → the existing duplicate ack path (`:176`) — one
observation per delivery attempt is NOT kept (same idempotent delivery, same fact).
`ofapi_webhook_events` continues serving all its consumers unchanged — **no cutover**; it retires
with stream v1 in Stage 25.

**core — producer 2, pull sync** (`services/sync/shared.ts` + handlers): `persistRawPayload`
(`shared.ts:73`, repo `insertRawPayload` `sync.ts:626`) becomes a dual-writer: every call also
inserts an observation — `source='pull'`, `producer='sync:<platform>:<stream>'`,
`account_id=pageId`, `kind=<endpoint template>`, `idempotency_key='<pageId>:<stream>:<runId>:<requestSeq>'`
(unique per fetch by construction), payload untrimmed. Then **audit every fetch site** so each
fetched response page passes through it — verified today it is called only from the
mapping-critical/DM sites; the gap list per handler (`executeLightChunk` `:949`,
`executeTopSpendersChunk` (DB-only — no fetch, skip), `executeTransactionsChunk` `:1509`,
`executeSubscribersChunk` `:1586`, `executeFollowersChunk` `:1841`, `executeFollowersReconcileChunk`
`:2107`, `executeDmConversationsChunk` `:2695`, `executeDmMessagesChunk` `:3514`,
`executeFanIdentitiesChunk` `:1476`, plus `ofapi-dm-sync.ts` REST paths and
`ofapi-audience-sync.ts`) is enumerated at execution; each fetch gains the persist call.
**Trimming ban honored:** the Fansly follower trim-to-three-fields stays in the *projection*
write; the observation keeps the whole response (target §3.1 rule 3).

**core — producer 5, command results** (`services/ofapi-command-executor.ts`): at every
`finalizeOfapiCommand` call site — success `:284-291`, failure `:300-312`, webhook-confirm
`verifyOfapiCommandFromSentWebhook` `:466-477` — emit a `command_result` observation:
`source='command_result'`, `producer='ofapi:command-executor'`, `kind='command.<state>'`,
payload = request summary + outcome (the payload the outbox already holds; Stage 1 stopped its
redaction), `idempotency_key='cmd:<commandId>:<state>'`, `actor_principal_id` = the command's
`chatter_user_id`.

**core — producer 6, operator actions** (`apps/runtime/src/api/server.ts` admin routes): extend
the existing audit choke point — admin mutations already write `audit_events` via
`auditCtx(principal)`/`insertAuditEvent` (e.g. `server.ts:2410,2419,2431`) — to dual-write an
observation: `source='operator'`, `producer='api:admin'`, `kind=<audit event type>`,
`actor_principal_id` = the acting user. Routes not yet audited (verified gaps: sync triggers
`:2545/:2562/:2576`, blocks reset `:2606`, credentials PATCH `:2888`, config PATCH `:3191`,
staged `:3280` — check each) gain the audit call, which now feeds both.

**core — partition management:** partitions pre-created **3 months ahead** by a scheduled job
(pattern: `boss.schedule` like `worker-services.ts:141`), with an incident
(`notification-incidents` machinery) if pre-creation fails or the lead shrinks below 2 months.
Missing-partition inserts fail loudly (Postgres errors → webhook returns 5xx → vendor retries;
sync chunk fails and retries) — **never a silent drop**.

**core — config:** none. No capture flags, by construction. (The only knob is the partition
pre-create lead, a code constant.)

## 3. Schema & data migration

```sql
-- 00NN_observations.sql
CREATE TABLE observations (
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  source             text NOT NULL CHECK (source IN
                       ('webhook','pull','client_capture','readthrough','command_result','operator')),
  producer           text NOT NULL,
  platform           text,                    -- FK → platforms.key from Stage 18; plain text until then
  account_id         bigint,                  -- nullable BY DESIGN: unmapped accounts captured
  native_account_ref text,
  kind               text NOT NULL,
  payload            jsonb NOT NULL,
  payload_hash       bytea NOT NULL,
  idempotency_key    text NOT NULL,
  observed_at        timestamptz,
  received_at        timestamptz NOT NULL DEFAULT now(),
  actor_principal_id bigint,
  parse_version      int NOT NULL DEFAULT 0,
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);
-- monthly partitions observations_YYYY_MM, pre-created; indexes per partition via the parent:
CREATE INDEX observations_account_received_idx ON observations (account_id, received_at);
CREATE INDEX observations_kind_received_idx    ON observations (kind, received_at);
CREATE INDEX observations_parse_idx            ON observations (parse_version, received_at);

-- dedup companion (unpartitioned; see Status header):
CREATE TABLE observation_keys (
  source          text NOT NULL,
  idempotency_key text NOT NULL,
  observation_id  bigint NOT NULL,
  received_at     timestamptz NOT NULL,
  PRIMARY KEY (source, idempotency_key)
);
```
Insert protocol (one tx): pre-allocate the id — `SELECT
nextval(pg_get_serial_sequence('observations','id'))` (identity gaps from duplicates are
harmless) — then `INSERT INTO observation_keys … ON CONFLICT DO NOTHING` carrying that id: zero
rows → duplicate, return the existing ref (no journal write, no rollback — composable inside the
webhook receiver's transaction); else insert the journal row with the pre-allocated id
(`OVERRIDING SYSTEM VALUE`; the column is GENERATED ALWAYS). `account_id` deliberately has **no
FK** (unmapped accounts + Stage 13 tombstones make RESTRICT/CASCADE both wrong; integrity is the
insert protocol's job). **No backfill** — history enters the ledger via Stages 10/12/14/17
mechanisms; the journal starts at deploy time (the point of Stage 1 was to stop losses until
now). "No data migration" is explicit.

## 4. Client compatibility

- **Desktop / extension / dashboard / workboard:** no visible change anywhere. SSE, gateway,
  outbox, all reads/writes untouched — this stage only adds writes on the server side.

**Compatibility invariants (target §14):** all preserved trivially; nothing consumer-facing
changes. The one latency-sensitive path — webhook receive — gains one bounded INSERT inside the
existing transaction; §5 measures it.

## 5. Tests & verification

**New tests:**
- Repo unit: insert protocol dedup (same (source,key) twice → one row, duplicate signaled);
  missing-partition insert raises (create a gap on purpose in a test DB).
- Integration (Testcontainers, patterns of `tests/ofapi-webhook.integration.test.ts`): a webhook
  delivery produces journal row + observation atomically; an **unmapped-account** webhook
  (settles `skipped` at `ofapi-events.ts:298-306`) still produces a retained observation — the
  headline test of the stage.
- Integration: a sync chunk (fixture) produces one observation per fetched page with the
  documented idempotency key; re-delivery of the same webhook produces no second observation.
- Command settle + admin mutation each produce their observation (integration).

**Existing suites:** webhook receiver, sync executor, command executor, admin API suites — all
must stay green (no behavior change).

**Production verification (exit criteria):**
- Row-rate reconciliation over 48 h: `observations WHERE source='webhook'` count ≈
  `ofapi_webhook_events` received count; `source='pull'` count ≈ sum of per-run fetch counters
  (`sync_runs.stats`), within a stated tolerance (retries produce extra observations — expected,
  distinct keys).
- Every producer class has ≥1 production row within 48 h:
  `SELECT source, count(*) FROM observations GROUP BY 1`.
- p95 webhook settle latency unchanged vs a pre-deploy baseline (from `sync_http_attempts`-style
  timings / receiver logs) — measure before and after on staging under load, then confirm in
  prod.
- Partition pre-create job ran and an induced failure drill pages (staging).

## 6. Rollback

- Producers are individually revertable code changes; the table is additive. Rolling back a
  producer stops *new* capture only — already-captured observations stay (never delete capture).
- No migration down-path is provided for the tables (dropping a fact ledger is an owner-gated
  erasure, not a rollback). If the stage must be aborted wholesale, disable producer call sites
  by revert-deploy; the empty/partial journal is inert.
- **No irreversible step** — additive schema + additive writes only.

## 7. Assumptions

1. **Stage 1 still in effect** (nothing expires while the journal ramps). Drift signal: journal
   purge deleting rows again (`ofapiEventRetentionDays` shrunk).
2. **Volumes ≈ Pass 2 estimates** (tens of MB/day; 1M obs/day at 10× is the design ceiling —
   target §3.4). Containment: Stage 1's disk alert; partitioning keeps the hot set manageable.
3. **Postgres 16 remains the single stateful store** — no new infra (target §5.4). Partitioned
   tables + identity PK including the partition key behave as spec'd on PG 16 (validated in the
   staging drill).
4. **The webhook receiver's HMAC-then-journal discipline** (`ofapi-webhooks.ts:104-190`) is
   unchanged by other in-flight stages when this executes.
5. **`sync_runs.stats` fetch counters exist per stream** for the reconciliation check (they are
   free-form JSONB — `schema.ts:319`; the executioner confirms which counters each handler
   emits and pins the reconciliation query accordingly).
6. **The `platforms` reference table does not exist yet** (Stage 18) — `observations.platform`
   is plain text until then; Stage 18 adds the FK.

## 8. Task breakdown

1. **Schema + repo + insert protocol + partition pre-create job + drill.** Done-check: repo unit
   tests; staging partition drill (incl. induced-failure alert). *(1 session)*
2. **Producer 1 (webhook dual-write).** Done-check: atomicity + unmapped-account integration
   tests; settle-latency staging measurement recorded. *(0.5–1 session)*
3. **Producer 2 (persistRawPayload dual-write + fetch-site audit/gap-fill).** Done-check:
   per-stream integration fixtures produce observations; gap list recorded in the PR. *(1–1.5
   sessions)*
4. **Producers 5 + 6 (command results + operator via the audit choke point, incl. audit-gap
   routes).** Done-check: integration tests. *(0.5–1 session)* *(parallel with 3)*
5. **(Last) Deploy; 48 h reconciliation + producer-coverage queries + p95 check; record results
   here.** *(ops)*

---

## Progress

*Working scratchpad — session 2026-07-05 (same owner-authorized compressed run as Stages 1/2/3/5), branch `kernel/stage-07-observation-journal` off main@e696cde. Stage 1 dep: deployed 00:00 UTC (exit formality lands 02:36 — recorded ordering deviation, owner-instructed).*

**Pre-flight verified:** PG 16; migrate-runner per-file tx + advisory lock (31415,27182); no prior observations code; next migration = **0054** (spec said 0051-era); disk 31.3 GiB free + disk alert proven live; schema-guard is a readiness check (partition-safe).

**§8 checklist:**
- [x] 1. Schema + repo + protocol + partition job (548d4bb) — migration 0054 (partitioned observations, identity PK incl. partition key, observation_keys companion, 2026-07..2026-12 partitions, `observations_partitions` incident kind); insert protocol with two hardenings found by tests: received_at stamped ONCE in JS (autocommit callers got split now() otherwise → key↔row join broke) and failed journal insert releases exactly its own key claim (orphaned claim would turn producer retries into false duplicates = lost fact); daily 03:10 UTC pre-create job, 3-month lead, pages below 2; 8 tests green.
- [x] 2. Producer 1 webhook dual-write (f29c5bf) — same-tx journal+observation, duplicate keeps one, unmapped-account headline test green.
- [~] 3. Producer 2 — SLICE 3a DONE (575ca76): persistRawPayload dual-writes pull observations (loud failure = chunk retries), platform tagged at all 7 existing call sites, integration proof on the OFAPI DM path (2 fetches → 2 observations, distinct keys). 3b-1 (139931c): all six transaction/chargeback persists platform-tagged (money streams covered). 3b-2 (see commit): top-spender windows x2, OM recent-chat-ids + head probes, group detail, DM head repair, light metadata x2 (both platforms), failed-payload observations. REMAINING 3b-3: Design: shared.ts persistRawPayload inserts observation after insertRawPayload — source='pull', producer=`sync:<platform>:<stream>` (platform passed by callers via options; stream+requestSeq from getPageSyncExecutionContext), kind=endpoint, idempotency_key=`<pageId>:<stream>:<runId>:<requestSeq>` (uuid fallback when context absent — retries with distinct keys are expected per spec §5). GAP LIST to audit (fetch sites without persist today): probeFanslyAccountResolution (executor-handlers ~:393, needs pageId threaded into the helper), fan-hydration.ts:62 getAccountsByIdsPage (same), executeFanIdentitiesChunk fetch (locate — fan_identities stream), OM aux fetches in onlyfans-transactions.ts (getTrackingLinkUsersPage/getTrialLinkUsersPage — transactions+chargebacks already persist), ofapi-dm-sync listChats (bootstrap/reconcile chat pages), ofapi-audience-sync.ts OFAPI list fetches. NB: light + transactions turned out already covered (light = refreshPageMetadata in shared.ts, now persisting; transactions = services/sync/transactions.ts + onlyfans-transactions.ts, already persisting — the spec's gap list was partly stale). Trimming ban: observation keeps the WHOLE response (trim stays in projections).
- [~] 4. Producers 5+6 — SLICE 4a DONE (738d957): command_result observations at all three finalize sites (best-effort after finalize commit — outcome already permanent in ofapi_commands; cmd:<id>:<state> keys dedupe the confirm race) + operator observations at the recordAudit choke point (UUID keys; atomic inside caller transactions); integration tests green. REMAINING 4b: add recordAudit (now dual-writing) to the six unaudited admin routes — sync triggers ~:2545/:2562/:2576, blocks reset ~:2606, credentials PATCH ~:2888, config PATCH ~:3191, staged ~:3280.
- [ ] 5. Deploy + 48 h reconciliation (row rate vs webhook receive + sync fetch counters), producer coverage query, p95 settle latency check (ops).

**Phase A close-out pending at 02:36 UTC** (background waiter): V1 journal survival + V2 counts vs snapshot (29,765 conversations, scratchpad/v2-baseline.txt) + would-deny recount + Stage 3 V5 read-gateway log check → flip Stages 1/2/3/5 to exited + decisions #68.

**Suite verdict 2026-07-05 01:19 UTC:** full `pnpm test` **168 files / 1413 passed / 0 failed** on branch tip 6433049 (after the collateral-fix slice: full-2026 partitions for clock-frozen fixtures; compensation swallows its own aborted-tx failure and rethrows the cause; auth unit mock factories gained insertObservation). Commits: 548d4bb → f29c5bf → 575ca76 → 738d957 → 6433049.

**3b-2/3b-3 landed (cce93dd, 36a0a90):** +8 fetch sites captured (top-spender windows x2, OM recent-chat-ids + head probes, group detail, DM head repair, light metadata both platforms) + failed-fetch observations; observed payload normalizes undefined→JSON null; suite 1413/1413 on 36a0a90.

**DEPLOYED 2026-07-05 01:50 UTC** (owner-authorized second deploy; main@1a06b5d): migration 0054 applied, 12 partitions, all containers healthy. First-minutes coverage: webhook 16, pull 9 (fansly dm_conversations/subscribers/light + onlyfans dm_messages). command_result/operator appear with the next command/admin action. Exit = 48 h row-rate reconciliation vs webhook receive + sync fetch counters, producer-coverage query all-sources>0, p95 settle check. Remaining build: 3b tail + 4b (mapped above) — deployable independently.

**3b tail + 4b BUILT (session 2026-07-05, after the desktop reconciliation interlude):**
- **3b tail — all six gap groups captured.** (1) `lookupHydratedFans` gained an optional `capture` context (`HydrationCaptureContext`) and persists every `account_lookup` chunk (mapping_critical); threaded from all three callers: subscribers hydration, follower hydration ×2 (via `hydrateFanslyFollowerRows`, capture now required), and Fansly transactions hydration (`persistFanslyTransactionsPage` input gained `syncRunId`). (2) `probeFanslyAccountResolution` takes a mandatory capture param — restructured so only the fetch is best-effort ("unknown" verdict); the journal write sits OUTSIDE the catch and stays loud; both callers (unresolvable-exclusion clear + dm_messages failure-streak) pass page+run. (3+4) tracking/trial link-users pages persist in `onlyfans-identities.ts` (the gap list's "onlyfans-transactions.ts" guess was stale — those fetches live in the fan_identities stream): endpoint = phase name, ONLYMONSTER_MAPPER_VERSION, mapping_critical. (5) OFAPI `listChats` pages persist as `dm_conversations` (dm_metadata, `{items}` — no raw envelope on the OFAPI client, same as the shipped listChatMessages capture). (6) OFAPI `listActiveFans` pages persist as `fans_active` (mapping_critical, local `OFAPI_AUDIENCE_MAPPER_VERSION = "ofapi-audience-rest-v1"`).
- **4b — TEN admin routes now audit through `recordAudit`** (exported from auth.ts; each call = audit row + operator observation): sync trigger / trigger-all / blocks-trigger, blocks pause / resume / reset (pause+resume added beyond the six-route list — same family, same producer-6 goal), credentials PATCH (field NAMES only — values never reach the audit row), config PATCH (`admin.config_update`, keys+versions+auditNote), config DELETE (`admin.config_clear`), staged PATCH (`admin.config_staged_update`, keys+desired+ack note). The config routes' pre-existing `config_audit` trail is unchanged; the operator observation is additive.
- **Test collateral:** `tests/onlyfans-identities.test.ts` closed mock factory gained `insertRawPayload`+`insertObservation`, plus pin assertions (per-page capture, endpoint names, 2 observations); `tests/ofapi-dm-sync.integration.test.ts` observation query scoped to `kind='dm_messages'` + new positive pin that the bootstrap chats walk journals `dm_conversations` pull observations.

**Suite verdict 2026-07-05 ~02:40 UTC:** full `pnpm test` **168 files / 1413 tests / 0 failed** on stage-branch tip **5c69c9c** (`Stage 07.3b-4+4b`). NB an intermediate run showed a phantom `admin-config-staged-api` failure — Testcontainers port-bind timeout from two suites running concurrently, not code; passes in isolation and in the clean final run. **Build COMPLETE — §8 items 1–4 all done.**

**SLICE DEPLOYED 2026-07-05 ~02:47 UTC** (owner-confirmed via AskUserQuestion "Deploy now"): main fast-forwarded to 5c69c9c and `scripts/deploy-production.sh --mode dist-only` ran clean — postgres/api/worker recreated healthy, `/api/v1/health` + `/api/v1/health/sync` 200, same-origin dashboard verified. No migration in this slice. ALL Stage 7 producers are now live in prod; **main pushed to origin (1a06b5d..5c69c9c) — prod = origin = local.** Interim coverage read (02:51 UTC, owner-approved SELECT): 13 kinds emitting — the new `dm_conversations` capture is already the top pull producer (116 rows in minutes); `fans_active`/identity kinds await their daily sweeps, `command_result`/`operator` await the next command/admin action (schedule-bound, not defects). Remaining = §8 item 5 only: 48 h reconciliation (clock from the 01:50 UTC journal deploy ≈ 2026-07-07 morning), producer-coverage query all-sources>0, p95 settle latency.
