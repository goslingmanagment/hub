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
- **M0.3 / Готово semantics**: when an open (unconfirmed personal) touch exists, "Готово" converts it to a confirmed `manual` touch instead of stacking a second row — one click, one touch; with nothing open it records a fresh manual touch.
- **M0.3 / confirm lookback**: the confirm job re-checks open touches up to 7 days back (window for *messages* stays 6h from opened_at) because the DM sync can deliver a confirming message hours late; unconfirmed touches simply stay unconfirmed — no expiry status.
- **M0.3 / job cadence**: `workboard-v3.confirm-touches` runs `*/20` UTC (PRD says 15–30 min), gated by `WB3_ENABLED` (default off) inside the handler so schedules exist but do nothing until the flag flips.
- **M0.4 / renew-off cadence**: subscribers with auto_renew=false get a 3-day interval (PRD says "every 2–3d"); the calm end was chosen because the expiry ladder reasons already carry the urgency and the PRD warns against hammering.
- **M0.4 / meaningfulness window**: the L1 content scan (+ Dialog Read intent when present for the exact message) covers the last 90 days; fan messages older than the scan count as "ever replied" — safe because such fans are >60d silent and stay in gray regardless, where has_ever_replied only boosts rotation priority.
- **M0.4 / ever-paid source**: spender = posted+active transactions with net > 0 **or** page_fans.total_creator_net_mills > 0 (belt and braces while transaction backfill coverage is uneven).
- **M0.4 / dead attempts reset**: once a fan has any message in stored history dead_attempts evaluates to 0 (PRD defines attempts as "while the fan has zero messages") — resurrection also clears sleep/archive timestamps.
- **M0.4 / sour scope**: the dossier `ending=sour` ×2 factor stretches spender and mass_active cadence only; subscriber retention keeps its schedule (renew risk beats dossier mood).
- **M0.4 / dialog days**: freeloader "dialog days" use UTC day boundaries (the codebase's business-date convention).
- **M0.4 / recompute order**: broadcasts → outcome stamping → FSM, so broadcast touch credit and outcomes exist before cadence/segment math; job runs 04:00 UTC after the v2 run at 03:00.
- **M0.4 / L1 reuse**: v3 imports `isClosingMessage` from workboard-v2/closing.ts read-only (shared L1 list per the brief; v2 files untouched).
