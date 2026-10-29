-- agency-hub:rollback-compatible — two new tables and a wider agent_keys check: the previous image never names the tables and never writes the new capability.
-- 0332_fan_queues.sql
--
-- Fan queues (docs/plans/2026-10-29-fan-queues/spec.md): the fans of one page
-- gathered on someone's word (through an agent such as Gengar, by a rule Hub
-- evaluates or a list), kept here and handed out to the page's chatters in
-- portions of up to 10. A chatter works a portion in the extension's
-- «Очереди» window, one click per message (a batch of 10 for template
-- queues); Hub sends nothing.
--
-- `fan_queues`: the queue — page, name, the chatter-facing goal, the scenario
-- (what to write with), the rule (null for a list) and Hub's own words for
-- it, campaign or standing (refilled from its rule once a Moscow day), shared
-- pool or split between people, a person's daily portion and the page's daily
-- limit, status, who asked for it and which agent key or person made it.
--
-- `fan_queue_items`: one fan in one queue. `pending` → `leased` (a portion:
-- who and until when, 30 minutes, renewed while the window is open, expired
-- lazily) → `sent` / `skipped` / `dropped` with its reason. A fan is in at
-- most one open (pending or leased) item of a page: a fan already queued
-- joins no other queue. Every outcome a chatter reports is journaled in
-- `observations` first (`observation_id`).
--
-- Erasure: a fan's items go with the fan (cascade); a page's with the page.

create table if not exists fan_queues (
  id bigint generated always as identity primary key,
  page_id bigint not null references pages(id),
  name text not null,
  goal text,
  kind text not null default 'campaign',
  status text not null default 'active',
  rule jsonb,
  rule_text text,
  scenario jsonb not null,
  distribution text not null default 'pool',
  people bigint[] not null default '{}',
  per_person integer,
  daily_limit integer,
  ends_at timestamptz,
  refilled_on date,
  paused_at timestamptz,
  paused_by_user_id bigint references users(id),
  requested_by_user_id bigint not null references users(id),
  created_by_agent_key_id bigint references agent_keys(id),
  created_by_user_id bigint references users(id),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint fan_queues_kind_check check (kind in ('campaign', 'standing')),
  constraint fan_queues_status_check check (status in ('active', 'paused', 'done')),
  constraint fan_queues_distribution_check check (distribution in ('pool', 'people')),
  constraint fan_queues_name_check check (length(name) between 1 and 80),
  constraint fan_queues_goal_check check (goal is null or length(goal) <= 600),
  constraint fan_queues_per_person_check check (per_person is null or per_person between 1 and 5000),
  constraint fan_queues_daily_limit_check check (daily_limit is null or daily_limit between 1 and 20000),
  constraint fan_queues_standing_rule_check check (kind <> 'standing' or rule is not null),
  constraint fan_queues_author_check check (created_by_agent_key_id is not null or created_by_user_id is not null)
);

create unique index if not exists fan_queues_idempotency on fan_queues (idempotency_key) where idempotency_key is not null;
create index if not exists fan_queues_page_status on fan_queues (page_id, status);

create table if not exists fan_queue_items (
  id bigint generated always as identity primary key,
  queue_id bigint not null references fan_queues(id) on delete cascade,
  page_id bigint not null references pages(id),
  fan_id bigint not null references fans(id) on delete cascade,
  fan_ref text not null,
  rank integer not null,
  why text,
  assignee_user_id bigint references users(id),
  state text not null default 'pending',
  leased_to_user_id bigint references users(id),
  lease_until timestamptz,
  not_before timestamptz,
  done_at timestamptz,
  done_by_user_id bigint references users(id),
  act text,
  template_id text,
  reason text,
  observation_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fan_queue_items_state_check check (state in ('pending', 'leased', 'sent', 'skipped', 'dropped')),
  constraint fan_queue_items_lease_check check ((state = 'leased') = (leased_to_user_id is not null and lease_until is not null)),
  constraint fan_queue_items_why_check check (why is null or length(why) <= 300),
  constraint fan_queue_items_act_check check (act is null or length(act) between 1 and 32),
  constraint fan_queue_items_template_check check (template_id is null or length(template_id) between 1 and 32),
  constraint fan_queue_items_reason_check check (reason is null or length(reason) between 1 and 32)
);

-- A fan already queued on a page joins no other queue of it.
create unique index if not exists fan_queue_items_open_fan on fan_queue_items (page_id, fan_id) where state in ('pending', 'leased');
-- The next items to hand out, in order.
create index if not exists fan_queue_items_next on fan_queue_items (queue_id, rank) where state = 'pending';
-- A person's portion, and the lazy expiry of portions.
create index if not exists fan_queue_items_leased on fan_queue_items (queue_id, leased_to_user_id) where state = 'leased';
-- Outcomes by day (today's counts, results) and a fan's last send from any queue (the cool-down).
create index if not exists fan_queue_items_done on fan_queue_items (queue_id, done_at) where done_at is not null;
create index if not exists fan_queue_items_fan on fan_queue_items (page_id, fan_id, done_at desc);

comment on table fan_queues is
  'Fan queues: a page''s fans gathered by a rule or a list on someone''s word, handed out to its chatters in portions.';
comment on table fan_queue_items is
  'One fan in one fan queue: pending, leased to a chatter for 30 minutes, then sent, skipped or dropped with a reason.';

-- An agent key may manage fan queues on its pages, on the word of the person
-- who asked (`write:fan_queues`).
alter table agent_keys
  drop constraint agent_keys_capabilities_check,
  add constraint agent_keys_capabilities_check check (
    capabilities <@ array[
      'read:messages',
      'read:money',
      'read:observations_envelope',
      'read:datasets',
      'request:hydration',
      'write:publication_drafts',
      'approve:publications',
      'write:fan_queues'
    ]::text[]
  );

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on fan_queues, fan_queue_items to read_only;
  end if;
end
$$;
