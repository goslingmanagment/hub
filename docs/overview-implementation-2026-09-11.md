# Overview implementation — 2026-09-11

Status: implemented and locally verified in branch `codex/overview-ux`, worktree
`/Users/dmitriy/.codex/worktrees/hub-overview-ux-20260910/hub`. The main checkout
was not used for implementation. The owner authorized merge on September 11;
the exact merge receipt is recorded in Git/PR history. Deployment and production
mutation remain separate. This record supersedes the earlier UI proposal in
[the September 10 review](overview-ux-review-2026-09-10.md); that file retains
the original metric research and dated data evidence. Decision #292 records the
final architecture.

## Delivered behavior

- The accepted compact variant-one table is now the actual typed dashboard SPA.
  Models stay in descending creator-net order. Page changes can be sorted inside
  each group; historical/deleted revenue remains represented.
- Expanded sources show current/prior/change, including a type present only in
  the prior window, refunds and unclassified records. All monetary arithmetic
  is performed by the reporting service, with generated SDK contracts.
- Each page/source amount opens `/transactions` for its exact platform window.
  Source/state filters and pagination retain that scope. Full-filter total,
  count and rows use one DB snapshot per response; a response without the echoed
  scope is unavailable instead of being treated as a reconciliation result.
- URL state retains period, expanded page, chart, sorting and subscriber filters.
  Explicit return links, Back and reload restore Overview scroll/focus, including
  delayed source/chart responses. Only UI position is written to session storage.
- Expiring-within-seven-days and explicit auto-renew-off links open the existing
  current Subscriber registry filters. Search/pagination and FanProfile backTo
  preserve the full list context. Unknown metadata is not treated as a negative
  flag or a known zero count.
- One entry clock fixes cross-platform/model midnight drift. Manual refresh and
  UTC rollover update the main report clock. Pending, adjustments, unfinished
  days and differing platform windows remain visible in the metric explanation.

## Code boundaries

Contracts: `packages/contracts/src/routes.ts`; regenerated hash, SDK metadata
and OpenAPI. Reporting math: `apps/runtime/src/services/reporting.ts`. Request
clock and authorized routes: `apps/runtime/src/modules/finance/index.ts`.
Scoped transaction snapshot: `packages/db/src/repositories/reporting.ts`.

UI composition: `apps/dashboard/src/pages/OverviewPage.tsx` and `pages/overview/`.
Pure URL/scope helpers: `lib/overviewNavigation.ts`, `lib/transactionNavigation.ts`.
Shared formatting and error notices: `lib/revenueDisplay.ts`,
`components/shared/QueryNotice.tsx`. New SDK query/view:
`api/transactions.ts`, `pages/TransactionsPage.tsx`. Existing Subscribers,
Topbar, PeriodSelector and mobile ProtectedLayout are adapted without a new
dashboard framework. Existing TrendSparkline negative/single-point fixes remain.

## Validation evidence

All logs below are under ignored `artifacts/overview-ux/` and contain local test
results, not a production deployment receipt.

- `implementation-check.log`: full `pnpm check` passed — 294 files, 3,220 unit
  tests passed / 9 skipped, lint and dashboard build passed. Root typecheck uses
  the repository strictness ratchet: 1,901 pre-existing diagnostics across 121
  files remain within the reduced budget. Dashboard `tsc -b` passes.
- `implementation-tests-final.log`: 45 tests in four files passed after final
  navigation/mobile changes. Verbose evidence includes all three transaction
  integration cases: exact edges/reportable predicates/full-filter pagination;
  deleted/empty/foreign scope; and a real concurrent insert between aggregate
  and item reads. Two new calendar-gap cases supplement the full-suite run.
- `implementation-typecheck-final.log`, `implementation-build-final.log`:
  successful final ratchet and dashboard build. Existing chunk-size and mixed
  import build warnings remain. Targeted dashboard ESLint with `--no-ignore`
  passed; this is separate because root lint excludes the dashboard.
- A final notice-copy/unused-wrapper cleanup is separately checked in
  `implementation-polish-check.log`.
- `implementation-review.md`: the separate reviewer checked contracts, money,
  access control, snapshot consistency, query isolation, restoration lifecycle,
  shared error styling and responsive fixes. R1–R10 are resolved in source; no
  open P1/P2 finding remains. The reviewer did not run competing Vitest suites.

Browser checks, using the actual SPA and generated SDK with controlled local
responses:

- Lora-3 paid messages for the selected seven-day window: $216.79 opens exactly
  five matching operations. Explicit return restores the expanded row and
  `source-current-3-message_purchase` focus.
- Cold reload with 1.8-second delayed detail/chart responses restores graph
  focus and scroll at 619.5 px after layout settles.
- Subscriber synthetic QA registry is explicitly TEST ONLY: three records,
  one known expiring/off record, unknown values excluded from narrow filters;
  filter changes and dashboard backTo survive navigation. These rows are never
  served in the normal user preview.
- An older API response without applied scope/summary is rejected by the view.
  A failed refresh retains eight previously loaded page rows with visible
  warnings. Switching 7D to 30D while the report fails renders no old-period
  rows. Restoring the server then loads eight rows and $22,701.17 for 30D.
- At 390 px, expanded table has three visible columns and no document overflow;
  at 970 px it has four. Responsive colSpan prevents phantom empty columns.
  Mobile navigation contains focus; Escape restores the trigger and body scroll.

## Preview and remaining boundary

Keep `http://localhost:5190/` running via
`node --import tsx/esm artifacts/overview-ux/preview-server.mts`. The old
`/variants/one/` path redirects to the implemented SPA. Normal preview data is
the recorded transaction slice ending September 10 at 19:45 UTC and separately
recorded audience/sync at 23:23 UTC. A fixed banner identifies it as non-live.
Today/7D/30D and transaction drilldowns are supported by this finite fixture;
all-time and current subscriber registries require the real backend. No live
coverage contract or hardcoded page capture floor was introduced into product
code. An unavailable registry is shown as unavailable, never fabricated.

The temporary 5194 QA proxy and its tab are closed at task completion; the
normal 5190 preview remains. `windowAt` aligns calendar bounds only. Different
HTTP requests can observe new ingest; transaction count/net/items are atomic
within their own response. Production rollout remains a separate owner action.

## Integration with current main

Before opening the merge PR, integrate `origin/main` at `32478124`, preserving
the C2b earnings shadow and Ping name-context changes. The financial source
changes remain intact; the independent optional `fanCustomName` field is kept.
Resolve generated hash/metadata by running `pnpm contracts:generate` over the
combined contract, not by choosing a previous generated artifact. Both decision
histories are retained. The unpublished Overview decisions are renumbered from
287/288 to 291/292 because the earlier numbers are reserved by the open C1/W0
changes. Recheck the integrated source with the independent reviewer and local
`pnpm check` (`artifacts/overview-ux/merge-check.log`), then require the repository's
GitHub `Quality Gate` before squash merge. This integration does not deploy.
