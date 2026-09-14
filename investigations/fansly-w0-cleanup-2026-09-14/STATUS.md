# W0 cleanup diagnostic correction — 14 September 2026

The shared operator launcher did not recognize Docker's lowercase absence
message. A completed identity preflight could therefore report cleanup failure
and the continuity launcher could stop before its scheduled gaps.

The correction matches one complete supported Docker absence message with the
exact name or immutable ID. Message casing is ignored; identity casing and
ownership remain strict. There is no provider retry, runtime flag or deployment.
D337 and the protocol runbook preserve the original receipt and require separate
absence evidence when an older launcher reports this condition.

## Validation

| Check | Result | Evidence |
| --- | --- | --- |
| pnpm check | 3821 passed, 9 skipped; 333 files | validation/pnpm-check-final.json |
| Typecheck/lint/dashboard build | Passed; 1897 existing type errors within ratchet, no new debt | validation/pnpm-check-final.log |
| Docker PostgreSQL context suite | 16 passed, no skips | validation/postgres.json |
| Offline Python launchers | 25 passed: short 10, continuity 11, binding 4 | REVIEW.md |
| Local Docker cleanup | Auto-removed and owned-created cases both confirmed absent | validation/docker-cleanup.json |
| Independent source/readability review | No actionable findings | REVIEW.md |

The first fullcheck inherited umask 077 from the private-log wrapper, changing
an existing public-file fixture to private permissions and causing one failure.
The final run used the ordinary child umask 022 with unchanged source. Both
execution records and the initial failure remain in private validation evidence.

## Production observation

The separate bounded Lilly-1 identity preflight returned HTTP 200, matching
account ID, and one GET at 20:09:41.786–20:09:42.189 UTC. Its original execution
had cleanup unconfirmed. Later read-only exact-name and run-label listings
both returned empty, confirming absence at 20:12:14.802 and 20:12:17.012 UTC.
A subsequent inspect showed the lowercase form reproduced by the new tests;
the original cleanup stderr was not retained. No provider retry was performed.

The private source evidence remains under the root checkout's investigation
`fansly-w0-continuity-2026-09-14/live-binding-20260914T200628Z`.
Ari-1 was selected and authenticated as itsaribae, viewing WetLillys. One native
presence baseline and Lilly's native HTTP 101 do not pass paired delivery,
presence effects, continuity, gap recovery, savings or reader latency.

## Next action and rollback

Use the corrected reviewed launcher modules together before the next approved
receiver. Preserve the successful identity receipt and later cleanup evidence.
No new owner decision is required for this correction. Stop the owned diagnostic
receiver to roll back an experiment; existing REST continues. Runtime services
need no deployment for this operator-only change. W0 and B0 remain gated by the
required live evidence; no socket or six-hour run was started by this correction.
