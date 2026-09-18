# Fansly events final mode — current pointer (Decision 366)

Session 2026-09-17 (Claude, after the codex handoff). Owner authorized deploys
and console flips for this round.

## Done (production)

- 16:22 UTC: B0 capture allowlist → all six Fansly pages (was lilly-1). Sockets
  verified on all six at 16:22:33 UTC; captures on every page within minutes.
- 16:27–16:30 UTC: B1 page allowlist → all six; types → `message_created,group_created`;
  policies → per page, pinned to the live generation read from
  `fansly_ws_connections`, `activationAt 2026-09-17T16:30:00Z`, no `expiresAt`,
  no `attemptLimit24h`, baselines = 2026-09-16 per-page physical attempts
  (ari-1 1137, lilly-1 4619, lilly-2 12142, lora-1 7150, lora-2 4461, lora-3 4303);
  `fanslyWsHintsEnabled` → true (v5). Converged on api/scheduler/worker.
  First results: lora-3 signal→hot apply 30.5 s; ari-1 ~126–131 s (coalesced
  bursts, one REST read per group per chunk); all attempts HTTP 200.
- 16:31 UTC: C1 `fanslyFollowersSettlementReusePageAllowlist` → all six (was lora-2).
- 16:36 UTC: A1 staged while OFF: `fanslyDmBoundedPageAllowlist` =
  `lilly-1,lilly-2,lora-1,lora-2,lora-3`, `fanslyDmBoundedPolicies` = 180 min each.
  `fanslyDmBoundedEnabled` stays false until the release below is deployed
  (otherwise status/health judge the pages against 3600 s and `/health/sync`
  degrades).

## Code

- PR #231 `feat/fansly-events-final-mode` (main): freshness target follows the
  A1 interval `(fullIntervalMinutes + 30) × 60`; Decision 366; runbooks.
  Fable review applied (certified-proof gate, /health/sync inheritance noted).
- Release branch `release/fansly-final-mode-20260917` = prod `0e3d13fb` +
  cherry-pick `f0f88852`. Deploy dist-only from the Claude worktree
  `.claude/worktrees/fansly-events-finish` (checked out on the release branch).

## Evidence

- `evidence/measurement-2026-09-16.json` (sha256 in `.sha256`): T0 baseline,
  33 812 physical attempts; dm_conversations 16 176.
- `evidence/earnings-followers-reports-2026-09-17.txt`: lilly-1 earnings shadow
  (705 rotation checks, 0 changes) and followers diagnostic (7 days).
- A0 seven-day aggregate was read live from `fansly_dm_shadow_report`
  (2026-09-10 22:58 → 2026-09-17 15:37 UTC); numbers are in Decision 366.

## Remaining

1. Deploy the release (after PR static checks), verify health, then flip
   `fanslyDmBoundedEnabled` → true; verify bounded cursors and status.
2. Measure one full UTC day (2026-09-18) with `fansly_events_measurement_report`
   against 2026-09-16; retain here.
3. Follow-ups not in this round: age-aware earnings roster (code), follower
   anomaly cooldown (design), B1 policy re-pin after a session/proxy rotation
   (runbook step; the generation-optional code change was withheld).

## Update 16:52 UTC

- PR #231 merged to main as `c54c2b57` (squash) after all CI checks passed.
- Release `f0f88852` deployed dist-only 16:42–16:48 UTC (`evidence/deploy-20260917.log`,
  376 s, health 200, roles healthy, restarts 0). All six B0 sockets reconnected
  at 16:48:15 UTC (verified 16:48:21).
- 16:50 UTC: `fanslyDmBoundedEnabled` → true; converged on api/scheduler/worker
  by 16:51. Overview: all six pages `up_to_date`, `/health/sync` ok.
- Pre-existing, unrelated: `media_stats` HTTP 500 from Fansly on five pages
  (~1 100 attempts today, source `recovery`), shown as `stalled media_stats`.
- Next: first full under A1 persists the anchor; bounded slots follow within the
  180-minute window. Verify `mode: bounded` in the overview and the per-slot
  `dm_conversations` attempt drop via `fansly_events_measurement_report`.

## B1 latency after 25 minutes on all pages (16:30–16:55 UTC)

