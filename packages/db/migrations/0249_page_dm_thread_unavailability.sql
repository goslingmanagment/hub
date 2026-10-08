-- 0249_page_dm_thread_unavailability.sql
--
-- Fansly Sync Engine, the chat Fansly stopped serving (arena "vanished chat",
-- plan §2, R2): the chat-unavailability episode of a page × chat — "Fansly
-- does not serve this chat's history to this page since T", with the attempts
-- and the raw answers that prove it.
--
-- Until now the engine had no such state. A chat whose every read answers
--   500 {"success":false,"error":{"code":500,"details":"error getting group messages"}}
-- (lora-1, 04.10, after the fan blocked the page) kept its `dm-messages.head`
-- row open for good, probed once a day on the subject breaker's last step,
-- and kept the page summary in "Needs attention".
--
-- One row per episode; the page's actor is its only writer:
--
--   opened     at the first QUALIFYING refusal of the chat's head: a
--              `messages.page` read without `before` of `dm-messages.head`,
--              `.catchup` or `.history` (all three read the head) answered
--              `subject_failure` or `envelope_unsuccessful` WITH Fansly's own
--              error envelope (`success: false`, a numeric `error.code`, a
--              non-empty `error.details`). A proxy's HTML page, an empty 5xx,
--              a 429, a 401/403 or a wire failure is not the chat's answer:
--              it neither opens an episode nor counts. Each refusal is one
--              attempt, counted in `refusals` since the last applied head read.
--   refusing → established
--              at the episode's own 5th refusal (never the work row's
--              `blocked_by_vendor`, which counts answers without the envelope
--              too). From then on the chat's work rows that need its head are
--              closed `chat_unavailable`, its unconfirmed socket messages are
--              deferred `chat_unavailable` (still shown), the history requests
--              refuse it, and no `dm-messages.*` key reads its head before
--              `retry_not_before`; a new socket message or a new list head
--              (one the episode has not answered: `handled_list_head_id`) gives
--              one read after it.
--   ended      by an applied head read of the chat (any of the three keys;
--              `read_served`), or when a plan closes the chat's work because
--              the chat was excluded or unbound (`thread_excluded`,
--              `thread_unbound`). A read of a deeper page (`before`) never
--              ends it.
--
-- The row names its chat by `thread_id` only: no fan identity, no page key.
-- An erasure of the fan deletes the fan's threads, an erasure of the page the
-- page's threads (the `pages` row is kept), and the episodes go with them
-- through the cascade — the image before this one erases them unchanged.
-- `owner_note` / `owner_note_at` are the owner's observation with its date;
-- the actor never writes them. The attempt and observation ids carry no
-- foreign key: the attempt journal is pruned after 30 days, the observation
-- journal is partitioned.
--
-- Data: the open episodes the engine's journal already proves — every chat
-- whose thread is bound and not excluded and whose qualifying refusals (the
-- rule above, read from `sync_attempts` and the journaled failed bodies) came
-- after its last applied head read, counted from the first such refusal; an
-- episode of 5 or more is established at its 5th, its retry boundary the
-- later of the last refused work's breaker and the last refusal + 24 h, and
-- its list head the thread's head now. The owner's note goes on lora-1's.
-- The unconfirmed, undeleted socket messages of the established chats are
-- deferred `chat_unavailable`. (Production, 2026-10-08: lora-1 chat
-- 959503986971394048 — 8 refusals, attempts 115884…158261, established at
-- 126171; lora-2 chat 962771411582074883 — 9 refusals, attempts
-- 82887…158938, established at 98386; their live rows 963176936203370497 and
-- 962774700725903361 go from `age_without_rest` to `chat_unavailable`. The
-- work rows 362195 and 218893 stay open: their next daily probe closes them,
-- or ends the episode.)
--
-- Rollback-compatible: a new table the previous image never names, created
-- with IF NOT EXISTS; the live rows take a wait reason the 0247 CHECK already
-- admits and the previous image never looks at (its parity pass needs
-- `confirm_due_at`); its erasure removes the episodes through the thread
-- cascade.
--
-- LOCKING: the foreign key takes SHARE ROW EXCLUSIVE on page_dm_threads for
-- the instant of the CREATE (the list apply waits behind it); lock_timeout
-- keeps the wait brief — if the lock is not had in 5 s this aborts and the
-- deploy rolls back.

set local lock_timeout = '5s';

