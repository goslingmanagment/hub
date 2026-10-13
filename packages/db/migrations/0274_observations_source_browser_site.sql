-- agency-hub:no-transaction
-- 0274_observations_source_browser_site.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §3.2 «Ответы на
-- собственные API-запросы сайта», §3.4; stage 3 PR 12): the answers to the
-- site's own API requests that carry platform data are kept as observations
-- before anything parses them, under their own source:
--
--   source 'browser_site'  producer `fansly-site:<route>`, idempotency key
--                          `fansly-site:<page>:<buffer id>:<number>`
--
-- The writer comes with the buffer's intake (PR 13); nothing writes the value
-- before it.
--
-- observations is partitioned by month and written all the time. The CHECK
-- is swapped in one ALTER, NOT VALID (the 0196 pattern: no scan of the
-- partitions under the lock; every row there is inside the old, narrower
-- list, and the new list only adds a value). The ALTER waits at most 1 s for
-- its lock and retries, instead of queueing every writer behind a long
-- reader, and fails the migration after ~60 s. Re-running after a crash is
-- safe.
--
-- Rollback-compatible: the previous image never writes 'browser_site' and
-- reads observations.source as text; its readers select the sources they
-- know.
-- agency-hub:statement
do $do$
begin
  for attempt in 1..60 loop
    begin
      set local lock_timeout = '1s';
      alter table observations
        drop constraint if exists observations_source_check,
        add constraint observations_source_check check (
          source in ('webhook', 'pull', 'client_capture', 'readthrough', 'command_result', 'operator', 'ofapi_capture',
                     'fansly_ws', 'browser_site')
        ) not valid;
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise exception 'could not lock observations to widen its source check';
end
$do$;