| page | routed events | hot applied | p50 signal→hot | max |
|---|---:|---:|---:|---:|
| lora-3 | 6 | 6 | 106 s | 199 s |
| lora-1 | 48 | 45 | 410 s | 833 s |
| ari-1 | 75 | 61 | 535 s | 980 s |

All 32 admitted attempts HTTP 200. Busy pages (a chatter typing on ari-1) coalesce
bursts into one REST read per group per DM chunk, so p50 is minutes, not the
plan's 30 s target; the plan already said the page-executor route yields
"minutes" and a targeted job would be needed for seconds. Still far under the
30-minute polling floor.

Pre-A1 hourly rhythm of dm_conversations list pages (received_at, UTC 13–16):
lora-1 156/h, lora-2 83, lora-3 66, lilly-1 70, lilly-2 ~280, ari-1 8–10
(≈660/h ≈ 15.8k/day). Expected under A1@180 on the five pages ≈ 210/h.

Scheduled in this session (session-only cron; if the session is gone, run by
hand): interim verification 17:41 UTC today; partial-day measurement 08:07 UTC
2026-09-18; full-day 2026-09-18 vs 2026-09-16 at 00:13 UTC 2026-09-19.

## Interim verification 17:41–17:51 UTC (A1 enabled 16:51)

- Schedule works: each A1 page ran one certified full in the 17:00 slot
  (lilly-1 17:00, lora-2 16:58, ari-1 full30 as intended, lora-1 17:12, lora-3
  17:14, lilly-2 17:16) and the overview shows `lastFullSweepCompletedAt` for
  all five; the 17:30 slot ran NO full on those five (only ari-1). Health ok,
  6/6 sockets open, B1 attempts all HTTP 200 (ari-1 39, lora-1 33, lora-3 10,
  lilly-2 1 since 16:48).
- Savings NOT realized yet: the 17:30 bounded walks read lilly-1 35/35,
  lora-1 78/78, lora-3 33/33, lilly-2 49+/142 (still running), lora-2 20/42.
  Cause (code, not data): `advanceDmBoundedStop` invalidated the stop for the
  whole walk on any uncertain marker and reset the streak on any timestamp
  tie; A0's rule (which produced the seven-day evidence) only marks the page
  as not-unchanged and ignores ties. Production sweeps carry 1 387–6 829
  uncertain markers and 152–2 278 ties each.
- Fix: PR #232 `fix/fansly-a1-stop-rule` (Decision 367), unit 12/12,
  integration 18/18 locally, Fable review + CI in flight; then cherry-pick
  onto the release (prod f0f88852) and dist-only deploy. No flag change needed.

## Stop-rule fix in flight (18:05 UTC)

- Final 17:30-slot counts: every A1 page walked its whole list (lilly-1 35,
  lora-1 78, lora-3 33, lora-2 42 by 17:59, lilly-2 142). Zero savings until
  the fix lands; freshness unaffected (walks are full-length, just uncertified).
- Fable review of PR #232: no P1; its P2 (the order-violation rule fires on any
  busy inbox that shifts down between two page requests) accepted — the rule is
  removed too. A1 = A0's measured rule, with a stricter boundary (full START).
  Amended commit 60450f54; unit 12/12, integration 18/18, ratchet OK.
- Release branch `release/fansly-a1-stop-rule-20260917` = prod f0f88852 +
  cherry-pick 26036295, pushed; affected unit suites 57/57 on it. Deploy
  dist-only after PR #232 CI passes; no flag change needed (A1 stays on).
- Verify after deploy: 30-min slot counts per page should drop to roughly the
  A0 stop page (+1): lilly-1 ~4-5, lora-1 ~10, lora-3 ~10-11, lora-2 ~4-12,
  lilly-2 ~5-15, with one full per 180 min. Then the scheduled measurements.

## Stop-rule release deployed (18:24 UTC)

- PR #232 merged to main as `c4e25813` after all CI checks passed.
- Release `26036295` (prod f0f88852 + cherry-pick) deployed dist-only
  18:13–18:24 UTC (`evidence/deploy-20260917-a1-stop-rule.log`, 618 s,
  health 200, roles healthy on `2603629551d9`, restarts 0). All six B0 sockets
  reconnected at 18:23:26 UTC (verified 18:23:31). No flag change.
