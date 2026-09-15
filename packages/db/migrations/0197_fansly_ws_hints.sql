alter type sync_request_source add value if not exists 'event';

alter table subject_refresh_state drop constraint subject_refresh_state_plane_check;
alter table subject_refresh_state add constraint subject_refresh_state_plane_check check (plane in (
  'media_stats', 'post_replies', 'post_engagement', 'of_post_stats',
  'fan_earnings_lifetime', 'fan_earnings_monthly', 'fan_earnings_attribution', 'fansly_ws_dm'
));

-- B1: durable routing receipts and the existing subject queue. No REST or
-- business projection is enabled by this migration. Operational receipts
-- must survive replay; truncating them would dispatch the same signal twice.
create table fansly_ws_hint_receipts (
  event_id bigint primary key,
  page_id bigint not null references pages(id) on delete restrict,
  observation_id bigint not null,
  received_at timestamptz not null,
  generation text,
  group_ref text,
  message_ref text,
  hint_type text check (hint_type in ('message_created', 'group_created')),
  mutation jsonb,
  outcome text not null check (outcome in (
    'routed', 'mutation_debt', 'disabled', 'generation_unknown',
    'before_activation', 'unrouted', 'invalid', 'limit'
  )),
  routed_revision bigint,
  hot_applied_at timestamptz,
  rest_raw_page_ids jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index fansly_ws_hint_receipts_page_time on fansly_ws_hint_receipts(page_id, received_at);
create index fansly_ws_hint_receipts_group on fansly_ws_hint_receipts(page_id, group_ref);

-- Admission rows count every additional physical attempt, including retries
-- and a crash after admission but before dispatch (conservative overcount).
create table fansly_ws_hint_attempts (
  page_id bigint not null references pages(id) on delete restrict,
  request_id text not null,
  attempt_number integer not null check (attempt_number > 0),
  generation text not null,
  sync_run_id bigint,
  admitted_at timestamptz not null default clock_timestamp(),
  source text not null default 'event' check (source = 'event'),
  primary key (page_id, request_id, attempt_number)
);
create index fansly_ws_hint_attempts_budget on fansly_ws_hint_attempts(page_id, admitted_at);

create view fansly_ws_hint_status as
  select r.page_id, r.event_id, r.observation_id, r.received_at, r.generation,
    r.group_ref, r.message_ref, r.hint_type, r.mutation, r.outcome, r.routed_revision,
    r.hot_applied_at, r.rest_raw_page_ids,
    extract(epoch from (r.hot_applied_at - r.received_at)) as signal_to_hot_seconds,
    s.requested_revision, s.applied_revision, s.next_due_at, s.last_refresh_outcome
  from fansly_ws_hint_receipts r left join subject_refresh_state s
    on s.page_id = r.page_id and s.plane = 'fansly_ws_dm' and s.subject_ref = r.group_ref;

create view fansly_ws_hint_attempt_status as
  select h.page_id, h.source, h.request_id, h.attempt_number, h.generation,
    h.sync_run_id, h.admitted_at, a.state, a.http_status, a.finished_at
  from fansly_ws_hint_attempts h left join sync_http_attempts a
    on a.sync_run_id = h.sync_run_id and a.logical_request_id = h.request_id and a.attempt_number = h.attempt_number;
do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on fansly_ws_hint_receipts, fansly_ws_hint_attempts to read_only;
    grant select on fansly_ws_hint_status, fansly_ws_hint_attempt_status to read_only;
  end if;
end $$;
