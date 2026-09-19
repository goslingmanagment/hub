# Plan — Fansly capture hardening (Fable, phase 3)

Date: 2026-09-06. Read-only planning; nothing here was executed. Every claim about the
current system cites a repo path; claims about Fansly's server side are marked
**evidence** (observed in a HAR, a response, or public source) or **inference**.
No credential, device id, session id, cookie value or check value appears in this file;
where a value matters, only its shape or length is given.

## 1. Summary

Today the kernel replays the OWNER'S PERSONAL Fansly session from a Node/undici HTTP/1.1
client behind each page's US residential proxy, while the owner keeps using that same
session from his own machine. Production pages carry only the `authorization` token
(answers §1), so every kernel request is shaped like nothing a real Fansly client ever
sends: no device id, no session id, no per-path check, no cookies, no CORS preflight, an
OpenSSL TLS handshake under a Firefox 153 user agent, and a 2.6-second metronome that runs
24/7 and full-scans every conversation list every 30 minutes. Fansly tolerates it today
(no 429s, two stray 401s in 14 days), which is evidence of tolerance, not of safety: the
web client already ships the AWS WAF challenge SDK wiring (dormant), Fansly records the
IP, city and last-use time of every session, and the kernel's replay is the only actor in
the whole setup whose identity is inconsistent.

