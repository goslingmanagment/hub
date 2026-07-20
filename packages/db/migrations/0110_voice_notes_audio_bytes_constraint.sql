-- 0110_voice_notes_audio_bytes_constraint.sql
-- 0109 capped the caller-supplied metadata column. Bind that metadata to the
-- actual BYTEA length so a future writer cannot bypass the 2 MiB carve-out by
-- supplying a smaller audio_bytes_len value. Rows whose artifact was purged
-- retain their historical length metadata and therefore remain valid.
ALTER TABLE "voice_notes"
  ADD CONSTRAINT "voice_notes_audio_bytes_consistent"
  CHECK (
    "audio_bytes" IS NULL
    OR (
      "audio_bytes_len" IS NOT NULL
      AND "audio_bytes_len" = octet_length("audio_bytes")
      AND octet_length("audio_bytes") <= 2097152
    )
  );
