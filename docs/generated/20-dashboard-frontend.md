> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Dashboard Frontend (`apps/dashboard/`)

The owner console: a React 19 single-page app built with Vite 6 and Tailwind v4,
served same-origin from the runtime `api` role in production. It holds no vendor
keys and computes no money — every read and write goes through the generated
kernel SDK over cookie-authenticated same-origin requests. This map covers the
build/config, the entry and router, the API/data layer, auth/session handling,
the zustand period stores, notable components, and how the built assets are
served in production. (The SPA is slated for a from-scratch rebuild; this
describes the app in the tree today.)

## Build / config

- `apps/dashboard/package.json` — package `@agency_hub_core/dashboard`, private.
  Scripts: `dev`=`vite`, `build`=`tsc -b && vite build`, `preview`.
  Runtime deps: React 19.1, react-router 7.17, `@tanstack/react-query` 5.80,
  zustand 5.0, recharts 3.8, lucide-react 0.511, react-markdown 10.1, sonner 2.0.
  Dev deps: Vite 6.3, Tailwind v4 via `@tailwindcss/vite`, TypeScript 5.8.
- `apps/dashboard/vite.config.ts` — plugins `react()` + `tailwindcss()`.
  Dev server `server.port = 5173` (`:19`). Proxy (`:20-23`) forwards `/api` and
  `/documentation` to `VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000"` (`:6`).
  Resolve aliases (`:11-16`): `@` → `src`,
  `@agency_hub_core/shared` → `packages/shared/src/browser.ts` (the browser
  build of shared, not `index.ts`), `@agency_hub_core/contracts` →
  `packages/contracts/src/index.ts`, `@kernel/sdk` → `packages/sdk/src/index.ts`.
- `apps/dashboard/index.html` — mounts `<div id="root">`, loads `/src/main.tsx`,
  title "AgencyHub", Inter font from Google Fonts.
- Build output: `apps/dashboard/dist/` — `index.html` plus `assets/` with
  per-page code-split chunks; the built `dist/` is present in the tree.

## Entry + router

- `apps/dashboard/src/main.tsx` — `createRoot` renders
  `QueryClientProvider` > `BrowserRouter` > `App`, alongside
  `<Toaster position="top-right" richColors>` (sonner).
- `apps/dashboard/src/App.tsx` — every page is `lazy()` code-split and wrapped in
  an `ErrorBoundary` + `Suspense`. Route table:

| Route path | Page component | Guard |
|---|---|---|
| `/login` | LoginPage | public |
| `/` (index) | OverviewPage | ProtectedLayout |
| `/pages/:pageLabel` | PageDetailPage | Protected |
| `/pages/:pageLabel/spender-autolists/:bucketKey` | SpenderAutoListPage | Protected |
| `/pages/:pageLabel/deleted-fans` | DeletedFansPage | Protected |
| `/pages/:pageLabel/subscribers` | SubscribersPage | Protected |
| `/pages/:pageLabel/followers` | FollowersPage | Protected |
| `/pages/:pageLabel/top-supporters` | TopSupportersPage | Protected |
| `/pages/:pageLabel/workboard` | WorkboardV2Page | Protected |
| `/pages/:pageLabel/workboard/v2` | LegacyWorkboardRedirect (→ `resolveLegacyWorkboardRedirect`) | Protected |
| `/pages/:pageLabel/crm` | LegacyWorkboardRedirect | Protected |
| `/pages/:pageLabel/fans/:platform/:platformUserId` | FanProfilePage | Protected |
| `/usage` | UsagePage | OwnerRoute |
| `/ofapi-credits` | OfapiCreditsPage | OwnerRoute |
| `/ai-analytics` | AiAnalyticsPage | OwnerRoute |
| `/notifications` | NotificationsPage | OwnerRoute |
| `/settings` | SettingsPage | OwnerRoute |
| `/dev/log` | LogPage | OwnerRoute |
| `/dev/queue` | QueuePage | OwnerRoute |
| `/dev/db-stats` | DbStatsPage | OwnerRoute |
| `/dev/incidents` | IncidentsPage | OwnerRoute |
| `/dev/sync-status` | SyncStatusPage | OwnerRoute |
| `*` | `<Navigate to="/" replace>` | — |