create table if not exists page_dm_thread_unavailability (
  id bigserial primary key,
  thread_id bigint not null references page_dm_threads(id) on delete cascade,
  state text not null,
  opened_at timestamptz not null,
  established_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  refusals integer not null,
  last_refusal_at timestamptz not null,
  last_http_status integer,
  retry_not_before timestamptz,
  first_attempt_id bigint not null,
  last_attempt_id bigint not null,
  first_observation_id bigint not null,
  first_observation_received_at timestamptz not null,
  last_observation_id bigint not null,
  last_observation_received_at timestamptz not null,
  handled_list_head_id text,
  owner_note text,
  owner_note_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint page_dm_thread_unavailability_state_check check (state in ('refusing', 'established')),
  constraint page_dm_thread_unavailability_end_reason_check check (end_reason in ('read_served', 'thread_excluded', 'thread_unbound')),
  constraint page_dm_thread_unavailability_ended_check check ((ended_at is null) = (end_reason is null)),
  constraint page_dm_thread_unavailability_established_check check ((state = 'established') = (established_at is not null)),
  constraint page_dm_thread_unavailability_retry_check check (retry_not_before is null or state = 'established'),
  constraint page_dm_thread_unavailability_refusals_check check (refusals >= 1),
  constraint page_dm_thread_unavailability_attempts_check check (first_attempt_id <= last_attempt_id),
  constraint page_dm_thread_unavailability_list_head_check check (handled_list_head_id ~ '^[0-9]{1,30}$'),
  constraint page_dm_thread_unavailability_owner_note_check check (
    (owner_note is null) = (owner_note_at is null) and (owner_note is null or length(owner_note) between 1 and 2000)
  )
);

-- One open episode per chat (the actor's upsert arbiter; also the index the
-- planner, the list and the history intake read the open episode by).
create unique index if not exists page_dm_thread_unavailability_open
  on page_dm_thread_unavailability (thread_id) where ended_at is null;
-- Every episode of a chat (the cascade from a deleted thread, its history).
create index if not exists page_dm_thread_unavailability_thread
  on page_dm_thread_unavailability (thread_id, id);

comment on table page_dm_thread_unavailability is
  'Fansly Sync Engine (arena "vanished chat", plan §2): a chat-unavailability episode of a page × chat — Fansly does not serve the chat''s history to the page since opened_at. Written only by the page''s actor; erased with its thread (cascade).';
comment on column page_dm_thread_unavailability.thread_id is
  'The chat (page_dm_threads): the page and the group id are the thread''s. No fan identity of its own; deleted with the thread.';
comment on column page_dm_thread_unavailability.state is
  'refusing: qualifying refusals seen, fewer than 5; established: 5 or more — the chat''s head is not read before retry_not_before, its work closed chat_unavailable, its socket messages deferred.';
comment on column page_dm_thread_unavailability.opened_at is
  'The first qualifying refusal: a messages.page head read (no before) of dm-messages.head/.catchup/.history answered subject_failure or envelope_unsuccessful with Fansly''s own error envelope.';
comment on column page_dm_thread_unavailability.established_at is
  'The episode''s 5th qualifying refusal (its own count, not the work row''s blocked_by_vendor).';
comment on column page_dm_thread_unavailability.ended_at is
  'The episode''s end (end_reason); null while open. One open episode per chat.';
comment on column page_dm_thread_unavailability.end_reason is
  'read_served: an applied head read of the chat (any of the three keys); thread_excluded / thread_unbound: a plan closed the chat''s work because the chat was excluded or unbound.';
comment on column page_dm_thread_unavailability.refusals is
  'Qualifying refusals of the chat''s head since the last applied head read, one per attempt.';
comment on column page_dm_thread_unavailability.last_refusal_at is
  'When the latest qualifying refusal was captured.';
comment on column page_dm_thread_unavailability.last_http_status is
  'The HTTP status of the latest qualifying refusal.';
comment on column page_dm_thread_unavailability.retry_not_before is
  'Established: no dm-messages.* key reads the chat''s head before this instant (the later of the refused attempt''s breaker and the daily step, 24 h). Moved by every later refusal.';
comment on column page_dm_thread_unavailability.first_attempt_id is
  'The first qualifying refusal (sync_attempts.id; no FK: the attempt journal is pruned after 30 days).';
comment on column page_dm_thread_unavailability.last_attempt_id is
  'The latest qualifying refusal (sync_attempts.id).';
comment on column page_dm_thread_unavailability.first_observation_id is
  'The raw answer of the first refusal (observations, with first_observation_received_at): the evidence.';
comment on column page_dm_thread_unavailability.last_observation_id is
  'The raw answer of the latest refusal (observations, with last_observation_received_at).';
comment on column page_dm_thread_unavailability.handled_list_head_id is
  'Established: the newest list head the episode answered with a read; a list head at or below it asks for no read.';
comment on column page_dm_thread_unavailability.owner_note is
  'The owner''s observation of the chat (e.g. the fan''s profile does not open from the page); never written by the actor.';
comment on column page_dm_thread_unavailability.owner_note_at is
  'When the owner made the observation in owner_note.';

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on page_dm_thread_unavailability to read_only;
  end if;
end $$;

