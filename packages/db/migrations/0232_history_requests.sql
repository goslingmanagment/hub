-- 0232_history_requests.sql
--
-- Fansly Sync Engine history requests (plan §4; design §2.5, §7.1). An agent
-- or the owner asks for the history of up to 1 000 fans' chats on one page,
-- to a depth ('all' = proven to the first message, 'latest' N, or the legacy
-- wrapper's 'before_boundary'). Every fan becomes one item; the items of one
-- chat share the chat's ONE `dm-messages.history` work row (sync_work), so a
-- read serves every request attached to the chat and is counted once.
--
--   history_requests       who asked what (the reason only as a digest), the
--                          idempotency key and request fingerprint, the depth,
--                          the estimate at submit, the round-robin stamp, and
--                          open / done / cancelled
--   history_request_items  one fan of a request: the input as given, what it
--                          resolved to (thread, fan, conversation), refused
--                          (not_found / excluded / page_erased / duplicate) or
--                          queued / loading / ready / blocked / cancelled, the
--                          shared work, the anchor of the depth, reads spent,
--                          and the counters frozen at a terminal state
--
-- Progress is never duplicated here: views read the chain columns of
-- page_dm_threads (0231) and the shared work. Requests are accepted only on a
-- page in mode 'live' whose requests_enabled_at has passed (409 otherwise), so
-- in step 2 (every page 'off' or 'shadow') both tables stay empty.
--
-- No scheduled deletion (records of who asked what; small). Erasure: both are
-- page-owned (page inventory); a fan's items go with the fan
-- (fan_platform_user_id, conversation_ref).
--
-- Purely additive, IF NOT EXISTS; the previous image never names these tables.

create table if not exists history_requests (
  id bigserial primary key,
  request_ref uuid not null unique,
  page_id bigint not null references pages(id) on delete restrict,
  requester_kind text not null,
  requester_agent_key_id bigint references agent_keys(id) on delete restrict,
  -- The owner's user (the table agent_hydration_requests.decided_by_user_id
  -- references, 0117); null for the owner CLI.
  requester_user_id bigint references users(id) on delete restrict,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  depth_kind text not null,
  depth_n integer,
  depth_boundary_at timestamptz,
  depth_boundary_message_ref text,
  reason_sha256 text not null,
  reason_length integer not null,
  state text not null default 'open',
  items_total integer not null,
  items_terminal integer not null default 0,
  estimate_at_submit jsonb not null,
  last_served_at timestamptz,
  legacy_hydration_request_id bigint,
  created_at timestamptz not null default clock_timestamp(),
  done_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason_sha256 text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint history_requests_requester_kind_check check (
    requester_kind in ('agent_key', 'owner_session', 'owner_cli', 'legacy_hydration_wrapper', 'switch_migration')
  ),
  constraint history_requests_requester_ids_check check (num_nonnulls(requester_agent_key_id, requester_user_id) <= 1),
  constraint history_requests_fingerprint_check check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint history_requests_depth_kind_check check (depth_kind in ('all', 'latest', 'before_boundary')),
  constraint history_requests_depth_n_check check (depth_n is null or depth_n between 1 and 1000000),
  constraint history_requests_depth_latest_check check ((depth_kind = 'latest') = (depth_n is not null)),
  constraint history_requests_depth_boundary_check check (
    (depth_kind = 'before_boundary') = (num_nonnulls(depth_boundary_at, depth_boundary_message_ref) = 1)
  ),
  constraint history_requests_reason_sha256_check check (reason_sha256 ~ '^[0-9a-f]{64}$'),
  constraint history_requests_reason_length_check check (reason_length between 1 and 1000),
  constraint history_requests_state_check check (state in ('open', 'done', 'cancelled')),
  constraint history_requests_items_total_check check (items_total between 1 and 1000),
  constraint history_requests_items_terminal_check check (items_terminal >= 0),
  constraint history_requests_done_check check ((state = 'done') = (done_at is not null)),
  constraint history_requests_cancelled_check check ((state = 'cancelled') = (cancelled_at is not null)),
  constraint history_requests_cancel_reason_check check (
    cancel_reason_sha256 is null or cancel_reason_sha256 ~ '^[0-9a-f]{64}$'
  )
);

-- One request per requester and idempotency key (a repeat returns it).
create unique index if not exists history_requests_idempotency on history_requests
  (requester_kind, coalesce(requester_agent_key_id, 0), coalesce(requester_user_id, 0), idempotency_key);
