# Findings catalogue — Fansly capture hardening (arena 2026-09-05/06)

Consolidated from both planners' plans, four cross-exchange rounds and the orchestrator's
own checks. **E** = evidence (code, HAR, public doc — cited), **V** = verified by the
orchestrator in the repo, **I** = inference. Line numbers refer to hub commit `582ef1cf`
and extension commit `1a74b811` (manifest 1.9.11). Nothing here is a credential; HAR
paths are listed only so an implementer can re-check shapes.

## 1. What the kernel sends today vs a real Fansly web client

| Aspect | Real Firefox 153 (session HAR 2026-08-19, E) | Kernel replay (V) |
|---|---|---|
| Transport | HTTP/2 over Gecko/NSS TLS (`X-Firefox-Spdy: h2`) | HTTP/1.1, `undici.Agent` without `allowH2`, OpenSSL ClientHello (`packages/shared/src/http-client.ts:14-45,129-141`) |
| Headers | Host, UA, Accept, Accept-Language, Accept-Encoding, Referer, `fansly-client-id`, `fansly-client-ts`, `fansly-session-id`, `fansly-client-check`, Origin, DNT, Sec-GPC, Sec-Fetch-*, authorization, Cookie, Priority, Pragma, Cache-Control, TE | UA…Referer, `fansly-client-ts`, Origin, DNT, Sec-GPC, Sec-Fetch-*, authorization (`packages/fansly/src/request-headers.ts:60-88`); identity headers only if the bundle carries them |
| Bundle on prod | — | owner: only `authorization` was ever pasted (answers §1) → no client-id, session-id, check, cookies |
| Cookies | 10 cookies incl. the auth token mirrored as a cookie and device cookies (`f-s-c`, `f-d`, `fansly-d`, …) | none (decision #234 "not fabricated") |
| CORS | one `OPTIONS` preflight per (path, header set); ~1:1 OPTIONS:GET | never |
| `fansly-client-ts` | cached `Date.now()` ± 5 s jitter, refreshed every 3 s, server-offset corrected (bundle `main.pretty.js:36298-36306`) | exact `Date.now()` per request (`request-headers.ts:72`) |
| Page sizes | `/messaging/groups` limit 20 (inbox) / 10 (filtered), `/message` 25, followers 100, transactions 10, `/account?ids=` ≤ 14 | `/messaging/groups` limit **100** (`executor-handlers.ts:2906-2907`), `/message` 25, followers 100, transactions 10, `/account?ids=` up to 100 |
| UA | moves with releases | constant string from 2026-08-21 (`request-headers.ts:8`) |

The kernel path uses its own dispatcher: `adapter.ts:2010` `getDispatcher(context.proxy)`;
`resolveEgress` is called only by vendor consumers (telegram, elevenlabs, egress-verify) —
**the Fansly read path does not go through `resolveEgress`** (V). Policy is the same
(page proxy mandatory, fail-closed: `page-context.ts:255`, `FanslyProxyMissingError`).

## 2. Fansly client internals (from the served bundle, HAR H4 entry 358, E)

- **`fansly-client-check` = `cyrb53(checkKey + "_" + pathname + "_" + deviceId).toString(16)`**,
  cached per exact pathname (`main.pretty.js:36386-36394`). Not per route family, not
  per request, no timestamp/method/query. Session HAR: 41 distinct pathnames ↔ 41
  distinct check values; Astra's offline recomputation matched **408/408** check-bearing
  requests across six HARs. The check key is obfuscated with a decoy first assignment and a
  later real one (public: prof79/fansly-downloader-ng#115; still true in the 2026-08-20
  bundle). Consequence: `FANSLY_CLIENT_CHECK_ROUTES` (7 families, `packages/shared/src/types.ts:166-174`,
  `request-headers.ts:28-57`) would reuse one path's digest on another path — wrong by
  construction; harmless today only because no check is sent.
- **`fansly-client-id`** = server-issued device id (`GET /device/id`, bundle `:13131`,
  persisted as `device_id`); **`fansly-session-id`** = the login session id; session model
  `{id, accountId, deviceId, token, metadata}` stored in `localStorage.active_session`
  (`:13008-13030, 13689-13698`). Login: `POST /login {username, password, deviceId}`,
  2FA `POST /login/twofa {token, code}`, e-mail flows under `/login/email/*` (`:13415-13470`).
- **AWS WAF integration is wired but dormant**: `AwsWafIntegration`, on-demand load of
  `…edge.sdk.awswaf.com/…/challenge.js`, token service with a 5-min skip window, request
  interceptor that waits for a token (`:13276-13472`). No `challenge.js` request and no
  `aws-waf-token` cookie in any HAR. An hCaptcha widget exists for a verification form.
  `apiv3.fansly.com` responds via CloudFront (`via`, `x-cache`, `x-amz-cf-pop`, `server:
  Fansly Api Gateway`). Not Cloudflare.
- **Sessions are tracked with IP/geo**: `GET /api/v1/sessions` returns per-session
  `{ip, locationData{city,stateCode,zipCode,countryCode,ip}, lastUsed, status}`; the
  owner's account showed 29 sessions, 15 distinct IPv4, last-used span 526 days (UI-walk
  HAR). Sessions are long-lived.
