# C1 presence: available reads and the remaining measurement

The current Agent Read Plane cannot measure the observation age that Workboard
requires. Its presence lane exposes the latest provider activity timestamp,
but not `external_presence_observed_at`. This does not establish stale or absent
presence in production; no presence rows were read in this investigation.

The [consumer inventory](PRESENCE-CONSUMERS-20260912.md) establishes why full
follower walks matter beyond membership. This follow-up checks whether the
existing read surfaces can measure that dependency before a suppression change.

## Verified read surfaces

At 19:52:44–19:52:46 UTC, the production-pinned `hub capabilities --pretty`
call succeeded. The grant covers all six Fansly pages. `presenceAt` is a claim
field, but there is no presence dataset or dataset field in the served catalog.
The response carries `claim_not_declared` and `capture_floor_unknown`; it is
capability evidence, not a completeness or freshness result.

| Surface | What it supplies | Measurement limit |
|---|---|---|
| Agent timeline, presence lane | One fan's latest stored `external_presence_at`, returned as `occurredAt` | No local observation timestamp or observation history; traversal explicitly has no frozen snapshot |
| Agent `fan_memberships` dataset | Membership bookkeeping `page_fans.last_seen_at` | This is neither provider activity nor its local observation timestamp |
| Followers API | `presence.lastSeenAt`, `presence.observedAt`, and `followedAt` | Requires a human principal with page access; offset pagination does not freeze the roster |
| Restricted C1 readers | Trigger, queue and membership receipts | Do not export presence observations |

The Followers API declares `auth: { kind: "any", scope: "page" }`. Here `any`
explicitly admits human authentication methods; it does not admit an agent key.
Both the policy evaluator and the handler's `requirePrincipal` enforce that
boundary. The route is not owner-only. No request to that route, credential
creation or authentication change was attempted.

At 20:00:24.425779 UTC, a five-second-bounded REPEATABLE READ READ ONLY catalog
query as `read_only` confirmed no SELECT on `page_fans` or `page_follows`.
The public functions whose names contain `presence` or `followers` comprise
the two existing C1 readers; both are executable by `read_only`. This is a
named-function inventory, not a claim about every possible read surface.

At 20:00:24–20:00:26 UTC, API, worker and scheduler were healthy with zero
restarts on `31b73a96`. All fifteen inspected source files match that revision,
the pinned CLI archive and the C1 worktree. The
[validation receipt](evidence/presence-access-20260912T195244Z/validation.json)
records source and raw-evidence hashes. Raw capabilities remain local.

## What a suppression candidate would need

Measure the followers outside the incremental pages it would skip refreshing,
keeping provider activity time separate from local observation age. A current
age distribution could provide a baseline. By itself, it cannot identify which
full or incremental run refreshed those rows or establish the counterfactual
coverage of a skipped walk. The repository stores maxima, not per-run presence
history, and Decision 224/A20 excludes volatile presence inputs from captures.

Repeated snapshots must retain their cohort and time bounds; roster changes
and independently advancing maxima prevent treating them as an atomic history.
Unknown inputs remain unknown. Workboard's observation-age condition must be
checked separately from Followers' activity buckets and the online indicator.

No suppression candidate has yet been established as redundant. The latest
[natural completion](OBSERVATION-20260912T183741Z.md) includes two actual
retirements after a guarded restart. This investigation therefore does not add
a speculative reader, new presence source, flag or polling policy. A future
candidate still needs a scoped measurement of the refreshes it would remove.
Neither a matching headline nor zero retirements clears that obligation.

This follow-up changes documentation and evidence only. No application suite
was rerun; existing unit and Postgres results do not measure production presence
coverage. Savings, fresh-event latency and the C1 exit gate remain unproven.
