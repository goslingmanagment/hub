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

## Exact first-enable evidence and monotonic capability

The first Core image that advertises `desktop-lifecycle-v2` embeds a versioned
evidence manifest. It pins the exact Extension release tag, source tree, proof
blobs, CI run and served XPI hashes; the exact Desktop source tree,
cross-platform CI, non-publishing Windows candidate run, uploaded artifact
digest and extracted file hashes; and a non-empty inventory of preserved
Desktop machine UUIDs bound to exact active chatter device-token rows.

Before stack replacement, `scripts/deploy-production.sh` reads that manifest
from the built candidate image and first matches its bytes against the immutable
SHA-256 approved in the deploy script. The local verifier pins `github.com` plus
the exact trusted repositories, checks the immutable GitHub objects and runs,
the live Extension feed/XPI, and the unexpired Desktop Actions artifact. It also
hashes and inspects the private Extension persona export, Desktop persona export,
and Desktop diagnostics files supplied through the three `*-receipt` deploy
arguments. Those private files stay on the operator machine and are not copied
into the image or production host.

A candidate-image command then checks the inventory read-only against the
production database. The inventory check is repeated at the last safe point
before image promotion. That records the exact active binding as a cutover
precondition and keeps the observation-to-promotion window small; it is not a
lock. An owner can still revoke or transfer the token after the check. Such a
later access change must block that machine's harvest/Desktop publication, but
it does not retract the monotonic protocol capability after Core advertises it.
There is no environment acknowledgement, operator status string, or
completion-file bypass.

The deploy gate implements four transitions:

- absent to absent: ordinary additive Core deployment;
- absent to present: full external evidence and production inventory checks;
- present to present: monotonic continuation without depending forever on an
  expired one-time artifact or harvest token;
- present to absent: rejected as a capability regression.

For absent to present, automatic image rollback is disabled before stack
recreation. Once the capability may have been observed by a client, recovery is
roll-forward only. After API health reaches 200, the deploy also verifies that
the served health capability matches the candidate image.

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
