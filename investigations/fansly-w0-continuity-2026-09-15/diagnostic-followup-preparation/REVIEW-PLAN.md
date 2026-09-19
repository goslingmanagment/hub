# Independent next-probe plan review — 15 September 2026

Reviewer: `/root/w0_next_scope`. Reviewed NEXT-PROBE.md, its local readiness
receipts, the retained binding/absence evidence and referenced validated artifacts.
Only this review was written. No tests, live actions, key reads/creation, staging,
source changes, production or browser operations were performed.

**The proposed single-attempt scope is consistent with the existing approval.**
The earlier failed receiver stopped and was investigated; the diagnostic-loss
correction does not establish its transport cause. A further bounded diagnostic
attempt can proceed within the agreed work after the stated technical gates.
There is no new token-approval requirement or time-based receipt-expiry rule.

## Two factual wording clarifications

1. The opening unqualified "no REST request" should explicitly mean no new Hub
   preflight/receiver REST request. Preparing native browser contexts and ordinary
   browser traffic are outside the receiver's zero-REST count. The later receiver
   limits already make the intended boundary clear; no additional browser action
   or provider accounting result is authorized by this clarification.
2. The static-version receipt establishes Node 22.23.2, OpenSSL 3.5.7 and Undici
   7.27.2 in the recorded image. Matching the tested Undici release supports API
   compatibility, but is not an execution test of the new compose/transport path
   inside production. Narrow the wording that says it "confirms" compatibility
   to the version match and retain that behavioral limitation.

## Preconditions that genuinely remain before execution

- Successful required CI, checked-head merge and matching diagnostic source.
  A saved pending snapshot or local passing checks is not a current merge verdict.
- Fresh host/image/network/health/resource/admission evidence. Unknown or foreign
  container ownership must refuse launch; a newly observed REST restriction is
  a stop condition. The `503 agent_plane_disabled` envelope receipt proves only
  that this Hub read is unavailable. It proves neither provider restriction nor
  successful provider REST traffic. That evidence gap remains visible for root's
  readiness assessment, without a privilege bypass, flag change or extra GET.
- Actual Lilly native Received-frame capture remains a prerequisite. The newer
  `ari-baseline.json` now documents the intended Ari account/target at baseline;
  preserve and verify that context for the actual attempt window. The earlier
  lora-2 selection is historical and does not contradict the later Ari baseline.
  Existing unrelated tabs must be preserved.
- The receiver's fresh credential snapshot and immediate generation read must
  match the original successful binding receipt. Invalid evidence, mismatch or
  unavailable read means zero socket attempts, without an automatic new GET.

The binding receipt's hash, page/account and generation match the proposal.
Its original cleanup failure and later separately confirmed absence remain
distinct. All nine hashes in the artifact table match the referenced local
files. The referenced full-check and PostgreSQL execution receipts are successful
and retain unchanged source hashes; their results do not replace live readiness.

## Attempt and acceptance limits

One short-launcher attempt is bounded by 120 seconds, the existing 150-second
host deadline, frame/report limits and owned-container cleanup. Early failure
does not grant a replacement attempt. The proposal does not schedule continuity,
generate test events, change credentials/routes, introduce business/pacing writes
or suppress ordinary REST collection.

The native capture starts first; only complete received frames inside the actual
intersecting windows can support a comparison. A missing corpus, empty overlap,
zero events or interrupted capture remains inconclusive. Ari samples while the
Lilly browser remains connected cannot isolate receiver-induced presence and
cannot pass the browser-off / WS-off-on gate. Shared provider-session provenance
is correctly left unknown.

The new fields remain bounded observations, not cause labels or permission/scope
proof. The proposal retains failed output and requires confirmed cleanup without
rewriting sealed evidence. Root owns the current gate checks and execution; this
review does not itself establish a new connection or W0/B0 acceptance.

Initially reviewed proposal SHA-256:
`6fb53b1daf3727140b2f95880124a574e40d8a0a3f358dd03f40e3c734951a50`.

## Resolved re-review and Ari baseline

Both wording findings were corrected: zero REST is explicitly scoped to Hub
preflight/receiver traffic, and runtime metadata establishes the version match
without claiming production execution of the new interceptor. Re-read proposal
SHA-256: `92d6c21eb03cdccdc229418f6f637c59febe1e6b7517a618a5ceea3816422b69`.
No wording findings remain open.

The subsequent retained Ari baseline records the owned fourth Ari-1 tab,
authenticated profile link `itsaribae`, target `WetLillys/posts` and `Last seen
today` in the read requested at 21:21:12 UTC. It preserves the original three tabs,
including Lora-2. This establishes the intended baseline context, not a continuous
presence interval or the still-missing Lilly Received-frame reference. No Hub
receiver is established by these preparation receipts. Root may finish the
remaining technical readiness gates within the already agreed scope.
