-- OF mirror S0: the legacy OnlyFans per-chat history crawler is a permanently
-- retired lane. This invariant deliberately lives in Postgres so it survives
-- an application rollback and also protects pages created by an older image.
-- The trigger coerces legacy writes instead of rejecting them: an old runtime
-- can keep operating its unrelated streams without retrying a failed state
-- seed transaction.

create or replace function guard_retired_onlyfans_dm_messages()
returns trigger
language plpgsql
as $$
begin
  if new.stream = 'dm_messages'::sync_stream
     and exists (
       select 1
       from pages p
       where p.id = new.page_id
         and p.platform = 'onlyfans'
     ) then
    new.status := 'paused'::page_sync_status;
    new.blocker_kind := 'retired';
    new.blocker_code := 'legacy_ofapi_dm_messages_retired';
    new.blocker_message :=
      'Legacy OnlyFans dm_messages crawler is permanently retired; history acquisition is owned by durable OF mirror jobs';
    new.blocked_at := coalesce(new.blocked_at, clock_timestamp());
    new.leased_seq := null;
    new.lease_owner := null;
    new.lease_token := null;
    new.lease_heartbeat_at := null;
    new.lease_expires_at := null;
    new.retry_kind := null;
    new.retry_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists page_sync_states_retired_onlyfans_dm_messages_guard
  on page_sync_states;
create trigger page_sync_states_retired_onlyfans_dm_messages_guard
before insert or update on page_sync_states
for each row execute function guard_retired_onlyfans_dm_messages();

insert into page_sync_states (
  page_id,
  stream,
  status,
  cadence_seconds,
  slot_offset_seconds,
  blocker_kind,
  blocker_code,
  blocker_message,
  blocked_at,
  created_at,
  updated_at
)
select p.id,
       'dm_messages',
       'paused',
       86400,
       mod(
         (p.id::bigint * 2654435761::bigint) +
           (9::bigint * 2246822519::bigint),
         86400::bigint
       )::int,
       'retired',
       'legacy_ofapi_dm_messages_retired',
       'Legacy OnlyFans dm_messages crawler is permanently retired; history acquisition is owned by durable OF mirror jobs',
       clock_timestamp(),
       clock_timestamp(),
       clock_timestamp()
from pages p
where p.platform = 'onlyfans'
  and p.status = 'active'
on conflict (page_id, stream) do nothing;

update page_sync_states st
set status = 'paused',
    blocker_kind = 'retired',
    blocker_code = 'legacy_ofapi_dm_messages_retired',
    blocker_message =
      'Legacy OnlyFans dm_messages crawler is permanently retired; history acquisition is owned by durable OF mirror jobs',
    blocked_at = coalesce(st.blocked_at, clock_timestamp()),
    leased_seq = null,
    lease_owner = null,
    lease_token = null,
    lease_heartbeat_at = null,
    lease_expires_at = null,
    retry_kind = null,
    retry_at = null,
    updated_at = clock_timestamp()
from pages p
where p.id = st.page_id
  and p.platform = 'onlyfans'
  and st.stream = 'dm_messages';
