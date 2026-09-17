# Lilly-2 known-head canary — rollback verified

The approved one-hour flag window is closed. The normal Configuration UI now
shows `fanslyDmHeadCatchupPageAllowlist=none` on API, worker and scheduler,
all active, with no drift or pending change. No recovery success is claimed:
there were zero eligible targets and zero completed recovery attempts.

## Operation and timing

- Activation pre-click dispatch: 10 September 2026, 15:28:32.701805 UTC.
- Planned rollback: 16:28:32.701805 UTC (19:28:32 Moscow).
- Rollback pre-click dispatch record: 16:28:40.436657 UTC, 7.735 seconds late;
  the save click immediately followed. Exact database commit time was not read.
- The normal UI save completed without a visible conflict/error. Scheduler
  reported none first, then worker, then API.
- All-role none verification recorded at 16:30:12.294205 UTC.
- The observations do not establish a <=60-second propagation bound. Do not
  substitute heartbeat times or the pre-click timestamp for the commit time.
- Only this flag changed. No deploy, replay, reset, manual provider request,
  other page/flag, socket or A1 action took place during this canary.

Evidence: [dispatch](evidence/rollback-dispatch.json),
[verification](evidence/rollback-verified.json), [state](STATE.json).

## Production result

| Check | Result and scope |
|---|---|
| Eligible debt | 0 throughout the observed window |
| Pending debt | 104, unchanged: 93 hidden and 11 other excluded visible targets; identity/exclusion categories overlap |
| Captured debt | 2959, unchanged; completed unconfirmed recovery attempts remain zero |
| Original eight targets | Captured by ordinary collection on 9 September before activation; never attributed to this flag |
| Material after rollback | 8/8 exact archive IDs, text, parent/root links and media/reference checks pass; one message has an attachment |
| Ordinary list progress | Full sweeps completed at 15:59:45.911 and 16:28:07.186 UTC |
| New Lilly-2 DM receipts | None in the explicitly covered canary/rollback windows |
| HTTP telemetry | 355 unique completed summaries / 1487 attempts through pre-click rollback; another 13 / 56 through verification; zero retries or terminal failures in those summaries and no retry/failure trace rows |
| Runtime | Same approved PR162 image on all roles; healthy, restarts 0/0/1 unchanged, 28GiB free |
| Existing warning | OFAPI webhook backlog alert persists; archive/canonicalization progress continues. Transaction early-stop warnings are also retained |

The HTTP totals are deduplicated by page, stream and run ID. A completed chunk
is not a completed full sweep; attempts may precede the summary's window.
These totals are not T0, recovery-only cost or measured savings.

[All HTTP windows](evidence/cumulative-http-summary.json),
[final active window](evidence/final-active-window/http-summary.json),
[post-rollback runtime](evidence/post-rollback/runtime.txt),
[post-rollback material](evidence/post-rollback-material/eight-material-check.json).

The eight Hub reads took 0.837–1.184 seconds each. That measures these reader
requests, not event-to-reader latency. Their delivery/field-state blockers
remain in the evidence; positive exact-ID comparisons do not establish whole
history completeness, an atomic census, media file delivery or later edits.

## Validation and remaining gates

[PR157](https://github.com/goslingmanagment/core/pull/157) supplied the recovery
fix: previously recorded pnpm check 3099 tests (9 existing skips), seven real
Docker-Postgres files / 66 tests / zero skips. The tests cover stale reads,
persisted continuation, caps, large bursts, exact external receipts and rollback.
[PR162](https://github.com/goslingmanagment/core/pull/162) is the deployed image,
with its own recorded 3110 unit tests and 122 Docker-Postgres tests. Both changes
received independent review before merge; these are historical test results,
not reruns performed during the canary.

The flag's enable/disable path and ordinary progress were observed, and the
selected material remained intact. Real recovery efficacy, five-attempt
exhaustion under load and recovery/event latency are still unmeasured because
no eligible work arrived. The 104 excluded debts remain explicit; no deletion
or completeness inference is made.

The owner requested the remaining development during this window. A0/T0
implementation has started in its own worktree/branch; production A0 shadow and
its >=7-day clock have not started. Freshness and >=50% savings are unproven.
B2 remains a separate decision. No owner input is needed to finish this rollback.

Detailed chronological evidence is preserved in [monitoring notes](MONITORING-NOTES.md).
