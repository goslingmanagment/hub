# Cross-exchange round 1 — reply (Fable)

Verified in the repo before answering; line numbers are from this worktree. No secrets.

## D1 — Which browser: **combine** (Firefox stays the default; adopt Position 2's discipline)

Keep Firefox as the profile browser, but take three things from Position 2:

1. **Wording.** Playwright's Firefox is a patched build (Juggler) — I will not call it
   "identical to a chatter's stock Firefox". What is stock is the network stack (Gecko/NSS
   TLS, HTTP/2, header order), which is the part the platform can see; the patches are
   JS-visible only (`navigator.webdriver`), the same as Playwright's Chromium. So the
   build-phase spike compares Playwright Firefox vs stock Firefox ESR driven over WebDriver
   BiDi, and the profile advertises whatever it actually is (no UA override).
2. **Version pinning.** Pin the browser build in the image and re-pin deliberately; a
   Firefox version one or two releases behind is ordinary in the wild (ESR users), a UA
   string that never moves is not.
3. **Proxy auth.** Do not depend on either browser's SOCKS5-auth support: run a per-page
   loopback forwarder inside the browser container (a 1-process credential-injecting
   SOCKS/HTTP bridge bound to `127.0.0.1:<port-per-page>`), and launch the profile with the
   unauthenticated loopback proxy. This removes the Chromium-lacks-SOCKS-auth argument
   entirely, works for the `http/https/socks5` schemes the kernel accepts
   (`packages/shared/src/proxy-string.ts:5`), and keeps the proxy credentials out of the
   browser profile.

Why not Chromium as the default: every other client on a page IP is Firefox — the
chatters' Firefox with the extension (`~/code/goose/fansly-ext/manifest.json` is
Firefox-only, gecko ≥ 142) and the captured corpus the header work was built from. A lone
Chromium on that IP is not a bot signal by itself (households mix browsers), but it is one
more distinct device class on an IP that should look like an agency team on Firefox, and
it throws away the only baseline we have for header/TLS parity (all six HARs are Firefox).
Position 2 concedes it is "not a claim that Chromium is safer"; with the forwarder the
tooling argument disappears, so the tie-breaker is parity with the observed population.

Future AWS WAF challenge: both browsers run `challenge.js` (bundle
`main.pretty.js:13289-13300`); both expose `navigator.webdriver` under Playwright; neither
is advantaged. If Bot Control browser-signal rules ever flag automation, the fallback is
the same for both (stock browser via BiDi first, Camoufox last).

Persistence: `launchPersistentContext` per page (one browser process per profile) or one
Firefox with N contexts + `storageState` per page; Playwright supports a proxy per context
on both engines (public Playwright docs, "Network" page). Choose in the spike by memory
(see D8).

## D2 — DM sweep shape: **combine** (cadence-only first at 100/page; head mode second, never a 20/page full scan)

Position 2 is right that changing 100 → 20 on a FULL scan multiplies list requests ~5×
and that the first step must keep the request shape stable for the transport comparison.
Position 1 is right that a full scan is the wrong shape for a 3-hour cadence. Both fit if
the head mode is a separate mode and ships after the cadence step.

**#214 semantics, verified.** The sweep starts a new generation on every run
(`executor-handlers.ts:2830-2845`, `mode: "full_scan"`, `generation + 1`, `offset 0`);
every applied row is stamped `lastSeenGeneration: state.generation`, `isVisible: true`
(`:3320-3321, 3399-3400`); the destructive visibility pass runs only on
`count(last_seen_generation = generation) === observedCount` exactly and only with a
present provider total (`:3446-3465`, `markPageDmConversationsInvisibleByGeneration`;
decision #214 "Certification"). Overlap is a pre-upsert read of rows carrying THIS
generation (`:3346-3361`).

**Head mode coexists if it never touches the generation.** Concretely: state v3 gains
`mode: "head_scan"`; a head run does NOT increment `generation`, does NOT stamp
`last_seen_generation`, does NOT run overlap-by-generation or the visibility pass; it only
upserts head fields (`lastMessageId`, `lastUnreadMessageId`, `unreadCount`, `flags`) and
inserts a previously unknown thread as visible with `last_seen_generation` = the last
COMPLETED generation (so the next full scan restamps it like any other row); it keeps the
existing `dmMessagesFollowupNeeded` trigger for moved heads (`:3583-3590`). The full scan
keeps today's code and its certification, on its own timer (`fullScanDueAt` in the cursor;
first proposal 24 h, then 48 h like `followers_reconcile`). Head runs and full scans are the
same stream, so they never interleave (one lease). Membership changes (deleted/blocked
threads) are therefore detected daily instead of every 30 minutes — decisions #208/#214
already prefer stale visibility to a wrong hide.

