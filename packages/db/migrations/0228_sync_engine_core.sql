-- 0228_sync_engine_core.sql
--
-- Fansly Sync Engine core state (plan §8, §11; design §2.2). Three tables of
-- the new engine; nothing of the legacy engine is touched and nothing reads
-- them until the `sync` process runs (step 2, shadow).
--
--   sync_pages     one row per Fansly page: mode (off / shadow / handover /
--                  live), owner pauses and registry overrides, holds, the
--                  identity check, ownership (generation + the owner process's
--                  identity, the step-1 OS-proof fields), the scheduler's
--                  cycle position, the pacer's facts and the shadow WS cursor
--   sync_work      the ONE queue: one open row per page × shadow × resource ×
--                  subject (duplicates merge in the database), demand and
--                  applied revisions, cursor / goal / proof, the subject
--                  breaker and the durable "why waiting"
--   sync_attempts  one row per physical attempt (or simulated attempt in
--                  shadow): admission, u, the actual send instant and its
--                  mark, outcome, the observation it captured, apply state
--
-- Every Fansly page gets its row in mode 'off'; a page created later gets one
-- lazily (ensureSyncPage). Telemetry retention: closed sync_work rows and
-- terminal non-evidence sync_attempts rows expire with the sync observability
-- window (deleteExpiredSyncEngineTelemetry); open work, unfinished attempts
-- and coverage evidence never do.
--
-- Purely additive, IF NOT EXISTS; the previous image never names these tables
-- or functions.

create table if not exists sync_pages (
  page_id bigint primary key references pages(id) on delete restrict,
  -- 'off'      the legacy engine owns the page; no actor runs
  -- 'shadow'   an actor runs: no HTTP, no domain writes (step 2)
  -- 'handover' legacy senders are fenced; the actor owns the page but has not
  --            sent yet (step 3, transient)
  -- 'live'     the actor is the only sender of the page
  mode text not null default 'off',
  mode_changed_at timestamptz not null default clock_timestamp(),
  mode_changed_by text not null default 'migration',
  requests_enabled_at timestamptz,
  legacy_imported_at timestamptz,
  registry_overrides jsonb not null default '{}'::jsonb,
  paused_all boolean not null default false,
  paused_requests boolean not null default false,
  paused_resources text[] not null default '{}',
  pause_note text,
  hold_kind text,
  hold_until timestamptz,
  hold_since timestamptz,
  hold_step smallint not null default 0,
  hold_detail jsonb not null default '{}'::jsonb,
  network_failure_streak smallint not null default 0,
  resource_holds jsonb not null default '{}'::jsonb,
  identity_account_id text,
  identity_checked_at timestamptz,
  credentials_generation text,
  owner_generation bigint not null default 0,
  owner_instance uuid,
  owner_host text,
  owner_pid integer,
  owner_pid_start text,
  owner_pid_ns text,
  owner_boot_id text,
  owner_acquired_at timestamptz,
  owner_heartbeat_at timestamptz,
  owner_released_at timestamptz,
  owner_release_generation bigint,
  owner_stop_confirmed_at timestamptz,
  owner_stop_confirmed_by text,
  cycle_pos smallint not null default 0,
  planned_rr jsonb not null default '{}'::jsonb,
  last_admitted_at timestamptz,
  last_send_at timestamptz,
  last_send_attempt_id bigint,
  last_completed_at timestamptz,
  ws_router_cursor bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sync_pages_mode_check check (mode in ('off', 'shadow', 'handover', 'live')),
  constraint sync_pages_hold_kind_check check (
    hold_kind is null or hold_kind in ('rate_limit', 'auth', 'identity_mismatch', 'network')
  ),
  constraint sync_pages_hold_pair_check check ((hold_kind is null) = (hold_until is null)),
  constraint sync_pages_cycle_pos_check check (cycle_pos between 0 and 9),
  constraint sync_pages_owner_generation_check check (owner_generation >= 0)
);

