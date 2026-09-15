-- C2c additional REST attempts are bounded independently of daily rotation.
-- Reservations survive crashes and cannot be reset by toggling the flag.
create table fan_earnings_target_attempts (
  page_id bigint not null references pages(id) on delete restrict,
  request_id text not null,
  attempt_number integer not null check (attempt_number > 0),
  sync_run_id bigint not null,
  admitted_at timestamptz not null default clock_timestamp(),
  primary key(page_id, request_id, attempt_number)
);
create index fan_earnings_target_attempts_budget on fan_earnings_target_attempts(page_id, admitted_at);
create view fan_earnings_target_attempt_status as
  select h.page_id, h.request_id, h.attempt_number, h.sync_run_id, h.admitted_at,
    a.state, a.http_status, a.finished_at
  from fan_earnings_target_attempts h left join sync_http_attempts a
    on a.sync_run_id = h.sync_run_id and a.logical_request_id = h.request_id and a.attempt_number = h.attempt_number;
do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on fan_earnings_target_attempts, fan_earnings_target_attempt_status to read_only;
  end if;
end $$;
