# D — ChatGoose Fansly extension: session capture, Hub client, Fansly egress, and WebSocket-tap feasibility

Repo under analysis: `/Users/dmitriy/code/goose/fansly-ext` (ChatGoose, Firefox MV3, `strict_min_version` 142).
Hub: `/Users/dmitriy/code/goose/hub`. Read-only analysis; nothing was modified and nothing touched Fansly or production.

Version at time of reading: `manifest.json:4` → `2.0.0`; contract pin `vendor/kernel-sdk/kernel-sdk.vendor.json` →
`contractHash 46f7a01e…`, `sourceCommit 7fac98f3…`.

---

## 0. Orientation — what this extension is and is not

- It is a **kernel client**, not a data collector. `CLAUDE.md:5-9`: the Hub "holds the vendor AI keys, assembles every
  prompt, and computes all money; this repo talks to Fansly's page DOM/API on one side and to the kernel's SDK +
  feature lane on the other."
- The binding rule that shapes every answer below — `CLAUDE.md:47-53`:
  > **DP 1-B — the extension is the LIVE reader:** it reads the Fansly DOM/API in real time for the chatter; the
  > kernel's Fansly archive is pull-cadenced (~30min/24h). Do not "optimize" a live read into a kernel read —
  > freshness is the product here.
  > **Fansly egress:** the extension rides the chatter's own browser session — never add out-of-band requests to
  > Fansly endpoints beyond what the injected page context already does; a model ban is the failure mode.
- Manifest surface (`manifest.json:6-35`): permissions `storage`, `unlimitedStorage`, `webRequest`, `tabs`;
  host permissions `*://fansly.com/*` + `*://apiv3.fansly.com/*`; optional host permissions `http(s)://*/*`
  (that is how the Hub origin gets granted at runtime — `agency-hub-client.ts:207-225`).
  **No `alarms`, no `webRequestBlocking`, no `scripting` permission.** Background is `background.scripts:["background.js"]`
  — an MV3 **event page**, not a service worker.
- One content script only, `content.js` on `*://fansly.com/*` at **`run_at: "document_idle"`** (`manifest.json:25-35`),
  ISOLATED world (no `world` key). `content-chat.js` is a `web_accessible_resource` lazily `import()`ed by the
  bootstrap (`src/content/bootstrap.ts:97-115`).

---

## 1. Session capture

### 1.1 What is captured, from where

`src/background/session-capture.ts:90-125` installs exactly one listener:

```ts
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => { … },
  { urls: ['https://apiv3.fansly.com/*'] },
  ['requestHeaders'],
);
```

- **Event:** `onBeforeSendHeaders` only. Non-blocking (`['requestHeaders']`, no `'blocking'` — and no
  `webRequestBlocking` permission in the manifest to allow it).
- **Filter:** `https://apiv3.fansly.com/*` — the REST API host only, never `fansly.com` itself.
- **Tab-scoped:** `details.tabId < 0` returns early (`session-capture.ts:93-95`) — the extension's own background
  fetches are deliberately not re-captured.
- **Request headers only. Response bodies are never read.** Verified by exhaustive grep: the only `browser.webRequest.*`
  references in the whole repo are `session-capture.ts:41` (a type) and `session-capture.ts:90` (the listener).
  There is **no** `onHeadersReceived`, `onCompleted`, `onResponseStarted`, or `filterResponseData` anywhere in `src/`.
  → **The extension performs no passive capture of Fansly response payloads at all.**

### 1.2 The four mandatory headers + the fifth optional one

`session-capture.ts:56-79`:

| Header | Field | Mandatory? |
|---|---|---|
| `authorization` | `authorization` | yes |
| `fansly-client-id` | `fanslyClientId` | yes |
| `fansly-client-ts` | `fanslyClientTs` | yes |
| `fansly-session-id` | `fanslySessionId` | yes |
| `fansly-client-check` | `fanslyClientCheck` | **no** — `?? null` (`:77`) |

If any of the four mandatory ones is absent the capture is dropped whole (`session-capture.ts:61-64`).

**Account id derivation** (`session-capture.ts:5-13`, called at `:66`): `atob(authorization).split(':')[0]` — the
Fansly bearer is base64 of `<accountId>:<secret>`, so the *legacy* account id is read straight out of the token
without any network call. A failure to decode kills the capture (`:67-69`).

**Route classification** (`normalizeRouteKey`, `session-capture.ts:15-38`) maps the URL to one of seven
`RouteKey` values (`src/shared/types.ts:13`): `earnings`, `subscribers`, `media`, `messagingGroups`, `group`,
`message`, `account`. Anything else → `null` (no route check recorded).

### 1.3 Where it is stored

**In-memory only, in the MV3 event page.** `src/background/session-store.ts:14-16`:

```ts
export class SessionStore {
  private readonly sessionsByAccount = new Map<string, SessionTemplate>();
  private readonly accountByTabId = new Map<number, string>();
```

- Nothing in `SessionStore` is persisted. `session-store.ts:62-64` states it explicitly: *"this map dies with the
  worker."* Session material never reaches `storage.local`/`storage.session`/`storage.sync`.
- Object identity is **reused** on re-capture so an in-flight request picks up a refreshed token instead of 401-ing
  on a detached copy (`session-store.ts:25-54`).
- `routeChecks` and the resolved identity survive a re-capture; `authorization` / `fanslyClientId` /
  `fanslySessionId` / `latestTs` / `latestCheck` are overwritten every time (`session-store.ts:45-54`).
- **Material vs ordinary capture** (`session-capture.ts:104-121`): a capture is "material" only when the account
  changed, the session was absent/disconnected, or one of the three durable credentials changed. Every request
  refreshes `latestTs`/`latestCheck` cheaply; only a material transition triggers the expensive `onCapture`
  side effects (tab-state rebuild, identity lookup, Hub prefetch).
- Custody hygiene: `snapshotSessionForDebug` (`src/shared/log.ts:89-104`) would emit the raw `authorization`, but it
  has **no callers** anywhere in `src/` — and the redactor (`log.ts:3-11, 45-52`) blanks any key containing
  `authorization`, `fanslyclient`, `fanslysession`, so even if wired up it would be redacted.

### 1.4 `routeChecks[route] ?? latestCheck`

`src/background/fansly-client.ts:367`:

```ts
const routeCheck = session.routeChecks[routeKey] ?? session.latestCheck;
if (routeCheck) { headers.set('fansly-client-check', routeCheck); }
```

Fansly's `fansly-client-check` is a **per-request, per-endpoint anti-automation signature** the page's JS computes
(it changes on essentially every request — `session-capture.ts:113-116`). The extension cannot compute it, so it
**replays** one:

1. `routeChecks[routeKey]` — the last check the *real page* sent **for that same route class**. Preferred, because a
   check computed for `/api/v1/message` is the one Fansly expects on `/api/v1/message`.
2. `latestCheck` — fallback: the last check seen on *any* apiv3 route (`session-store.ts:39,51`).
3. If neither exists, the header is simply omitted.

`routeChecks` is only written when the capture had **both** a recognised `routeKey` and a non-null check
(`session-store.ts:56-58`), and it is **preserved across re-captures** (`session-store.ts:46`) — so the map warms up
as the chatter navigates and each route class eventually gets its own replayable check.

Practical consequence for any redesign: **the extension's Fansly reads are structurally dependent on the page
having just made the same class of request.** It is a replay attack on the site's own anti-bot header, and it
degrades (falls back to `latestCheck`, or to nothing) exactly when the chatter is idle.

Every outbound Fansly request also stamps a **fresh** `fansly-client-ts` (`fansly-client.ts:353,362`
— `const requestTs = String(Date.now())`) rather than replaying the captured one, and adds `?ngsw-bypass=true`
(`fansly-client.ts:84-87`) to skip the site's Angular service worker.

### 1.5 Does the session bundle reach the Hub?

**No. Not automatically, and there is no manual paste path either.**

- No Hub client method takes a `SessionTemplate`. The complete list of kernel SDK operations the extension calls is
  in §2.2 — none of them carries Fansly credentials.
- `README.md:12-13`: *"Fansly conversation data is read live from the page DOM/API in the chatter's browser session.
  **Credentials remain in memory and are not copied into the Hub.**"*
- There is no options-page field, no export, no "copy session" affordance. The support report is secret-free by
  construction and a test greps the produced text for `agency_hub_`/`Bearer`/stored custody values
  (`docs/decisions.md:1591-1596`).

