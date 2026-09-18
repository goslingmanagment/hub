# W0 Lilly-1: failed paired-observation attempt, 14 September 2026

**Result: W0 remains unverified.** One receiver attempt ended with
`transport_error` after 158 ms and no received frames. Its process stopped,
output was synchronized, and container cleanup was confirmed. There was no
retry and no six-hour continuity run.

## Exact execution and identity

- Reviewed operator source: PR [198](https://github.com/goslingmanagment/core/pull/198),
  head `1efe1cb42ba730d9cdcb4b7d74d139d87d3abb60`, merged as
  `b5900cfcf41a5a29d45a7c8c7c8ee0b2a76dce3e`. The nine staged operator files
  were hash-verified before execution; see `operator-builds.json` and `staging.json`.
- Existing runtime image: `sha256:ca60d6371efa39d256c929eec025f05d78edf97dba21076b82f58b1f5f8cc01d`,
  source label `ac92197ba976`. This diagnostic did not deploy or restart services.
- Lilly-1 used its existing encrypted REST session and existing page dispatcher.
  The separate [one-GET identity preflight](../live-binding-20260914T200628Z/REPORT.md)
  returned HTTP 200 with expected account `643579795946348544` at
  20:09:42.189 UTC. Receipt SHA-256:
  `94fd01694c6804b0d876d04d85ed59a572486b87970c77c7efd28099d88c1354`.
- The receiver accepted that receipt, checked the fresh generation before
  connecting, and observed it unchanged afterward. This proves the recorded
  credential/route binding, not the WS actor or its capabilities.
- Actual receiver observation: **20:42:08.221–20:42:08.379 UTC**, 158 ms;
  one connection attempt, zero received/retained frames, `sessionFrameSeen=false`,
  `closeCode=null`, **zero receiver REST requests**. Planned 120 seconds were not
  observed. `PLAN.json` is the preserved preparation record, not current status.

`server-output/report.json` is the result authority. Its SHA-256 is
`bf7165074ecf4be97d258c7a14b403d836d514a00d5df6c6139fa868266eedfc`.
`server-output/execution.json` records exit 2 without timeout, confirmed attach
stop/output sync/cleanup; cleanup exit 1 was recognized as container absence.
Its SHA-256 is `6853fefb40f635be08049692b4c0ad2bd60448fa410ee5d8a581afaf440aa573`.
The SSH launcher exited 1. Wall clocks across Mac, browser and VPS were not
calibrated; their ordering is contextual and is not an event-latency measurement.

## Browser and reader evidence

The owner selected Ari as the independent presence observer. The existing Ari-1
container authenticated as `itsaribae`; the earlier [observer packet](../observer-ari-20260914T195710Z/REPORT.md)
contains one WetLillys presence baseline. It does not establish a continuous
WS-off/on presence comparison. Ari later displayed notifications; the cause of
that navigation was not established.

Our separate Lily-1 reference tab authenticated as WetLillys. Native Firefox
Network Monitor recorded HTTP 101 and a received type-1 frame at 20:30:45.275 UTC,
before the server attempt. Only sanitized metadata from that complete frame was
saved in `native-before-receiver.json`. Native/Hub same-token provenance remains
unverified; no browser credential was extracted.

`native-observation.json` retains the operator's aggregate summary of 47
received-row previews, with reported timestamps from 20:42:00.236 through
20:42:30.279 UTC, around the failed attempt. The individual previews are not
retained. These truncated UI observations are not full-frame records, do not all
fall within the actual 158 ms, and provide no paired corpus or completeness
proof. The summary records observed browser activity continuing after the failed
receiver attempt; the count cannot be independently replayed from this packet.

The authorized Hub reader supplied three thread/head references as inventory
samples. Its `delivery_not_exhausted`, `capture_floor_unknown`, and
`plane_not_read` limitations remain. No full transcript or gap recovery is
certified. Direct SQL access to `page_dm_threads` was denied. No alternate DB
role or grant was used.

## Failure interpretation and cleanup

`transport_error` does not identify an auth rejection, session conflict, proxy
failure or provider restriction. The current short wrapper omits the observer's
`openedAt`; therefore a missing successful-open field does not prove that the
handshake failed. Offline source analysis is retained in `offline-diagnosis/`.
The original receiver and launcher stderr files are empty; no missing transport
error text is reconstructed.

At 20:45:11.734 UTC the API, worker and scheduler were healthy with zero restarts,
the same image, and no W0 container. Available disk was 17,241,080 KiB (79% used).
This proves service health and receiver absence, not successful provider REST
traffic. The post-attempt read of `sync_http_attempts` was denied to `read_only`;
provider REST outcomes after the attempt remain unknown from this packet.

Only our fourth, temporary Lily-1 tab was closed; the three existing tabs remain,
with Ari-1 selected. DevTools docking was restored to the prior bottom position.
See `native-reference-closed.json` for request/verification times. No logout,
global offline switch, test message, follow, reaction, credential rotation or
proxy-settings inspection/change was performed in this experiment.

The owned 32-byte diagnostic correlation key was removed from the remote staging
directory after metadata validation. Launcher key/receipt copies were already
absent. See `remote-diagnostic-key-cleanup.*`; provider credentials and other files
were unchanged. The private local diagnostic key remains outside this packet.

## Gate disposition

| Evidence or gate | State |
| --- | --- |
| Existing REST account identity and generation comparison | Verified for this receipt/attempt |
| Receiver received type-1 / socket actor and scope | Unverified: no received frames |
| Same-token fan-out and paired business delivery | Unverified: no paired corpus |
| Independent WS-off/on presence comparison | Unverified: only a separate earlier baseline |
| Six-hour continuity, receiver-only gaps and recovery | Not run |
| B0/B1 admission | Remains gated |
| Physical HTTP savings and event-to-reader latency | Not measured |

The stop rule was applied. Investigate the failure and retain useful, safely
bounded failure diagnostics before resuming a live probe; do not turn repeated
short attempts into claimed continuity. Freshness policy, polling and all stage
gates are unchanged. The owner has already authorized the agreed existing-token
work; this packet does not create a new permission request or expand its scope.
