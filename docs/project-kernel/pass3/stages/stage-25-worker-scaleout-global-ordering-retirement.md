# Stage 25 — Worker scale-out; global-ordering retirement

**Repo(s):** core · **Depends on:** 24 (desktop off v1), 8 · **Passport:** roadmap.md §4,
stage 25

**Status header — one verified calibration:** the "asserted-single-replica worker" is narrower
than the passport reads: only the **OFAPI event sub-service** asserts it
(`assertOfapiEventWorkerSingleton`, `ofapi-events.ts:376-383`, `OFAPI_EVENT_WORKER_REPLICAS`
must be 1, registry note "unsupported until the event fanout design is redesigned for HA" —
`config-registry.ts:167`; advisory lock ns 58211 — `:392-418`). Everything else in the worker is
already lock/singleton-key coordinated per page. That assertion + the global `fanout_seq` + the
stream-v1 serving role are one deletable unit once the desktop is off v1. Also verified: there
is **no scheduler role** today — cron is registered by whatever worker boots
(`boss.schedule` calls in `worker-services.ts:139-148`, `sync-queue.ts:111-152`, etc.;
`resolveRole` accepts only `api|worker`, `startup.ts:35-42`); pg-boss `^12.14.0`
(`package.json:60`).

## 1. Context

Capture latency is capped by one process: the OFAPI event worker is a structural singleton
because `fanout_seq` (global settle-ordered sequence, `repositories/ofapi.ts:96-97`) demands a
single settle lane. Stage 8 made ordering per-account (`domain_event_seq` row locks — already
multi-worker-safe); Stage 21 gave clients a per-account stream; Stage 24 moved the desktop onto
it. This stage scales workers horizontally, formalizes a scheduler leader, retires v1 + the
global sequence, and makes the five golden signals first-class — they are the acceptance
instrument.

**Entry criteria restated as facts to verify:**
- Desktop v1 SSE connection count = 0 for a week (server metrics on `GET /api/v1/events/stream`).
- Consumer inventory of v1 + `fanout_seq` + `ofapi_webhook_events.sync_event` proves zero
  remaining consumers (grep all repos; anything found = blocker).
