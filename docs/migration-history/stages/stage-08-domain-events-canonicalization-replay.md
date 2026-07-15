# Stage 8 — Domain events, canonicalization, replay

**Repo(s):** core · **Depends on:** 7 · **Passport:** roadmap.md §4, stage 8

**Status header — two design elaborations (flag for sign-off):**
1. **Partitioned-unique constraint** (same as Stage 7's): `UNIQUE (account_id, account_seq)` and
   `UNIQUE (account_id, dedup_key)` cannot live on a table partitioned by `occurred_at`.
   Resolution: `account_seq` is made collision-free by construction (assigned under a per-account
   row lock on a counter table), and dedup is enforced by an unpartitioned companion
   `domain_event_keys (account_id, dedup_key) PK`. The journal table itself partitions monthly.
2. **Partition key = `occurred_at` needs a bound.** Provider timestamps can be arbitrary
   (backfills reach 2024); partitions must exist for the whole historical range. Resolution:
   pre-create historical partitions back to the earliest known fact (2024-01) plus a catch-all
   `MINVALUE` partition; the pre-create job (Stage 7's) manages both tables.

## 1. Context

Observations are provider-native and unqueryable as a vocabulary. This stage adds the canonical
`domain_events` log — the layer the stream (21), workboard (23), archive (10), and analytics (28)
consume — with per-account ordering, cross-producer dedup, and replay from retained observations.
The `tips.received` class of blocker dissolves permanently: capture now, parse later, replay.

**Entry criteria restated as facts to verify:**
- Stage 7 producers live for several days (a real observation corpus:
  `SELECT source, kind, count(*) FROM observations GROUP BY 1,2`).
- Desktop-repo webhook fixtures current (`chatgoose_desktop_fable/tests/fixtures/webhooks/`).
- The worker is still effectively single-lane for OFAPI events
  (`assertOfapiEventWorkerSingleton`, `ofapi-events.ts:376-383`) — multi-worker arrives in
  Stage 25; this stage's serialization must already be correct without relying on that
  singleton (it is: row-lock per account).

**Deliverable:** `domain_events` in production; canonicalizers for all mapped OFAPI webhook kinds
and OnlyFans/Fansly pull-sync observation kinds; gapless per-account `account_seq` under
concurrency; CI-proven cross-producer dedup; an idempotent `events replay` CLI.

## 2. Changes

**core — `packages/db`:** schema (§3); `repositories/domain-events.ts` (`appendDomainEvents`
(batch, one account per call, seq-assigning), `getAccountHighWater`, `listEventsForReplay`,
`listEventsSince(account, seq)`).

**core — canonicalizer seam** (`apps/runtime/src/services/canonicalize/`): one module per
source-family, all pure functions `observation → CanonicalEvent[]`:
- `ofapi-webhook.ts` — from `kind` (= OFAPI event type): `messages.received/sent/deleted` →
  `message.received/sent/deleted` (reuse the parsing already proven in
  `ofapi-dm-archive.ts`/`ofapi-spend-projection-contract.ts` as reference, but the canonicalizer
  reads the **observation** payload); `transactions.new` → `transaction.posted`;
  `messages.ppv.unlocked` → `message.ppv_unlocked`; `accounts.*` → `account.auth_changed`;
  presence kinds → `presence.online/offline`; `tips.received` → `tip.received` **only if the
  live fixture exists** (else the observation waits — the first replay customer).
- `sync-pull.ts` — per stream kind: transactions pages → `transaction.posted` (both platforms),
  subscribers/followers pages → `subscription.*`/`follow.*` + `fan.profile_observed`, DM pages →
  `message.*`, earnings (Stage 16, later) → `fan.earnings_observed`.
- `command-result.ts` — `command.settled`.
- Vocabulary is target §3.2's list, versioned per type (`schema_version`); every canonicalizer
  is **total** over its declared kinds (unknown kind → no events, observation left for a later
  `parse_version`).
- **Dedup keys per type (the one-way-risk table — binding):**
  | type | dedup_key |
  |---|---|
  | message.received/sent/deleted | `msg:<type>:<platform_message_id>` |
  | message.ppv_unlocked | `ppv:<platform_message_id or order_id>` |
  | transaction.posted/adjusted | `txn:<transaction_id>[:adjust-hash]` |
  | tip.received | `tip:<transaction_id ?? message_id>` |
  | subscription.started/renewed/expired/cancelled | `sub:<type>:<fan_native_id>:<period-or-ts>` |
  | follow.started/ended | `follow:<type>:<fan_native_id>:<observed-date>` |
  | presence.online/offline | `presence:<state>:<fan_native_id>:<observed_at ISO>` (time series — never collapses) |
  | fan.profile_observed | `fanprof:<fan_native_id>:<payload_hash>` (only on change) |
  | fan.earnings_observed | `earn:<fan_native_id>:<window>:<payload_hash>` |
  | account.auth_changed | `auth:<status>:<observed_at ISO>` |
  | command.settled | `cmd:<command_id>:<state>` |

**core — canonicalization driver:** post-append hook — after an observation insert commits, a
pg-boss job (`canonicalize.observation`, `singletonKey` = observation id, pattern of
`ofapi-events.ts:262`) runs the matching canonicalizer and appends events. Per-account
serialization happens **inside `appendDomainEvents`** via the counter-row lock (§3), so job
concurrency is safe regardless of queue policy. A minutely sweep (pattern: existing OFAPI sweeps)
picks up observations with `parse_version < current` for their kind — this same sweep IS the
replay executor.

**core — `parse_version` marking:** after a canonicalizer (version `N`) consumes an observation,
stamp `observations.parse_version = N`. Bumping a canonicalizer's version makes the sweep revisit
its kinds — replay is the steady-state mechanism, not a special case.

**core — replay CLI** (`apps/runtime/src/cli.ts`): `events:replay --kind <k> --from --to
[--account] [--parse-version N] [--dry-run]` — re-runs canonicalizers over retained observations;
idempotent via `domain_event_keys` (duplicates append nothing). Prints appended/deduped counts.

**core — NOT here:** no projection is rewired (they keep their current feeds; re-anchoring is
per-projection in Stages 10/23); no stream changes (21); no consumer of `domain_events` ships in
this stage beyond tests.

## 3. Schema & data migration

```sql
-- 00NN_domain_events.sql
CREATE TABLE domain_events (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  account_id       bigint NOT NULL,
  account_seq      bigint NOT NULL,
  type             text NOT NULL,
  occurred_at      timestamptz NOT NULL,
  fan_identity_ref text,                      -- platform-native fan id; platform_identities FK is Stage 18+
  conversation_ref text, message_ref text, transaction_ref text,
  data             jsonb NOT NULL,
  schema_version   int NOT NULL,
  observation_id   bigint NOT NULL,           -- provenance (no FK across partitions; integrity by protocol)
  dedup_key        text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX domain_events_account_seq_idx  ON domain_events (account_id, account_seq);
CREATE INDEX domain_events_type_occurred_idx ON domain_events (type, occurred_at);

CREATE TABLE domain_event_keys (
  account_id bigint NOT NULL, dedup_key text NOT NULL,
  event_id bigint NOT NULL, occurred_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, dedup_key)
);
CREATE TABLE domain_event_seq (
  account_id bigint PRIMARY KEY, next_seq bigint NOT NULL DEFAULT 1
);
```
Append protocol (one tx per account-batch): `SELECT … FROM domain_event_seq WHERE account_id=$1
FOR UPDATE` (upsert row if absent) → for each event: pre-allocate the event id
(`nextval(pg_get_serial_sequence('domain_events','id'))` — gaps from dedups are harmless), then
`INSERT INTO domain_event_keys … ON CONFLICT DO NOTHING` carrying that id; skipped → dedup; else
take `next_seq++`, insert the event with the pre-allocated id (`OVERRIDING SYSTEM VALUE`). Gapless-per-account by
construction under any concurrency. **No data migration/backfill** — events derive from
observations from deploy onward; history arrives via replay as backfill stages land their
observations. Partitions: monthly, pre-created 2024-01 → now+3mo + `MINVALUE` catch-all.

## 4. Client compatibility

- **All clients:** no visible change — nothing consumes `domain_events` yet. SSE v1, gateway,
  outbox untouched.

**Compatibility invariants (target §14):** untouched.

## 5. Tests & verification

**New tests:**
- **Cross-producer dedup (CI headline):** the same DM delivered as a webhook fixture AND as a
  REST-page fixture → two observations, **one** `message.received` event (the passport's binding
  proof).
- `account_seq` gapless under concurrency: N parallel appenders on one account → seq is a
  permutation-free 1..K (integration).
- Replay idempotency: run canonicalization over a fixture corpus twice → identical row counts
  (`events:replay` double-run).
- Per-type dedup-key unit tests over the table in §2 (each type's key built from fixtures).
- Unknown-kind observation → zero events, `parse_version` untouched (capture-now-parse-later).

**Existing suites:** all Stage 7 producer suites; OFAPI projection suites (must be unaffected).

**Production verification (exit criteria):**
- Events derived from live observations for all mapped kinds:
  `SELECT type, count(*) FROM domain_events GROUP BY 1` — every expected type > 0 within days
  (presence/tips depend on real activity; note absences with reasons).
- Replay over a copied production slice on staging: double run → identical counts.
- Canonicalization lag (observation `received_at` → event `created_at`) p95 in seconds, recorded
  as the golden-signal baseline for Stage 25.

## 6. Rollback

- The driver job + sweep are revertable code; tables are additive and inert without consumers.
- A bad canonicalizer is the designed-for case: events are **derived data** at this point — fix,
  bump `schema_version`/parser version, replay; nothing upstream is harmed. (After Stage 10+
  consumers exist, the same recovery is "rebuild the projection after replay".)
- No irreversible step.

## 7. Assumptions

1. **Stage 7's observation kinds/idempotency keys are stable** — canonicalizers key off `kind`.
   Drift signal: a producer renames kinds → sweep finds unparseable rows (visible, not silent).
2. **The dedup-key table above is the contract.** Any change after consumers exist requires a
   versioned migration of `domain_event_keys` — this is THE one-way door; the CI dedup proof
   gates it (passport risk note honored).
3. **Worker topology:** single worker today; the append protocol is already multi-worker-safe
   (row lock), so Stage 25 changes nothing here.
4. **`fans`/identity consolidation not yet done** (platform_identities is Stage 18+): events
   carry platform-native fan refs (`fan_identity_ref` text), never `fans.id` — so identity
   refactors never invalidate the ledger.
5. **`tips.received` fixture status** is whatever Stage 14 found; this stage ships the
   canonicalizer only with a verified fixture.

## 8. Task breakdown

1. **Schema + append protocol + repo + partition wiring.** Done-check: gapless-seq + dedup unit/
   integration tests. *(1 session)*
2. **Canonicalizers: ofapi-webhook family** (+ fixtures from the desktop repo). Done-check:
   per-type unit tests; cross-producer dedup test half 1. *(1 session)*
3. **Canonicalizers: sync-pull families (OnlyFans REST + Fansly) + command-result.** Done-check:
   fixture tests; dedup test half 2 (webhook+REST same DM). *(1–1.5 sessions)*
4. **Driver job + parse_version sweep + `events:replay` CLI.** Done-check: replay idempotency
   test; sweep picks up a version bump. *(1 session)*
5. **(Last) Deploy; days-long type-coverage watch; staging replay drill on a prod slice; record
   results + the lag baseline here.** *(ops)*

## Progress

*Working scratchpad — session 2026-07-05, branch `kernel/stage-08-domain-events` off main@d410573 (= deployed Stage 13). **ORDERING DEVIATION (owner-instructed "do not wait"):** built while Stage 7 is deployed+live but not yet exited (48 h reconciliation lands ~07.07) — the same compression pattern as Stage 7-on-Stage-1 (decision #68). DEPLOY of this stage WAITS for Stage 7's exit; the build is local. Entry criterion "producers live for several days" is relaxed to "producers live + verified" (interim coverage read 02:51 UTC: 13 kinds emitting).*

**§8 checklist:**
- [x] 1. **Schema + append protocol + repo + partitions (08.1, 7392702).** Migration 0057: `domain_events` partitioned monthly by occurred_at, historical range 2024-01..2026-12 + MINVALUE catch-all; companions `domain_event_keys` (PK account_id+dedup_key) + `domain_event_seq` (counter). `appendDomainEvents`: counter row FOR UPDATE for the whole batch → pre-allocated identity ids → key claim ON CONFLICT DO NOTHING → event insert OVERRIDING SYSTEM VALUE; gapless 1..K proven by an 8-way concurrent appender test with overlapping keys. **Trap found & fixed:** ORDER BY with a bare column name resolves to the SELECT's ::text alias → lexicographic sort (looked exactly like seq gaps); qualified column in listEventsSince. The Stage 7 partition job now maintains BOTH ledgers (min lead paged).
- [x] 2. **ofapi-webhook family (08.2, 6f83200).** messages received/sent/deleted, ppv_unlocked (keyed on notification id), transactions.new→transaction.posted, subscriptions.new→subscription.started, presence time series, six accounts.*→account.auth_changed. `tips.received` NOT declared (fixture unverified — spec §7.5); waits at parse_version 0 as the first replay customer. Fixtures vendored from the desktop live-capture corpus into `tests/fixtures/ofapi-webhooks/`.
- [x] 3. **sync-pull + command-result (08.3, 0514cff).** Declared: fansly `earnings_transactions`→transaction.posted per item; OFAPI `dm_messages` items→message.received/sent (REST id = webhook id → keys collide by construction). **CI headline PROVEN:** same DM as webhook + REST page → 2 observations, 1 event, replay appends 0. Deliberately undeclared (journaled, wait at parse_version 0): fansly DM pages (direction needs the page's own Fansly account id — not decidable by a pure function; later version threads a context table), onlymonster pages (vendor retiring, 0 prod rows), subscriber/follower/audience pages (next canonicalizer version). command_result: every `command.<state>`→command.settled.
- [x] 4. **Driver + sweep + replay CLI (08.4).** Minutely `canonicalize.sweep` (exclusive queue) IS the replay executor: walks parse_version < family-version per family (registry dispatch), appends, stamps forward-only; unmapped-account observations skip-and-retry (self-heal when mapping lands); undeclared kinds never stamped. `events:replay --kind --from --to --account --parse-version --dry-run` runs the same engine. Integration test: corpus settles (3 events), second sweep idle, version-bump replay dedupes 100%, dry-run writes nothing. **Elaboration:** no per-observation pg-boss job in this slice — the minutely sweep bounds lag at ≤~60 s, which is the recorded baseline; a hot-path enqueue at the webhook receiver is a later latency optimization if the p95 baseline demands it.
- [ ] 5. Deploy (AFTER Stage 7 exits) + days-long type-coverage watch + staging replay drill + lag baseline record.
