# C1 membership diagnostics restored — 12 September

Release `64149b95a3029035e8008cc807ab1971140830ba` restores the membership
diagnostics displaced by release `1f89bcc2`. The standard deployment ran from
14:40:37 to 14:43:28 UTC and exited 0. All three roles were independently
verified healthy on the restored release at 14:45 UTC.

## Release and validation

The release joins current production `1f89bcc2` and the earlier C1 release
`7aaa3185`. The merge is conflict-free and retains both histories. Current
conditional fan writes, skipped-row readback and their regressions are unchanged.
The restored handler, protection aggregate and actual UPDATE count are the
previously reviewed C1 implementation.

All 181 migration files match `7aaa3185`; all 180 files from `1f89bcc2` are
unchanged. Applied migration 0185 is restored byte-for-byte, with SHA-256
`bd9c2ee7987815ef6fd0f517a0783ead45954a2eb6ad7b5553c0075859940cb0`.
There is no new migration or change to flags, provider requests, reconciliation
policy, absence grace or presence updates. No replay, recovery, socket probe or
image garbage collection ran.

Validation used a clean archive of the exact release tree with a frozen offline
install and isolated Git metadata. Its 1,881 tracked files match the commit.

- `pnpm check`: 3,258 passed, nine existing skips, 296 files. Strictness remains
  1,901 known errors in 121 files within the existing budget; lint and dashboard
  build passed.
- Serial Docker-Postgres: 86 passed, zero skips, seven suites, 23.91 seconds.
  Suites cover membership receipts, timeline, decision diagnostics, generation
  grace, lease fencing, sync and conditional fan writes.
- `pnpm build:production` passed. Six compiled files and migration 0185 match
  the files independently read from the deployed worker.
- Independent correctness and code-quality reviews found no actionable issues
  in the exact release. Both verified preservation of the current performance
  changes and applied migrations; neither reviewer ran tests or accessed prod.

These are release `64149b95` results. Earlier source and release test counts
remain historical evidence and are not substituted for this validation.

## Production verification

API, worker and scheduler use image
`5dc2810c7654e7953dc15e39b4de21f795bca145f2ad6ec9c4fb2fb8f59575ea`,
with zero restarts. The worker started at 14:42:55.424771416 UTC. Its compiled
membership note, fields and migration file are present again.

The deployment's protected sync-health request completed at 14:43:18.634 UTC
with HTTP 200, confirmed by API request `req-6`. Its single duration was
7,083.620 ms; this is not fresh-event latency or a measured C1 speedup. Ordinary
health, dashboard delivery and the rebuilt production-pinned CLI also passed.
Free space was 23,069,528,064 bytes (about 21.5 GiB).

The adjacent READ ONLY report covers 14:25:55.812250–14:48:14.392509 UTC,
with snapshot 14:48:16.586338 UTC: 23 unique ordered runs, exhausted at upper
ID 734051. Its SHA-256 is
`b827c7213ac979828478bc35462abef4344312563a5b6d860b4cec815ae28a95`.
Only one run starts after the restored worker: Lora-2 incremental run 734024
measures 8,134 active and 8,134 provider followers and requests no reconciliation.
There is no natural full-walk membership receipt after restoration yet.

Before restoration, Lilly-2's 14:33 incremental run measured 18,323/18,323
without a request. That later count does not recover generation 789's missing
actual UPDATE count or identify its retired fan. Lora-1 generation 1213 also
completed before restoration with zero candidates and no membership receipt.
Together with Lilly-2/789 and Ari-1/59 in the preceding report, these three
terminal runs retain unknown actual retirement counts.

## Remaining boundary

The loss came from deploying a source history without the earlier C1 refinement.
This restoration preserves both histories; it does not add a global deployment
ancestry guard. Future release assembly must recheck current production and
preserve its deployed changes and immutable migrations.

The [preceding observation](OBSERVATION-20260912T142555Z.md) establishes two
later matching Lilly-1 decisions. It does not justify trigger suppression.
C1 policy acceptance, HTTP savings and fresh-event latency remain unmeasured.
A0 retains its original seven-day window, with this runtime boundary recorded;
elapsed time alone cannot pass completeness or freshness.

The bounded [validation receipt](evidence/observation-20260912T142555Z/validation.json)
records source, command results and evidence hashes. Raw reports and command
logs are retained locally in that directory; the private API log is not published.
