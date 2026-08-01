-- agency-hub:no-transaction
-- Agent Read Plane, slice A: the access paths operations #3..#10 actually walk.
--
-- Every index is built CONCURRENTLY and every statement is idempotent, because
-- the alternative is an ACCESS EXCLUSIVE lock on `message_archive` during a
-- deploy — the largest table in the system and the one every transcript read
-- goes through. A crashed run can leave an `indisvalid = false` shell behind,
-- and `create index if not exists` would then happily "succeed" against a broken
-- index forever; so each physical index is conditionally DROPPED when invalid
-- before the create retries.
--
-- Deliberately NOT here, and each omission is a decision:
--
--   * `dm_message_archive (platform_account_id, platform_conversation_id,
--     message_created_at desc)` ALREADY EXISTS as
--     `dm_message_archive_page_conversation_idx`. `IF NOT EXISTS` only checks the
--     NAME, so a second copy under a new name would have built silently and cost
--     a write on every message forever.
--   * `page_dm_threads (platform_account_id, platform_conversation_id, ...)` is
--     redundant to the baseline UNIQUE on its first two columns: the lookup is
--     already a single row.
--   * `message_archive (account_id, conversation_ref, occurred_at desc,
--     message_ref desc)` duplicates `message_archive_account_conv_idx` on its
--     three-column prefix; Postgres scans that index backwards for the DESC walk,
--     and the ref tiebreak only orders rows sharing one timestamp.
--
-- Full-text indexes for `dm_message_archive` and `page_dm_messages`. The plane declares those two planes `not_indexed` on
-- search and lets `absenceProvable` stay false there, which is the honest
-- answer; building the indexes would double the FTS write cost on the hot path
-- to buy an answer the epistemics still could not certify.
-- Also NOT here: `pg_trgm`. Migrations are forward-only, numbered and applied in
-- an unbroken prefix, so a "skippable" committed migration does not exist. The
-- extension is a manual owner DBA step and the code detects it at runtime.

-- #6 transcript union, cold arm: (account, conversation, occurred_at) ordered

-- #4 timeline, message lane: the fan is addressed by its NATIVE id here (the
-- archive carries `fan_native_id`, not `fan_id`), so the join needs its own path.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select 'drop index concurrently if exists message_archive_agent_fan_timeline_idx' as statement
where exists (
  select 1
  from pg_class index_relation
  join pg_index index_state on index_state.indexrelid = index_relation.oid
  where index_relation.oid = to_regclass('message_archive_agent_fan_timeline_idx')
    and not index_state.indisvalid
);

-- agency-hub:statement
create index concurrently if not exists message_archive_agent_fan_timeline_idx
  on message_archive (account_id, fan_native_id, occurred_at desc)
  where fan_native_id is not null;


-- #3 person card and #4 money lane: one fan's ledger across the granted pages,
-- newest first, with the inactive (negated) rows excluded from the hot path.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select 'drop index concurrently if exists transactions_agent_fan_occurred_idx' as statement
where exists (
  select 1
  from pg_class index_relation
  join pg_index index_state on index_state.indexrelid = index_relation.oid
  where index_relation.oid = to_regclass('transactions_agent_fan_occurred_idx')
    and not index_state.indisvalid
);

-- agency-hub:statement
create index concurrently if not exists transactions_agent_fan_occurred_idx
  on transactions (fan_id, platform_account_id, occurred_at desc)
  where is_active and fan_id is not null;

-- #3/#10 subscriptions: one fan's subscriptions on the granted pages.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select 'drop index concurrently if exists page_subscriptions_agent_fan_idx' as statement
where exists (
  select 1
  from pg_class index_relation
  join pg_index index_state on index_state.indexrelid = index_relation.oid
  where index_relation.oid = to_regclass('page_subscriptions_agent_fan_idx')
    and not index_state.indisvalid
);

-- agency-hub:statement
create index concurrently if not exists page_subscriptions_agent_fan_idx
  on page_subscriptions (fan_id, platform_account_id, ends_at desc);

-- #2 resolve: the historical-username arm is looked up case-insensitively, and
-- an unindexed lower() over the alias table is a sequential scan per candidate.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select 'drop index concurrently if exists fan_username_aliases_agent_lower_idx' as statement
where exists (
  select 1
  from pg_class index_relation
  join pg_index index_state on index_state.indexrelid = index_relation.oid
  where index_relation.oid = to_regclass('fan_username_aliases_agent_lower_idx')
    and not index_state.indisvalid
);

-- agency-hub:statement
create index concurrently if not exists fan_username_aliases_agent_lower_idx
  on fan_username_aliases (lower(username));

-- #2 resolve: the same for the current username on `fans`, which is the key the
-- production gate proved a slug can be.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select 'drop index concurrently if exists fans_agent_lower_username_idx' as statement
where exists (
  select 1
  from pg_class index_relation
  join pg_index index_state on index_state.indexrelid = index_relation.oid
  where index_relation.oid = to_regclass('fans_agent_lower_username_idx')
    and not index_state.indisvalid
);

-- agency-hub:statement
create index concurrently if not exists fans_agent_lower_username_idx
  on fans (platform, lower(username))
  where username is not null;

-- #2 resolve: the page-scoped operator alias, also case-insensitive.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select 'drop index concurrently if exists page_fan_aliases_agent_lower_idx' as statement
where exists (
  select 1
  from pg_class index_relation
  join pg_index index_state on index_state.indexrelid = index_relation.oid
  where index_relation.oid = to_regclass('page_fan_aliases_agent_lower_idx')
    and not index_state.indisvalid
);

-- agency-hub:statement
create index concurrently if not exists page_fan_aliases_agent_lower_idx
  on page_fan_aliases (platform_account_id, lower(alias));

-- #8 coverage: the (page, conversation) keyset walk is ordered by the page LABEL,
