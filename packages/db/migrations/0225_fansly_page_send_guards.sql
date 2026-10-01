-- 0225_fansly_page_send_guards.sql
--
-- Fansly Sync Engine plan §2.5 step 1: the legacy engine's per-page send guard.
-- Between the sends of any two requests of one Fansly page there is at least
-- S (the owner setting fanslyDefaultDelayMs) — a strict minimum, counted from
-- the COMPLETION of the previous request, by the database clock, across every
-- process and every sender of the page.
--
-- fansly_page_send_guards: one row per Fansly page, shared by every process.
--   holder_*          the capture in force: its token and the identity of the
--                     process holding it (host = container hostname, pid, the
--                     pid's start token, the pid namespace, the kernel boot id,
--                     a uuid per process start, the process role)
--   captured_at       when the capture was granted (DB clock)
--   lease_until       capture + send window + request timeout + margin. An
--                     expired lease does NOT open the page: it stays closed
--                     until its holder writes a completion, or the holder's
--                     death is confirmed at OS or Docker level.
--   last_completed_at the previous request's completion (DB clock); the next
--                     capture waits until last_completed_at + S × (1 + next_u)
--   next_u            the jitter drawn at that completion, u ∈ [0, 0.2); 0.2
--                     after seeding and after a confirmed termination (1.2 × S)
--   closed_*          set when a lease expired with its holder unconfirmed
--
-- fansly_send_log: append-only journal of EVERY guarded attempt (any source,
-- any process), written at capture and completed by the holder or by the
-- confirmation of its death. page_id is null for a check of an unknown
-- session (onboarding, credentials verify), which is paced against no page
-- (owner decision №4). Telemetry, not captured facts: it expires with the
-- other sync observability tables (deleteExpiredSyncObservability).
--
-- Purely additive, IF NOT EXISTS; the previous image never names either table.
create table if not exists fansly_page_send_guards (
  page_id bigint primary key references pages(id) on delete cascade,
  holder_token uuid,
  holder_source text,
  holder_operation text,
  holder_host text,
  holder_pid integer,
  holder_pid_start text,
  holder_pid_ns text,
  holder_boot_id text,
  holder_instance uuid,
  holder_role text,
  captured_at timestamptz,
  lease_until timestamptz,
  last_completed_at timestamptz not null,
  next_u double precision not null,
  closed_reason text,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint fansly_page_send_guards_next_u_check check (next_u >= 0 and next_u <= 0.2),
  constraint fansly_page_send_guards_holder_check check (
    (holder_token is null and captured_at is null and lease_until is null
      and closed_reason is null and closed_at is null)
    or (holder_token is not null and captured_at is not null and lease_until is not null
      and holder_source is not null and holder_host is not null
      and holder_pid is not null and holder_instance is not null)
  )
);

-- Every existing Fansly page starts closed for 1.2 × S from the deploy, as if
-- its previous request had just completed.
insert into fansly_page_send_guards (page_id, last_completed_at, next_u, updated_at)
select id, now(), 0.2, now() from pages where platform = 'fansly'
on conflict (page_id) do nothing;

create table if not exists fansly_send_log (
  id bigserial primary key,
  page_id bigint references pages(id) on delete cascade,
  guard_token uuid not null,
  source text not null,
  operation text not null,
  holder_host text not null,
  holder_pid integer not null,
  holder_role text not null,
  holder_instance uuid not null,
  setting_ms integer,
  jitter_u double precision,
  pause_ms integer,
  previous_completed_at timestamptz,
  capture_wait_ms integer not null default 0,
  capture_refusals integer not null default 0,
  captured_at timestamptz not null,
  sent_at timestamptz,
  send_offset_ms integer,
  completed_at timestamptz,
  outcome text,
  outcome_detail text,
  http_status integer,
  constraint fansly_send_log_source_check check (source in (
    'sync_stream', 'ws_hint', 'ai_accelerator', 'targeted_backfill', 'ai_fast_lane',
    'account_me_api', 'account_me_cli', 'endpoint_probe', 'replay_probe', 'alias_backfill',
    'onboarding', 'credentials_verify',
    'media_download', 'ws_connect', 'binding_preflight', 'ws_probe'
  )),
  constraint fansly_send_log_outcome_check check (outcome is null or outcome in (
    'response', 'transport_error', 'timeout', 'aborted_before_send', 'confirmed_terminated'
  )),
  constraint fansly_send_log_completion_check check ((completed_at is null) = (outcome is null))
);

create unique index if not exists fansly_send_log_guard_token_uidx
  on fansly_send_log (guard_token);
create index if not exists fansly_send_log_page_captured_idx
  on fansly_send_log (page_id, captured_at);
-- The retention sweep's scan (page_id is null for unknown-session checks).
create index if not exists fansly_send_log_captured_idx
  on fansly_send_log (captured_at);

comment on table fansly_page_send_guards is
  'Plan §2.5: the per-page Fansly send guard shared by every legacy-engine process (capture by DB clock, completion-based pause).';
comment on table fansly_send_log is
  'Plan §2.5: journal of every guarded Fansly attempt from any source and process; 30-day telemetry retention.';
comment on column fansly_send_log.sent_at is
  'Wall clock of the sending process when the transport was about to write the request headers; null when nothing was sent.';
comment on column fansly_send_log.send_offset_ms is
  'Monotonic time from the issue of the capture statement to the send.';

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on fansly_page_send_guards to read_only;
    grant select on fansly_send_log to read_only;
  end if;
end $$;
