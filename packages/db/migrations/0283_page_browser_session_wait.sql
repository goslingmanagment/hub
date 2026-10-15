-- Pilot F1: distinguish a site stuck before discovering its session from
-- a slow browser start. Kept across state refreshes and engine restarts;
-- starts only when the operator actually reports this condition.
alter table page_browsers add column session_wait_since timestamptz;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select (session_wait_since) on page_browsers to read_only;
  end if;
end $$;
