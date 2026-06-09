# Workboard v3 — Implementation decisions log

Append-only. One line per ambiguity resolved during implementation (what was decided and why),
per the question policy in `docs/workboard-v3-implementation-brief.md`.

- **M0.1 / segment enum**: `workboard_v3_segment` holds lifecycle states only (`subscriber|spender|fresh|gray|mass_active|dead|archived`); the PRD's `service` "segment" is derived at read time from `do_not_touch` + active `workboard_snoozes` — a snooze expiring must restore the underlying segment, so it cannot overwrite it.
- **M0.1 / do_not_touch_reason**: added a nullable `do_not_touch_reason` column to `workboard_v3_fan_state` — the Service tab review of stop_request auto-DNT (PRD §9) needs the "why", and the PRD sketch had no home for it.
- **M0.1 / retention vs history**: `dialog_reads.last_fan_message_pk` and `workboard_v3_touches.model_message_pk` are `ON DELETE SET NULL` so the DM tiered-retention pruning (migrations 0025/0026) never erases verdict timelines or touch history; `dm_broadcast_messages.message_pk` cascades because the mapping only matters while the message exists.
- **M0.1 / job watermark**: added a tiny `workboard_v3_job_state` table (page → `broadcast_scanned_until`) because the brief requires the broadcast detector to scan "model messages since the last run"; everything else (confirm, recompute, dialog-read candidates) is watermark-free/idempotent.
- **M0.2 / broadcast touches**: the detector inserts one `broadcast` touch per newly mapped message (fan resolved via the thread) — PRD §4 lists `broadcast` as a touch type and §10 wants outcomes for every touch, so touches are the single source for cadence credit and the outcome loop; messages in threads with no linked fan are grouped but credit nothing.
- **M0.2 / empty content**: messages whose content is empty after lowercase+trim (media-only) never group — identical "no text" attachments would otherwise collapse into one bogus broadcast.
- **M0.2 / split blasts**: the scan loads a created_at window around newly synced messages (not just the new rows), so a blast that syncs in two halves still reaches the ≥10 threshold; the watermark advances on `synced_at` (ms-truncated to survive the JS Date round-trip).
- **M0.2 / config**: threshold/window are function parameters with PRD defaults (≥10 recipients / 60 min); per-page tuning arrives with the Phase 2 settings surface.
