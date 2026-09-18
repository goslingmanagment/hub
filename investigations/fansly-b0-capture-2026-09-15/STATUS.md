# Fansly events — current continuation pointer

## Full-state replacement checked; owner freshness choice pending (2026-09-17 15:28 UTC)

The active objective remains the complete migration, including actual request
reduction. The successful one-message example below did not finish that objective.
Two bounded alternatives to reducing freshness were inspected without new Fansly
requests, new messages, configuration changes, CI or deployment:

- The retained official client implements `GET /message/unread` as interaction
  pagination, not a snapshot of all chat flags, visibility and current heads.
  The retained HAR response shape is `messageInteractions,total`; it cannot
  replace the full mutable-state contract. Group detail reads address one known
  group and do not independently discover missed changes across the roster.
- The observed messaging-list calls in the retained HARs requested 10 or 20
  rows. Production's adapter requests 100 and treats a shorter response as end
  of list. There is no retained proof here of support for more than 100 rows;
  increasing the requested size without provider-cap evidence could truncate
  discovery. This is not a claim that the provider definitely caps at 100.

Sources: root `artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js`
lines 34477, 34714 and 35182; retained HARs under root `artifacts/`; deployed
release `packages/fansly/src/adapter.ts` lines 1134-1192. These client artifacts
are historical evidence, not a current exhaustive provider API contract.

The owner was asked to choose between preserving freshness without a mandatory
50-percent target, or allowing full chat scans every 3 hours and earnings scans
every 48 hours, with measured savings. No answer has been received; neither
choice is approved by a preselected UI option or by elapsed time. For the
retained Sep15 workload, even the latter has an optimistic 52.79-percent ceiling
before bounded scans, event reads and recovery: `(16656*5/6 + 6176/2)/32145`.
It is not a forecast, an accepted per-fan age bound or proof of >=50% savings.
Reduced earnings rotation would still require implementation; it is not an
existing C2c switch. No freshness/status threshold has been weakened.

Fresh read-only production evidence at 15:27-15:28 UTC: Lilly-1's existing B0
connection 84d964fd is open with a current guard, 330 retained decode receipts,
first receipt 01:19:17.553 and latest 15:12:18.890 on Sep17. Corpus nodes are
4/2=315, 5/1=4, 5/10=2, 5/22=5, 5/3=1 and 9/1=3 (service/type). There is no
group-created 4/8 sample. Exactly one completed B1 attempt exists since the
accepted example. This supports continued capture, not seven accepted days or
general/permanent B1 rollout. The first exploratory aggregate mislabeled its
last-received bound; the direct min/max query supplied the corrected bound above.

## Final B1 route accepted; rollout decision closed (2026-09-17 15:08 UTC)

**The coordinated B1 example succeeded and has been switched off.** The owner
approved exactly one Ari-1 -> Lilly-1 message and a maximum 15-minute,
10-attempt window. After Firefox became available, the exact known conversation
956621723275390976 showed the verified sender itsaribae and recipient WetLillys.
The earlier 14:44 policy had never been enabled and expired unused; no empty
live trial was extended. The actual trial policy was saved while off:
15:00:53.441 -> 15:15:53.441 UTC, same accepted generation and original 5018
baseline, Lilly-1/message_created only, cap 10. Policy convergence preceded the
15:02:14.805 enable request; all-role on convergence preceded the send.

Exactly one Send action at 15:04:06.816 UTC transmitted
`Техническая проверка Hub B1 — 17 сентября`. The native conversation displayed
one matching message and an empty composer. No repeat send or visibility change.

Proven chain:

- Durable B0 observation 2614949 received 15:04:08.172 and decoded retained
  15:04:08.185332; unchanged generation and the existing connection 84d964fd.
- Event 19341178 routed message 956985351879016448/group 956621723275390976,
  revision 1. One physical event-sourced attempt (run 774861) admitted
  15:05:14.679, HTTP 200, finished 15:05:15.099.
- REST raw page 3004663 retained; atomic hot apply 15:05:15.183125,
  requested/applied revisions both 1, boundary_checked, no next_due debt.
  Server receipt latency from signal to hot apply: **67.011125 seconds**.
- Independent production-pinned `hub transcript` confirmed the exact messageRef
  and text by 15:06:13.269632, sourcePlane page_dm_messages,
  contentPending=false, no source errors or gaps. About 125 seconds elapsed
  from signal to this local confirmation; first reader availability and
  server/local clock alignment were not independently measured.

The reader's nativeMessageRef is null for this hot-plane row; the exact ID is
messageRef. Its delivery_not_exhausted/mutable_sort_key/no_frozen_snapshot
caveats remain. Provenance reports no_material_lane/unknown ingest path, so the
cross-referenced B1 receipt proves this hot write; the reader alone does not
prove canonical/archive convergence or complete-window delivery. This one
sample is not p95/p99, all-event coverage, outage recovery or causal savings.

Disable requested immediately after the successful route at 15:06:11.549 UTC;
all-role off convergence confirmed at **15:08:02.671 UTC**, before expiry.
Exit SQL 15:07:57.459823 retained exactly **one** successful physical attempt,
325/325 decoded receipts retained, same open B0 connection/current guard,
one advisory owner. No additional attempt after the selected 15:05:14.679
admission. No wait to the future expiry was performed or claimed as evidence.
Ordinary Messages Live advanced and remains up to date, 3550 conversations,
1695/1695 HTTP success, original 30-minute cadence. History's pre-existing
Delayed state remains, 3465/3465 ready, zero left, 1946/1946 HTTP success.

**Remaining scope is decided, not another testing backlog.** All agreed code
is deployed. B0 stays enabled for Lilly-1; C1 stays narrowly enabled for Lora-2;
C2c stays additive on Lilly-1 within its existing budget and daily rotation.
B1's live message-created route is now proven; broader/permanent activation is
not granted by this bounded trial. A1/reduced full polling and reduced earnings
rotation remain NO-GO under unchanged freshness for the concrete reasons below.
Retained T0 counts changed -13.7464%, but causal >=50% savings remain unproven.
Do not automatically start another test, deploy, CI run or calendar wait. The
existing A0 report may add evidence; elapsed time cannot reverse the no-go.
If >=50% is mandatory, the remaining product decision is a changed freshness
contract or a separately accepted replacement detector. B2 remains parked.

No code change, new CI/deploy, session/proxy change, message deletion, receiver
restart, general audit or new automation. Original private evidence is in
`/Users/dmitriy/.local/share/hub-w0-private/20260917-final-rollout/`:
active-b1-plan.json, single-send-receipt.json, b1-after-send.jsonl,
b1-route-result.jsonl, b1-exact-reader.json, b1-exact-match.json and b1-exit.jsonl.
The earlier preparation/browser-conflict sections below are historical.

## Owner steering: finish the migration without another verification loop (2026-09-17)

The owner explicitly asked to reduce checks and finish the whole job faster.
The agreed implementation is already merged and deployed. The outstanding
result is rollout/acceptance and measured request reduction; full polling still
runs, so shipped event handling is not evidence of achieved savings. PR #230 was
a real side defect, but further side fixes must not extend this migration.

Execution rules for the remainder:

- Reuse passed tests, reviews, kill-switch, presence and paired-message evidence.
  Repeat only when a relevant change or failure invalidates that evidence.
- No new audit, diagnostic framework, speculative fix or empty timed trial.
  Broader follower suppression has no demonstrated safe fix and is not a coding
  backlog item. Keep unrelated findings separate.
- If a release-blocking defect is found, finish the fixes together: focused local
  regression checks, one independent review, one final required CI and one
  deployment. Finalize comment/prose changes before that CI. Recheck a composite
  release only for the integration risk it actually adds.
- Use the existing A0 report once to make a concrete rollout/no-go decision.
  A calendar deadline does not resolve historical unknowns, and a no-go must
  name the actual missing guarantee or owner decision instead of starting
  another open-ended audit.
- B1 needs one observed event through addressed REST to the reader. Prefer one
  deliberately coordinated short example over hoping for traffic during serial
  hour-long windows. A new trial and a new message are still not authorized by
  this process change: Decision 364's expired trial is not silently extended.
- Prepare one consolidated rollout decision for the remaining A1/C2 scope.
  Apply any authorized settings sequentially with their existing propagation
  checks; do not merge settings into a blind bulk flip. Use the existing T0
  exporter for one comparable result measurement rather than more instruments.

Final deliverable: enabled scope, actual physical request change, observed
freshness/reader latency, rollback and explicit uncovered cases. If the original
>=50% reduction with unchanged freshness is not supported, state that result
and the precise remaining product choice. Do not relabel "code deployed" as
that outcome or silently trade away freshness to declare completion.

## B1 message approved; configuration prepared, browser in use (2026-09-17)

The owner replied `делай` to the exact one-message, 15-minute, 10-attempt
confirmation. This authorizes the prepared Ari-1 -> Lilly-1 message and one
bounded trial; do not ask for the same send approval again.

At 14:43:48 UTC, the original B0 connection 84d964fd remained open under the
accepted generation with one owner and fresh guard. All 318 decode receipts
were retained; zero B1 physical attempts. The signed-in native Ari-1 tab first
showed the verified WetLillys conversation and an empty composer.

While B1 remained off, the new policy was saved through the owner console:
activation 14:44:08.202, expiry 14:59:08.202 UTC, Lilly-1/message_created,
cap 10/rolling24h, original 5018 baseline and generation. Console convergence
was confirmed by 14:45:52 UTC. Page/type settings were already correct and were
not needlessly rewritten. No master-switch enable has been requested.

Firefox then changed to another customer conversation with an in-progress
owner draft. Computer Use cancelled two attempted UI interactions with
`The user changed Firefox`; the next state read confirmed the different chat.
No test text was pasted and no Send action was attempted. Do not overwrite or
send that unrelated draft. The owner was asked only to free Firefox for two
minutes or send the already approved message themselves after the ready signal.
The sender binding remains Ari-1, recipient WetLillys, test group
956621723275390976; only that destination may receive the approved text.

Ordinary sync entry UI: Messages Live up to date, 3550 conversations,
1695/1695 successful attempts24h, 30-minute cadence. History retains its prior
Delayed state, 3465/3465 ready, zero left, 1945/1945 successful attempts24h;
this is not a new B1 failure. No manual sync/reset or provider hydration.
CLI capabilities still report the deployed contract hash 8e9dda0b...c33b2.

The trial has not begun. Keep B1 off until the coordinated message is ready.
If this prepared policy expires before browser access resumes, it is an unused
configuration, not an inconclusive live trial; retain it and prepare the same
already-approved single 15-minute trial when the sender is ready. Never extend
an actually running/expired quiet trial or add another message.
Evidence: approved-b1-plan.json, b0-approved-entry.jsonl,
capabilities-approved.json, send-not-attempted.json and b1-canary-status.sql in
`/Users/dmitriy/.local/share/hub-w0-private/20260917-final-rollout/`.

## Consolidated rollout decision (2026-09-17 13:23 UTC)

The owner's latest instruction authorizes finishing the fast path. Preparation
is complete; no new flag was changed and no message was sent at this point.
The previous report and passed regressions are reused; no new CI/deploy is
needed because implementation has not changed.

**A1 request reduction: NO-GO under unchanged whole-list freshness.** This is
an evidence decision, not a wait for the seven-day clock. The retained September
15 report already contains complete sweeps with changes below the proposed
stop: Lilly-1 G7577/G7601 each report one state change; Lora-1 G4959/G4960/G4997
each report a flags change, and G4971 a state change. Full polling captured these;
these are shadow counterexamples, not losses caused by enabled A1. Repeated
reader-missing counters are not unique missing messages and are not attributed
to a new regression. Historical Lilly-2 ambiguity and the exact excluded head
remain separate unresolved evidence. Keep A1 off and the existing full schedule.
Full30 would preserve its original slots and does not substantiate substantial
request savings. Reaching seven days cannot override these counterexamples.

**C1/C2 decision:** keep the already enabled narrow Lora-2 settlement reuse and
Lilly-1 additive earnings recovery/targets (10 extra attempts/rolling day).
Broader follower suppression lacks a supported safe rule; C2 daily rotation
remains necessary for quiet corrections and unproven per-fan maximum age.
There is no authorized interval reduction that preserves the current contract.
Do not start another quiet-correction wait or introduce weekly rotation.

**Cost result:** reuse the complete retained T0 comparison, September 12 versus
September 15 UTC: 37,268 -> 32,145 physical sync attempts, -5,123 (-13.7464%).
The comparator reports eligible count comparison, zero blockers, causal savings
unverified and reader latency unmeasured. Different workload/days and intervening
changes prevent attribution; this is neither achieved >=50% savings nor a
freshness-parity result. Browser traffic is outside that ledger. Source:
`/Users/dmitriy/.local/share/hub-w0-private/http-day-20260915/`.

**B1 final route example:** native Firefox Ari-1 / itsaribae is open in the
verified Lilly / WetLillys conversation `956621723275390976`, with the prior
approved test messages visible. Do not confuse it with natural-message group
`912295888171315200`. Prepared text: `Техническая проверка Hub B1 — 17 сентября`.
The owner is being asked once for this new message plus a fresh, explicitly
bounded 15-minute Lilly-1/message_created trial, cap 10, existing generation
and baseline 5018. Configure policy while off, verify, enable, send exactly
once, inspect receipt -> physical REST -> atomic hot apply -> exact reader ID,
then disable immediately on result or failure. Do not replay the disabled
receipt, silently extend the window or repeat an uncertain send.

Fresh read 13:19:54 UTC confirms the post-deploy B0 connection 84d964fd is open,
same accepted generation, current guard and exactly one owner; 296 decoded
receipts all retained. It captured a new message-created event at 13:08:22.582
(observation 2611089), so post-deploy business capture is now observed. This
receipt was disabled for B1 and cannot be rerouted. B1 attempts remain zero.
Owner console confirms B0 on/Lilly-1, B1 off with its old expired policy, and
existing C1/C2 settings. No presence or session/proxy change was made.

Private entry receipt and derived retained-report summary:
`/Users/dmitriy/.local/share/hub-w0-private/20260917-final-rollout/`.
The remaining product choice, if >=50% reduction is still mandatory, is an
explicitly changed freshness contract for quiet state/membership/earnings or
a separately accepted replacement detector. The present code cannot honestly
promise both >=50% reduction and unchanged full mutable-scope freshness.

## Reader count fix deployed and verified (2026-09-17)

PR #230 is now in production. Clean composite release
`0e3d13fb02392ca3fae2f186a51bc108dea3739c` starts from the previously running
`2c96d9a4` and adds only the four reviewed PR files, preserving the identity
changes already deployed outside main. Worktree/branch:
`/Users/dmitriy/.codex/worktrees/hub-agent-transcript-count-release` /
`codex/agent-transcript-count-release` (pushed). Source/test files match merged
PR #230 exactly. Release PostgreSQL suites: 49 passed. The standard dist-only
script built and deployed this revision, with apps-only recreation and no image
GC, finishing at 13:04:44 UTC in 215 seconds. API/sync health checks passed and
the production-pinned CLI was rebuilt from the full release commit; contract
hash remains `8e9dda0b2352b0b7a106e515a3282493b0977db4c730466681e985e20e7c33b2`.