Recommendation: **option F, a hybrid built around option B** — a kernel-owned, persistent,
real Firefox profile per page ("page browser"), logged in ONCE as the model (or as a
dedicated manager account, owner's choice) from inside the page's proxy, driven by the
kernel so that every Fansly read is executed from the page's own origin with the app's
own identity headers, cookies, TLS and HTTP/2. The extension and the chatters' manager
sessions stay exactly as they are. Before any transport work, ship the traffic-shape
reform (stage 1): the DM sweep becomes head-incremental at a 3-hour cadence, the follower
and fan-earnings walks stop re-reading what has not changed, all bulk lanes get jitter and
optional quiet hours, and a 429 stops the page instead of being retried. Stage 1 alone
removes roughly 80–90% of today's volume and is verifiable from telemetry without touching
Fansly beyond normal capture.

The pasted owner session is retired at stage 4; the Node replay path stays as the
rollback transport until then and is deleted afterwards (raw-fetch ratchet 10 → 9).

## 2. Diagnosis of the current implementation

### 2.1 What the kernel sends today (verified shape)

Header plan built by `packages/fansly/src/request-headers.ts:60-88`; identity headers are
conditional on bundle fields; production bundles carry only `authorization` (answers §1).

| Real Firefox 153 API GET (session HAR 2026-08-19, `X-Firefox-Spdy: h2`) | Kernel replay today |
|---|---|
| HTTP/2 over TLS from NSS (Firefox ClientHello) | HTTP/1.1, `undici.Agent` with no `allowH2` (`packages/shared/src/http-client.ts:14-45`, 129-141); OpenSSL ClientHello |
| `Host, User-Agent, Accept, Accept-Language, Accept-Encoding, Referer, fansly-client-id, fansly-client-ts, fansly-session-id, fansly-client-check, Origin, DNT, Sec-GPC, Sec-Fetch-*, authorization, Connection, Cookie, Priority, Pragma, Cache-Control, TE` | `user-agent … referer, fansly-client-ts, origin, dnt, sec-gpc, sec-fetch-*, authorization` (no client-id, session-id, check, cookie, priority, pragma, cache-control, te) |
| `Cookie` with 10 cookies incl. the auth token mirrored as a cookie and two device cookies (names `f-s-c`, `f-d`, `fansly-d`, plus version/ts/analytics cookies) | no cookies ("not fabricated", decision #234) |
| One `OPTIONS` preflight per (path, header set) before the first GET (HAR: preflight `Access-Control-Request-Headers` lists the five custom headers; 1:1 OPTIONS:GET on most API paths) | never sends OPTIONS |
| `fansly-client-ts` = cached `Date.now() ± 5 s` jitter, refreshed every 3 s, corrected by server time offset when drift > 30 s (bundle `main.pretty.js:36298-36306, 36376-36384`) | exact `Date.now()` per request (`request-headers.ts:72`) |
| `fansly-client-check` = `cyrb53(checkKey + "_" + pathname + "_" + deviceId).toString(16)`, cached per exact pathname (bundle `:36386-36394`); HAR: 41 distinct pathnames → 41 distinct check values | absent; when present the kernel maps by ROUTE FAMILY (`request-headers.ts:28-57`), which would reuse one path's digest on another path (e.g. every `/group/{id}/`) |
| `fansly-client-id` = server-issued device id (`GET /device/id`, bundle `:13131`, stored as `device_id`) and `fansly-session-id` = the login session id (`/login` body carries `deviceId`; session model `{id, accountId, deviceId, token, metadata}` `:13008-13030, 13415-13420`) | absent |
| Page sizes: `/messaging/groups` limit 20 or 10, `/message` 25, `/account/{id}/followersnew` 100, `/account/wallets/earnings/transactions` 10, `/account?ids=` ≤ 14 ids | `/messaging/groups` limit **100** (`executor-handlers.ts:2906-2907`), `/message` 25, followers 100, transactions 10, `/account?ids=` up to 100 (`adapter.ts:ACCOUNT_MEDIA_BATCH_SIZE`) |

Everything in the left column is **evidence** from the local HARs and the served bundle.

### 2.2 Identity consistency

1. **The token is a personal session used from two places.** The owner's browser is still
   open on the same session (answers §2). Fansly keeps a per-session record with `ip`,
   `locationData {city, stateCode, zipCode, countryCode, ip}`, `lastUsed`, `status`
   (`GET /api/v1/sessions` in the UI-walk HAR: 29 sessions on the owner's account, 15
   distinct IPv4 addresses, last-used span 526 days) — **evidence** that Fansly stores and
   surfaces IP/geo per session. The replay therefore makes one session alternate between
   the owner's location and a US residential IP, with the proxy-side requests missing the
   device and session headers the browser-side requests carry. Severity: the single
   strongest anomaly in the setup; also the single easiest for Fansly to act on (revoke a
   session). Whether Fansly correlates this today: **unknown**.
2. **No device identity at all.** A real client never sends an API request without
   `fansly-client-id`/`fansly-session-id` (HAR: present on every API GET; the CORS
   allow-list returned by the gateway names them, plus short aliases `fy-d`, `fy-ts`,
   `fy-s`). Decision #44 ("only authorization required") and the Stage 6 probe (#62)
   proved the server ACCEPTS such requests; they say nothing about whether it scores them.
   **Inference:** a request class that is 0% of organic traffic is the cheapest possible
   bot signature.
3. **TLS/HTTP fingerprint contradicts the User-Agent.** Node cannot reorder TLS extensions
   or add GREASE (public: HTTP Toolkit article; undici issue #1983), so the JA3/JA4 of the
   replay is "Node/OpenSSL" while the UA says Firefox 153, and the request is HTTP/1.1
   while every Firefox request to this host is h2. `apiv3.fansly.com` is fronted by
   CloudFront (HAR response headers `via: …cloudfront.net`, `x-cache`, `x-amz-cf-pop`;
   `server: Fansly Api Gateway`) — **evidence**. CloudFront can forward JA3/JA4 to AWS WAF,
   and WAF rate rules can aggregate on them (public AWS docs) — **evidence of capability,
   not of use**.
4. **The web client is pre-wired for AWS WAF challenges.** The bundle loads
   `…edge.sdk.awswaf.com/…/challenge.js` on demand, has a token service with a 5-minute
   skip window and a request interceptor that waits for a WAF token before sending
   (`main.pretty.js:13276-13400`). In the 2026-08-19/21 HARs no `challenge.js` request and
   no `aws-waf-token` cookie appear, and no request pipeline attaches the interceptor
   (**evidence: dormant**). An hCaptcha widget exists for a verification form. Implication:
   Fansly can turn on a JS challenge on any route with a WAF config change; a non-browser
   client fails instantly and today's code would classify the challenge body as a generic
   `provider`/`http` failure with no dedicated incident (`packages/fansly/src/adapter.ts:2056-2140`).
5. **Fixed UA drifts.** The UA string is a constant from a 2026-08-21 capture
   (`request-headers.ts:8`); real Firefox users move to new versions within weeks, so the
   replay's UA ages while its (already wrong) TLS stays constant.
6. **`fansly-client-ts` shape.** Exact millisecond `Date.now()` per request versus the
   app's jittered, 3-second-cached, server-corrected value: a low-weight but clean
   statistical tell.

### 2.3 Network identity

- Per-page dedicated residential US proxy, fail-closed egress (`apps/runtime/src/services/egress/resolver.ts:59-121`,
  `page-context.ts:236-260`, decision #124) — **good**. Chatters ride the same page
  proxy with their own manager sessions (answers §4) — consistent with how agency
  tooling works (OnlyMonster: "all team members using a single IP … assigned to the
  account"; Infloww: "unique proxy per creator").
- Proxy type, provider, rotation and exclusivity are not recorded or checked anywhere
  (`packages/shared/src/proxy-string.ts:5` accepts any http/https/socks5; backlog
  FANSLY-007). A rotating residential IP would move the session between IPs hourly
  without anyone noticing; only the CLI `page proxy-ip` (`apps/runtime/src/cli.ts:280-360`)
  can show the exit IP, and nothing samples it over time.
- The only entity with an inconsistent network identity is the owner's session (see 2.2.1).

### 2.4 Request patterns (production, 7 days to 2026-09-05)

| Page | calls/day | dm_conversations | followers | fan_earnings (2 calls/fan) | rest |
|---|---:|---:|---:|---:|---:|
| lilly-2 | 11 199 | 6 465 (58%) | 1 889 (17%) | 2 010 (18%) | ~830 |
| lora-1 | 6 974 | 3 579 (51%) | 797 | 1 666 | ~930 |
| lora-2 | 4 517 | 1 928 | 584 | 1 250 | ~750 |
| lora-3 | 3 789 | 1 526 | 671 | 792 | ~800 |
| lilly-1 | 2 342 | 1 411 | 213 | 196 | ~520 |
| ari-1 | 451 | 48 | 25 | 10 | ~370 |

Source: `reference/prod-facts-2026-09-05.md` (observations per kind).

- **Metronome.** In-process pacing is `fanslyDefaultDelayMs` 2500 + 100 ms
  (`adapter.ts:2252-2262`, `config-registry.ts:115`), so a chunk of up to five requests
  (`sync/chunk-budget.ts:10`) fires at exactly 2.6 s spacing, and a busy page sustains
  24 req/min for most of the day (backlog: lilly-2 active 70% of minutes). The real
  client in the UI-walk HAR made 129 API calls in 100 minutes: peaks of 24/min for two
  minutes while clicking through stats, otherwise 0–5/min.
- **Full scans no human does.** `dm_conversations` restarts a `full_scan` generation on
  every run (`executor-handlers.ts:2830-2845`), 48 runs/day, ~135 pages of 100 for
  lilly-2 ≈ 13 500 conversations re-read every 30 minutes; the app reads 20 at a time and
  only when the inbox is opened. `fan_earnings` calls two per-fan statistics routes for
  EVERY known fan daily (`executor-handlers.ts:4434-4449`); the app calls them only when
  a fan's earnings card is opened. `followers` is written as an incremental walk with a
  known-checkpoint stop (`executor-handlers.ts:1912-1990`) yet lilly-2 spends ~79 follower
  pages per hour — either the stop is ineffective or the 48-hour reconcile shares the
  observation kind; to verify in stage 0.
- **No diurnal shape.** Hourly totals over 48 h sit between 700 and 2 400 with midnight
  UTC spikes (daily lanes), while the owner's own browser traffic follows a workday.
- **Page-size mismatch.** `/messaging/groups?limit=100` versus the app's 20/10.
- `ngsw-bypass=true` on every URL matches the app (`adapter.ts:1982`) — fine.

### 2.5 Session lifecycle

- Provisioning: manual paste from the owner's DevTools into the dashboard form
  (`apps/dashboard/src/pages/settings/PlatformCredentialsFields.tsx:35-66`); only
  `authorization` was ever filled (answers §1). The extension never pushes anything to the
  kernel (no such call in `~/code/goose/fansly-ext/src/background/agency-hub-client.ts`;
  credential routes are `owner-session` only, `packages/contracts/src/routes.ts:7656-7737`).
- Death: 401/403 blocks the stream, pauses the whole page and opens `auth_blocked`
  (`sync/executor.ts:768-830`, `pausePageSyncForAuth`) — **good, fail-closed**. Recovery
  is a re-paste (`services/connections.ts:updatePageCredentials`), again from the owner's
  live session. The Stage 6 "check longevity" measurement was never closed (decision #62).
- Sessions on Fansly appear long-lived (526-day span in the sessions list), so a pasted
  token can silently run for months, and the two 401s in 14 days have no root cause on
  record (answers §2).

### 2.6 Error handling

- 429/500/502/503/504: up to three in-request retries with `Retry-After` or exponential
  backoff (`adapter.ts:2090-2100`, `http-client.ts:571-575`), then a stream-level retry
  ladder 60 s → 30 min (`packages/db/src/repositories/page-sync.ts:resolveRetryDelayMs`).
  Retrying a 429 three times inside a minute is mildly abusive; a real client shows a
  toast and stops.
- 401/403: no retry (`adapter.ts:2056-2070`) — correct.
- Transport error: dispatcher rotated (new TLS session) and retried with 5 s × attempt
  jitter (`adapter.ts:2019-2040`) — fine.
- Blind spots: a WAF challenge page, an HTML interstitial or an empty 202 has no
  classification and no incident kind (`notification_incident_kind` enum,
  `packages/db/src/schema.ts:234-257`); a 401 burst across several pages at once (the
  "Fansly enabled a check" signal) is not distinguished from one page's dead token.

### 2.7 Latent platform facts that shape the options (all evidence from HARs/bundle)

- Management sessions are first-class: `GET /management/managementsessions` returns rows
  `{accountId, createdAt, id, label, lastUsedAt, metadata, sessionId, status, token, version}`;
  `GET /management/managers` returns `{accountManagers, accounts}`; the session model has
  `isManagementSession()`. Chatters already use these (answers §4). A kernel identity can
  therefore be "one more manager" instead of "the model's own session".
- The web client keeps a WebSocket to `wss://wsv3.fansly.com?v=3` (bundle `:20022`) and a
  chat socket `wss://chatws.fansly.com?v=3` (`:253422`); the kernel opens neither.
- Login is `POST /login {username, password, deviceId}` with 2FA continuation
  `POST /login/twofa {token, code}` (`:13415-13470`); e-mail verification and password
  flows exist under `/login/email/*`.

### 2.8 What is fine today

Per-page proxy with fail-closed refusal; capture-first journaling of every body; no
writes at all (adapter has no POST; the `/postreply/verify` POST is deliberately never
issued, `fansly-endpoint-probe.ts` header comment); auth failure parks the page instead of
hammering; daily call budgets on the bulk lanes (`config-registry.ts:185-243`); one
attempt reserved before egress (decision #235); chatters and the owner are separate,
real identities.

### 2.9 Risk table

| # | Finding | Kind | Severity (ban/restriction) | Fixed by |
|---|---|---|---|---|
| 1 | Owner's personal session replayed from a second IP/geo without device headers | evidence + inference | **High** (session-level revoke is a one-click action for the platform) | own identity per page (stages 2–4) |
| 2 | No client-id/session-id/check/cookies/preflight on any request | evidence | **High** as a signature; tolerated today | real browser transport (stage 3) |
| 3 | Node TLS + HTTP/1.1 under a Firefox UA | evidence | **Medium** today, **High** the day WAF fingerprinting/challenge is enabled | stage 3; challenge detection (stage 1) |
| 4 | 24/7 metronome, 30-min full scans, per-fan daily statistics, 11k calls/day on one page | evidence | **High** (behavioural; the pattern commercial tools avoid) | stage 1 |
| 5 | Route-family check reuse would be wrong if ever loaded | evidence | Low today (nothing loaded) | delete with stage 4 |
| 6 | 429 retried in-request | evidence | Low–Medium | stage 1 |
| 7 | Proxy type/rotation unrecorded | evidence | Medium (unknown = unmanaged) | stage 0/1 |
| 8 | No challenge/interstitial classification, no multi-page 401 latch | evidence | Medium (blindness, not a ban cause) | stage 1 |

## 3. Options

Common structure for each: how it works · needs · pros · cons · ban-risk rating with
reasons · data completeness/freshness · operational burden · cost · effort and sequence
in this codebase · hard rules touched.

### 3A. Harden the Node replay path

**How.** Keep `FanslyAdapter` as the client. Add: exact header parity including the cookie
jar, the `OPTIONS` preflight, jittered `fansly-client-ts`; compute `fansly-client-check`
per exact pathname with cyrb53 and a check key extracted from the served `main.js`
(AST walk, last assignment wins — the public fansly-scraper `helpers/checkkey.py`
approach); obtain a kernel-owned device id via `GET /device/id` and a kernel-owned
session via `POST /login` (+ 2FA) so the owner's session is no longer shared; replace
the TLS/H2 layer with a browser-fingerprint transport — a `curl-impersonate` sidecar with
a Firefox target, or a Go `uTLS` sidecar (Node itself cannot reorder extensions; the
pure-JS `hellojs` project only clones Chrome).

**Needs.** A sidecar binary in the image (or a Rust/Go helper process), a check-key
extractor that survives Fansly's deliberate decoys (public issue #115: the first
assignment is a honeypot, the real key is assigned later), a UA/TLS pair that is
re-pinned on every Firefox release, and a login flow that may meet the WAF challenge and
hCaptcha (both wired in the bundle, dormant now).

**Pros.** No new runtime, smallest RAM, keeps all lane code; the kernel gets its own
identity.

**Cons.** It is an impersonation arms race against a platform that already plants decoys
in its bundle; every Firefox release changes the target; a challenge flip breaks it with
no JS engine to answer; the `OPTIONS` + cookie + priority header emulation has to be
maintained by hand; still a synthetic client behind residential IPs — exactly the class
OFAPI-style vendors advertise they do NOT use for their own products ("no headless
browsers" is their claim about integrations, not about Fansly).

**Ban risk: Medium** (down from High) while the impersonation is current, **High** on
the first day it lags a Firefox release or a WAF change; the failure is silent until a
challenge appears. **Completeness/freshness:** unchanged. **Ops:** re-pin per Firefox
release, monitor decoy changes, re-login on session death (2FA by owner). **Cost:** ~0
infra. **Effort:** 3–5 weeks: `packages/fansly/src/request-headers.ts` (full parity,
preflight), a `packages/fansly/src/check-key.ts`, `packages/shared/src/http-client.ts`
(sidecar dispatcher), `services/page-onboarding.ts` (login flow), tests for parity and
decoy handling. **Hard rules touched:** egress through the resolver (sidecar must be a
dispatcher, raw-fetch budget unchanged), capture-first (unchanged), staged flags.

### 3B. Kernel-driven real Firefox per page ("page browser")

**How.** A new runtime role `browser` (same image, `apps/runtime/src/startup.ts:45-77`
gains a fourth role) runs one persistent Firefox profile per Fansly page via Playwright,
launched with the page's proxy from `egress_endpoints` (Playwright `proxy:{server,
username, password}`, `services/onlyfans-public-profiles.ts:102-116` already builds this
shape for Chromium). The owner logs in ONCE per profile as the model (or as a dedicated
manager account) through a remote screen; the profile keeps `active_session`,
`device_id` and cookies. The kernel's adapter routes each read to the browser role over
a loopback/docker-network HTTP API; the browser executes `fetch` from the `fansly.com`
origin inside the page, so cookies, `Origin`, `OPTIONS` preflight, HTTP/2, TLS and the
identity headers are the real client's. Identity headers are produced in-page by a
small injected helper that mirrors the app's interceptor (device id and session from
`localStorage`, check key extracted from the served bundle; fallback: reuse the check the
app itself last sent for that pathname, harvested via `page.on('request')`). The app's own
WebSocket stays open because the tab is alive.

**Needs.** Firefox in the image (`playwright install firefox --with-deps`, the Dockerfile
today installs only the Chromium shell, `Dockerfile:97`), ~300–500 MB RAM per profile
(6–8 pages → a 4–8 GB host or a second VPS; answers §7a allow it), a per-page volume for
the profile, Xvfb + VNC/noVNC (or an owner-only screenshot/typing route) for login, 2FA
and any future challenge, a health probe per profile (logged-in, WS connected, exit IP).

**Pros.** Identity consistency by construction (nothing is emulated); the kernel gets its
OWN session bound to its OWN device id and IP; a WAF challenge is answered by a real
browser; UA/TLS/H2 update with Firefox; future WebSocket capture is free; the pasted
bundle and the whole `request-headers.ts` emulation go away; the lane code above the
adapter does not change (transport is a seam below `request()` at `adapter.ts:1995-2011`).

**Cons.** New long-running component with RAM cost; Playwright's Firefox is a custom
build and exposes `navigator.webdriver` (JS-visible only; irrelevant to the network path,
relevant if Fansly enables browser-signal bot control — mitigations: headed under Xvfb,
stock Firefox via WebDriver BiDi, or Camoufox as a fallback); session death needs a human
(owner) unless a password vault is built; a crashed browser pauses capture (fail-closed).

**Ban risk: Low** for identity (indistinguishable from a chatter's Firefox on the same
proxy) — provided the request PATTERN is also human-plausible, which is stage 1's job;
**Medium** only in the residual "headless automation flagged by a future JS challenge"
scenario, which has a known fallback. **Completeness/freshness:** identical routes and
bodies; can improve later with WS. **Ops:** one login per page (owner, on his schedule,
answers §7f), re-login on death, browser role monitoring. **Cost:** ~$20–60/month for
RAM or a second host; Firefox is free. **Effort:** 4–7 weeks across stages 2–4 below.
**Hard rules touched:** egress resolver (new scope class `browser`, still per-page
proxy), raw-fetch budget (−1 at the end), capture-first (unchanged: same journaling),
platform-branch budget (no new `platform ===` outside adapters if the transport is chosen
by the registry's custody descriptor, `apps/runtime/src/platforms/registry.ts:180-186`),
migrations forward-only (one migration for `page_browser_profiles`).

### 3C. The extension as the sole collector

**How.** Chatter browsers (manager sessions) forward what the page already fetched to the
kernel (Firefox MV3 `webRequest.filterResponseData` can read bodies); the kernel never
talks to Fansly.

**Needs.** Extension work (new capture pipeline, batching, privacy custody), kernel ingest
under the existing `client_capture` producer (`services/ingest-observations.ts`),
canonicalizers for a new source.

**Pros.** Zero synthetic traffic; identities are all real.

**Cons.** Fails the owner's requirement that the kernel keeps collecting when browsers are
closed (answers §6); coverage equals what chatters happen to open (no follower walks,
statistics, payouts, vault, comment archive); observation completeness becomes
non-deterministic; the extension's hard rule (no out-of-band requests) forbids the walks
the kernel needs.

**Ban risk: Lowest** (nothing new is sent). **Completeness:** poor and unprovable;
**freshness:** live while a tab is open, nothing otherwise. **Ops:** none new. **Cost:**
none. **Effort:** 2–4 weeks in the extension plus ingest work. **Hard rules:** extension
"live reader" and "no out-of-band" (respected), capture-first (respected). Verdict: a
possible COMPLEMENT (passive live capture for freshness), not an architecture.

### 3D. Third-party anti-detect / cloud browser profile per page

**How.** One GoLogin/Multilogin-class profile per page with the page proxy, driven
through the vendor's Playwright/API integration; chatters could also use it, but they do
not need to (they have their own sessions).

**Needs.** Vendor subscription (public pricing: GoLogin from ~$24–49/month for the small
tiers, Multilogin from ~€99), local or cloud runner, the same kernel transport seam as 3B.

**Pros.** GUI profile management, fingerprint presets, built-in remote view in some
products; same identity benefits as 3B.

**Cons.** A vendor dependency on the most sensitive path (the owner excluded OFAPI for
Fansly on exactly this ground, answers §7d "not excluded" but "does not know how");
fingerprint SPOOFING is a liability here, not an asset — we want a truthful Firefox,
not a synthetic Chrome; vendor API changes and outages become capture outages; cost
scales per profile.

**Ban risk: Low–Medium** (real browser, but spoofed fingerprints are what bot-control ML
is trained on). **Completeness/freshness:** as 3B. **Ops:** vendor account, profile
sync, plus everything in 3B. **Cost:** vendor fee + runner. **Effort:** as 3B plus
integration. **Hard rules:** as 3B. Verdict: keep as an operator-convenience variant of
3B, not the default.

### 3E. Own credential login flow (server-side, the OFAPI way)

**How.** Store the model's password encrypted (`page_credentials` already encrypts a
bundle, `services/page-context.ts:103-118`); the kernel performs `GET /device/id`,
`POST /login {username, password, deviceId}`, handles `/login/twofa` with an
owner-supplied code (Telegram prompt), stores `{session id, token, device id}` and
replays with full identity headers from Node.

**Needs.** Everything in 3A for the transport (or it remains a fingerprint mismatch),
a 2FA relay, WAF-token/hCaptcha handling on the login route the day it is enforced.

**Pros.** The kernel gets its own session and device; re-login is automatic; matches
how OFAPI and apifansly connect accounts (public docs: username/password + 2FA + managed
mobile/residential proxy).

**Cons.** Same synthetic-transport weakness as 3A; the login route is the most likely
place for the dormant WAF challenge to be activated (the bundle's WAF interceptor is
injected into the session API service, `main.pretty.js:13406-13472`); password custody
on the hub.

**Ban risk: Medium** (identity fixed, transport not). **Completeness/freshness:**
unchanged. **Ops:** 2FA relay, challenge handling. **Cost:** ~0. **Effort:** 2–3 weeks
on top of 3A. **Hard rules:** secret storage (#21), egress resolver. Verdict: the right
way to PROVISION a session, but inside a real browser (3B), not from Node.

### 3F. Hybrid (recommended): 3B transport + in-browser login identity + traffic-shape reform + extension unchanged

**How.** Stage 1 reshapes the kernel's traffic regardless of transport. Stages 2–4 move
the transport to the page browser and give each page its own session created inside that
browser (the owner types the password and 2FA code on the remote screen; optionally an
encrypted password enables unattended re-login later). Chatters keep their manager
sessions and the extension; the owner keeps his personal session for himself only. The
Node replay stays as rollback until parity is proven on the canary and then on all pages,
then is deleted. Optional stage 6 journals the page browser's WebSocket frames to shrink
polling further.

**Ban risk: Low** overall: identity by construction, human-plausible cadence, one IP per
identity, fail-closed everywhere. Remaining exposure is behavioural (volume) and is
measurable. **Completeness/freshness:** unchanged at first; DM freshness relaxes to the
3-hour cadence the owner accepted; WS capture can later beat today's 30 minutes.
**Ops:** one login per page, incident on death, browser-role health. **Cost:** host RAM.
**Effort:** ~8–11 weeks end-to-end, each stage shippable alone.

## 4. Recommendation and rationale

Build 3F. Reasons, in order of weight:

1. The two High findings (owner's session shared across IPs; identity-less requests) are
   both consequences of "the kernel pretends to be a browser it is not". Only a real
   browser removes the whole class rather than the currently known instances of it. Every
   commercial tool the brief names ends up in the same place: OnlyMonster ships its own
   browser and a single IP per account; Infloww assigns a dedicated proxy per creator and
   logs the account in through its own client; OFAPI provisions a session by real
   login + 2FA behind a dedicated mobile/residential IP. None of them replays a pasted
   token from a server-side HTTP client.
2. The behavioural finding (volume/cadence) is independent of transport and is the
   cheapest, fastest, most verifiable win. It ships first, behind flags, with the health
   SLA constants moved in the same change.
3. The kernel already runs Playwright (`onlyfans-public-profiles.ts`), the image already
   installs browser dependencies, the egress resolver already models per-page scopes, and
   `request()` is the one seam every lane goes through — the transport swap is local.
4. It preserves every hard rule: per-page proxy (the browser launches with it), egress
   through the resolver (new scope class), capture-first (same journal writes), no
   writes to Fansly (the helper only executes GET), flags one at a time, extension as
   the live reader.
5. It keeps the rollback honest: until stage 4 the undici transport exists and is one flag
   away per page.

Not recommended: 3A/3E as the end state (arms race), 3C as the architecture (fails
completeness), 3D as the default (vendor on the critical path, spoofing).

## 5. Migration path and stages with dependencies

Numbers below are targets for the plan; the build phase sizes them against telemetry.

### Stage 0 — Verify the baseline (no code change; 1–2 days; owner-gated reads only)

- Confirm what the bundle carries: run `fansly:endpoint-probe --dry-run` on the VPS; it
  prints the redacted header plan with `present/missing` per identity header without any
  Fansly call (`services/fansly-endpoint-probe.ts`, `fansly-endpoint-probe-headers.test.ts`).
- Confirm the effective pacing config (`FANSLY_DEFAULT_DELAY_MS`, `SYNC_SHARED_RATE_LIMIT_ENABLED`,
  `EGRESS_PACER_MODE`, `FANSLY_BACKFILL_CONTINUATION_DELAY_MS`) via the owner-session
  config read (`config_settings` is not readable by `read_only`).
- Record the proxy inventory per page (provider, type, static/rotating) in
  `docs/decisions.md`; sample the exit IP of each page proxy three times over a day with
  `page proxy-ip` and note whether it moves.
- Read `page_sync_states.progress` for `followers` on lilly-2 and lora-3 to explain the
  ~79 pages/hour (incremental stop ineffective vs reconcile sharing the kind).
- Read the two `dm_conversations:failed` 401 snippets from the journal to attribute the
  14-day 401s.
- Output: a dated "Fansly capture baseline" entry in `docs/decisions.md`; no flags.

### Stage 1 — Traffic-shape reform (1–2 weeks; ships behind live flags, one at a time)

Dependencies: stage 0. Transport untouched.

1. **DM sweep becomes head-incremental.** `dm_conversations` gets a second mode beside
   `full_scan` (`executor-handlers.ts:2830-2845` state machine, `DmConversationCursorState`
   version 3): read `/messaging/groups?limit=20` from offset 0 and stop after two
   consecutive pages whose `lastMessageId`/`lastUnreadMessageId` set is already known;
   keep the existing `full_scan` (membership generation, decision #214) but on its own
   cadence of 24 h, or 48 h like `followers_reconcile`. New key
   `fanslyDmSweepMode` (`full_scan` | `head_incremental`, default `full_scan`) plus
   `fanslyDmFullScanCadenceSeconds`. The page-size change (100 → 20) is part of the mode.
   Bodies of moved heads keep flowing through the same sweep (answers §6).
2. **Cadence and SLA move together.** `SYNC_STREAM_POLICY.dm_conversations.cadenceSeconds`
   1800 → 10 800 and `freshnessSlaSeconds` 3600 → 28 800; domain `messages_live` SLA the
   same (`packages/db/src/repositories/page-sync.ts:253-262, 468-473`); health and deploy
   gate read these constants (`services/sync-status.ts:1029-1039`, `services/health.ts:290-300`,
   `scripts/deploy-production.sh` gates); the integration pins at
   `tests/api.integration.test.ts:663, 1267, 9645-9655` change in the same PR. Optional:
   make the cadence a live config key with the SLA derived as 2.5 × cadence, so later
   tuning needs no deploy.
3. **Fan-earnings walk becomes change-driven.** `fan_earnings` visits a fan only when the
   fan had activity since its last visit (a transaction, a message head move, a new
   subscription — all already in projections) or when its last visit is older than
   30 days; new key `fanslyFanEarningsRevisitDays` (default 30). Expected: −85% of that
   lane on the big pages.
4. **Followers.** Fix or explain the hourly page count from stage 0; cap the hourly
   incremental walk at N pages (`fanslyFollowersIncrementalMaxPages`, default 5) and
   leave completeness to the 48-hour reconcile.
5. **Human-plausible pacing.** `fanslyDefaultDelayMs` stays the floor, but the adapter's
   in-process wait gains jitter (uniform 0.6–1.8 × the floor, `adapter.ts:2212-2262`
   `waitForRateLimit`), and continuation chunks get the existing
   `spreadFanslyContinuation` jitter applied to steady-state lanes too
   (`sync/fansly-lane.ts:64-70`). Optional quiet hours: `fanslyQuietHoursUtc` (e.g.
   `02-08`) during which only `light` and `transactions` run, implemented in the planner
   as a scheduling gate (`sync/planner.ts` before `scheduleDuePageSync`) — the owner
   decides whether a night shift exists (answers §6).
6. **429 stops the page.** In `adapter.ts:2090-2100` a 429 becomes `failed` with
   `failureKind: "http"` and no in-request retry; the executor's `rate_limit` retry class
   (`sync/executor.ts:353-358`) backs the WHOLE page off for 30–60 minutes via
   `pausePageSync…` semantics, and a second 429 within 24 h opens an incident.
7. **Challenge classification.** A response whose body is HTML, or whose status is 202/405
   with `x-amzn-waf-*` headers, or whose gateway header is missing, is classified
   `failureKind: "challenge"` (new `HttpRequestFailureKind` value in
   `packages/shared/src/types.ts:202`), parks the stream `manual_action_required/
   fansly_challenge` and opens a new incident kind `fansly_challenge` (migration for the
   `notification_incident_kind` enum, next free number in `packages/db/migrations`). A
   401/403 on ≥ 2 pages within 10 minutes opens `fansly_auth_burst` instead of per-page
   `auth_blocked` only.
8. **Bulk lanes.** `media_stats`, `post_replies`, `catalog`, `notifications` daily caps
   stay; their continuation delay gets the same jitter; they are simply paused on
   non-canary pages during the transport migration (existing allowlists).

Rollout: flip one key per page group with a 48-hour window each, starting with ari-1,
then lilly-1, then the rest; watch the stage-1 acceptance metrics (§6).

### Stage 2 — Page-browser service, canary, no adapter change (2–3 weeks)

Dependencies: stage 1 items 2 and 7 (so health and challenge signals exist).

- New role `browser` in `startup.ts`, `docker-compose.production.yml` service
  `browser` with a named volume per page profile and a memory limit; Dockerfile installs
  Playwright Firefox (`--with-deps firefox`) beside the Chromium shell; a boot smoke
  extends `scripts/smoke-playwright-runtime.mjs`.
- `apps/runtime/src/services/page-browser/`: `profile-manager.ts` (one persistent
  context per Fansly page; proxy from `resolveStoredProxyConfig`; launch headed under
  Xvfb), `session-probe.ts` (reads `localStorage` `active_session` presence and the
  app's WS state without calling Fansly), `remote-screen.ts` (Xvfb + x11vnc + websockify
  bound to loopback; access only via the owner's SSH tunnel), `api.ts` (loopback HTTP:
  `GET /profiles/:pageId/status`, `POST /profiles/:pageId/open-remote-screen`,
  `POST /profiles/:pageId/fetch` — used from stage 3).
- New table `page_browser_profiles` (migration; forward-only): `page_id`, `status`
  (`absent|logged_out|logged_in|challenge|error`), `identity_kind` (`model|manager`),
  `device_id_present`, `session_id_present` (booleans only, never values), `exit_ip_last`,
  `exit_ip_checked_at`, `last_login_at`, `last_probe_at`.
- Identity choice for the canary (ari-1): the owner logs in on the remote screen as the
  model (default) or as a dedicated manager account (see §8). The extension is not
  involved.
- Parity harness: while the profile is open, `page.on('request')` records (header
  names, order, value lengths, equality of client-id/session-id across requests) for the
  app's own traffic and for helper-issued requests; stored as a redacted report in
  `page_browser_profiles.parity_report` (JSON without values). This uses only the
  requests the app makes during login and the kernel's ordinary capture — no extra probes.
- Exit-IP continuity: once a day the profile fetches a non-Fansly IP echo through its
  proxy and stores the IP; a change opens `proxy_failed` with reason `exit_ip_changed`.
- Nothing reads Fansly through the browser yet; the canary page keeps syncing over undici.

### Stage 3 — Transport seam and canary switch (2–3 weeks)

Dependencies: stage 2 running for ≥ 7 days on the canary with `logged_in` and a stable
exit IP.

- `packages/fansly/src/transport.ts`: `interface FanslyTransport { execute(input: {
  method: "GET"; url: string; headers: Record<string,string> }): Promise<{ status: number;
  headers: Record<string,string>; text: string }> }` with two implementations:
  `UndiciTransport` (today's `fetch` + dispatcher, `adapter.ts:2006-2011`) and
  `BrowserTransport` (calls the browser role's `/fetch`). `request()` uses
  `context.transport`; the header builder becomes transport-owned: undici keeps
  `buildFanslyRequestHeaders`, the browser ignores the kernel's identity headers and lets
  the in-page helper set `fansly-client-id/ts/session-id/check` from the profile's own
  state (`localStorage` `device_id` and `active_session`; check key from the served
  bundle by AST walk with "last assignment wins"; fallback to the last check the app sent
  for the same pathname). The helper is GET-only by construction and refuses any other
  method (a test pins it, extending the existing no-write pin).
- Egress: `resolveEgress` gains scope kind `page` with `transport: "browser"` resolved from
  `page_browser_profiles.status === "logged_in"`; the registry's custody descriptor
  (`platforms/registry.ts:180-186`) becomes `browser_profile` when the page is on the new
  transport, so no `platform ===` branch is added.
- Flag: `fanslyBrowserTransportPageAllowlist` (fail-closed CSV, same template as
  `fanslyCatalogPageAllowlist`), read per chunk. Page not listed → undici as today.
- Pacing: the browser transport still passes the DB-backed waiter and the stage-1 jitter;
  the in-browser `fetch` inherits the app's connection reuse.
- Journaling: unchanged (`persistRawPayload`, observations); `sync_http_attempts` gains
  `transport` (`undici|browser`) so telemetry can be split.
- Canary switch: ari-1 on the browser transport; the undici bundle for ari-1 is left in
  place but unused; after 7 clean days, lilly-1; then the rest one page per 48 h.

### Stage 4 — Fleet switch, retire the pasted session, delete the emulation (1–2 weeks)

Dependencies: stage 3 on all six pages for ≥ 7 days.

- Delete the owner-session bundles from `page_credentials` (owner act; the rows become
  `identity_kind: browser_profile` markers), remove the Fansly paste fields from the
  dashboard credentials form and replace them with profile status + "open remote screen"
  (`PlatformCredentialsFields.tsx`, `CredentialsModal.tsx`), keep the proxy input.
- Remove `UndiciTransport` for Fansly, `buildFanslyRequestHeaders`, the route-family
  check map and `FANSLY_CLIENT_CHECK_ROUTES` (contracts change + `pnpm contracts:generate`;
  the extension does not use these operations), lower `scripts/raw-fetch-budget.json`
  10 → 9, drop the `fansly adapter 1` exemption in the undici lint wall.
- `fansly:replay-probe` and `fansly:endpoint-probe` run through the browser transport
  (same header-plan print, now "as the browser sends it").
- Record decisions: identity kind per page, proxy policy (residential/mobile only,
  static, US), the retirement of decision #44's "authorization only" mode.

### Stage 5 — Lifecycle automation (optional, 1–2 weeks)

- Encrypted password per page (owner decision, answers §7e) enabling unattended
  re-login inside the profile: the helper fills the app's own login form (never a bare
  `POST /login` from Node), waits for the 2FA prompt, and asks the owner for the code via
  the existing Telegram outbox; a failed or challenged login parks the page and opens the
  incident. Without the vault, session death = Telegram incident → owner opens the remote
  screen.

### Stage 6 — Optional freshness recovery via the app's WebSocket (2–3 weeks)

- The profile already holds `wss://wsv3.fansly.com?v=3`; a `page.on('websocket')` tap
  journals frames as observations of a new `source` (`observations_source_check`
  migration) under capture-first; a canonicalizer maps message/notification frames; the
  head-incremental sweep then drops to the 24-hour full scan plus event-driven head reads.
  This is the only stage that can make the kernel FRESHER than today while sending fewer
  requests. Format unknown until frames are journaled — plan a capture-only first slice.

Dependency graph: 0 → 1 → 2 → 3 → 4 → (5, 6 independent of each other, both after 4).
Stage 1 is valuable and reversible on its own; stages 2–3 are reversible per page by the
allowlist; stage 4 is the point of no return for the pasted-session path (the browser
profile IS the credential from then on).

## 6. Verification and acceptance criteria

All checks read telemetry the kernel already writes (`observations`, `sync_http_attempts`,
`page_sync_states`, `notification_incidents`, `/health/sync`) or the page-browser
status table; none adds Fansly traffic beyond normal capture. Read-only role suffices for
everything except config reads.

Stage 0: baseline entry exists; header plan shows which identity headers are present;
effective pacing values recorded; proxy inventory recorded; followers page-count
explanation recorded.

Stage 1 (per page, 48-hour window after each flip):
- calls/day ≤ 25% of the 7-day baseline on the two largest pages (lilly-2 ≤ 2 800,
  lora-1 ≤ 1 750) within a week; `dm_conversations` ≤ 15% of baseline.
- Distribution of inter-request gaps on a page (from `sync_http_attempts.started_at`)
  has no dominant 2.6 s bin (mode share < 20%).
- Zero 429; `dm_conversations` freshness ≤ 3 h + chunk on `/health/sync`; deploy gate
  green with the new SLA constants; the integration pins updated.
- Workboard "needs reply" lag observed ≤ 4 h on the canary during a working day.
- One synthetic challenge fixture (HTML body, 202) classifies as `challenge` in unit tests
  and opens the incident kind in the integration test.

Stage 2 (canary):
- `page_browser_profiles.status = logged_in` for 7 consecutive days without re-login;
  parity report shows the app's own requests carry all four identity headers with stable
  client-id/session-id lengths; exit IP unchanged across daily checks (or the proxy is
  replaced by a static one).
- Browser role memory within the compose limit; restart of the role restores
  `logged_in` without owner action.

Stage 3 (canary, then fleet):
- Byte-parity of journaled bodies: for one full day the canary's observations per kind
  match the previous day's undici baseline in count (±10%) and the canonicalizers stamp
  the same event families (`domain_events` per family per day, ±10%).
- Zero `provider`/`http` failures attributable to the transport (compare failure kinds
  split by `sync_http_attempts.transport`).
- The parity report shows the helper's requests and the app's requests are
  header-identical in names and order, with equal client-id/session-id and per-path
  check equality for any pathname both have visited.
- Rollback drill executed once on the canary: remove the page from the allowlist, next
  chunk runs on undici, journal continues.

Stage 4:
- `page_credentials` holds no Fansly session token for any page (owner verifies through
  the dashboard; a read-only count of rows with `identity_kind='browser_profile'` = 6).
- `scripts/check-raw-fetch.mjs` passes at budget 9; `request-headers.ts` deleted; probes
  print the browser header plan.
- 14-day incident watch: no `auth_blocked`, `fansly_challenge` or `proxy_failed` opened
  by the browser transport.

Stage 5/6: login automation exercised once per page on purpose (owner-triggered logout
inside the profile, unattended recovery, 2FA prompt delivered); WS slice journals frames
for 7 days before any canonicalizer ships.

## 7. Risks, trade-offs, assumptions

- **Assumption (owner-stated, unverifiable read-only):** production bundles carry only
  `authorization`. If a page turns out to carry a device/session id, finding 2.2.2 weakens
  for that page but 2.2.1 (shared session) still holds. Stage 0 settles it.
- **Assumption:** the six proxies are static residential US IPs. If any rotates, stage 2's
  exit-IP check will show it and the proxy must be replaced before that page moves to the
  browser transport (a session hopping IPs is worse in a real browser than in the replay,
  because now the device id is consistent and the IP is not).
- **Risk: Playwright Firefox is not release Firefox.** Its UA and TLS are real for its
  version, but `navigator.webdriver` is exposed and the version may lag. Mitigation
  ladder: headed under Xvfb; stock Firefox ESR driven through WebDriver BiDi (Playwright's
  experimental `moz-firefox` channel) if the build phase confirms proxy-auth support;
  Camoufox only if a JS challenge appears. Verify SOCKS5-with-auth support for the chosen
  driver early (Chromium lacks it; Firefox supports it natively; fall back to a loopback
  credential-injecting forwarder per page if Playwright's option does not pass it).
- **Risk: check-key extraction.** Fansly plants decoy assignments (public issue #115) and
  may obfuscate further. The helper prefers the check the app itself sent for the same
  pathname (harvested in-profile) and only computes when no observation exists; a
  mismatch between computed and observed digests for the same pathname fails closed and
  opens `fansly_challenge`-class incident `check_key_drift`.
- **Risk: model-login identity puts a full-access session on hub infrastructure.** The
  manager-identity alternative limits blast radius but may not see wallets/payouts/stats;
  its access must be verified with one owner-gated read per lane on the canary before
  choosing it fleet-wide. Either way the password is entered by the owner, not stored,
  unless stage 5 is approved.
- **Risk: RAM/host.** Six to eight persistent Firefox profiles need 3–4 GB; if the current
  VPS cannot host them, the browser role goes to a second host on the same private
  network with the DB reachable only through the API (`AppContext` in the browser role
  needs DB access for proxies and status; alternatively the API hands it the decrypted
  proxy per request — decision in the build phase).
- **Trade-off: freshness.** DM head lag grows from ≤ 30 min to ≤ 3 h (accepted, answers
  §6); the dossier for a brand-new conversation appears hours later; stage 6 can recover.
- **Trade-off: the extension's own out-of-band reads** (spender name sweeps in batches,
  messaging-group walks up to 20 pages, per-fan earnings when the board opens) remain;
  they run in real chatter browsers and are bounded, so they are out of scope here, but
  their volume should be included in any per-IP reasoning (they share the page IP).
- **Assumption:** Fansly's session table and management sessions behave as the HAR
  shapes suggest (per-session IP/geo, long-lived tokens). Nothing in the plan depends on
  the server's internal scoring; the plan removes signals rather than guessing thresholds.
- **Residual risk after 3F:** behavioural detection of any automated volume. The counter
  is the stage-1 budget discipline plus the ability to slow further per page without
  redeploying (live keys), and the incident latches that turn "Fansly changed something"
  into a same-hour signal.

## 8. Decisions left to the owner

1. **Kernel identity per page:** log the page browser in as the model (full access,
   default) or as a dedicated "Hub" manager account (least privilege; needs the lane
   access check first). Can differ per page.
2. **Password vault (stage 5):** store the model's password encrypted for unattended
   re-login, or keep re-login a manual remote-screen act.
3. **Remote screen mechanism:** noVNC over an SSH tunnel (recommended) versus an
   owner-only screenshot-and-type dashboard route.
4. **Host placement:** upgrade the VPS RAM or add a second host for the browser role.
5. **Quiet hours:** whether to pause non-essential lanes overnight (needs the night-shift
   answer).
6. **Cadence numbers:** 3 h for the DM head sweep and 24 h vs 48 h for the full
   membership scan; 30-day fan-earnings revisit.
7. **Bulk lanes during migration:** keep `media_stats`/`post_replies`/`catalog` running on
   all pages or pause them until each page is on the browser transport.
8. **Proxy policy:** codify "static residential or mobile, US, one per page, exit-IP
   checked daily" in `docs/decisions.md` and replace any proxy that fails it.
9. **Stage 6 go/no-go:** journal WebSocket frames once stage 4 is stable.
10. **Firefox flavour:** Playwright's Firefox build (fastest to ship) versus stock Firefox
    via BiDi (closest to a real user), decided after the build-phase spike.

## 9. Evidence index

Repository (this worktree unless noted):
- `packages/fansly/src/request-headers.ts` — fixed header set, conditional identity
  headers, route-family check map.
- `packages/fansly/src/adapter.ts:1949-2311` — request core, retry/backoff, dispatcher,
  in-process pacing; `:2006-2011` the single raw `fetch` (raw-fetch budget item).
- `packages/shared/src/http-client.ts:14-141, 571-575` — undici Agent/ProxyAgent/SOCKS
  dispatcher (no `allowH2`), retry delay.
- `packages/shared/src/types.ts:155-175` — `FanslySessionBundle`, `FANSLY_CLIENT_CHECK_ROUTES`.
- `packages/shared/src/proxy-string.ts`, `proxy.ts` — accepted proxy schemes, egress key.
- `packages/shared/src/config-registry.ts:113-125, 135-138, 172-243` — Fansly pacing,
  ramp gates, daily caps, pacer mode.
- `apps/runtime/src/services/egress/resolver.ts`, `pacer.ts` — address policy, class
  pacing (decision #100, #124).
- `apps/runtime/src/services/page-context.ts`, `page-onboarding.ts`, `connections.ts`,
  `page-proxies.ts` — credential custody, verify/re-paste, proxy assignment.
- `apps/runtime/src/services/sync/executor.ts:226-440, 760-830` — failure classification,
  auth pause; `executor-handlers.ts:1895-1990, 2790-2845, 2906-2928, 3113-3118, 4355-4449`
  — followers walk, DM full-scan generation, page size 100, `/group/:id` lookups,
  fan-earnings per-fan calls; `fansly-lane.ts:64-70` — continuation jitter;
  `chunk-budget.ts:10` — five requests per chunk; `fansly-stream-scheduling.ts`,
  `fansly-stream-gate.ts` — allowlist semantics; `planner.ts` — minutely cycle.
- `packages/db/src/repositories/page-sync.ts:176-475` — cadences and SLAs;
  `resolveRetryDelayMs` — stream retry ladder.
- `packages/db/src/schema.ts:234-257, 348-372` — incident kinds, `page_credentials`,
  `egress_endpoints`.
- `apps/runtime/src/services/fansly-endpoint-probe.ts`, `fansly-replay-probe.ts`,
  `tests/fansly-endpoint-probe-headers.test.ts` — probes, dry-run header plan.
- `apps/runtime/src/services/onlyfans-public-profiles.ts:102-116, 253-258` — existing
  Playwright + per-page proxy launch; `Dockerfile:80-99`; `apps/runtime/src/startup.ts:45-77`;
  `docker-compose.production.yml`; `scripts/raw-fetch-budget.json`.
- `apps/runtime/src/platforms/registry.ts:180-186` — session custody descriptor.
- `apps/dashboard/src/pages/settings/PlatformCredentialsFields.tsx` — paste form.
- `packages/contracts/src/routes.ts:3166-3270, 7656-7737` — credential schemas, owner-only
  routes.
- `docs/decisions.md` #44, #62, #76, #100, #124, #224, #234, #235; `backlog.md` §"Fansly
  ingestion" (FANSLY-001…008, prod evidence of 2026-09-04).
- `~/code/goose/fansly-ext/src/background/session-capture.ts`, `session-store.ts`,
  `fansly-client.ts:349-400`, `manifest.json`, `CLAUDE.md` — extension capture, its own
  Fansly calls and retry policy, permissions, hard rules.
- `reference/prod-facts-2026-09-05.md`, `answers.md` — production volumes, owner answers.

Local captures (read-only; shapes only were used):
- `~/code/goose/hub/artifacts/fansly-network-capture-2026-08-19/fansly-session-2026-08-19.har`
  — header set/order, HTTP/2, cookies (names), OPTIONS preflights, CloudFront headers,
  one client-id/session-id across the capture, 41 pathnames ↔ 41 check values.
- `~/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js`
  `:13008-13030, 13131, 13276-13472, 13560-13700, 20022, 22956-23110, 36290-36400, 253422`
  — session model and login, device id, AWS WAF SDK wiring (dormant), header interceptor
  (ts jitter, per-path cyrb53 check), WebSocket endpoints.
- `~/code/goose/hub/artifacts/fansly-ui-walk-2026-08-21/fansly-ui-walk-2026-08-21.har`
  (+ `-pre-rewalk.har`) — real-client request rate, app page sizes, `/sessions` and
  `/management/*` response shapes.

Public sources:
- https://github.com/prof79/fansly-downloader-ng/issues/115 and /issues/48 — check-key
  decoys and the manual key-hunt history; `api/fansly.py` in that repo — device id via
  `/device/id`, check formula, WS session handshake (older client behaviour).
- https://github.com/Jakan-Kink/fansly-scraper (`helpers/checkkey.py`) — AST-based
  check-key extraction.
- https://docs.onlyfansapi.com/introduction/essentials/proxies — dedicated mobile/
  residential IP per account, no datacenter, consistent geolocation;
  https://docs.onlyfansapi.com/api-reference/fansly/connect-fansly-account/start-authentication
  (snapshot in `reference/`) — username/password + 2FA + managed proxy;
  https://docs.onlyfansapi.com/introduction/essentials/rate-limits.
- https://docs.apifansly.com/api-reference/connect-fansly-account/connect-account —
  competitor: login + e-mail 2FA + managed proxy country.
- https://docs.onlymonster.ai/onlymonster-browser/proxy-management and
  https://docs.onlymonster.ai/onlymonster-browser/onlymonster-browser-setup-guide —
  dedicated browser, single IP per account, SOCKS5, profile isolation.
- https://infloww.com/blog/getting-started-with-infloww — dedicated proxy per creator,
  credentials entered in Infloww's client.
- https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-fields-list.html,
  https://aws.amazon.com/about-aws/whats-new/2025/03/aws-waf-ja4-fingerprinting-aggregation-ja3-ja4-fingerprints-rate-based-rules/,
  https://docs.aws.amazon.com/prescriptive-guidance/latest/bot-control/advanced-analysis-controls.html
  — JA3/JA4 on CloudFront, Bot Control signals.
- https://httptoolkit.com/blog/tls-fingerprinting-node-js/, https://github.com/nodejs/undici/issues/1983,
  https://github.com/unreleased/hellojs — what Node can and cannot do about TLS
  fingerprints.
- https://playwright.dev/docs/network — proxy configuration per launch/context;
  https://github.com/daijro/camoufox — fallback anti-detect Firefox.
