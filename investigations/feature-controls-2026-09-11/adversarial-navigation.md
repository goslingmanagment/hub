# Adversarial review: authentication, navigation and daily pages

Reviewed independently on 2026-09-12: `c0cd21c3..d08d969c`, including both
`2f55b035` and `d08d969c`. The earlier page-review reports and test-result claims
were not used as evidence. This report records the original reviewed head, before
the follow-up fixes authorized by the coordinator.

Method: static control/data-flow comparison against the base, contracts, SDK
runtime, server handlers and repositories. Read `CLAUDE.md`, Decisions 286, 292,
294 and 295, `docs/error-handling.md`, and migration stages 20 and 27. No suite,
browser interaction, production read/write or configuration/branch operation was
performed for this review.

## Confirmed regressions

### NAV-1 — P2: PageDetail controls erase the return path to Overview

**Location:** `apps/dashboard/src/pages/PageDetailPage.tsx:130-136`, especially the
`setSearch` call without navigation state at line 136.

**Reproduction:**

1. Open an Overview URL with a non-default expanded row, chart and/or sort, for
   example `/?period=30d&row=<active-page>&chart=page:<active-page>&sort=decline`.
2. Open that page through its Overview link. `OverviewPage.tsx:415-418` transfers
   the full Overview URL in `state.backTo`; `PageSources.tsx` does the same.
3. Change the PageDetail tab, transaction type, transaction page or spender page.
4. Use the Overview breadcrumb.

**Effect:** the breadcrumb now points to `/`, so the expanded row, chart and sort
are lost. If the incoming period was owned only by its URL, the Overview period
also falls back to the persisted store. Scroll/focus restoration is keyed by the
exact Overview URL and cannot recover the original context from this new target.

**Proof:** the installed React Router `useSearchParams` delegates to
`navigate("?" + newSearchParams, navigateOptions)`; navigation sends
`options.state` to history. No state option means no retained `backTo`.
`Topbar.tsx:24-26` consequently resolves the fallback `/`. In the base, the same
controls changed local React state, leaving the existing router state intact.

**Other URL writers checked:** new Followers, DeletedFans and SpenderAutoList
writers also omit state, but their current incoming product links do not carry a
router-state `backTo`, so no separate newly broken product path was established.
Their existing query parameters survive cloning. Subscribers and TopSupporters
already omitted state in the base. Overview subscriber quicklinks carry `backTo`
in the query string, and it survives their filtering/pagination.

### NAV-2 — P3: AutoList rows lose their existing open-fan action

**Location:** `apps/dashboard/src/pages/SpenderAutoListPage.tsx:153-160`.

**Reproduction:** open a populated spender auto-list and click a row's status,
gross amount, net amount or date, outside the fan-name link.

**Effect:** nothing opens. Previously any such click opened the fan profile.
The new name link remains usable and preserves the period, so this does not
remove access to the profile or lose stored records. It does remove an existing
navigation action from the rest of the row.

**Proof:** the base row had `onClick={() => navigate(fanNavigation.to,
{ state: fanNavigation.state })}`. The head deletes it and only the name has a
`Link`. Other daily tables retain their row action when adding a name control.

## Invariants actually inspected