- **Management sessions are first-class**: `GET /management/managementsessions` →
  `{accountId, createdAt, id, label, lastUsedAt, metadata, sessionId, status, token,
  version}`; `GET /management/managers` → `{accountManagers, accounts}`; the session model
  has `isManagementSession()`. Chatters use these (own accounts via manager link). Public
  doc: https://help.fansly.com/en/articles/12328641-management-sessions (permission-limited;
  payouts and other sensitive areas restricted).
- **WebSockets**: `wss://wsv3.fansly.com?v=3` (bundle `:20022`) and chat
  `wss://chatws.fansly.com?v=3` (`:253422`). The session id does NOT depend on the socket in
  the current client (it comes from `/login`); the older WS handshake in
  fansly-downloader-ng is obsolete.
- **A live tab writes**: UI-walk HAR has 14 × `POST /api/v1/message/ack` (`messageIds/type`),
  7 × `POST /api/v1/status` (`statusId`), plus `/it/pis`, `/it/mois`, `/it/fyp`,
  `metrics.fansly.com/event/track`, intercom, leaderboard. The app queues **delivery**
  acknowledgements while loading unread messages and sends **read** acks when the active
  group matches and the document has focus (bundle ≈ chars 619704, 622315, 631396);
  `setStatus` ≈ 675790 is a presence mutation. Acks fire in runs with no preceding
  `GET /message` → an open connected tab acks without a human opening conversations.
  `GET /message` alone is not an ack (the kernel has sent it daily for months; I).
- **Real client request rate**: UI-walk HAR: 129 API calls in 100 minutes; peaks 24/min for
  two minutes while clicking stats, otherwise 0–5/min.

## 3. Kernel code seams an implementer will touch (V unless noted)

- Single raw fetch of the adapter: `packages/fansly/src/adapter.ts:2006-2011` (raw-fetch
  budget item; `scripts/raw-fetch-budget.json`). Retry core `:1949-2100`: 429/5xx up to 3
  in-request retries with `Retry-After`/backoff; 401/403 no retry (`:2056-2070`);
  transport error rotates the dispatcher (`:2019-2040`). In-process pacing
  `waitForRateLimit` `:2212-2262` (`fanslyDefaultDelayMs` 2500 + 100 ms,
  `config-registry.ts:115`); with `syncSharedRateLimitEnabled` off the adapter uses
  in-process chains, so any admission hook must live in `request()` itself.
- `parseRetryAfterDelayMs` clamps to `MAX_RETRY_DELAY_MS = 60_000`
  (`packages/shared/src/http-client.ts:20,546`). Extension clamps its own to 5 s
  (`fansly-ext/src/background/fansly-client.ts:398`, retries 429 up to 3×).
- Rate limiter: `packages/db/src/repositories/sync.ts:2708` reserves/advances
  `next_available_at` under row locks; `services/sync/rate-limiter.ts` sleeps outside the
  transaction; advancing the timestamp after a 429 does not revoke earlier reservations →
  a separate `cooldown_until` is needed (Astra, E).
- **Cadence trap**: `SYNC_STREAM_POLICY` constants (`packages/db/src/repositories/page-sync.ts:176-455`;
  dm_conversations 1800 s / SLA 3600 s `:253-262`; domain `messages_live` SLA 3600 `:469-473`)
  are shared across platforms. `ensurePageSyncStates` rewrites `cadence_seconds` and
  `slot_offset_seconds` on existing rows (`:1593-1613`) but not `last_scheduled_slot`;
  `scheduleDuePageSync` skips while `currentSlot <= lastScheduledSlot` (`:1930-1944`),
  `currentSlot = floor((now-offset)/cadence)`. Raising the cadence without rebasing the
  slot strands the stream for centuries (1800-s slot ≈ 993 696 vs 7200-s slot ≈ 248 424
  at 2026-09-06). Rollback direction is safe. Missed slots are never replayed
  (`:1936-1952`).