- Golden-signal baselines recorded on the singleton topology (Stage 8's canonicalization-lag
  baseline + fresh capture/projection/command/SSE numbers — §5's queries, run BEFORE).
- pg-boss group/singleton semantics under multi-worker verified for the pinned version (a
  staging two-worker soak with singleton-keyed jobs — the passport's explicit assumption check).

**Deliverable:** ≥2 workers in production; scheduler leader elected with stateless standby;
ordering property tests + kill-a-worker chaos check green; v1 stream + `fanout_seq` + the
singleton assertion deleted; golden signals exported and alertable.

## 2. Changes

**core — scheduler role:** `resolveRole` (`startup.ts:35-42`) gains `scheduler`; ALL
`boss.schedule` registrations move from worker boot into a scheduler-only path
(`worker-services.ts:139-148`, `sync-queue.ts:111-152`, `ofapi-events.ts:251-252`,
`ofapi-credits.ts:431-433`, `ofapi-command-executor.ts:113`, `ofapi-dm-analytics.ts:49`); leader
election = a session advisory lock (`pg_try_advisory_lock`, new namespace) held by the active
scheduler; standby boots, fails to acquire, retries on interval (stateless). Compose gains the
`scheduler` service (1 active + optional standby); `docker-compose.production.yml` worker service
gains `deploy`-level scale (or duplicated service entries `worker-1/worker-2` — compose-file
mechanics decided at execution).

**core — canonicalization/projection partitioning by account:** the Stage 8 driver's jobs adopt
`singletonKey=<accountId>` group semantics where ordering matters (append protocol is already
row-lock-safe; the singleton key reduces lock contention, not correctness); projection consumers
(archive writer, workboard recompute) already per-account/per-fan singleton-keyed — verify each
consumer's key at execution and record the matrix.

**core — retire the global order (one deletable unit, LAST):**
- v1 SSE endpoints (`server.ts:1346,1542`) + `createSyncEventHub` (`events-stream.ts`) +
  `OFAPI_SYNC_EVENT_CHANNEL` NOTIFY (`ofapi-events.ts:66,341`) removed;
- `settleOfapiWebhookEvent` stops assigning `fanout_seq` (`ofapi.ts:96-98`); the sequence +
  partial unique indexes dropped (migration); `sync_event` column stops being written (journal
  row settles processed/skipped as today — `ofapi_webhook_events` remains the OFAPI-specific
  receive journal; its full retirement into pure-observations is a later cleanup, noted, not
  forced here);
- `assertOfapiEventWorkerSingleton` + `OFAPI_EVENT_WORKER_REPLICAS` + lock (`ofapi-events.ts:73-74,
  376-418`) deleted — event processing scales by `singletonKey=<eventId>` + per-account append
  locks.

**core — golden signals (the acceptance instrument):** a metrics module (ops) computing the five
lags — capture (webhook `received_at` → observation), canonicalization (observation →
`domain_events.created_at`), projection (event → watermark advance), command settle
(enqueue → `finalizeOfapiCommand`), SSE delivery (append → smoke-consumer receipt, Stage 21's
counters) — sampled minutely into an ops table + served at `GET /api/v1/ops/metrics`
(owner/monitoring-token) + threshold alerts via the existing incident machinery (Telegram).
Prometheus export is explicitly out of scope (none exists today — verified); the endpoint's JSON
is the export format until the family needs more.

## 3. Schema & data migration

```sql
-- 00NN_retire_fanout_seq.sql   (ships LAST, after the consumer-zero proof)
DROP INDEX IF EXISTS ofapi_webhook_events_fanout_seq_uniq;
DROP INDEX IF EXISTS ofapi_webhook_events_replay_idx;
ALTER TABLE ofapi_webhook_events DROP COLUMN fanout_seq, DROP COLUMN sync_event;
DROP SEQUENCE IF EXISTS ofapi_webhook_events_fanout_seq;
-- 00NN_ops_metrics.sql: golden-signal sample table (ops-class, bounded retention per Stage 28)
CREATE TABLE ops_metric_samples (
  id bigserial PRIMARY KEY, metric text NOT NULL, value_ms bigint NOT NULL,
  quantile text NOT NULL, sampled_at timestamptz NOT NULL DEFAULT now()
);
```
No data migration. The column drops are the stage's only destructive DDL — gated on the
consumer-zero proof + owner go (passport rule 5: contracts retire only after their last consumer
migrates).

## 4. Client compatibility

- **Desktop:** already on v2 (Stage 24) — v1 removal is invisible; its rollout-window v1
  fallback flag must be past its window (entry criterion re-check).
- **Extension / dashboard:** never consumed v1 bearer-SSE (dashboard polls until 33) — no
  effect.
- **Workboard:** v2-only world is its substrate.

**Compatibility invariants (target §14):** the v1 SSE invariant **retires here, by the book** —
consumers named (desktop), migration verified (24), then removal. Everything else untouched.

## 5. Tests & verification

**New tests:** ordering property tests — N workers × M accounts × concurrent appends → per-account
seq gapless and per-account delivery ordered (extends Stage 8's proof to multi-process in a
Testcontainers harness); scheduler leader election (kill the leader → standby takes over within
the retry interval; no double-fired cron in the overlap — assert via job-run uniqueness);
kill-one-worker chaos check mid-load → no gaps, no duplicates (seq + dedup proofs re-run under
churn); golden-signal computation unit tests.

**Existing suites:** full integration suite green on a 2-worker topology (CI adds a
multi-worker variant for the sync-critical subset).

**Production verification (exit criteria):**
- ≥2 workers live (`runtime_instances` roles + `last_seen_at`); scheduler leader + standby
  visible.
- Staging 5× synthetic load: all five lag p95s ≤ singleton baseline (recorded numbers side by
  side).
- Chaos drill executed on staging (documented) and a controlled worker restart in prod shows no
  gap/duplicate on the smoke consumer.
- v1 code deleted; `fanout_seq` columns gone; alerts armed on the five signals.

## 6. Rollback

- Scale-out is compose-level: drop back to one worker instantly; scheduler role reverts to
  worker-registered cron by redeploying the prior image (schedules are idempotent upserts).
- The retirement migration is the point of no return for v1 — it ships last, separately, after
  a soak on the new topology, under explicit owner go. Until it ships, v1 can be re-enabled by
  revert-deploy.

## 7. Assumptions

1. **Postgres write throughput has headroom** at these volumes (tens of MB/day today; the 10×
   ceiling is far from PG16 limits on this hardware — re-verify with `pg_stat` numbers at
   execution and record them).
2. **pg-boss `^12.14.0` singleton/group semantics hold under multi-worker** — the staging soak
   is the proof, not the changelog.
3. **Stage 24 shipped and soaked**; the desktop's v1-fallback window is closed.
4. **In-memory login backoff** (Stage 22 note) is per-instance — acceptable with N api replicas?
   This stage scales *workers* only; api replica count is unchanged. Note for any future api
   scale-out.
5. **`ofapi_webhook_events` keeps serving** as the OFAPI receive journal (projections/archive
   bookkeeping columns still consumed by #49/#52 paths) — only its *fan-out* role dies here.

## 8. Task breakdown

1. **Scheduler role + leader election + compose topology.** *(1 session)*
2. **Multi-worker ordering property harness + chaos test (staging).** *(1 session)*
3. **Golden-signal module + endpoint + alerts + baselines.** *(1 session)* *(parallel with 1)*
4. **Consumer-zero proof sweep + singleton-assertion removal + 2-worker prod rollout + soak.**
   *(0.5–1 session)*
5. **(Last, owner-gated) v1 + fanout_seq retirement migration; post-drop verification; record
   everything here.** *(ops)*

## Progress

**Session 1 (2026-07-06, chain branch `kernel/stage-21-event-stream-v2` continued — Stage 25
commits 077aa08/60110cd/98d4819/e76c866 after Stage 24's core enablers; ordering deviation per
the standing owner "continue": Stage 24 is green-local, not fleet-soaked, so ONLY tasks 1–3
built; the retirement unit stays untouched):**

§8 checklist — **Tasks 1–3 BUILT** (decision #96). Suite after the last commit:
**191 files / 1538 tests**. Migration **0067**.

- [x] **Task 1** (077aa08 + fix e76c866) — scheduler role: resolveRole gains 'scheduler';
  services/schedules.ts is the ONE cron home, called only by the leader-elected scheduler
  runtime (session advisory lock ns 58212; stateless standby retries 10 s; leadership loss =
  immediate exit). Workers + api construct pg-boss with `schedule: false` (v12 default fires
  cron from ANY instance — verified in the pinned source); the scheduler also creates queues
  (idempotent, fresh-env boot-order-proof). Compose: scheduler service added; worker-2
  scale-out documented inline for Task 4. Leader-election integration tests (single leader,
  takeover on release, loud loss on backend termination, clean standby stop). Full-suite
  find: a terminated lock session left its client checked out → pool.end() hang; onDeath now
  destroys the corpse.
- [x] **Task 2** (60110cd) — multi-worker ordering property harness: 3 racing sweep runners ×
  3 accounts over a growing corpus; per-account seq gapless 1..K + dedup collapse hold,
  including a runner dying mid-load. Staging chaos drill (real processes) = Task 4 ops.
- [x] **Task 3** (98d4819) — golden signals: 0067 ops_metric_samples + golden_signal_lag
  incident kind (pg enum + contracts + title map); five lags sampled minutely (trailing
  10-min window, p50/p95): capture, canonicalize, projection (backlog age above watermarks),
  command_settle, sse_delivery = smoke-checkpoint staleness (RECORDED INTERPRETATION — no
  per-frame receipt stamps exist by design). Thresholds (capture 60 s / canonicalize 180 s /
  projection 180 s / command 300 s / sse 600 s, p95) flip the incident latch;
  GET /api/v1/ops/metrics (monitoring gate; requireSyncHealthAccess) serves series +
  thresholds + smoke counters. Cron on the scheduler; sample job on workers.
- [ ] **Task 4 (ops-gated)** — BEFORE rollout: record singleton-topology baselines from
  /api/v1/ops/metrics; staging 2-worker soak + kill-a-worker chaos drill; consumer-zero
  sweep (grep all repos for v1 SSE, fanout_seq, sync_event consumers — desktop must be
  fleet-confirmed off v1 per Stage 24 §5); then delete assertOfapiEventWorkerSingleton +
  OFAPI_EVENT_WORKER_REPLICAS + lock ns 58211 and roll prod to 2 workers + scheduler
  (+ standby), watching the five signals against the recorded baselines.
- [ ] **Task 5 (owner-gated, LAST)** — retirement migration: v1 SSE endpoints +
  createSyncEventHub + OFAPI_SYNC_EVENT_CHANNEL + fanout_seq assignment deleted; DROP
  fanout_seq/sync_event columns + sequence + indexes. NOTE ADDED IN STAGE 24: the v2
  stream's ephemeral typing lane consumes createSyncEventHub — Task 5 must port typing
  forwarding to a direct NOTIFY subscription (or an equivalent) BEFORE deleting the hub;
  the consumer-zero sweep will catch it, recorded here so it isn't a surprise.

Gotchas for the next session: worker-startup's closed sync-queue mock family now includes a
golden-signals module mock (the service imports ensureQueueCreated from sync-queue);
`ALTER TYPE ... ADD VALUE` rides migration 0067 (PG16 allows it in-txn when the enum predates
the txn); the ephemeral-lane dependency above is the one cross-stage coupling Stage 24 added
to this stage's retirement unit.