create table if not exists sync_work (
  id bigserial primary key,
  page_id bigint not null references pages(id) on delete restrict,
  shadow boolean not null default false,
  resource text not null,
  subject text not null default '',
  kind text not null,
  class text not null,
  state text not null default 'open',
  due_at timestamptz not null default clock_timestamp(),
  coalesce_until timestamptz,
  deadline_at timestamptz,
  first_demand_at timestamptz not null default clock_timestamp(),
  last_served_at timestamptz,
  demand_revision bigint not null default 1,
  applied_revision bigint not null default 0,
  demand jsonb not null default '{}'::jsonb,
  cursor jsonb not null default '{}'::jsonb,
  goal jsonb,
  proof jsonb,
  params jsonb not null default '{}'::jsonb,
  secret_params text,
  result jsonb,
  failure_count smallint not null default 0,
  breaker_until timestamptz,
  blocked_by_vendor_at timestamptz,
  last_error_class text,
  last_attempt_id bigint,
  waiting_reason text,
  waiting_until timestamptz,
  attempts_count integer not null default 0,
  owner_generation bigint,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  close_reason text,
  constraint sync_work_resource_check check (resource ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'),
  constraint sync_work_subject_check check (length(subject) <= 200),
  constraint sync_work_kind_check check (kind in ('poll', 'trigger', 'goal', 'repair')),
  constraint sync_work_class_check check (class in ('urgent', 'requests', 'planned')),
  constraint sync_work_state_check check (
    state in ('open', 'running', 'quarantined', 'done', 'cancelled', 'superseded')
  ),
  constraint sync_work_waiting_reason_check check (
    waiting_reason is null or waiting_reason in (
      'not_due', 'pacer', 'class_share', 'page_hold', 'resource_hold', 'subject_breaker',
      'blocked_by_vendor', 'quarantined', 'paused', 'dependency', 'ownership_unconfirmed', 'running'
    )
  ),
  constraint sync_work_closed_check check ((state in ('done', 'cancelled', 'superseded')) = (closed_at is not null)),
  constraint sync_work_revision_check check (applied_revision <= demand_revision)
);

-- One open row per page × shadow × resource × subject: demand merges here.
create unique index if not exists sync_work_open_uniq
  on sync_work (page_id, shadow, resource, subject) where state in ('open', 'running', 'quarantined');
-- Every class pick (urgent by deadline, planned polls by due time, the planned
-- round robin's group by resource).
create index if not exists sync_work_runnable
  on sync_work (page_id, shadow, class, due_at) where state = 'open';
-- Breaker carry-forward to a new row of the same key; status of closed work.
create index if not exists sync_work_key_recent
  on sync_work (page_id, resource, subject, id desc);
-- Retention of closed rows.
create index if not exists sync_work_closed_at
  on sync_work (closed_at) where closed_at is not null;

-- Demand merge of upsertDemand: bounded id lists (first occurrences kept, in
-- order), the overflow flag set once a list would exceed its cap.
create or replace function sync_work_merge_ids(a jsonb, b jsonb, cap int) returns jsonb
language sql immutable parallel safe as $$
  select coalesce(jsonb_agg(v order by first_pos), '[]'::jsonb) from (
    select v, min(pos) as first_pos
      from jsonb_array_elements(coalesce(a, '[]'::jsonb) || coalesce(b, '[]'::jsonb)) with ordinality as e(v, pos)
     group by v
     order by min(pos)
     limit cap) s
$$;

create or replace function sync_work_merge_demand(a jsonb, b jsonb) returns jsonb
language sql immutable parallel safe as $$
  select jsonb_build_object(
    'messageIds', sync_work_merge_ids(a -> 'messageIds', b -> 'messageIds', 200),
    'txIds', sync_work_merge_ids(a -> 'txIds', b -> 'txIds', 200),
    'reasons', sync_work_merge_ids(a -> 'reasons', b -> 'reasons', 20),
    'overflow', coalesce((a ->> 'overflow')::boolean, false) or coalesce((b ->> 'overflow')::boolean, false)
      or (select count(distinct v) from jsonb_array_elements(
            coalesce(a -> 'messageIds', '[]'::jsonb) || coalesce(b -> 'messageIds', '[]'::jsonb)) e(v)) > 200
      or (select count(distinct v) from jsonb_array_elements(
            coalesce(a -> 'txIds', '[]'::jsonb) || coalesce(b -> 'txIds', '[]'::jsonb)) e(v)) > 200)
$$;

create table if not exists sync_attempts (
  id bigserial primary key,
  page_id bigint not null references pages(id) on delete restrict,
  shadow boolean not null default false,
  -- no FK: work retention is independent of the attempt journal
  work_id bigint,
  resource text not null,
  subject text not null default '',
  class text not null,
  slot smallint,
  owner_generation bigint not null,
  demand_revision bigint,
  setting_ms integer not null,
  jitter_u double precision not null,
  pause_ms integer not null,
  admitted_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  send_mark text,
  send_mono_offset_ms double precision,
  gap_prev_ms double precision,
  completed_at timestamptz,
  operation text not null,
  request jsonb not null,
  outcome text not null default 'admitted',
  http_status smallint,
  retry_after_ms integer,
  error_class text,
  duration_ms integer,
  response_bytes integer,
  -- observations' primary key is (id, received_at): no FK is possible
  observation_id bigint,
  observation_received_at timestamptz,
  apply_state text not null default 'none',
  apply_error text,
  apply_failures smallint not null default 0,
  apply_retry_at timestamptz,
  applied_at timestamptz,
  evidence boolean not null default false,
  constraint sync_attempts_class_check check (class in ('urgent', 'requests', 'planned')),
  constraint sync_attempts_slot_check check (slot is null or slot between 0 and 9),
  constraint sync_attempts_setting_check check (setting_ms > 0),
  constraint sync_attempts_jitter_check check (jitter_u >= 0 and jitter_u <= 0.2),
  constraint sync_attempts_send_mark_check check (
    send_mark is null or send_mark in ('request_start', 'completion_fallback', 'shadow')
  ),
  constraint sync_attempts_outcome_check check (outcome in (
    'admitted', 'sent', 'response', 'transport_error', 'timeout', 'aborted_before_send', 'unknown', 'shadow'
  )),
  constraint sync_attempts_apply_state_check check (
    apply_state in ('none', 'captured', 'applied', 'deferred', 'quarantined', 'skipped')
  ),
  constraint sync_attempts_observation_check check ((observation_id is null) = (observation_received_at is null))
);

-- The takeover floor (paceFloorFromDb, last 10 minutes) and per-page history.
create index if not exists sync_attempts_page_admitted on sync_attempts (page_id, admitted_at desc);
-- The pace audit over actual sends.
create index if not exists sync_attempts_page_sent on sync_attempts (page_id, sent_at) where sent_at is not null;
create index if not exists sync_attempts_work on sync_attempts (work_id, id desc);
-- Recovery at actor start and the apply drain.
create index if not exists sync_attempts_unfinished on sync_attempts (page_id, id)
  where outcome in ('admitted', 'sent') or apply_state in ('captured', 'deferred');
-- Retention (coverage evidence is never pruned).
create index if not exists sync_attempts_retention on sync_attempts (admitted_at) where not evidence;

comment on table sync_pages is
  'Fansly Sync Engine (plan §11): per-page mode, pauses, holds, ownership generation, scheduler and pacer facts.';
comment on column sync_pages.mode is
  'off: legacy engine; shadow: actor without HTTP or domain writes; handover: legacy fenced, actor not sending yet; live: the actor is the only sender. handover/live only through the switch CLI.';
comment on column sync_pages.owner_generation is
  'Incremented by every ownership acquisition; every write of an actor is fenced by it.';
comment on column sync_pages.owner_released_at is
  'Safe release written by the owner after its last completion (generation owner_release_generation).';
comment on column sync_pages.last_send_at is
  'Wall clock of the last actual live send (undici onRequestStart); a takeover waits >= 1.2 x S after it.';
comment on column sync_pages.ws_router_cursor is
  'Last fansly_ws_decode_receipts.observation_id the shadow actor routed into demand.';
comment on table sync_work is
  'Fansly Sync Engine (plan §3, §11): the one work queue; one open row per page, shadow, resource and subject.';
comment on column sync_work.demand_revision is
  'Raised by every new demand; an attempt admitted at an older revision never closes newer demand.';
comment on column sync_work.applied_revision is
  'The demand revision the last applied response satisfied.';
comment on column sync_work.secret_params is
  'Ciphertext (same box as page_credentials); cleared in the transaction that closes the work.';
comment on table sync_attempts is
  'Fansly Sync Engine (plan §8, §11): one row per physical (or shadow) attempt; 30-day telemetry except evidence and unfinished rows.';
comment on column sync_attempts.sent_at is
  'Wall clock at undici onRequestStart (send_mark request_start), at completion (completion_fallback) or simulated (shadow).';
comment on column sync_attempts.evidence is
  'Request parameters are coverage evidence (dm-messages, notifications, purchases, catalog vault, post replies): never pruned.';

insert into sync_pages (page_id, mode, mode_changed_by)
select p.id, 'off', 'migration:0228' from pages p where p.platform = 'fansly'
on conflict (page_id) do nothing;

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on sync_pages to read_only;
    grant select on sync_attempts to read_only;
    -- every column of sync_work except the ciphertext
    grant select (id, page_id, shadow, resource, subject, kind, class, state, due_at, coalesce_until, deadline_at,
      first_demand_at, last_served_at, demand_revision, applied_revision, demand, cursor, goal, proof, params, result,
      failure_count, breaker_until, blocked_by_vendor_at, last_error_class, last_attempt_id, waiting_reason,
      waiting_until, attempts_count, owner_generation, created_at, updated_at, closed_at, close_reason)
      on sync_work to read_only;
  end if;
end $$;
