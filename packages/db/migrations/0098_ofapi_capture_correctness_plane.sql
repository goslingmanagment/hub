-- OF mirror S1: durable intent, physical-attempt certainty, admission
-- accounting, and operator controls. Protocol vocabularies intentionally use
-- text + CHECK rather than PostgreSQL enums so an older application image can
-- still read the database after a rollback.

alter table ofapi_credit_state
  add column governed_scope_day date,
  add column live_spent_credits integer not null default 0,
  add column interactive_spent_credits integer not null default 0,
  add column bulk_spent_credits integer not null default 0,
  add column governed_unsettled_credits integer not null default 0,
  add column floor_probe_not_before timestamptz,
  add constraint ofapi_credit_state_governed_counters_nonnegative_check check (
    live_spent_credits >= 0
    and interactive_spent_credits >= 0
    and bulk_spent_credits >= 0
    and governed_unsettled_credits >= 0
  );

create table ofapi_capture_jobs (
  id uuid primary key,
  page_id bigint not null references pages(id) on delete restrict,
  ofapi_account_id text not null,
  kind text not null,
  goal text,
  state text not null default 'ready',
  active_slot_key text not null,
  target jsonb not null,
  target_hash char(64) not null,
  target_generation integer not null default 0,
  manifest jsonb,
  cursor jsonb,
  cursor_hash char(64),
  row_version bigint not null default 0,
  next_attempt_at timestamptz not null default now(),
  priority integer not null default 0,
  budget_scope text not null,
  origin_principal_id bigint references users(id) on delete restrict,
  created_by text not null,
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  pending_observation_id bigint,
  pending_observation_received_at timestamptz,
  terminal_observation_id bigint,
  terminal_observation_received_at timestamptz,
  reason_code text,
  reason_message text,
  result jsonb,
  max_calls integer,
  max_credits integer,
  max_pages integer,
  max_items integer,
  attempt_count integer not null default 0,
  dispatch_count integer not null default 0,
  spent_credits integer not null default 0,
  accepted_items bigint not null default 0,
  accepted_pages bigint not null default 0,
  zero_progress_count integer not null default 0,
  source_contract_version text not null,
  parser_version text not null,
  proof_policy_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint ofapi_capture_jobs_kind_check check (
    kind in ('chat_paginate', 'campaign_snapshot', 'head_repair', 'account_export', 'export_import')
  ),
  constraint ofapi_capture_jobs_goal_check check (
    (kind = 'chat_paginate' and goal in ('history_to_exhaustion', 'connect_to_anchor', 'bounded_tail'))
    or (kind <> 'chat_paginate' and goal is null)
  ),
  constraint ofapi_capture_jobs_state_check check (
    state in ('ready', 'leased', 'awaiting_parse', 'retry_wait', 'blocked', 'complete', 'cancelled')
  ),
  constraint ofapi_capture_jobs_budget_scope_check check (
    budget_scope in ('live', 'interactive', 'bulk')
  ),
  constraint ofapi_capture_jobs_created_by_check check (
    created_by in ('owner', 'cohort_seed', 'product_signal', 'interactive_open', 'verification_probe')
  ),
  constraint ofapi_capture_jobs_page_slot_check check (
    active_slot_key like ('page:' || page_id::text || ':%')
  ),
  constraint ofapi_capture_jobs_target_object_check check (jsonb_typeof(target) = 'object'),
  constraint ofapi_capture_jobs_manifest_object_check check (
    manifest is null or jsonb_typeof(manifest) = 'object'
  ),
  constraint ofapi_capture_jobs_cursor_object_check check (
    cursor is null or jsonb_typeof(cursor) = 'object'
  ),
  constraint ofapi_capture_jobs_result_object_check check (
    result is null or jsonb_typeof(result) = 'object'
  ),
  constraint ofapi_capture_jobs_target_hash_check check (target_hash ~ '^[0-9a-f]{64}$'),
  constraint ofapi_capture_jobs_cursor_hash_check check (
    cursor_hash is null or cursor_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint ofapi_capture_jobs_lease_shape_check check (
    (lease_owner is null and lease_token is null and lease_until is null)
    or (lease_owner is not null and lease_token is not null and lease_until is not null)
  ),
  constraint ofapi_capture_jobs_pending_observation_pair_check check (
    (pending_observation_id is null) = (pending_observation_received_at is null)
  ),
  constraint ofapi_capture_jobs_terminal_observation_pair_check check (
    (terminal_observation_id is null) = (terminal_observation_received_at is null)
  ),
  constraint ofapi_capture_jobs_interactive_principal_check check (
    budget_scope <> 'interactive' or origin_principal_id is not null
  ),
  constraint ofapi_capture_jobs_blocked_reason_check check (
    state <> 'blocked' or reason_code is not null
  ),
  constraint ofapi_capture_jobs_complete_evidence_check check (
    state <> 'complete' or (
      terminal_observation_id is not null
      and completed_at is not null
    )
  ),
  constraint ofapi_capture_jobs_terminal_time_check check (
    (state in ('complete', 'cancelled')) = (completed_at is not null)
  ),
  constraint ofapi_capture_jobs_nonnegative_check check (
    target_generation >= 0
    and attempt_count >= 0
    and dispatch_count >= 0
    and spent_credits >= 0
    and accepted_items >= 0
    and accepted_pages >= 0
    and zero_progress_count >= 0
    and (max_calls is null or max_calls >= 0)
    and (max_credits is null or max_credits >= 0)
    and (max_pages is null or max_pages >= 0)
    and (max_items is null or max_items >= 0)
  )
);

create unique index ofapi_capture_jobs_active_slot_uniq
  on ofapi_capture_jobs(active_slot_key)
  where state in ('ready', 'leased', 'awaiting_parse', 'retry_wait', 'blocked');
create index ofapi_capture_jobs_runnable_idx
  on ofapi_capture_jobs(next_attempt_at, priority desc, created_at)
  where state in ('ready', 'retry_wait');
create index ofapi_capture_jobs_page_state_idx
  on ofapi_capture_jobs(page_id, state);
create index ofapi_capture_jobs_lease_until_idx
  on ofapi_capture_jobs(lease_until)
  where state = 'leased';
create index ofapi_capture_jobs_awaiting_parse_idx
  on ofapi_capture_jobs(updated_at)
  where state = 'awaiting_parse';

create function guard_ofapi_capture_job_frozen_identity()
returns trigger
language plpgsql
as $$
begin
  if new.page_id is distinct from old.page_id
     or new.ofapi_account_id is distinct from old.ofapi_account_id
     or new.kind is distinct from old.kind
     or new.goal is distinct from old.goal
     or new.active_slot_key is distinct from old.active_slot_key
     or new.target is distinct from old.target
     or new.target_hash is distinct from old.target_hash
     or new.target_generation is distinct from old.target_generation
     or new.budget_scope is distinct from old.budget_scope
     or new.origin_principal_id is distinct from old.origin_principal_id then
    raise exception 'ofapi_capture_job frozen identity cannot be changed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger ofapi_capture_jobs_frozen_identity_guard
before update on ofapi_capture_jobs
for each row execute function guard_ofapi_capture_job_frozen_identity();

create table ofapi_interactive_requests (
  id uuid primary key,
  page_id bigint not null references pages(id) on delete restrict,
  ofapi_account_id text not null,
  principal_user_id bigint not null references users(id) on delete restrict,
  operation text not null,
  surface text not null,
  target jsonb not null,
  request_fingerprint char(64) not null,
  state text not null default 'created',
  row_version bigint not null default 0,
  response_observation_id bigint,
  response_observation_received_at timestamptz,
  http_outcome text,
  error_code text,
  policy_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint ofapi_interactive_requests_target_check check (jsonb_typeof(target) = 'object'),
  constraint ofapi_interactive_requests_fingerprint_check check (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint ofapi_interactive_requests_state_check check (
    state in ('created', 'attempt_reserved', 'response_captured', 'served', 'failed', 'indeterminate')
  ),
  constraint ofapi_interactive_requests_observation_pair_check check (
    (response_observation_id is null) = (response_observation_received_at is null)
  ),
  constraint ofapi_interactive_requests_terminal_time_check check (
    (state in ('served', 'failed', 'indeterminate')) = (completed_at is not null)
  ),
  constraint ofapi_interactive_requests_capture_shape_check check (
    state not in ('response_captured', 'served') or response_observation_id is not null
  )
);

create index ofapi_interactive_requests_principal_created_idx
  on ofapi_interactive_requests(principal_user_id, created_at desc);
create index ofapi_interactive_requests_incomplete_idx
  on ofapi_interactive_requests(updated_at)
  where state in ('created', 'attempt_reserved', 'response_captured');

create table ofapi_request_attempts (
  id uuid primary key,
  owner_kind text not null,
  owner_id uuid not null,
  capture_job_id uuid references ofapi_capture_jobs(id) on delete restrict,
  interactive_request_id uuid references ofapi_interactive_requests(id) on delete restrict,
  owner_attempt_no integer not null,
  page_id bigint not null references pages(id) on delete restrict,
  ofapi_account_id text not null,
  origin_principal_id bigint references users(id) on delete restrict,
  budget_scope text not null,
  reservation_day date not null,
  deadline_at timestamptz not null,
  admission_snapshot jsonb not null,
  operation text not null,
  endpoint_class text not null,
  egress_key text not null,
  method text not null,
  request_semantics text not null,
  request_fingerprint char(64) not null,
  is_floor_probe boolean not null default false,
  principal_window_started_at timestamptz,
  state text not null default 'reserved',
  dispatch_outcome text,
  http_outcome text,
  parser_outcome text not null default 'pending',
  raw_count bigint not null default 0,
  accepted_count bigint not null default 0,
  boundary_duplicate_count bigint not null default 0,
  explicitly_irrelevant_count bigint not null default 0,
  rejected_count bigint not null default 0,
  credit_state text not null default 'reserved',
  reserved_credits integer not null,
  settled_credits integer,
  credit_estimated boolean,
  balance_after integer,
  response_observation_id bigint,
  response_observation_received_at timestamptz,
  fence_token uuid not null,
  job_lease_token uuid,
  surface text,
  serving_mode text,
  fallback_reason text,
  policy_version text not null,
  source_contract_version text not null,
  parser_version text not null,
  reserved_at timestamptz not null default now(),
  dispatch_started_at timestamptz,
  response_captured_at timestamptz,
  response_observed_at timestamptz,
  finished_at timestamptz,
  certainty_resolved_at timestamptz,
  certainty_resolution text,
  updated_at timestamptz not null default now(),
  constraint ofapi_request_attempts_owner_kind_check check (
    owner_kind in ('capture_job', 'interactive_request')
  ),
  constraint ofapi_request_attempts_owner_shape_check check (
    (
      owner_kind = 'capture_job'
      and capture_job_id = owner_id
      and interactive_request_id is null
    )
    or (
      owner_kind = 'interactive_request'
      and capture_job_id is null
      and interactive_request_id = owner_id
      and budget_scope = 'interactive'
      and origin_principal_id is not null
    )
  ),
  constraint ofapi_request_attempts_owner_attempt_no_check check (owner_attempt_no > 0),
  constraint ofapi_request_attempts_deadline_check check (deadline_at > reserved_at),
  constraint ofapi_request_attempts_budget_scope_check check (
    budget_scope in ('live', 'interactive', 'bulk')
  ),
  constraint ofapi_request_attempts_admission_snapshot_check check (
    jsonb_typeof(admission_snapshot) = 'object'
  ),
  constraint ofapi_request_attempts_method_check check (
    method in ('GET', 'POST', 'DELETE', 'PATCH')
  ),
  constraint ofapi_request_attempts_semantics_check check (
    request_semantics in ('safe_read', 'stateful')
  ),
  constraint ofapi_request_attempts_fingerprint_check check (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint ofapi_request_attempts_floor_probe_scope_check check (
    not is_floor_probe or budget_scope = 'live'
  ),
  constraint ofapi_request_attempts_principal_window_check check (
    (origin_principal_id is null) = (principal_window_started_at is null)
  ),
  constraint ofapi_request_attempts_state_check check (
    state in ('reserved', 'released_pre_dispatch', 'dispatching', 'response_captured', 'indeterminate')
  ),
  constraint ofapi_request_attempts_dispatch_outcome_check check (
    dispatch_outcome is null or dispatch_outcome in (
      'response_received', 'vendor_slow', 'transport', 'capture_uncommitted'
    )
  ),
  constraint ofapi_request_attempts_http_outcome_check check (
    http_outcome is null or http_outcome in (
      'success', 'not_found', 'auth_confirmed', 'forbidden_unconfirmed',
      'rate', 'vendor_5xx', 'request_rejected', 'unexpected_http', 'invalid_response'
    )
  ),
  constraint ofapi_request_attempts_parser_outcome_check check (
    parser_outcome in ('pending', 'accepted', 'intentional_noop', 'contract_rejected', 'failed')
  ),
  constraint ofapi_request_attempts_credit_state_check check (
    credit_state in ('reserved', 'settled', 'released', 'indeterminate')
  ),
  constraint ofapi_request_attempts_serving_mode_check check (
    serving_mode is null or serving_mode in ('vendor_only', 'shadow', 'db_fallback', 'db_only')
  ),
  constraint ofapi_request_attempts_fallback_reason_check check (
    fallback_reason is null or fallback_reason in (
      'surface_not_cutover', 'no_certificate', 'stale_head', 'gap',
      'projection_lag', 'shadow_probe'
    )
  ),
  constraint ofapi_request_attempts_nonnegative_check check (
    reserved_credits >= 0
    and (settled_credits is null or settled_credits >= 0)
    and raw_count >= 0
    and accepted_count >= 0
    and boundary_duplicate_count >= 0
    and explicitly_irrelevant_count >= 0
    and rejected_count >= 0
  ),
  constraint ofapi_request_attempts_observation_pair_check check (
    (response_observation_id is null) = (response_observation_received_at is null)
  ),
  constraint ofapi_request_attempts_state_shape_check check (
    (
      state = 'reserved'
      and dispatch_started_at is null
      and response_observation_id is null
      and finished_at is null
      and credit_state = 'reserved'
    ) or (
      state = 'released_pre_dispatch'
      and dispatch_started_at is null
      and response_observation_id is null
      and finished_at is not null
      and credit_state = 'released'
    ) or (
      state = 'dispatching'
      and dispatch_started_at is not null
      and response_observation_id is null
      and finished_at is null
      and credit_state = 'reserved'
    ) or (
      state = 'response_captured'
      and dispatch_started_at is not null
      and response_observation_id is not null
      and response_captured_at is not null
      and response_observed_at is not null
      and finished_at is not null
      and dispatch_outcome = 'response_received'
      and credit_state = 'settled'
    ) or (
      state = 'indeterminate'
      and dispatch_started_at is not null
      and response_observation_id is null
      and finished_at is not null
      and dispatch_outcome in ('vendor_slow', 'transport', 'capture_uncommitted')
      and (
        (
          certainty_resolved_at is null
          and certainty_resolution is null
          and credit_state = 'indeterminate'
          and settled_credits is null
        ) or (
          certainty_resolved_at is not null
          and certainty_resolution is not null
          and credit_state in ('released', 'settled')
        )
      )
      and http_outcome is null
      and (
        dispatch_outcome <> 'capture_uncommitted'
        or response_observed_at is not null
      )
    )
  ),
  constraint ofapi_request_attempts_parse_balance_check check (
    parser_outcome not in ('accepted', 'intentional_noop')
    or (
      raw_count = accepted_count + boundary_duplicate_count + explicitly_irrelevant_count
      and rejected_count = 0
    )
  )
);

create unique index ofapi_request_attempts_owner_attempt_uniq
  on ofapi_request_attempts(owner_kind, owner_id, owner_attempt_no);
create unique index ofapi_request_attempts_active_owner_uniq
  on ofapi_request_attempts(owner_kind, owner_id)
  where state in ('reserved', 'dispatching')
     or (state = 'indeterminate' and certainty_resolved_at is null);
create unique index ofapi_request_attempts_active_floor_probe_uniq
  on ofapi_request_attempts(is_floor_probe)
  where is_floor_probe = true
    and (
      state in ('reserved', 'dispatching')
      or (state = 'indeterminate' and certainty_resolved_at is null)
    );
create unique index ofapi_request_attempts_observation_uniq
  on ofapi_request_attempts(response_observation_id, response_observation_received_at)
  where response_observation_id is not null;
create index ofapi_request_attempts_job_reserved_idx
  on ofapi_request_attempts(capture_job_id, reserved_at);
create index ofapi_request_attempts_budget_idx
  on ofapi_request_attempts(reservation_day, budget_scope, page_id);
create index ofapi_request_attempts_endpoint_health_idx
  on ofapi_request_attempts(page_id, endpoint_class, finished_at desc);
create index ofapi_request_attempts_principal_idx
  on ofapi_request_attempts(origin_principal_id, reserved_at desc)
  where origin_principal_id is not null;
create index ofapi_request_attempts_indeterminate_idx
  on ofapi_request_attempts(finished_at)
  where state = 'indeterminate' and certainty_resolved_at is null;

alter table ofapi_credit_ledger
  add column attempt_id uuid references ofapi_request_attempts(id) on delete restrict,
  add column attempt_entry_phase text,
  add constraint ofapi_credit_ledger_attempt_shape_check check (
    (attempt_id is null and attempt_entry_phase is null)
    or (
      attempt_id is not null
      and attempt_entry_phase in ('settlement', 'certainty_adjustment')
    )
  );
create unique index ofapi_credit_ledger_attempt_phase_uniq
  on ofapi_credit_ledger(attempt_id, attempt_entry_phase)
  where attempt_id is not null;

alter table observations drop constraint observations_source_check;
alter table observations add constraint observations_source_check check (
  source in (
    'webhook', 'pull', 'client_capture', 'readthrough',
    'command_result', 'operator', 'ofapi_capture'
  )
);

create table ofapi_budget_denial_daily (
  day date not null,
  scope text not null,
  page_id bigint not null references pages(id) on delete restrict,
  principal_key text not null,
  principal_user_id bigint references users(id) on delete restrict,
  reason text not null,
  denied_count bigint not null default 0,
  threshold_crossings bigint not null default 0,
  first_denied_at timestamptz not null,
  last_denied_at timestamptz not null,
  primary key (day, scope, page_id, principal_key, reason),
  constraint ofapi_budget_denial_daily_scope_check check (scope in ('live', 'interactive', 'bulk')),
  constraint ofapi_budget_denial_daily_principal_shape_check check (
    (principal_key = 'system' and principal_user_id is null)
    or (principal_key = ('user:' || principal_user_id::text) and principal_user_id is not null)
  ),
  constraint ofapi_budget_denial_daily_reason_check check (
    reason in (
      'global_cap', 'scope_cap', 'job_cap', 'manifest_cap',
      'principal_credit_cap', 'principal_call_cap', 'principal_storm_block',
      'credit_floor', 'balance_stale', 'persistent_pause', 'deadline'
    )
  ),
  constraint ofapi_budget_denial_daily_nonnegative_check check (
    denied_count >= 0 and threshold_crossings >= 0
  )
);

create table ofapi_principal_budget_state (
  principal_user_id bigint primary key references users(id) on delete restrict,
  window_started_at timestamptz not null,
  used_calls integer not null default 0,
  used_credits integer not null default 0,
  consecutive_budget_denials integer not null default 0,
  blocked_until timestamptz,
  last_denial_reason text,
  last_denial_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint ofapi_principal_budget_state_nonnegative_check check (
    used_calls >= 0 and used_credits >= 0 and consecutive_budget_denials >= 0
  )
);

create table ofapi_capture_controls (
  control_key text primary key,
  paused boolean not null default false,
  reason text,
  version bigint not null default 0,
  actor_user_id bigint references users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  constraint ofapi_capture_controls_key_check check (
    control_key = 'global'
    or control_key ~ '^page:[0-9]+$'
    or control_key in ('scope:live', 'scope:interactive', 'scope:bulk')
    or control_key ~ '^operation:[a-z0-9_.:-]+$'
  ),
  constraint ofapi_capture_controls_reason_check check (not paused or reason is not null),
  constraint ofapi_capture_controls_version_check check (version >= 0)
);

create table ofapi_capture_operator_actions (
  id bigserial primary key,
  action text not null,
  target_type text not null,
  target_ref text not null,
  expected_state text,
  previous_state jsonb,
  resulting_state jsonb,
  dry_run boolean not null,
  actor_user_id bigint references users(id) on delete restrict,
  reason text not null,
  occurred_at timestamptz not null default now(),
  constraint ofapi_capture_operator_actions_target_check check (
    target_type in ('job', 'attempt', 'control', 'credit', 'observation')
  )
);
