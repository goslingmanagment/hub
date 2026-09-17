# C2b observation — September 14, 11:09 UTC

**One of two subsequent independent daily sweeps observed; observation remains open.**
The first post-activation completion on September 13 at 10:53:03.993 UTC stays
excluded as transitional because its full start was not proved. The next distinct
daily completion is September 14 at 10:53:41.787 UTC.

The reviewed metadata report ran once as `read_only`, in a repeatable-read,
read-only transaction, with a 15-second statement timeout and bounded process.
It completed successfully; the report is as of 11:09:08.126752 UTC. Raw inputs,
identity and the signed comparison are retained beside this report.

| Per endpoint (lifetime and monthly separately) | Cumulative | Since prior report |
|---|---:|---:|
| Tracked fans | 99 | 0 |
| Valid checks / visits / receipts | 198 each | +99 each |
| Fans checked within 24 hours | 99 | 0 |
| Changes / changes without signal | 0 / 0 | 0 / 0 |
| Pending / retry / missing receipt | 0 / 0 / 0 | 0 / 0 / 0 |

The worker log independently contains 49 partial chunks followed by one success,
from 10:44:27.247 to 10:53:41.800 UTC. Lifetime has 99 physical attempts; monthly
has 100 including one retry, with zero terminal failures. These support the new
99 receipts per endpoint and the daily completion 13 milliseconds before the
success summary. They are not added to endpoint counts or labelled savings.

This is the first subsequent complete walk under the retained transition-exclusion
rule. Current and previous observations show unchanged runtime starts/image and
C2b `lilly-1` override version 1 with matching values on all three active roles.
No interruption is known across these observations. Logs expose no generation,
lease sequence, request source or explicit full-walk start; exact per-role applied
versions and uninterrupted instrumentation history remain unproved. This scoped
qualification does not certify those unavailable properties.

`tracked_scope_complete=false` remains explicit. Outcomes are still `observed`
for 99 fans per endpoint; no correction has been observed. Zero scoped changes,
claims, stale checks or unknown-attribution counts do not prove roster completeness,
quiet correction coverage or maximum age. Physical HTTP savings and event-to-reader
latency remain unmeasured. The original September 12, 23:38:22.888 UTC activation
clock is unchanged. No final observation report, C2c acceptance or flag change.

Next: retain one more distinct subsequent complete daily sweep with no known
instrumentation interruption; then deliver the bounded report with its coverage
limits. Until then the shared observer remains active. Independent review pending.

---

Previous retained activation and observer reports follow unchanged.

## Latest observation — September 14, 05:13 UTC

[Current observation](observation-20260914T051301Z/REPORT.md): endpoint values
remain unchanged, with 0 of 2 qualifying sweeps after the excluded transition.
Current UI response reports the intended values on all three roles; historical
continuity remains unproven. Runtime is unchanged and healthy. No production
mutation or stage acceptance. The dated history below is preserved.

# C2b one-page shadow activation — 13 September 2026

Latest: [13 September 23:11 observation](observation-20260913T231118Z/REPORT.md).
The lifetime/monthly endpoint counts remain 99 each, with no additional completed
daily sweep since the excluded 10:53 transition. There are **0 of 2** qualifying
subsequent independent sweeps. The original activation clock is unchanged.

Current UI at 23:10 UTC shows `lilly-1`; three roles are active at 23:11 UTC.
The Docker runtime remains healthy on the same image with zero restarts.
Per-role effective configuration/version and historical continuity remain
unverified. Current independent review is pending the shared observer review.

The Management-only W0 prerequisite in the historical text below was superseded
by the owner's existing-session token choice and is independent of C2b readiness.

## Historical observations and original activation record

Latest: [13 September 17:10 observation](observation-20260913T171033Z/REPORT.md).
The report is unchanged from the 11:10 baseline: 99 checks/receipts on each
endpoint, no additional completed daily sweep, and zero qualifying comparisons.
The 10:53:03.993 UTC transition completion remains excluded. Two subsequent
independent completions and continuity evidence are still required.

