-- agency-hub:rollback-compatible — new pot tables, switch table, feed tables and triggers only on the new pot tables; the previous image never names them.
-- 0443_workboard_pots.sql
--
-- Workboard pots (H11): pot definitions, balance in base mills (derived from `sale_homes` minus non-reversed
-- `pot_distribution_parts` across ALL pots), immutable posted distributions, and the K2 feed
-- (`GET /api/v1/agent/pot-distributions/feed`) for the agency ledger.
--
-- pots_switch              — single-row switch (`pots_from`): Moscow day from which pots live in Workboard (null = off).
-- pots                     — page pots (`intake_reasons` subset of {post_tip, campaign}) and event pots (empty intake).
-- pot_distributions        — immutable posted distributions; may only transition once from unreversed to reversed.
-- pot_distribution_parts   — which sales and how many base mills each distribution consumed (global remaining-base check).
-- pot_distribution_changes — K2 feed change-log (`posted` / `reversed`), placed once committed under an advisory lock.
-- pot_distribution_feed_held — changes held back per agent key while any page of the distribution is outside its grant.

set local lock_timeout = '5s';

create table if not exists pots_switch (
  id boolean primary key default true,
  pots_from date,
  set_by text,
  set_at timestamptz,
  constraint pots_switch_one_row check (id)
);

insert into pots_switch (id) values (true) on conflict (id) do nothing;

comment on table pots_switch is
  'From which Moscow day pots live in Workboard (H11); null — off (days before it stay in ledger).';

