> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 16 — Dashboard Frontend (API consumer)

Scope: this document covers the React single-page app in `apps/dashboard/`. Files read in full or in the relevant part: `apps/dashboard/package.json`, `apps/dashboard/vite.config.ts`, `apps/dashboard/index.html`, `apps/dashboard/tsconfig.json`; `apps/dashboard/src/main.tsx`, `apps/dashboard/src/App.tsx`; the API client layer `apps/dashboard/src/api/*.ts` (`client.ts`, `utils.ts`, `queries.ts` barrel, `auth.ts`, `overview.ts`, `pages.ts`, `workboard.ts`, `conversations.ts`, `dev.ts`, `adminConfig.ts`, `adminNotifications.ts`, `adminOfapiCredits.ts`, `adminPages.ts`, `adminSync.ts`, `adminUsage.ts`, `adminUsers.ts`); `apps/dashboard/src/lib/*` (`queryClient.ts`, `navigation.ts`, `path.ts`, `platformUrls.ts`, `constants.ts`); `apps/dashboard/src/stores/*` (`periodStore.ts`, `spenderPeriodStore.ts`); the layout components `apps/dashboard/src/components/layout/*`; all pages under `apps/dashboard/src/pages/**`; and the shared/AI/workboard components under `apps/dashboard/src/components/**` that issue API calls. For how the built SPA is served, `apps/runtime/src/api/server.ts:329-345` and `:3569-3580` are cross-read. The dashboard is a pure HTTP-API consumer: it holds no business logic beyond presentation and issues only same-origin requests to the core API described in territories `02-http-api-surface.md` and `03-contracts-and-codegen.md`.

---

## 1. Stack, build, and how the SPA is served

