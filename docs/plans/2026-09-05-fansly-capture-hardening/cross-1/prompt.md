# Cross-exchange round 1 — disputed points

You wrote an independent plan for the Fansly capture hardening task. Another planner wrote
one too. Below are the points where the two plans disagree. For each point you get the two
positions anonymized as Position 1 / Position 2 (the order is arbitrary and differs per
point). One of them is close to yours; treat both as arguments, not as ownership.

For EACH point reply with one of:
- **agree** with the other position — say why, what changed your mind;
- **object** — reasons grounded in code (cite repo paths), the owner's answers or the
  constraints; where a claim is factual, verify it in the repo and say what you found;
- **combine** — a concrete synthesis keeping the strengths of both, and what it costs.

Rules unchanged: read-only, no network calls to Fansly or production, you may read the
repo, the extension repo, the HARs (never copy secrets) and public docs. Write to the
output path given in the message that launched this round. Be dense; cite; no restating
the whole plan. Orchestrator-verified facts you may rely on:
- `parseRetryAfterDelayMs` clamps to `MAX_RETRY_DELAY_MS = 60_000` (`packages/shared/src/http-client.ts:20,546`).
- The Fansly adapter's fetch uses its own `getDispatcher(context.proxy)` (`packages/fansly/src/adapter.ts:2010,2158`); `resolveEgress` is called only by vendor consumers (`services/telegram.ts`, `voice-notes.ts`, `service-egress-verify.ts`), not by the Fansly read path.
- `page_sync_states.last_scheduled_slot` is compared as `currentSlot <= row.lastScheduledSlot` (`packages/db/src/repositories/page-sync.ts:1930-1944`) where `currentSlot = floor((now - offset)/cadenceSeconds)`; the `ensurePageSyncStates` insert is `on conflict do nothing`.
- Production: dm_conversations ≈ 51% of pull observations; lilly-2 ≈ 6 465/day of them (`reference/prod-facts-2026-09-05.md`).

## D1 — Which browser for the page profile

Position 1: Playwright's Firefox build, headed under Xvfb; fallback ladder: stock Firefox
ESR via WebDriver BiDi, then Camoufox only if a JS challenge appears. Argument: every real
client on the page IP (chatters, the extension, the captured UA) is Firefox; a Firefox
profile is indistinguishable from one more chatter; UA/TLS/H2 follow Firefox releases.
Playwright Firefox exposes `navigator.webdriver` (JS-visible only).

Position 2: a pinned, ordinary headed Chromium build with the sandbox enabled, driven by
Playwright. Argument: supported control/proxy tooling; Playwright's Firefox is a patched
browser and "should not be sold as identical to chatters' stock Firefox"; let the profile
advertise its actual browser/OS. Not a claim that Chromium is safer.

Question: which one, and does a Chromium UA appearing on a page IP where every other
session is Firefox matter? Consider SOCKS5-with-auth support (Chromium lacks native
SOCKS auth), profile persistence, and how each handles a future AWS WAF challenge.

## D2 — Shape of the DM conversation sweep after the cadence change

Position 1: make the sweep head-incremental: `/messaging/groups?limit=20` from offset 0,
stop after two consecutive pages whose `lastMessageId`/`lastUnreadMessageId` set is
already known; keep the existing full scan (membership generation, decision #214) on its
own 24–48 h cadence; cadence 3 h. Claimed effect: `dm_conversations` ≤ 15% of baseline.

Position 2: keep the resumable full scan at 100 per page, change only the cadence to 2 h
(≈ −38% of total observations); "removing detail reads or stopping at the first unchanged
page can lose facts" because the exact-set completion guards (#214: visibility pass only
on `count(generation) == observedCount`) protect visibility; changing 100 → 20 multiplies
list requests ~5×, so 20/page at 2 h could be 1.25× today's list requests; evaluate page
size and cadence jointly and keep 100 during the transport comparison.

Question: can a head-incremental mode coexist with #214's membership semantics (which
rows get `last_seen_generation`, when does the visibility pass run), and what is the real
request arithmetic for lilly-2 (≈13 500 conversations) under each proposal? Give numbers.
Cite `apps/runtime/src/services/sync/executor-handlers.ts:2780-2930, 3540-3600` and
`docs/decisions.md` #214.

## D3 — How the browser executes a read, and how locked-down the tab is

Position 1: the kernel's request runs as `fetch` from the `fansly.com` origin inside the
page; a small injected helper sets `fansly-client-id/ts/session-id/check` from the
profile's own state (`localStorage` device id and active session; check key extracted
from the served bundle by AST walk, "last assignment wins"; fallback: reuse the check the
app itself last sent for that pathname, harvested via `page.on('request')`). The app's own
tab stays alive with its WebSocket open (later tapped for freshness).