create table if not exists pots (
  id bigserial primary key,
  code text not null unique,
  name text not null,
  model_id bigint not null references models(id),
  page_ids bigint[] not null,
  intake_reasons text[] not null default '{}',
  opens_on date not null,
  closes_on date,
  participants_mode text not null,
  participants jsonb not null default '[]'::jsonb,
  formula jsonb not null,
  auto_post boolean not null default false,
  state text not null default 'open',
  created_by_user_id bigint references users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint pots_code_check check (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  constraint pots_page_ids_nonempty_check check (cardinality(page_ids) > 0),
  constraint pots_intake_reasons_check check (intake_reasons <@ array['post_tip', 'campaign']::text[]),
  constraint pots_dates_check check (closes_on is null or closes_on >= opens_on),
  constraint pots_participants_mode_check check (participants_mode in ('page_workers', 'listed')),
  constraint pots_formula_kind_check check ((formula ->> 'kind') in ('equal', 'weights', 'manual')),
  constraint pots_auto_post_equal_check check (not auto_post or (formula ->> 'kind') = 'equal'),
  constraint pots_state_check check (state in ('open', 'closed'))
);

create index if not exists pots_model_idx on pots (model_id);
create index if not exists pots_state_idx on pots (state);

create table if not exists pot_distributions (
  id bigserial primary key,
  pot_id bigint not null references pots(id),
  day date not null,
  formula jsonb not null,
  base_mills bigint not null,
  lines jsonb not null,
  posted_at timestamptz not null default clock_timestamp(),
  posted_by_user_id bigint references users(id),
  reversed_at timestamptz,
  reversed_by_user_id bigint references users(id),
  reversed_reason text,
  constraint pot_distributions_base_mills_check check (base_mills > 0),
  constraint pot_distributions_formula_kind_check check ((formula ->> 'kind') in ('equal', 'weights', 'manual')),
  constraint pot_distributions_reversed_reason_check check (
    reversed_at is null or (reversed_reason is not null and btrim(reversed_reason) <> '')
  )
);

create index if not exists pot_distributions_pot_day_idx on pot_distributions (pot_id, day desc, id desc);
create index if not exists pot_distributions_active_pot_idx on pot_distributions (pot_id) where reversed_at is null;

create table if not exists pot_distribution_parts (
  distribution_id bigint not null references pot_distributions(id) on delete cascade,
  transaction_id bigint not null,
  page_id bigint not null references pages(id),
  base_mills bigint not null,
  primary key (distribution_id, transaction_id),
  constraint pot_distribution_parts_base_mills_check check (base_mills > 0)
);

create index if not exists pot_distribution_parts_tx_idx on pot_distribution_parts (transaction_id);
create index if not exists pot_distribution_parts_page_idx on pot_distribution_parts (page_id);

-- Realm helper: a pot belongs to the realm of its model (0414).
create or replace function hub_pot_is_test(p_pot_id bigint) returns boolean
language sql stable as $$
  select coalesce((select m.is_test from pots pt join models m on m.id = pt.model_id where pt.id = p_pot_id), false)
$$;

-- A pot's pages must all belong to the same realm as its model (0414).
create or replace function pots_realm_check() returns trigger
language plpgsql as $$
declare
  model_is_test boolean;
begin
  select m.is_test into model_is_test from models m where m.id = new.model_id;
  if exists (
    select 1
    from unnest(new.page_ids) as pid
    left join pages p on p.id = pid
    left join models pm on pm.id = p.model_id
    where p.id is null or pm.is_test is distinct from model_is_test
  ) then
    raise exception 'pot % pages must exist and belong to the same realm as its model (0443)', new.code
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

drop trigger if exists pots_realm_check on pots;
create trigger pots_realm_check before insert or update on pots
  for each row execute function pots_realm_check();

-- Immutability of pot_distributions: once posted, may only be reversed once (setting reversed_at, reversed_by_user_id,
-- reversed_reason). Never deleted except during sandbox:remove for test-realm rows (0425 pattern).
create or replace function pot_distributions_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('agency_hub.sandbox_remove', true) = 'test_realm' and hub_pot_is_test(old.pot_id) then
      return old;
    end if;
    raise exception 'pot_distributions rows are immutable and never deleted';
  end if;

  if old.reversed_at is not null then
    raise exception 'pot_distributions row % is already reversed and immutable', old.id;
  end if;

  if new.reversed_at is null
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

drop trigger if exists pot_distributions_immutable on pot_distributions;
create trigger pot_distributions_immutable before update or delete on pot_distributions
  for each row execute function pot_distributions_immutable();

-- Immutability of pot_distribution_parts: never updated; never deleted except during sandbox:remove for test-realm rows.
create or replace function pot_distribution_parts_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('agency_hub.sandbox_remove', true) = 'test_realm'
      and (hub_page_is_test(old.page_id) or exists (select 1 from pot_distributions d where d.id = old.distribution_id and hub_pot_is_test(d.pot_id)))
    then
      return old;
    end if;
    raise exception 'pot_distribution_parts rows are immutable and never deleted';
  end if;
  raise exception 'pot_distribution_parts rows are immutable';
end
$$;

drop trigger if exists pot_distribution_parts_immutable on pot_distribution_parts;
create trigger pot_distribution_parts_immutable before update or delete on pot_distribution_parts
  for each row execute function pot_distribution_parts_immutable();

-- K2 feed tables (mirrors 0409 / 0441).
create table if not exists pot_distribution_changes (
  id bigserial primary key,
  distribution_id bigint not null references pot_distributions(id) on delete cascade,
  is_test boolean not null,
  change text not null,
  at timestamptz not null default clock_timestamp(),
  seq bigint,
  constraint pot_distribution_changes_change_check check (change in ('posted', 'reversed')),
  constraint pot_distribution_changes_seq_key unique (seq)
);

create index if not exists pot_distribution_changes_unplaced_idx on pot_distribution_changes (id) where seq is null;
create index if not exists pot_distribution_changes_realm_seq_idx on pot_distribution_changes (is_test, seq) where seq is not null;

create or replace function pot_distribution_changed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into pot_distribution_changes (distribution_id, is_test, change)
    values (new.id, hub_pot_is_test(new.pot_id), 'posted');
  elsif tg_op = 'UPDATE' then
    if old.reversed_at is null and new.reversed_at is not null then
      insert into pot_distribution_changes (distribution_id, is_test, change)
      values (new.id, hub_pot_is_test(new.pot_id), 'reversed');
    end if;
  end if;
  return null;
end
$$;

drop trigger if exists pot_distribution_changed on pot_distributions;
create trigger pot_distribution_changed after insert or update on pot_distributions
  for each row execute function pot_distribution_changed();

create table if not exists pot_distribution_feed_held (
  agent_key_id bigint not null references agent_keys(id) on delete cascade,
  change_id bigint not null references pot_distribution_changes(id) on delete cascade,
  held_at timestamptz not null default clock_timestamp(),
  primary key (agent_key_id, change_id)
);
