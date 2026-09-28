# Fable follow-up review

Model: claude-fable-5-1. Successful; one turn; no permission denials.

No blocking findings. The follow-up diff resolves each item in the disposition, and I found no new correctness defect.

**Verified against the findings**

- **Runbook tracking.** The allowlist entry and the usage pointer are in place, so the file lands with the PR.
- **One-off container exclusion.** The remote loop inspects each container's image and oneoff label in one call, skips oneoff containers, and only prints "absent" when no real container remained. Quoting survives the outer double-quoted string. The probe test runs the generated remote shell against a stub, so the escaping is exercised, not just asserted as text.
- **Event lane test.** Settling dm_messages before the event request means the lease now carries the event source and the WS-hint payload. The test asserts both.
- **Tie policy.** Kept as designed and pinned by the mixed-source tie test. Fine as a deliberate choice.
- **Unrecoverable label.** The runbook now says replacement cannot bypass it.
- **Test gaps.** Multi-container, malformed fourth field, three validation positions, CLI parsing with the env-only negative case, manual boost isolation and recovery lending are all covered.

**Two non-blocking notes**

- **Comment precision in page-sync.ts.** "Unrelated work wins an equal-priority tie" holds only once a group member has started. If no peer has started, both sides have a NULL start key and the tie falls to requested_at. Consider adding "once the group has started" to the comment so the next reader does not expect the rule in the not-yet-started case.
- **Yield source in the event test.** The event lease is yielded with a scheduled dispatch source. If yield uses that value to requeue the state, the assertion afterwards passes for a scheduled follow-up rather than an event one. That does not weaken what the test proves about the lane, but yielding with "event" would be the more faithful shape.

Everything else in the diff is consistent with the plan and the prior review.

Disposition: clarified the comment about already-started peers. Kept the
event-test yield as scheduled because the production executor consumes the
event dispatch boost on continuation in the same way. No behavior changed.
