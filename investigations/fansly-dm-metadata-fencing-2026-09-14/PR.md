After repeated message 5xx failures, an unresolved partner lookup could write an old conversation snapshot over a newer head, preview, stored-message cursors or metadata. The recovery now merges only its exclusion key into the current row, matching the conversation, page and verified partner. The lease-owned transaction refuses removed/rebound rows without resetting their checkpoint or recreating them.

This addresses audit finding 10. Decision 327 and the runbook document the behavior; no flag, migration or provider request is added.

Validation on the current-main composition:

- `pnpm check`: passed; 3,420 tests in 304 files, nine existing skips; strictness baseline, lint and build passed (46.218s).
- Mandatory Docker PostgreSQL, serial: `fansly-dm-exclusion`, `page-dm.repository`, `page-sync-lease-fencing`, `fansly-dm-conversations-sweep`; 48/48 tests, zero skips (12.485s).
- Original-handler negative control reproduced the stale head/cursor/metadata overwrite; exact source restoration and all initial failures are retained in `investigations/fansly-dm-metadata-fencing-2026-09-14/evidence`.
- Independent source, composition and readability review: no outstanding findings. No production action or measurement was performed for this patch.
