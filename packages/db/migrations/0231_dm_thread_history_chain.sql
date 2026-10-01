-- 0231_dm_thread_history_chain.sql
--
-- Fansly Sync Engine design §2.3 (plan §6.2, §6.3, §8): the contiguous-chain
-- coverage of a DM thread, and the WS repair bookkeeping of a connection.
--
-- page_dm_threads — chain columns. ONE writer:
-- packages/db/src/repositories/sync/thread-chain.ts writeThreadChain (the
-- engine's DM apply, in the transaction of the messages, or the journal
-- rebuild, in its own transaction). Legacy writers never touch these columns,
-- and writing them never touches a legacy column (stored_*,
-- message_coverage_status, message_backfill_complete, last_message_sync_at).
--
--   head_confirmed_id / _at   newest message of the proven chain; _at is the
--                             capture time of the page that showed it as head
--   contiguous_oldest_id / _at oldest message of the proven chain; _at is that
--                             message's created_at
--   contiguous_count          messages in the chain (head .. oldest)
--   chain_upward_count        messages added above the head over time
--   chain_epoch               bumped when the chain is replaced (anchors of
--                             history requests are cleared on a change)
--   history_state             none | unverified | partial | complete
--   history_proof             empty_page (first_second is reserved, never
--                             written while owner decision №3 stands)
--   history_proven_at         capture time of the proving empty page
--   history_proof_observation_id / _received_at
--                             the proving page as an engine observation
--   history_proof_raw_payload_id
--                             the proving page in the legacy journal (rebuild)
--   chain_source              journal_rebuild | engine (null: never written)
--   chain_journal_watermark   sync_raw_payloads.id the rebuild folded through
--
-- Legacy-stored messages are not proof (plan §6.3): threads that hold messages
-- start 'unverified' until a chain is proven. Readers use the effective state
-- (thread-chain.ts effectiveHistoryStateSql) because legacy keeps storing
-- messages after this marking.
--
-- fansly_ws_connections — plan §8 repair bookkeeping (written from step 3).
--
-- Purely additive, IF NOT EXISTS; the previous image never names these
-- columns. ADD COLUMN ... NOT NULL DEFAULT <constant> is catalog-only. The
-- one-time marking touches about 37 000 rows (2026-10-02) while the deploy has
-- worker and scheduler quiesced. page_dm_threads keeps its grants (none for
-- the read role: fan material); fansly_ws_connections keeps its table grant.
alter table page_dm_threads
  add column if not exists head_confirmed_id text,
  add column if not exists head_confirmed_at timestamptz,
  add column if not exists contiguous_oldest_id text,
  add column if not exists contiguous_oldest_at timestamptz,
  add column if not exists contiguous_count integer not null default 0,
  add column if not exists chain_upward_count bigint not null default 0,
  add column if not exists chain_epoch integer not null default 0,
  add column if not exists history_state text not null default 'none',
  add column if not exists history_proof text,
  add column if not exists history_proven_at timestamptz,
  add column if not exists history_proof_observation_id bigint,
  add column if not exists history_proof_observation_received_at timestamptz,
  add column if not exists history_proof_raw_payload_id bigint,
  add column if not exists chain_source text,
  add column if not exists chain_journal_watermark bigint not null default 0;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'page_dm_threads_history_state_check') then
    alter table page_dm_threads add constraint page_dm_threads_history_state_check
      check (history_state in ('none', 'unverified', 'partial', 'complete')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'page_dm_threads_history_proof_check') then
    alter table page_dm_threads add constraint page_dm_threads_history_proof_check
      check (history_proof is null or history_proof in ('empty_page', 'first_second')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'page_dm_threads_contiguous_count_check') then
    alter table page_dm_threads add constraint page_dm_threads_contiguous_count_check
      check (contiguous_count >= 0 and chain_upward_count >= 0 and chain_epoch >= 0 and chain_journal_watermark >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'page_dm_threads_chain_source_check') then
    alter table page_dm_threads add constraint page_dm_threads_chain_source_check
      check (chain_source is null or chain_source in ('journal_rebuild', 'engine')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'page_dm_threads_history_proof_observation_check') then
    alter table page_dm_threads add constraint page_dm_threads_history_proof_observation_check
      check ((history_proof_observation_id is null) = (history_proof_observation_received_at is null)) not valid;
  end if;
