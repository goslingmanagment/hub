> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.
>
> **STALE (Decision 349, 2026-09-15):** the console's Russian configuration
> copy carries the new `accountLinksEnabled` entry. The "Команда" tab
> (replacing the users tab and every API-key surface), the "Техническое"
> section and the `/join` and `/account` pages land in PR-1B and PR-1C of the
> same wave.

> **STALE (Decision 356, 2026-09-15):** user administration now addresses immutable
> IDs through `/admin/users/by-id/:userId`, SDK 0.3 retires username routes,
> migration 0202 adds permanent account deletion and partial login uniqueness,
> and Team state/cache ownership follows IDs. See Decision 356 and
> `docs/runbooks/user-account-deletion.md`; the body predates this change.

# Dashboard Frontend

`apps/dashboard` is a React 19 single-page owner console. Vite builds it,
Tailwind supplies the CSS pipeline, React Router owns navigation, TanStack Query
owns server state, and Zustand persists the two period selectors. The source
tree at this commit does not contain `apps/dashboard/dist`; that directory is a
build output consumed by the production image.

## Build and entry points

`apps/dashboard/package.json` exposes `dev`, `build`, and `preview`. The build
runs TypeScript project compilation followed by Vite. Runtime dependencies also
include Recharts, Lucide, React Markdown, and Sonner.

`apps/dashboard/vite.config.ts` configures React and Tailwind, listens on port
5173 in development, and proxies `/api` and `/documentation` to
`VITE_API_PROXY_TARGET` or `http://127.0.0.1:3000`.

The Vite aliases are:

| Import | Source |
|---|---|
| `@` | `apps/dashboard/src` |
| `@agency_hub_core/shared` | `packages/shared/src/browser.ts` |
| `@agency_hub_core/contracts` | `packages/contracts/src/index.ts` |
| `@kernel/sdk` | `packages/sdk/src/index.ts` |

`apps/dashboard/src/main.tsx` mounts the app inside a TanStack
`QueryClientProvider` and a `BrowserRouter`, with the global Sonner toaster.
`apps/dashboard/src/App.tsx` wraps the lazy-loaded route tree in one error
boundary and Suspense fallback.

## Route tree and authorization

The route tree lazy-loads 20 page components.

| Surface | Paths |
|---|---|
| Public | `/login` |
| General authenticated | `/`, `/pages/:pageLabel`, spender auto-list, deleted-fan, subscriber, follower, top-supporter, workboard, and fan-profile paths |
| Legacy redirects | `/pages/:pageLabel/workboard/v2` and `/pages/:pageLabel/crm` redirect to the current workboard path |
| Owner | `/usage`, `/ofapi-credits`, `/ai-analytics`, `/notifications`, `/settings` |
| Owner diagnostics | `/dev/log`, `/dev/queue`, `/dev/db-stats`, `/dev/incidents`, `/dev/sync-status` |

`apps/dashboard/src/components/layout/ProtectedLayout.tsx` loads the current
session and overview page catalog. Failed authentication redirects to login;
successful authentication provides the page catalog to the sidebar, top bar,
and nested route outlet.

`apps/dashboard/src/components/layout/OwnerRoute.tsx` accepts only a session
whose user role is `owner`; other authenticated roles are redirected to the
overview.

`apps/dashboard/src/pages/SettingsPage.tsx` exposes credentials, sync, models,
AI personas, pages, users, and configuration tabs. The notifications page has
settings, incidents, and reports tabs.

## API and server-state layer

`apps/dashboard/src/api/sdk.ts` constructs the single `@kernel/sdk` client with
same-origin base URL and cookie authentication. A 401 from any operation except
login clears the query cache and navigates to `/login`.

Domain-specific query and mutation hooks live under `apps/dashboard/src/api`.
They cover authentication, overview and pages, conversations, workboard,
personas, users, usage, OFAPI credits, notifications, sync administration, and
developer diagnostics. `apps/dashboard/src/api/queries.ts` is the public hook
barrel; `adminConfig.ts` is imported directly where needed.

`apps/dashboard/src/lib/queryClient.ts` disables retries and window-focus
refetching and sets a 30-second stale time. Query and mutation cache handlers
show global error toasts except when hook metadata suppresses them or the error
is an authentication 401.

`tests/dashboard-sdk-ban.test.ts` pins the SDK boundary by scanning dashboard
API source for direct `fetch` and legacy hand-written client patterns.

## Local state and presentation

`apps/dashboard/src/stores/periodStore.ts` persists the general period under
`agencyhub-period`; supported values are today, 7 days, 30 days, and all time.
Its current store version is 3 and its migration moves an older 30-day value to
the 7-day default.

`apps/dashboard/src/stores/spenderPeriodStore.ts` persists both the main
spender period and top-supporter period under `agencyhub-spender-period`. It
adds 90- and 180-day values; its defaults are 7 days and all time respectively.

The current workboard presentation lives under
`apps/dashboard/src/components/page/workboard/v2` and is rendered by
`apps/dashboard/src/pages/WorkboardV2Page.tsx`. Reusable charts, previews,
badges, event panels, and error/loading primitives live under
`apps/dashboard/src/components/shared`; AI run displays are under
`apps/dashboard/src/components/ai`.

## Production delivery

`scripts/build-production.mjs` builds server packages, while the root
`build:production` script also builds the dashboard. The Docker image copies
the generated dashboard assets.

`apps/runtime/src/api/server.ts` searches ancestor directories for
`apps/dashboard/dist/index.html`. When found, the API process registers
Fastify static serving at `/`. Its not-found handler sends `index.html` for
non-API, non-documentation paths to support browser routing, while unknown
`/api/` and `/documentation` paths remain JSON 404 responses.
