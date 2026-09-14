# Preserve provider cooldown while queueing new work

A queued request used to erase a future provider retry deadline in two orders:
request after retry settlement, or request while a lease was still running and
then a provider failure. The latest revision now remains queued behind the
existing deadline. The actual DM sweep follow-up is covered by a regression.

The shared queue guard covers `rate_limit` and `provider_5xx` on Fansly and OFAPI,
including their local ladder because persisted state has no header-provenance
field. Ordinary transport/yield and expired-provider supersession remain.
No request is dropped: source, payload and newest revision survive, and ordinary
or targeted dispatch can resume at the deadline.

A Fansly 429/5xx deadline more than 30 minutes away opens the existing incident
on the first failure and includes the deadline. The title no longer claims
three failures on a forced first-failure path. Keys, deduplication and recovery
are unchanged. Decision 275 remains: max(provider deadline, local backoff),
never a cap that retries before the provider permits it.

## Validation

Final candidate integrates main `478fca4220d3d07d61a9200d1860316e770cb4fe`.
The original six-file patch merged cleanly over the deployed performance fixes;
independent review verified that its added/removed behavioral lines are identical.
Decision 322, error-handling guidance and the cooldown runbook describe scope.

- `pnpm check`: exit 0, 304 unit files, 3,420 tests passed, nine existing skips;
  typecheck, lint and dashboard build passed.
- Five serial Docker-Postgres suites: exit 0, 64 tests, no skips. Docker absence
  is fatal (`ALLOW_MISSING_TEST_PREREQUISITES=0`).
- Nine new Postgres cases cover both queue/retry orders, latest request metadata,
  pre-deadline ordinary/targeted refusal, resumption and completion at the exact
  deadline, unchanged ordinary supersession and a real DM sweep follow-up.
- Six executor cases cover 429/503, the strict 30-minute alert boundary and a
  24-hour unchanged deadline. The notification suite covers delivery/recovery.
- [Independent review](REVIEW.md) and merged-base/docs follow-up: no open findings.

Final commands, UTC times, full compressed logs and hashes are in
[final-validation](final-validation/). The prior run and its fixture setup
failure remain in `validation-20260913T235518Z/`; they are not substituted for
final-candidate validation. The final run also includes the neutral-title fix.

No production query, deployment, flag change or provider request was needed
for this patch. This is a regression fix, not a measurement of savings or reader
latency. Existing deployment approval and A0/C1/W0 stage gates still apply.
