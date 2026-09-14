# Independent production-source reconciliation

No omitted production-only runtime fix or migration-history regression was found
in this candidate. This is local source reconciliation, not runtime-health,
acceptance-gate or deployment-readiness evidence. No tests, production calls,
provider requests or Git mutations were performed by this reviewer.

Reviewed 2026-09-14T00:53:24.291134+00:00 against retained production
`380326368fe39a6a9d22eb73b0b955f8ecd7c3cc` and main
`b78752d0d1144a8457638ffb3ae0bda33455fde1`. Candidate HEAD is
`c28efafe5cadb80780b9bcd34bacc10e2f0fbf0f`: the requested `bfdb1440` candidate plus the now-committed
static-CI heap follow-up. Runtime, package and dashboard topic source did not
change during this review. Unrelated untracked evidence was not assessed.

## Preservation checks

| Scope | Independent comparison |
| --- | --- |
| Twelve performance transfers | Recomputed the union of `production-perf-parity-2026-09-14/transfer-steps.json`: 44 paths, 39 production-byte-identical. The other five contain only inherited deployment/cooldown changes described below. Lease-loss admission cancellation, cleanup/finalizer fencing, separate capture/replay, empty replay-head probing, single-pass earnings parsing, alias order, seed counts, bounded metrics/payload reads and preview scope remain present. |
| C1 and remaining runtime | The entire `apps/runtime` and `packages` diff against production contains only the three intentional cooldown files below. In particular, `executor-handlers.ts`, `fans.ts`, C1 diagnostics/read functions and the AI runtime retain the production content. |
| Dashboard transfer | Recomputed all 103 source-manifest current/production hashes from files and Git blobs: all match the retained manifest; 102 are production-byte-identical. `OfapiMarketing.tsx` retains the already independently verified formatting-only change; its reviewed candidate hash is unchanged. This review did not rerun that transpilation comparison. |
| Historical decisions | All 17 requested D296–311/315 bodies and quick-reference rows match production (section boundaries ignore trailing separator whitespace). Every main decision body and quick-reference row remains present; added topic entries only expand the table. |
| Newer main | Outside the 103 declared dashboard topic paths and documentation/evidence, the sole change versus main is the four-line static-CI heap setting. Runtime, database, migrations, contracts, SDK, Dockerfile, deployment helpers and earnings exporter equal main exactly. |

The dashboard source manifest SHA-256 is `819f99e75c995aeb75291cd042de1481b6e54023462880f2dc6be1353fb4f784`.
The independent comparisons do not treat the retained transfer receipts or past
test totals alone as proof of the current files.

## Migration identities

All **187 tracked migration entries**, including their Git blob IDs, are identical
to production, and the working migration directory has no tracked differences or
new untracked migration files. All 13 SQL files in the 0178–0191 interval match
production bytes: 0178 and 0180–0191. **0179 is absent in both trees**, so it is
not a new missing migration and must not be invented to fill the numbering gap.

| Applied historical identity | SHA-256 |
| --- | --- |
| `0185_fansly_followers_membership_read.sql` | `bd9c2ee7987815ef6fd0f517a0783ead45954a2eb6ad7b5553c0075859940cb0` |
| `0186_ops_metrics_recent_series.sql` | `8fde039eb9e8f0d211ab419f0cd7264e5186aa79d9e223c6a4a42a083d571b7e` |

The retained performance preflight records `read_only`, repeatable-read/read-only
identity and applied names/times for 0180–0191 at 2026-09-13T23:30:46.860032Z.
It does not cover 0178 or prove database SQL contents; the checks here establish
source-byte preservation, not a fresh production ledger observation. Migration
runner code is also production-identical. The earlier 0185/0186 omission and
prefix-collision risk is closed in this source candidate.

## Intentional differences from production

- **D322 / PR184:** `sync/executor.ts`, `notification-incidents.ts` and
  `repositories/page-sync.ts` add durable provider-cooldown preservation and
  immediate visibility of a provider pause over 30 minutes. Existing production
  lease cancellation and seed-state work remain intact. Associated tests and
  error-handling prose explain these differences.
- **D316 / PR177, retained from main:** Docker/CI and deployment helpers add the
  checked-image pull path, metadata/infrastructure checks and build-cache changes.
  The Compose configuration itself remains production-identical; the deployment
  script keeps the applied 0186 additive rollback declaration. These newer main
  changes were preserved, not replaced by older production scripts.
- **PR181, retained from main:** the earnings audit exporter requires and records
  `force_custom_plan` within its read-only transaction. Newer A0 regression and
  migration-continuity tests also remain present.
- **Dashboard formatting and CI heap:** Marketing's reviewed formatting exception
  remains; the static CI job alone gains `NODE_OPTIONS: --max-old-space-size=4096`.
  This setting changes CI process capacity, not the production image environment.

## Limits before a future main deployment

Main `b78752d0` still lacks the dashboard topic until this candidate is merged.
After that merge, no known source-parity omission from the named production
revision remains in this reviewed scope. Pending audit remediations and stage
gates are separate: source parity does not repair the retained A0 material/gate,
exhausted-head history, stale exclusion-write or earnings-claim issues. It does
not certify current role/config receipts, live socket approval, measured savings,
or safe deployment of a later composed revision. Current-head CI, independent
review of subsequent changes and the owner's deployment gate still apply.

Candidate pins: CI workflow SHA-256
`3f8b9318fabb991f1ec5c37952c2dd1d24b35b6e1eb92c223c15d3b5b27b905f`;
decisions SHA-256
`6abb08975ba81c5b7b1f01ccbe7b5ff3d275df69571b5291f15f8d157894c112`.
