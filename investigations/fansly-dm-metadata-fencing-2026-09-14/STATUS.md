# DM exclusion metadata fencing

Prepared from main `478fca4220d3d07d61a9200d1860316e770cb4fe` on
`fix/fansly-dm-metadata-fencing`, scoped to audit finding 10. Decision 327 and
`docs/runbooks/fansly-dm-exclusion.md` describe the existing recovery path's
metadata-only write and refusal behavior. No polling policy, flag or migration
changes; no production calls, push or PR publication performed here. The parent
task authorized local checkpoint and main-composition commits before validation.

The implementation replaces the stale full-row upsert after an unresolved partner
lookup with an atomic merge into current metadata, matching conversation/page/
partner. A missing match rethrows the original provider error inside the same
lease-owned transaction, preserving the checkpoint and avoiding row recreation.
Initial independent source inspection found no defect in this implementation.

`tests/fansly-dm-exclusion.integration.test.ts` adds five real PostgreSQL cases:
newer head/preview/body/reply/stored-cursor/coverage/metadata preservation during
lookup, removed and rebound thread refusals, lease replacement and wrong-page
refusal. Only adapter transport is stubbed; the handler, failure history, account
lookup capture, lease ownership, metadata update and checkpoints use real code.
The existing handler unit test pins the narrow repository call and continuation.

Validation is pending the shared serial test lane. Planned: `pnpm check`, then
mandatory Docker PostgreSQL for the new suite, `page-dm.repository.integration`,
`page-sync-lease-fencing.integration` and
`fansly-dm-conversations-sweep.integration`. Independent review is requested
before publication. This packet claims no production repair or measured savings.