Position 2: prefer the app's own HTTP pipeline so its session/WAF machinery produces the
request; a plain `page.evaluate(fetch)` does NOT invoke the app's interceptors; an offline
prototype against a fake platform must prove a maintainable read bridge before any live
use (go/no-go gate). Capture mode is default-deny: only allowlisted GET operations, block
all platform mutations including `/message/ack`, `/status`, telemetry POSTs the live app
emits, block WebSockets initially, cover service workers/popups. If no safe bridge
exists, stop and keep stages 1–2 plus hardened replay.

Question: which execution model, and should the app tab be "alive" (WS, background POSTs)
or locked down? Address: does a live Fansly tab mark conversations read or emit
presence/acks that change what chatters see; can `page.route` block them reliably; what
does the injected helper need from the bundle and how fragile is it (decoy assignments,
public issue prof79/fansly-downloader-ng#115).

## D4 — 429 handling

Position 1: a 429 becomes a terminal failure for the request, no in-request retry; the
executor backs the WHOLE page off for 30–60 min; a second 429 within 24 h opens an
incident.

Position 2: respect the full `Retry-After` (today clamped to 60 s), publish it as a
durable page/egress cooldown consulted by every kernel attempt (all streams, probes,
verification); a 429 yields a checkpoint-preserving retry counted as an attempt; a wait
longer than the chunk budget releases the lease; repeated unadvised 429s use bounded
increasing backoff.

Question: combine? Specify the concrete rule (where the cooldown lives, who reads it,
what the extension does with its own reads).

## D5 — What goes into stage 1 (traffic-shape reform) besides the cadence

Position 1: cadence + head-incremental sweep + `fan_earnings` visits only fans with
activity since the last visit or older than 30 days (−85% of that lane) + hourly follower
walk capped at N pages with completeness left to the 48 h reconcile + jitter on the
2.6 s metronome (uniform 0.6–1.8×) + optional quiet hours + 429 rule + challenge
classification; all behind live keys, one flip at a time.

Position 2: stage 1 = cadence only (with health/SLA/tests); per-fan earnings and
followers are "the next measured candidates" after the migration, "do not skip inactive
fans indefinitely or weaken reconciliation merely to hit a traffic target"; "fixed minimum
spacing is not proof of abuse; random sleeps are not a safety certificate"; no quiet hours
without shift data; notifications: keep 30-min forward polling, the "33 days of overlap"
is an observed-rate assumption, not a guarantee.

Question: which reductions are safe to ship before the transport change, in what order,
and with what acceptance numbers? Is jitter worth anything? Is an overnight slowdown
worth proposing (owner has not said whether a night shift exists)?

## D6 — Where the cadence/SLA change lives

Position 1: change `SYNC_STREAM_POLICY.dm_conversations.cadenceSeconds` 1800 → 10 800,
`freshnessSlaSeconds` 3600 → 28 800, domain `messages_live` the same; health, deploy gate
and integration pins move in the same PR; optionally make cadence a live key with SLA =
2.5 × cadence.

Position 2: a Fansly/page-resolved policy behind a fail-closed page allowlist; keep the
OnlyFans default; 7 200 s cadence, 14 400 s SLA; atomically rebase `last_scheduled_slot`
(stored in old-cadence units) on forward and rollback transitions or scheduling strands
far into the future; never enqueue all missed slots.

Question: verify the slot-stranding claim in `packages/db/src/repositories/page-sync.ts`
(who writes `cadence_seconds` for existing rows; what happens to `last_scheduled_slot`
when the constant changes) and say which design you would ship.

## D7 — "Verbatim" raw capture and the browser transport

Position 1: journaling is unchanged by the transport swap (same `persistRawPayload`).

Position 2: some handlers trim sidecars/aggregations BEFORE `persistRawPayload`
(`services/sync/shared.ts:83,526`, `fansly-notifications.ts:39`), so "every wire response
is journaled verbatim" is not literally true; the browser transport should journal the
original business body before transformation with a versioned mapper bridge; measure
storage/CAS impact first.

Question: verify; is retaining full bodies worth the storage, or is the current trimming
a deliberate, acceptable reduction under DP 7?

## D8 — Host sizing

Position 1: ~300–500 MB per Firefox profile → 3–4 GB for 6–8 pages (VPS upgrade or a
second host). Position 2: planning allowance 4–8 vCPU and 16–24 GiB for 5–8 profiles.
Give your number with a source or a measurement plan.
