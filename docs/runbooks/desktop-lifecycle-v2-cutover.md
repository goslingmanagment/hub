# Desktop lifecycle v2 production cutover

This is a one-way Core-first cutover. It introduces device-token reserve/activate
custody, owner-bound harvest capability, the read-only persona catalog, and v2
snapshot/cursor contracts. Do not publish the corresponding Desktop until this
runbook is complete.

## Preconditions

1. Record every Desktop machine UUID that still has local data to harvest. Use
   the UUID shown by that machine's current diagnostics/manifest; do not infer or
   regenerate it. Record the owning username and active device-token row for each
   UUID. If no machine needs the one-time harvest, record that fact explicitly.
2. Prepare Desktop and Fansly Extension builds that, before their first persona
   network read, preserve the complete legacy local persona/mapping state in an
   immutable local snapshot with an operator-accessible JSON export. Both builds
   must consume the metadata-only catalog, keep account mappings local, represent
   archived/missing keys as unresolved instead of pruning them, and issue no
   persona definition writes. They must be ready to release as soon as the
   additive Core catalog is live. A build that merely hides the editor while old
   background sync still writes is not acceptable evidence.
3. Confirm that the release operator understands this is roll-forward-only once
   migrations start. The deploy script refuses an automatic image rollback when
   the schema changes. Do not manually restore the old Core image afterward: old
   Core cannot consume v3 cursors or newly enrolled pending-device credentials.
4. Reserve at least ten minutes for the `observations` index migration and ten
   minutes for owner bindings. Keep the owner dashboard session open. The
   deploy verifier permits up to twenty minutes for API health while startup
   holds the migration lock and builds that index; do not reduce this below the
   measured production migration window.

Migration 0096 is additionally run as a bounded candidate-image one-shot before
stack recreation, with the current API still serving. The deploy captures the
pre-migration schema baseline first and waits synchronously for the advisory
lock holder to exit; failure leaves the current stack running. Startup retains
the twenty-minute budget as crash/retry protection, but the normal deploy path
should find 0096 already recorded and reach health without the index-build gap.
Before the one-shot starts, local pending migrations through 0096 are compared
with that remote baseline. Any pending migration not on the explicit
rollback-compatible allowlist sets a rollback-forbidden latch immediately, so
an interrupted concurrent build can never trigger automatic image rollback
while its schema ledger row is still absent.

## Current capability and client-release block

The additive Core schema and compatibility routes may be deployed normally;
blocking every Core or emergency release would make unrelated fixes impossible.
`/api/v1/health` deliberately does not advertise `desktop-lifecycle-v2`, so the
Desktop publication gate remains closed. There is no environment-variable
acknowledgement or completion-marker bypass for capability enablement.
Before replacing the stack, the deploy script interrogates the built candidate
image itself. A candidate that advertises `desktop-lifecycle-v2` is rejected;
the current branch deliberately has no evidence-bypass input. The later cutover
change must replace that fail-closed branch with verification of owner-approved,
exact client artifacts and their preservation/read-only test evidence.

Before enabling the capability, land and build both preservation-first read-only
client changes above. The eventual deploy change must verify the exact Desktop
and Extension release artifacts plus automated tests proving snapshot-before-read,
export completeness, catalog-only steady state, and absence of persona writes;
an operator-entered status string is not evidence. It must also restore the
explicit machine UUID inventory and verify that every required UUID is bound to
a non-revoked, unexpired device token before the capability is advertised.

Only a later owner-gated release that performs all of those checks may return
`desktop-lifecycle-v2` from health. Do not add the capability merely because the
Core schema/routes exist.

## Complete the fleet cutover

1. Release the prepared read-only Extension and verify that an existing profile
   creates its immutable legacy snapshot before the first catalog request, its
   JSON export contains full persona text plus mappings, archived/missing keys
   remain unresolved, and no persona PUT/DELETE is emitted.
2. Confirm `GET /api/v1/health` advertises `desktop-lifecycle-v2` only after the
   exact client-artifact checks and harvest inventory checks pass.
3. Confirm each inventoried Desktop uploads its harvest successfully and no
   machine remains in terminal 401/403 retry state.
4. Only then tag/publish Desktop. The Windows publication workflow independently
   checks the production Core capability and fails on an old Core.
5. Verify one new Desktop enrollment, sign-out/re-enrollment, v2 snapshot
   recovery, persona JSON export, unresolved archived mapping, and absence of
   persona definition writes from both clients.

Legacy bearer persona PUT/DELETE routes stay available during this cutover for
already-shipped clients. Closing them is a separate owner-gated release after
preservation/read-only fleet coverage is demonstrated; do not fold that auth
change into this lifecycle deployment.

## Failure policy

- Before stack recreation, fix the prerequisite and rerun; release files are
  restored automatically.
- After migrations begin, diagnose and roll forward. Do not use the old Core
  image as a recovery shortcut.
- If owner binding cannot be completed, leave Desktop unpublished, repair the
  binding or token, and rerun this deploy. The runtime capability stays absent
  and the Desktop publication gate stays closed; there is no completion-marker
  bypass.
