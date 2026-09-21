# 04 — Preserve the certified comparison boundary across A1 cursors

## Root cause

After bounded state, parseDmConversationSweepState returns null. createDmShadowState only checks a completed full cursor, ignoring previousBounded.polling.lastCertifiedFull. The next full sweep gets boundaryMs=null and reports incomplete despite the scheduling proof being present.

## Proposed change

Resolve the previous certified full once from validated checkpoint state: the A1 polling lastCertifiedFull proof when present, otherwise a completed membership-certified legacy full. Feed its completion timestamp to the A0 comparison (preserving the accepted A0 semantic); A1 still uses the start time and its 60-second overlap. Do not accidentally change the stop algorithm to use the later completion time.

Persist the chosen A0 boundary in the full-sweep diagnostics before/with progress so it survives chunk/restart. Existing diagnostics win on resume. Malformed/uncertified/future/partial proof stays unknown and incomplete; a resumed sweep with no saved boundary cannot reconstruct a complete comparison after missing earlier pages. The change must not alter membership stamping, last-success timestamps, full certification or cadence.

## Acceptance

Integration: certified full→bounded→next full produces a complete A0 report with the expected prior boundary; chunked resume retains it; legacy completed full still works; a new/uncertified cursor stays incomplete; interrupted full with missing diagnostics cannot become complete; disabling A1 still falls back to a correct full. Include a below-stop changed-head witness to prove the comparator actually runs, not merely that a status label is green.
