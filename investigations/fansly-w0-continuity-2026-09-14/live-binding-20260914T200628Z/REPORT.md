# Lilly-1 W0 REST identity — 14 September 2026

The single REST identity request succeeded. No Hub receiver was started.
The original launcher returned failure because cleanup was not confirmed;
separate read-only checks subsequently confirmed the container was absent.

## Live result

- Source `9f727fe17464158c6c7136b78bb414b27f841d47`, merged by PR197
  as `1d0ed3cf8232c24f659d37db9ceda21d65d09dd3`.
- Existing Lilly-1 encrypted REST credential and its existing page dispatcher.
  No proxy settings were inspected or changed in this experiment.
- One GET, HTTP 200, from 20:09:41.786 to 20:09:42.189 UTC.
  Expected and observed account ID: `643579795946348544`.
- Credential/route generation:
  `c7a7ea0c8cf2fce9c2f3e697482e8abce3ae9767869991c6a44a9dfddf7226da`.
- Node/container exit 0; no timeout; attach stopped and output fsync confirmed.
  Launcher exit 1, original `cleanupConfirmed: false`, cleanup exit 1.
- Exact-name and exact-run-label Docker listings at 20:12:14.802 and
  20:12:17.012 UTC both succeeded with no rows. These establish absence at
  those checks; the original execution receipt is unchanged.
- API, worker and scheduler remained healthy with zero restarts at
  20:10:43.499 UTC, on runtime source `ac92197ba976`.

The separate inspect at 20:11:26.218 returned
`error: no such object: hub-fansly-w0-lilly-1`.
The reviewed helper only recognizes `No such object` with a capital N.
This proves a live compatibility defect in absence recognition. The original
cleanup stderr was not retained, so the exact original failure path cannot be
reconstructed from its receipt alone. Fix and independently review the shared
helper before continuity; normal automatic removal must not abort its gaps.
No identity GET retry is needed to investigate or confirm cleanup.

## Evidence boundaries

`plan.json` records the action, authorizing exchange, source, immutable image,
network, environment path, stop bounds and SHA256 pins. `staging.json` verifies
all nine remote operator files. `server-output/report.json` is the original
sanitized identity receipt; `server-output/execution.json` is the original
cleanup/result receipt. `cleanup-absence.json` contains the later independent
absence checks. Host-script `providerRequestStarted: false` describes each
read-only metadata command, not the whole experiment, which made one GET.

REST identity is bound to the recorded generation. Socket actor scope, paired
fan-out, presence effects, continuity, gap recovery, savings and event-to-reader
latency remain unmeasured or unverified. No socket, flag flip, deployment,
credential change, business write or recovery dispatch was performed here.

The accompanying Ari/native reference observations are in
`../observer-ari-20260914T195710Z/`; they do not provide paired Received frames.