- Next: the 18:30 UTC slot is the first bounded walk under the A0-equivalent
  rule; verification of per-slot list-page counts scheduled for 19:13 UTC.

## First bounded slot under Decision 367 (18:30 UTC slot, read 18:57)

| page | list pages 18:00 slot (old rule) | 18:30 slot (new rule) | full list |
|---|---:|---:|---:|
| lora-1 | 78 | 9 | 78 |
| lora-3 | 33 | 10 | 33 |
| lilly-1 | 35 | 3 | 35 |
| lilly-2 | 142 | 3 | 142 |
| lora-2 | 33 (walk spanned the deploy) | slot at :58, pending | 42 |
| ari-1 | 5 | 5 (full30 as intended) | 5 |

Bounded slots now read ~30 list pages fleet-wide instead of ~330; with one
certified full per 180 min the dm_conversations rate should settle near
160/h versus 660/h before A1 (≈ −12k/day). No full sweeps on the five A1
pages since 18:00 (their 180-minute deadline falls at 20:00–20:16 UTC).

## Scheduled verification 19:13 UTC (slots 18:30 and 19:00 under Decision 367)

| page | pre-A1 per slot | 18:30 slot | 19:00 slot (as of 19:13) |
|---|---:|---:|---:|
| lora-1 | 78 | 9 | 9 |
| lora-2 | 42 | 13 | slot at :28, pending |
| lora-3 | 33 | 10 | slot at :14, pending |
| lilly-1 | 35 | 3 | 3 |
| lilly-2 | 142 | 3 | slot at :16, pending |
| ari-1 | 5 (full30) | 5 | 5 |

- Bounded slots read 43 list pages fleet-wide (18:30) versus ~335 before A1;
  hourly dm_conversations rhythm on the five pages ≈ 2×43 = 86/h between
  fulls versus ~655/h before. With one certified full per 180 min the daily
  estimate is ≈ 4.1k list pages versus 16.2k on 2026-09-16.
- No full sweep on the five A1 pages since their 17:00-slot certifieds (ari-1
  full30 continues every slot); their 180-minute deadlines fall 20:00–20:16 UTC
  and remain to be observed.
- Overview: all five up_to_date/fresh with lastFullSweepCompletedAt 17:01–17:28
  (age up to 2 h 12 min, within the 12 600 s target; the old 3 600 s target
  would have shown them delayed). `/health/sync` ok, 0 stalled, 6/6 sockets
  open with captures within the last minute, 70 B1 attempts since the deploy
  all HTTP 200.

## Owner decisions 19:30 UTC and the earnings round

- Owner approved the 48-hour earnings rotation; declined a followers-anomaly
  cooldown (the reconciles catch deleted/unfollowed accounts — keep as is).
- 19:36 UTC: `fanslyFanEarningsShadowPageAllowlist` → all six pages (was lilly-1);
  converged on all roles. Adds no HTTP; it records per-spender check receipts
  (`subject_refresh_state.last_checked_at`) that the age-aware roster needs.
- Implementation in flight (Opus executor, branch
  `feat/fansly-earnings-roster-max-age`, Decision 368): live key
  `fanslyFanEarningsRosterMaxAgeHours` (0 = today's behavior; 48–168 = skip a
  spender validly checked on both planes within N hours unless dirty/failed);
  recovery debt and C2c age-based targets use the same effective age. After
  review, PR, CI, cherry-pick onto prod (26036295) and deploy, set the key to
  48. First savings appear on the second daily walk after receipts exist
  (≈ 2026-09-19); expected ≈ −2 900 attempts/day.
- Stale worktree/branch `hub-fansly-events-finish-20260917` removed on the
  owner's word.

## Earnings roster (Decision 368) — review and release prep (≈ 20:40 UTC)

- Executor commit `9a6a9993` → Fable review: P1 (skip must be gated on the
  shadow allowlist — only shadow pages get dirty marks from new transactions),
  P2 (recovery debt must be anchored to the walk start, else false holds),
  P2 (latency wording: N h + one daily cadence ≈ 72 h at 48). Fixed in
  `b363baef` with three new integration cases (each fails on the unfixed code).
  Re-review: fixes correct, no regression, mergeable; P3 follow-ups noted:
  page-gate the effective age used by targets/debt (moot while every page is
  in the shadow allowlist), one checkpoint write per skipped fan in recovery,
  a re-anchor assertion for a new generation, two doc clauses (walk duration
  in the latency bound; rollback mid-walk can cause one transient hold).
