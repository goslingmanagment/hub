# Bounded SSE warning review — 13 September 2026

The retained warnings show two historical episodes of smoke-checkpoint staleness
or missing-checkpoint detection. They do not measure Fansly event-to-reader
latency or establish an ongoing delivery failure. No further production probe
was performed or is justified by this packet alone. Recommendation: DONT_NOTIFY
for this observer; retain the outlier and its limits.

## What the deployed code measures

Inspected locally with `git show` at
`380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`; line numbers below refer to that
revision, not the current checkout.

- `apps/runtime/src/services/golden-signals.ts:50,80–84,184–197` samples the age
  of `domain_events_smoke_checkpoint.updated_at` each minute, with a 600,000 ms
  threshold. A missing checkpoint also produces the `sse_delivery` breach.
- `golden-signals.ts:263,315–337,408–411` stores the same instantaneous age in
  both p50 and p95 slots. The warning logs metric names only. It does not expose
  a frame-latency distribution, exact age or whether the checkpoint was absent.
  A missing sample leaves the incident latch unchanged, so later omission of
  the metric is not proof of incident resolution.
- `apps/runtime/src/services/domain-events-smoke.ts:22–32` describes a worker
  subscriber to the internal replay/live hub, not a browser-network timing probe.
  `:59–69,115–170,275–285` advances the checkpoint timestamp only when consumed
  events or continuity counters make the state dirty. The 30-second timer does
  not refresh an idle checkpoint. Thus a quiet interval can produce an old
  checkpoint; that is a possible explanation here, not an established cause.

## Retained log evidence

Source: `worker-log.stdout` in this directory, SHA-256
`9fd57a3f2e75b7f027b059f64863358104035530c73c614e382894e7f780e98c`.
All 3,000 lines parse. Actual coverage is 12:02:37.446–17:07:13.321 UTC;
the requested lower bound was 11:08:40, but the tail limit excludes its prefix.

Eight warnings name `sse_delivery`, each also naming the known OFAPI v5 backlog:

| Episode | UTC timestamps | Samples |
| --- | --- | ---: |
| First | 15:00:13.985, 15:01:13.182, 15:02:13.474 | 3 |
| Second | 16:10:12.976, 16:11:10.065, 16:12:10.846, 16:13:10.683, 16:14:10.937 | 5 |

The following 53 completed threshold-warning records, through 17:07:13.180,
name only the OFAPI backlog. This bounds the retained symptom; it does not
establish exact recovery time or prove that an SSE sample existed on every run.

Thirty smoke summaries span 12:08:40.908–16:58:40.927. Their cumulative
`framesSeen` rises from 1,392,664 to 1,394,751; `gapCount` stays at 2,781 and
`duplicateCount` at zero in every summary. The 2,781 gaps are historical,
not new gaps in this comparison. No smoke warning/error is present in this
bounded tail. Ten-minute summaries cannot reconstruct event interarrival times,
checkpoint write timing or individual consumer delivery.

The prior 11:08 tail contained no SSE breach, but the tails cover different
intervals. These are eight new retained diagnostic samples, not eight failed
messages, a failure-rate estimate, a confirmed false alert or a Fansly SLA result.
No lost message, current incident, causal relationship to OFAPI backlog or stage
gate change is established. This review used local logs and exact source only;
no tests, SQL/API/UI calls, application edits or operational changes were made.
