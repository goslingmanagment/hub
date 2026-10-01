-- 0230_tip_context_observation_lineage.sql
--
-- Fansly Sync Engine design §2.4. The new engine journals `/message` pages in
-- `observations` only (no `sync_raw_payloads` row, plan §11), so a tip context
-- it materializes keeps its lineage by observation. The observations primary
-- key is (id, received_at) — partitioned, so no foreign key is possible — and
-- each lineage is the pair of both columns:
--
--   source_observation_id / _received_at
--       the observation that proved tip identity and its captured
--       conversation (the twin of source_raw_payload_id);
--   tip_message_source_observation_id / _received_at
--       the observation whose note won the knowledge-monotonic merge (the
--       twin of tip_message_source_raw_payload_id).
--
-- A row carries raw lineage (legacy writers), observation lineage (the
-- engine), or neither (its raw row was deleted); the writer
-- (repositories/transaction-tip-contexts.ts) sets one kind per lineage. The
-- raw-payload foreign keys stay until step 4; existing rows keep their raw
-- lineage (no backfill here).
--
-- Purely additive, IF NOT EXISTS; the previous image never names the columns,
-- and its writer (which names only the raw columns) leaves them null, which
-- the pair check accepts. No read-role grant: the table holds fan notes and
-- read_only has never been granted it.
alter table transaction_tip_contexts
  add column if not exists source_observation_id bigint,
  add column if not exists source_observation_received_at timestamptz,
  add column if not exists tip_message_source_observation_id bigint,
  add column if not exists tip_message_source_observation_received_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transaction_tip_contexts_obs_lineage_check') then
    alter table transaction_tip_contexts add constraint transaction_tip_contexts_obs_lineage_check check (
      (source_observation_id is null) = (source_observation_received_at is null)
      and (tip_message_source_observation_id is null) = (tip_message_source_observation_received_at is null)
    ) not valid;
  end if;
end $$;

-- About 1 300 rows in production (2026-10-02): validating scans them at once.
alter table transaction_tip_contexts validate constraint transaction_tip_contexts_obs_lineage_check;

create index if not exists transaction_tip_contexts_source_observation_idx
  on transaction_tip_contexts (source_observation_id) where source_observation_id is not null;

comment on column transaction_tip_contexts.source_observation_id is
  'Observation (with source_observation_received_at) that proved tip identity and its conversation, for rows the Fansly Sync Engine materialized; the twin of source_raw_payload_id. No FK: observations are partitioned.';
comment on column transaction_tip_contexts.source_observation_received_at is
  'received_at of source_observation_id (the observations partition key); set together with it.';
comment on column transaction_tip_contexts.tip_message_source_observation_id is
  'Observation (with tip_message_source_observation_received_at) whose note won the merge; the twin of tip_message_source_raw_payload_id.';
comment on column transaction_tip_contexts.tip_message_source_observation_received_at is
  'received_at of tip_message_source_observation_id; set together with it.';