**This is the single biggest architectural gap for an event-driven design.** The Hub polls Fansly with its own
credentials (harvested elsewhere); the extension holds a *different*, live, page-derived session that it never
shares. Any design where "the Hub holds the WebSocket" needs a token custody path that does not exist today.

---

## 2. Hub client

### 2.1 Authentication toward the Hub

`src/background/agency-hub-client.ts:87-95`:

```ts
export function resolveHubBearer(settings): string {
  const deviceToken = (settings.agencyHubDeviceToken ?? '').trim();
  return deviceToken || (settings.agencyHubApiKey ?? '').trim();
}
```

- **Device token preferred, legacy chatter API key as fallback** (kernel dual-acceptance). Both are sent as
  `Authorization: Bearer …` via the SDK's `auth: { mode: 'bearer', token: () => bearer }`
  (`agency-hub-client.ts:227-238`).
- Every request also carries `clientVersionHeaders()` (`agency-hub-client.ts:232`) — this is the `x-client-version`
  header the Hub's ingest route requires (see §2.3).
- **Device-token issuance** (`src/background/device-token.ts:35-85`): one-time `login()` with username+password in
  the options page → `authIssueDeviceToken({ label })` → `logout()`. Browser-specific: `credentials: 'include'`
  because `Set-Cookie` is a forbidden response header in an extension, so the browser's own cookie jar carries the
  Hub session between the three calls (`device-token.ts:9-13`). Token is `agency_hub_device_…`, sliding 90 d
  (`device-token.ts:1-7`).
- Credentials live in **their own `storage.local` keys**, never inside the settings blob
  (`src/shared/storage.ts:2-3,85-86,346-351`; rule stated in `CLAUDE.md:63-66` as decision E19).
- Before any Hub call the client checks `browser.permissions.contains({origins:[…]})` for the Hub origin
  (`agency-hub-client.ts:207-225`) — the Hub URL is granted from `optional_host_permissions`.

### 2.2 Every Hub operation the extension calls

Complete enumeration (grep over `src/background/*.ts` for `.sdkFor(...)` / `createClient(...)`):

| SDK op | file:line | Purpose |
|---|---|---|
| `pages()` | `agency-hub-client.ts:295` | list visible pages → resolve `pageLabel` from Fansly username |
| `pageConversationProfile()` | `agency-hub-client.ts:332` | **read** stored fan dossier for a conversation |
| `upsertFanProfile()` | `agency-hub-client.ts:354` | **write** the full-recap dossier (append-only versions) |
| `aiUsageBatch()` | `agency-hub-client.ts:373` | deprecated; **no production caller** (only tests) |
| `voiceNoteCreate()` | `agency-hub-client.ts:464` | paid-audio take |
| `voiceNoteStatus()` | `agency-hub-client.ts:477` | poll voice job |
| `aiRecapStatus()` | `agency-hub-client.ts:525` | recap freshness metadata |
| `pageTopSpenders()` | `agency-hub-client.ts:591` | **the spenders board's only ranking source** |
| `aiPersonaCatalog()` | `agency-hub-client.ts:655` | persona metadata refresh |
| `authRevokeCurrentDeviceToken()` | `agency-hub-client.ts:690` | sign-out |
| `raw('health')` | `agency-hub-client.ts:720` | `/health` probe |
| `me()` | `agency-hub-client.ts:757` | identity/diagnostics |
| `login()` / `logout()` / `authIssueDeviceToken()` | `device-token.ts:50,68,84` | one-time sign-in |
| **`ingestObservations()`** | **`acceptance-reporter.ts:154`** | **the only ingest use — see §2.3** |
| `POST /api/v1/ai/features/:feature` (SSE) | `kernel-feature-gateway.ts:3` | every AI generation |
| `fetchVoiceNoteAudio` | `agency-hub-client.ts:5` (SDK helper) | audio bytes |

### 2.3 Ingest: what actually flows over `POST /api/v1/ingest/observations` today

**Only AI-acceptance telemetry. Zero Fansly data.**

`src/background/acceptance-reporter.ts` is the entire ingest lane:

- Wire shape (`acceptance-reporter.ts:64-80`): `{ clientEventId, kind: 'ai_acceptance', observedAt,
  payload: { operationId, requestId?, generationRef?, feature, action, pageLabel, conversationId } }`.
- `action` ∈ `'shown' | 'copied' | 'inserted'` (`:25`) — i.e. did the chatter use the draft.
- **Batching:** `BATCH_MAX = 100` events per POST (`:21`), `FLUSH_DEBOUNCE_MS = 1_000` (`:22`).
- **Spool:** `storage.local` keys `acceptanceSpool` / `acceptanceSpoolDropped` (`:18-19`), cap
  `SPOOL_CAP = 300` with **drop-oldest** and a persisted dropped counter (`:20`, `:200-204`).
  Deliberately unlike the desktop's never-drop spool — header comment `:6-10`:
  *"acceptance is recoverable signal here, not custody-grade audit; the counter keeps the gap visible."*
- **Retry:** `MAX_ATTEMPTS = 5` (`:23`). A `400` drops the batch **loudly** and increments the counter (`:157-166`);
  any other failure increments per-event attempts, drops the exhausted ones, and reschedules (`:168-184`).
  A missing/unconfigured Hub simply parks the spool (`:126-128`).
- **Startup flush:** `src/background/index.ts:176-180` — one flush on worker boot so events spooled by a dead
  instance don't wait for the next enqueue.
- **Dedupe key:** `clientEventId = crypto.randomUUID()` assigned once at enqueue, **reused on resend**
  (`:38-41`, `:199`).

**Hub side** (from `vendor/kernel-sdk/dist/contracts/routes.js:1573-1586` and confirmed against the Hub repo):

```ts
ingestObservationEventSchema = z.object({
  clientEventId: z.string().uuid(),
  kind: z.string().min(1).max(120),
  observedAt: isoTimestamp,
  payload: z.record(z.string(), z.unknown()),
  pageLabel: z.string().min(1).max(120).optional(),
});
ingestObservationsBodySchema = z.object({ events: z.array(...).min(1).max(100) });
ingestObservationsResponseSchema = z.object({ accepted, duplicates });
```

Server facts that matter for any redesign (evidence from the Hub repo):

- `auth: { kind: "apiKey" }` — bearer API key **or** device token, so the extension's existing credential works.
  `packages/contracts/src/routes.ts:5521-5534`; enforced by `apps/runtime/src/services/auth.ts:1241-1247`.
- `x-client-version` header is **mandatory**, else `400 missing_client_version`
  (`apps/runtime/src/modules/ingest/index.ts:57-64`). The extension already sends it.
- **`bodyLimit: 1_048_576`** (1 MiB per batch) and **`rateLimit: { max: 120, timeWindow: "1 minute" }`**
  (`apps/runtime/src/modules/ingest/index.ts:45-53`). The limiter has **no `keyGenerator`** anywhere in the runtime,
  so `@fastify/rate-limit` defaults to **keying by IP** — all extension instances behind one NAT share the bucket.
- **`source` is server-assigned `'client_capture'`** (`apps/runtime/src/services/ingest-observations.ts:199`). A
  client cannot choose it. The seven-value enum is `packages/db/src/schema.ts:3333-3342`; adding `fansly_event`
  would be a migration.
- **Dedupe key** = `"<principalUserId>:<clientEventId>"` scoped by `source`
  (`apps/runtime/src/services/ingest-observations.ts:206-208`), enforced by the primary key of the
  `observation_keys` table (`packages/db/migrations/0054_observations.sql:35-44`). Not a content hash;
  `payload_hash` is stored but not part of the key. Re-POSTing an identical batch returns
  `{accepted: 0, duplicates: N}` and writes nothing.
- **Kind allowlist** (`apps/runtime/src/services/ingest-observations.ts:26-47`): `ai_acceptance`, `guard_audit`,
  `send_audit`, `ai_spend`, `credit_spend`, `data_purge_notice` → stored as `desktop.<kind>`; `harvest.*` only from
  a `desktop-harvest@…` producer bound to a machine id. **Everything else is journaled as
  `desktop.unknown:<kind>` with `account_id: null` and `parse_version 0`** — captured, never canonicalized into
  domain events (`apps/runtime/src/services/canonicalize/client-capture.ts:30-49`).