Independent container read at 13:06:35.269660 UTC: API, worker and scheduler
healthy, restarts 0, all source `0e3d13fb0239`, image
`sha256:96e776a6e20131482ce128a97610368d6cb087c1ba16fec5c09874309211c7e3`;
13,189,931,008 free bytes. An earlier unauthenticated HTTP verification attempt
returned 401 and did not produce its combined JSON; do not count that attempt
as a successful health read. The standard deploy's authenticated health result
and the separate container/Agent reads above are the successful evidence.

Selected Lilly-1 transcript, conversation `900557177436004352`, fixed window
2024-01-01 through 2026-09-17 00:00 UTC: before and after return count 817 exact,
same sampled message ID `921434389525577728` and identical text, no source errors.
Both retain delivery-not-exhausted and the before-capture-floor gap (archive
starts 2026-06-11 12:37:17 UTC); this is stored-row parity, not complete platform
history or a live count-above-1500 proof. Those boundaries remain proven by the
PostgreSQL regressions. No hydration or provider request was made for this read.

B0 read at 13:05:44.289054 UTC: new connection
`84d964fd-f415-408d-919f-352b2bb7881d`, started 13:04:18.427051 UTC, verified
13:04:23.450063 UTC, same accepted generation, current guard, one advisory owner.
Previous connection closed normally as disabled at 13:03:15.259727 UTC during
deploy. All 289 decode receipts remain retained; zero B1 attempts. The new
connection has not yet captured a business frame in this read; deployment-gap
event recovery is not inferred. No flags, polling cadence, sessions or proxies
were changed. No new B1 window, test message or monitor was launched.

Original deploy/release logs: `/tmp/hub-agent-transcript-count-{deploy,release-pg,release-install}.log`.
Private before/after reads and retained logs:
`/Users/dmitriy/.local/share/hub-w0-private/20260917-reader-count-release/`.
No pending implementation/deployment remains for PR #230. The migration still
needs the existing A0 seven-day report (earliest 2026-09-17 22:58:33.610 UTC),
unresolved scope/freshness acceptance, and a live B1 event-to-reader sample.
Do not restart a quiet trial, add a monitor, or treat this reader fix as A0 GO.

## Reader count fix merged; queued for the next combined deploy (2026-09-17)

