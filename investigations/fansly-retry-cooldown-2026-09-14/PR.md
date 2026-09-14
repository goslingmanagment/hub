A new sync request could erase a future provider retry deadline, both after retry settlement and while the failed lease was still running. The latest request now remains queued behind that deadline, preserving its revision, source and payload. Ordinary transport/yield and expired-provider supersession are unchanged.

The shared queue guard protects `rate_limit` and `provider_5xx` on Fansly and OFAPI, including their local ladder: the stored row has no separate header-provenance field. A Fansly 429/5xx deadline more than 30 minutes away opens the existing incident immediately and includes its retry time. **The provider deadline is preserved, including a 24-hour Retry-After.** Decision 275's `max(provider, ladder)` remains in force. Incident keys, deduplication and recovery are unchanged; the title is truthful for a first-failure alert.

Decision 322 and the cooldown runbook document the behavior. No flag or migration is added. The patch integrates main `478fca42` and preserves #183's performance fixes.

Validation:

- `pnpm check`: 3,420 tests passed, nine existing skips, 304 files; typecheck, lint and build passed.
- Five serial Docker-Postgres suites: 64/64 passed with missing prerequisites fatal. Nine new cases cover both races, latest request metadata, ordinary/targeted admission before and at the deadline, and the actual DM follow-up.
- Executor tests cover 429/503, the strict 30-minute boundary and unchanged 24-hour deadlines; notification integration covers forced delivery and recovery.
- Independent correctness/readability review plus merged-base/documentation follow-up: no open findings.

[Report, full commands, test receipts and review](https://github.com/goslingmanagment/core/blob/fix/fansly-retry-cooldown/investigations/fansly-retry-cooldown-2026-09-14/REPORT.md).

No production operation or provider request was performed. No savings, latency or stage-acceptance claim follows from this fix.