→ A new kind such as `fansly.ws_frame` would be **accepted and journaled today with zero Hub changes**, but it would
land in the unknown bucket and produce no `domain_events` until a canonicalizer family + registry entry are added.

### 2.4 The AI feature lane (the biggest Hub payload)

`src/background/kernel-feature-gateway.ts:301` (`streamFeature`) → the vendored `streamAiFeature`
(`kernel-feature-gateway.ts:407`) → `POST /api/v1/ai/features/:feature`, SSE.

Three callers: the generic operation runner (`operations.ts:3036`), Compare — **one stream per card**
(`compare-operations.ts:1111-1115`), and the voice script (`voice-service.ts:771`).

`clientContext` (assembled `operations.ts:2803-2814`, serialized `kernel-feature-gateway.ts:445-463`):

- `transcript` — the **live-read** Fansly transcript, truncated oldest-first to
  `KERNEL_TRANSCRIPT_MAX_CHARS = 300_000` (`constants.ts:263`).
- `messageCount` — the **kept** count after truncation (`operations.ts:2804`), distinct from the top-level
  requested window (`operations.ts:2798`; contract note `kernel-feature-gateway.ts:71-77`).
- `fanDisplayName` — from the account lookup only, never the DOM label; falls back to `'fan'`
  (`operations.ts:2807-2808`).
- `fanSpendingData` (incl. up to 12 monthly rows), `fanSubscriptionData` (`operations.ts:2809-2810`).
- Conditional: `fanBio` (only `help-me` / `hi-greeting` / `coach-chat` — `features.ts:79,129,155`),
  `pingSegment`, `fanSilenceDays` (≤ `FAN_SILENCE_DAYS_MAX = 20_000`, `constants.ts:141`),
  `transcriptCoverage` (coach + short recap only, `operations.ts:2764-2767`).
- Body extras: `coachHistory[]` (answers ≤ 64 000 chars, questions ≤ 2 000 — `constants.ts:172,178`).

**Failure behaviour — no retry, no queue, fail closed.** The gateway arms no timeouts of its own and relies on the
caller's signal (`kernel-feature-gateway.ts:471-482`). `handle.done` resolving without a `done` frame and without an
abort ⇒ `hub_stream_truncated` — *"AI stream ended without completing"* (`:506-508`). The **only** retry anywhere is
one transparent caller-level retry on `service_unavailable`, and only if nothing has streamed yet
(`operations.ts:3050-3055`, `AUTO_RETRY_SERVICE_UNAVAILABLE_MS = 5_000` at `operations.ts:205`). Caller-armed
timeouts: TTFB 45 s, idle 45 s, max stream 300 s (`constants.ts:196-198`, armed `operations.ts:2859`).

The Hub's own code states the reason for shipping a live transcript at all
(`apps/runtime/src/modules/ai/features/index.ts:97-99`):
> *"the kernel archive is pull-cadenced: dm_conversations 30 min / dm_messages 24 h, no webhooks."*

and the extension says the same thing from its side (`kernel-feature-gateway.ts:5-9`):
> *"The extension keeps loading context itself (Fansly has no webhook lane — the kernel archive is pull-cadenced
> 30 min/24 h, while the panel reads the conversation live at generation time), so the request carries
> `clientContext` VALUES."*

**This is the load-bearing coupling for the whole project**: the only reason the extension paginates Fansly at
generation time is that the Hub's copy is up to 24 h stale. Kill the staleness and §3's egress mostly evaporates.

---

## 3. Active Fansly fetches the extension makes on its own

All of them go through one function: `FanslyClient.fetchEnvelope` (`src/background/fansly-client.ts:341-437`).

### 3.1 Transport policy (shared by every call)

| Property | Value | Evidence |
|---|---|---|
| Method | always `GET` | `fansly-client.ts:370` |
| Credentials | `credentials: 'omit'` — headers only, no cookies | `fansly-client.ts:373` |
| Query | `?ngsw-bypass=true` appended | `fansly-client.ts:84-87, 370` |
| Per-request timeout | `FANSLY_REQUEST_TIMEOUT_MS = 30_000` | `constants.ts:74`, `fansly-client.ts:350` |
| Retry ladder | `[1000, 2000, 4000]` ms → 3 retries max | `constants.ts:76`, `fansly-client.ts:341` |
| Retried on | `429` and `5xx` only | `fansly-client.ts:387-395` |
| `Retry-After` | parsed (seconds **or** HTTP-date), **capped at `FANSLY_RETRY_MAX_BACKOFF_MS = 5_000`** | `fansly-client.ts:22-37, 383-393`; `constants.ts:79` |
| 401/403 | no retry — marks the session disconnected, throws `session_expired` | `fansly-client.ts:379-382` |
| Final 429 | throws `rate_limited` carrying `retryAfterMs`/`retryAtMs` | `fansly-client.ts:397-405` |
| Pagination pacing | `FANSLY_PAGINATION_DELAY_MS = 300` ms between pages | `constants.ts:75` |
| Opt-out | `retryPolicy: 'none'` for best-effort earnings calls | `fansly-client.ts:687, 818` |

Note the `Retry-After` cap: if Fansly answers `Retry-After: 60`, the client waits **5 s** and retries anyway. That
is a deliberate latency choice but it is also the one place where the extension does *not* honour a platform
backoff request.

### 3.2 The endpoint inventory

| # | Endpoint | Method | file:line | Cost per invocation |
|---|---|---|---|---|
| 1 | `/api/v1/account/me` | GET | `fansly-client.ts:476` | 1; cached in `SessionTemplate.resolvedAccountId` (`:465-473`) |
| 2 | `/api/v1/group/{groupId}/` | GET | `fansly-client.ts:447` | 1, optional (failures tolerated) |
| 3 | `/api/v1/message?groupId&limit=25[&before]` | GET | `fansly-client.ts:515-522` | 1 per page; `FANSLY_PAGE_LIMIT = 25` (`constants.ts:73`) |
| 4 | `/api/v1/account?ids=…` | GET | `fansly-client.ts:652` | 1 per batch of ≤ `SPENDERS_NAME_LOOKUP_BATCH = 50` (`constants.ts:99`) |
| 5 | `/api/v1/account/wallets/earnings/stats/accounts` | GET | `fansly-client.ts:685-687` | 1, `retryPolicy:'none'` |
| 6 | `/api/v1/account/wallets/earnings/monthlystats/accounts` | GET | `fansly-client.ts:804-818` | 1, `retryPolicy:'none'` |
| 7 | `/api/v1/messaging/groups?limit=100&offset&sortOrder=1&flags=0&search=` | GET | `fansly-client.ts:717, 773, 827` | 1 per page, ≤ `MESSAGING_GROUPS_MAX_PAGES = 20` (`fansly-client.ts:66`) |
| 8 | `/api/v1/subscribers?status=3,4 / 5&limit=100&offset` | GET | `fansly-client.ts:884` | pages of 100, both status buckets |
| 9 | `/api/v1/media/orderhistory?accountMediaId|accountMediaBundleId&accountIds&limit=100` | GET | `fansly-client.ts:530-540` | ≤ `FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT = 10` per conversation, concurrency 3, 3 s timeout each (`constants.ts:80-83`) |

Caches that suppress repeats:

- Subscription context: `SUBSCRIPTION_CACHE_TTL_MS = 5 min` keyed `account:fan` (`fansly-client.ts:67, 280-303`).
- Media-purchase verdicts: `FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS = 5 min` keyed
  `account:fan:kind:contentId` (`constants.ts:83`, `fansly-client.ts:304-338`).
- Fan names for the board: `SPENDERS_NAMES_CACHE_TTL_MS = 6 h`, max 2 000 entries (`constants.ts:107,110`).
- Board result: `SPENDERS_CACHE_TTL_MS = 10 min` in memory + `storage.session` (`constants.ts:116`,
  `spenders-service.ts:558-590`).
- `resolvedAccountId` short-circuits `/account/me` for the life of the worker (`fansly-client.ts:465-473`).

### 3.3 Message-window constants (what drives page counts)

Resolution path: `resolveFeatureMessageCount(feature, settings)` (`features.ts:213-229`) → bucket from
`FEATURE_POLICIES` (`features.ts:43-174`), called at `operations.ts:1278` and `voice-service.ts:697`;
short recap overrides it at `operations.ts:1968-1970`.

