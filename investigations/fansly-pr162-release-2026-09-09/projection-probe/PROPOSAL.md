# Five Lilly-2 reply roots: exact operational diagnosis

Superseded without production execution: ordinary archive passes completed at
19:57 UTC; the20:02:55 exact recheck matched all five roots. No role exception
is needed for these targets. The prepared query remains unused evidence.

Originally prepared, locally validated, NOT dispatched to production. This is separate
from the completed owner-approved PR162 deployment and completed scoped reply
replay. Existing replay permission remains behind the original per-page gate.

All409 original Lilly-2 messages and parent links are readable. The same five
messages still lack root material after the19:53:55 UTC read; four also retain
old normalized text. All162 source receipts are v6, and the pure deployed
canonicalizer derives the expected parent/root for all409. The five unresolved
IDs come from two original source receipts at01:41:16.029 and01:44:01.049 UTC on
8 September. Their exact event keys were derived from those retained bodies.

## Proposed single operation

Execute [probe.sql](probe.sql), exactly once, as `postgres` in `BEGIN READ ONLY`.
Statement limit10s, lock limit2s. Five exact keys and archive IDs, account5 only.
Indexed key/event/archive lookups and one account watermark/sequence row return
only IDs, sequence numbers, timestamps, reply refs and a diagnostic classification.
No message text, attachment content, credentials, writes, ANALYZE, role grants,
rebuilds, replay, scheduling or flags. On timeout/error, save it and stop.

SHA-256: `6cf694600d20f8531d66e7f1fad2402df6e77eb4f67b5a6453d73979bb2472d3`.

The classification distinguishes a missing key, an unavailable event row,
a projection watermark below the expected event, and a watermark which already
covers it. This is a diagnostic result, not authorization for a repair.

Local Docker-Postgres16 validation passed the exact SQL in READ ONLY across five
fixtures: pending, covered-but-missing-material, missing key, missing event row,
and populated root; a foreign-account key cannot satisfy the account5 lookup.
The test container was removed. This verifies syntax and classification, not
production cost. See local-validation.json and local-probe.txt.

## Why a separate yes is required

The user's production rule and CLAUDE.md restrict ordinary psql to `read_only`.
At19:41:41 UTC, metadata checks confirmed SELECT is unavailable on domain_events,
message_archive and projection_seq_watermarks. Operational metrics and job tables
were also denied at19:44:14; the authenticated browser metrics attempt did not
produce a readable report. No permission was bypassed. The previous one-time
PR161 plan-only exception was already used and does not authorize this query.
`Да деплой на все` authorized deployment, not a new database-role exception.

Rollback: there are no data/config changes to reverse. Connection termination
ends the read-only transaction. Prior failures and successful retained-body reads
are preserved. Any subsequent production mutation needs its own applicable gate.
