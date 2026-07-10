-- Fast-reply corrections (Wave 2): fingerprint bookkeeping on the OF material
-- head. material_fingerprint = sha256 over the reduced 13-field material tuple
-- (nullable until the preamble backfill runs — the reconciler is gated on a
-- boot flag that stays OFF until the backfill completes; enabling it against
-- NULL fingerprints would mass-append redundant superseding events).
-- emitted_* track what the domain_events ledger last said about this message;
-- material != emitted is THE queryable repair signal. revision_no counts
-- ledger revisions (1 = first event). material_field_provenance records which
-- source last set each material field (seeded from `source` by the preamble).
-- rest_platform_changed_at is the deferred Wave-2 input: the platform's own
-- edit time from REST payloads (NOT observation time — that stays in
-- rest_material_observed_at). Single transaction, catalog-only changes.
ALTER TABLE dm_message_archive
  ADD COLUMN material_fingerprint bytea,
  ADD COLUMN emitted_fingerprint bytea,
  ADD COLUMN emitted_event_id bigint,
  ADD COLUMN revision_no integer NOT NULL DEFAULT 1,
  ADD COLUMN material_field_provenance jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN rest_platform_changed_at timestamptz;

-- The reconciler's work-list access path: rows whose material advanced past
-- the ledger. Partial — steady state is empty (fingerprints equal), so the
-- index stays tiny; backfill sets both sides equal for already-evented rows.
CREATE INDEX dm_message_archive_repair_signal_idx
  ON dm_message_archive (platform_account_id, id)
  WHERE material_fingerprint IS DISTINCT FROM emitted_fingerprint;
