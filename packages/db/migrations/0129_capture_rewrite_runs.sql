-- 0129: G5 slice 3c-2 — the tombstone journal of the historical rewrite (§9.1/
-- §9.2 of investigations/storage-compaction-architecture-2026-08-11.md).
--
-- WHY A TABLE AND NOT A LOG LINE. Every act in this slice is owner-initiated
-- from the CLI, and two of them need to READ what an earlier one concluded:
--
--   * `capture:verify-backfill` must know how many rows the backfill LEFT
--     without a reference on purpose (the codec refused their body), because a
--     null-ref row it cannot account for is the one condition that makes it
--     refuse to bless a scope. That count is produced by a run that finished
--     hours earlier, in another process.
--   * `capture:reclaim` must not build a skinny shadow off a scope whose
--     verdict is stale or was never given. "The owner ran verify and it said
--     ok" has to be a fact the database holds, not a claim the operator makes
--     on the command line.
--
-- A pino line satisfies neither, and `ops_metric_samples` is the wrong home for
-- both: it is a fixed-shape gauge series the golden-signals deadman watches, and
-- an irregular, operator-paced series inside it either trips that deadman or
-- teaches everyone to ignore it (#212 already had to carve `disk_*` out of the
-- deadman for the same reason). So this follows `erasure_log` — the house
-- pattern for exactly this shape of act: owner-initiated, dry-run by default,
-- one durable row per run, plan and counts as jsonb.
--
-- STRUCTURED LOGGING STILL HAPPENS. This table is the durable summary; the CLI
-- also prints and logs per batch, because a run that is still going has no row
-- to read yet.
--
-- NOTHING HERE IS A CAPTURED FACT. These are records OF acts, like erasure_log —
-- so no retention question arises and nothing deletes them.

CREATE TABLE "capture_rewrite_runs" (
  "id"           bigserial PRIMARY KEY,
  -- Which act this row records. `drop_parked` is the only one that destroys
  -- anything; it is here so the destruction has the same tombstone as the rest.
  "operation"    text NOT NULL
    CHECK ("operation" IN ('backfill', 'verify', 'reclaim', 'drop_parked')),
  "scope_table"  text NOT NULL
    CHECK ("scope_table" IN ('observations', 'sync_raw_payloads')),
  -- The observations monthly cohort, as the `YYYY-MM-01` date its partition
  -- covers. NULL for `sync_raw_payloads`, which is not partitioned and whose
  -- verdict is therefore always whole-table — a month-scoped verdict could not
  -- gate a whole-table act, so the column refuses to hold one.
  "scope_month"  date,
  -- Which sub-step of a multi-step act (shadow / swap / null-bodies /
  -- vacuum-full). NULL for the single-step ones.
  "phase"        text,
  "dry_run"      boolean NOT NULL,
  -- ok       — the act completed and, for `verify`, the scope is blessed.
  -- refused  — a precondition said no. NOTHING was touched.
  -- failed   — the act started and did not finish.
  -- running  — the row was written at start and not yet settled.
  "verdict"     text NOT NULL DEFAULT 'running'
    CHECK ("verdict" IN ('running', 'ok', 'refused', 'failed')),
  "summary"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_at"   timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "capture_rewrite_runs_month_shape_check"
    CHECK (("scope_table" = 'sync_raw_payloads') = ("scope_month" IS NULL))
);

-- The one query that matters: "the latest settled run of operation X over
-- scope Y". Both readers (verify looking for the backfill's refusal count,
-- reclaim looking for the verify verdict) walk this index backwards and stop
-- at the first row.
CREATE INDEX "capture_rewrite_runs_scope_idx"
  ON "capture_rewrite_runs" ("scope_table", "scope_month", "operation", "started_at" DESC);
