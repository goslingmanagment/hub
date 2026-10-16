-- agency-hub:no-transaction
-- Site socket upgrades have urgent priority, without impersonating an engine
-- work. All old site/login rows remain valid; old binaries still write them.
-- The constraint swap holds ACCESS EXCLUSIVE only briefly, bounded per try.
-- agency-hub:statement
do $do$
begin
  for attempt in 1..60 loop
    begin
      set local lock_timeout = '1s';
      alter table sync_attempts
        drop constraint if exists sync_attempts_origin_check,
        add constraint sync_attempts_origin_check check (
          (origin = 'engine' and class in ('urgent', 'requests', 'planned'))
          or (origin in ('site', 'login') and work_id is null and (
            class = 'site'
            or (origin = 'site' and class = 'urgent' and slot is null
                and operation is not distinct from 'ws.upgrade')
          ))
        ) not valid;
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise exception 'could not lock sync_attempts to admit urgent site socket upgrades';
end
$do$;
-- agency-hub:statement
alter table sync_attempts validate constraint sync_attempts_origin_check;
-- agency-hub:statement
comment on column sync_attempts.origin is
  'Request owner: engine, site or login. Site/login have no work; site uses class urgent only for ws.upgrade (no cycle slot), otherwise class site.';
