# Independent failed-attempt evidence review — 14 September 2026

Reviewer: `/root/w0_next_scope`. Reviewed retained receipts, operator hashes,
native summaries, authorized-reader evidence and the final offline diagnosis.
No tests, provider requests, production/browser actions or key-content reads
were performed in this review. REPORT.md received the two precision corrections
listed below; original receipts and other agents' artifacts were not changed.

**The failure verdict and gate disposition are supported. No material unresolved
finding in the live report remains.** One receiver observation lasted 158 ms
(20:42:08.221–20:42:08.379 UTC) and ended with `transport_error`, zero frames,
no type-1, null close code and zero receiver REST requests. The planned 120-second
observation did not complete. The accepted preflight hash/account/generation and
the before/after generation comparison do not establish the WS actor or scope.

## Execution and evidence integrity

All nine retained operator files match their build/staging hashes. Invocation
uses the short bundle, one attempt, existing runtime image/environment, the
private diagnostic key and the successful binding receipt. The result and
execution hashes match REPORT.md:

- `server-output/report.json`: `bf7165074ecf4be97d258c7a14b403d836d514a00d5df6c6139fa868266eedfc`
- `server-output/execution.json`: `6853fefb40f635be08049692b4c0ad2bd60448fa410ee5d8a581afaf440aa573`

Container exit 2 and SSH launcher exit 1 are retained, with no timeout and
confirmed attach stop, output sync and cleanup. Cleanup exit 1 is consistent
with the corrected helper recognizing exact container absence; it is not a
failed cleanup. The later host receipt separately reports no W0 container,
unchanged API/worker/scheduler container IDs/image, healthy roles, zero restarts
and 17,241,080 KiB available. It does not prove healthy provider REST outcomes.

The direct `page_dm_threads` and post-attempt `sync_http_attempts` reads both
retain permission-denied results. The standard authorized reader supplied only
three inventory references with the recorded partiality/coverage limitations.
No privilege fallback or complete transcript/recovery claim appears. Native-tab
closure and remote diagnostic-key cleanup retain their own request/verification
receipts; they do not establish closure of every creator session.

## Corrected wording and browser limitations

1. REPORT.md originally said `native-observation.json` records 47 previews.
   It contains the operator's aggregate count/time/type summary, not 47 retained
   rows. The report now says this explicitly and notes that the count cannot be
   independently replayed from the packet.
2. "The original stderr files are empty" was overly broad: denied reads and the
   offline reproduction have nonempty stderr. This now explicitly refers to the
   original receiver and launcher stderr, which are both empty.

The native type-1 metadata predates the server attempt. Its correlation-key
fingerprint matches the receiver's, without proving a shared provider session.
The preview summary spans 20:42:00.236–20:42:30.279 UTC, surrounding the reported
158 ms interval; it is not a frame corpus confined to that interval. Native UI
activity, an earlier Ari baseline and unknown other creator sessions cannot
prove fan-out, complete browser delivery or WS-off/on presence effects. The
report appropriately retains cross-host clock uncertainty and claims no latency.

## Offline diagnosis

The retained source and dependency hashes match the inspected checkout. Original,
current and merged transport-source comparisons also match. The earlier
successful probe's nested receipt records the same stored generation; this
does not prove unchanged provider state or effective runtime/TLS configuration.

The synthetic harness uses fake EventTargets or explicit in-memory rejecting
dispatchers, with a rejecting global fallback. Its saved exit-0 receipt covers
four observer cases and three real local Undici cases. Source and results agree:
the short wrapper drops `openedAt`, first completion discards a later close code,
and distinct synthetic transport errors collapse to indistinguishable receipts.
This proves diagnostic loss, not the live cause or a failed handshake. Local
Node/Undici versions are not substituted for uninspected production versions.

This failed-attempt packet contains no validation of the proposed
dispatcher-boundary diagnostic change. Implementation or validation in a
separate worktree is outside this evidence review. No retry, new live scope or
W0 acceptance follows from the retained proposal. Root owns final sealing after
all contributors finish.

Final source-analysis re-review: the ambiguous `execution.json` citation was
corrected by its author to `../server-output/execution.json`, distinguishing
live exit 2 from the offline reproduction's exit 0. The final analysis SHA-256
is `aeac3d2945355c5a5855f1cdcaa2bc398cd5da46f0d4dcfd7bdd55bba2f14b76`.
All retained JSON parses successfully. The source author confirmed completion;
no review findings remain open. This reviewer did not seal the packet.
