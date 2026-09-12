# C1 presence consumers and the freshness boundary

Full follower walks also refresh presence for fetched older followers. The
Workboard uses those observations for urgency, not only a display badge.
Retiring zero rows therefore does not prove that a full walk had no useful
effect. This inventory identifies the code dependency; it does not measure
production presence coverage or authorize a slower refresh policy.

The inspected source is deployed release `31b73a96`. Its presence producer,
repository and server consumers match the restored `64149b95` source. The
dashboard has newer navigation and reporting copy; its presence filter and
display remain consumers. A hash inventory is retained with the observation.

## Producer and storage

`apps/runtime/src/services/fansly-presence.ts` takes account `lastSeenAt`, falling
back to follower `lastSeenAt`. It normalizes milliseconds, retains observations
younger than two hours and assigns the existing 30/120-minute buckets. The
local observation timestamp is distinct from the provider's activity time.

Both follower handlers in
`apps/runtime/src/services/sync/executor-handlers.ts` build presence signals from
the fetched page. The incremental handler does so before its known-checkpoint
loop stops membership processing; presence can still come from the rest of
that fetched page. It cannot observe old followers on pages it never fetches.
The full handler observes each fetched roster page. Both paths persist presence
through the owned page transaction, including partial chunks.

`upsertFanPageExternalPresences` in `packages/db/src/repositories/fans.ts` keeps
the maximum provider activity and local observation timestamps in `page_fans`.
The generic `lastSeenAt` bookkeeping field is not the provider presence time.
No new presence source or cadence was added by C1 diagnostics.

## Identified consumers

- Followers API: `packages/db/src/repositories/reporting.ts` filters
  `activeWithinMinutes` by activity time and classifies 30/120-minute buckets.
  `apps/runtime/src/services/reporting.ts` returns status and both timestamps.
- Followers dashboard: `apps/dashboard/src/pages/FollowersPage.tsx` uses a
  120-minute Active filter and renders the returned presence status/time.
- Workboard urgency: `recompute.ts` supplies both timestamps to `engine.ts`.
  The presence driver rejects observations older than 30 minutes. Activity
  within 30/120 minutes produces a driver value of 35/20. Final urgency uses
  the existing driver aggregation, not a direct addition of that value. These
  modules are under `apps/runtime/src/modules/workboard/`.
- Workboard online indicator: `report.ts` in the same directory uses activity
  within six minutes. Its threshold differs from urgency and Followers.
- Agent timeline: `packages/db/src/repositories/agent-read.ts` exposes the
  stored latest presence timestamp in the presence lane. This mutable row is
  not a history of every activity event.

The shared field does not make these product thresholds interchangeable.
This is a Hub source inventory, not a complete audit of external clients.

## What C1 still has to prove

The existing handler unit fixture checks a follower-derived presence write;
the database reader fixture checks enriched follower presence. Those checks
do not establish equivalent coverage when a future policy skips a full walk.
No local tests were rerun or introduced for this source-only inspection.

A candidate suppression must account for followers outside incremental pages,
their observation age and these reader behaviors. Neither a matching headline
count nor zero actual retirements certifies that obligation. New sockets are
not an assumed replacement; W0/B0/B1 retain their separate evidence gates.
