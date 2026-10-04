-- chat-extension H-3: a device token may be bound to a client profile, the
-- route allowlist of a narrow token (packages/contracts/src/client-token-scopes.ts).
-- The column holds the profile NAME, never a list of operations, so a route the
-- profile gains later reaches tokens already issued. NULL = a full token: no row
-- is rewritten, every token issued before this migration stays full.
alter table device_tokens add column client_profile text
  check (client_profile is null or client_profile in ('chat-extension'));

-- Set once, at issuance. A narrow token that could be widened (or a full one
-- narrowed) in place would make the allowlist a suggestion; the trigger fires
-- only when an UPDATE names the column, so the hot last_used_at stamp is free.
create or replace function device_tokens_client_profile_immutable() returns trigger language plpgsql as $$
begin
  if old.client_profile is distinct from new.client_profile then
    raise exception 'device_tokens.client_profile is immutable';
  end if;
  return new;
end $$;

create trigger device_tokens_client_profile_immutable before update of client_profile on device_tokens
  for each row execute function device_tokens_client_profile_immutable();