The separate count defect recorded in the September 14 A0 investigation still
existed in current main. It is now reproduced and fixed in
[PR #230](https://github.com/goslingmanagment/core/pull/230), worktree
`/Users/dmitriy/.codex/worktrees/hub-agent-transcript-count`, branch
`codex/agent-transcript-count`. Base `975f191b`, implementation `f09755e5`, final
head `3d4ca2bf6179114060a8bd36e12a1dfe3c98f2b9` (two review-comment clarifications).
The shared query's delivery ceiling previously made 1501/5001/5002 matching
messages all report `value: 1500, exact: true`. Delivery and its EXPLAIN still cap
at 1500; count now probes its independent threshold plus one. Runtime counts
through 5001 are exact; 5002 is a lower bound. Source precedence, deduplication,
tombstones, filters and cursor clearing remain unchanged; Decision 365 records
the contract.

Original before-fix PostgreSQL run: 3 expected failures, 4 passes. Final relevant
PG suites: 49 passed. Full pnpm check: 4187 passed, 9 existing skips;
strictness 1893/120, lint/build passed. Independent reviewer approved both
implementation and final head.
The last commit changes comments only; TypeScript output with comments removed
is byte-identical in both files. Original failed/passing logs and final CI JSON
are retained under `investigations/agent-transcript-count-2026-09-17/` in that
worktree (the original `/tmp/hub-agent-transcript-count-*.log` also remain).
Final-head CI 35222372247 passed all required checks; image publication was
skipped for the PR. Original CI 35222289105 was superseded and cancelled; its
Quality Gate failure reflects cancellation, not a test verdict.
PR #230 merged at 12:53:56 UTC as `b71b2e65a9c3372056ff630f20cc11bead65ff7b`.
The merged tree equals the reviewed final head. Tracked source is clean;
the local verification receipts remain untracked.
No deployment yet; include this fix in the next combined release, preserving
the production identity changes absent from main. Do not deploy clean main.

Fresh bounded read at 12:29:54.311720 UTC: B0 connection d948a42c still open,
current guard, one advisory owner, 281 decoded receipts all retained; zero B1
attempts. No new message-created event after the original 06:04:33 event. The completed quiet B1
trial is not restarted. Receipt `b0-followup-next.jsonl` in the existing private
20260917-heartbeat-recovery folder. Exact Lilly-2 debt read at 12:34:19.926437 UTC
remains pending, attempts 0, captured_at null, excluded for
`partner_unresolvable_from_account_lookup`; receipt `a0-specific-debt-followup.jsonl`.
This count fix neither repairs that advertised head nor explains historical
G6917/G6918. A0's existing report time, C1/C2 acceptance and B1 live-route proof
remain separate; no new provider request, flag, test message or monitor.

## B1 quiet canary closed; stop-reason fix deployed (2026-09-17)

Policy expired at 11:09:26.581 UTC. Exit read at 11:10:03.253572 UTC:
19 retained/projected events in the window, all other/unrouted types; zero
decoded message-created frames, zero B1 physical attempts and zero admissions
at/after expiry. All 258 B0 decode receipts are retained; no pending/decode debt.
Same connection and accepted generation held throughout the observed trial,
one advisory owner, fresh guard and no stop. No B1 hot-write/latency sample was
produced. This is inconclusive traffic, not successful live addressed-REST proof.
Do not extend or reroute old events. B1 disable requested at 11:10:27.988 UTC;
all-role off convergence confirmed by 11:12 UTC. B0 stays on.

Exit Agent Read Plane still returns exact entry message 956849556971077632 from
message_archive, contentPending=false, no gaps/source errors; the existing
delivery_not_exhausted caveat remains. Direct hot-table reads are not granted
to read_only (checked without attempting forbidden reads); no privileged
fallback used. There is no B1 hot_applied_at receipt to replace the absent sample.
Ordinary Messages Live advanced during the trial and remains up to date,
1695/1695 HTTP success; History retains its pre-existing Delayed state,
3465/3465 ready, zero left and 1946/1946 successful attempts, next due in 2 hours.
Original exit receipts: b1-canary-expired.jsonl and b1-exit-reader.json in the
existing private folder. No new test message or extra provider read was sent.

### Completed canary setup and entry evidence

Natural B0 message-created evidence arrived at 06:04:33.103 UTC, observation
2600990 / event 19266409 / message 956849556971077632 / group 912295888171315200.
Decode retained, no pending debt for the selected event, same accepted generation;
B1 receipt was disabled and is not rerouted. Agent Read Plane independently
returned the exact message from message_archive, contentPending=false, no source
errors/gaps. Its delivery_not_exhausted caveat remains; this is a row witness,
not a completeness claim. Existing kill-switch and unchanged baseline hash reused.

At entry, production image was 8dffc188 / source f0fc4042; roles healthy, restarts 0.
B0 has 237 decoded receipts at entry and one owner. Overnight it retained two
guard_unavailable stops and one pong_timeout; automatic recovery succeeded.
The 03:00 disabled reason is ambiguous: the old supervisor also wrote disabled
when its configuration read failed or stalled. That diagnostic defect was
reproduced and fixed below; do not infer an owner flag flip from the old receipt.
Two unrelated mutation_debt receipts remain outside the accepted message-created
type. Entry connection f88df73c-f003-4c8c-afd9-6092c47ae169, started 09:41:31.686 UTC,
same generation, current guard and captures. Historical gaps remain unknown.

Page lilly-1, type message_created and policy were saved separately through the
owner console with B1 off; all-role convergence verified before enabling.
Policy activationAt 2026-09-17T10:09:26.581Z, expiresAt 2026-09-17T11:09:26.581Z,
attemptLimit24h 10, baselineAttempts24h 5018, original baseline SHA256 unchanged.
Enable requested 10:11:05.059 UTC; all-role convergence confirmed by 10:13 UTC.
Polling/history/daily rotation unchanged.
Entry sync UI: Messages Live up to date, 3550 conversations, 1695/1695 HTTP success;
History retains existing Delayed state, 3465/3465 ready, zero left, 1946/1946 success.

The bounded window, exit read and B1 disable are complete; raw and receipts
remain intact. No automatic extension/new DM.
Private SQL and original entry/reader receipts are in the existing
20260917-heartbeat-recovery folder; use b1-canary-status.sql for bounded reads.

### Stop-reason diagnostic fix merged and deployed

Isolated worktree `/Users/dmitriy/.codex/worktrees/hub-fansly-b0-stop-reasons`,
base `25cca331`, branch `codex/fansly-b0-stop-reasons`, commit `5aa2b508`.
Supervisor config rejection/stall now preserves `guard_unavailable` through
the page controller and receiver; explicit shutdown/removal keeps `disabled`.
Existing watchdog, retry, capture and ownership behavior unchanged.
One new unit case and both new real-worker PostgreSQL cases failed before the
fix with the previous `disabled` receipt. After fix: unit 16 passed; PG 15 passed;
full pnpm check 4187 passed / 9 existing skips, ratchet 1893/120, lint/build passed.
Independent reviewer approved. All required checks in CI run 35209752715 passed
on head `5aa2b5088926863e7df5bc085f139625786240a0`; image publication skipped.
[PR #229](https://github.com/goslingmanagment/core/pull/229) merged at
10:31:10 UTC as `975f191bc6aa919f33ad2fb7a3a772a03df2f9b8`.
Original logs `/tmp/hub-b0-stop-reasons-{unit-before,pg-before,unit,pg,check,ci}.log`.
Release worktree `/Users/dmitriy/.codex/worktrees/hub-fansly-b0-stop-reasons-release`
starts at the previous production `f0fc4042`, preserving its deployed identity changes.
It contains PR228's tests as `4fd5fc7a`, then the exact reviewed fix as `2c96d9a4`.
Only the five reviewed files differ from that baseline. Production build passed;
the exact release B0 unit/PG suites passed 31 tests (91.92 seconds). Release logs:
`/tmp/hub-b0-stop-reasons-release-{install,build,tests}.log`.
After B1 expiry/cleanup, the authorized standard dist-only deploy started from
clean release `2c96d9a4c08a4c0e028067586c0d6f65bf959667`. Apps-only recreation;
image GC disabled. Fresh preflight: source f0fc4042/image8dffc188 unchanged,
all three roles healthy, restarts 0 and 13 GiB free. Deploy log:
`/tmp/hub-b0-stop-reasons-deploy.log`. Deployment verified successfully at
**11:15:05 UTC**, elapsed 174 seconds. API and sync health passed; the shared
production-pinned CLI was rebuilt and its unchanged contract verified.

Independent post-deploy read at 11:16:04 UTC: all three roles healthy,
restarts 0, source **2c96d9a4c08a**, image
`sha256:7491abbc5bf50b7883e11dea98110f3d55d936ee43271e78497e2748f1b6bd2a`.
B0 connection `d948a42c-448c-4b4c-8adf-b8e975606c24` started 11:14:38.193674 UTC,
verified 11:14:43.231057 UTC, same accepted generation, fresh guard and one owner.
No business capture on that new connection at this read; do not invent one.
All 260 existing decode receipts retained; zero B1 attempts, including after
expiry. Owner-console all-role state confirms B0 on for Lilly-1 and B1 off;
the expired policy remains as evidence. Post-deploy receipt: b1-postdeploy.jsonl.

### Remaining live evidence

Missing: a message arriving during an active B1 window, followed by an admitted
addressed REST read, its atomic hot receipt and independent Agent Read Plane row.
This quiet trial supplies no latency or savings measurement. No repeat trial
has been scheduled. B0 continues capture; the broader acceptance and existing
A0 seven-day read remain separate. No new automation, message, session/proxy
change, polling reduction or B2 work was performed.

## Recovery verified; B0 enabled; heartbeat regression merged (2026-09-17)

Owner explicitly requested diagnosis, necessary launches/waiting and code
continuation. One reviewed 120-second recovery probe ran 01:13:18.815–01:15:18.835 UTC
with production image `8dffc188` / source `f0fc4042` and the original accepted
binding receipt. Same generation
`c7a7ea0c8cf2fce9c2f3e697482e8abce3ae9767869991c6a44a9dfddf7226da`;
one connection, 8/8 frames retained, deadline exit 0, unchanged final generation,
cleanup and output sync confirmed. This proves present recovery from the
heartbeat failure. Six-hour continuity and missing gap-event recovery remain
unproven; the historical failure does not identify a provider or transport root
cause. No threshold, credential, route or polling change was made.

### B0 live capture

B0 was enabled alone through the authenticated owner console: exact page
allowlist `lilly-1` first, verified, then the enabled flag. First connection
`3f75493d-6a11-4a13-8159-42a72c9e8d55` started 01:17:33.822 UTC and verified
01:17:38.836 UTC; it retained a decoded service event at 01:19:17.553 UTC.
Kill-switch requested 01:19:55.470 UTC; durable close 01:20:03.672713 UTC with
reason `disabled`: **8.203 seconds**, lock count 0, raw receipt retained and
B1 attempts 0. All-role configuration convergence was verified before reenable
at 01:21:33.974 UTC.

Current connection `8d3adf6d-ab3e-485f-8893-dd7a4a846499` started 01:21:43.745 UTC
and verified 01:21:48.755 UTC. Last read **01:44:43 UTC**: one owner, healthy
guard, same generation, no timeout or capture/decode failure. Six receipts
retained and decoded; no durable `message_created` yet. B1 remains false with
empty page/type allowlists and empty policies; zero B1 attempts.
All six receipts have reached the projector and are explicitly `unrouted`;
none contains the required message-created type. The receiver remains active
in the regular production worker. No additional background monitor was created.

Private probe and subsequent bounded SQL receipts:
`/Users/dmitriy/.local/share/hub-w0-private/20260917-heartbeat-recovery/`.
Probe report SHA256:
`4de8d76a8dda4e2e2920f3426950ffd1f3f294ca9a13d4f1474a372523d3b44e`.
One read of `page_sync_states` via `read_only` was denied; no privileged
fallback was used. The authenticated owner sync UI confirmed ordinary live
messages up to date and successful HTTP progress. History already showed
Delayed/catching-up, 3465/3465 ready and 1949/1949 HTTP successes in 24 hours.
Preserve that baseline; do not claim whole-history freshness. Production roles
were healthy with zero restarts.
The final owner-console refresh confirmed B0 on for Lilly-1 only and B1 off.
Ordinary Messages Live completed another scheduled run during observation:
up to date, 3550 conversations, 1695/1695 HTTP attempts successful in the rolling
24-hour window. History remains at its pre-existing Delayed state with all
3465/3465 conversations ready, zero left and 1948/1948 successful attempts.

### Code and CI complete

Added concrete missing-pong recovery regressions in isolated worktree
`/Users/dmitriy/.codex/worktrees/hub-fansly-b0-heartbeat-recovery`, branch
`codex/fansly-b0-heartbeat-recovery`, base `91ecd2c0`. Runtime code is unchanged.
Unit suite: 15 passed. Actual-worker PostgreSQL suite: 13 passed in 51.71 seconds,
including missing-pong reconnect, exclusive ownership and retained gap/capture
receipts. Independent reviewer approved both changed test files.
Full `pnpm check`: 4,186 passed, 9 existing skips; ratchet 1893/120, lint and build
passed. All required CI checks passed on head
`fc6b15c79791206e2ea70bfc0f2a7f21d41e19fa`; image publication was skipped.
[PR #228](https://github.com/goslingmanagment/core/pull/228) merged at
**01:41:05 UTC** as `25cca331d56ee7cb89a576b3cc7443b43e89f05f`.
Only two test files changed; no production deployment is required.

### Exact next action

Await a durable natural `message_created` under the current accepted generation.
Retain its decode and disabled hint receipt, then configure the previously
approved bounded B1 trial: Lilly-1 / `message_created`, 60 minutes, at most
10 additional attempts against the retained 5018-attempt daily baseline.
Set page, type and real activation/expiry policy separately with B1 off,
verify each, then enable last. Kill-switch evidence above is already complete.
After expiry, check attempts/debt/ordinary progress and the selected hot/Agent
Read Plane message, then disable B1. Do not reroute historical receipts.
No additional test message, automation, six-hour rerun or feature expansion.
Quiet traffic is an external observation dependency, not a failed connection.

### C2 scheduled follow-up complete

Read-only report at 01:30:53.701586 UTC confirms the September 16 ordinary daily
spender sweep completed at 10:52:54.861 UTC. Both lifetime/monthly planes:
99 tracked, 99 checked within 24 hours, 596 visits/receipts/valid checks, zero
pending/retry/expired/missing/inflight/unknown-attribution, all outcomes observed.
No extra C2c attempt was admitted in the preceding 24 hours. Original report:
`20260917-heartbeat-recovery/c2-followup.jsonl` under the private evidence root.
This closes the pending scheduled-sweep read. Quiet-correction detection,
whole-scope coverage (`tracked_scope_complete=false`) and savings remain
unproven. Daily rotation is unchanged; no provider work was manually requested.

## W0 terminal result: heartbeat timeout; B0/B1 remain off (2026-09-17)

Fresh production read00:54:24UTC: API/worker/scheduler all healthy, restarts0,
sourcef0fc4042c749. The bounded B1 implementation from PR227 is deployed; no
B0/B1 activation has occurred in this continuation. The W0 launcher and owned
receiver are absent. The original continuous phase stopped21:21:06.169UTC on
September16, after19,786,168ms (5h29m46s) from its session marker, with
`stopReason=pong_timeout`, exit2. The short/long-gap phases never started.
This is an incomplete six-hour experiment, not a passed continuity check.

Retained metadata:4,325 records,3,664 received/retained frames,987 pongs and659
unchanged generation checks; final generation also unchanged. Ordinals and
monotonic times validate, and the original binding receipt hash matches.
Existing phase validator correctly returns `incomplete_observation`.
Last pong21:20:26.195UTC; service frames continued through21:20:53.289UTC;
stop followed about39.979seconds after that pong. Previous inter-pong intervals
were all below30seconds (maximum20.277seconds). The immediate cause is the
missing heartbeat response; these receipts cannot distinguish a provider-side
miss from a transport issue. No credential, route, auth or DB-generation error
was recorded. Do not invent a root cause or loosen the heartbeat threshold to
make the experiment pass. Accepted Online/Away visibility and paired DM evidence
remain closed; this failure concerns connection continuity.

Original allowlisted report/execution/metadata were copied to the existing
private experiment folder:
`/Users/dmitriy/.local/share/hub-w0-private/20260916-continuity-6h/server-output/`.
Metadata SHA25688548d32c3818ede11d5a18d2fd0a5ffcc5834bf6286fd5be0ee8cfb83f7f53a
matches remote bytes (2,005,395). At00:59:35.522943UTC, verified the matching
execution's cleanupConfirmed/outputSyncConfirmed, absent launcher932056 and
absent owned container, then removed only the staged remote original
`/root/hub-w0-20260916-continuity-6h/correlation.key`. Local original and all
receipts are retained. No production settings changed, no new experiment,
message, automation or six-hour rerun was started.

Next: resolve the heartbeat/reconnection failure narrowly before B0 activation;
a short recovery connection can test present recovery but cannot retroactively
pass the six-hour run. Decision364's transport-failure refusal still applies.
Then retain B0 durable message-created and kill-switch evidence before the
already implemented60-minute/10-attempt B1 trial. A0's existing first seven-day
read remains scheduled for September17T22:58:33.610UTC, not yet reached at this
read. Older sections below retain the previous plan and deployment evidence.


## Reduced-wait B1 canary code merged and deployed, activation next (2026-09-16)

Owner asked to reduce waiting checks and approved continuing with the proposed
short B1 canary while full polling stays enabled. Implemented Decision364 in
`/Users/dmitriy/.codex/worktrees/hub-fansly-b1-bounded-canary`, branch
`codex/fansly-b1-bounded-canary`, base5383dd38. Optional policy `expiresAt` and
`attemptLimit24h` enforce a deadline and a lower cap using the existing rolling
attempt ledger. First bounded policy: Lilly-1/message_created,60 minutes,
at most10 extra attempts. No live B0/B1 setting has changed in this continuation.
[PR227](https://github.com/goslingmanagment/core/pull/227), head502165fd,
CI35136073959 passed every required check (PR image publication skipped).
PR227 merged18:55:26UTC as91ecd2c0456be5adad890b7c6c68d7a74fcbc229.
The seven-day minimum is replaced only for this bounded experiment; broader
rollout and A0/A1/polling-reduction acceptance retain their existing requirements.

One W0 read18:31:09.034UTC confirms the original receiver still running and no
terminal execution receipt. Finish that original run at its existing deadline;
do not poll unchanged progress or repeat closed presence/paired-DM checks.
Transport/auth/generation failure still refuses entry. A quiet gap stays
unknown, without blocking the additive early canary on unchanged full polling.
B0 durable current-generation message_created and a retained kill-switch check
are required before B1. No additional test message, session/proxy change or
new automation is authorized by this shorter validation path.

Retained September15 whole-UTC-day baseline is already available: Lilly-1/page4,
5,018 physical attempts, zero unknown runs and zero/null-free loss counters.
Its five-percent allowance is250; the early-canary limit10 is the effective cap.
Reference `/Users/dmitriy/.local/share/hub-w0-private/http-day-20260915/report.json`,
SHA256162148ee211be47955445d78a97e3b44710e7de899344ea3589fb68ce5a24381.
Bind generation and activation/expiry at actual activation, not from an old
timestamp or invented session. Review found an expiry/admission await race;
the fix adds post-admission/commit/telemetry checks with explicit late-refusal
telemetry and conservative committed reservations. Final PG29 passed; final
pnpm check passed (4,185 tests/9 existing skips, ratchet/lint/build green);
independent follow-up review approved. Commit502165fd is ready for CI. Original logs:
`/tmp/hub-b1-bounded-policy-test.log`, `/tmp/hub-b1-bounded-integration-final.log`,
`/tmp/hub-b1-bounded-check-final.log` (earlier logs retained separately).

Production preflight18:37/18:38UTC confirms API/worker/scheduler healthy with
zero restarts, imageb2003129c489ed09de405b64bf56cb116724de44cb6f288ebecae7c31710926a,
source **de66a76f6cbb**, which already includes deployed identity changes not
present in origin/main (PR215 remains open). Do not deploy main over that
baseline: it would remove identity/contract/migration changes. Prepared a clean
release at `/Users/dmitriy/.codex/worktrees/hub-fansly-b1-canary-release`, branch
`codex/fansly-b1-canary-release-20260916`, head **f0fc4042**: exact deployed de66a76f
plus only PR227's nine-file patch. Eight non-decision files are byte-identical
to502165fd; the production decisions history is preserved with only364 appended.
Independent composition review approved; its table-formatting nit was fixed.
Release `pnpm check`:4,148 passed/9 existing skips, ratchet/lint/build green;
release PG29 passed. Logs `/tmp/hub-b1-canary-release-check.log` and
`/tmp/hub-b1-canary-release-integration.log`. Remote branch is retained; no second
PR/CI workflow was created for identical feature bytes. Fresh pre-deploy verification after18:55UTC reconfirmed all three healthy roles
still on de66a76f/b2003129, with no intervening release. Standard dist-only
deployment of f0fc4042 is now running; dependency checksum matches the existing
clean full base (0667a9e9cd490c9c7ee729e146cfbfa2e432a5c983c3ceec9804f4d9eb24ccd4).
No GC, configuration writes or new provider experiment. Deploy log:
`/tmp/hub-b1-canary-deploy.log`.
The first upload was intentionally cancelled before candidate verification or
service recreation: only8.1MiB had arrived by19:00:02UTC after a18:56:43UTC start.
Only its verified owned SSH upload PID27135/parent26493 was stopped; the original
exit1/log is retained. The cleanup trap removed the owned remote overlay and
released the deploy lock; a fresh read confirmed de66a76f still healthy on all
three roles. Retrying the unchanged standard deploy script with process-local
SSH `-C` compression (no machine SSH/proxy/configuration edit). Retry log:
`/tmp/hub-b1-canary-deploy-compressed.log`.

**Deployment complete at19:07:45UTC (exit0).** The compressed artifact upload
completed in123seconds (19:03:07–19:05:10UTC); standard candidate/capability,
unchanged-infrastructure, migration, service/sync/dashboard and CLI checks passed.
Fresh independent19:08:28UTC inspection confirms API/worker/scheduler all healthy,
restarts0, source **f0fc4042c749**, image
**sha256:8dffc188eb92acc6e1afb600efd235540d726bcf2c3471ff7adac41bf6aa3a9d**.
The production-pinned CLI now serves f0fc4042 (contract8e9dda0b2352...); the old
installation is retained. The original W0 receiver is still running its pinned
b2003129 image from15:51:12.864UTC, restarts0; deployment did not restart it.
Read-only19:08:31UTC verification (`read_only`, transaction_read_only=on) finds
page4 B0 connections0, B1 receipts0, B1 attempts0. No B0/B1 activation occurred.
Original final receipts: `/tmp/hub-b1-canary-postdeploy.json` and
`/tmp/hub-b1-canary-readonly.json`. Release checkout and remote branch are clean.

**Next executable step:** after the original W0 run finishes around00:59:50MSK
September17, read its terminal receipts once, verify cleanup and remove only its
staged remote correlation key. Do not restart a six-hour run or reopen accepted
Away presence/paired DM. Transport/auth/generation failures must be resolved;
quiet gaps stay unknown under the Decision364 exception. Then enable B0 alone,
retain a durable current-generation `message_created` and one kill-switch receipt,
and prepare/enable the reviewed60-minute/10-attempt B1 policy with the5018 baseline.
No seven-day wait before this trial; no new message, session/proxy edit or
polling reduction. A0's existing scheduled report and broad B0 observation remain
background work. Causal savings, reader latency percentiles and full migration
acceptance are still unproven. No additional automation was created.




## Coding continuation complete: HTTP and native W0 comparison tools merged (2026-09-16)

Owner asked to continue coding while W0 runs. Implemented the next bounded T0
measurement tool in `/Users/dmitriy/.codex/worktrees/hub-fansly-migration-measurements`,
branch `codex/fansly-migration-measurements`, commit `1582f526`,
[PR #226](https://github.com/goslingmanagment/core/pull/226). Decision 362
(361 is allocated by concurrent CI PR #225). Offline command consumes existing
report/manifest pairs and an explicit page cohort; validates hashes, closed
equal whole-day windows, identities, safe totals and complete run telemetry.
All sources/states count once; retries are subsets. Missing/null loss counters
keep the percentage unavailable; causal savings and reader latency stay unverified.
No runtime/DB/flag change or deployment is needed to use this command.

Final local `pnpm check`: 4,152 passed, 9 existing skips, ratchet/lint/build pass.
PG16 measurement suite: 11 passed, including actual SQL exports through the
comparator. Independent review approved after fixing submillisecond window
truncation. Original historical reports reproduce 30,684 → 37,268 attempts;
all 7,125 baseline runs lack loss telemetry, so comparison eligibility is false.
Private result: `/Users/dmitriy/.local/share/hub-w0-private/http-comparison-20260916.json`.
CI run35127409894 passed all required checks (image publication skipped on PR).
PR226 merged17:32:04UTC as `576c3525`. The offline tool is available from main;
no runtime deployment is required. PR218 was refreshed on this main with its
old decision renumbered363; implementation/tests/runbook are unchanged.

One fresh T0 read completed17:36:53.279UTC via PostgreSQL `read_only` in an
explicit READ ONLY transaction, using the existing bounded measurement function.
Closed September15 UTC day compared with retained September12, same six page IDs:
37,268 → 32,145 recorded attempts (−5,123; **−13.7464%**). Both windows have
known zero unrecorded/unfinished attempts, zero unknown runs, and no comparison
blockers. This is a count change, not causal migration savings: Saturday versus
Tuesday workload and intervening policy/deploy changes are not controlled; no
reader latency or freshness parity is inferred. Largest observed stream deltas:
dm_messages−2,307, followers_reconcile−1,939, fan_earnings−1,598,
dm_conversations+586. All sources remain included, including400 manual attempts
in the current window. Original read receipt, report, manifest and comparison:
`/Users/dmitriy/.local/share/hub-w0-private/http-day-20260915/`.

PR218 final refresh head `a57bce91`, base `576c3525`: local `pnpm check`
4,174 passed /9 existing skips; PostgreSQL16 probe-context suite16 passed.
Independent merge-resolution review approved, original six W0 code/test/runbook
files byte-identical to740c18ed. CI run35129040177 passed every required check
(image publication skipped on PR). PR218 merged17:48:08UTC as `5383dd38`.
Both operator tools are now in main, with local/PG/independent-review/CI checks
complete. The old billing/startup refusal is historical. No runtime deployment
is required for either tool. Remaining live work: completion/cleanup of the
running W0 scenario, independent gap evidence where events exist, and the
already scheduled A0 gate read; neither merge grants B0/B1/A1 activation or
asserts causal savings/reader latency. The controlled paired DM and its exact
archive/Agent Read Plane identity match are closed below.

Latest W0 read-only progress check17:45:42.714UTC: original launcher present,
owned receiver running, continuous phase584 metadata lines, no terminal execution
receipt (previous check17:19:13.578UTC had449 lines). The original deadline and
cleanup instructions below still apply.

## Latest: one paired DM confirmed; six-hour continuity running (2026-09-16)

Owner resumed W0 and approved one two-minute Online control with mandatory
restoration to Away. After the verified result, owner explicitly accepted closure:
“Ну все закрываем вопрос все норм с онлайном значит”. Close the presence question
for the current Away configuration; do not reopen absent a changed configuration,
regression or new owner request. This does not assert neutrality with configured
Online and browser closed, or measure numeric lastSeen/decay.

### Current running experiment: six-hour continuity and bounded receiver gaps

The already authorized W0 continuity experiment is now running on Lilly-1.
Reviewed sourcec57df223 and the unchanged same-revision Python launcher/modules
were staged with verified hashes. Pinned image remains
`sha256:b2003129c489ed09de405b64bf56cb116724de44cb6f288ebecae7c31710926a`.
Launch15:51:12.535UTC; native server session marker **15:51:20.001UTC**. Fresh
binding generation matched the original accepted REST receipt, without another
account/me GET. At15:51:41.197UTC the owned receiver was running, three metadata
records retained, no terminal receipt yet. This is a start verification, not six
hours accepted.

Runner sequence: six hours from the session marker, confirmed receiver removal,
30-second gap,120-second connection, confirmed removal,240-second gap,120-second
connection. No retries after failure. Six-hour minimum ends21:51:20UTC;
nominal entire scenario ends about21:59:50UTC (**00:59:50MSK September17**), plus
connection/cleanup overhead. Host deadline22:06:12UTC. Resource limits, generation
watch, shared page admission and owned-container cleanup remain in the reviewed
launcher. The detached host process survives the local chat/SSH ending.

Private local preparation/start receipts:
`/Users/dmitriy/.local/share/hub-w0-private/20260916-continuity-6h/`.
Remote directory `/root/hub-w0-20260916-continuity-6h/`, launcher PID932056;
`launch.json`, `start-verification.json`, `launcher.log`,
`server-output/report.json`, per-phase `receipts.jsonl` and `execution.json`.
Do not copy a live output directory containing its temporary key. Retrieve
completed metadata files after owned cleanup; then remove the staged remote
original key. Verify PID identity before any explicit cancellation. The launcher
itself confirms gaps and cleanup; independent retained REST/reader evidence of
actual events in the gaps is still required for recovery acceptance. A quiet gap
is inconclusive. No additional message, new automation, flag or visibility change.

### Controlled repeat: same message ID in browser and independent receiver

Owner approved one repeat; then confirmed the Received panel was ready. Exactly
one free Ari-1/itsaribae → Lily-1/WetLillys message was sent:
“Техническая проверка Hub W0”, conversation956621723275390976. Sender account,
recipient and editor were verified. Before sending, the server's ready receipt
at15:43:00.930UTC confirmed a running container, native session marker15:42:54.868,
and the original accepted binding matched against a fresh generation read.

Browser received serviceId5/eventType1 at **15:43:19.779UTC**; independent server
received the same service/type and message.id reference at **15:43:19.837UTC**.
Both contain pseudonym
`56f9bf23ff84089bae6838cefef57b920242ad0a6338e2677a6498abdbe166b7` and the expected
conversation reference. This demonstrates this controlled DM in both selected
connections. Do not interpret the58ms timestamp difference as latency: clocks
were not aligned. Browser Raw diagnostic628bytes and server diagnostic590bytes
were retained; identical payload encoding/content is not claimed.

Native preview was clipped; original failed preview is preserved. After filtering
`Hub`, four Tabs from Filter Messages focused the row; Down opened its detail
when mouse clicks only highlighted it. Raw checkbox exposed the complete frame,
which was passed only through the shipped pure allowlist diagnostic. No raw/auth
frame, header or token was exported. The original sender receipt immediately
after click had exactSentTextVisible=false because its AX matcher missed the
message's time prefix; sender-ui-confirmed.json independently confirms the text
with an empty editor. Native Lilly recipient header and exact text were confirmed
at15:48:42.726UTC. There was one send attempt, no automatic resend or Follow.

This bounded receiver reused the reviewed120-second streaming `after_short_gap`
phase through a small private operator wrapper; **no preceding gap or six-hour
continuity was asserted for that run**. The connection completed15:44:54.871UTC,
120003.375ms after its marker; HTTP101,9/9frames, four unchanged generation checks,
exit0, host output sync and owned cleanup confirmed. The pure comparator validates
the whole phase and reports one non-ambiguous matching message reference,
zero left/right-only references. Its generic fanOut/accountBinding/completeness
fields remain unverified: external narrow witness evidence is recorded here,
not substituted into the original comparator. Full browser stream completeness,
same provider session, other event types and W0 acceptance remain unproven.

Private original receipts:
`/Users/dmitriy/.local/share/hub-w0-private/20260916-paired-message-repeat/`.
At15:48:12.287UTC the short receiver and launcher copies were absent and its
staged remote original key was removed; local key/evidence remain private.
Both owned test tabs/DevTools closed, original three Firefox tabs preserved.
The subsequent six-hour receiver above is a different experiment, not a failed
short-run cleanup. Production-pinned Hub transcript read at15:48:47UTC returned
zero items for15:42–15:48UTC with delivery_not_exhausted and no source errors;
that read did not establish reader arrival. Follow-up at17:21:40.283–17:21:41.127UTC
returned message956632825266720768, with exact HMAC match to the paired browser/
receiver reference and exact controlled text. `sourcePlane=message_archive`,
`originClass=fansly_dm_sidecar`, `contentPending=false`, materialObservedAt
16:03:54.940UTC. This proves archive/Agent Read Plane availability by read completion,
not first visibility or a latency percentile. `delivery_not_exhausted` remains;
no source errors or capture gaps in this read. Original empty read preserved;
follow-up files `hub-transcript-followup.json`, `hub-read-followup.json` and
`hub-message-followup-check.json` are in the same private directory. This exact
controlled example is closed. The earlier manual123 was also matched as below.

### Owner's manual message: native delivery confirmed; paired receiver absent

Owner manually sent `123` from Ari-1/itsaribae to Lily-1/WetLillys and asked to
check. This supersedes the pending Follow/send preparation: no agent Follow or
send was performed and no further test message is authorized by this result.
Exact native conversation: `956621723275390976`.

Lilly's native Firefox Received frame at **2026-09-16T15:10:15.930Z** proves
browser delivery: outer transport10000, serviceId5/eventType1,547bytes, matching
conversation reference. Only the shipped pure diagnostic allowlist was retained.
The message.id pseudonym is
`f18cac9b06c3515c2404efcb226147df5204183cea05c7939514aa0f0c2d2065`.
The initial511byte row preview was clipped by Firefox, not a malformed provider
frame. Selecting its timestamp cell and native Raw detail recovered the complete
547byte frame; original failed preview metadata remains preserved. This does not
prove full stream capture or clock alignment.

At15:24:00.770UTC, the native recipient conversation in the Lily-1 container
showed the Ari Bae/@itsaribae header and exact `123` message. The browser's
business event and visible received message are confirmed.

**The independent server receiver was not running when the owner sent.**
Therefore this send supplies no paired fan-out or server continuity evidence.
Do not relabel it as a successful two-connection test or start a retrospective
receiver to claim the same event. Original preparation and UI blockers remain
historical receipts; there were zero receiver launches for this experiment.

The production-pinned Agent Read Plane was checked with `hub capabilities`, then
`hub transcript --page-label lilly-1 --conversation 956621723275390976` for
15:09–15:20UTC, declaring textPlain. At15:22UTC it returned zero items, no source
errors, and blockers `delivery_not_exhausted` / `capture_floor_unknown`
(exit3 with --fail-on-partial). Thus Hub reader ingestion of this message is
**unverified**, not proof of loss or of an empty complete archive. The earlier
optional SQL read was denied page_dm_threads using read_only/READ ONLY; no grant,
privileged fallback or retry was used. The authorized read-plane operation is
preserved separately from that denial.

At15:37:36UTC the same Agent Read Plane query returned four rows. The exact
inbound `123`, nativeMessageRef956624504312844288, matches the browser message.id
HMAC above. Its occurredAt is15:10:14.000UTC and materialObservedAt15:33:24.649UTC;
sourcePlane message_archive, originClass fansly_dm_sidecar, contentPending=false.
Thus **this specific message is now confirmed in the Hub reader**. Original
empty read remains preserved. Follow-up blockers delivery_not_exhausted,
window_before_capture_floor and gaps_present still prohibit a complete-window
claim. No observationRef/known ingest path was supplied; do not infer an exact
REST call, reader-availability timestamp or whole-system p95/p99. Original output
and exact-ID comparison are hub-transcript-followup.json / hub-message-match.json
in the same private manual-message directory.

Original private preparation, browser preview/complete diagnostic, recipient UI
receipt, capabilities/transcript output and cleanup receipt:
`/Users/dmitriy/.local/share/hub-w0-private/20260916-controlled-message/`.
At15:24:30.952UTC, Docker had zero W0 receivers and no receiver-output directories;
the unused remote experiment key was removed. Local original key/evidence remain
private. Both owned test tabs and their DevTools were closed; the original three
Firefox tabs were preserved. No production setting, session or visibility change.

### Presence control and two bounded receivers

All times below UTC on September16. Ari's baseline14:26:21.867 showed
`Last seen today` / amber. Online was requested14:28:12.203; Lilly's own green
indicator was confirmed14:29:10.919 and Ari independently showed `Active Now`
with green14:29:41.059. Away was requested14:30:10.114, **117.911seconds after
Online request**, within the approved two-minute request interval. This is not
an exact provider visibility-duration measurement. Lilly's own amber indicators
were confirmed14:30:24.140. Ari's unchanged tab still showed stale `Active Now`
at14:34:29.712; after reload14:34:57.653 it showed `Last seen today` / amber.
A refreshed observer is necessary; cached profile text is not fresh presence.

The owned Lilly tab was closed14:36:15.502. A120-second socket-only receiver
observed14:36:57.071–14:38:57.073: deadline stop, type1, HTTP101, one connection,
zero REST, six retained frames (one session marker/five pongs), no transport error,
unchanged before/after generation. Refreshed Ari observations14:37:12.996 and
14:38:01.562 during the run and14:39:52.293 after cleanup all showed
`Last seen today`. This proves sampled unchanged visibility in Away only.
Other devices were not inspected; no global browser-off or exact decay claim.

A separate paired window used native Firefox Lily-1/WetLillys plus one receiver
14:43:10.045–14:45:10.060. It also completed normally: one connection, zero REST,
unchanged generation, one session marker/five pongs. Browser metadata contains
12rows, with four pongs inside the overlap and no business references. The pure
comparator reports **inconclusive**, matchingReferences0, fanOut unverified.
No test message or business event was created. Three initial AX extraction misses
were recovered by correcting the local text-prefix handling; no raw frame,
authentication or header value was exported. Full native capture and clock
alignment remain unverified; complete parse metadata is not capture completeness.

Both runs consumed the original Sep14 binding receipt (SHA256
`94fd01694c6804b0d876d04d85ed59a572486b87970c77c7efd28099d88c1354`),
matching generation `c7a7ea0c8cf2fce9c2f3e697482e8abce3ae9767869991c6a44a9dfddf7226da`.
No new account/me GET. Reviewed operator source c57df223 and same-revision launcher
modules were built/staged with verified hashes; runtime image was pinned below.
Both execution receipts confirm exit0, output sync and owned-container cleanup.
Final Docker check14:47:24.700 found zero receivers; remote experiment key and
launcher key copies are absent. Owned Lilly/Ari tabs and DevTools are closed,
original three Firefox tabs preserved. No six-hour run or production flag flip.

Original private screenshots, control timestamps, both receiver outputs,
browser metadata, comparison, binding receipt, provenance and cleanup:
`/Users/dmitriy/.local/share/hub-w0-private/20260916-afternoon-control/`.
Earlier inconclusive presence probes remain historical evidence. Successful new
connections do not establish the cause of the historical158ms transport failure.

### PR218: implementation and independent review complete; Actions billing blocked

Native continuity comparator branch `codex/fansly-w0-continuity-compare`,
code commit6eae01e8, refreshed head **740c18ed4c562c4e2eeb8a12a321db5d7f464678**,
base82333417, **Decision359**. Main's purchase-history Decision358 was preserved;
only documentation conflict required resolution. Operator code/tests/runbook are
byte-identical to reviewed93a8f277. It validates/hashes the complete native phase
and compares references only in the overlapping browser window.

Refreshed `pnpm check`:4107passed +9existing skips; strictness1893known/120debtfiles,
lint/build passed. Relevant PostgreSQL context16passed sequentially. Prior focused
57tests include native six-hour fake-time output and overlap-pressure regression.
Independent correctness/readability review and merge-resolution review approved.
[PR218](https://github.com/goslingmanagment/core/pull/218) remains open/unmerged.
Run35107771270 was refused at startup with zero jobs/check runs. Signed-in GitHub
UI confirms failed account payments or an Actions spending limit; not a YAML/test
failure. Required CI is not passed; no bypass, billing change or repeated retry.
Restore Actions availability before rerunning required checks. No runtime deploy
is needed for this operator-only PR. Durable validation/review/CI evidence:
`/Users/dmitriy/.codex/worktrees/hub-fansly-w0-continuity-compare/investigations/fansly-w0-continuity-compare-2026-09-16/`.

Production metadata14:35:20.362UTC: source
`de66a76f6cbb882b6259b534e7fe2b60c9c1a917`, image
`sha256:b2003129c489ed09de405b64bf56cb116724de44cb6f288ebecae7c31710926a`.
API/worker/scheduler healthy/running/restarts0;14Gfree/84%used. Concurrent fixes
were preserved; no rollback/deploy by this task.

### Concrete remainder

Online question is closed for current Away. One controlled DM is now witnessed in
both native browser and independent receiver with the same message ID. The
six-hour/gap experiment is running above. After its terminal receipts, validate
actual duration, all generation checks, gaps/cleanup and independently read
existing Hub/REST capture for events during the receiver gaps. Absence of such
events does not prove recovery. No additional controlled message is authorized.
B0/B1 live activation still needs accepted applicable W0/corpus evidence; default-off
code is already shipped. Calendar gates do not block independent development.

### C1 natural follow-up: broad suppression is not justified

Existing bounded timeline was read through read_only/READ ONLY at
2026-09-16T01:02:14.947132UTC, covering Sep15T12:52:04 onward:80Lora-2records,
64partial/16succeeded, zero failures. Twelve incremental decisions produced
four count-mismatch requests from clean queues and eight no-request outcomes.
All four completed as certified exact-generation membership receipts,82pages,
no snapshot restart/quality hold/gated skip:

| Request/generation | Terminal run | Outside source | Grace | Deactivated |
| --- | --- | ---: | ---: | ---: |
|1643/G1605|758397|1|0|1|
|1644/G1606|759282|1|1|0|
|1645/G1607|759546|2|1|1|
|1646/G1608|759805|1|0|1|

These include three actual stale-membership retirements and a legitimate grace
hold. Six subsequent hourly decisions19:44–00:45 required no reconciliation:
four at8143/8143, then a new legitimate follower raised both to8144. The data do
not support broader anomaly suppression. Existing narrow certified checkpoint
reuse remains Lora-2 only; presence freshness equivalence remains unaccepted.
Original query, read-only cleanup receipt and selected rows:
`investigations/fansly-c1-remainder-2026-09-16/` in this worktree.

## Previous: C2c retained-history freshness and cost measured (2026-09-16)

**Evidence step completed, no new release:** production remains merged
`c57df2238b1a8432a283b5098c6e66a8059d79f8` / image
`sha256:b63efd84096d80f7081b97716e41382ab6baef3ca3d5983eaef6aa77549952c9`.
Fresh health00:56:34.550772UTC: API/worker/scheduler healthy/running/restarts0;
14G free/83% used. The release checkout remains clean. No flag, cadence, proxy,
session or production data mutation; no new provider request or automation.

Read-only scope: Lilly-1, retained observations from2026-09-13T00:00:00UTC
through2026-09-16T00:53:23.089077UTC. Existing bounded exporter retained994 valid
responses; shipped parser/receipt code reproduced497 snapshots per endpoint,
99fans, zero fingerprint changes. These are observations of unchanged content,
**not accepted quiet-correction detection**. No fabricated provider correction.

All198 current per-fan/endpoint states were read through the existing restricted
status function at00:56:34.100501UTC. Latest checked observation IDs and content
fingerprints match the retained histories exactly; pending revisions, active
claims and retries are zero. Actual current last-checked ages range
25221.934501–25758.296501seconds (about7h00m–7h09m). This proves the currently
tracked scope only; zero/negative/unseen references remain outside acceptance.

Historical consecutive valid captured-response intervals:398 per endpoint;
124 lifetime and123 monthly intervals exceed24h. Maximums are86453.444seconds
and86453.412seconds, respectively. The largest intervals are Sep13→Sep14,
before target activation. They measure capture gaps, not historical receipt
check times, provider correction time or event-to-reader latency. The corpus
also includes two manual verification walks; do not treat all intervals as
natural daily cadence. No strict24h maximum-age acceptance follows.

| Lilly-1 earnings cohort | Physical HTTP attempts | Result |
| --- | ---: | --- |
| Sep13 scheduled | 198 | 198HTTP200 |
| Sep14 scheduled | 199 | 198HTTP200 plus one timeout; one retry attempt |
| Sep15 scheduled | 198 | 198HTTP200 |
| Sep15 two manual verification walks | 400 | 400HTTP200;396ordinary plus4addressed |

Total995physical attempts reconcile to994captured successful responses and
one timeout.250chunks have zero unknown/boundary runs, unrecorded or unfinished
attempts. The timeout is preserved, not omitted. All three scheduled cohorts
precede C2c activation; they establish the daily baseline, not a post-activation
savings experiment. The400manual requests are verification cost, not daily
steady-state load. The4additional requests succeeded under the10/24h cap;
no live cap-exhaustion/rejection/age-only example was established. No >=50%
reduction or causal cost improvement is claimed.

Raw→reader comparison:225/225rows match, parser7, parseDebt0, legacySources0.
The first repeatable-read snapshot honestly returned verified=false because
projectionHighSeq363584 lagged eventHighSeq363638. A later bounded metadata
read showed catch-up. One repeat of the same closed cohort returned
**verified=true**, with identical994observation rows and225projection rows;
both originals are retained. No runtime defect or repair was inferred.

Original SQL, two exporter snapshots, reproduction script and verification:
`/Users/dmitriy/.codex/worktrees/hub-fansly-b0-capture/investigations/fansly-c2c-evidence-2026-09-16/`.
`verification.json` records current status/health, complete physical accounting,
the initial incomplete reader check and the successful follow-up. All database
reads used read_only in READ ONLY; history analysis was local.

### Exact continuation boundary

The agreed B0/B1/A1 default-off code, narrow C1 certified-checkpoint reuse and
C2c target/recovery implementations are shipped. Broader C1 anomaly suppression
and its freshness equivalence remain unaccepted; this is not whole-C1 closure.
This bounded evidence pass found no additional implementation defect to fix.
Do not manufacture more manual earnings walks to obtain quiet corrections,
rejection or cap exhaustion; the next C2c evidence must come from a relevant
natural generation/event, retaining daily rotation. Full quiet-correction,
unseen/zero/negative coverage, strict max-age, live recovery scenarios and
comparable post-activation cost remain unaccepted.

A0 retains the exact new Lilly-2 witness explained below and the historical
unknowns. Its existing monitor can read the seven-day report no earlier than
2026-09-17T22:58:33.610UTC; elapsed time does not imply GO. A1 remains off.
W0 is explicitly owner-deferred, so B0 live capture and B1 activation remain
off. No active calendar wait, new monitor or unapproved freshness relaxation.
Whole-migration acceptance and event-to-reader p95/p99 remain open.

## Previous: A0 reader witnesses deployed and verified through a full natural sweep

**Closed:** [PR217](https://github.com/goslingmanagment/core/pull/217), Decision354,
merge `c57df2238b1a8432a283b5098c6e66a8059d79f8` (19:28:50UTC). Reviewed/tested
head `2be104b67cbcc9f3752e7f29805edec055dd0c1b` has the identical tree. Standard
clean-main dist-only deploy completed19:40:35UTC, exit0, CLI rebuilt. Final
health 2026-09-15T19:59:19.913902+00:00: API/worker/scheduler healthy/running/restarts0,
same revision and image `sha256:b63efd84096d80f7081b97716e41382ab6baef3ca3d5983eaef6aa77549952c9`;
14G free/83% used. No rollback, migration, flag, cadence, proxy or session change.

### What changed and what production proved

A0 now retains the first20 discrepancy witnesses per fully instrumented sweep:
observation pointer, canonical current-body digest, exact trimmed-data index,
page number and pre-apply reader state/time bounds. Counts continue after the
cap, omitted witnesses are explicit, legacy/mid-sweep scope stays null. No fan
IDs/text are copied into diagnostics; shared capture can remain resolvable
under existing erasure residual law. No additional runtime SQL/provider calls.

**Lilly-2 G6978 completed all142pages at19:58:14.985694UTC**, stop10. Final
read19:58:35.994145UTC: reader_missing1, witness1, unknown0, omitted0. The witness
survived continuation and terminal persistence byte-for-byte as JSON values.
It resolves observation2545010/page69 to conversation834268142812291072 /
message949097710298869762. Current-body hash, scope and index pass the shipped
resolver. The reader was missing that exact head during the worker-clock read
bracket19:52:09.636–19:52:09.670UTC; one matching aggregation group retains a null
embedded head. These times bracket a read, not an event-to-reader latency sample.

The exact current debt read19:53:57.652609UTC found pending/captured_at null,
attempts0, visible/resolved identity, recorded complete history and exclusion
`partner_unresolvable_from_account_lookup`. Current ordinary-selection predicates
in page-dm.ts:83/1162/1276 and the head-retry predicate in
fansly-dm-head-debt.ts:70 exclude this state. This establishes why Hub does not
schedule its material debt; it does not establish whether bypassing the exclusion
would retrieve material. The list handler can clear it after successful account
resolution. No exclusion or head repair was performed.

This is the same candidate found by the previous targeted investigation under
root `investigations/fansly-a0-reader-missing-2026-09-14/`. It is now an exact
**new** pre-apply observation. Historical G6917/G6918 retained only counters,
so their exact IDs still cannot be reconstructed. No provider deletion, permanent
account loss or retroactive attribution is claimed; no repeat historical audit.

Other completed new sweeps: Lora-1 G4985,78pages,stop9; Lora-3 G7787,33pages,stop10.
Both have missing0/unknown0/omitted0. Lora-3's prior stop was3, so its changed
comparison scope cannot be called a repaired historical miss. Older reports
retain null witness scope. All production SQL used read_only in READ ONLY;
only normal polling produced the new data. No manual provider walk was started.

### Validation and continuation

pnpm check:4078passed+9existing skips;1893known type errors/120debt files,
lint/build pass. PostgreSQL shadow/reader33 and bounded/page-erasure9 passed.
Three regressions fail on the old reducer. Independent correctness/readability
review approved code and the explicitly justified platform-guard budget delta.
CI35012504744 passed all five mandatory checks; image publication skipped onPR.
Original scalar-assertion, fixture-typing and platform-budget failures are retained.

Original checks, SQL/read receipts, raw linkage and `verification.json`:
`/Users/dmitriy/.codex/worktrees/hub-fansly-b0-capture/investigations/fansly-a0-reader-witness-2026-09-15/`.
Release checkout `/Users/dmitriy/.codex/worktrees/hub-fansly-a0-reader-witness`
is clean, detached at mergedc57df223; feature branch retained. Original deploy
log also remains `/tmp/hub-a0-witness-deploy.log` (upload took8m23s).

A0 continues full polling and the existing monitor. Use the witnesses for future
per-ID attribution; keep historical unknowns and the original Sept10 22:58:33.610UTC
clock. Earliest seven-day read remains Sept17 at that time, not automatic GO.
A1 stays off. W0 is explicitly deferred; B0/B1 remain shipped/off. C1 Lora-2 and
C2c Lilly-1 scopes remain unchanged; C2c quiet corrections/rejection/cap/savings
acceptance remains outstanding. No new automation. Comparable HTTP savings>=50%
and event-to-reader p95/p99 remain unmeasured. Next is existing-scope evidence
review with the now-working witness field, not another blind poll or a general audit.

## Previous: status-only earnings debt fixed and verified on production

**Closed:** [PR216](https://github.com/goslingmanagment/core/pull/216), Decision353,
migration0201, merge `9d40bec6ef4383e4593da62496e916c577882615`. Standard dist-only
deploy completed2026-09-15 17:44:15UTC from clean merged main, CLI rebuilt. Final
17:56:59UTC health: API/worker/scheduler healthy/running/restarts0 on the same
revision and image `sha256:c3f35eddbadb20128a07fdab5a4ac20055f247e6966e6c9947b77ddcb90894a1`;
14G free/83% used. No rollback, flag, cadence, proxy or session change.

Root cause is proved by retained read_only observations: transaction953695226747179008
changes only status1/pending→2/posted between2534859/2536721; its wallet balance
also changes but was already excluded from semantic comparison. Both endpoints
already included4800net/6000gross in2533005/2533006 and remained identical in
2540252/2540262. Blanket changed-fingerprint acknowledgement caused a permanent
false hold. Exact status-only signals still request both endpoints; the durable
content revision preserves strict money/type/binding debt and R+1. Valid unchanged
rechecks acknowledge status without inventing content changes. Preexisting debt
and overlapping old writers remain conservative.

The independently reviewed one-time repair matched current transaction semantics
to retained after-response, six evidence IDs, both original1/0 revisions, exact
receipt fingerprints and no claims. It committed17:45:31.485UTC, audit380, changing
only classification/content revision/due. Independent post-read proved applied,
checks, changes, provenance, retry times and prior full completion unchanged.
Then one normal manual request78 committed17:46:14.908UTC (prior77/77), audit381.
Both addressed HTTP200 receipts closed revisions1/1 at17:47:13.491/17:47:26.199UTC;
later ordinary rotation rechecks stayed clean.

**Full verification walk passed:** terminal run759590 `success` at17:56:12.191UTC;
certified full completion17:56:12.180UTC.200 physical requests,198 ordinary+2additional,
allHTTP200, zero retries,50closed chunks, no unknown/boundary runs or unrecorded/
unfinished attempts. Additional rolling24h usage4/10.99tracked fans per endpoint
are checked within24h;497visits/receipts/validchecks each, zero pending/retry/missing/
expired/active claims and unknown attribution. Target fingerprints remain identical,
changes0. This resolves the prior manual walk's `fan_earnings_unconfirmed_coverage`.

Raw→reader audit of the same17:46:14.908–17:56:26.858UTC window ultimately passes:
200observations,225projection rows all matched, parser7, parseDebt0, no legacy
sources, projector caught up, verified=true. Initial immediately-after-terminal
snapshot was honestly unverified (parseDebt2,200matched/23outside_cohort/2pending);
a later identical-scope read after normal processing passed. Both originals remain.
No replay, forced projection repair or extra provider requests were used for parity.

Validation: final pnpmcheck4071passed+9existing skips,1893known type errors/120debt
files, lint/build pass;40deploy tests;30status/dirty/receipt PG;37recovery/target/
erasure/expiry PG;final13status/migration PG. Four new regressions fail on old code.
The actual private repair bundle passes7PG tests including later-money/later-revision
rejection, atomic audit, receipt preservation and repeat rejection. Independent
review approved code, migration, docs, rollback allowlist and concrete repair.
Both CI runs34998843182 and35000282460 passed all five mandatory checks; image
publish skipped onPR as expected. Initial diagnostic fixture role failure and
generated private bundle lint failure were corrected without hiding original logs.

Original source/proof/operations/read receipts and `verification-summary.json`:
`/Users/dmitriy/.codex/worktrees/hub-fansly-c2c-isolation/investigations/fansly-earnings-status-recheck-2026-09-15/`.
Root-cause source reads remain alongside under `fansly-c2c-isolation-2026-09-15/debt-*`.
Release checkout `/Users/dmitriy/.codex/worktrees/hub-fansly-earnings-status-recheck`
is clean, detached at merged9d40bec6; feature branch retained. Main/production
include the parallel unified-account release052d6ca9; nothing was overwritten.
Logs `/tmp/hub-earnings-status-*` retain deploy, all checks and early failures.

### Remaining migration scope

- C2c's concrete status-only false hold is closed. Single-page canary config remains
  Lilly-1,10extra physical attempts/rolling24h, daily roster unchanged. Quiet
  corrections, live age-only/rejection/cap-exhaustion evidence and savings remain
  unaccepted; no whole-scope or weekly-freshness claim.
- C1 remains Lora-2 only with previously verified natural reconciles; no broad
  suppression or savings claim.
- A0 retains full polling and the existing monitor. Earliest seven-day report is
  Sept17 22:58:33.610UTC; the two historical Lilly-2 reader_missing remain unexplained.
  A1 code is shipped default-off; activation stays gated.
- W0/online remains explicitly deferred by the owner. B0/B1 code is shipped and
  off; their live activation gates remain. B2 is outside scope.
- Comparable HTTP savings≥50% and event→reader p95/p99 are not measured. Current
  work is complete; remaining acceptance requires the named evidence, not another
  blind earnings rerun or a general re-audit. No new automation was created.

## Previous: immediate C2c walk completed; reader parity verified; unconfirmed debt retained

2026-09-15 16:26:07.889 UTC: owner explicitly requested «Ну давай, сделаем сейчас.» after the distinction between an immediate manual check and the natural daily slot. This supersedes natural-only dispatch for **one** `lilly-1` / `fan_earnings` request. No cadence/flag change, direct provider invocation, deployment or repeated dispatch.

The pinned production runtime's existing `requestPageSync` repository operation committed request77 from requested76/applied76, together with audit event362 (`source=operator`, owner-authorization text retained; no fabricated API user). The enclosing transaction would roll back if prior earnings work was pending. Page identity and the five approved C2c override values were checked as mutation preconditions; no app-user diagnostic read was performed. The operation only enqueued existing worker work; leases, proxy resolver, provider cooldown, chunk budgets and 10-extra-attempt rolling24h limit remain authoritative. Source/image guard matched `d24ec00b7862` / `sha256:ec12faa6345ac4b96a72a83a3ea6570d2f22cf86f0698502b7d2e44ee04501f7`. Local script syntax check passed; one invocation, exit0. No retry.

Pre-read at16:25:20.729 UTC as `read_only` in REPEATABLE READ READ ONLY:297 receipts/valid checks per endpoint, one pending fan per endpoint, zero extra attempts; prior certified completion10:53:09.849 UTC. The worker made two successful HTTP200 addressed attempts (runs759134/759137), then finished the ordinary roster. Final run759218 at **16:38:38.247 UTC** is `skipped` with `fan_earnings_unconfirmed_coverage`, independently verified in the owner run UI. This is the expected coverage hold: valid responses remained unchanged after pending signals. Prior certified completion10:53:09.849 UTC was preserved, with one pending/unconfirmed fan per endpoint; no full freshness or provider-recalculation acceptance is claimed.

Final READ ONLY report at16:39:49.125 UTC accounts for **200 physical attempts:198 ordinary +2 addressed**, all HTTP200, no retries, unknown bytes, boundary/unknown runs, unrecorded or unfinished attempts.50 finished chunks. Both endpoints now have397 visits/receipts/valid checks (+100 each), zero missing/inflight/expired/active claims and zero unknown attribution.99 tracked fans per endpoint remain checked within24h; changes/unsignaled changes remain0. The additional rolling24h cap used **2/10**. The current scope does not prove cap exhaustion, isolated rejection, age-only recovery, quiet changes or savings.

Bounded raw-to-reader verification for the manual window16:26:04–16:39:49.125 UTC completed successfully:200 valid observations,225 projection rows matched exactly, parser v7, no parse debt or legacy sources, projector caught up, `verified=true`. Export used the existing short `read_only` repeatable-read workflow. Its deprecation warning is retained; no export failure or broader historical audit. This proves the captured responses reached the reader correctly, separately from the unconfirmed provider recalculation above.

A parallel deployment replaced the worker at16:36:36.551 UTC and changed all roles from `d24ec00b7862` to **`052d6ca9375a3f3b3ddbe52e1283be23385bddcc`**, image `sha256:33ed42c3b0eb2eb45eaa6d8298ceb7fa7177f84920dc1275fb4bf1102c77165c`. The old revision is an ancestor; targeted comparison confirms identical sync/earnings/receipt/queue/canonicalizer/projection source. Shared config changes add only the unrelated account-link switch, and the money change adds an AI display helper. No C2c behavior change was found. Health at16:39:49.565 UTC: all three roles healthy/running/restarts0,14G free /83% used. Earlier commentary attributing the shorter Docker log to rotation was corrected: the observed worker replacement explains the lost old-container log view. Original successive logs are retained; the complete attempt total is independently verified from database telemetry.

Original operation and successive read-only receipts are in `/Users/dmitriy/.codex/worktrees/hub-fansly-c2c-isolation/investigations/fansly-c2c-isolation-2026-09-15/`: `manual-earnings-request.mjs`, `manual-request-invocation.json`, `manual-before-20260915T162518Z.*`, `manual-progress-*`, `manual-final-20260915T163946Z.*`, `manual-reader-verification/`, `manual-worker-final.json`, `manual-after-health.json` and `manual-production-source-continuity.json`. Checked result: `manual-verification-summary.json`; assertions verify one request,50 closed chunks,200 HTTP200,198+2 attempt split,225 reader matches, retained original certified time and source continuity. The single-launch exception/result is recorded in the existing `canary-policy.json`. Owner result tab: `https://gosling-agency.ru/dev/sync-status?runId=759218`. No second manual launch is scheduled or authorized by this receipt. Next ordinary work can recheck remaining debt; do not manufacture a changed response or weaken the hold. W0 remains deferred; no new automation.

## Latest: C2c first follow-up; next regular slot identified

2026-09-15 13:18:22.472 UTC, permitted `read_only` inside REPEATABLE READ READ ONLY: no new earnings work since activation. Both endpoints still have297 visits/receipts/valid checks for99 fans; zero pending/retry/expired/missing/older-than24h and zero unknown attribution. Additional physical attempts remain **0/10**; last certified daily completion remains September15 10:53:09.849 UTC, before activation. The first post-activation natural walk and live recovery/reader acceptance remain unobserved.

Independent health at13:18:46.167 UTC: all three roles healthy/running/restarts0 on reviewed source `d24ec00b7862`, same immutable image; 15G free /82% used. No configuration change or forced provider work.

Next regular slot calculated from the deployed code is **2026-09-16 10:43:54 UTC /13:43:54 Moscow**. `SYNC_STREAM_POLICY.fan_earnings` uses86400 seconds and streamIndex10; `computePageSyncSlotOffsetSeconds(4, "fan_earnings")` gives38634 seconds. The scheduler advances the request when the next slot arrives. This is a code-derived schedule, not a live queue-state read or a guaranteed start: leases, retries, dependency state and queue load can delay dispatch. The permitted role cannot read the underlying page state; no privileged fallback was used. A bounded report after that natural walk is the next verification, with the existing endpoint/attempt/reader checks. No active overnight wait, new monitor, broader audit or W0 work.

Original report: `/Users/dmitriy/.codex/worktrees/hub-fansly-c2c-isolation/investigations/fansly-c2c-isolation-2026-09-15/canary-check-20260915T131820Z.sql`, `.raw.json`, `.stderr`. Schedule source: `packages/db/src/repositories/page-sync.ts` in the deployed C2c worktree (policy, slot-offset calculation and scheduled request advancement). The approved scope and rollback remain in the unchanged canary policy/activation receipt below.

## Latest: C2c bounded Lilly-1 probe enabled and verified

2026-09-15 13:10:43 UTC. The owner explicitly answered «да» to the prepared probe before quiet-correction acceptance. Five audited owner-UI writes were applied **separately**, with running-state convergence across API/scheduler/worker and zero configuration attention/drift verified after each:

1. `fanslyFanEarningsTargetsPageAllowlist="lilly-1"`.
2. `fanslyFanEarningsTargetsDailyAttemptLimit=10` (extra physical attempts per rolling24h).
3. `fanslyFanEarningsTargetsEnabled=true`.
4. `fanslyFanEarningsRecoveryPageAllowlist="lilly-1"`.
5. `fanslyFanEarningsRecoveryEnabled=true`.

Final read-back confirms all five stored and effective values; all three roles active. Independent 13:10:43.871 UTC Docker inspection: same reviewed source `d24ec00b7862`, image `sha256:ec12faa6345ac4b96a72a83a3ea6570d2f22cf86f0698502b7d2e44ee04501f7`, all roles healthy/running/restarts0; 15G free /82% used. No deploy. Base earnings stream and Lilly-1 shadow remain enabled; daily rotation is unchanged. Other pages retain legacy earnings behavior. C1 remains scoped to Lora-2; A1/B0/B1 and W0 unchanged.

Intermediate target-only read at13:05:48 and final read at13:10:43.423 UTC both used the permitted read_only role inside REPEATABLE READ READ ONLY. **Extra attempts:0/10.** Each endpoint retains297 visits/receipts/valid checks for99 fans, zero pending/expired/missing/older-than24h and zero unknown attribution. Last certified daily completion stays10:53:09.849 UTC. No new earnings walk/response occurred during activation, so there is no claimed live recovery, reader-convergence or quiet-change proof yet. Zero extra requests is an idle observation, not a demonstrated cap-exhaustion test or savings result.

Next bounded verification: after natural `fan_earnings` work, retain strict endpoint receipts, additional-attempt reservation/outcomes, original success time versus quality hold, per-endpoint age and reader convergence. Do not force a run or wait for a manufactured rejection. The owner exception permits only this bounded probe before the quiet-correction criterion; it does not accept that criterion, change maximum-age expectations, relax daily rotation or permit wider rollout.

One policy/receipt set: `/Users/dmitriy/.codex/worktrees/hub-fansly-c2c-isolation/investigations/fansly-c2c-isolation-2026-09-15/canary-policy.json` and `canary-activation-receipt.json`; initial/final health, intermediate/final original SQL/JSON and stderr files are retained alongside them. Assertions checked the five ordered values, unchanged completion/receipts, zero attempts and source/health/restarts. Rollback: disable recovery and verify, then disable addressed targets and verify; retain captured facts, debt and budget reservations. No forced work, new monitor/automation, credential/proxy change, or online probe.

## Latest: C1 natural canary verified; C2c bounded probe prepared

2026-09-15 12:57 UTC. C1 remains enabled only for `lora-2`; owner dashboard freshly reloaded, running values true / `lora-2`, no config attention. Independent 12:52:53 UTC source/image/health read confirms the same `d24ec00b7862` image, all three roles healthy/running/restarts0 and 15G free /82% used.

The permitted `read_only` / REPEATABLE READ / READ ONLY timeline covering 11:25:55–12:52:04 UTC is exhausted. Lora-2 has 36 rows: 32 partial chunks and four successful terminals (two incremental, two full reconcile), no failed run or quality hold. Certified full runs:

- `757809`, scheduled revision1641 / generation1603, finished12:13:14.165 UTC, valid membership receipt5995460 at12:13:14.144; 8144 observed /8144 source.
- `757962`, anomaly revision1642 / generation1604, finished12:51:22.588 UTC, valid membership receipt5997324 at12:51:22.569; 8144 observed /8144 source.

Both use `exact_generation`, no snapshot restart or deactivation, one grace-only member preserved. Scheduled incremental757908 observed active8145/source8144 and correctly requested1642 from previous requested1641/applied1641; that successor completed. This proves ordinary settlement/continued repair, not the production crash-reuse path or general anomaly suppression. Exact completion-proof/checkpoint-last-success fields are not exported by the permitted timeline. The crash/original-time case remains covered by the already-passed PostgreSQL fault tests, not claimed as live-observed. Fresh page UI shows Audience, followers and reconcile Up to date; 612/612 audience attempts, 8,144 headline followers. Existing Messages History delay is unchanged.

C1 original SQL/JSON: `.../hub-fansly-c1-reconcile/investigations/fansly-c1-reconcile-2026-09-15/canary-followup-20260915T125159Z.*`; bounded verified summary `canary-followup-summary.json`. No new prod write in this follow-up.

C2c preflight for `lilly-1`: second eligible full daily completion is now present at10:53:09.849 UTC (Sept13 transition remains excluded). Cumulative shadow: 99 fans on each endpoint, 297 visits/receipts/valid checks each, zero missing/inflight/expired/pending/never-checked/older-than24h and zero unknown attribution. All latest outcomes observed. Both changes and unsignaled changes are zero; quiet-correction detection and outside-roster freshness are therefore still unaccepted, not a positive corpus or whole-scope pass. `tracked_scope_complete=false` remains explicit.

Comparable 24h baseline 2026-09-14 12:53:45.752594–2026-09-15 12:53:45.752594 UTC: 6,446 recorded Hub Fansly sync HTTP attempts on Lilly-1 (198 earnings;197 retries across streams). 1,427 overlapping runs, zero unknown/boundary/unrecorded/unfinished counts. Browser traffic is outside that denominator; no savings claimed. Addressed attempt view at12:57:35 UTC is empty.

Prepared named policy: Lilly-1 only, 10 extra physical attempts per rolling24h (0.1551% of the measured page baseline), unchanged daily rotation, natural dispatch, sequential independently verified allowlist/budget/target/recovery settings and boolean rollback. File: `/Users/dmitriy/.codex/worktrees/hub-fansly-c2c-isolation/investigations/fansly-c2c-isolation-2026-09-15/canary-policy.json`; original preflight SQL/JSON `canary-preflight-20260915T125341Z.*` and attempt snapshot alongside. All C2c settings still off/empty/zero. Asked the owner specifically whether this bounded additive probe may precede the unfulfilled quiet-correction gate; this is not a repeated request for already-authorized coding/deploy permission. Await that choice before dependent C2c activation. A1/B0/B1 unchanged; W0 deferred; no new monitor or automation.


## Latest: C1 canary enabled for lora-2; natural terminal acceptance remains open

2026-09-15 11:27 UTC: after the owner's explicit «давай» on the concrete C1 canary plan, set `fanslyFollowersSettlementReusePageAllowlist="lora-2"` through the signed-in owner settings UI, verified propagation while the boolean stayed false, then separately set `fanslyFollowersSettlementReuseEnabled=true`. Final UI read shows both saved and effective values, zero configuration attention/drift, and all three active roles (API, scheduler, worker). These are running-state observations, not an inference from missing environment overrides.

Independent 11:26:44.841 UTC Docker read: same reviewed source `d24ec00b7862`, all three roles healthy/running, restarts0; 15G free /82% used. No redeploy. Lora-2 Audience remains Up to date, 8,145 followers, 440/440 successful audience HTTP attempts over the displayed trailing day; followers and reconcile both Up to date. Existing unrelated Messages History delay remains as before.

**Activation is verified; post-activation reconcile acceptance is not yet complete.** No new natural reconcile has finished in this observation. UI estimated the next followers run around 11:44 UTC and full reconcile around 12:05 UTC (15:05 Moscow), not a delivery guarantee. The next bounded read should retain its certified terminal, original success timestamp and successor queue state. Live crash/reuse remains unobserved and must not be manufactured or awaited as a prerequisite; the injected-failure PostgreSQL tests remain the evidence for that path. No provider work was forced. Do not infer savings or whole-C1 acceptance from flag convergence.

Read-only SQL access to `page_sync_states` was denied; no privileged fallback used. The permitted 30-minute diagnostic timeline at 11:24:14 UTC was exhausted with no Lora-2 rows (pre-activation). Top-level browser navigation to the config API was blocked by client; the authenticated existing settings UI supplied effective-state verification. C2c targets/recovery and A1/B0/B1 were observed off and left untouched. W0/online remains deferred. No new monitor or automation was created.

Receipt and health snapshot: `/Users/dmitriy/.codex/worktrees/hub-fansly-c1-reconcile/investigations/fansly-c1-reconcile-2026-09-15/canary-activation-receipt.json` and `canary-after-production-health.json`. The pre-activation SQL and original diagnostic JSON are retained alongside them. Rollback is the single live boolean `fanslyFollowersSettlementReuseEnabled=false`; no deploy is required.


## Latest: C1 + C2c code delivered in one default-off deployment

2026-09-15 10:33:43 UTC verified. **C1 #209 and the C2c recovery remainder #210 are merged and deployed together.** Production source `d24ec00b7862c312a416b6e4d42de181980e6dc2`, image `sha256:ec12faa6345ac4b96a72a83a3ea6570d2f22cf86f0698502b7d2e44ee04501f7`. API, worker and scheduler all running/healthy, restarts0; 15G free /82% used. New feature environment overrides absent. No flags changed; live DB overrides were not independently verified through the permitted read-only role.

One standard `dist-only --no-image-gc` deploy ran 10:30:46–10:33:23 UTC, exit0. Existing PostgreSQL preserved; no new migration. Service health, sync health and dashboard passed at 10:33:18; production-pinned local Hub CLI rebuilt and its capabilities verified. Independent post-deploy Docker source/image/health check passed at 10:33:43. The merged tree equals checked C2c tree `28190b60dceed3918ed729366f93653f7b2be673`; original production source was an ancestor, and no parallel main change was overwritten.

- C1 [PR #209](https://github.com/goslingmanagment/core/pull/209): checked `2e3c6bc3fc11f4b8214584b3eff183bc6d50f9e2`, merged `5e0a79d1910fd191008cbac887811ccaa49a5925`, Decision347. Certified same-request settlement reuse fixes a reproduced terminal-page replay after a checkpoint committed but queue settlement failed. Original read time, later provider incidents and R+1 are preserved. No broad anomaly suppression or normal cadence/grace/presence change.
- C2c [PR #210](https://github.com/goslingmanagment/core/pull/210): checked `5ca3560b8dec59b09ca377599ff6247166e41129`, merged production revision above, Decision348. Durable independent endpoint receipts allow other fans to proceed past isolated 400/404/410; unconfirmed coverage keeps a quality hold. Known endpoints with no new signal become eligible after 24h within the existing physical cap. Daily rotation remains unchanged; eligibility is not a guaranteed maximum latency.

Both changes independently approved. Final local pnpm check3924 PASS +9 existing skips, lint/build PASS, type debt1897/120 unchanged. C1 relevant PG53 plus final timestamp/timeline PG26; C2c PG58. All five required CI gates passed: C1 run34955291667, C2c run34957053971. C2c prior run34955934073 passed all three integrations but was cancelled for the rebase required after C1 squash-merge; its failed Quality Gate reflects cancellation. Rebase changed no file contents, and the final-head local check passed again. Publish image was skipped in PR CI, not counted as a sixth pass.

Receipts: C1 `/Users/dmitriy/.codex/worktrees/hub-fansly-c1-reconcile/investigations/fansly-c1-reconcile-2026-09-15/`; C2c plus combined deploy `/Users/dmitriy/.codex/worktrees/hub-fansly-c2c-isolation/investigations/fansly-c2c-isolation-2026-09-15/`. Original failed tests, final passes, cancellation, exact-tree rebase proof, CI and deployment results are retained. The C2c worktree is detached at the merged production revision; stage branches remain. A private stash named `C2c recovery work while adopting reviewed C1 base` is only an old backup of now-committed work and must not be reapplied.

**Remaining acceptance, not a coding wait:** W0/online remains explicitly deferred. A0 seven-day report, durable B0 corpus/live activation, B1 accepted event coverage, quiet-correction/reader convergence, actual per-fan age and physical cost evidence remain open. General C1 suppression and reduced rotation need their demonstrated preservation/owner decision; they are not inferred from these fixes. No >=50% savings or event-to-reader latency acceptance is claimed. No new monitors/probes, cadence changes or B2 work. Do not start a general audit or use calendar activation gates to block authorized default-off development.


## Latest: remaining dormant code implemented; batch CI/merge/deploy

Update 10:17 UTC: C1 #209 merged as `5e0a79d1910fd191008cbac887811ccaa49a5925`; all five CI gates passed first run `34955291667`. C2c original CI `34955934073` passed all three integrations, then was cancelled during the necessary rebase onto the squashed C1 merge (Quality Gate reflects that cancellation, not a test failure). New C2c head `5ca3560b8dec59b09ca377599ff6247166e41129`, base C1 merge; old/new tree identical `28190b60dceed3918ed729366f93653f7b2be673`, diff exit0. GitHub reports MERGEABLE. New exact-head CI and pnpm check are running; no implementation changed. Production still at A1, no interim deploy.


2026-09-15 10:04 UTC: C1 [PR #209](https://github.com/goslingmanagment/core/pull/209), head `2e3c6bc3fc11f4b8214584b3eff183bc6d50f9e2`, and C2c [PR #210](https://github.com/goslingmanagment/core/pull/210), head `6b5ed187`, are implemented and independently approved. Both remain default-off. C1 is a reproduced certified-checkpoint/failed-settlement replay fix, not broad anomaly suppression. C2c isolates daily per-fan rejection behind durable endpoint receipts, holds unconfirmed completion, and makes known overdue endpoints eligible without new signals inside the existing cap. Daily cadence remains unchanged; no unproved max-age or savings acceptance.

Final local checks: each `pnpm check` 3924 PASS +9 existing skips, lint/build PASS, type debt1897/120 unchanged. C1 PG53 plus final timestamp/timeline PG26; C2c PG58 across seven suites. Reviewer findings were fixed and regressions passed (C1 timestamp replacement; C2c cumulative debt, provider-policy preservation and aged-only admission gate). Original failed/passing local logs copied under the respective worktree's `investigations/fansly-c1-reconcile-2026-09-15/` and `investigations/fansly-c2c-isolation-2026-09-15/`.

Pending: required CI, merge #209 then #210, one standard default-off dist-only deploy from verified merged main and independent source/image/health check. Production has not changed since the A1 receipt below. W0/online remains explicitly deferred; no new live probes or monitors. Calendar gates do not block this development. A0, activation evidence, quiet-correction/reader convergence and measured >=50% physical savings remain unaccepted. B2 remains outside scope.


## Latest: A1 delivered; batch future default-off deployments

2026-09-15 09:31 UTC: **A1 default-off is complete**, [PR #208](https://github.com/goslingmanagment/core/pull/208) merged as `1403df844b3aa3779a11abf0869fb2dabd238a8d` and deployed by the standard dist-only script with image GC disabled. Checked PR head `2a85e8ca9dc21e7e30aecdae65c67a849144264c` has the same tree as the merge. All five CI gates passed on the first run (`34951199138`); Publish image was skipped. GitHub merge returned internal/empty-response errors; read-back confirmed open before a later REST retry succeeded. No gate was bypassed.

Deploy exited zero; service, sync and dashboard checks passed at 09:30:44 UTC, local production-pinned CLI rebuild completed. Independent 09:31:23 UTC Docker inspection: API/worker/scheduler source `1403df844b3a`, image `sha256:5a23f050dc0936e73525522710bf9ac4d820f1c3326e3d03db366c9a7cb12587`, healthy/restarts0. A1 environment overrides absent; DB overrides were not independently readable through the permitted role. Disk 15G free /82% used. No flag activation, cadence change, provider calls for acceptance, proxy change or new online/presence probe. A1 savings/latency and activation remain unaccepted; full30/default-off behavior is preserved by code and regressions.

**Owner steering during A1 deploy:** «а нужно ли деплоить каждую или мб допишем весь код и потом деплойнем?» Adopt batch deployment for the remaining default-off code. Keep independent stage branches/PRs and reviews, finish the remaining authorized implementation, then deploy one verified merged revision. Do not deploy after every PR. This A1 deployment had already recreated processes when the question arrived, so its health verification was completed. Feature activation stays separate and one setting at a time; do not restart online/presence work or wait on calendar gates before coding. B2 remains outside scope. No new permission is required for previously authorized work/deploys.

A1 receipts, including original failed local checks, final tests, CI and deploy: `/Users/dmitriy/.codex/worktrees/hub-fansly-a1-bounded/investigations/fansly-a1-bounded-2026-09-15/`. Implementation details and local results remain below. Remaining code/acceptance: C1 suppression is not implemented/accepted; Decision 294 records that counts alone do not establish redundant generations. C2c #207 implements additive addressed selection only; daily spender rejection behavior, quiet-correction freshness/max-age and rotation reduction remain separate uncompleted scope. A0, W0 and durable B0 gates retain their earlier status. No new general audit was started.

Latest A1 update 2026-09-15 09:12 UTC: [PR #208](https://github.com/goslingmanagment/core/pull/208), head `2a85e8ca9dc21e7e30aecdae65c67a849144264c`, is ready and running CI. A1 is default-off with an empty allowlist; full30 scheduler slots and the full-list 3600-second freshness target remain. Separate bounded cursor/proof, capped continuation, off/deadline restart at offset zero, no bounded membership stamps/finalization/full success, and independent full freshness in detailed status plus lightweight summary are implemented. Independent review APPROVE after fixing stale summary and its domain label.

Final local `pnpm check`: 3912 passed +9 existing skips, lint/build pass, type baseline 1897/120 unchanged. Sequential PG regressions: 45 passed in bounded/full/generation/shadow suites. Initial failed checks (checkpoint test-field typo and stale config key pins) are retained; final runs pass. Original A1 logs: `/Users/dmitriy/.codex/worktrees/hub-fansly-a1-bounded/investigations/fansly-a1-bounded-2026-09-15/`. Pending in this update: CI, merge, default-off deployment and source/image health receipt. No activation, savings or latency claim. W0/presence remains owner-deferred.

Latest continuation 2026-09-15 08:48 UTC: the owner explicitly deferred the online/presence check and requested the next stage. Work has moved to **A1 default-off**, worktree `/Users/dmitriy/.codex/worktrees/hub-fansly-a1-bounded`, branch `codex/fansly-a1-bounded`, base `16956194`. Presence is not a coding blocker and will not be re-probed in this continuation. No live activation is implied.

Before that correction, one paired W0 probe completed 08:38:28.184–08:40:28.205 UTC: one connection, HTTP101/type1, 8/8 retained metadata frames, original binding/generation matched, zero receiver REST requests, cleanup/output sync confirmed. The overlap has eight native browser records and eight receiver records, including two service4/type2 events per side. Neither event exposes a supported entity reference; the comparator is inconclusive (zero matching references), not a fan-out pass. Ari continued to show Last seen today with the ordinary Lilly browser open; positive control remained inconclusive. Existing source code was unchanged. Source/image and healthy/restarts0 were freshly verified; disk/attempt counts below remain the earlier snapshot.

Original private receipts: `/Users/dmitriy/.local/share/hub-w0-private/20260915-presence-pair/paired-20260915T083737Z/` (preparation, invocation, browser report/provenance, presence observations, receiver report/execution, comparison, cleanup verification). Only the existing pure diagnostic allowlist was exported; no raw AX frames/auth, clipboard auth or WS hooks. Native AX JSON prefix handling was corrected locally before export; final malformed/partial/unknown counts zero. Docker confirmed receiver absence at 08:44:20 UTC; its staged correlation-key copy was removed. Owned Lilly tab and DevTools closed; Ari remains open. No six-hour receiver or new automation is running. No flags, proxy, credential or visibility setting changed. No earlier receipt was overwritten.

Updated 2026-09-15 02:34 UTC. B0 (#205), B1 (#206), and the additive addressed-selection part of C2c (#207) are merged and deployed as default-off code. Current verified production source: `16956194d3be`. API/worker/scheduler all healthy, restarts0; approximately 16 GiB free (81% used). Both new additional-attempt ledgers contain zero rows. No feature environment overrides were present; live DB config overrides were not readable by the permitted role.

Final C2c checked head `84255aa304e835bdacf45328dc6a963eb35b8f5d`, merge `16956194d3bee896818f9ee2ae28144566dd7a9a`, image `sha256:02f68a0fe661f81d060b45f2a23595567a0b726bcb4e2ac02f492bb7bfe2b3af`. Independent review APPROVE; final pnpm check3894+9 and PG32 passed; all five CI checks passed on first run. B1 checked head4b96aafc, merge9dbe3c02, final CI passed after correcting two legacy test pins (original failed run retained).

No live flags, proxies, credentials or fan messages were changed. Full polling and daily rotation remain. The full migration is not accepted: W0 paired/positive presence/6h/gap evidence, durable B0 corpus, A0 report, safe-stop/freshness decisions and measured savings/reader latency remain. Do not block default-off coding on calendar gates, create new monitors, or restart a general audit. The historical receipts below remain unchanged unless an explicitly newer section replaces status.

## B0 implementation history

## Implementation / acceptance

- Dedicated page advisory-lock session; generation fences at open, guard and raw commit.
- Page resolver HTTP CONNECT/SOCKS5 only, independent dispatcher, bounded wire/queue,
  forced upgraded-socket teardown and live kill within 60 seconds.
- Atomic raw + pending decode receipts, UUID/ordinal dedup, offline metadata repair,
  unknown children/debt and explicit unknown gaps. No B0 business apply or hints.
- Source/contracts/SDK/registries and nested JSON erasure codec are aligned.
  Fan-scoped unknown-exclusive WS envelopes remain counted residuals; page/model
  erasure reaches raw, receipts and connection journal. See the runbook.
- Independent reviewer /root/b0_review approved final code after corrections for
  lake shared exclusion, group fences, transport assembly/upgrade-head bounds and
  isolation of startup/periodic decode replay. Reviewer did not run tests.

## Verification receipts (original attempts preserved alongside this file)

- check-3.log: pnpm check PASS, 3872 tests + 9 existing skips; lint/build pass;
  strictness ratchet unchanged at 1897 known errors / 120 debt files.
- pg-final.log: 54 PostgreSQL tests across six relevant suites PASS, including
  ownership death, generation change, raw atomicity, nested fan/group erasure,
  lake actual execution and existing erasure regressions.
- unit-final.log: 23 focused connection/transport tests PASS, including real TLS
  through both proxy transports, stalled peer close, no direct fallback,
  compression rejection, frame/fragment bounds, auth deadline and retry reset.
- pg-replay-isolation.log: 12 B0 PostgreSQL tests PASS after replay isolation; the actual worker retains
  two raw frames and pending debt through a failing receipt UPDATE, then observes live off.
- Earlier unsuccessful attempts remain in check-1.log and hub-b0-*.log: fixture
  grant assumptions, SQL array serialization, test assertions and registry/census
  omissions were corrected. They are not counted as passing checks. check-2.log
  passed before the final reviewer-requested replay-isolation correction.

## Production / live gates

Pre-deploy verified source 22a529589cf1, image
sha256:fad1c0385b36a352ceb0d4e5df9b27bc30b26b7919d3d38ccf65a345fe4d10b6.
All three roles healthy, restart count 0, 17 GiB free / 80% used. This closes the
handoff's old #202-not-deployed remainder; no rollback to the previous snapshot.

Final PR, deployment and bounded W0 receipts follow below.
W0 paired fan-out/presence and 6h/gap recovery remain unaccepted. Original binding
receipt is authoritative only for matching current generation; no invented TTL.
B1 requires seven accepted durable B0 days/event diversity after live activation.
A0 earliest seven-day read remains Sept 17 22:58:33.610 UTC. Existing monitor only.
Savings >=50% and event-to-reader p95/p99 have not been measured.


## Final stage result — 2026-09-15 00:20 UTC

**B0 default-off implementation is merged and deployed. Live activation is off.**

- PR https://github.com/goslingmanagment/core/pull/205, checked head
  `0a30cdc24a4fcc374f69c165284b82f22a56f4ec`, merge
  `ba6e2eabbdfbcfcbaa63ad249e0dbe3c28c26914`.
- CI run 34911546586: five mandatory checks passed on the first run (Static,
  Integration 1/2/3, Quality Gate). PR image publishing was skipped, not a sixth pass.
- Clean merged-main deploy via `scripts/deploy-production.sh --mode auto
  --no-image-gc root@45.8.230.111` completed successfully at 00:18:59 UTC.
  Source `ba6e2eabbdfb`; all three roles use image
  `sha256:f4dcfdf40b2477cb44c8a7f65df5d2ff24bcab19a3304328c16d367d901538f6`.
  API/worker/scheduler healthy, restart count 0; sync health 200; contract
  `52984c9dd02de37887aa6e12e613780060d541f6e79014a474ef506f85f7c654`.
  Production-pinned hub CLI was rebuilt and capabilities verified by the deploy.
- Independent final SSH snapshot: 00:19:24 UTC, about 16 GiB free / 80% used.
  READ ONLY as `read_only` confirms both B0 tables exist and contain zero rows.
  See `deploy.log`, `production-final.log`, `ci-watch.log`.
- Production Chrome UI visually verified the new feature card and both controls:
  effective enabled=false, no selected pages, unchanged Save disabled. No flag
  was flipped. Direct config_settings SELECT is forbidden to read_only; the
  supported configuration UI supplied the effective-value verification instead.
- Kill <=60s is proved by fault-injection/transport tests, not a live B0 on/off
  experiment. No live B0 connection has been claimed or approved by this result.

### Bounded W0 diagnostic follow-up

Exactly one approved 120-second receiver used the existing encrypted Lilly-1 REST
session and page resolver on the pre-B0 image/source 22a529589cf1. It consumed the
original binding receipt (SHA-256
`94fd01694c6804b0d876d04d85ed59a572486b87970c77c7efd28099d88c1354`), without a new GET.
Fresh generation matched; the receiver observed 00:05:55.621–00:07:55.624 UTC,
opened 00:05:56.002, HTTP 101, terminal reason `deadline`, session frame seen,
generation unchanged, exit 0, cleanup and host output sync confirmed.

74 received/retained metadata records: 1 type-1, 5 pong, 68 service envelopes;
0 rejected/truncated. Service/event code counts: 5/1=31, 4/2=4, 5/22=33.
These code counts do not establish business meaning or paired equality.
The earlier 158ms failure did not recur; its cause remains unproven.
No Fan messages, proxy/session changes or B0 activation occurred.

Original private receipts:
`/Users/dmitriy/.local/share/hub-w0-private/20260915T0005Z/`
(`staging.json`, `invocation.json`, `receiver-output/report.json`,
`receiver-output/execution.json`). Remote owned-container absence was independently
checked after cleanup. No provider credential was exported or printed.

W0 is still unaccepted: paired native events, Ari presence, six-hour continuity and
short/long-gap REST catch-up remain open. The browser-access question from this
00:20 UTC result was resolved by the continuation below; B0 stays default-off.

### W0 continuation — 2026-09-15 00:40 UTC

- Native Firefox access is available. Its existing containers include `Lily-1`
  (exact UI spelling) and `Ari-1`; Ari self-profile was verified as `itsaribae`.
  No proxy settings or provider credentials were inspected.
- The preliminary `WetLillys` profile showed `Last seen today` before any new
  receiver or local Lilly tab. This is not accepted presence evidence: Ari then
  navigated independently between message threads and other profiles, including
  during a requested return to the selected target. The active task
  `Ответить от Ари в чатах` also uses Firefox. Native UI work stopped to avoid
  competing with that task. The user was asked for a 5–10 minute exclusive window.
  No new receiver, Lilly tab or DevTools capture was started in this continuation;
  the Ari tab was left untouched once the conflict was identified.
- Built the reviewed short/continuity bundles and a bundle of the existing pure
  `diagnoseReceivedRecord` plus key-fingerprint helper from merged source
  `ba6e2eabbdfb`. A fresh private shared correlation key was generated locally.
  Five synthetic checks passed in the actual CUA process: nested type-1 token
  redaction, plaintext-ID redaction, type-1 classification, outbound exclusion and
  secret-bearing endpoint exclusion. This verifies the sanitizer path only;
  the native AX extraction procedure still needs validation against the actual
  Network Monitor UI before live export. No raw Received data was exported.
- Fresh SSH verified the same immutable production image on all three healthy
  roles, zero restarts, expected Docker network, and no W0 receiver container.
  B0 activation was not changed.
- Production-pinned `hub capabilities` succeeds and grants Lilly-1 access.
  A single bounded observation-envelope read for 00:30–00:35 UTC returned
  `503 agent_plane_disabled` (`agent observation reads are disabled`). It was
  not retried. A READ ONLY privilege check as `read_only` confirms no direct
  SELECT on `sync_runs`, `sync_raw_payloads`, `page_dm_threads` or
  `page_dm_messages`; SELECT on `observations` is granted. These facts do not
  establish access to the exact request-cursor/run receipts required by W0.
  Existing A0 metadata functions cover dialog heads only, not the full selected
  message recovery walk. No privilege or feature flag was changed.

Private preparation and original access/interruption receipts:
`/Users/dmitriy/.local/share/hub-w0-private/20260915-presence-pair/`
(`preparation.json`, `cua-diagnostic-fixtures.json`, `browser-interruption.json`,
`capabilities.json`, `rest-observations-access.json`). No live staging was performed.

Next executable step: obtain uncontested native-browser control, collect a fresh
Ari→WetLillys WS-off baseline, run the approved 120-second WS-only presence window,
then paired native/receiver evidence. Sustained continuity follows accepted
fan-out/presence and requires actual permitted gap/recovery receipts. Neither a
process exit nor a successful handshake substitutes for those gates.

### Other stage state / next actions

| Stage | State / exact next action |
| --- | --- |
| T0 | Accounting exists; comparable savings experiment still needed. |
| A0 | Existing shadow/full polling continues. Original seven-day gate and two previously unresolved reader_missing remain. The 00:05 UTC accumulated report attempt hit its normal 20s statement timeout; no new A0 conclusion is drawn. Keep existing monitor, read a valid report no earlier than Sept 17 22:58:33.610 UTC. |
| A1 | Off/unimplemented, pending accepted A0 and stop/freshness contract. |
| C1 | Diagnostics; suppression/freshness equivalence not accepted. |
| C2a | Accepted correctness and bounded replay parity remain. |
| C2b | Fresh 00:03:50.209 UTC cumulative report: 99 fans, 198 valid checks and receipts per endpoint, no pending/expired/missing/never-checked targets; scope_complete=false. Last daily completion still Sept 14 10:53:41.787 UTC, so only one eligible completion. Read next natural completion; no cadence change. |
| C2c | Additive addressed selection implemented default-off in #207, merged/deployed default-off; full rotation acceptance/quiet corrections/max-age/cost remain unresolved. |
| W0 | Short diagnostic passed; next paired native/presence evidence, then 6h and gaps. |
| B0 | Code/deploy complete, default-off. After accepted W0: set one allowlist, verify, then enable separately. |
| B1 | Default-off code merged/deployed in #206; activation still requires accepted W0/B0 evidence. |
| B2 | Parked; separate owner decision required. |

HTTP savings >=50% and event-to-reader p95/p99 remain unmeasured. No polling
freshness was weakened to claim success. Rollback is the existing disabled flag
or empty allowlist; retain raw/debt/gaps. Whole-envelope fan-erasure residuals and
inline-only decode repair remain documented limitations. This closes the B0
implementation/deployment stage, not the complete events-migration acceptance.

## Continuation — W0 presence and coding priority

The owner released Firefox at 00:44 UTC. One 120-second WS-only receiver completed
00:46:10.082–00:48:10.084 UTC: HTTP 101, type-1, 117/117 metadata records retained,
matching original binding/generation, exit 0, cleanup and output sync confirmed.
Ari-1 was independently verified as itsaribae and the selected target WetLillys.
Valid native snapshots at 00:45:30.375 (before), 00:46:37.455 and 00:47:42.176
(during), and 00:49:01.958 (after) all said Last seen today. No presence change
was observed; other creator clients and a positive browser-presence control remain
unverified. Original receipts: presence-output/, presence-invocation.json and
presence-observations.json in the existing private presence-pair directory.

An owned Lily-1 browser tab was subsequently opened with native Network Monitor;
no paired receiver or raw Received export was started. The panel was too short
to select its request row, and the UI preparation was taking too long. After
the owner's coding-priority correction, the owned Lily-1 tab was closed; Ari
remains open, DevTools closed, no W0 receiver remains. W0 fan-out and 6h/gap/REST
recovery are still unaccepted.

Next implementation: B1 default-off in
/Users/dmitriy/.codex/worktrees/hub-fansly-b1-hints, branch codex/fansly-b1-hints,
from current merged main ba6e2eabbdfb. Live W0 and durable B0 duration gate
activation, not this inert implementation. Do not enable routing from historical
protocol candidates alone.

## B1 coding continuation 2026-09-15 01:54 UTC

Implementation PR [#206](https://github.com/goslingmanagment/core/pull/206), current head `4b96aafc` (runtime `58937d3b`) in `/Users/dmitriy/.codex/worktrees/hub-fansly-b1-hints`, branch `codex/fansly-b1-hints`, base `ba6e2eabbdfbcfcbaa63ad249e0dbe3c28c26914`. Decision 344 / migration 0197. B1 remains default-off; no live flags or W0 sessions changed. Second CI run34919845480 passed all five mandatory checks. B1 merged as `9dbe3c028241eecdb2b6e29f5c6bcdd4e21accd3`; standard dist-only deploy completed at 02:19:38 UTC from clean merged main (`/tmp/hub-b1-deploy.log`). First CI failed two old operational-registry integration pins; both corrected without runtime changes, 20 focused PG tests passed and reviewer approved. Full original failed CI: run 34918972310.

Implemented: bounded address extraction; canonical projection-only signals; durable coalesced revisions and replay receipts; live policy with generation/type/baseline checks; one physical hint attempt per chunk; event-only idle wakeup; REST raw staging until original boundary; shared normalization/atomic hot apply; exact missing-message debt; known fan/page erasure; read-only cost and signal-to-hot views. Unknown groups remain membership debt. Event-only settlement preserves ordinary DM freshness, failures and incidents. Runbook: `docs/runbooks/fansly-ws-hints.md` in B1 worktree.

Final validation: `pnpm check` PASS, 3894 tests +9 existing skips; strictness unchanged (1897 known errors/120 debt files), lint/build passed. B1 PostgreSQL 24/24, B0/DM/erasure regressions 30/30. Logs: `/tmp/hub-b1-check-final.log`, `/tmp/hub-b1-final-pg.log`, `/tmp/hub-b1-regression-pg.log`. Independent reviewer `/root/b0_review`: APPROVE after final targeted inspection; reviewer did not rerun tests.

Earlier failures retained: initial PG missing plane constraint, array binding and timestamp CASE; unit fixture recursive encoding/OOM; first full check four registry/discovery pins. Initial review found uncharged ordinary wakeups, partial overlap hiding history after off, disabled frozen type wedge, SQL binding, poisoned targets; final review found false ordinary success. All corrected and regression-tested. Original full-check logs `/tmp/hub-b1-check.log`, `/tmp/hub-b1-check-2.log`; earlier targeted failures remain in tool transcript.

W0 fan-out/positive presence/6h continuity and calendar reports remain activation/measurement work. Next coding stages must retain full30/daily freshness by default and cannot use calendar waits as development blockers. B2 remains outside scope.


## C2c coding continuation 2026-09-15 02:06 UTC

Separate worktree `/Users/dmitriy/.codex/worktrees/hub-fansly-c2c-targets`, branch `codex/fansly-c2c-targets`, rebased onto merged B1 `9dbe3c02`; final C2c head `84255aa3`, tree unchanged from reviewed `d17d2ef4`. Committed as `d17d2ef4` (reviewed parent `4b96aafc`), Decision345/migration0198 implement additive addressed selection with default false/empty/zero policy, one endpoint per ordinary chunk, strict physical attempt ledger, existing per-window receipt/CAS and erasure. Daily rotation and its own rejection behavior remain unchanged; no interval increase or full C2c acceptance is claimed. Docs explain remaining quiet-correction/max-age/cost decisions.

Initial `pnpm check` passed 3894+9 with unchanged strictness. Initial targeted PG19 passed. After moving visit accounting from claim to actual attempt admission, expanded PG32 and final full check3894+9 passed. Logs: `/tmp/hub-c2c-pg-final.log`, `/tmp/hub-c2c-check-final.log`. Initial typecheck caught registry metadata fields and missing narrowed Fansly context; fixed without debt. Independent reviewer `/root/b0_review`: APPROVE, no material findings; reviewer did not run tests. C2c PR [#207](https://github.com/goslingmanagment/core/pull/207) passed CI run34920594829 (all five mandatory checks, first run) on head84255aa3. It merged as `16956194d3bee896818f9ee2ae28144566dd7a9a`; deploy from clean merged-main worktree completed at 02:33:33 UTC (`/tmp/hub-c2c-deploy.log`). No C2c flag flips.


### B1 production verification 02:19 UTC

All api/worker/scheduler roles healthy, restarts0, source `9dbe3c028241`, image `sha256:2354345630a8fb3077008e82e3619aa9bb8594d775493a388eb2e1a406a67ded`. Standard deploy verified API/sync/dashboard and rebuilt production-pinned CLI. Feature environment keys were all unset (compiled defaults false/empty); no configuration writes were made. `read_only` has no SELECT on config_settings, so live DB overrides were not read and no app/superuser SQL fallback was used.

`read_only` in READ ONLY confirms Lilly-1/page4 has zero B1 routing receipts, attempts and rows in both new status views. Files: `/tmp/hub-b1-production-status.log`, `/tmp/hub-b1-production-readonly.log`. These counts do not certify live WS corpus, production savings or latency.


## Final continuation state — 2026-09-15 02:34 UTC

C2c standard deploy completed successfully at 02:33:33 UTC. Independent verification confirms source/image on all three roles, health200, restart0 and unchanged contract hash `52984c9dd02de37887aa6e12e613780060d541f6e79014a474ef506f85f7c654`. Production-pinned CLI rebuilt. All selected B0/B1/C2c environment keys unset; no flags changed. Global new B1 receipt/attempt and C2c attempt counts are zero, queried as read_only inside READ ONLY. No app/superuser diagnostic SQL was used.

Final evidence: `/tmp/hub-c2c-deploy.log`, `/tmp/hub-c2c-production-status.log`, `/tmp/hub-c2c-production-readonly.log`, `/tmp/hub-c2c-production-health.log`, `/tmp/hub-c2c-ci-watch.log`. Stage code/worktrees remain intact and clean (detached at their merged revisions); original feature branches and failed test logs are retained.

| Stage | Current acceptance / next action |
| --- | --- |
| T0 | Physical-attempt accounting exists; comparable savings measurement still absent. |
| A0 | Existing shadow and full polling remain; read accepted seven-day report no earlier than 2026-09-17 22:58:33.610 UTC. The two historical reader_missing cases remain unexplained in this task; no new broad audit performed. |
| A1 | Off/unimplemented. A safe-stop/freshness contract is not accepted; full30 remains. This is separate from default-off development and not a WS dependency. |
| C1 | Diagnostics implemented; suppression requires an evidence-backed fix preserving legitimate repairs and presence freshness. |
| C2a | Previously accepted correctness and bounded replay parity unchanged. |
| C2b | Shadow remains, daily rotation preserved. Last observed report had one eligible daily completion; next natural report is the next evidence step. |
| C2c | Additive addressed selection shipped default-off in #207. Full rotation acceptance, quiet-correction coverage, per-fan/window max-age and comparable cost remain unaccepted. No interval increase or new age guarantee. |
| W0 | 120s receiver/presence receipt retained; paired native fan-out, positive presence control and 6h plus gaps/recovery remain unaccepted. No receiver left running. |
| B0 | Capture-only code shipped in #205, default-off. Durable seven-day live corpus has not begun. W0 remains activation prerequisite. Unknown-exclusive mixed raw-envelope erasure and inline-only pending-decode repair limits remain explicit. |
| B1 | Addressed REST hint code shipped in #206, default-off. Activation requires accepted W0/B0/type corpus and measured baseline policy; signal-to-hot is not end-to-reader proof. |
| B2 | Parked; separate owner decision required. |

Actual HTTP savings >=50% and event-to-reader p95/p99 remain unmeasured. Do not claim full migration completion. Polling freshness has not been weakened. Rollback for new influence is leaving/disabling flags or empty allowlists; preserve all raw facts, receipts, pending revisions and attempt custody. Calendar-dependent gates should remain ready for explicit flip/read-report work, not an active multi-day wait. Existing fansly-a0-shadow monitor only; no new automation created.
