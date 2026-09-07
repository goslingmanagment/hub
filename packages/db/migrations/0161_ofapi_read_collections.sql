-- Default-off collection jobs retain leases and replayable normalized snapshot pages.
alter table ofapi_collection_jobs add column purpose text not null default 'one_off' check (purpose in ('one_off','background'));
alter table ofapi_collection_jobs add column lease_token uuid;
alter table ofapi_collection_jobs add column lease_until timestamptz;
create table ofapi_collection_schedules (
 page_id bigint not null references pages(id) on delete restrict,
 category text not null,
 last_scheduled_at timestamptz not null,
 primary key(page_id,category)
);
create table ofapi_read_snapshots (
 id bigint generated always as identity primary key,
 page_id bigint not null references pages(id) on delete restrict,
 category text not null,
 operation text not null,
 pathname text not null,
 query jsonb not null,
 observed_at timestamptz not null,
 observation_id bigint not null,
 observation_received_at timestamptz not null,
 event_id bigint not null,
 granularity text not null,
 coverage jsonb not null,
 items jsonb not null,
 unique(page_id,observation_id)
);
create index ofapi_read_snapshots_lookup on ofapi_read_snapshots(page_id,operation,observed_at desc,id desc);
