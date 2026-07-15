# Stage 11 — Client-capture lane (core side) + desktop hoard upload

**Repo(s):** core (+ desktop — desktop half is Pass 3c's; its interface contract is fixed HERE)
· **Depends on:** 7, 4 (desktop spool base) · **Passport:** roadmap.md §4, stage 11

**Status header.** No deviation. Scope boundary per DP 1-B (owner decision): the extension does
**NOT** mirror Fansly responses — this lane exists for desktop-held facts (acceptance telemetry,
guard-audit events with full text, send audit, AI/credit spend ledgers) and, in Stage 32, the
extension's existing summary/telemetry pushes. This spec covers the **core side** in full and
pins the wire contract the 3c desktop spec must implement verbatim.

## 1. Context

The AI quality loop's raw signal — did the chatter use the suggestion — and the desktop's private
audit trail die on N machines today (review §4.5). Producer 3 (client capture) is the one
genuinely new capture lane in the target: bearer-authenticated, batched, idempotent, size-capped,
rate-limited, spool-backed on the client. Stage 4 (desktop, 3c) made the spool durable; this
stage gives it a kernel endpoint and canonicalizers.

**Entry criteria restated as facts to verify:**
- Stage 7 live (journal + `observation_keys` dedup protocol).
- Stage 4's desktop release confirmed across the fleet (hub telemetry) — the spool exists and no
  longer self-deletes.
- Verified precedent to model on: `POST /api/v1/ai-usage/batch` (`server.ts:694` →
  `ingestAiUsageBatch`, `services/ai-usage.ts:74`; per-event `clientEventId` dedup via
  `onConflictDoNothing(target:[userId, clientEventId])`, `repositories/ai-usage.ts:220-221`;
  batch 1..100, `contracts/src/routes.ts:1767-1768`).

**Deliverable:** `POST /api/v1/ingest/observations` in production; acceptance events from ≥1
production desktop visible end-to-end as observations; idempotent under duplicate upload; polite
backpressure; canonicalizers for the desktop kinds.

## 2. Changes

**core — the endpoint** (`server.ts` + `services/ingest-observations.ts` + contracts):
- `POST /api/v1/ingest/observations` — bearer principal (`requireApiKeyUser`; **must not assume
  device tokens** — they arrive in Stage 22; the handler reads `principal.user.id` whichever
  credential kind resolved it).
- Body (contract in `packages/contracts/src/routes.ts`, house style):
  `{ events: [{ clientEventId: string(uuid), kind: string, observedAt: ISO, payload: object,
  pageLabel?: string }] }`, `events` 1..100, explicit route `bodyLimit` 1 MB (Fastify default
  made explicit), per-route rate limit (`config.rateLimit` pattern of `server.ts:1294`, e.g.
  120/min/principal).
- Each event → one observation: `source='client_capture'`,
  `producer='desktop@<x-client-version header>'` (version header required; extension sets its
  own in Stage 32), `kind='desktop.<kind>'` (allowlisted kind set — unknown kinds are **accepted
  and journaled** with `kind='desktop.unknown:<kind>'`, never dropped: capture-first),
  `account_id` resolved from `pageLabel` when present, `actor_principal_id=principal.user.id`,
  `idempotency_key='<principal.user.id>:<clientEventId>'` — dedup via Stage 7's
  `observation_keys` protocol; duplicates counted and reported in the response
  (`{accepted, duplicates}` — the client may prune its spool on either).
- **Backpressure:** on rate-limit or overload the route replies `429`/`503` with `Retry-After`
  seconds; the client spool absorbs (contract note for 3c: never drop on 4xx/5xx except `400`
  schema-invalid, which goes to the client's exportable quarantine — Stage 4 semantics).
- Initial kind allowlist (canonicalizer-backed): `ai_acceptance` (shown/inserted/edited/sent
  lifecycle), `guard_audit` (full text), `send_audit`, `ai_spend`, `credit_spend`,
  `data_purge_notice`.

**core — canonicalizers (Stage 8 seam, new family `client-capture.ts`):**
- `desktop.ai_acceptance` → the acceptance lifecycle events consumed later by Stage 29's
  restricted class (until then they live as observations + a thin `ai_acceptance_events`
  canonical type in `domain_events`? — **No**: acceptance is not account-scoped platform truth;
  it stays observation-only until Stage 29 defines its home. Record this explicitly: no
  domain_events for desktop kinds in this stage).
- `desktop.send_audit`/`guard_audit`: observation-only; guard-audit text is sensitive → reads
  are owner-only (no read endpoint ships here at all; Stage 29 formalizes the restricted class).
  `desktop.guard_audit` goes on Stage 28's exporter **kind-exclusion list** (restricted lake
  path, stage-28 §2) the moment that exporter exists — full text never lands in the generic lake.
- The canonicalizer family therefore ships as **registration + validation only** (schema-checks
  payloads, stamps parse_version) — deliberate; flag in review.

**desktop — (3c's spec; the contract fixed here):** the Stage 4 durable usage spool generalizes
into the capture uploader (batch ≤100, uuid `clientEventId` per event, resend-until-2xx,
`Retry-After` honored, 400 → quarantine-export); `cmd:data.purge` gets its full target semantics
— purge the device, never the kernel's copy (upload `data_purge_notice` first, wait for 2xx,
then wipe). Ships as the next desktop release on the existing feed (auto-update invariant).

## 3. Schema & data migration

**No schema change** (observations + keys exist from Stage 7). No backfill — the fleet's
*historical* hoard is Stage 12's one-time harvest (deferred-to-3c), which reuses this lane with
`producer='desktop-harvest@<version>'`; this stage's lane definition is what makes that spec
possible. "No data migration" is explicit.

## 4. Client compatibility

- **Desktop:** additive endpoint; nothing breaks if the desktop never calls it (old clients keep
  working). Chatter bearer keys remain the credential (target §14 invariant); device tokens
  (Stage 22) will be accepted by the same route with zero contract change.
- **Extension:** untouched (its summary/telemetry pushes migrate to this lane in Stage 32; its
  current `agency-hub-client` routes keep working).
- **Dashboard:** none. No read surface for captured client events ships here (deliberate —
  guard-audit sensitivity; Stage 29).
- **Workboard:** n/a.

**Compatibility invariants (target §14):** chatter bearer keys — preserved (route accepts them);
no existing contract altered.

## 5. Tests & verification

**New tests:** endpoint integration — batch accepted, observations rows with correct producer/
principal/idempotency; duplicate batch → `duplicates=n`, zero new rows; unknown kind journaled
not dropped; 400 on schema-invalid with no partial writes (whole-batch tx? — no: **per-event**
acceptance with per-event result list would complicate the spool; keep whole-batch atomic +
all-or-nothing 400, matching ai-usage precedent — test asserts atomicity); 429 carries
Retry-After; bearer-only (session cookie → 401? verify: chatter API-key required via
`requireApiKeyUser`, dashboards don't call this).

**Existing suites:** ai-usage batch suite (unchanged — the old lane keeps working until
Stage 29/31 deprecate it).

**Production verification (exit criteria):**
- Acceptance events from ≥1 production desktop visible end-to-end:
  `SELECT count(*) FROM observations WHERE source='client_capture' AND kind='desktop.ai_acceptance'` > 0.
- Simulated 24 h-offline spool drains on reconnect (staging desktop harness — 3c executes,
  result recorded here).
- Duplicate-upload idempotency proven in prod (re-send a drained batch → duplicates=all).
- No unbounded spool growth over a week (fleet telemetry — 3c metric, gate for Stage 12).

## 6. Rollback

- Endpoint removal/disable = clients spool (bounded by Stage 4's no-delete policy → disk-bounded
  on clients; do not leave disabled for weeks). Captured observations stay.
- No migration, no irreversible step.

## 7. Assumptions

1. **Chatter bearer keys are the client credential** until Stage 22; the route must not require
   anything device tokens would add (it doesn't — principal resolution is upstream).
2. **Batch/size numbers** (100 events, 1 MB, 120/min) are starting points sized from the
   ai-usage precedent; tune from fleet telemetry — they are config, not contract.
3. **Whole-batch atomicity** is acceptable to the desktop spool design (3c must implement
   resend-whole-batch; per-event journaling inside the tx is fine because dedup makes overlap
   free).
4. **Guard-audit text is sensitive** — no read path ships until Stage 29's restricted class;
   drift signal: anyone adding a read endpoint before 29 must route it owner-only.
5. **DP 1-B boundary holds**: no Fansly response mirroring lands in this lane; the extension's
   future use (32) is summaries/telemetry only.

## 8. Task breakdown

1. **Contract + endpoint + rate/size caps + backpressure.** Done-check: integration tests incl.
   idempotency + atomicity. *(1 session)*
2. **Kind allowlist + validation canonicalizers (registration-only family).** Done-check: kind
   tests; unknown-kind journaling test. *(0.5 session)*
3. **3c interface memo** — the desktop contract block (§2 desktop bullet) handed to the Stage 4/
   11-desktop/12 specs (Pass 3c) verbatim. Done-check: memo lands in 3c's inputs; no core code.
   *(≤0.2 session)*
4. **(Last) Deploy; production end-to-end check with one desktop; record results here.** *(ops,
   jointly with 3c's desktop release)*

## Progress

- **2026-07-05 (same-day session after Stage 14).** Core side BUILT on the kernel
  chain (8→9→10→16→17→14→11). Ordering deviation, same recorded pattern as #73–#75:
  Stage 7 deployed-not-exited, Stage 4 released-not-exited (0.1.29 on the feed; fleet
  verify pending 07-12 — its data source was itself fixed this session, decision #81).
- Endpoint per §2 exactly: bearer-only (`requireApiKeyUser`), `x-client-version`
  required (400 without), events 1..100, bodyLimit 1 MB, 120/min rate limit,
  whole-batch atomic (pre-validated observedAt → all-or-nothing 400), per-event dedup
  via the Stage 7 key protocol (`<principal>:<clientEventId>`) → `{accepted, duplicates}`.
  Unknown kinds journaled as `desktop.unknown:<kind>` — capture-first, CI-proven.
  Unknown pageLabel → null account (fact kept; no batch failure on a label typo).
- Canonicalizer family `client_capture` registered (6 desktop.* kinds, version 1),
  ZERO domain events BY DESIGN (§2: desktop facts are not account-scoped platform
  truth until Stage 29; the family version is Stage 29's replay hook). Sweep-proven:
  declared kind stamps parse_version 1 with zero events; desktop.unknown stays 0.
- Task 3 memo delivered: `chatgoose_desktop_fable/docs/project-kernel/
  pass3-stage-11-wire-contract.md` (new untracked file — 3c's input, contract verbatim
  + client obligations incl. quarantine-on-400 and purge-notice-before-wipe).
- Exit (ops): deploy with the chain → desktop uploader release (3c/Stage 12 executor)
  → §5 checks: ≥1 prod desktop end-to-end, duplicate re-send all-duplicates, 24 h
  offline drain drill, week of spool telemetry.
