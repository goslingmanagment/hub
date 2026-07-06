# Stage 28 — Retention tiering, lake, metrics, erasure procedure

**Repo(s):** core · **Depends on:** 8, 10, Q3; recommended after 12 & 17 (their facts in the
ledger first); soft: 29 (acceptance-rate model) · **Passport:** roadmap.md §4, stage 28

**Status header — Q3 re-scope + one standing risk re-raised (owner attention required):**
1. **Q3 (off-box storage) was declined** ("я бы не делал этого"). Per the master, the tiering
   target is re-scoped **on-box**: aged partitions export to Parquet on the VPS filesystem
   (dedicated directory on the same volume), checksum-verified, then detached. The lake layout
   (`plane/table/year/month`) is identical to the off-box design — moving it to S3 later is a
   copy job, not a redesign (two-way door preserved).
2. **Standing risk re-raised and ANSWERED (owner, 2026-07-04): option (b) — no backups for now,
   risk re-accepted.** The master instructed re-raising it no later than this stage; done. With
   on-box tiering, a VPS disk loss destroys hot DB AND lake together, and there is still no
   off-server backup of any kind (go-live doc names it an infrastructure blocker,
   `docs/chatgoose-custody-go-live.md:81-83`). The owner has explicitly re-accepted this — the
   execution session records it verbatim in `decisions.md` (tombstone-style entry: "off-server
   backup declined 2026-07-04, VPS-loss = total-history-loss risk accepted") and does **not**
   build lake mirroring. The restore drill (§2) is therefore a same-disk exercise only. This is a
   two-way door: an S3 mirror (~$2/mo) remains a copy job over the unchanged
   `plane/table/year/month` layout whenever the owner reverses.
3. **Elaboration:** `sync_runs` currently grows **unbounded** (verified — no deleter exists;
   only `sync_http_attempts`/`sync_run_events` get the 30-day cleanup,
   `repositories/sync.ts:759-766`, `worker-services.ts:157-163`). The passport's "ops telemetry
   gets bounded retention" explicitly gains `sync_runs`.

## 1. Context

DP 7-A: business facts are forever; "delete" is a governed procedure. The mechanism: hot windows
in Postgres, aged monthly partitions exported → verified → detached; a DuckDB-queryable lake;
versioned SQL metrics models; and the audited break-glass erasure that reaches all three planes.
With history then provably held, Stage 1's kill-switches retire and bounded hot-table pruning
returns as a safe cache policy.

**Entry criteria restated as facts to verify:**
- Stages 12 & 17 complete (harvest + backscroll facts already in the ledger — tiering must not
  detach partitions their replays still want hot; if either lags, tier only months they can't
  touch).
- Partition sizes measured (`pg_total_relation_size` per observations/domain_events partition);
  disk: re-check (32 GB free of 79 GB on 2026-07-04) — headroom for export staging.
- Cost/perf guardrails written against DP 7's "never in the minus": export runs off-peak;
  hot-path p95s (golden signals, Stage 25) must be unaffected during exports.
- Verified: no partitioning existed before Stage 7 (the observations/domain_events partitions
  are the only tiering units); no S3/object-storage code exists anywhere (grep clean).

**Deliverable:** tiering job in production with ≥1 partition tiered and query-proven; DuckDB
query head + `core/analytics/models/` producing the canonical metrics; erasure drill passed on a
synthetic fan; hot DB size plateaus; Stage 1 kill-switches retired; ops telemetry (incl.
`sync_runs`) bounded — the only scheduled deletion left.

## 2. Changes

**core — tiering job** (`services/tiering/` + scheduler): for each monthly partition of
`observations` / `domain_events` (and `message_archive` if/when partitioned — it isn't at
creation; tier it by date-range export instead) older than the hot window (constant, default
6 months — **deploy-time constant, not a config knob**, per target §3.4):
1. EXPORT: DuckDB (dev-dependency binary, `postgres_scanner`) reads the partition → writes
   `lake/<plane>/<table>/<year>/<month>.parquet` + a manifest (row count, min/max ids, sha256).
   The exporter takes an **exclusion list at two granularities**: whole tables (Stage 29's
   `ai_generation_content`/`ai_acceptance_events`) and observation **kinds** (initially
   `desktop.guard_audit` — full-text sensitive capture, stage-11 §2). Excluded kinds are not
   dropped: they export to `lake/restricted/…` under the same manifest/verify discipline,
   outside the analytics models' search path and access-scoped like the Stage 29 restricted
   reads — so DETACH still loses nothing and the generic lake carries no sensitive full text.
2. VERIFY: re-read the Parquet with DuckDB; row count + checksum re-computed must match the
   manifest AND a fresh Postgres count. **In that absolute order — export, verify, only then:**
3. DETACH: `ALTER TABLE … DETACH PARTITION`; the detached table is renamed to a
   `tiered_pending_drop` schema and DROPPED only after the global restore drill has passed once
   and (owner question above) the mirror decision is recorded.
   Failure at any step = abort loudly (incident), partition stays hot. Idempotent: manifest
   presence + checksum short-circuits re-export.

**core — restore drill (mandatory, gates the first DROP):** from Parquet alone, rebuild a
staging table, re-attach as a partition, run the Stage 8 replay + a projection rebuild over it —
counts identical to pre-detach records.

**core — DuckDB query head + metrics models:** `core/analytics/models/*.sql` (plain SQL over
lake + hot Postgres via scanner; a thin runner script `pnpm analytics:run <model>` — dbt-style
discipline, no framework): initial set — LTV per fan, cohort retention, net revenue by
page/model/day, response SLAs (from message events), AI acceptance rate (from Stage 29's class,
metadata-only fields; deferred to land with Stage 29 if 29 hasn't shipped — soft dep). Each
model versioned, banner-carrying (machine-generated output tables
under `analytics_` prefix or lake-side). Dashboard serving swaps in Stage 33 — here the models
must **reproduce current report numbers within stated tolerance** (the reconciliation is this
stage's exit, so 33 is a serving swap, not a numbers change).

**core — erasure procedure** (`cli.ts erasure:run` + module): owner-initiated, scoped
(page/model/fan), **dry-run default** (lists affected rows per plane: hot tables, ledger
partitions, lake files); execution writes tombstones (erasure_log: scope, initiated_by, counts,
timestamps), physically purges hot rows, rewrites affected Parquet files (filter-out + checksum
update), and re-runs affected projection rebuilds. Fully audited (operator observation +
`audit_events` + the log table). Restricted-class AI content (Stage 29) is inside the erasure
reach by design.

**core — retire Stage 1's kill-switches; prune returns as cache policy:**
`PAGE_DM_PRUNE_ENABLED` and the redaction switch retire; `page_dm_messages` pruning re-enables
(caps per Stage 1's constants) **gated on the Stage 10 coverage query passing at that moment**
(archive ≥ hot per conversation — run it in the same deploy); command-payload redaction stays
retired (the text is a kept business fact — target §3.5/4.8). `ofapi_commands` payloads,
`sync_raw_payloads`: now covered by ledger+tiering; their Stage 1 forever-stamps stand (they
tier with everything else if table sizes ever warrant — noted, not built).

**core — ops telemetry bounded:** `sync_runs` gains the 30-day cleanup (join the existing
`deleteExpiredSyncObservability` sweep); `ops_metric_samples` (Stage 25) gets 90 days;
pg-boss archives stay default. These are the ONLY scheduled deletions in the system — assert it
with a repo test enumerating deleters (the inverse of today's audit).

## 3. Schema & data migration

```sql
-- 00NN_erasure_log.sql
CREATE TABLE erasure_log (
  id bigserial PRIMARY KEY, scope_type text NOT NULL CHECK (scope_type IN ('page','model','fan')),
  scope_ref text NOT NULL, initiated_by bigint NOT NULL REFERENCES users(id),
  dry_run boolean NOT NULL, plan jsonb NOT NULL, executed_counts jsonb,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
-- 00NN_sync_runs_retention: no DDL (sweep-side), plus index if the delete needs one:
CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs (started_at);
```
The tiering "migration" is operational (per-partition, manifest-checkpointed, resumable,
verified per §2). Verification queries: per tiered partition — DuckDB count == manifest count ==
recorded pre-detach count; hot DB size series (`/admin/db/stats`) plateaus after the first
tiering cycle.

## 4. Client compatibility

- **Desktop:** none — hot windows exceed every interactive read horizon; stream v2's retained
  floor becomes real (Stage 21's 409 path now reachable — its conformance suite already proves
  the recovery flow; desktop is on v2 with snapshot handling by now).
- **Extension / workboard:** none.
- **Dashboard:** none this stage (reporting still served from rollups; the model swap is 33).
  The erasure UI is 33; the CLI is the owner surface here.

**Compatibility invariants (target §14):** untouched.

## 5. Tests & verification

**New tests:** tiering unit/integration on a seeded partition (export→verify→detach; induced
checksum mismatch aborts + incidents; idempotent re-run); restore drill automated on staging;
erasure drill — synthetic fan across hot+lake+projections, dry-run plan matches executed counts,
audit complete; deleter-enumeration test (only the sanctioned sweeps delete); prune re-enable
gated test (coverage query fails → prune stays off).

**Existing suites:** archive/projection suites; golden-signal checks during export (staging
load).

**Production verification (exit criteria):**
- A tiered partition queried via DuckDB returns identical counts to its recorded pre-detach
  rows; restore drill passed (documented).
- Erasure drill on a synthetic fan: removed from hot DB + lake + projections, full audit trail.
- Hot DB size plateaus over the following month (`/admin/db/stats` series — the actual point).
- Metrics models reproduce current report numbers within stated tolerance (reconciliation table
  recorded here — Stage 33's gate).
- Owner ruling recorded in `decisions.md`: **risk re-accepted, no mirror** (answered 2026-07-04,
  § Status header) — the entry exists before the first real DROP.

## 6. Rollback

- Tiering: reversible until DROP (detached tables re-attach); DROP is gated on the restore
  drill + owner go — the one irreversible step, named, gated.
- Prune re-enable: kill-switch semantics preserved for one release (flag kept, default on) —
  instant revert if the coverage gate was wrong.
- Erasure is BY DESIGN irreversible — that's what dry-run + owner confirmation + audit exist
  for; a drill precedes any real use.

## 7. Assumptions

1. **Single VPS remains the topology**; DuckDB runs on-box off-peak within memory limits
   (measure on the first partition; partitions are small at current volumes).
2. **The monthly partition scheme from Stages 7/8 is the tiering unit**; `message_archive` is
   unpartitioned by choice (Stage 10) — its tiering is range-export, or it gets partitioned here
   if size warrants (decide at execution from measured sizes).
3. **Stage 1's forever-retention held** throughout — no facts were lost between Stages 1 and 28;
   the kill-switch retirement only happens with the coverage query green.
4. **DP 7's "never in the minus"**: export cost is off-peak CPU + temporary disk; the guardrail
   numbers (export duration, p95 impact) are recorded on the first partition before scheduling
   the rest.
5. **Q3's decline stands unless the owner reverses it here** (the re-raise is built into the
   exit criteria).

## 8. Task breakdown

1. **Tiering job (export/verify/detach + manifests + incidents) + staging drill.** *(1–1.5
   sessions)*
2. **Restore drill automation.** *(0.5 session)*
3. **DuckDB head + metrics models + report reconciliation.** *(1–1.5 sessions)* *(parallel with
   1–2)*
4. **Erasure procedure (CLI, dry-run, tombstones, Parquet rewrite, audit) + synthetic drill.**
   *(1 session)*
5. **Kill-switch retirement + gated prune re-enable + ops-telemetry retention (`sync_runs`).**
   *(0.5 session)*
6. **(Last) First production tiering cycle; owner mirror-or-accept ruling; month-long plateau
   watch; record everything here.** *(ops)*

## Progress

**Session 1 (2026-07-06, on main post-#101 deploy; decision #102):**

§8 status — **Task 5 DONE (deployed same-day); Tasks 1–4, 6 remain.**

- [x] **Task 5** (1f8ead8) — ops retention bounded: sync_runs joins the 30-day sweep
  (children cascade, raw payloads SET NULL, 'running' rows never swept — wedged runs are
  evidence; migration 0070 = the started_at index); ops_metric_samples 14d stopgap → 90d;
  PAGE_DM_PRUNE_ENABLED default ON (kill-switch kept one release) with every call site
  behind isPageDmPruneAllowed = flag AND countArchiveCoverageGaps (archive ≥ hot per
  conversation; 15-min cache; fails closed); Stage 1 command-payload redaction switch +
  sweep arm + repository fn DELETED (payloads are kept business facts, permanently);
  deleter-enumeration test pins every SQL-deleting file (tests/retention-deleters.test.ts).
  Prod env pins neither flag → prune gate live with the coverage query deciding.
- [ ] **Task 1 (next session's opener)** — tiering job (export/verify/detach + manifests +
  incidents). DESIGN NOTE recorded: DuckDB must be a RUNTIME dependency of apps/runtime
  (the scheduler container runs the export — a dev-dependency binary would not ship in the
  image); lockfile change ⇒ that deploy is a full image build. NOTHING IS TIERABLE until
  ~2027-01 (data starts 2026-07, hot window 6 months) — the job ships drill-tested on
  synthetic partitions, prod cycle fires when the first partition ages out.
- [ ] Task 2 restore drill; Task 3 DuckDB head + metrics models (reconciliation = Stage 33's
  gate); Task 4 erasure CLI (+ erasure_log migration — deliberately NOT in 0070, rides the
  erasure commit); Task 6 ops (first prod cycle + plateau watch + the §5 exit criteria).

Standing facts: Q3 declined → on-box lake (S3 mirror stays a copy job if the owner ever
reverses); the no-backup risk re-accepted 2026-07-04 — BUT this session's #101 deploy
banked the first off-box snapshot ever (3.0 GB pg_dump on the dev machine, scratchpad).