- Health coupling: `services/sync-status.ts:1029-1039` and `services/health.ts:257,297-299,355-376`
  compare `succeeded_at` age with `freshnessSlaSeconds`; `scripts/deploy-production.sh:1000,1586`
  gate on `/api/v1/health/sync`; tests pin 1800 at `tests/api.integration.test.ts:663,1267,9645-9655`.
- DM sweep: full-scan generation per run (`executor-handlers.ts:2830-2845`), 100/page,
  `sortOrder=1&flags=0`; rows stamped `lastSeenGeneration`/`isVisible` (`:3320-3321,3399-3400`);
  destructive visibility pass only when `count(last_seen_generation = generation) ==
  observedCount` with a provider total (`:3446-3465`, decision #214); `/group/:id` only
  when the list lacks/contradicts the partner id (`:3113-3118`); head repair `getMessagesPage
  limit 1` (`:3183-3190`); moved head → `dm_messages` follow-up queued (`:3583-3590`).
  `page-dm.ts:164-240`: passing `lastSeenGeneration: null` preserves an existing stamp
  (monotonic conflict update) — the primitive a head-only writer needs; the visibility
  update at `page-dm.ts:247` has no recent-touch exemption.
- Followers: incremental walk with known-checkpoint stop (`:1863-2122`); lilly-2 still
  spends ~79 follower pages/hour — unexplained, stage 0 item.
- `fan_earnings`: keyset walk of fans with positive spend, two calls per fan
  (`:4369-4509`); cursor advances only through a contiguous successful prefix; a failed
  monthly call repeats the preceding stats call. Only consumer: the extension spenders
  board via `GET /pages/:label/top-spenders` (`modules/audience/index.ts:123-137`,
  `message-archive.ts:1586-1640`); insights read `revenue_*` tables, agent dataset
  `fan_earnings` is planned-only (`agent-read-datasets.ts:865-886`). Stage 16 chose daily
  because stats move slowly (`stage-16-fansly-earnings-ppv-streams.md:57`).
- Notifications: forward poll from the head until overlap, up to 20 pages × 50, own daily
  attempt cap, type-filter fallback (`fansly-notifications.ts:103,730-803`).
- Capture trims before `persistRawPayload` are deliberate and decision-recorded:
  `trimFanslyMessagingGroupsPayload` (`shared.ts:526`, 9 list fields kept, `accounts[]`
  allowlisted to 18 fields — decision #224, ~11:1 dedup at the time), followers `:439`,
  notifications `:357` + `fansly-notifications.ts:39-47`, catalog/post-replies `:385,432`;
  `dm_messages` journals `page.raw` untrimmed (`shared.ts:520-525`).
- Existing Playwright: `apps/runtime/src/services/onlyfans-public-profiles.ts:102-116,253-258`
  builds proxy launch options for Chromium; `Dockerfile:97` installs only the Chromium
  shell; `startup.ts:45-77` roles (api/worker/scheduler). Playwright 1.60
  `normalizeProxySettings` throws on SOCKS5 with username/password for every engine →
  a per-page loopback tunnel is required.
- Credentials: `packages/contracts/src/routes.ts:3166` (`fanslyCredentialsSchema`), paste
  form `apps/dashboard/src/pages/settings/PlatformCredentialsFields.tsx:35-66`,
  `services/page-onboarding.ts`, `page-context.ts:103-118` (encrypted bundle),
  `connections.ts:updatePageCredentials`; credential routes are owner-session only
  (`routes.ts:7656-7737`). The extension never pushes credentials to the kernel
  (`fansly-ext/src/background/agency-hub-client.ts` has no such call).
- Incident kinds enum: `packages/db/src/schema.ts:234-257` (no challenge kind yet).
- Quiet hours: no mechanism; only `pauseSyncBlock` (`services/sync-blocks.ts:453`).

## 4. Extension facts (fansly-ext, E)

- Captures session material from the chatter's own tab traffic (`session-capture.ts:4,14,95`),
  keeps it in an in-memory `SessionStore` (`session-store.ts:15,24,139`; recapture refreshes
  creds in place but keeps old route checks), uses `routeChecks[family] ?? latestCheck`
  for its own background GETs (`fansly-client.ts:341-400`; cross-route fallback). It calls
  the kernel only for AI generations (SSE, `clientContext` carries the live transcript),
  voice notes, recap status, top spenders, fan dossier get/push, persona catalog, AI
  usage batches, page resolution, health/identity, device tokens. It reads no kernel DM
  data. Manifest: Firefox-only, gecko ≥ 142.

## 5. Freshness consumers of the kernel's Fansly copy (orchestrator research, V)

Nothing chatter-facing depends on it: AI features use `clientContext`
(`modules/ai/features/index.ts:345-386`, `routes.ts:2164-2170`). Telegram sends only the
daily money report and incident latches (`notification-incidents.ts:80-118`). Agent Read
Plane promises no freshness. Workboard v2 reads `page_dm_threads`/`page_dm_messages` and
treats the sync as lagging by design (`docs/workboard-v2-priority-design.md:376-386`).
Dossier lookup keys on `page_dm_conversations` rows created by the sweep; push 404s for an
unseen fan (`services/fan-profiles.ts:107-146`). Owner accepted a 2–4 h archive lag.

## 6. Production facts (read-only snapshot 2026-09-05, V)

Six Fansly pages (lora-1/2/3, lilly-1/2, ari-1). Pull observations/day: lilly-2 11 199
(dm_conversations 6 465, followers 1 889, fan_earnings 2 × 1 005), lora-1 6 974, lora-2
4 517, lora-3 3 789, lilly-1 2 342, ari-1 451; total ≈ 29 272 (204 904 / 7 days).
dm_conversations = 51 %, followers 14 %, fan_earnings 20 %, dm_messages 2.4 %,
notifications 1.6 %. Hourly totals 700–2 400 with midnight-UTC spikes; no diurnal shape.
`page_sync_states`: pending notifications/media_stats on several pages, ari-1
`purchase_history` blocked `provider_bad_data`. 0 × 429 and 2 × 401 in 14 days (backlog).
`config_settings`, runs and domain_events are not readable by the `read_only` role. Full
tables: `reference/prod-facts-2026-09-05.md`.

## 7. Browser candidates (dossiers, `cross-4/`, E unless noted)

- Playwright Firefox 150.0.2 (Juggler): patches (`browser_patches/firefox/patches/bootstrap.diff`)
  touch request interception (`nsHttpChannel.cpp`, `InterceptedHttpChannel.cpp`) and cert
  overrides, not NSS/HTTP2; `Navigator::Webdriver()` hard-coded `true`, no pref removes it;
  no CDP artefacts; long-session memory growth issues (playwright#4434, #12464, #38864).
- Stock Firefox via BiDi (`moz-firefox`): `webdriver=true` whenever RemoteAgent runs;
  BiDi cannot read bodies, intercept WebSockets or set a per-context proxy
  (playwright#32577) → cannot implement default-deny capture mode today.
- Chrome Stable (`chrome` channel) / Playwright Chromium (Chrome for Testing 148, unpatched):
  `webdriver` removable (`--disable-blink-features=AutomationControlled`,
  `ignoreDefaultArgs:['--enable-automation']`); the classic CDP `Runtime.enable` leak was
  closed in V8 for Chrome M137 (DataDome 2024 write-up; Castle 2025); other CDP side channels
  reportedly survive, undocumented; primary Playwright engine; CDP screencast for remote
  view; Chrome auto-update must be disabled; `--disable-dev-shm-usage` in Docker.
- Both: run `challenge.js` unattended; AWS WAF tokens carry "indications of automation and
  browser setting inconsistencies" (docs.aws.amazon.com/waf/…/waf-tokens-details.html);
  `TGT_SignalAutomatedBrowser` answers CAPTCHA, not block; headed Xvfb → software WebGL
  (llvmpipe/SwiftShader) is a server tell for either; no packet-level TLS/H2 parity was
  measured for any candidate. Owner chose Chrome (no AWS account for the WAF spike).

## 8. Commercial tools (public docs, E) — patterns, not safety proof

- OnlyFansAPI Fansly connector: username/password + 2FA challenge (e-mail on new IP or
  authenticator) + managed dedicated mobile/residential proxy per account or custom proxy
  (`reference/ofapi-fansly-start-authentication.md`; proxies doc: no datacenter,
  consistent geolocation).
- apifansly.com: login + e-mail 2FA + managed proxy country.
- OnlyMonster: own browser, single IP per account, SOCKS5, profile isolation
  (docs.onlymonster.ai/onlymonster-browser/*).
- Infloww: dedicated proxy per creator, creator credentials entered in Infloww's client,
  currently advises disabling 2FA for Fansly (help.infloww.com/…/324832).
- None replays a pasted token from a server-side HTTP client. None publishes ban statistics.

## 9. Owner-supplied facts (answers.md)

Bundle pasted by hand from the owner's own browser Network tab, one token only; that
browser is still open and used. Each page has its own US residential proxy (provider,
rotation unknown). Chatters join via Fansly manager links (own accounts), work from home
in Firefox + extension through the page's proxy. No bans, restrictions, e-mails or
challenges observed ever. E-mail and authenticator for every account are with the owner.
5–8 pages, no more. Decisions: Chrome; login as model; chatters stay in their own tabs;
fan_earnings daily; no stored password; no quiet hours; separate host, sized after a spike.