- **Package**: `@agency_hub_core/dashboard` (`apps/dashboard/package.json`), `type: module`, private. React 19, `react-router` 7, `@tanstack/react-query` 5, `zustand` 5 (with `persist`), `recharts` 3, `lucide-react`, `react-markdown`, `sonner` (toasts). Tailwind CSS 4 via `@tailwindcss/vite`. Vite 6 + `@vitejs/plugin-react`.
- **Scripts**: `dev` = `vite`; `build` = `tsc -b && vite build`; `preview` = `vite preview`.
- **Vite config** (`vite.config.ts`): dev server on port 5173. Path aliases: `@` → `src`, `@agency_hub_core/shared` → `../../packages/shared/src/browser.ts` (browser-safe shared entry), `@agency_hub_core/contracts` → `../../packages/contracts/src/index.ts` (the source of all response/body types the dashboard imports). Dev proxy forwards `/api` and `/documentation` to `process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000"`. This is the only place `VITE_API_PROXY_TARGET` is used; it exists purely so `vite dev` can reach a locally-running API server.
- **HTML shell** (`index.html`): mounts `#root`, loads `/src/main.tsx`, sets title "AgencyHub", pulls Inter from Google Fonts (external, dev/HTML-level only — not subject to the app's own CSP).
- **Production serving** (outside this territory but the counterpart of every request): the Fastify API server serves the built SPA. `apps/runtime/src/api/server.ts:329` `resolveDashboardDistPath()` searches ancestor dirs for `apps/dashboard/dist/index.html`; when found (`:3570`) it registers `@fastify/static` with `root: dist, prefix: "/", wildcard: false` and a `setNotFoundHandler` that returns `index.html` for any path not starting with `/api/` or `/documentation` (`:3574-3577`), i.e. client-side routes fall through to the SPA. So in production the dashboard and API are same-origin, which is what makes the cookie-based auth below work without CORS.

## 2. Bootstrap

`main.tsx` renders (in order): `QueryClientProvider` (the shared `queryClient`) → `BrowserRouter` → `App` + a `sonner` `<Toaster position="top-right" richColors />`. Global CSS `./globals.css`. No providers beyond React Query, Router, and Toaster; cross-cutting page data flows through `DashboardShellContext` (§6) and the two zustand stores (§8).

## 3. Routing map

`App.tsx` defines all routes with `react-router`. Pages are `lazy()`-imported (code-split) and wrapped in a top-level `<ErrorBoundary>` + `<Suspense>`. Two guard layers: `ProtectedLayout` (requires any authenticated user) and `OwnerRoute` (requires `role === "owner"`).

| Path | Page component | Guard | Owner-only |
|---|---|---|---|
| `/login` | `LoginPage` | none | no |
| `/` (index) | `OverviewPage` | ProtectedLayout | no |
| `/pages/:pageLabel` | `PageDetailPage` | ProtectedLayout | no |
| `/pages/:pageLabel/spender-autolists/:bucketKey` | `SpenderAutoListPage` | ProtectedLayout | no |
| `/pages/:pageLabel/deleted-fans` | `DeletedFansPage` | ProtectedLayout | no |
| `/pages/:pageLabel/subscribers` | `SubscribersPage` | ProtectedLayout | no |
| `/pages/:pageLabel/followers` | `FollowersPage` | ProtectedLayout | no |
| `/pages/:pageLabel/top-supporters` | `TopSupportersPage` | ProtectedLayout | no |
| `/pages/:pageLabel/workboard` | `WorkboardPage` (v1) | ProtectedLayout | no |
| `/pages/:pageLabel/workboard/v2` | `WorkboardV2Page` | ProtectedLayout | no |
| `/pages/:pageLabel/crm` | `LegacyWorkboardRedirect` → `resolveLegacyWorkboardRedirect` | ProtectedLayout | no |
| `/pages/:pageLabel/fans/:platform/:platformUserId` | `FanProfilePage` | ProtectedLayout | no |
| `/usage` | `UsagePage` | ProtectedLayout + **OwnerRoute** | **yes** |
| `/ofapi-credits` | `OfapiCreditsPage` | ProtectedLayout + **OwnerRoute** | **yes** |
| `/ai-analytics` | `AiAnalyticsPage` | ProtectedLayout + **OwnerRoute** | **yes** |
| `/notifications` | `NotificationsPage` | ProtectedLayout + **OwnerRoute** | **yes** |
| `/settings` | `SettingsPage` | ProtectedLayout + **OwnerRoute** | **yes** |
| `/dev/log` | `LogPage` | ProtectedLayout + **OwnerRoute** | **yes** |
| `/dev/queue` | `QueuePage` | ProtectedLayout + **OwnerRoute** | **yes** |
| `/dev/db-stats` | `DbStatsPage` | ProtectedLayout + **OwnerRoute** | **yes** |
| `/dev/incidents` | `IncidentsPage` | ProtectedLayout + **OwnerRoute** | **yes** |
| `/dev/sync-status` | `SyncStatusPage` | ProtectedLayout + **OwnerRoute** | **yes** |
| `*` | `Navigate to="/"` | — | — |

Notes:
- `SyncStatusPage` has a route but no sidebar link; it is reached via `/dev/sync-status?runId=<n>`, linked from `EventDetailPanel.tsx:93` (used by the Log/Incidents dev pages).
- `LegacyWorkboardRedirect` reads `:pageLabel` and `<Navigate replace>` to `buildWorkboardRoute(pageLabel)` (or `/` when absent) — `navigation.ts:55`.
- Guard order is client-side only; `OwnerRoute` renders `<Navigate to="/" replace>` for non-owners (`OwnerRoute.tsx:16`). Actual authorization is enforced server-side; these guards only shape the UI.

## 4. Auth & session model (the auth boundary, consumer side)

- **Session transport**: cookie only. Every request goes through `request()` in `api/client.ts:33` with `credentials: "include"` and no auth header. There is no token in JS, no `Authorization` header, no CSRF header. The session cookie is set/cleared by the API (territory 02). Same-origin in production (§1) makes the cookie flow automatically.
- **`useAuthMe`** (`api/auth.ts:5`) → `GET /api/v1/auth/me` → `AuthState` (`{ user: { username, role } }`). Query key `["auth","me"]`, `retry:false`.
- **`ProtectedLayout`** (`components/layout/ProtectedLayout.tsx`): calls `useAuthMe`; while loading shows a spinner; on error or no data `<Navigate to="/login" replace>`; otherwise renders the shell (`Sidebar`, `Topbar`, `<Outlet/>`) and provides `DashboardShellContext`. It also calls `useOverview()` here to populate the page catalog for the whole shell.
- **`LoginPage`** (`pages/LoginPage.tsx`): if already authenticated redirects to `/`; posts `{username, password}` via `useLogin` → `POST /api/v1/auth/login`; on success `navigate("/")`, on error a `toast.error`. Login errors are suppressed from the global toast handler (mutation `meta.suppressGlobalError:true`, `auth.ts:16`) so the page shows its own toast.
- **401 handling**: `client.ts:16-31,49-51` — on any non-`/api/v1/auth/login` request returning 401, `redirectToLogin()` calls `clearDashboardSession()` (clears the whole React Query cache, `lib/queryClient.ts:55`) and hard-navigates `window.location.assign("/login")` (unless already on `/login`). The global query/mutation error handler additionally swallows 401s so no toast fires (`queryClient.ts:31`).
- **Logout**: `Topbar.handleLogout` (`Topbar.tsx:39`) awaits `useLogout` → `POST /api/v1/auth/logout`, then `clearDashboardSession()` + `window.location.assign("/login")` regardless of outcome.

## 5. API client layer

`api/client.ts` is the single fetch wrapper.
- `request<T>(method, url, body?)`: `fetch(url, { method, credentials:"include", headers: body? {"Content-Type":"application/json"} : undefined, body: JSON.stringify(body) })`. On `!res.ok` it JSON-parses the error body (falling back to `{message: statusText}`), triggers the 401 redirect when applicable, and throws `ApiError(status, body)`. `ApiError.message` is `body.message` when present else `HTTP <status>`. `204` returns `undefined`; otherwise `res.json()`.
- Exported `api` object: `get/post/patch/put/del` (`client.ts:60-66`). All URLs are **relative** (`/api/v1/...`, `/api/v2/...`) so they resolve against the app origin. There is no base-URL constant in the client.
- **Types**: all response and request-body shapes are imported as `type` from `@agency_hub_core/contracts` (the Zod-derived contract types, territory 03). The client itself is untyped at the wire; each hook parameterizes `api.get<T>()` with the contract type — i.e. the dashboard trusts the contract types and does **not** re-validate responses at runtime.
- **URL param encoding**: `lib/path.ts` `pathSegment(v) = encodeURIComponent(String(v))` is used for every dynamic path segment (page labels, platform, platformUserId, slugs, bucket keys). Query strings are built by `api/utils.ts` `qs(params)` which skips `undefined`, appends arrays as repeated keys, and prefixes `?`.
- **`lib/queryClient.ts`**: single `QueryClient`. Defaults `queries: { retry:false, staleTime:30_000, refetchOnWindowFocus:false }`. A `QueryCache`/`MutationCache` `onError` calls `handleGlobalError`, which (a) no-ops when `meta.suppressGlobalError` is set, (b) no-ops on `status === 401`, (c) otherwise `toast.error(error.message ?? "Request failed")`. Mutations that render their own errors set `meta.suppressGlobalError:true`. Register augmentation declares `mutationMeta`/`queryMeta` with the `suppressGlobalError?` flag.
- **React Query usage pattern**: read hooks are `useQuery` keyed by a stable array (endpoint id + params); writes are `useMutation` that on success/settled `invalidateQueries` the relevant key prefixes (prefix matching drives cross-view refresh — e.g. workboard v2 mutations invalidate `["workboard-v2", pageLabel]`). Several list hooks use `placeholderData: (prev)=>prev` to avoid flicker while paging/polling.

## 6. Shell context and navigation

- **`DashboardShellContext`** (`components/layout/DashboardShellContext.tsx`): provides `{ pageCatalogState: "loading"|"ready"|"error", pageCatalogError, pages: OverviewResponse["pages"], findPageByLabel(label) }`. Populated once in `ProtectedLayout` from `useOverview()`. Every page uses this instead of refetching the catalog: `PageDetailPage`, `WorkboardPage`, `Sidebar`, `Topbar`, `AiAnalyticsPage` all read `pages`/`findPageByLabel`. `useDashboardShell()` throws if used outside the provider.
- **`Sidebar`** (`components/layout/Sidebar.tsx`): builds the model→pages tree from `pages`; each page links to `/pages/:label`; when active, expands sub-links Subscribers, (Fansly-only) Followers, Top Supporters, Deleted Fans, (Fansly-only) Workboard + Workboard v2. Owner-only bottom section: a collapsible **Dev** group (Log, Queue, DB Stats, Incidents), plus Usage, OFAPI Credits, "ИИ-аналитика" (AI Analytics), Notifications, Settings. The Settings icon shows a warning dot when `useAdminConnections({enabled: role==="owner"})` returns any connection whose `syncUx` is an alert state (`isAlertState`, `constants`/`syncUxDisplay`). The AI Analytics link is pre-scoped to the active/most-recent Fansly page (`buildAiAnalyticsRoute`). Several labels are Russian.
- **`Topbar`** (`components/layout/Topbar.tsx`): breadcrumbs derived purely from `location.pathname` (+ router `state` for fan labels), a period `PeriodSelector` shown for dashboard/spender/topSupporters contexts (`getPeriodSelectorMode`), and a user menu with logout. Fan-profile breadcrumb label prefers `location.state.fanLabel` (`resolveFanLabelFromState`).
- **`lib/navigation.ts`**: URL builders (`buildPageRoute`, `buildPageSectionRoute`, `buildWorkboardRoute`, `buildWorkboardV2Route`, `buildAiAnalyticsRoute`, `buildPageSpenderAutoListRoute`, `buildFanProfileRoute`/`buildFanProfileNavigation`, `buildSettingsRoute`), settings-tab resolution (`resolveSettingsTab`, default `"credentials"`), and `resolveFanProfileBackTarget` which only trusts an in-app path (`startsWith("/") && !startsWith("//")`) from router state, else falls back to the page route.
- **`lib/platformUrls.ts`**: builds external deep links to `onlyfans.com`/`fansly.com` profile and chat URLs (used by the Top Supporters "copy link" button, `TopSupportersPage.tsx:288`). These are strings copied to the clipboard, not requests the dashboard issues.

## 7. State stores (client-persisted)

Two `zustand` `persist` stores, both persisted to `localStorage`:
- **`stores/periodStore.ts`** — key `agencyhub-period`, version 3. `period: "today"|"7d"|"30d"|"all"` (default `7d`). Drives Overview and PageDetail period selection. `migratePeriodState` downgrades a persisted `30d` from older versions to the default.
- **`stores/spenderPeriodStore.ts`** — key `agencyhub-spender-period`, version 2. `period` (default `7d`) and `topSupportersPeriod` (default `all`), each `"today"|"7d"|"30d"|"90d"|"180d"|"all"`. Drives spender/auto-list/fan-profile and Top Supporters period. Pages map `"all"` → the API's `"lifetime"` period value.
- Additional client-only persistence: `WorkboardV2Page` stores its queue-vs-lists mode toggle under `localStorage["wb-v2-lists"]` (`WorkboardV2Page.tsx:32,69`). No other component uses storage directly.

## 8. Pages → endpoints they consume

Every entry is a same-origin HTTP call to the core API. Method + path shown; the request/response types are the named `@agency_hub_core/contracts` types.

**`OverviewPage`** (`pages/OverviewPage.tsx`): `useOverview` `GET /api/v1/overview`; `useOverviewRevenue` `GET /api/v1/overview/revenue?period`; `useOverviewRevenueDaily` `GET /api/v1/overview/revenue/daily?period`; `useOverviewGrowth` `GET /api/v1/overview/growth?period`; `useAuthMe`. Renders a per-model page table (revenue in mills via `formatUsdFromMills`, subs, new followers/subs, per-page `syncUx` exception banners linking owners to Settings→sync) and an agency revenue daily chart. `describeMixedRevenueWindows` discloses OnlyFans vs other-platform trailing-window width differences from `revenueData.platformWindows`.

**`PageDetailPage`** (`pages/PageDetailPage.tsx`): gated on `pageCatalogState==="ready"` + page found. `usePageRevenue`, `usePageRevenueDaily`, `usePageFollowersDaily` (Fansly only), `usePageSubscribersDaily`, `usePageSubscribers` (limit 6 preview), `usePageSpenderAutoLists`, `usePageTransactions` (paged, type filter), `useSpenders` (`scope:"page"`, sorted by `creatorNetAmountMills`). Tabs: Transactions / Spenders / (Fansly) Followers. Opens fan profiles with back-target state.

**`SubscribersPage`** (`pages/SubscribersPage.tsx`): `usePageSubscribers` `GET /api/v1/pages/:label/subscribers?limit,offset,query,expiringWithinDays,startedWithinHours,autoRenew`. Also fires three `limit:1` count queries for filter badges (expiring≤7d, new24h, auto-renew off).

**`FollowersPage`** (`pages/FollowersPage.tsx`): `usePageFollowers` `GET /api/v1/pages/:label/followers?limit,offset,query,followedWithinHours,subscriber,dmStatus,activeWithinMinutes`. Detects the older follower-list shape (missing `isSubscriber`/`totalSpentCents`/`dm`/`presence`) and disables enrichment filters with a notice.

**`SpenderAutoListPage`** (`pages/SpenderAutoListPage.tsx`): `usePageSpenderAutoList` `GET /api/v1/pages/:label/spender-autolists/:bucketKey?limit,offset,query,excludeNonFollowers,period`.

**`DeletedFansPage`** (`pages/DeletedFansPage.tsx`): `usePageDeletedFans` `GET /api/v1/pages/:label/deleted-fans?limit,offset`.

**`TopSupportersPage`** (`pages/TopSupportersPage.tsx`): `useSpenders` (`scope:"page"`, period from `topSupportersPeriod`, retention filter, sortBy `creatorNetAmountMills`|`lastTransactionAt`); `useSpenderBatch` `POST /api/v2/spenders:batch` (enriches visible rows with type-breakdown + subscription). All filter/sort/paging state lives in the URL query string. Row detail modals: `ChatPreviewPanel` → `usePageConversationPreview`, `TransactionsPreviewPanel` → `usePageFanTransactions`, `SpenderTrendPanel` → `useSpenderSeries`.

**`FanProfilePage`** (`pages/FanProfilePage.tsx`): `usePageFanDetail` `GET /api/v1/pages/:label/fans/:platformUserId`; `usePageFanProfile` `.../profile`; `usePageFanProfileVersions` `.../profile/versions` (lazy on history open); `usePageFanProfileVersion` `.../profile/versions/:version`; `useSpenderDetail` `GET /api/v2/spenders/:platform/:platformUserId?scope,pageLabel,period`; `usePageFanTransactions` (two calls: paged table + fixed 10-row timeline); `useCreateFanNote` `POST .../fans/:platformUserId/notes {body}`. "Fan Intelligence" renders the ChatMuse profile markdown and version history.

**`WorkboardPage`** (v1, `pages/WorkboardPage.tsx`): `useWorkboard` `GET /api/v1/pages/:label/workboard`; `useWorkboardPresence` `.../workboard/presence` (lazy on panel open); `useWorkboardSnooze` `POST .../workboard/snooze {fanId,days}`; `useWorkboardUnsnooze` `DELETE .../workboard/snooze/:fanId`. Fansly-only (redirects non-Fansly pages). Tabs Подписчики / Активные спендеры / Все спендеры, card + compact views, priority lanes. UI copy is Russian. View models built in `pages/workboard/viewModel.ts`.

**`WorkboardV2Page`** (`pages/WorkboardV2Page.tsx`): `useWorkboardV2` `GET .../workboard/v2?tab,status,limit=100,offset`; `useWorkboardV2Lists` `.../workboard/v2/lists` (spend-band view, enabled only in lists mode); `useWorkboardV2Contact` `POST .../workboard/v2/contact {fanId,action:"opened"|"handled"|"snoozed",wasProductive}`; `useWorkboardV2Recompute` `POST .../workboard/v2/recompute`; `useWorkboardV2Snooze` `POST .../workboard/v2/snooze`; `useWorkboardV2Unsnooze` `DELETE .../workboard/v2/snooze/:fanId`; `useWorkboardV2UndoContact` `DELETE .../workboard/v2/contact/:fanId`. Keyboard triage (j/k/e/s/Enter). Rows (`components/page/workboard/v2/WorkboardV2Row.tsx`) can expand a chat preview via `usePageConversationPreview`. Links to AI Analytics when `data.aiCoverage` present.

**`AiAnalyticsPage`** (owner, `pages/AiAnalyticsPage.tsx`): page selector over Fansly pages; `useWorkboardV2AiRuns` `GET /api/v1/workboard/ai/runs` (polls 2.5s while any run is `running`, else 15s). Renders `AiPageDashboard` + `AiRunLog`.
- `components/ai/AiPageDashboard.tsx`: `useWorkboardV2Ai` `GET .../workboard/v2/ai`; `useWorkboardV2AiClassify` `POST .../workboard/v2/ai/classify {reclassify?}`; `useWorkboardV2AiSettings` `PUT .../workboard/v2/ai/settings` (`WorkboardV2AiSettingsBody`). Shows the Haiku reply-detector state distribution, spend, and controls.

**`UsagePage`** (owner, `pages/UsagePage.tsx`): `useAdminChatterUsage` `GET /api/v1/admin/usage/chatters?from,to`. Day/week/month navigator over Moscow business dates (`toBusinessDate`, `MOSCOW_TIME_ZONE` from shared). Renders per-chatter AI usage: per-feature request counts, token counts (input/output/cache), micro-USD cost (`microUsd/1e6`), regenerate rate, and per-provider gateway breakdown.

**`OfapiCreditsPage`** (owner, `pages/OfapiCreditsPage.tsx`; currently modified in the working tree): `useAdminOfapiCreditsSummary` `GET /api/v1/admin/ofapi/credits/summary` (polls 60s); `useAdminOfapiCreditsDaily` `GET /api/v1/admin/ofapi/credits/daily?days` (two instances: 30-day charts + configurable breakdown); `useAdminOfapiCreditsLedger` `GET /api/v1/admin/ofapi/credits/ledger?offset,limit,source,pageId,operation,from,to`; `useAdminOfapiSpendComparison` `GET /api/v1/admin/ofapi/spend/comparison?days=7,sampleLimit=25` (lazy, on "Projection accuracy" open); `downloadOfapiCreditsLedgerCsv` (raw fetch, §11). Hero card Balance→Runway→Refill, today's spend by source, per-stream budget meters, a Recharts balance area chart + stacked-bar spend chart, a paginated/filterable credit ledger, and a collapsible System Health section. Credits are the OFAPI unit (integer), displayed alongside USD estimates derived from `summary.pricing.microUsdPerCredit`; the page also shows mills money via `formatUsdFromMills`. Many `ConfigLink`s deep-link to `/settings?tab=configuration#config-<key>`. All copy is Russian; all timestamps labeled UTC.

**`NotificationsPage`** (owner, `pages/NotificationsPage.tsx` + `pages/notifications/*`): tabbed.
- Settings tab (`NotificationsSettingsTab.tsx`): `useNotificationsSettings` `GET /api/v1/admin/notifications/settings`; `useUpdateNotificationsSettings` `PATCH .../settings`; `useSendTestMessage` `POST .../test`; `useDiscoverTelegramChats` `POST .../discover-chats`.
- Incidents tab (`NotificationsIncidentsTab.tsx`): `useNotificationIncidents` `GET .../incidents?status,kind,pageLabel,limit,offset` (polls 30s); `useResolveIncident` `POST .../incidents/:id/resolve`.
- Reports tab (`NotificationsReportsTab.tsx`): `useReportPreview` `GET .../reports/preview` (manual, `enabled:false`); `useSendReport` `POST .../reports/send`; `useReportHistory` `GET .../reports/history`.

**`SettingsPage`** (owner, `pages/SettingsPage.tsx` + `pages/settings/*`): tab in `?tab=` query. Tabs:
- **Credentials** (`CredentialsTab.tsx`): `useAdminConnections` `GET /api/v1/admin/connections`; `CredentialsModal` → `useAdminUpdateCredentials` `PATCH /api/v1/admin/pages/:label/credentials` (§10 secrets). `PlatformCredentialsFields` also drives verify via `useAdminVerifyCredentials`.
- **Sync** (`pages/settings/SyncTab.tsx` re-exports `pages/settings/sync/SyncTab.tsx`): master/detail on `?page=`. `SyncPageList` → `useSyncOverview` `GET /api/v1/sync/overview` (polls 10s); `SyncPageDetail` → `usePageSyncBlocks` `GET /api/v1/pages/:label/sync/blocks` (polls 10s). `SyncBlockActions` → `useAdminSyncBlockTrigger/Pause/Resume/Reset` `POST /api/v1/admin/sync/blocks/{trigger,pause,resume,reset}` (`AdminSyncBlockBody`).
- **Models** (`ModelsTab.tsx` + modals): `useAdminModels` `GET /api/v1/admin/models`; `useAdminCreateModel` `POST`; `useAdminUpdateModel` `PATCH /api/v1/admin/models/:slug`; `useAdminReorderModels` (parallel PATCHes of `{sortOrder}`); `useAdminDeleteModel` `DELETE`.
- **Pages** (`PagesTab.tsx` + modals): `useAdminPages` `GET /api/v1/admin/pages`; `useAdminModels`; `useAdminConnections`; `useAdminCreatePage` `POST /api/v1/admin/pages`; `useAdminUpdatePage` `PATCH .../pages/:label`; `useAdminDeletePage` `DELETE .../pages/:label`; `useAdminVerifyPage` `POST .../pages/:label/verify`; `CreatePageModal` also `useAdminVerifyCredentials` `POST /api/v1/admin/credentials/verify`. `ProxyInput`/`useAdminTestProxy` `POST /api/v1/admin/proxy/test`.
- **Users** (`UsersTab.tsx` + `UserPageAssignmentModal.tsx`): `useAdminUsers` `GET /api/v1/admin/users`; `useAdminCreateUser` `POST`; `useAdminUserApiKeys` `GET .../users/:username/api-keys`; `useAdminIssueApiKey` `POST` (returns the plaintext key once, `IssuedApiKeyResponse`); `useAdminRevokeApiKeys` `DELETE`; `useAdminAssignPage` `POST .../users/:username/pages`; `useAdminUnassignPage` `DELETE .../users/:username/pages/:label`.
- **Configuration** (`ConfigurationTab.tsx`): §12.

**Dev pages** (all owner):
- `LogPage` (`pages/dev/LogPage.tsx`): `useAdminLogs` `GET /api/v1/admin/logs?severity,limit` (polls 10s). Event rows link to `SyncStatusPage` when they carry a `syncRunId`.
- `QueuePage` (`pages/dev/QueuePage.tsx`): `useAdminQueueJobs` `GET /api/v1/admin/queue/jobs?state,limit=100` (polls 10s). Displays pg-boss jobs (state, timestamps, retryCount, data/output).
- `DbStatsPage` (`pages/dev/DbStatsPage.tsx`): `useAdminDbStats` `GET /api/v1/admin/db/stats` (table row estimates + byte sizes, migrations).
- `IncidentsPage` (`pages/dev/IncidentsPage.tsx`): `useAdminIncidents` `GET /api/v1/admin/incidents?severity,code,limit` (polls 30s).
- `SyncStatusPage` (`pages/dev/SyncStatusPage.tsx`): `useAdminSyncRunDetail` `GET /api/v1/admin/sync/runs/:runId` (from `?runId=`). Renders run header, emitted events, and per-stream request attempts.

## 9. Full outbound endpoint catalog (the primary boundary)

All calls are **outbound HTTP to the core API, same origin, cookie-authenticated (`credentials:"include"`), JSON**. Grouped by client module; polling intervals noted.

`api/auth.ts`: `GET /api/v1/auth/me`; `POST /api/v1/auth/login {username,password}`; `POST /api/v1/auth/logout`.

`api/overview.ts`: `GET /api/v1/overview`; `GET /api/v1/overview/revenue?period`; `GET /api/v1/overview/growth?period`; `GET /api/v1/overview/revenue/daily?period`.

`api/pages.ts`: `GET /api/v1/pages/:label/revenue?period`; `.../revenue/daily?period`; `.../subscribers?…`; `.../subscribers/daily?period`; `.../followers?…`; `.../followers/daily?period`; `.../transactions?limit,offset,type,state`; `.../spender-autolists?period,from,to`; `.../spender-autolists/:bucketKey?…`; `.../deleted-fans?limit,offset`; `.../fans/:platformUserId/transactions?limit,offset`; `GET /api/v1/fans/:platform/:platformUserId/transactions` (**defined, not called by any component**); `.../fans/:platformUserId`; `.../fans/:platformUserId/profile`; `.../profile/versions`; `.../profile/versions/:version`; `POST .../fans/:platformUserId/notes {body}`; `GET /api/v2/spenders?scope,pageLabel,period,platform,limit,offset,sortBy,sortDir,query,retentionStatus`; `GET /api/v2/spenders/:platform/:platformUserId?scope,pageLabel,period`; `GET /api/v2/spenders/:platform/:platformUserId/series?scope,pageLabel,period,granularity`; `POST /api/v2/spenders:batch {scope,pageLabel,period,fans:[{platform,platformUserId}]}`.

`api/workboard.ts`: `GET /api/v1/pages/:label/workboard`; `.../workboard/presence`; `POST .../workboard/snooze {fanId,days}`; `DELETE .../workboard/snooze/:fanId`; `GET .../workboard/v2?tab,status,limit,offset`; `.../workboard/v2/lists`; `POST .../workboard/v2/contact {fanId,action,wasProductive}`; `POST .../workboard/v2/recompute`; `POST .../workboard/v2/snooze {fanId,days}`; `DELETE .../workboard/v2/snooze/:fanId`; `DELETE .../workboard/v2/contact/:fanId`; `GET .../workboard/v2/ai`; `PUT .../workboard/v2/ai/settings`; `POST .../workboard/v2/ai/classify {reclassify?}`; `GET /api/v1/workboard/ai/runs`.

`api/conversations.ts`: `GET /api/v1/pages/:label/conversations/:platformConversationId/preview?limit`.

`api/dev.ts`: `GET /api/v1/admin/logs?severity,limit` (10s); `GET /api/v1/admin/sync/runs/:runId`; `GET /api/v1/admin/queue/jobs?state,limit` (10s); `GET /api/v1/admin/db/stats`; `GET /api/v1/admin/incidents?severity,code,limit` (30s). (Type interfaces for these are declared locally in `dev.ts`, not imported from contracts, except `SyncRunDetailResponse`.)

`api/adminConfig.ts`: `GET /api/v1/admin/config` (30s); `PATCH /api/v1/admin/config` (`ConfigUpdateBody`); `PATCH /api/v1/admin/config/staged` (`ConfigStagedBody`); `DELETE /api/v1/admin/config/:key?expectedVersion,note`.

`api/adminNotifications.ts`: `GET/PATCH /api/v1/admin/notifications/settings`; `POST .../test`; `POST .../discover-chats`; `GET .../incidents?…` (30s); `POST .../incidents/:id/resolve`; `GET .../reports/preview` (manual); `POST .../reports/send`; `GET .../reports/history`.

`api/adminOfapiCredits.ts`: `GET /api/v1/admin/ofapi/credits/summary` (60s); `GET .../credits/daily?days`; `GET .../credits/ledger?…`; `GET .../spend/comparison?days,sampleLimit`; `GET .../credits/ledger.csv?…` (raw fetch, §11).

`api/adminUsage.ts`: `GET /api/v1/admin/usage/chatters?from,to`.

`api/adminPages.ts`: `GET /api/v1/admin/models`; `POST /api/v1/admin/models`; `PATCH .../models/:slug`; `DELETE .../models/:slug`; `GET /api/v1/admin/pages`; `POST /api/v1/admin/pages`; `PATCH .../pages/:label`; `DELETE .../pages/:label`; `POST /api/v1/admin/credentials/verify`; `POST /api/v1/admin/proxy/test`; `POST /api/v1/admin/pages/:label/verify`.

`api/adminSync.ts`: `GET /api/v1/admin/connections`; `POST /api/v1/admin/sync/trigger` (**defined, not called**); `POST /api/v1/admin/sync/trigger-all` (**not called**); `GET /api/v1/admin/sync/runs?…` (**not called**); `GET /api/v1/sync/status?…` (**not called**); `GET /api/v1/sync/overview` (10s); `GET /api/v1/pages/:label/sync/blocks` (10s); `GET /api/v1/pages/:label/sync/blocks/messages` (**not called**); `POST /api/v1/admin/sync/blocks/{trigger,pause,resume,reset}`; `PATCH /api/v1/admin/pages/:label/credentials`.

`api/adminUsers.ts`: `GET /api/v1/admin/users`; `POST /api/v1/admin/users`; `GET .../users/:username/api-keys`; `POST .../users/:username/api-keys`; `DELETE .../users/:username/api-keys`; `POST .../users/:username/pages`; `DELETE .../users/:username/pages/:label`.

## 10. Credentials submission (secrets boundary)

`pages/settings/PlatformCredentialsFields.tsx` collects raw platform session secrets in the browser and posts them to the API. `buildCredentialsBody` (`:94`) assembles either a `VerifyCredentialsBody` (used by `useAdminVerifyCredentials` `POST /api/v1/admin/credentials/verify`, and `CreatePageModal`) or an `UpdateCredentialsBody` (`useAdminUpdateCredentials` `PATCH /api/v1/admin/pages/:label/credentials`, and `EditPageModal`). Fields that cross:
- **Fansly**: `session.authorization` (bearer/auth token), optional `fanslyClientId`, `fanslyClientCheck`, `fanslySessionId`.
- **OnlyFans**: `auth.token`, `username`.
- **Proxy** (both): a `{ url, username?, password? }` config parsed from the raw proxy string by shared `buildProxyConfig`; when the stored proxy already has auth and the URL is unchanged, the auth is preserved server-side by omitting it (`preserveStoredProxyAuth`, `:127`). Proxy connectivity is tested via `useAdminTestProxy` `POST /api/v1/admin/proxy/test`.

These plaintext secrets exist only transiently in component state and the outbound request body; nothing is stored client-side.

## 11. CSV export (raw download boundary)

`api/adminOfapiCredits.ts:77` `downloadOfapiCreditsLedgerCsv(params)` bypasses the JSON `api` client (which always `res.json()`s) with a direct `fetch(ledger.csv?…, { credentials:"include" })`. It reads the blob, extracts the filename from `Content-Disposition`, triggers an anchor-click download, and returns `{ rowCount: header "x-export-row-count", truncated: header "x-export-truncated" === "1" }` so the page can warn when the server capped the extract. Same-origin, cookie-auth, `GET /api/v1/admin/ofapi/credits/ledger.csv`.

## 12. Configuration surface (config-write boundary)

`pages/settings/ConfigurationTab.tsx` reads `useAdminConfig` `GET /api/v1/admin/config` (`ConfigViewResponse`, polled 30s) and writes through three mutations, all with `meta.suppressGlobalError` and `onSettled: invalidate ["admin","config"]` (refetch after both success and failure so an optimistic-concurrency 409 refreshes the version):
- `useUpdateConfig` `PATCH /api/v1/admin/config` (`ConfigUpdateBody`) — set/override a scalar config value (carries an `expectedVersion` for optimistic concurrency).
- `useStagedConfig` `PATCH /api/v1/admin/config/staged` (`ConfigStagedBody`) — staged enable/disable of the staged feature flags, gated on the server-computed `runningState`/`desiredEffective` fleet truth (the client distinguishes a display-only "partial" fleet but does not use it as the lock truth; `:24-50`). Three stream flags (`ofapiDmSyncEnabled`, `ofapiAudienceSyncEnabled`, `onlyFansTopSpendersEnabled`) require a manual Sync-tab resume after flipping (`:16-22`).
- `useClearConfig` `DELETE /api/v1/admin/config/:key?expectedVersion,note` — remove an override.

Russian copy for keys/subsystems comes from `pages/settings/configCopyRu.ts`.

## 13. Notable shared components that issue requests

- `components/shared/ChatPreviewPanel.tsx` → `usePageConversationPreview` (conversation message preview). Also used by `WorkboardV2Row.tsx`.
- `components/shared/TransactionsPreviewPanel.tsx` → `usePageFanTransactions`.
- `components/shared/SpenderTrendPanel.tsx` → `useSpenderSeries` (`GET /api/v2/spenders/:platform/:platformUserId/series`).
- `components/page/workboard/PresencePanel.tsx` is presentational (data passed in from `WorkboardPage`'s `useWorkboardPresence`).
- Presentation-only shared components of note: `Pagination` (offset/limit/total controls, `components/shared/Pagination.tsx`; currently modified in the working tree), `StatusPanel`, `TableSkeleton`/`StatCardSkeleton`, `StackedBarChart`, `PageActivityChart` (Recharts), `SyncUxBadge`/`syncUxDisplay.ts` (sync-state → display mode/tone mapping), `MoneyCell`/`RemainingBar`/`DeltaIndicator`, `EventDetailPanel` (links to sync-status). Money is rendered via `formatUsdFromMills`/`formatUsdFromCents` (shared / `lib/format.ts`); the dashboard treats mills as the money unit throughout.

## 14. Behavior vs. names — discrepancies to note

- **Defined-but-unused endpoints**: `api/adminSync.ts` exports `useAdminSyncTrigger` (`POST /api/v1/admin/sync/trigger`), `useAdminSyncTriggerAll` (`/trigger-all`), `useAdminSyncRuns` (`/admin/sync/runs`), `useSyncMonitor` (`/sync/status`), and `usePageMessagesBlock` (`/sync/blocks/messages`); `api/pages.ts` exports `useFanTransactions` (cross-page `/api/v1/fans/:platform/:platformUserId/transactions`). Grepping the component tree shows none of these are called by any page/component in the current code — the sync UI drives everything through the block-level endpoints and `useSyncOverview`/`usePageSyncBlocks` instead. These endpoints therefore exist in the client but are not part of the live dashboard→API dependency.
- **Two `SyncTab` modules**: `pages/settings/SyncTab.tsx` is a one-line re-export of the real `pages/settings/sync/SyncTab.tsx`; `SettingsPage` imports the re-export.
- **`/dev/sync-status`** is routed and owner-gated but has no sidebar entry (reached only via `?runId=` deep links).
- **`getPeriodSelectorMode`** in `Topbar.tsx:104` never returns `"usage"`/`"ofapi"` etc.; the period selector is shown only for Overview, PageDetail, Top Supporters, and spender/fan contexts.
- **Mixed languages**: Overview/Subscribers/etc. are English; Workboard v1/v2, AI Analytics, and OFAPI Credits are largely Russian. This is presentation only.
- **No runtime response validation**: contract types are compile-time only; the client trusts server shapes (with a couple of defensive shape checks, e.g. the Followers enrichment fallback in `FollowersPage.tsx:78`).
- **No SSE/WebSocket/EventSource** anywhere in the dashboard; "live" data is React Query polling (`refetchInterval`) only. The only non-`api`-client network call is the CSV download (§11).

## 15. Cross-references

- `02-http-api-surface.md` / `03-contracts-and-codegen.md` — the server side of every endpoint above and the `@agency_hub_core/contracts` types the dashboard imports.
- `01-runtime-and-processes.md` — the Fastify API process that serves this SPA via `@fastify/static` and answers all `/api/*` calls.
- `06-sync-engine.md` — sync blocks/overview/run-detail consumed by the Settings→Sync and dev pages.
- `09-financial-spend-credits.md` — the OFAPI credits ledger/summary/comparison behind `OfapiCreditsPage`.
- `10-ai-gateway-and-usage.md` — chatter usage (`UsagePage`) and the Workboard v2 AI reply-detector (`AiAnalyticsPage`).
- `11-workboard.md` — the workboard v1/v2 server logic behind the two workboard pages (the "future standalone-app surface" currently embedded in this SPA).
