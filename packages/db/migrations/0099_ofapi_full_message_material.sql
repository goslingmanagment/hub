-- OF mirror S2: projection-only full message material and indexed SSE replay.
-- Raw/vendor responses remain in observations; these columns are a rebuildable
-- serving projection. Signed media URLs and bytes are intentionally excluded.

ALTER TABLE message_archive
  ADD COLUMN native_message_id bigint,
  ADD COLUMN text_html text,
  ADD COLUMN is_opened boolean,
  ADD COLUMN is_new boolean,
  ADD COLUMN tip_text_plain text,
  ADD COLUMN reply_metadata jsonb,
  ADD COLUMN origin_class text,
  ADD COLUMN material_observed_at timestamptz,
  ADD COLUMN vendor_changed_at timestamptz,
  ADD COLUMN source_account_seq bigint,
  ADD COLUMN serving_contract_version integer NOT NULL DEFAULT 0;

ALTER TABLE message_archive_shadow
  ADD COLUMN native_message_id bigint,
  ADD COLUMN text_html text,
  ADD COLUMN is_opened boolean,
  ADD COLUMN is_new boolean,
  ADD COLUMN tip_text_plain text,
  ADD COLUMN reply_metadata jsonb,
  ADD COLUMN origin_class text,
  ADD COLUMN material_observed_at timestamptz,
  ADD COLUMN vendor_changed_at timestamptz,
  ADD COLUMN source_account_seq bigint,
  ADD COLUMN serving_contract_version integer NOT NULL DEFAULT 0;

CREATE INDEX message_archive_ofapi_native_order_idx
  ON message_archive (account_id, conversation_ref, native_message_id DESC)
  WHERE platform = 'onlyfans' AND deleted_at IS NULL;

CREATE INDEX message_archive_shadow_ofapi_native_order_idx
  ON message_archive_shadow (account_id, conversation_ref, native_message_id DESC)
  WHERE platform = 'onlyfans' AND deleted_at IS NULL;

-- SSE v2 never needs to visit projection-only rows per connection. PostgreSQL
-- propagates this partitioned index to every attached domain_events partition.
CREATE INDEX domain_events_v2_deliverable_account_seq_idx
  ON domain_events (account_id, account_seq)
  WHERE type <> 'message.material_observed';
