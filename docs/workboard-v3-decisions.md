# Workboard v3 — Implementation decisions log

Append-only. One line per ambiguity resolved during implementation (what was decided and why),
per the question policy in `docs/workboard-v3-implementation-brief.md`.

- **M0.1 / segment enum**: `workboard_v3_segment` holds lifecycle states only (`subscriber|spender|fresh|gray|mass_active|dead|archived`); the PRD's `service` "segment" is derived at read time from `do_not_touch` + active `workboard_snoozes` — a snooze expiring must restore the underlying segment, so it cannot overwrite it.
- **M0.1 / do_not_touch_reason**: added a nullable `do_not_touch_reason` column to `workboard_v3_fan_state` — the Service tab review of stop_request auto-DNT (PRD §9) needs the "why", and the PRD sketch had no home for it.
- **M0.1 / retention vs history**: `dialog_reads.last_fan_message_pk` and `workboard_v3_touches.model_message_pk` are `ON DELETE SET NULL` so the DM tiered-retention pruning (migrations 0025/0026) never erases verdict timelines or touch history; `dm_broadcast_messages.message_pk` cascades because the mapping only matters while the message exists.
- **M0.1 / job watermark**: added a tiny `workboard_v3_job_state` table (page → `broadcast_scanned_until`) because the brief requires the broadcast detector to scan "model messages since the last run"; everything else (confirm, recompute, dialog-read candidates) is watermark-free/idempotent.
