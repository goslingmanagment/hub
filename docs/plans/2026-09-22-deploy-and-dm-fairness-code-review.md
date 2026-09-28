# Fable code review

Model: claude-fable-5-1. Successful; 34 turns; no permission denials.

No blocking findings. Both parts match the plan and the production evidence, the guard sits under the remote lock before any image tagging, and the fairness SQL does what the plan describes. Below are the actionable items, ordered by severity, then test gaps.

**Findings**

- **Medium, `docs/runbooks/production-deploy.md`.** The file is gitignored: `.gitignore:27-28` ignores `docs/runbooks/*` except the allowlisted names, and git status shows it neither modified nor untracked. It will not land in the PR unless it is added with `git add -f` and allowlisted like the other runbooks. Nothing links to it either, so add a pointer from the deploy script usage text or CLAUDE.md.

- **Medium, `scripts/deploy-production.sh:725`.** `compose ps -a -q <service>` also lists one-off containers created by `compose run`, and this deploy runs `run --rm --no-deps api` in the same project at lines 1709 and 1756. A `--rm` container orphaned by an interrupted deploy shows up as an extra `api` line with the abandoned candidate's label. A later normal deploy of any commit not containing that candidate fails as "stale or divergent", and `--replace-deployed` can never match both labels. Either filter on the `com.docker.compose.oneoff=False` label or name the offending container in the refusal so the operator knows what to remove.

- **Medium, `tests/page-sync-dm-fairness.integration.test.ts:79-86`.** The "event-sourced B1 lane" test never produces an event dispatch. `requestPageSync` with source `event` returns early unless dm_messages is idle with no pending generation (`page-sync.ts:3144-3145`), and the `beforeEach` already queued a scheduled generation, so the call is a no-op and the lease at line 84 is scheduled priority 25. The scenario that run 815253 motivated is untested. Settle dm_messages first, then request the event and assert the lease has `dispatchSource: "event"` and the `fanslyWsHintOnly` payload.

- **Low, `packages/db/src/repositories/page-sync.ts:2123`.** The started_at key is NULL for every non-group row, so at an equal effective priority a non-group stream sorts ahead of any started group member regardless of requested_at. This is reachable only in a mixed-source group (recovery dm_conversations at 40 lifts scheduled reconcile to 40 against scheduled subscribers at 40). The plan says existing tie-breakers are retained. A `row_number()` rank within the group, used as the second key, would keep non-group ties on priority and requested_at.

- **Low, `scripts/deploy-production.sh:751-752`.** The deployed label must resolve locally even with `--replace-deployed`, so a label that exists in no fetchable history (the 3803263 case in the review) has no driver path, and the message "fetch its Git history first" cannot be followed. This matches the plan's fail-closed rule, but the runbook should say it plainly instead of implying a fetch always works.

- **Low, behaviour to watch.** With no reconcile pending, dm_conversations and scheduled dm_messages history chunks now alternate one for one at effective priority 30. Before, the live lane always went first. A page with a deep history backlog now waits one full history chunk per live poll. The plan accepts this, but the observation window should include such a page.

**Test gaps**

- Deploy guard fixture `inventory()` always emits one line per role. Add a case with two containers for one role carrying different labels, and one with a fourth field, to cover the multi-container parsing and the malformed-line branch.
- `tests/compose-config.test.ts:212` only asserts `validate_source_checkout` exists. Assert its three positions: after metadata initialisation and before build, after build, and before the candidate `docker tag` promotion.
- No test covers `--replace-deployed` CLI parsing (regex, no env equivalent) or `--source-dir` driving `ROOT_DIR` and the `HUB_CLI_SOURCE_DIR` hand-off at line 1517; the existing string assertion at `compose-config.test.ts:269` passes without the env prefix.
- Fairness: no test that a manual group member does not lend its priority to peers (manual dm_messages 65 plus scheduled reconcile 34 plus scheduled subscribers 40 should order dm_messages, subscribers, reconcile). No test for the plan's stated consequence that a mixed-source group lifts a scheduled DM chunk over an unrelated scheduled stream (recovery reconcile 44, scheduled dm_conversations 30, scheduled followers 35).

## Disposition

- Runbook was force-added before review completed; also added its allowlist and
  linked it in script usage.
- Excluded one-off Compose containers. Added a test executing the actual remote
  shell against a local Docker stub, including an orphan migration container.
- Corrected the event test to settle the scheduled generation first and assert
  the actual event lease and fanslyWsHintOnly payload.
- Retained the narrow tie policy: unrelated equal-priority work wins over a
  previously started fairness group. Documented and tested this explicitly.
- Documented that an unrecoverable Git object cannot be bypassed by replacement.
- Added multi-container/malformed inventory, CLI parsing/source selection, three
  validation positions, manual boost isolation and mixed-source priority tests.
- History/live alternation is intentional and remains under existing chunk
  budgets. Production observation must distinguish this from latency guarantees.