The signed-in UI at 17:08 UTC shows `lilly-1` and three active roles, without
per-role application/version evidence. Docker remains healthy on the same
image. Historical flag continuity and all stage gates remain unproven.

Independent [review](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T170716Z/REVIEW.md) passed with no open actionable findings.

Previous observation (historical): [13 September 11:10](observation-20260913T111056Z/REPORT.md)
first recorded the 99-check endpoint baseline and transition completion.

Previous observation (historical): [13 September 05:09](observation-20260913T050954Z/REPORT.md)
had empty endpoints and unavailable Chrome. Those statements do not describe
the later 11:10/11:12 receipts or the current 17:10/17:08 receipts.

The [authenticated UI read at 13 September 01:00:36–41 UTC](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/flags-current-20260913T010036Z.json)
shows C2b `lilly-1` and all three roles active. It shows no configuration version
or per-role acknowledgement; uninterrupted historical continuity remains
unverified. The original observation start and qualifying-sweep rules are unchanged.

At the original activation, C2b was enabled on `lilly-1`, version 1.
API, worker and scheduler reported the desired value at
2026-09-12T23:38:22.888Z (13 September 02:38:22 Moscow).
The original immediate post-activation report had no tracked endpoint rows. Coverage,
quiet-correction detection, physical HTTP savings and event latency remain
unproven.

## Authorized operation and prerequisites

The owner authorized this operation in the implementation chat:
“да все разрешаю”. Only `fanslyFanEarningsShadowPageAllowlist` changed,
from effective `none` to `lilly-1`, using the existing audited Hub UI.
The configuration comparison covers 164 keys and shows one changed key.
No other flag was changed by this operation.

