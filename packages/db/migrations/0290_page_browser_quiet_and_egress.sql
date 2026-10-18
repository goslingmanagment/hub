-- agency-hub:no-transaction
-- 0290_page_browser_quiet_and_egress.sql
--
-- Project Browser, variant Б (plan-b §4.1.10, Б12; 2026-10-18): a Hub request
-- through a page's browser is let go twice — the engine grants it, then the
-- operator releases it once the page has been quiet the admission's pause by
-- its own sight (the proxy's bytes to the API, the site's sends it saw). The
-- send audit measures Б12 from the release; the exit's refusals, counted by
-- the operator, are kept with its state.
--
--   sync_attempts.granted_at     when the engine granted a request a page's
--                                browser sends (`checkRemoteGrant`), on the
--                                wall clock. Null: none recorded (an engine
--                                send, a row from before)
--   sync_attempts.released_at    when the page's browser released it after
--                                its quiet (`sent.releasedMono`). Null: not
--                                reported (an operator from before)
--   page_browsers.egress_failures, egress_failures_since
--                                the exit's refusals since the operator
--                                started (`state.egressFailures`): the page's
--                                SOCKS5 failing tunnels by kind, step, reply
--                                and the host's class; the rules extension's
--                                blocks by the host's class, the self-test's
--                                probes apart. Null: not counted
--
-- The live engine keeps running while this migrates (the deploy leaves the
-- previous sync up), and sync_attempts is its journal: the 0272 pattern —
-- each statement in its own transaction, nullable columns without a default
-- (catalog only, no rewrite), every DDL waiting at most 1 s for its lock and
-- retrying, failing the migration after ~60 s. Re-running after a crash is
-- safe: every statement is idempotent.
--
-- Rollback-compatible: the previous image never names these columns (it
-- writes sync_attempts and page_browsers by named columns only) and skips the
-- fields an operator adds to its messages.
-- agency-hub:statement
do $do$
begin
  for attempt in 1..60 loop
    begin
      set local lock_timeout = '1s';
      alter table sync_attempts
        add column if not exists granted_at timestamptz,
        add column if not exists released_at timestamptz;
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise exception 'could not lock sync_attempts to add granted_at and released_at';
end
$do$;
-- agency-hub:statement
do $do$
begin
  for attempt in 1..60 loop
    begin
      set local lock_timeout = '1s';
      alter table page_browsers
        add column if not exists egress_failures jsonb,
        add column if not exists egress_failures_since timestamptz;
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise exception 'could not lock page_browsers to add egress_failures';
end
$do$;
-- agency-hub:statement
comment on column sync_attempts.granted_at is
  'Project Browser (0290): when the engine granted a request a page''s browser sends (checkRemoteGrant). Null: none recorded.';
-- agency-hub:statement
comment on column sync_attempts.released_at is
  'Project Browser (0290): when the page''s browser released the request after its own sight of the page''s quiet (plan-b Б12; sent.releasedMono). The send audit measures Б12 from it. Null: not reported.';
-- agency-hub:statement
comment on column page_browsers.egress_failures is
  'Project Browser (0290): the exit''s refusals since the operator started (egress_failures_since), as its last state said: {socks: [{kind, step, rep, cls, count, lastAt, lastHost}], dnr: [{cls, probe, count, lastAt, lastHost}]}. Null: not counted.';
-- agency-hub:statement
-- The read role reads sync_attempts whole (0228); page_browsers by column.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select (egress_failures, egress_failures_since) on page_browsers to read_only;
  end if;
end $$;