- `App.tsx:53-54` — `/pages/:pageLabel/workboard/v2` and
  `/pages/:pageLabel/crm` are legacy redirects handled by `LegacyWorkboardRedirect`
  (which delegates to `resolveLegacyWorkboardRedirect` in `lib/navigation.ts`).
  The current workboard lives at `.../workboard` and is rendered by
  `WorkboardV2Page`; the older `/workboard/v2` and `/crm` paths redirect to it.
- Tabbed sub-pages (not separately routed): `pages/settings/` (ConfigurationTab,
  CredentialsTab, ModelsTab, PagesTab, UsersTab, SyncTab, plus modals and a
  `sync/` subdir), `pages/notifications/` (IncidentsTab, ReportsTab, SettingsTab),
  and `pages/dev/` (the five dev pages).

## API / data layer (`src/api/`)

- `api/queries.ts` — barrel that re-exports the domain query modules:
  adminNotifications, adminOfapiCredits, adminPages, adminSync, adminUsage,
  adminUsers, auth, conversations, dev, overview, pages, workboard. Additional
  module files alongside: `adminConfig.ts`, `sdk.ts`.
- `api/sdk.ts:23` — the dashboard's single API client, `createClient` from
  `@kernel/sdk` (Stage 20). Configured `baseUrl: ""` (same-origin) and
  `auth: { mode: "cookie" }`. `onAuthError` (`:26`): a 401 on any operation other
  than `login` calls `redirectToLogin()`, which (unless already on `/login`)
  invokes `clearDashboardSession()` and `window.location.assign("/login")`. A
  failed login is treated as a normal form error, not an expired session.
  `KernelApiError` is re-exported. Direct `fetch` and hand-rolled clients are
  lint- and test-banned inside `src/api/` (see `tests/dashboard-sdk-ban.test.ts`).
- `api/auth.ts` — `useAuthMe` (queryKey `["auth","me"]`, `retry: false`),
  `useLogin`, `useLogout` (both carry `meta.suppressGlobalError` and invalidate
  the `["auth"]` key).

## Auth / session handling

- `components/layout/ProtectedLayout.tsx` — gates all app routes on `useAuthMe()`;
  `isError || !data` redirects to `<Navigate to="/login">`. On success it loads
  the page catalog via `useOverview` and provides `DashboardShellProvider`
  (Sidebar + Topbar + `Outlet`).
- `components/layout/OwnerRoute.tsx:16` — role gate:
  `data?.user.role !== "owner"` redirects to `<Navigate to="/" replace>`.
- `lib/queryClient.ts` — QueryClient defaults `retry: false`,
  `staleTime: 30_000`, `refetchOnWindowFocus: false`. A global error toast is
  wired through the QueryCache/MutationCache `onError`; errors that are 401 with
  `meta.suppressGlobalError` are suppressed. `clearDashboardSession()` calls
  `queryClient.clear()`.

## Stores (`src/stores/`)

- `periodStore.ts` — zustand with the `persist` middleware.
  `PeriodOption = "today" | "7d" | "30d" | "all"`, default `7d`,
  `PERIOD_STORE_VERSION = 3` with a `migratePeriodState` migration.
- `spenderPeriodStore.ts` — a sibling, spender-scoped period store.

## Notable components

- Workboard v2 lives at `src/components/page/workboard/v2/`: `CapMeter.tsx`,
  `FocusStrip.tsx`, `QuadrantGlyph.tsx`, `WorkboardV2Row.tsx` (~14KB), and
  `tone.ts` (~12KB of tone/classification helpers). The page component is
  `pages/WorkboardV2Page.tsx`.
- Shared: ~35 components under `components/shared/` (ChatPreviewPanel,
  EventDetailPanel, SpenderTrendPanel, SyncUxBadge, StackedBarChart,
  TrendSparkline, and others), `components/ai/` (AiPageDashboard, AiRunLog), and
  `components/layout/` (Sidebar, Topbar, DashboardShellContext).

## Production serving (runtime `api` role)

The built dashboard is not served by Vite in production — the runtime `api` role
serves `apps/dashboard/dist/` same-origin.
`apps/runtime/src/api/server.ts:98` `resolveDashboardDistPath()` walks ancestor
directories for `apps/dashboard/dist/index.html`. `:498-508` registers
`@fastify/static` (root = the dist dir, prefix `/`, `wildcard: false`) plus a
`setNotFoundHandler` SPA fallback: any non-`/api/`, non-`/documentation` URL is
served `index.html`; anything else returns a 404 JSON body. The deploy script's
delivery check confirms `/login` returns 200 containing `<!doctype html>` and
`id="root"`.
