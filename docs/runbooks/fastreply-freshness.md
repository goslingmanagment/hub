# OnlyFans AI transcript freshness

Operational runbook for the archive/union/readthrough/corrections path. Current
behavior is defined by code and Decisions #121-#123, #134, and #234. Historical
design and rollout evidence remains in Git history.

## Safety rules

- Change one flag per verification window (#234).
- `ofapiDmColdArchiveEnabled` must be effective before readthrough reconcile is
  enabled.
- Never enable the corrections reconciler before the fingerprint backfill.
- Do not clear a backlog alert by deleting observations; repair or resume the
  consumer.
- Use `docs/runbooks/message-archive-rebuild.md` for any archive rebuild. The
  old in-place delete-and-replay flow is retired.

## Controls

| Config key | Values | Apply |
| --- | --- | --- |
| `aiTranscriptFreshUnionMode` | `off`, `shadow`, `serve` | live, per generation |
| `ofapiDmReadthroughReconcileEnabled` | boolean | staged, boot |
| `ofapiDmCorrectionsReconcileEnabled` | boolean | staged, boot |

Read effective values from the admin config surface and runtime heartbeats. Use
the admin config API for changes; do not infer effective state from an env file
alone.

## Fresh-union lane

`aiTranscriptFreshUnionMode` controls the transcript read used for OnlyFans AI
features:

- `off`: serve the archive only. This is the performance rollback.
- `shadow`: execute the union query and record its comparison, but serve the
  archive. This is the correctness rollback, not a load rollback.
- `serve`: serve the union; on query error, serve the archive with
  `staleContext: true`.

Upward changes must be stepwise: `off -> shadow -> serve`. Any rollback to a
lower mode is allowed immediately.

For the verification window, inspect owner-only restricted generations at
`params.contextManifest`. Watch `mode`, `source`, `additions`, head timestamps,
`gapMs`, `queryDurationMs`, and `unionError`. Stop or roll back on union errors,
unexpected head regressions, or material query-latency growth.

## Readthrough reconcile

When `ofapiDmReadthroughReconcileEnabled` is on, eligible chat-open reads capture
`ofapi_gateway_chat_messages_v2`, project immediately on a best-effort basis,
and leave the minutely sweep as recovery. The worker log line is
`Readthrough reconcile sweep complete`.

Review its upserts/no-ops, conflicts, drops, deferred writes, and parse skips.
Conflicts are observed source divergence, not permission to guess a winner.
Erasure-fenced material is terminal; a write deferred behind an active erasure
must retry.

Turning the flag off stops new v2 capture and immediate projection. Previously
captured v2 rows remain durable and may keep the readthrough backlog signal
open until the consumer is resumed and drains them.

## Corrections reconciler

Before the first enablement, run:

```text
corrections:backfill-fingerprints --dry-run
corrections:backfill-fingerprints
corrections:intake-lineage --dry-run
corrections:intake-lineage
```

Review every dry-run count. Do not enable if the fingerprint backfill is
incomplete or the lineage intake reports an unexplained open drain.

After enabling `ofapiDmCorrectionsReconcileEnabled`, watch
`DM corrections reconcile sweep complete`. First events should drain toward
zero; superseding events should be rare and explainable; growing lineage/stub
skips or a cursor that does not advance is a stop condition.

Disabling the flag stops future sweeps and preserves the repair signal for a
later resume. Events already appended by the reconciler are immutable facts and
have no rollback.

The one-shot `events:repair-fansly-1970` campaign is historical repair tooling,
not part of an ordinary freshness rollout. Re-running it requires an owner
review of its dry-run and current event partitions.

## Rollback summary

- Query load: union mode to `off`.
- Serving correctness: union mode to `shadow`.
- New readthrough capture/reconcile: stage readthrough off and restart.
- Corrections drain: stage corrections off and restart.

Rollbacks stop future work; they do not delete captured inputs, restricted
generation evidence, corrected material, or appended domain events.