| Surface | Checks and result at the reviewed head |
| --- | --- |
| Authentication/session | SDK retains cookie authentication and redirects only non-login 401 responses. Safe return paths preserve path/query/hash and reject external, protocol-relative, backslash/control paths and login loops. Non-401 session-check failure has a read retry. The shell hook is disabled until authenticated data exists. |
| Catalog and roles | `/pages` and `/overview` both use `pageScopeFor` and `listVisiblePages`: owner scope is unrestricted, assigned users have an explicit ID list, empty assignment cannot broaden scope, and navigation includes active pages only. Optional voice capability enrichment catches its own failures. Only shell identity fields changed; backend scope checks still apply to daily reads. |
| Overview | The two changed page links now pass their current URL period; report totals, source calculation, exact transaction drilldowns and server clock reuse are unchanged. `state.backTo` is present when entering PageDetail, which is why NAV-1 is reachable. Historical/deleted revenue pages still use transaction drilldowns rather than active-only PageDetail links. |
| Transactions | Only state-label presentation changed. Exact scope parsing, response-scope matching, `[from,to)` bounds, server summary and paginated rows stay intact. Unknown state labels fall back to their actual value. |
| PageDetail | Identity comes from `/pages`; sync evidence is a separate `/overview` response. Primary/secondary reads remain separately keyed. No response is hidden as zero/empty by the new ReadSection wrapper. Same-key stale data is retained with a failed-refresh notice. URL period is used by revenue and spender reads; `all` maps to spender `lifetime`. Period selection clears `spendersOffset`, leaves all-history `txOffset` and preserves router state. NAV-1 remains in the other controls. |
| Subscribers | Filters and URLs were already owned by the router. Known expiry and explicit `autoRenew=false` predicates are preserved. Full list query survives fan navigation. The new empty-offset recovery and future-timestamp guard do not change the API filters or cents formatter. |
| Followers | URL filter/search/offset map to the same query inputs as before. SDK omits undefined values, so conditional property spreading preserves request semantics. Backend `dmStatus=none` tests missing conversation ID; Active uses the 120-minute external-presence signal. Unknown enrichment remains distinct from a known false/zero value. List context is passed to fan navigation. |
| DeletedFans | Only list navigation, read-failure presentation and copy change. The audit endpoint, aliases, detected/confirmed timestamps and pagination request stay intact. A failed read has a retry and cannot render a successful empty audit. No deletion action was added. |
| SpenderAutoList | URL period/filter/search/offset reach the existing endpoint; `all` maps to `lifetime`. Gross and creator-net remain distinct server fields in mills. Fan links carry the current period and complete return query. NAV-2 removes only the non-link row action. |
| TopSupporters | URL period wins over the separate historical TopSupporters store. Page/filter/search/sort/offset stay in the query key and return target. Missing window metrics now render unavailable rather than zero. Per-fan batch presence and complete breakdown checks prevent a successful partial batch from marking all rows complete. Existing visible-row sums remain visible-row sums, not agency totals. |
| FanProfile | Detail, spender metrics, transactions, latest profile, historical profile and versions retain independent reads and error states. `all` maps to `lifetime`; the selected period reaches spenderDetail. Transaction history and the separate 10-row timeline remain all-history. A successful `{profile:null}` is different from a failed profile request. Period changes preserve the parent navigation state. |
| Workboard reads/navigation | Queue/list keys retain page scope; their active errors and stale-data notices remain separate. Route/page changes reset focused/expanded rows and offset. Keyboard traversal only includes visible rows and does not intercept controls, modified shortcuts or dialogs. Lists mode tolerates unavailable browser storage. Mutation correctness is delegated to the separate reviewer. |

The money check follows the actual fields, not merely the absence of backend
changes: PageDetail and FanProfile display net earnings/creator net through the
mills formatter; AutoList retains gross alongside net; Followers/Subscribers
retain their existing cents conversion. Server contracts require the displayed
money fields, while nullable spender windows are handled as unavailable.

## Existing limitations and unverified boundaries

- A chatter can hold a cookie session. `/overview` still rejects that role,
  whereas `/pages` and the existing page-scoped daily contracts admit it. The new
  shell therefore exposes its assigned navigation; there is no demonstrated
  widening beyond the API's existing grants. This is not proof that every
  chatter-facing screen is a supported, complete workflow.
- `main.tsx:15-16` still prefetches the catalog before authentication on a direct
  `/analytics` load. This is an existing exception to the new shell-hook gate,
  not a new regression or a reason to claim that no catalog request can ever
  precede authentication.
- Router-state-only fan return targets are not encoded in a copied/new-tab URL.
  Nested Overview state is not restored by `navigate(backTo)` after a fan round
  trip. Those limitations also existed in the base; NAV-1 is the additional
  loss caused by ordinary PageDetail controls without leaving the page.
- No browser rendering, real focus/scroll behavior, network timing, concurrent
  interaction, SQL fixture run or server deployment was exercised. The findings
  are deterministic code-path proofs, not recorded browser executions.
- Production capture completeness, data freshness and historical financial
  reconciliation were not measured. Existing server semantics and nullable
  contract fields were checked; a successful screen does not certify capture.
- The new copied-data notices do not independently certify freshness. Existing
  TopSupporters popover reads and Workboard's local tab/band state are not made
  URL durable by these commits.

No P0/P1 data-loss or permission-bypass regression was established in this
bounded review. That is a statement about the inspected paths, not a claim that
all runtime behavior or persisted data has been verified.

## Authorized follow-up

The coordinator subsequently authorized the bounded corrections:

- PageDetail, Followers, DeletedFans and SpenderAutoList now pass the current
  router state when updating their URL. The filter and offset rules stay intact.
- An ordinary primary-button click on a non-interactive AutoList cell again
  opens the fan with the same period and return state as the name link. Native
  links, other controls, modified clicks and already-handled clicks keep their
  own behavior and cannot produce a duplicate row navigation.
- `tests/adversarial-navigation.test.ts` adds 19 cases that invoke actual page
  event callbacks with isolated transport/router hooks. It covers return state,
  filter/offset preservation and the row/link interaction boundary.

`git diff --check`, ESLint for the new test and a separate `--no-ignore` ESLint
pass for all four modified frontend files pass. The test suite has not been run
by this reviewer; execution and integration verification belong to the
coordinator. No production, configuration, branch or backend change was made.
