-- agency-hub:rollback-compatible — older writers omit the nullable posting key.
alter table pot_distributions add column agent_key_id bigint references agent_keys(id) on delete set null;

create or replace function pot_distributions_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('agency_hub.sandbox_remove', true) = 'test_realm' and hub_pot_is_test(old.pot_id) then
      return old;
    end if;
    raise exception 'pot_distributions rows are immutable and never deleted';
  end if;

  -- A removed key releases only its foreign key, including on already reversed rows.
  if old.agent_key_id is not null and new.agent_key_id is null
    and (to_jsonb(new) - 'agent_key_id') = (to_jsonb(old) - 'agent_key_id')
    and not exists (select 1 from agent_keys where id = old.agent_key_id)
  then
    return new;
  end if;

  if old.reversed_at is not null then
    raise exception 'pot_distributions row % is already reversed and immutable', old.id;
  end if;

  if new.reversed_at is null
    or new.agent_key_id is distinct from old.agent_key_id
    or new.id is distinct from old.id
    or new.pot_id is distinct from old.pot_id
    or new.day is distinct from old.day
    or new.formula is distinct from old.formula
    or new.base_mills is distinct from old.base_mills
    or new.lines is distinct from old.lines
    or new.posted_at is distinct from old.posted_at
    or new.posted_by_user_id is distinct from old.posted_by_user_id
    or new.reversed_reason is null
    or btrim(new.reversed_reason) = ''
  then
    raise exception 'pot_distributions rows are immutable except reversing once with a reason';
  end if;

  return new;
end
$$;