-- The requests class's round robin between a page's open requests.
create index if not exists history_requests_page_open on history_requests (page_id, last_served_at nulls first, id)
  where state = 'open';
create index if not exists history_requests_page_created on history_requests (page_id, created_at desc);

create table if not exists history_request_items (
  id bigserial primary key,
  request_id bigint not null references history_requests(id) on delete cascade,
  page_id bigint not null references pages(id) on delete restrict,
  ordinal integer not null,
  input_kind text not null,
  input_ref text not null,
  fan_platform_user_id text,
  fan_id bigint,
  thread_id bigint references page_dm_threads(id) on delete set null,
  conversation_ref text,
  state text not null,
  refusal text,
  excluded_reason text,
  work_id bigint,
  anchor_message_id text,
  anchor_fixed_at timestamptz,
  anchor_upward_count bigint,
  anchor_chain_epoch integer,
  estimate_reads_min integer,
  estimate_reads integer,
  reads_spent integer not null default 0,
  last_served_at timestamptz,
  satisfied_at timestamptz,
  satisfied_by text,
  satisfied_oldest_id text,
  satisfied_count integer,
  final jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint history_request_items_ordinal_check check (ordinal >= 0),
  constraint history_request_items_input_kind_check check (input_kind in ('fan_platform_user_id', 'conversation_ref', 'chat_url')),
  constraint history_request_items_input_ref_check check (length(input_ref) between 1 and 300),
  constraint history_request_items_state_check check (
    state in ('refused', 'queued', 'loading', 'ready', 'blocked', 'cancelled')
  ),
  constraint history_request_items_refusal_check check (
    refusal is null or refusal in ('not_found', 'excluded', 'page_erased', 'duplicate')
  ),
  constraint history_request_items_refused_check check ((state = 'refused') = (refusal is not null)),
  constraint history_request_items_satisfied_by_check check (
    satisfied_by is null or satisfied_by in ('empty_page', 'latest_n', 'boundary', 'already_satisfied')
  ),
  constraint history_request_items_reads_spent_check check (reads_spent >= 0),
  constraint history_request_items_ordinal_uniq unique (request_id, ordinal),
  constraint history_request_items_input_uniq unique (request_id, input_kind, input_ref)
);

-- The requests class's round robin between a request's fans (blocked fans
-- keep their turn: their chat is probed when its breaker passes).
create index if not exists history_request_items_rr on history_request_items
  (request_id, last_served_at nulls first, ordinal)
  where state in ('queued', 'loading', 'blocked');
create index if not exists history_request_items_work on history_request_items (work_id)
  where state in ('queued', 'loading', 'blocked');
create index if not exists history_request_items_thread on history_request_items (thread_id)
  where state in ('queued', 'loading', 'blocked');

comment on table history_requests is
  'Fansly Sync Engine (plan §4): a history request of an agent or the owner — one page, 1..1000 fans, a depth. Progress is read from page_dm_threads and the shared work.';
comment on column history_requests.request_ref is 'The public reference of the request (API, CLI).';
comment on column history_requests.page_id is 'The page the request reads (one page per request).';
comment on column history_requests.requester_kind is
  'agent_key | owner_session | owner_cli | legacy_hydration_wrapper | switch_migration.';
comment on column history_requests.requester_agent_key_id is 'The agent key that filed it (requester_kind agent_key).';
comment on column history_requests.requester_user_id is 'The owner user that filed it (owner_session); null from the owner CLI.';
comment on column history_requests.idempotency_key is
  'The caller''s key: a repeat with the same key and fingerprint returns this request; another fingerprint is refused.';
comment on column history_requests.request_fingerprint is
  'sha256 of the normalized request (page, sorted inputs, depth, sha256 of the reason).';
comment on column history_requests.depth_kind is
  'all (proven to the first message) | latest (depth_n messages from the anchor) | before_boundary (legacy wrapper).';
