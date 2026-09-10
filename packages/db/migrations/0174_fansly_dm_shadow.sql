-- A0 diagnostics are independent of business data and full-sweep authority.
-- Reports survive sync-run telemetry retention. No message text is stored here.
create table fansly_dm_shadow_sweeps (
  page_id bigint not null references pages(id) on delete restrict,
  generation bigint not null,
  started_at timestamptz not null,
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'complete', 'incomplete')),
  reason text,
  page_count integer not null check (page_count >= 0),
  diagnostics jsonb not null,
  primary key (page_id, generation)
);
create index fansly_dm_shadow_started_idx
  on fansly_dm_shadow_sweeps (started_at, page_id);

create view fansly_dm_shadow_report as
select p.label as page_label, s.*
from fansly_dm_shadow_sweeps s join pages p on p.id = s.page_id;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on fansly_dm_shadow_report to read_only;
  end if;
end $$;