| Feature (UI label) | Bucket | Constant | Default N | Pages `ceil(N/25)` | file:line |
|---|---|---|---|---|---|
| Reply (`fast-reply`) | quick | `QUICK_DEFAULT_MESSAGE_COUNT` | 100 | 4 | `constants.ts:132`, `features.ts:45` |
| Fix (`improve-draft`) | improve | `IMPROVE_DEFAULT_MESSAGE_COUNT` | 25 | 1 | `constants.ts:142`, `features.ts:57` |
| Help (`help-me`) | quick | `QUICK_DEFAULT_MESSAGE_COUNT` | 100 | 4 | `features.ts:69` |
| **Recap FULL (`fan-summary`)** | deep | `DEEP_DEFAULT_MESSAGE_COUNT` | **3000** | **120** | `constants.ts:148`, `features.ts:82` |
| Recap SHORT | fixed | `SHORT_SUMMARY_MESSAGE_COUNT` | 300 (hard ceiling, not a setting) | 12 | `constants.ts:158`, `operations.ts:1968` |
| **Review (`chat-review`)** | deep | `DEEP_DEFAULT_MESSAGE_COUNT` | **3000** | **120** | `constants.ts:148`, `features.ts:94` |
| Ping | ping | `PING_DEFAULT_MESSAGE_COUNT` | 100 | 4 | `constants.ts:135`, `features.ts:106` |
| Hi (`hi-greeting`) | hi | hardcoded literal | 25 | 1 | `features.ts:227` — *"fixed: 1 Fansly API page, no user setting"* |
| Coach (`coach-chat`) | quick | `QUICK_DEFAULT_MESSAGE_COUNT` | 100 | 4 seed / 1 typical tail refresh (bound 5, `coach-transcript-cache.ts:235`) | `features.ts:140` |
| Voice (`voice-script`) | quick | `QUICK_DEFAULT_MESSAGE_COUNT` | 100 | 4 | `features.ts:158`, `voice-service.ts:697` |
| Compare / Multi | — | `settings.quickMessageCount` directly | 100 | 4 | `compare-operations.ts:349` |

User-adjustable bounds: quick/ping 5–200 (`constants.ts:133-137`), improve 5–200 (`:143-144`), deep 100–3000
(`:149-150`).

`docs/decisions.md:1062-1078` is explicit about the blast radius of the v15 bump 1500 → 3000:
> *"raising it doubles the live-read pagination (~60 → ~120 Fansly pages) not only for coach's recap but for
> `fan-summary` AND `chat-review` … the pagination PACING is unchanged — `FANSLY_PAGINATION_DELAY_MS` stays 300 ms,
> so the request RATE against Fansly (the actual model-ban risk surface per CLAUDE.md) is identical."*

Prep budget for the deep path: `DEEP_OPERATION_PREP_TIMEOUT_MS = 360_000` — sized as *"3000 msgs = 120 pages ×
300ms pagination delay ≈ 36s of pure pacing floor"* (`constants.ts:189-195`).

### 3.4 Per-operation cost (default settings, cold caches)