comment on column history_requests.depth_n is 'N of a latest request.';
comment on column history_requests.depth_boundary_at is 'The legacy wrapper''s boundary instant (before_boundary).';
comment on column history_requests.depth_boundary_message_ref is 'The legacy wrapper''s boundary message id (before_boundary).';
comment on column history_requests.reason_sha256 is 'sha256 of the stated reason; the text itself is never stored.';
comment on column history_requests.reason_length is 'Length of the stated reason (1..1000).';
comment on column history_requests.state is 'open | done (every item terminal) | cancelled.';
comment on column history_requests.items_total is 'Items of the request (1..1000).';
comment on column history_requests.items_terminal is 'Items that reached ready, refused or cancelled.';
comment on column history_requests.estimate_at_submit is
  'The estimate given at submit: {readsMin, readsEstimate, etaMinMs, etaEstimateMs, sharePercent, settingMs} (fact vs forecast).';
comment on column history_requests.last_served_at is 'Last read admitted for this request (round robin between a page''s requests).';
comment on column history_requests.legacy_hydration_request_id is
  'The agent_hydration_requests row this wrapper request serves (no FK: that table retires for Fansly).';
comment on column history_requests.created_at is 'When the request was filed.';
comment on column history_requests.done_at is 'When the last item became terminal.';
comment on column history_requests.cancelled_at is 'When the request was cancelled.';
comment on column history_requests.cancel_reason_sha256 is 'sha256 of the cancel reason, when one was given.';
comment on column history_requests.updated_at is 'Last change of the row.';

comment on table history_request_items is
  'Fansly Sync Engine (plan §4.2): one fan of a history request; fans of one chat share the chat''s dm-messages.history work.';
comment on column history_request_items.request_id is 'The request.';
comment on column history_request_items.page_id is 'The request''s page.';
comment on column history_request_items.ordinal is 'Position of the fan in the request (0-based).';
comment on column history_request_items.input_kind is 'fan_platform_user_id | conversation_ref | chat_url: what the caller gave.';
comment on column history_request_items.input_ref is 'The input as given (trimmed).';
comment on column history_request_items.fan_platform_user_id is
  'The fan''s Fansly account id (given, or the chat partner); erasure target.';
comment on column history_request_items.fan_id is 'fans.id of the chat''s fan, when bound.';
comment on column history_request_items.thread_id is 'The resolved chat (page_dm_threads).';
comment on column history_request_items.conversation_ref is 'The chat''s Fansly group id; erasure target.';
comment on column history_request_items.state is
  'refused | queued (no read yet) | loading | ready (satisfied) | blocked (the vendor keeps refusing the chat) | cancelled.';
comment on column history_request_items.refusal is
  'not_found (no visible chat) | excluded (the chat is not read) | page_erased | duplicate (another input of the request names the chat).';
comment on column history_request_items.excluded_reason is 'Why the chat is excluded (refusal excluded).';
comment on column history_request_items.work_id is 'The shared sync_work row (dm-messages.history of the chat); no FK: work retention is independent.';
comment on column history_request_items.anchor_message_id is
  'The chain head the depth counts from: fixed by the first head accepted after intake (or at intake when the socket saw no gap since it was confirmed).';
comment on column history_request_items.anchor_fixed_at is 'When the anchor was fixed.';
comment on column history_request_items.anchor_upward_count is
  'page_dm_threads.chain_upward_count when the anchor was fixed (messages added above the anchor do not count toward N).';
comment on column history_request_items.anchor_chain_epoch is 'page_dm_threads.chain_epoch of the anchor; another epoch clears it.';
comment on column history_request_items.estimate_reads_min is 'Reads at least needed, estimated at submit.';
comment on column history_request_items.estimate_reads is 'Reads estimated at submit (null when the chat has too few stored messages to estimate).';
comment on column history_request_items.reads_spent is 'Reads admitted on this fan''s turns.';
comment on column history_request_items.last_served_at is 'Last turn of this fan (round robin inside the request).';
comment on column history_request_items.satisfied_at is 'When the fan became ready.';
comment on column history_request_items.satisfied_by is 'empty_page | latest_n | boundary | already_satisfied (ready at intake, no read).';
comment on column history_request_items.satisfied_oldest_id is 'Oldest message of the proven chain when the fan became ready.';
comment on column history_request_items.satisfied_count is 'Messages of the chain counted for the depth when the fan became ready.';
comment on column history_request_items.final is
  'Counters frozen at a terminal state: {readsSpent, estimateReads, estimateReadsMin, loadedMessages, oldestLoadedAt, ...}.';
comment on column history_request_items.created_at is 'When the fan was filed.';
comment on column history_request_items.updated_at is 'Last change of the row.';

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on history_requests to read_only;
    grant select on history_request_items to read_only;
  end if;
end $$;
