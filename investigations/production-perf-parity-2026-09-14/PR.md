Production contains performance and correctness fixes absent from main. A deployment from main would restore repeated replay scans, admit new HTTP attempts after lease loss, and reopen the cleanup/finalizer race. This PR restores the twelve original performance patches while preserving newer main deployment, audit and A0 changes.

It also restores the exact, already-applied 0185/0186 migration files, pins their identities and bytes, and tests real migration continuation through 0191. Historical decisions 301–311/315 and decision 321 document the transfer. No new flag or provider call is added.

**Validation**

- `pnpm check`: passed; 304 unit files, 3,414 tests passed, nine existing skips; typecheck, lint and dashboard build passed.
- Serial Docker-Postgres/transport suites: 16 files, 144 tests passed. Covers migration history, alias contention, cleanup/finalizer races, lease fencing, replay isolation and query work, payload batching, metrics, A0 and transport.
- Independent correctness and readability reviews: no open findings. The final test setup correction received a follow-up review.
- Initial migration test setup failure and successful full rerun are retained alongside commands, timestamps and compressed logs in `investigations/production-perf-parity-2026-09-14/validation/`.

**Production and remaining scope**

Read-only preflight at 2026-09-13 23:30 UTC confirmed source `380326368fe3`, three healthy roles, zero restarts and applied migration names 0185–0191. SQL hashes come from the identified production Git revision; the ledger stores names and timestamps only. No deployment or flag change occurred.

C1 membership diagnostics in #166 and dashboard feature controls remain separate production/main differences. Reconcile them before deploying main as a replacement. This PR does not establish A0/C1/W0 acceptance, savings or reader latency.

[Transfer report and independent reviews](https://github.com/goslingmanagment/core/blob/fix/production-perf-parity-20260914/investigations/production-perf-parity-2026-09-14/REPORT.md)