[C2b PR169](https://github.com/goslingmanagment/core/pull/169) was already merged
and deployed. The runtime observed for this activation is
`74aac5093cfc665853cc8e5b6cc661de7119b917`, image
`sha256:78155bc45b646787c6ed504cb3a24aadbe9990457ea1139f91f9d476f8904fc4`.
This is a live setting; activation required no deployment or restart.
Its implementation records semantic revisions and existing endpoint receipts
without adding provider calls or changing selection, budgets or daily rotation.

C2a acceptance now covers six independently verified bounded page snapshots.
The final Lora-1 and Lilly-2 exports used the operator-script correction in
[PR181](https://github.com/goslingmanagment/core/pull/181), merged at
2026-09-12T23:35:28Z. All six scopes have caught-up projections and zero parse
debt. Their different cutoffs do not form an atomic agency snapshot. No repair
was justified by these results.

## Activation receipts

| Evidence | UTC | Result |
|---|---|---|
| Baseline SQL snapshot | 12 September 23:32:36.524388 | Empty shadow; tracked scope incomplete |
| Configuration before | 23:33:21.703 | Environment fallback `none` on all roles |
| Save followed by GET | 23:35:59.289 | HTTP 200; `lilly-1`, version 1; application still pending |
| Fresh configuration GET | 23:38:22.888 | All three roles `lilly-1`; no pending apply or drift |
| Post-activation SQL snapshot | 23:39:50.557199 | Still empty; no post-enable completed daily sweep |

Use 23:38:22.888Z as the conservative observation start. It is the time of
confirmation on all roles, not a measured instant when every chunk changed.
The exact save instant is bounded by its subsequent GET.

The baseline and follow-up SQL use `read_only` in repeatable-read READ ONLY
transactions, with a 15-second statement timeout, 1-second lock timeout and
bounded noninteractive sessions. SQL, raw results, transaction identities,
command outcomes and hashes are retained alongside this report.

Both reports retain the last completed daily spender sweep at
2026-09-12T10:53:28.495Z, before activation. They report empty endpoints and
outcomes, zero currently recorded unknown attribution, and
`tracked_scope_complete=false`. Empty scope cannot establish zero missed
corrections or complete attribution.

## Physical HTTP baseline

For `lilly-1` / `fan_earnings` only, the 24-hour window
2026-09-11T23:32:36.524388Z to 2026-09-12T23:32:36.524388Z contains:

| Operation | Physical attempts | Retry attempts | Unknown payload bytes |
|---|---:|---:|---:|
| Monthly per-fan earnings | 99 | 0 | 0 |
| Lifetime per-fan earnings | 99 | 0 | 0 |
| Total | 198 | 0 | 0 |

All 198 attempts succeeded with HTTP 200. The corresponding 50 scheduled-run
receipts have zero unknown runs, boundary runs, unfinished attempts and
unrecorded attempts. This scope has 52,607 captured payload bytes; those are
not wire bytes. Other streams in the same raw export have separate failures
and unknowns and are not included in these earnings numbers.

This is a baseline, not a measured reduction. Endpoint visits in the shadow
report cannot replace physical HTTP telemetry.

## Observation and rollback

The existing `fansly-a0-shadow` heartbeat now also observes C2b. Its schedule
and the original A0 clock are unchanged. It retains cumulative reports and
notifies only for a meaningful finding, failure, required input or a completed
bounded comparison. It performs no implementation or production mutation.

The first comparison needs two distinct complete independent daily sweeps
with a proven start at or after the all-role confirmation time. The allowlist
is read per chunk: completion after enablement alone is insufficient. If the
start is unavailable, exclude the first post-enable completion as transitional,
then compare two subsequent distinct daily sweeps with evidence of that
ordering and no known flag or instrumentation interruption. Missing continuity
or provenance stays unknown.

The metadata role cannot SELECT configuration or runtime-instance tables.
Existing signed-in Chrome configuration reads may establish flag continuity;
unavailable UI access is recorded as unknown. No role fallback, credential
creation or cookie extraction is part of observation.

The bounded observer reports incomplete evidence once if eight days pass
without two qualifying sweeps. It ends only after both its A0 and C2b reports
are delivered; ending observation does not pass either implementation gate.

For rollback, set only `fanslyFanEarningsShadowPageAllowlist` to `none`
through the audited Hub UI and verify all roles. Keep pending revisions,
receipts and the ordinary daily rotation. This operation has not run rollback.

## Validation and remaining scope

PR169's pre-PR checks remain its implementation evidence: `pnpm check`
passed 3,190 tests with 9 existing skips; serial real Docker-Postgres passed
57 tests in 10 suites with zero skips. Tests cover atomic semantic changes,
old/new fan attribution, revision races, separate endpoint outcomes,
capture ordering, provider errors, reader permissions and erasure scope.
Its independent review findings were fixed before merge.

PR181 passed 3,364 tests with 9 existing skips and 61 real Docker-Postgres
tests in 10 suites with zero skips. It tests local planner-mode selection,
rollback restoration in the same connection, fail-closed identity receipts
and existing cursor, scope, payload and projection behavior. All five required
CI checks passed. Correctness, numerical evidence and code quality were
independently reviewed. This flag operation changed no application code.

The operational reviewer found that completion time alone could admit a
partially instrumented transition sweep. The observer rule above fixes that
finding; final document review is recorded in `REVIEW.md`.

Uncovered: pre-enable and untracked fans/windows; missing-roster targets;
quiet corrections outside signals; per-fan max-age equivalence; per-correction
latency; physical savings. C2c remains gated by those measurements or its
separate owner max-age decision. A0's earliest seven-day point remains
2026-09-17T22:58:33.610Z; calendar age alone does not authorize A1 acceptance.
W0 still needs the dedicated test account label with a Management Session.
## Historical observation at 00:20 UTC

[13 September, 00:20 UTC](observation-20260913T002030Z/REPORT.md): read access
recovered; endpoint/outcome arrays remain empty and no qualifying post-enable
daily sweep has completed. Current effective flag continuity is unverified.
The dated activation proof and original observation clock are preserved.
