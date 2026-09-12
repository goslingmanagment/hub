# A0 reason coverage follow-up

A0 records a generic state-change count but previously retained no separate
counts for six of the eleven head-diff reasons. That prevents attributing
eleven retained raw-unchanged observations through 12 September 18:37 UTC to a
reason category. The original
pre-apply rows are unavailable; this follow-up cannot reconstruct them.

The patch adds bounded nullable scalars for visibility, unresolved identity,
exclusion reason, subscription tier, effective head timestamp and sender.
Measurement from the start of a runtime sweep starts at zero. Starting midway
through a sweep leaves the new counts unknown. Legacy checkpoints preserve missing counts
as null through completion; a completed sweep is not complete reason coverage.
The two unread reasons still count one conversation, and the generic,
rollback, material and stop predicates keep their prior semantics.

The offline analyzer leaves its three unavailable runtime-only categories
null. Tier/time/sender there describe retained metadata differences, not the
effective values compared by the runtime writer. Existing JSON storage/read
functions preserve these fields; no migration, flag or provider request is added.

The original A0 branch is reused in worktree `hub-fansly-a0-shadow`. Merge
`52c910ea` preserves the original branch history and exactly adopts main
`c76c6db0`'s tree after PR164's earlier squash merge. Decision 313 follows
main's 295, deployed 296–300, performance reservations 301–311 and C2a's
unpublished 312. Recheck reservations before publication.

The [validation receipt](evidence/validation.json) records the final tested
tree `0763c732`:

- `pnpm check`: 3,261 unit tests in 296 files passed, nine existing skips.
  Strictness remains 1,901 known errors in 121 files; lint and build passed.
- Serial real Docker-Postgres: 34 tests in four files passed, zero skips,
  10.56 seconds. The suites cover shadow/full-sweep parity, pre-apply reason
  persistence through the real writer, legacy/late-start unknown counts,
  measurement reads and page erasure.
- Independent correctness and quality re-reviews closed two P2 findings:
  late-created diagnostics initially invented zeros for an unobserved prefix,
  and a new fixture incorrectly addressed metadata values as physical columns.
  Both are fixed and covered by the final checks. The earlier failed PG run
  remains retained as historical evidence.

The three changed implementation/tool modules are 114, 130 and 165 lines.
After this tested tree, only documentation and evidence are updated.

On 12 September the owner explicitly approved the additional A0 PR and
deployment ("да все разрешаю"). PR164 is already merged; this approval
permits the follow-up on the same A0 branch and worktree.
No new PR or deployment has run yet. A future release must preserve the current
production ancestry and all applied migrations. It must not deploy this
main-based branch as a replacement for unrelated production changes.

Historical A0 gaps and unexplained observations remain. No A1 acceptance,
physical savings or fresh-event latency is claimed. The original shadow start
and its calendar gate are unchanged; the usable reason-coverage window starts
with new runtime sweeps after this code is deployed.