end $$;

-- The new columns hold their defaults on every row, so validation is a scan
-- that cannot fail (about 37 000 rows, 2026-10-02).
alter table page_dm_threads validate constraint page_dm_threads_history_state_check;
alter table page_dm_threads validate constraint page_dm_threads_history_proof_check;
alter table page_dm_threads validate constraint page_dm_threads_contiguous_count_check;
alter table page_dm_threads validate constraint page_dm_threads_chain_source_check;
alter table page_dm_threads validate constraint page_dm_threads_history_proof_observation_check;

-- Legacy-stored messages are not proof (plan §6.3): mark them unverified until
-- the journal rebuild proves a chain. Only the new column changes.
update page_dm_threads t
   set history_state = 'unverified'
  from pages p
 where p.id = t.platform_account_id
   and p.platform = 'fansly'
   and t.stored_message_count > 0
   and t.history_state = 'none';

alter table fansly_ws_connections
  add column if not exists state_reconciled_at timestamptz,
  add column if not exists transient_unknown tstzrange;

comment on column page_dm_threads.head_confirmed_id is
  'Newest message id of the proven contiguous chain (Fansly Sync Engine, plan §6.2). Written only by writeThreadChain.';
comment on column page_dm_threads.head_confirmed_at is
  'Capture time of the page that showed head_confirmed_id as the head of the chat.';
comment on column page_dm_threads.contiguous_oldest_id is
  'Oldest message id of the proven contiguous chain; the next history read is before = this id.';
comment on column page_dm_threads.contiguous_oldest_at is
  'created_at of contiguous_oldest_id.';
comment on column page_dm_threads.contiguous_count is
  'Messages in the proven chain, head to oldest.';
comment on column page_dm_threads.chain_upward_count is
  'Messages the chain gained above its head over time (anchors of latest-N history requests count from it).';
comment on column page_dm_threads.chain_epoch is
  'Bumped when the chain is replaced; history request anchors of an older epoch are cleared.';
comment on column page_dm_threads.history_state is
  'none | unverified (legacy-stored messages, no proven chain) | partial (chain from a confirmed head) | complete (proof in history_proof). Readers use effectiveHistoryStateSql.';
comment on column page_dm_threads.history_proof is
  'How complete was proven: empty_page (an accepted empty page at before = contiguous_oldest_id, or the empty head of a known chat). first_second is reserved and never written while owner decision №3 stands.';
comment on column page_dm_threads.history_proven_at is
  'Capture time of the proving empty page.';
comment on column page_dm_threads.history_proof_observation_id is
  'Observation of the proving page (engine reads), with history_proof_observation_received_at. No FK: observations are partitioned.';
comment on column page_dm_threads.history_proof_observation_received_at is
  'received_at of history_proof_observation_id; set together with it.';
comment on column page_dm_threads.history_proof_raw_payload_id is
  'sync_raw_payloads id of the proving page when the proof comes from the legacy journal rebuild. No FK: the journal and its erasure are independent.';
comment on column page_dm_threads.chain_source is
  'Last writer of the chain columns: journal_rebuild or engine; null when never written. The rebuild never overwrites an engine chain.';
comment on column page_dm_threads.chain_journal_watermark is
  'sync_raw_payloads id the journal rebuild folded this thread through; an incremental rebuild folds only later pages.';
comment on column fansly_ws_connections.state_reconciled_at is
  'When the post-gap REST repair of this connection finished (Fansly Sync Engine, plan §8).';
comment on column fansly_ws_connections.transient_unknown is
  '[gap_since - 60 s, verified_at): a message created and deleted inside this range is unrecoverable (plan §8).';

-- The table-level grant of 0196 already covers new columns; repeated so the
-- read role's access does not depend on the order of migrations.
do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on fansly_ws_connections to read_only;
  end if;
end $$;
