# C1-preserving health deployment — 11 September 2026

Approved source `66d6ac1a8979cfb1be6e9c365bbe9dc1981f29f3` is running on API,
worker and scheduler. The standard deployment exited **0** at
**19:47:07.552 UTC**. Its protected sync-health gate executed and returned
**HTTP 200**, with eight pages present and all eight marked `ok`.

This closes the deployment gate for this release. It does not close the
endpoint latency issue, A0 acceptance, C1 policy investigation or the migration.

## Release and validation

- [PR172](https://github.com/goslingmanagment/core/pull/172) narrowed completed-run
  ranking before payload lookup. It merged after independent correctness and
  code-quality reviews. C1 remains the [PR166 draft](https://github.com/goslingmanagment/core/pull/166).
- This combined release also includes the already merged PR171 Overview/API
  changes. C1 runtime and all 179 migration files match the prior diagnostic
  release byte for byte. No new flag or migration was introduced.
- The approved tree passed `pnpm check`: 3251 tests, nine existing skips;
  seven serial Docker-Postgres suites: 81 tests, zero skips.
  They cover decision/queue receipts, read permissions, lease/generation guards,
  absence grace, completed-run selection and the incoming revenue API.
- All five [Node 22 CI jobs](https://github.com/goslingmanagment/core/actions/runs/34636261183)
  passed, including production/Docker builds and Chromium smoke. Deployment
  rebuilt the same clean source; five compiled files inside the running image
  match the local build hashes. No new runtime edits or test reruns were needed.

## Actual deployment and health

The owner answered “давай” to the exact release request. The unmodified command
was `scripts/deploy-production.sh --mode dist-only --no-image-gc root@45.8.230.111`.
It ran from 19:21:03.317 through 19:47:07.552 UTC; upload of the 30 MB context
accounted for much of the preparation. The standard path recreated Postgres
and all three application roles, retaining the existing database volume.

- Previous image: `sha256:c8a5567e229b012bea7f2c63baf0c398aae3990cf04b8710b01e4f08b99fe851`.
- Running image: `sha256:072683cec009ac8bc0bf9dc60436da6c64825e57696f6db3c70450038de41e2a`.
- API and scheduler started at 19:37:08 UTC; worker at 19:37:45.925797558 UTC.
  All were healthy with zero restarts in the 19:48 postflight. The earlier
  worker restart on the previous image remains a separate historical boundary.
- Ordinary API health was `ok`; its postflight database probe was 185 ms.
  A prior probe during the protected-health wait was 8 ms. Neither measures
  the detailed sync endpoint or provider-event delivery latency.
- The new contract is `f3d4c12dadbef703b7c85f289f63d0d1651941e0ea15fbd94685d9448b0e7b79`.
  The local CLI was rebuilt from the exact full source, checked against live
  capabilities and switched successfully; its prior install was retained.
- Dashboard checks passed. Both deployment locks were absent after completion.
  Free disk was 25,611,698,176 bytes (23.85 GiB). No rollback or image GC ran.

The first two protected-health requests timed out at 150000 and 150004 ms.
The third, `req-4v`, started at 19:44:13.438 UTC and completed at 19:46:26.743;
Fastify recorded **133304.531 ms** and HTTP 200. This is one successful whole
endpoint duration, not a SQL timing, percentile or demonstrated improvement.
All eight page statuses were `ok`; the same body retains historical counters
of 30 recent failed runs and 1231 recent 5xxs. These are not new errors attributed
to this deployment. No additional protected-health GET was sent.

## Remaining latency investigation

Independent code review confirms that PR172 changes only one part of one SQL
query. The endpoint waits for five parallel branches; the sync snapshot also
performs later OFAPI freshness and financial-summary reads. Their individual
durations have not been measured. The historical physical-attempt window remains.

Two one-second host samples had no idle CPU and a runnable queue of 11/8.
The first passive process snapshot showed one API SELECT; after success only
an idle API backend was present. Those snapshots do not prove accumulated or
cancelled SQL, continuous query duration or attribution of CPU to a request.
The first two requests have no completion in the bounded API log; their SQL
outcomes are unknown. A pg busy-client deprecation warning is retained in the
API log without an established relationship to this endpoint.

No further speculative production query rewrite is justified by these data.
The next technical step is a local full-endpoint measurement by branch under
concurrent load; production profiling outside the existing read plane retains
its separate owner gate.

## First observation on the new runtime

The existing reviewed helper read 19:37:45.925797–19:49:43.148710 UTC in one
repeatable READ ONLY snapshot as `read_only`, with a 20-second statement limit.
The report hash and exhausted cursor were verified; these are retained rows,
not a claim of telemetry completeness. This window is not added to older ones.

- C1: two valid no-request decisions, Lilly-2 18324/18324 and Lora-2 8132/8132.
  All three predicates were false. Other branches and completed reconciliation
  generations are not exercised by these two observations.
- A0: four newly started sweeps, one incomplete and three running, none complete;
  1100 repeated unknown material checks. These are not 1100 lost messages.
- Retained physical attempts: 131, with zero recorded retries, failed states or
  429s. HTTP coverage has two unknown and two boundary runs. DM coverage has
  two unknown runs and one lost-report receipt on Lora-2. Coverage includes
  intersecting runs, so this receipt cannot be attributed to the new worker or
  release. No worker-log reconciliation or savings comparison was performed.

A0 keeps its original start, 10 September 22:58:33.610 UTC; the new runtime
boundary is retained without resetting it. Seven days alone do not pass A0.
C1 remains diagnostic. C2a/C2b execution evidence, W0 live scope, A1 and B2
remain separately gated. No physical HTTP saving or fresh-event latency
percentile is claimed.

## Evidence and independent review

`dispatch.json` records approval and preflight; `result.json` records the actual
exit and log hash. `gate-capture.json` binds the four response/schema artifacts.
Its separate collector followed the deploy-owned temporary directory because
macOS mktemp used the system temp directory. The initial wrapper's empty
`result.gate_artifacts` is not used as evidence of missing or successful gates.
`postflight.json` and its summary bind runtime, compiled hashes, CLI and API logs.
`post-release-report/` retains the read receipt and manifest; the derived counts
are in `post-release-summary.json`. Independent operational review confirmed the
release, latency and observation facts; final review is closed with no findings.