**Ordering evidence.** The kernel requests `sortOrder=1&flags=0` (`:2906-2909`); the app's
inbox uses exactly `sortOrder=1&flags=0&limit=20&offset=0` (session HAR, 3 calls) and a
`flags=32&limit=10` variant for a filtered list. That the inbox is most-recent-first is an
inference from the UI; the stop rule therefore needs a guard: the daily full scan counts
threads whose head moved but which the head runs never saw (`head_mode_miss`); a page
with misses widens its stop window from 2 to 3 unchanged pages automatically and reports
it.

**Arithmetic for lilly-2** (6 465 list calls/day ÷ 48 runs ≈ 135 pages of 100 ≈ 13 500
threads; `/group/:id` and head-repair reads excluded, they scale with changed threads,
not with page size):

| Variant | list calls/day | share of today's lane |
|---|---:|---:|
| Today: full scan, 100/page, every 30 min | 48 × 135 = 6 480 | 100% |
| Position 2: full scan, 100/page, every 2 h | 12 × 135 = 1 620 | 25% (−43% of the page's total 11 199) |
| Full scan at 20/page every 3 h (the naive reading of Position 1) | 8 × 675 = 5 400 | 83% — Position 2's objection holds |
| Head mode 20/page every 3 h, stop after 2 unchanged pages, full scan 100/page daily | 8 × (⌈k/20⌉ + 2) + 135; k = threads with a moved head per 3 h: k = 60 → 175, k = 150 → 215, k = 500 → 359 | 3–6% |
| Same with the full scan every 48 h | 8 × (⌈k/20⌉ + 2) + 68 | 2–5% |

`k` is measurable before building anything: `page_dm_threads` rows whose head fields
changed between two generations (read-only role; stage 0 item). If k on lilly-2 turns out
to be in the thousands per 3 h, head mode still wins but the stop window must be sized from
that measurement rather than assumed.

Order: stage 1a = cadence change only (D6), 100/page, request shape unchanged — this is
what the undici→browser parity comparison runs on; stage 1b = head mode behind its own
key (`fanslyDmSweepMode`, per-page allowlist, fail-closed), after 1a's window and after
`k` is measured.

## D3 — Execution model and tab lock-down: **combine** (Position 2's default-deny and gate; Position 1's helper with a graceful ladder)

**The app's own pipeline is not reachable.** The identity headers are added by an Angular
HTTP interceptor (`main.pretty.js:36360-36395`) on the app's internal request wrapper; a
production Angular build exposes no `ng.getInjector`/service handles, and `page.evaluate(
fetch)` bypasses the interceptor exactly as Position 2 says. There is no supported way to
push a kernel-chosen request through the app's interceptors; the only in-app path is the
UI itself, which cannot express our reads. So the executable model is: `fetch` from the
`fansly.com` origin with the helper adding the four identity headers. What the browser
still contributes without any help: TLS/H2, cookies (the auth token and device cookies the
kernel never sends — session HAR cookie names `f-s-c`, `f-d`, `fansly-d`), the `OPTIONS`
preflight, `Origin`/`Sec-Fetch-*`, and a real `fansly-client-ts` shape if the helper
mirrors the app's cached-jitter rule (`:36298-36306`).

**What the helper needs from the bundle and how fragile it is.** Only the check key.
Device id and session id come from `localStorage` (`device_id`, `active_session` →
`{id, token, deviceId}`, bundle `:13008-13030, 13241-13242, 13689-13698`); the ts rule and
the digest function are stable (`cyrb53`, `:36325-36345`). The key is deliberately
obfuscated with a decoy first assignment and a later real one (issue prof79/#115; still
true in the 2026-08-20 bundle: two assignments to the same field, `:36298-36312`). Ladder,
fail-soft in the right direction: (1) key extracted by AST walk, last assignment wins,
validated against a check the app itself emitted for any pathname observed in the profile
(`page.on('request')`), (2) if validation fails, use the app-observed check for pathnames
the app has visited and send NO check for the rest — the shape production runs on today,
proven accepted (decision #62, answers §1) — and open a non-blocking `check_key_drift`
incident, (3) never block capture on the check. Per-id pathnames (`/group/{id}/`,
`/post/{id}/replies`) cannot use the observed cache, which is why (1) matters.

**Offline prototype gate: agree.** A fixture platform (the served bundle's interceptor
logic replicated in a test page, a fake `apiv3` that echoes headers) proves the bridge and
the lock-down before any live profile; the parity harness on the canary then proves it
against real traffic using only the app's own requests during login. If the bridge cannot
be made to pass the fixture, stop at stages 1–2 plus the hardened undici path.

**Lock-down: default-deny, agree, with these specifics.**
- Two modes per profile. `login` (owner on the remote screen): everything allowed. `capture`:
  `context.route('**/*')` allows only GET to `apiv3.fansly.com/api/v1/<allowlisted paths>`
  (the kernel's endpoint set from `packages/fansly/src/adapter.ts` `endpointTemplate`s
  plus the app's boot reads `/versioning`, `/account/me`, `/settings`, `/account/settings`),
  `fansly.com` static assets and `cdn*.fansly.com` images; blocks ALL POST/PUT/DELETE
  (`/message/ack`, `/it/pis`, `/it/mois`, `/it/fyp`, `metrics.fansly.com/event/track`,
  `intercom`, `leaderboard.fansly.com` — all observed in the session HAR while browsing);
  `serviceWorkers: 'block'`; popups closed; downloads denied. Blocking analytics/metrics is
  what every ad-blocking user does, so it is not itself a tell.
- WebSockets: block in capture mode initially (`page.routeWebSocket` or the Firefox pref in
  capture mode). The session id does NOT depend on the socket in the current client — it is
  the `/login` response stored in `active_session` (`:13689-13698`); the older WS handshake
  in `fansly-downloader-ng` is obsolete. Presence: whether an open `wsv3` socket marks the
  creator online is unknown; blocking it avoids changing what fans and chatters see.
  Re-enable only in stage 6 as its own decision with a measurement.
- Read marks: the app marks read explicitly with `POST /message/ack` (8 in the HAR while
  the owner opened chats); `GET /message` is what today's replay already sends daily
  without complaints, so a GET is not an ack (inference, consistent with the app design).
  The helper is GET-only by construction and refuses other methods; a test pins it.
- `page.route` reliability: fetch/XHR from the page and the service worker (blocked) are
  covered; WebSocket needs the separate route; navigations inside the app are allowed but
  the kernel never triggers them in capture mode.

Cost of the combination: a fixture platform (~1 week), the lock-down table maintained
next to the endpoint list (a test asserts every `endpointTemplate` is allowlisted).

## D4 — 429 handling: **combine**

Both positions are compatible once the cooldown lives in the DB-backed waiter. Concrete
rule:

1. **Adapter (`packages/fansly/src/adapter.ts:2090-2100`).** A 429 is terminal for the
   logical request: no in-request retry. `FanslyApiError` gains `retryAfterMs` parsed
   WITHOUT the 60 s clamp (`parseRetryAfterDelayMs` clamps to `MAX_RETRY_DELAY_MS = 60_000`,
   `packages/shared/src/http-client.ts:20,546` — keep that for other callers; add an
   uncapped parse with a 24 h ceiling for this path).
2. **Executor (`services/sync/executor.ts:352-358`).** On 429: publish a cooldown by pushing
   the page's `sync_rate_limits` row `(provider fansly, egress_key = page egress key,
   scope global)` `scheduled_at` to `max(scheduled_at, now + retryAfterMs)`; when no
   `Retry-After` is present, use a bounded ladder keyed on consecutive 429s for that egress
   key: 5 → 15 → 60 min, ceiling 24 h. Then yield the chunk with `continuationRetryAt` =
   cooldown end, checkpoint preserved, attempt counted (decision #235). A second 429 within
   24 h opens an incident (`fansly_rate_limited`); a third pauses the page for owner
   review.
3. **Who reads it: everything, automatically.** Every kernel Fansly request goes through
   `createSyncRateLimitWaiter` → `reserveSyncProviderRateLimit` on scope `global` for that
   egress key (`services/sync/rate-limiter.ts:18-56`; used by lanes, `verifySession` in
   `connections.ts:254-262` and `page-proxies.ts:33-51`, both probes, hydration). Pushing
   the row is therefore a whole-page/whole-proxy cooldown with no new state machine —
   Position 1's "back the whole page off" falls out of Position 2's durable cooldown.
   A wait longer than the chunk's wall clock releases the lease (existing budget yield).
4. **Extension.** The kernel cannot see the chatters' 429s (separate sessions), but the
   page IP is shared, so a kernel-triggered per-IP limit would hit chatters — one more
   reason for (2). On the extension side today: `fansly-client.ts:349-400` retries 429 up
   to 3× with `Retry-After` capped at 5 s. Recommended (separate, small change): on 429
   stop the operation and surface the existing `rate_limited` error; no retries. Not a
   kernel dependency.

## D5 — Stage 1 contents: **combine**, ordered, with numbers

Agree with Position 2 on three points: jitter is hygiene, not a safety certificate (I only
claim it removes the fixed 2.6 s inter-arrival mode, which is a machine signature; it is
one line in `waitForRateLimit`, `adapter.ts:2212-2262`, and costs nothing); no quiet hours
without shift data (ship the key, default off, owner decides); notifications unchanged
(I never proposed changing the 1 800 s head poll; the "33 days overlap" is an observed
rate, agreed).

Object to "cadence only": two of my items are safety items with no traffic effect (429
rule, challenge classification) and belong in stage 1; and the fan-earnings change is not
"skipping inactive fans indefinitely" — it has a 30-day maximum revisit
(`fanslyFanEarningsRevisitDays`), so every fan is read at least monthly and any fan with a
transaction/message/subscription event since the last visit is read at the next run. The
lane today calls two statistics routes for EVERY known fan daily
(`executor-handlers.ts:4434-4449`; lilly-2 2 010/day ≈ 18% of the page), which the app
does only when a fan's card is opened. Followers: agree not to weaken reconciliation;
the hourly walk is written as incremental with a known-checkpoint stop
(`:1912-1990`), so the right stage-1 action is to explain the ~79 pages/hour on lilly-2
(stage 0) and add the page cap only as a guard after the cause is fixed.

Order and acceptance (each behind a live key, one flip per page group, 48 h windows):

1. Cadence + SLA + slot rebase (D6): `dm_conversations` ≤ 30% of baseline on lilly-2/lora-1
   within 3 days; freshness on `/health/sync` ≤ cadence + 30 min; deploy gate green.
2. 429 rule + challenge classification: unit fixtures (429 with/without `Retry-After`,
   202/HTML challenge) classify as specified; no traffic effect expected; zero 429 stays
   zero.
3. Head mode (D2) after `k` is measured: `dm_conversations` ≤ 10% of baseline; zero
   `head_mode_miss` after the first full scan, or the window widens automatically.
4. Fan-earnings revisit rule: lane ≤ 30% of baseline; a read-only query shows no fan whose
   last visit is older than 31 days.
5. Followers: stage-0 explanation first; then the cap; acceptance is "no follower row
   created later than 2 h after its follow time on the canary" (from `followedAt`).
6. Jitter with (1); acceptance: inter-request gap histogram has no bin above 20%.
7. Quiet hours key shipped default off; proposed to the owner with the trade-off
   (overnight lag up to the quiet window; nothing lost — every lane resumes from its
   cursor).

## D6 — Where the cadence/SLA change lives: **agree with Position 2 on the mechanism (verified stranding), combine on numbers**

Verified: `ensurePageSyncStates` rewrites `cadence_seconds` and `slot_offset_seconds` on
existing rows when the policy constant changes (`packages/db/src/repositories/page-sync.ts:1585-1612`)
but never touches `last_scheduled_slot`; `scheduleDuePageSync` then computes
`currentSlot = floor((now − offset)/cadenceSeconds)` with the NEW cadence and skips the row
while `currentSlot <= lastScheduledSlot` (`:1930-1944`). With `now ≈ 1.79 × 10⁹ s`, a
1 800 s slot number is ≈ 9.9 × 10⁵ and a 7 200 s slot number ≈ 2.5 × 10⁵: after a forward
change the row is stranded for centuries (only manual/recovery requests would run it).
The rollback direction is safe: the new current slot exceeds the stored one, the row is
scheduled once, and the update writes `last_scheduled_slot = currentSlot` — the planner
never enqueues missed slots (one update per row per cycle, `:1936-1952`). Position 2's
claim is correct and my plan missed it.

Ship: a page-resolved policy `resolveSyncStreamPolicy(page, stream)` (platform-aware,
fail-closed Fansly page allowlist, OnlyFans default untouched) used by
`ensurePageSyncStates`, `scheduleDuePageSync`, `sync-status.ts:1029-1039` and
`health.ts:290-300`; when a row's cadence changes in either direction,
`ensurePageSyncStates` rebases `last_scheduled_slot = computeCurrentPageSyncSlot(
requested_at ?? now, newCadence, newOffset)` in the same UPDATE (`:1603-1609`), which
preserves due-ness and enqueues at most one run. Numbers: 7 200 s cadence / 14 400 s SLA
first (the owner's lower bound, smaller change), 10 800 s as a later flip of the same
key; tests pin both the rebase and the no-missed-slot behaviour.

## D7 — "Verbatim" capture and the transport: **object to bundling; clarify**

Verified: several handlers trim before `persistRawPayload`:
`trimFanslyMessagingGroupsPayload` (`services/sync/shared.ts:526`, keeps all nine row
fields, allowlists `aggregationData.accounts[]` to 18 fields — decision #224),
`trimFanslyFollowerPayload` (`:439`), `trimFanslyNotificationsPayload` (`:357`;
`fansly-notifications.ts:39-47` explains: `accounts[]` carries `lastSeenAt` and counters
that change every minute and would destroy the ~9:1 content-address dedup the disk budget
rests on), catalog and post-replies trims (`:385, :432`). So "every wire body verbatim" is
not literally true; the trims are deliberate, decision-recorded (#224), field-allowlisted
and versioned by mapper (`FANSLY_GROUPS_CAPTURE_MAPPER_VERSION`), and the untrimmed
material of the trimmed sidecars is held elsewhere (`dm_messages` journals `page.raw`
untrimmed, `shared.ts:520-525`). That is an acceptable reduction under DP 7 as the
project has defined it.

My "journaling is unchanged by the transport swap" means exactly that: the browser
transport returns the same body to the same handler, which applies the same trim and the
same `persistRawPayload` — and that sameness is what makes the undici→browser parity
measurable (identical request shape, identical trim, compare counts and hashes per kind).
Changing the trim policy inside the transport migration would break the comparison and
multiply storage on the same day. If the owner wants fuller bodies, it is a separate
decision with its own measurement: a 1% untrimmed sample per lane into the CAS (drift
detection at ~1% of the storage cost) is the cheap version; full retention needs the
dedup-loss measurement #224 already did.

## D8 — Host sizing: **number with a measurement plan**

Planning number: **8 GiB RAM, 4 vCPU** for the browser role at 6–8 profiles, with 3–4 GiB
of that as measured working set and the rest headroom (Position 2's 16–24 GiB is not
wrong, it is ~2× what a headed Firefox with one Fansly tab per profile needs; the extra
matters only if profiles keep media-heavy pages open or run one full browser process per
profile with several tabs). Basis: a headed Firefox with one heavy Angular SPA tab idles at
roughly 300–500 MB RSS across parent + content processes (public Firefox memory
reporting; the Fansly bundle is 5.7 MB of JS plus media), and the one-browser-many-contexts
layout shares the parent process (~250 MB) with ~200–300 MB per context.

Measurement plan (stage 2, canary host, no Fansly traffic beyond the login and normal
capture): launch 1, 3 and 6 profiles logged in and idle on a neutral page for 24 h, then
under stage-1 capture load for 24 h; record cgroup `memory.peak` and CPU per container
and per profile via `ps`; size the host at 1.5 × p95 of the 6-profile run plus Postgres
headroom if co-located; compare persistent-context-per-profile vs shared-browser-with-
contexts and pick the cheaper one that keeps profiles isolated. Decide VPS upgrade vs
second host after that number, not before.
