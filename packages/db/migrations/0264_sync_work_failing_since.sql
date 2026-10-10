-- 0264_sync_work_failing_since.sql
--
-- Fansly Sync Engine, bug hunt Д3/У2: how long a work row's steps have been
-- failing without an outcome.
--
--   failing_since   the start of the row's current series of steps that ended
--                   without an outcome: a plan that threw, a local write that
--                   failed and will be retried, an in-memory answer (the
--                   WebSocket Upgrade, a CDN hop) whose apply failed and will
--                   be read again, an attempt recovery closed `unknown`. Any
--                   step with an outcome (an applied answer, a committed local
--                   write, a plan that needs no request, a classified answer of
--                   Fansly) ends the series: null. The owner's requeue of a
--                   quarantined row starts afresh: null.
--
-- Writers: the engine's `settleWork` (`stepFailed`), its recovery
-- (`recoverUnfinishedAttempts`, a row it opens after an `unknown` attempt) and
-- the owner's `requeueQuarantinedWork`. Reader: alert 4's `step_failing`
-- (a row failing for longer than 5 min, unless the owner's pause, a page hold,
-- a pause of its key or its file's breaker explains it).
--
-- Purely additive, nullable without a default (catalog-only); the previous
-- image never names it (every insert and update of sync_work names its
-- columns). The table-level read_only grant of 0228 covers it.
alter table sync_work add column if not exists failing_since timestamptz;

comment on column sync_work.failing_since is
  'Д3/У2: the start of the work''s current series of steps without an outcome (a plan error, a failed local write, an in-memory answer not applied, an attempt recovered unknown); null once a step has an outcome or the owner requeued it.';
