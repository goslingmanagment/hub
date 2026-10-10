-- 0262_sync_alert_evaluations.sql
--
-- Fansly Sync Engine, bug hunt Д11: the alert evaluator's proof of work. The
-- evaluator (`apps/runtime/src/sync/engine/alerts.ts`, process `sync`) is the
-- only one that opens alerts 2–4 and resolves alerts 1–4; a rule that keeps
-- failing used to fail silently while the process kept beating. Each pass now
-- writes one row per handover/live page and rule: when the rule was last
-- judged in full, and the failure that keeps it from being judged now. The api
-- watchdog (`services/ops-watchdog.ts`) reads the rows and opens the global
-- latch `fansly_sync_engine:global:evaluator` when a rule of a page has not
-- been judged for 5 minutes.
--
--   rule           one of the evaluator's rules: the page alerts
--                  (page_stopped, live_degraded, freshness, stuck), the
--                  route incidents (route_limited) and the pace backstop
--                  (pace_audit). No CHECK: the vocabulary lives in code
--                  (SYNC_ALERT_EVALUATION_RULES, one source for the evaluator
--                  and the watchdog), and the watchdog reads only the rules
--                  it names — a row of a rule the code dropped is never read,
--                  and a rule the code adds needs no migration.
--   attempted_at   the pass that last wrote the row (the database clock of
--                  the pass).
--   evaluated_at   the last pass that judged the rule in full: every fact it
--                  reads was read, and its open or resolve landed. Null: never.
--   failure        why the last pass could not judge it (the fact part or
--                  step, a SQLSTATE or error name and a short message; never
--                  SQL), with failed_since the first pass of that failure
--                  streak. Both null once a pass judges it again.
--
-- Page-owned like the other engine tables (RESTRICT on the page; the erasure
-- deletes the rows by page). No telemetry history: one row per page and rule,
-- rewritten in place, never pruned.
--
-- Purely additive, IF NOT EXISTS; the previous image never names the table.

create table if not exists sync_alert_evaluations (
  page_id bigint not null references pages(id) on delete restrict,
  rule text not null,
  attempted_at timestamptz not null,
  evaluated_at timestamptz,
  failure text,
  failed_since timestamptz,
  constraint sync_alert_evaluations_pkey primary key (page_id, rule),
  constraint sync_alert_evaluations_failure_check check ((failure is null) = (failed_since is null))
);

comment on table sync_alert_evaluations is
  'Fansly Sync Engine (bug hunt Д11): per handover/live page and alert rule, when the alert evaluator last judged it in full and why it cannot now. Written by the evaluator alone; read by the api watchdog (latch fansly_sync_engine:global:evaluator).';
comment on column sync_alert_evaluations.page_id is
  'The page whose rule was judged; the erasure deletes the rows by page.';
comment on column sync_alert_evaluations.rule is
  'The evaluator''s rule (SYNC_ALERT_EVALUATION_RULES in code; no CHECK, the code names what it reads).';
comment on column sync_alert_evaluations.attempted_at is
  'The database clock of the evaluator pass that last wrote the row.';
comment on column sync_alert_evaluations.evaluated_at is
  'The last pass that judged the rule in full (its facts read, its open or resolve landed); null: never.';
comment on column sync_alert_evaluations.failure is
  'Why the last pass could not judge the rule: the fact part or step, the SQLSTATE or error name, a short message; never SQL. Null when judged.';
comment on column sync_alert_evaluations.failed_since is
  'The first pass of the current failure streak; null when judged.';

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on sync_alert_evaluations to read_only;
  end if;
end $$;