One toolbar press walks a fixed pipeline in `operations.ts::runOperation`: resolve identity (`:1874`) → load
messages (`:2259`, or `:2219`/`:2235` for coach's cached seed + tail refresh) → `getGroup` (`:2280`) → purchase
verification (`:2434`) → `getAccountNames` (`:2425`) → earnings + subscription in parallel (`:2549/2557/2567/2574`)
→ for **deep** features only, a monthly earnings fan-out of **up to 12 extra `getEarnings`** at concurrency 4
(`operations.ts:2625-2635`).

| Operation | msg pages | group | purchases | names | earnings + sub | identity | **total** |
|---|---|---|---|---|---|---|---|
| Reply / Help / Coach (1st turn) | 4 | 1 | 0–10 | 1 | 2 + sub-walk | 0–1 | **~8 + sub-walk** |
| Fix | 1 | 1 | 0–10 | 1 | 2 + sub-walk | 0–1 | **~5 + sub-walk** |
| Ping | 4 | 0–1 | 0–10 | 1 | 2 + sub-walk | 0–1 | **~8 + sub-walk** |
| Hi | 1 | 1 | 0–10 | 1 | **0** (`features.ts:128`) | 0–1 | **~3** |
| Coach (later turn) | 1 | 1 | cached | 1 | cached sub + 2 | 0 | **~5** |
| Recap SHORT (300) | 12 | 1 | 0–10 | 1 | 2 + ≤12 monthly + sub-walk | 0–1 | **~28 + sub-walk** |
| **Recap FULL / Review (3000)** | **120** | 1 | 0–10 | 1 | 2 + ≤12 monthly + sub-walk | 0–1 | **~136 + sub-walk** |
| Voice script | 4 | 1 | 0–10 | 1 | **0** (`features.ts:172`) | 0–1 | **~6** |
| Spenders board (cold) | — | — | — | `ceil(missing/50)` | — | — | **2 + name batches** |
| Board row open (unmapped fan) | — | — | — | — | — | — | **1** |

**The dominant unbounded term is the subscription walk.** On a cold 5-minute cache,
`getFanSubscriptionContext` walks up to 20 `/messaging/groups` pages **and then** an *unbounded* `/subscribers`
walk — a `while(true)` over `status='3,4'` then `status='5'`, 100/page, bounded only by `stats.total*` or a short
page (`fansly-client.ts:874-923`). For a creator with tens of thousands of subscribers this is the single
largest egress event in the extension, and it fires on a *reply*. Each request inside it can additionally
multiply ×4 under the 429/5xx retry ladder.

### 3.5 Automatic (non-user-initiated) egress

Deliberately near-zero on Fansly, but not literally zero — there are three lanes:

1. **Identity resolution on capture.** `index.ts:117-127` → `handleCapture` (`operations.ts:614`) →
   `resolveCapturedIdentity` (`:640,647`) → one `GET /account/me` (`operations.ts:769`). Fires only when
   `resolvedAccountId` is unset (`:625`), throttled by `CAPTURE_IDENTITY_RETRY_COOLDOWN_MS = 30_000`
   (`operations.ts:198`, applied `:628-635`), single-flight per legacy id (`:744-751`), 5 s timeout
   (`CAPTURE_IDENTITY_TIMEOUT_MS`, `operations.ts:189`). **≤1 request per 30 s per unresolved account; 0 once
   resolved.**
2. **Voice capability probe on tab open / route change.** `tab:init` (`operations.ts:668-679`) and
   `tab:routeChanged` (`:680,825`) both await `voiceCapabilityResolver` (`operations.ts:842-844`, wired
   `index.ts:92-94`), which calls `resolvePageForTab` → **Fansly `getAuthenticatedAccount`
   (`voice-service.ts:1307`)** + **Hub `resolvePageForUsername` (`voice-service.ts:1344`)**. Only on conversation
   routes; single-flight per tab; capability cached per pageLabel for 5 min (`voice-service.ts:57,1330-1364`);
   budget `VOICE_CAPABILITY_BUDGET_MS = 800` (`constants.ts:245`). The Fansly call is normally the memoized
   0-request path, but it is genuinely automatic.
3. **Opportunistic dossier re-push.** Every `refreshTabState` on a tab holding a stored recap fires
   `retrySummaryHubSync` (`operations.ts:596-601`) — a Hub `fetchFanProfileByConversation` preflight
   (`:1096`) and, if it pushes, Fansly `getGroup` (`operations.ts:1476`) + Hub `pushFanProfile` (`:1511`).
   Throttled by `SUMMARY_SYNC_RETRY_COOLDOWN_MS = 3 min` per (groupId, generatedAt, baseUrl)
   (`operations.ts:992-1001`).

Automatic **Hub** traffic is larger than automatic Fansly traffic: the persona catalog refresh runs on a
`setInterval` of `PERSONA_CATALOG_REFRESH_INTERVAL_MS = 5 min` (`persona-catalog.ts:14,39-43`), plus the
acceptance flush (1 s debounce, `acceptance-reporter.ts:22`).

One more path worth flagging: **the auto-recap chain** (`content/index.ts:2410-2419`). On the first Coach question
of a session, if no fresh matching recap exists, it silently runs a whole `fan-summary` first. Default is `off`
(`constants.ts:319`), but enabled in `full` mode that is a **120-page** Fansly walk plus the 12-month earnings
fan-out before the chatter's question is even answered.

The codebase actively polices this boundary: `docs/decisions.md:1586-1589` records that the options-page
«Проверить всё» button **must not** call `getSessionsSnapshot`, because it resolves identity against Fansly's `/me`
and *"a settings button may not become out-of-band Fansly egress (DP 1-B)"*. Likewise `runtime-api.ts:626-631`:
*"NOTHING here touches Fansly or the hub: this handler is called on every mount and must not become egress (DP 1-B)."*
There are **no `browser.alarms`** and **no polling of Fansly** anywhere.

### 3.6 Request volume per active chatter-hour — estimate

Assumptions: one chatter, one Fansly tab, one creator account, working DMs continuously, defaults unchanged.

| Activity | Fansly GETs each | Plausible rate/h | GETs/h |
|---|---|---|---|
| Reply / Help (100 msgs) | ~8 + sub-walk on cold cache | 25–40 | 200–320 |
| Fix (25 msgs) | ~5 | 5–10 | 25–50 |
| Cold subscription walk (5 min TTL per fan) | 1–20 groups pages + unbounded subscribers pages | ~10 cold fans | 20–200+ |
| PPV purchase verification | ≤10, 5 min TTL | a few conversations | 0–40 |
| Short recap (300 msgs) | ~28 | 1–3 | 28–84 |
| **Full recap / Review (3000 msgs)** | **~136** | 0–2 | **0–272** |
| Spenders board (10 min cache) | ~2 + `ceil(missing/50)` name batches | ≤6 opens | ≤30 |
| Capture identity + capability probes | ≤1 per 30 s per unresolved account | — | ~1–5 |

**Working estimate: ≈300–500 Fansly GETs per active chatter-hour in ordinary reply work, ≈700–900 in an hour
containing two full-window recaps, and materially more if subscription caches keep missing on a creator with a
large subscriber list.** Pacing is 300 ms between pages *within* a single paginated walk
(`FANSLY_PAGINATION_DELAY_MS`, `constants.ts:75`); there is **no global rate limiter across operations or tabs**, so
concurrent operations add up linearly. Peak burst from one deep walk is ≈3.3 req/s.

For comparison, the Hub polls the same page's DMs at `dm_conversations` = 30 min and `dm_messages` = 24 h
(`packages/db/src/repositories/page-sync.ts:253-274`) with a hard 5 000 ms per-request pacing floor
(`packages/shared/src/config-registry.ts:119-120`). **Per creator, the extension is by an order of magnitude the
louder Fansly client — and every one of those requests exists only because the Hub's copy is stale.**

---

## 4. Presence

**"Presence" in this extension means: "this browser has seen this Fansly account live at time T".** It is a local,
operator-facing observation for the options cabinet's «Аккаунты» pane. It is **not** the model's online status on
Fansly, and it is **not** a chatter-presence signal toward the Hub.

`src/background/account-presence.ts:1-27` states it directly:
> *"Durable 'this browser has seen this Fansly account' memory for the cabinet's «Аккаунты» pane. SessionStore lives
> in the MV3 worker's memory: after a suspension every account looks like it was never here. The pane must still be
> able to say «была вчера 21:40» instead of «сессий не было»."*

**Detection.** Two hooks, both fire-and-forget so they can never fail a capture:

1. `session-store.ts:62-72` — on **every** `registerCapture`, i.e. on every `apiv3.fansly.com` request the tab
   makes. Names are still `null` here.
2. `fansly-client.ts:489-500` — after `/account/me` resolves, to fill in `username`/`displayName`.

**Write discipline** (`account-presence.ts:16-27`): a **leading** write plus a 30 s coalescing window per account
(`PRESENCE_COALESCE_MS = 30_000`, `:35`). Leading, not trailing, on purpose: *"MV3 can suspend the worker before the
tail fires and the observation would be lost outright."* An identity upgrade (a name not yet recorded) bypasses the
window (`:158-171`).

**Storage.** Its own `storage.local` key `chatgoose:accountPresence` with its own `version: 1`
(`account-presence.ts:33, 56-58`), never the settings blob. A malformed or foreign-version record is **discarded,
not migrated** (`:64-82`) — *"this is an observation log, not user data."* All mutations go through a single
module-level FIFO queue because `storage.local.set` replaces the whole record (`:114-136`).
`transferAccountPresence` (`:198-231`) moves a legacy-id row onto the canonical id after identity resolution.

**Consumption.** Read only by `runtime-api.ts:643` inside `getAccountsView`, which builds three row states
(`runtime-api.ts:709-751`): `live` (a captured session in this worker's memory), `seen` (a durable presence record
with no live session), `never` (a known account with no observation at all). Tabs that cannot be attributed after
a worker restart are reported as an aggregate — *"re-deriving it would mean reading Fansly (DP 1-B)"*
(`runtime-api.ts:768-772`).

**Nothing about presence is sent to the Hub.** Confirmed on both sides: no Hub client method takes it, and on the
Hub, presence exists only as an *outbound* SSE frame type (`presenceEventSchema`,
`packages/contracts/src/routes.ts:3402-3409`), with Fansly declared `presenceSource: "poll"`
(`apps/runtime/src/platforms/registry.ts:154-186`). The Hub has no route that accepts presence from a client.

---

## 5. WebSocket tap feasibility

### 5.0 What the socket actually is (verified against the live Angular bundle)

The bundle `fansly_main.js` (downloaded by a sibling lane into the shared scratchpad) contains exactly **one**
`new WebSocket(...)` construction:

```js
setUpConnection() {
  this.clearConnection();
  const o = this;
  (this.con_ = new WebSocket(this.uri_)),
    (this.con_.binaryType = 'arraybuffer'),
    (this.con_.onopen    = function () { o.onConOpened(); }),
    (this.con_.onerror   = function (i) { o.onConError(i); }),
    (this.con_.onmessage = function (i) { o.onConMessageReceived(i); }),
    (this.con_.onclose   = function () { o.onConClosed(); });
}
```

and the DM service that drives it:

```js
class o {
  constructor() {
    (this.websocketUri_ = 'wss://wsv3.fansly.com?v=3'), …
  }
  connect() { … this.websocketClient_ = new d5(); this.websocketClient_.connect(this.websocketUri_); … }
}
… (n.ɵprov = Y({ token: n, factory: n.ɵfac, providedIn: 'root' }))
```

Facts that matter for a tap:

- **The plain global `window.WebSocket` constructor is used** — not a captured reference stashed at module load,
  not a `Worker`, not `EventSource`. Wrapping `window.WebSocket` before the Angular app boots therefore intercepts it.
- Handlers are assigned via the **`onmessage` property setter**, not `addEventListener`. A tap that adds its own
  `addEventListener('message', …)` therefore composes cleanly: both fire, the page is unaffected.
- `binaryType = 'arraybuffer'`, and `onConMessageReceived` branches on `typeof data === 'string'` → `onText` /
  `onBytes`. So **binary frames occur too** and a tap must handle them.
- Reconnect logic: `startReconnectTimer` backs off 1 500 ms doubling, capped **15 000 ms**; while connected it
  re-arms at 15 s but does **not** tear down a healthy socket. Consequence: **installing the tap late means waiting
  for a natural disconnect** — there is no periodic forced reconnect to piggyback on.
- Frame dispatch (`handleText`): `t=0` Error, `t=1` SessionVerified, `t=2` **PingResponse**, `t=10000` ServiceEvent,
  `t=10001` batch (recursively re-dispatched). Note this **contradicts** the Hub's
  `reference/fansly_api_spec.md:1650-1656`, which lists `t=2` as `BatchMessages`. The live bundle wins.
- The bundle also exposes a 46-entry `ServiceIds` table (`MessageService: 5`, `WalletService: 6`,
  `TippingService: 7`, `OnlineStatusService: 8`, `NotificationService: 9`, `SubscriptionService: 15`,
  `OrderService: 14`, …) — i.e. the one socket carries far more than DMs. That is the prize.
- **The socket never appears in the project's own HAR.** `artifacts/fansly-network-capture-2026-08-19/fansly-session-2026-08-19.har`
  has 845 entries, 0 matches for `wsv3`; the only `wss://` entry is Intercom's. `notes.md:25` records item 10
  ("Edit/delete WebSocket experiment") as **skipped**. So no observed handshake headers exist for wsv3 in-house.

### 5.a Can a content script observe those frames?

**Yes — via a `world: "MAIN"` content script at `run_at: "document_start"`. This is the only mechanism that is both
supported and CSP-proof in Firefox.**

Mechanics and the Firefox-specific facts:

1. **`world: "MAIN"` in the manifest `content_scripts` key is supported from Firefox 128**
   (MDN browser-compat-data, `webextensions/manifest/content_scripts.json` → `world: firefox 128, chrome 111`).
   `scripting.executeScript`'s `world: "MAIN"` and `RegisteredContentScript.world` are likewise Firefox 128
   (`webextensions/api/scripting.json`). This extension's `strict_min_version` is **142.0** (`manifest.json:67`)
   and esbuild already targets `firefox128` (`esbuild.config.mjs:108`), so the floor is met with room to spare.
2. **A MAIN-world content script is not subject to the page's CSP.** It is injected by the extension as a content
   script placed in the page's global, not as a `<script>` element the page's CSP gets to veto. Mozilla's own
   guidance in bug 1267027 comment 78 (Rob Wu) is exactly this: *"Extensions can already specify the `world` option
   set to 'MAIN', when they want to run content scripts."*
3. **The `<script>`-tag injection alternative is the one that CSP can kill.** MDN's
   [Content Security Policy](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_Security_Policy)
   page: *"In Firefox, JavaScript features such as eval are restricted by the extension CSP. Generally, most
   DOM-based APIs are subjected to the CSP of the web page. In Chrome, many DOM APIs are covered by the extension
   CSP instead of the web page's CSP."* Bug 1267027 (*"[meta] Page CSP should not apply to content inserted by
   content scripts"*) is **still NEW after 10 years**, and its inline-script sub-bug 1446231 is *"tracked but not
   actively worked on."* So: do **not** build on `<script src="moz-extension://…">` injection.
4. **CSP of fansly.com is UNKNOWN from our evidence.** The project HAR contains **zero** `content-security-policy`
   response headers from any `fansly.com`/`apiv3.fansly.com` entry (the only CSP header in the file is
   `content-security-policy-report-only` from `fonts.gstatic.com`), and it contains **no main-document entry at all** —
   the capture began after navigation (845 entries, all XHR/asset; `fansly.com` entries are images + one
   `chart.umd.min.js`). **This is a gap, not a clean bill of health.** It is also *moot* for the recommended
   approach: `world: "MAIN"` sidesteps the question entirely. It would only matter for the `<script>`-tag fallback.
5. **The Xray fallback exists but is unnecessary here.** Firefox's `wrappedJSObject` / `exportFunction` / `cloneInto`
   (MDN [Sharing objects with page scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts))
   would let an ISOLATED document_start script do
   `window.wrappedJSObject.WebSocket = exportFunction(…)`. It works on every Firefox, but it is fiddly
   (`instanceof`/prototype identity, cloning the returned object across the Xray boundary) and buys nothing given
   the 142 floor.
6. **Bridge, not direct messaging.** A MAIN-world script has **no `browser.*` APIs** (MDN: *"Scripts in this
   environment do not have access to content script-only APIs"*). The chain must be:
   `MAIN tap → window.postMessage / CustomEvent → ISOLATED content script → browser.runtime.sendMessage → background`.
   The ISOLATED side must validate `event.source === window` and a private nonce, because the page can forge
   these messages (MDN warns explicitly about this on the Content scripts page).
7. **Build wiring is small.** `esbuild.config.mjs` already emits three bundle groups; the tap becomes a fourth
   `iife` entry point (content scripts cannot be ESM), plus one new `content_scripts` block in `manifest.json`
   with `run_at: "document_start"`, `world: "MAIN"`, `matches: ["*://fansly.com/*"]`, `all_frames: false`.
   The existing bootstrap stays at `document_idle`.
8. **A working reference implementation already exists in the shared scratchpad**: `research/ws-tap-snippet.js`
   (a sibling lane's DevTools snippet) wraps `window.WebSocket` with a function that returns the native instance,
   registers its own `open`/`message`/`close`/`error` listeners, and tees `send`. That is precisely the shape a
   MAIN-world content script needs. It also demonstrates token redaction (`"token":"<redacted>"`).

**Ordering caveat that must be designed for:** `document_start` fires before the page's scripts, so the tap wins the
race in the normal case. But if the tap is ever installed late (extension update, a tab open before the update),
the page holds an already-open socket and the tap sees nothing until a natural disconnect — the reconnect timer
does not tear down a healthy connection. The tap must therefore report "installed but never saw an open" so the
gap is visible rather than silent.

### 5.b `browser.webRequest` sees only the handshake

**Confirmed, on both documentation and our own evidence.**

- MDN [webRequest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest):
  the API *"includes websocket requests on `ws://` and `wss://`"* — i.e. the HTTP **upgrade** request. Frames sent
  over an established connection are not exposed to any webRequest event; there is no `filterResponseData`
  equivalent for WS frames. Firefox's own frame-inspection work lives in DevTools
  ([bug 927481](https://bugzilla.mozilla.org/show_bug.cgi?id=927481) / the WebSocket Inspector meta bug 885508),
  not in an extension API.
- Our HAR corroborates it: the one WebSocket entry
  (`wss://nexus-websocket-a.intercom.io/...`) is recorded as `status: 101 Switching Protocols` with only the
  handshake headers (`Upgrade`, `Sec-WebSocket-Accept`, `Sec-WebSocket-Extensions`) and **no** `_webSocketMessages`
  key. Firefox's HAR export — which is a superset of what webRequest exposes — carries no frames.
- Consequence: the existing `session-capture.ts` listener could learn that a wsv3 handshake happened and could
  read its request headers, but never the payload. A tap must be in the page.

### 5.c Background opens its OWN WebSocket to wsv3 with the captured token

Technically possible; strategically the worst option.

- **Permissions.** `wss://wsv3.fansly.com` is **not** covered by the current `host_permissions`
  (`*://fansly.com/*` and `*://apiv3.fansly.com/*` — `manifest.json:12-15`); it would need adding. (The blanket
  `optional_host_permissions: ["https://*/*"]` at `:16-19` could cover it after a grant, but that is the Hub-URL
  mechanism, not a place to smuggle a platform host.)
- **Origin.** A WebSocket opened from an extension background context sends
  `Origin: moz-extension://<per-install UUID>` — a per-installation random UUID, i.e. an unmistakable
  non-browser fingerprint *and* a UUID leak
  ([bug 1405971](https://bugzilla.mozilla.org/show_bug.cgi?id=1405971),
  [bug 1257989](https://bugzilla.mozilla.org/show_bug.cgi?id=1257989)). It cannot be overridden from the DOM API.
  Rewriting it would require blocking `webRequest.onBeforeSendHeaders` — which needs `webRequestBlocking`
  (not declared today) and is, functionally, header forgery to evade an origin check.
- **Does Fansly check Origin?** **Unknown and untested.** Our HAR has no wsv3 handshake at all, and testing it
  would mean an out-of-band connection to Fansly — precisely what `CLAUDE.md:53-57` forbids
  (*"a model ban is the failure mode"*).
- **Duplication.** A second authenticated socket per token, alongside the page's own. Its effect on
  `OnlineStatusService` (`ServiceIds: 8`) presence, on ack semantics (the page auto-acks certain messages), and on
  Fansly's own abuse heuristics is unknown. Two sockets acking the same messages is a real risk of
  *changing platform state*, not merely observing it.
- **Lifecycle.** The background is an MV3 **event page** and would drop the socket on suspension (see §5 lifecycle
  below). With no `alarms` permission there is not even a wake-up timer.
- **Verdict:** this converts the extension from a passive observer of traffic the browser was making anyway into an
  independent Fansly client with a forged-looking origin. It violates the repo's own egress rule and it is the
  option most likely to end in a ban.

### 5.d Hub-side connection holds the WebSocket

Clean in theory; **blocked on custody today**.

- The Hub has **no WebSocket code at all** — no `ws`/`socket.io`/`@fastify/websocket` dependency; the only `wsv3`
  strings in the repo are documentation (`reference/fansly_api_spec.md:17-18, 1619-1712`) and an unbuilt backlog
  item **FANSLY-005** (`backlog.md:524-538`), which itself says *«Формат сокета в нашем коде не снят — сначала один HAR»*.
  Its outbound story is entirely REST polling; its SSE endpoints (`/api/v1/events/stream`,
  `apps/runtime/src/modules/events/index.ts:119`) are *server → client*.
- Fansly is declared poll-only in the platform registry: `webhooks: false`, `presenceSource: "poll"`, `writes: []`
  (`apps/runtime/src/platforms/registry.ts:154-186`).
- **The blocking issue is the token.** The socket authenticates with `{"t":1,"d":"{\"token\":…}"}` — the same
  bearer the extension captures. The Hub would need that credential, and today **the extension never sends session
  material to the Hub** (§1.5). Whether the Hub's *own* Fansly credentials (the ones the pull lanes use) are valid
  for wsv3 is a separate question this lane cannot answer.
- Upside if solved: one connection per page instead of one per chatter browser; survives laptop sleep, Firefox
  restarts, and staff turnover; no client change at all; frames land directly next to the pull-lane observations
  with the existing capture-first discipline.

### 5.e Comparison

| | **(a) MAIN-world page tap** | **(c) Extension background opens its own WS** | **(d) Hub holds the WS** |
|---|---|---|---|
| **Feasible on Firefox as built?** | **Yes.** `world:"MAIN"` since FF128; repo floor is FF142; esbuild targets firefox128 | Yes technically; needs new `host_permissions` for `wss://wsv3.fansly.com` | N/A on the client; Hub has zero WS code today |
| **CSP exposure** | None — MAIN-world content scripts are not page-inserted script elements | None | None |
| **Reliability: tab closed** | **Dead.** No fansly.com tab → no socket → no frames | Survives (independent socket) | Survives |
| **Reliability: tab asleep / backgrounded** | Socket usually survives tab throttling, but frames only flow while the tab lives | Survives | Survives |
| **Reliability: Firefox closed / laptop asleep** | **Dead** | **Dead** | Survives |
| **Reliability: MV3 event-page suspension** | Frames buffer in the content script; a `runtime.sendMessage` wakes the background — but a suspension between tee and send loses the frame unless the content script buffers | **Fatal** — the socket dies with the event page and there is no `alarms` permission to revive it | N/A |
| **Duplication** | **Zero.** Observes the connection the browser already opened | **One extra authenticated socket per token** — unknown effect on presence/acks | One connection per page (replaces polling) |
| **Token exposure** | Token stays in the page where it already is; the tap must redact it before shipping frames | Token leaves the tab into the background and onto a new connection | Token must **leave the browser entirely** and be custodied server-side — new custody class |
| **Origin / fingerprint** | Genuine `https://fansly.com` origin, genuine browser | `Origin: moz-extension://<uuid>` — unspoofable without `webRequestBlocking`; leaks the install UUID | Server-chosen; equally unlike a browser, but the Hub already speaks to Fansly as a non-browser client on REST |
| **Presence side-effects** | None (passive) | Unknown; `OnlineStatusService` (id 8) is on this socket | Unknown; likely marks the model online |
| **Repo-rule compliance** | Compliant — *no new out-of-band request to Fansly* | **Violates** `CLAUDE.md:53-57` | Hub-side, outside the extension's rule |
| **Engineering effort (extension)** | **Small.** 1 esbuild entry, 1 manifest block, a postMessage bridge, a storage.local spool, an ingest kind | Medium; plus a permission prompt and a lifecycle fight it cannot win | **Zero** |
| **Engineering effort (Hub)** | Small: 1 new kind + canonicalizer family (ingest route already accepts it) | Same | **Large**: WS client, per-page connections, reconnect/backoff, token custody, presence policy |
| **Coverage** | Only pages a chatter has open, only while they work | Only while Firefox runs | **All pages, 24/7** |

### 5.f Recommendation

**Build (a) — a `world: "MAIN"` / `run_at: "document_start"` tap — as the near-term, technically sound option for
this extension, and treat it explicitly as a bridge to (d), not a destination.**

Why (a):

- It is the only option that adds **zero new Fansly egress**. It observes a connection the chatter's browser opens
  regardless, which is exactly what `CLAUDE.md:53-57` permits and what (c) violates.
- It is fully supported on the Firefox floor this extension already declares, with no CSP question to resolve, no
  new host permission, and no Xray gymnastics.
- The interception point is verified against the live bundle: a single `new WebSocket(this.uri_)` on the global
  constructor, with `onmessage`-setter handlers that compose with an added listener.
- The delivery machinery already exists in-repo (`acceptance-reporter.ts`) and the Hub route already accepts the
  batches with the extension's current credential.

Why not (c): unspoofable `moz-extension://` Origin, a second authenticated socket per token, unknown presence and
ack side-effects, a new host permission, and a lifecycle the MV3 event page cannot sustain without `alarms`. It is
the highest ban-risk option for the least reliability gain.

Why (d) is still the right end state: (a) is structurally incapable of covering nights, weekends, closed laptops,
or pages nobody is chatting on — and the value of an event feed is precisely that it does not depend on someone
watching. (a) buys freshness during shifts; only (d) replaces polling.

**Shipping frames to the Hub — concrete shape (all of this works with today's contract):**

- **Route:** the existing `POST /api/v1/ingest/observations`. Auth `apiKey` accepts the extension's device token
  (`packages/contracts/src/routes.ts:5521-5534`); `x-client-version` is already sent by `clientVersionHeaders()`.
- **Kind:** a new string, e.g. `fansly.ws_frame`. It will be accepted and journaled **immediately** but stored as
  `desktop.unknown:fansly.ws_frame` with `account_id: null` and no domain events, until a canonicalizer family and
  an `observation-kinds.ts` registry entry are added Hub-side
  (`apps/runtime/src/services/ingest-observations.ts:70-78`;
  `apps/runtime/src/services/canonicalize/client-capture.ts:30-49`). Land the kind first, canonicalize second —
  that is capture-first and it means no frames are lost while the Hub side is built.
- **Dedupe:** `clientEventId` UUID assigned once at enqueue and reused on resend, exactly as
  `acceptance-reporter.ts:38-41,199` does. Server key is `"<principalUserId>:<clientEventId>"`
  (`apps/runtime/src/services/ingest-observations.ts:206-208`). Consider deriving the UUID deterministically from
  a frame hash so two tabs on the same account collapse instead of double-journaling.
- **Batching:** ≤100 events/POST and ≤1 MiB/POST are hard server limits
  (`routes.ts:1834`; `apps/runtime/src/modules/ingest/index.ts:45-53`). At 120 req/min (IP-keyed!) the ceiling is
  ~12 000 frames/min per NAT — ample, but the IP keying means a busy office shares one bucket.
- **Spool: do NOT copy the acceptance spool's policy.** It is drop-oldest at 300 with a counter
  (`acceptance-reporter.ts:6-10, 20, 200-204`) because *"acceptance is recoverable signal, not custody-grade audit."*
  Business facts from a socket are the opposite — they are unrepeatable. A frame spool needs a never-drop or
  much larger bounded policy plus a loud alarm on overflow. `unlimitedStorage` is already granted
  (`manifest.json:8`).
- **Redaction:** strip the auth frame (`t:1` outbound carries the bearer). `research/ws-tap-snippet.js:7` shows the
  regex.
- **Honest gaps:** the tap must ship "socket was open from T1 to T2" markers so the Hub can tell "no events"
  from "nobody was watching". Without that, an event feed silently degrades into a worse poll.

---

## 6. Delivery guarantees today

| Data | Durable? | Where | Replay | Dedupe key |
|---|---|---|---|---|
| **Fansly session material** | **No** | in-memory `SessionStore` only (`session-store.ts:14-16, 62-64`) | none — dies with the worker | n/a |
| **AI acceptance events** | **Yes** | `storage.local` `acceptanceSpool` (`acceptance-reporter.ts:18`) | debounce 1 s + startup flush (`index.ts:176-180`); ≤5 attempts | `clientEventId` UUID, server key `<principalUserId>:<clientEventId>` |
| **Fan dossier (full recap)** | Partly | the summary itself is cached locally; the *sync* has an in-memory retry map `summarySyncRetryByKey` (`operations.ts:461-466`) with `SUMMARY_SYNC_RETRY_COOLDOWN_MS = 3 min` (`constants.ts:255`, applied `operations.ts:992-1001`) | **retry map is in-memory** — a worker restart forgets a pending sync; recovery is the opportunistic re-push on the next `refreshTabState` (`operations.ts:596-601`) plus a preflight that detects "already stored" and records the save without appending a duplicate (`operations.ts:1010-1030`) | Hub-side content preflight, plus `generatedAt` in `hasAgencyHubSyncMetadata` (`agency-hub-client.ts:989-1002`) |
| **Coach transcript** | No | in-memory session cache keyed (tabId, coachSessionId, accountId, groupId, count, transcriptEpoch) (`operations.ts:2205-2216`) | lost on suspension → next coach turn re-seeds `ceil(N/25)` pages | n/a |
| **Account presence** | Yes | `storage.local` `chatgoose:accountPresence` (`account-presence.ts:33`) | leading write, so the observation is already on disk (`account-presence.ts:16-27`) | last-write-wins per accountId |
| **Spenders status observations** | `storage.session` | `spenders-status-tracker.ts:5` | dies with the browser session, by design | keyed by hub+credential fingerprint |
| **Quota / ops counters** | `storage.session` / `storage.local` | `quota-tracker.ts:6`, `ops-daily.ts:6` | — | per page/day |

**What happens when the Hub is down or the laptop sleeps:**

- **Acceptance telemetry survives** and replays, with a visible drop counter if it overflowed 300.
- **Everything else that matters is not queued at all**, because nothing else is *captured* to begin with —
  the extension is a live reader, so "Hub down" degrades features (no dossier, no spenders board, no AI), it does
  not lose data. There is no Fansly-data queue because there is no Fansly-data capture.
- On the Hub side, dedupe is `(source='client_capture', "<principalUserId>:<clientEventId>")` enforced by the
  `observation_keys` primary key (`packages/db/migrations/0054_observations.sql:35-44`), so unbounded client
  resends are safe: an identical batch returns `{accepted: 0, duplicates: N}` and writes nothing.

**MV3 lifecycle — how the worker stays alive today.** The manifest declares no `alarms` permission, so there is no
timer-based wake-up. The mechanism is a **persistent content port with an auto-reconnect ladder**:
`src/content/bootstrap.ts:88-92` starts `startBootstrapKeepalive()` on every fansly.com page;
`src/content/bootstrap-keepalive.ts:1,32-67` connects `browser.runtime.connect({name:'chatgoose-bootstrap'})`
and **reconnects on disconnect** with delays `[100, 500, 1000, 5000] ms`; the background accepts those ports
without wiring the operational protocol (`src/background/index.ts:101-115`). The code comments claim
*"A persistent content port can keep this MV3 worker alive for a whole shift"* (`index.ts:72-74`) — MDN is blunter
(*"Message ports cannot prevent an event page from shutting down… the ports are closed when the event page idles"*),
so what actually happens is that the worker suspends and the content script's reconnect **resurrects it within
≤5 s**. In-memory state (`SessionStore`, the summary-sync retry map, the subscription/purchase caches) is lost each
time; the `setInterval` persona-catalog refresh loop (`persona-catalog.ts:33-45`, 5 min) dies with it and is
restarted by the startup path. **A frame spool for a WS tap must therefore be written to `storage.local` on the
content-script side or immediately on receipt in the background — not held in memory.**

---

## 7. Where the extension already assumes the Hub polls on a cadence

1. **The rule itself.** `CLAUDE.md:47-51` — *"the kernel's Fansly archive is pull-cadenced (~30min/24h). Do not
   'optimize' a live read into a kernel read — freshness is the product here."* This is the reason the AI feature
   lane ships a freshly paginated transcript instead of a `pageLabel` + conversation id.

1b. **The same assumption, stated three more times in code and in the decision log:**
   - `kernel-feature-gateway.ts:5-9` — *"Fansly has no webhook lane — the kernel archive is pull-cadenced
     30 min/24 h, while the panel reads the conversation live at generation time — so the request carries
     `clientContext` VALUES."*
   - `operations.ts:2735-2739`, at the prompt-build site — *"The client ships context VALUES because Fansly has no
     webhook lane — the kernel archive is pull-cadenced while this transcript was read live moments ago."*
   - `docs/decisions.md:136-139` (**decision E5**, index row at `:24`) — the same sentence, recorded as the
     architectural ruling. **An event-driven Hub makes E5 obsolete; it should be revisited by number, not silently.**

2. **Spenders board — user-visible copy.** `src/content/spenders/spenders-board-controller.ts:56-61`:
   > *"Spend data comes from the Agency Hub, which re-reads Fansly earnings on a schedule (roughly hourly to daily).
   > Refresh re-fetches the latest hub snapshot — **it cannot make the hub re-walk Fansly**. The freshness value is
   > the newest Hub observation for this page and window, not a timestamp shared by the shown rows; individual rows
   > may be older."*

   This tooltip is attached to both the subtitle and the **Refresh button** (`:411-413, 422`) precisely so a stale
   number *"never reads as a broken Refresh button"* (`:51-55`).

3. **Board meta line** (`spenders-board-controller.ts:465-481`) prints `newest Hub observation <relative>` +
   `shown rows may be older` + `fetched <relative>` — a deliberate **two-timestamp** design (decision E23,
   `docs/decisions.md:42`) separating "when the Hub last saw Fansly" from "when this client last asked the Hub".
   `relativeTime` (`:139-147`) formats `just now / Nm / Nh / Nd` — the `Nd` arm exists because multi-day staleness
   is expected.
4. **Stream-state copy for an empty board** (`:442-461, 680-694`): `flag_off`, `not_allowlisted`,
   `unsupported_platform`, and `ramped` with `Waiting for the first spender sync` /
   `0 spenders · synced <relative>` / `N failed sync attempts`. All four are Hub-pipeline states surfaced to the
   chatter — the board is explicitly a window onto a background sync, not a live read.
5. **`builtAt` semantics are documented as deliberately weak** (`spenders-service.ts:18-21`,
   `types.ts:1296-1305`): *"builtAt = max(observed_at) across the page/window projection, not 'now', not necessarily
   one of the returned top N, and not a coherent timestamp shared by every returned row."*
6. **The spenders board once cost ~150 Fansly calls per creator per 10 minutes** and was moved to the Hub for
   exactly that reason (`spenders-service.ts:1-8`) — the extension already traded freshness for egress here, and the
   30-min/24-h cadence is the price it pays.
7. **Recap freshness** — `COACH_RECAP_FRESH_MS = 24h` (`constants.ts:180-183`): a stored recap older than 24 h is
   considered stale and the auto-recap chain refreshes it (by re-paginating Fansly) before the first coach question.
   Consumed at `content/index.ts:222` (`recapSlotFresh`) and `:229+` (`hasFreshMatchingRecap`, which additionally
   requires a full recap to match the *current* `deepMessageCount`).
8. **Hub-vs-local recap arbitration assumes either copy may be newer** — `operations.ts:1043-1049`
   (*"another device re-scanned. Never supersede it with a stale body"*) and `:2117-2121`.
9. **No "needs-reply" feature exists in this extension.** Grep finds no `needsReply`/`needs-reply` in `src/`; that
   concept lives Hub-side. The nearest thing is a debug-only echo: `protocol.ts:367-372` carries the kernel's
   `contextManifest.transcript = {source, mode, archiveCount, unionCount, stale}` — i.e. **the Hub reporting how
   much of its own archive it merged and whether that archive was stale**. Visible only in debug mode; it is a
   ready-made observability hook for measuring the freshness win of an event feed.

**Net:** the extension has *already* absorbed the cost of a stale Hub in the one place it reads Hub data
(the spenders board), and it papers over the gap everywhere else by paying 4–120 Fansly page reads per operation.
An event-driven Hub would let items 2–5 drop their hedging copy and would let the AI feature lane stop shipping a
freshly paginated transcript — which is where the real Fansly-egress saving is (§3.5).

---

## Appendix — open questions this lane could not close

1. **fansly.com's document CSP** — not in the HAR (no main-document entry, zero CSP headers from any fansly host).
   Moot for `world:"MAIN"`, but unresolved for any `<script>`-injection fallback.
2. **Does wsv3 validate `Origin`?** No wsv3 handshake exists in any in-house capture; testing means touching Fansly.
3. **Does the Hub's own Fansly credential authenticate the wsv3 socket**, or is the page-derived bearer required?
   Determines whether option (d) needs a token-custody path from the extension.
4. **Presence side-effects of a second socket** (`OnlineStatusService`, id 8) — unknown.
5. **`t=2` discrepancy**: the live bundle dispatches `t=2` to `handlePingResponseEvent`, while
   `hub/reference/fansly_api_spec.md:1650-1656` documents `t=2` as `BatchMessages`. The spec doc is stale.
</content>
