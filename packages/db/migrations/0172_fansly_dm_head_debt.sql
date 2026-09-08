-- Decision 277: a successful read is not a receipt for an expected message.
-- Operational work, retained until explicitly resolved; no scheduled deletion.
create table fansly_dm_head_debt (
  conversation_id bigint not null references page_dm_threads(id) on delete cascade,
  message_id text not null,
  message_at timestamptz,
  first_observed_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts between 0 and 5),
  next_retry_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  captured_at timestamptz,
  primary key (conversation_id, message_id)
);
create index fansly_dm_head_debt_pending_idx
  on fansly_dm_head_debt (conversation_id, next_retry_at)
  where captured_at is null and attempts < 5;

-- Seed only known, non-null heads lacking an exact, live stored row. No
-- provider reads or wakeups: the selection allowlist defaults to none.
insert into fansly_dm_head_debt (conversation_id, message_id, message_at)
select c.id, c.last_message_id, c.last_message_at
from page_dm_threads c join pages p on p.id = c.platform_account_id
where p.platform = 'fansly' and c.last_message_id is not null
  and not exists (
    select 1 from page_dm_messages m
    where m.conversation_id = c.id and m.platform_message_id = c.last_message_id
      and m.deleted_at is null
  );

-- IDs and operational state only. No message text or credentials are exposed.
create view fansly_dm_head_debt_report as
select p.id as page_id, p.label as page_label, c.platform_conversation_id,
       d.message_id, d.message_at, d.first_observed_at, d.attempts,
       d.next_retry_at, d.last_attempt_at, d.captured_at,
       c.is_visible, c.fan_id is not null as identity_resolved,
       c.metadata ->> 'messageSyncExcludedReason' as excluded_reason,
       c.message_coverage_status as history_coverage,
       case when d.captured_at is not null then 'captured'
            when d.attempts >= 5 then 'exhausted'
            when d.next_retry_at > now() then 'backoff'
            else 'pending' end as state
from fansly_dm_head_debt d
join page_dm_threads c on c.id = d.conversation_id
join pages p on p.id = c.platform_account_id;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on fansly_dm_head_debt_report to read_only;
  end if;
end $$;