- Release branch `release/fansly-earnings-roster-20260917` = prod `26036295`
  + cherry-pick `b47fe7f2`, pushed; unit 84/84 on it; integration in flight.
- Next: PR #233 CI on b363baef → merge → deploy dist-only → set
  `fanslyFanEarningsRosterMaxAgeHours` = 48 → savings from the second daily
  walk after receipts exist on every page (≈ 2026-09-19).

## First 180-minute certified fulls under A1 (20:12 UTC read)

- lora-2 full 19:58–20:01 (42 pages) and lilly-1 full 20:00–20:03 (35 pages)
  ran exactly at their 180-minute deadlines and certified: the overview's
  `lastFullSweepCompletedAt` advanced to 20:01:47 / 20:03:16; lora-1 full in
  progress at 20:12, lora-3/lilly-2 due 20:14/20:16. Health ok, 0 stalled.
- Slot 19:30 (bounded): lora-1 9, lora-2 20 (its full spanned the 20:00
  boundary), lora-3 10, lilly-1 4, lilly-2 4, ari-1 5.
- The A0 shadow now labels these fulls `uncertified_or_partial_diagnostics`:
  its own diagnostics chain needs a certified predecessor sweep and bounded
  runs break it. That is the shadow's measurement status, not A1's
  certification (which the overview confirms). A0's job is done; its allowlist
  adds no HTTP and can stay or be cleared later.
- PR #233 merged as `d2fa4dce`; release `b47fe7f2` deploy in progress.

## Earnings roster released and armed (20:19 UTC)

- Release `b47fe7f2` (prod 26036295 + Decision 368) deployed dist-only
  20:11–20:18 UTC (`evidence/deploy-20260917-earnings-roster.log`, 375 s,
  health 200, roles healthy on `b47fe7f2374e`, restarts 0). All six B0
  sockets reconnected 20:17:25–29 UTC.
- 20:18 UTC: `fanslyFanEarningsRosterMaxAgeHours` → 48 (v1) through the
  console; running values converge within the heartbeat.
- Effect timeline: receipts for every spender appear on each page's next daily
  `fan_earnings` walk (shadow allowlist on all pages since 19:36 UTC); the walk
  after that skips spenders checked < 48 h ago → roughly half of the 5 784
  attempts/day, visible from about 2026-09-19. Verification SQL is in
  `docs/runbooks/fansly-earnings-shadow.md` (Roster max age section).
- Production now runs main `d2fa4dce` equivalents for Decisions 366–368 via
  the release chain f0f88852 → 26036295 → b47fe7f2 (identity commits outside
  main preserved).

## Scheduled verification 20:25 UTC — 180-minute certified fulls

| page | 17:00-slot full | 180-min full (start–end) | pages | certified (overview) |
|---|---|---|---:|---|
| lora-2 | 16:58 | 19:58–20:01 | 42 | 20:01:47 |
| lilly-1 | 17:00 | 20:00–20:03 | 35 | 20:03:16 |
| lora-1 | 17:12 | 20:12–20:19 | 78 | 20:19:22 |
| lora-3 | 17:14 | 20:14–20:17 | 33 | 20:17:44 |
| lilly-2 | 17:16 | 20:17– (running, 93/142 at 20:25) | 142 | pending (`syncing`, fresh) |
| ari-1 | full30 | every slot | 5 | n/a |

All five deadlines fired at exactly +180 min; bounded slots before them read
4–20 pages (lora-2's 20 = the first half of its full). Overview: all pages
fresh, no `full_sweep_unconfirmed`/`delayed`; `/health/sync` ok, 0 stalled,
6/6 sockets with a fresh guard. The A0 shadow's `uncertified_or_partial_diagnostics`
label on these fulls is the shadow's own broken diagnostics chain (bounded runs
have no diagnostics), not an A1 certification failure. Nothing to diagnose.
