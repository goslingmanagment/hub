# Deploy ancestry and Fansly DM fairness

Status: revised after independent Fable review; ready for implementation.

## Evidence and scope

On 2026-09-22, a deployment of 5d4cf1b12048 replaced the newer 1cd78fa4eef0
release. The current deploy lock serialized the deployments but did not compare
their ancestry. Production has since been restored to 1cd78fa4eef0.

On Lora 2, a followers reconciliation occupied consecutive page chunks from
00:44:53 through 00:56:45 UTC. Five incoming messages waited while the runnable
dm_conversations stream had lower priority (30 versus 34). All five were
subsequently captured. Cross-page FIFO already works; this fix concerns only
selection of the next stream within one page.

The owner authorized these two fixes, independent Fable plan/code review,
merge, deployment and verification. Historical raw-only Ari messages, WS B2,
media_stats failures and request-budget changes are outside this change.

## 1. Refuse accidental production downgrades

- Keep the guard in the canonical deploy script, common to full, dist-only,
  auto and pull modes. Require a clean, identifiable candidate checkout and
  no untracked release inputs (generalize the existing pull validation).
- After acquiring the remote deploy lock, before image build/tagging, release
  writes, migrations or quiesce, inspect the images of the existing API,
  worker and scheduler containers. Include stopped containers. Read their
  agency-hub.source-revision labels; never substitute the mutable release tag.
- Resolve candidate and every runtime label to unambiguous local Git commits.
  Fail closed on missing labels/objects, dirty labels, malformed values,
  partial role inventory or SSH/Docker errors. Error messages ask to fetch
  missing history, not to bypass the guard. A genuinely empty first deployment
  is a separate valid inventory result.
- Normal deploy requires each deployed commit to be an ancestor of or equal
  to the candidate. This handles a mixed-version stack conservatively. Check
  under the lock again before migration/quiesce to detect external replacement.
- Explicit CLI-only --replace-deployed <12-hex> must match every deployed
  role label and permits an intentional rollback or replacement of a divergent
  release. The comparison is repeated under the lock before quiesce. Unknown
  labels, missing Git history and dirty candidates still fail closed. Add
  --source-dir so the current driver can deploy an older clean checkout.
  The production-pinned CLI helper must resolve that same source checkout.
  Log source and target revisions; retain all migration and health guards.
  Automatic rollback after a failed promotion retains its current behavior.
- Validate the candidate checkout again after building and before release
  publication. Do not label changed files as a clean old commit.
- Document that code predating this guard cannot enforce it and must not be
  used as the deployment driver. Root access or an obsolete script can bypass
  a client-side guard; do not claim otherwise. Intentional rollbacks must use
  an up-to-date deployment driver (review the simplest supported invocation).
- Behavioral tests use tiny real Git DAGs and stubbed remote inventory: newer,
  equal, older, divergent, unresolved, dirty, mixed roles, stopped roles, empty
  inventory, partial inventory, remote errors, explicit rollback and changed
  checkout. Assert guard wiring precedes any production mutation.

## 2. Alternate bounded reconciliation and live DM chunks

- Include followers_reconcile, dm_conversations and dm_messages in the
  Fansly fairness group. Fable correctly identified that dm_messages also
  owns the B1 WS hint step. Production run 815253 (2026-09-22 00:57:32 UTC)
  confirms event-sourced dm_messages ran after reconciliation; dm_conversations
  did not start until 00:58:41. Keeping either DM stream outside the group
  would preserve a starvation path. Fairness therefore also serves ordinary
  message-history chunks under the existing request and time limits.
- For runnable background dispatches (scheduled/event/recovery/anomaly), give
  the competing streams the group's maximum existing priority, and select
  the least recently started one. Never-started work sorts first. On equal timestamps retain existing
  priority, requested_at and stream-order tie breakers within the group. Unrelated
  equal-priority work wins over previously started group members; a lone
  member retains its own priority and original ordering. Manual/onboarding/reset
  dispatches retain their explicit priority until the existing yield demotion.
- Compute this inside acquirePageSyncLease after the existing eligibility
  filters, using the durable page_sync_states.started_at value. No new queue,
  schema, timer, increased request limit or in-memory rotation state. Stamp
  starts using PostgreSQL clock_timestamp so worker clock skew cannot invert
  the service order. A failed/reclaimed attempt counts as a turn; retry gates
  remain authoritative. Existing leases/fencing/CAS and page execution lock
  are unchanged. Cross-page FIFO and reported original priorities are unchanged.
- A single runnable member runs immediately. Blocked, paused, leased,
  future-retry or inactive-page work cannot participate or suppress runnable
  work. Explicit higher-priority work keeps precedence. Other platforms and
  streams keep their own priorities. A mixed-source group lends its highest
  background priority to its least recently served member; this can put a
  scheduled DM chunk ahead of scheduled subscribers during anomaly recovery.
  Manual/onboarding/reset priorities remain above the group.
- Integration regression: repeat bounded yields for the three streams and
  assert alternation plus unchanged cursor/progress and unapplied generation;
  test mixed background sources, a new manual request, unavailable peer,
  unrelated higher-priority stream, only one peer, worker clock skew/restart,
  and existing lease fencing. No artificial sleeps for queue fairness.

## Delivery and acceptance

Review and revise this plan through actual claude-fable-5-1 before code. Run
focused deploy behavior tests, real PostgreSQL sync tests, pnpm check, then
Fable code review and follow-up as needed. Open a draft PR, finish review/CI,
merge, deploy the merged revision, verify all role labels and health. Observe
natural DM/reconciliation run ordering; report if no simultaneous runnable
work occurs during the observation window instead of claiming live proof.

No live Fansly writes or synthetic events are necessary for verification.

## Review disposition

Accepted Fable recommendations: exact-current replacement instead of ancestor-only
rollback, separate source directory, stopped-container inventory, shared
checkout validation and one windowed fairness ordering. Verified the DM lane
against production and corrected the scope to all three competing streams.
The read-only review is saved next to this plan. No decision/session logs are
added because their cleanup is underway in the shared root.