with head_reads as (
  select a.id, a.page_id, a.subject, a.work_id, a.apply_state, a.error_class, a.http_status, a.completed_at,
         a.observation_id, a.observation_received_at
    from sync_attempts a
   where not a.shadow
     and a.operation = 'messages.page'
     and a.resource in ('dm-messages.head', 'dm-messages.catchup', 'dm-messages.history')
     and a.outcome = 'response'
     and a.request -> 'params' ->> 'before' is null
), last_served as (
  select r.page_id, r.subject, max(r.id) as attempt_id
    from head_reads r
   where r.apply_state = 'applied'
   group by r.page_id, r.subject
), refused as (
  select r.*, row_number() over (partition by r.page_id, r.subject order by r.id) as n
    from head_reads r
    left join last_served s on s.page_id = r.page_id and s.subject = r.subject
    join observations o on o.id = r.observation_id and o.received_at = r.observation_received_at
   cross join lateral (
     select case when pg_input_is_valid(o.payload ->> 'bodyText', 'jsonb')
                 then (o.payload ->> 'bodyText')::jsonb end as body
   ) b
   where r.id > coalesce(s.attempt_id, 0)
     and r.error_class in ('subject_failure', 'envelope_unsuccessful')
     and r.http_status is not null
     and r.completed_at is not null
     and o.kind = 'dm_messages:failed'
     and jsonb_typeof(b.body) = 'object'
     and b.body -> 'success' = 'false'::jsonb
     and jsonb_typeof(b.body -> 'error') = 'object'
     and jsonb_typeof(b.body -> 'error' -> 'code') = 'number'
     and jsonb_typeof(b.body -> 'error' -> 'details') = 'string'
     and (b.body -> 'error' ->> 'details') ~ '[^[:space:]]'
), per_chat as (
  select r.page_id, r.subject, count(*)::int as refusals, min(r.id) as first_id, max(r.id) as last_id,
         min(r.completed_at) filter (where r.n = 5) as established_at
    from refused r
   group by r.page_id, r.subject
), episodes as (
  select t.id as thread_id, t.last_message_id, c.refusals, c.established_at,
         f.id as first_attempt_id, f.completed_at as opened_at,
         f.observation_id as first_observation_id, f.observation_received_at as first_observation_received_at,
         l.id as last_attempt_id, l.completed_at as last_refusal_at, l.http_status as last_http_status,
         l.observation_id as last_observation_id, l.observation_received_at as last_observation_received_at,
         greatest(w.breaker_until, l.completed_at + interval '24 hours') as retry_not_before
    from per_chat c
    join refused f on f.id = c.first_id
    join refused l on l.id = c.last_id
    left join sync_work w on w.id = l.work_id
    join page_dm_threads t on t.platform_account_id = c.page_id and t.platform_conversation_id = c.subject
   where t.fan_id is not null
     and coalesce(t.metadata ->> 'messageSyncExcludedReason', '') = ''
)
insert into page_dm_thread_unavailability (
  thread_id, state, opened_at, established_at, refusals, last_refusal_at, last_http_status, retry_not_before,
  first_attempt_id, last_attempt_id, first_observation_id, first_observation_received_at,
  last_observation_id, last_observation_received_at, handled_list_head_id
)
select e.thread_id,
       case when e.established_at is null then 'refusing' else 'established' end,
       e.opened_at, e.established_at, e.refusals, e.last_refusal_at, e.last_http_status,
       case when e.established_at is null then null else e.retry_not_before end,
       e.first_attempt_id, e.last_attempt_id, e.first_observation_id, e.first_observation_received_at,
       e.last_observation_id, e.last_observation_received_at,
       case when e.established_at is not null and e.last_message_id ~ '^[0-9]{1,30}$' then e.last_message_id end
  from episodes e
 order by e.thread_id
on conflict (thread_id) where ended_at is null do nothing;

update page_dm_thread_unavailability e
   set owner_note = '06.10: профиль не открывается из-под lora-1 — ЧС со стороны фана, по наблюдению владельца',
       owner_note_at = timestamptz '2026-10-06 22:14:00+00',
       updated_at = clock_timestamp()
  from page_dm_threads t
  join pages p on p.id = t.platform_account_id
 where e.thread_id = t.id
   and e.ended_at is null
   and e.owner_note is null
   and p.label = 'lora-1'
   and t.platform_conversation_id = '959503986971394048';

update dm_live_messages m
   set confirm_wait_reason = 'chat_unavailable',
       confirm_due_at = null,
       updated_at = clock_timestamp()
  from page_dm_thread_unavailability e
  join page_dm_threads t on t.id = e.thread_id
 where e.ended_at is null
   and e.state = 'established'
   and m.page_id = t.platform_account_id
   and m.platform_conversation_id = t.platform_conversation_id
   and m.confirmed_at is null
   and m.deleted_at is null;
