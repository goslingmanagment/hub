-- agency-hub:no-transaction
-- 0272_sync_attempts_browser_send.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §3.2, §3.4; stage 3
-- PR 12): a page's browser sends the engine's requests itself, after the
-- engine's grant, and reports when each one left. The pacer counts the pause
-- from that instant, and the journal keeps it.
--
--   send_mark           gains 'transport_reported': sent_at is the instant
--                       the page's browser reported the request left (Chrome's
--                       timing, never before the gate's first bytes of it),
--                       as the engine's pacer took it — never before the
--                       engine's grant, never after the completion.
--   browser_request_id  the operator's id of a request the engine did not
--                       choose: a site request's `siteRequestId`, a site
--                       socket's `connectionId` (spec §6.1). Null for the
--                       engine's own requests: their id at the operator is
--                       the attempt's id.
--
-- The live engine keeps running while this migrates (the deploy leaves the
-- previous sync up), and sync_attempts is its journal, so nothing here holds
-- the table for long (the 0271 pattern). Each statement runs in its own
-- transaction:
-- 1. the column, nullable without a default (catalog only, no rewrite);
-- 2. the send_mark check swapped NOT VALID in one ALTER (brief, under ACCESS
--    EXCLUSIVE): every DDL waits at most 1 s for its lock and retries,
--    instead of queueing the engine's reads and writes behind a long reader,
--    and fails the migration after ~60 s;
-- 3. the check validated apart, under SHARE UPDATE EXCLUSIVE: the scan of
--    the table conflicts with no read or write.
-- Re-running after a crash is safe: every statement is idempotent.
--
-- The previous image never names `browser_request_id` (it inserts
-- sync_attempts by named columns) and never writes 'transport_reported'; it
-- reads send_mark as text and acts on no value of it. Nothing sends through
-- a page's browser before the transport switch (PR 14): it runs unchanged
-- after a rollback.
-- agency-hub:statement
do $do$
begin
  for attempt in 1..60 loop
    begin
      set local lock_timeout = '1s';
      alter table sync_attempts add column if not exists browser_request_id text;
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise exception 'could not lock sync_attempts to add browser_request_id';
end
$do$;
-- agency-hub:statement
do $do$
begin
  for attempt in 1..60 loop
    begin
      set local lock_timeout = '1s';
      alter table sync_attempts
        drop constraint if exists sync_attempts_send_mark_check,
        add constraint sync_attempts_send_mark_check check (
          send_mark is null or send_mark in ('request_start', 'completion_fallback', 'transport_reported', 'shadow')
        ) not valid;
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise exception 'could not lock sync_attempts to widen its send_mark check';
end
$do$;
-- agency-hub:statement
alter table sync_attempts validate constraint sync_attempts_send_mark_check;
-- agency-hub:statement
comment on column sync_attempts.send_mark is
  'How sent_at was taken: request_start (undici onRequestStart), completion_fallback (the completion instant, the safe upper bound), transport_reported (the instant the page''s browser reported, 0272) or shadow (simulated, retired).';
-- agency-hub:statement
comment on column sync_attempts.browser_request_id is
  'Project Browser (0272): the operator''s id of a request the engine did not choose (a site request''s siteRequestId, a site socket''s connectionId). Null for the engine''s own requests: their id at the operator is the attempt id.';
