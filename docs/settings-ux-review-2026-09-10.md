# Settings UI/UX review — 2026-09-10

## Scope and approval

The owner requested simpler, friendlier settings and reviewed a local before/after
comparison, including a second copy/layout pass. Merge is authorized only after
independent engineering, quality and performance reviews approve the final
candidate and required checks pass. Deployment and production configuration
changes are separate actions. Local preview code, fixture state and screenshots
are review artifacts and are excluded from the product commit.

## Resulting behavior

- Settings use three navigation groups with desktop links and a mobile selector.
  Existing tab URLs, query parameters, default section and owner access remain.
- Configuration opens with live controls, searches metadata across the catalog,
  and offers subsystem/state filters. Russian titles, explanations and raw-value
  units sit beside aligned controls. Technical details remain available.
- Runtime, desired, unknown, pending and drift states remain distinct. Each boot
  flag has one row/anchor. Staged writes keep dependency order, acknowledgement
  and atomic dependent disable; operational prerequisites appear before approval.
- Drafts survive polling and filtering and retain the reviewed version. Conflicts
  require review. Blank strings and invalid numeric values match API validation.
  Reset removes an override and inherits the server setting.
- Receipts retain actual saved values/versions, including server clamps, across
  read failures. Another write waits for reconciliation. A later external change
  invalidates the earlier success message. A polling/filter change cannot hide an
  open staged confirmation.
- Onboarding discards stale verification responses after input changes. OnlyFans
  uses its supported username/OFAPI flow. Team load failures are explicit, account
  deactivation copy describes tombstones, and wide tables scroll locally.

## Evidence and limits

The initial draft was checked against revision `21e0ee33` with full `pnpm check`
(3130 unit tests passed, 9 skipped), 30 real live/staged API integration tests on
isolated PostgreSQL, and browser scenarios for polling, conflicts, write/read
failures, receipts, clamps, staged guards, keyboard focus and the actual app shell
at 1440/1280/1024/768/390/320px. The fixture uses the real scalar and staged
validators; it cannot call production. Root lint excludes dashboard source, so
changed dashboard files also receive an explicit ESLint run.

Pure-helper, SSR and mocked-hook unit tests are limited to their actual scope;
they do not establish React lifecycle or browser accessibility by themselves.
Browser checks provide separate interaction evidence. Final revision checks and
independent review outcomes belong in the pull request; the initial counts above
are historical evidence, not a claim about a later base revision.

## Independent engineering, quality and performance review

Three independent reviewers approved their respective scopes after inspection.
Engineering found no blocking architecture/state issue; dense JSX and test
formatting were improved. Root TypeScript cannot resolve dashboard-only
`react-router`, so the new navigation test uses the existing routing-test import
pattern; a public import was attempted and failed TS2307 under a fresh locked
install. No compiler budgets or lint rules were relaxed.

The quality reviewer reproduced a 20px gap in the modal overlay caused by the
parent's spacing utility. The shared shell now removes that margin. A visible
search fallback receives focus when polling has hidden the original trigger.
Both fixes were independently verified at desktop and mobile widths.

Performance used copied production builds, the real app shell and identical
161-item API fixtures. Search/filter interactions reached 15ms on normal CPU
and 65ms with CPU slowed fourfold; scalar edits reached 18ms. Median initial
ready times stayed within the observed run-to-run range. The lazy settings chunk
grew by 14.1KB gzip, global CSS by 1KB; ordinary config observers remained one
with the existing 30-second interval. These are localhost synthetic measurements,
not live API latency or physical mobile-device results. The final base adds two
registry entries with descriptions; no render or polling path changed afterward.

## Existing limitations outside this change

- Leaving Configuration for another settings section still drops unsaved drafts.
  Preservation in this change covers polling and filtering.
- Fansly credential replacement can remove stored route checks in the existing
  backend path. Credential recovery needs a separate contract fix.
- The config repository reuses version 1 after DELETE/INSERT, leaving an existing
  ABA race that frontend snapshot checks cannot close.
- The existing proxy tester omits stored authentication and can show a late result
  after address edits. OnlyFans Verify can succeed where Create rejects ambiguous
  or unverified identities.

These backend/shared limitations remain visible and were not claimed as repaired.
Future settings slices should audit each concrete workflow with before/after
review rather than treating this change as approval for a full platform redesign.
