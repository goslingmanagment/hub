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

-- Indexes over the existing retained ledgers are deliberately deferred to
-- 0104, whose non-transactional runner builds every physical index
-- concurrently and is safe to resume after a process crash.
