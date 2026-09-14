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

Local composition `33b4e909` merges main `b78752d0` (C1 and durable provider
cooldown) before final validation. Only the append-only decisions conflicted;
D322 and D327 were both retained. The runtime change remains the same narrow
metadata exclusion diff against that main. The first full check found nullable
property narrowing lost across the transaction callback. Capturing the verified
partner in one immutable local value fixed the type error without a cast or
policy change; independent review covers that final correction.

Validation is complete. `pnpm check` passed 3,420 tests in 304 unit files, with
nine existing skips; strictness baseline, lint and build passed. Four mandatory
Docker-Postgres suites passed 48/48 tests without skips, including the five new
cases. An original-handler negative control reproduced the stale overwrite
before an exact byte-verified restore. [REPORT.md](REPORT.md) gives commands,
timing, source hashes and all retained attempts. Independent review found no
outstanding findings. The parent task owns publication; no branch was pushed
here. This packet claims no production repair or measured savings.
