# Independent Retry-After review — 14 September 2026

**No actionable correctness or readability findings in the reviewed candidate.**
This is a static review by the independent reviewer, not the implementation or
test runner. No tests, production reads, provider calls or code edits were made.

The review covers the complete candidate diff against
`0a08365fbefa545397f4e91a2eae3fca7c36c444`: page-sync repository, sync executor,
notification title, and their three test files, including the untracked provider
cooldown integration suite. Exact identities are in
[review-source-hashes.json](review-source-hashes.json).

## Correctness

- **Both queue/retry orderings preserve the deadline.** A request arriving after
  retry settlement reads the locked row and keeps a future provider cooldown.
  A request arriving before settlement leaves the leased generation running;
  the finalizer's SQL now keeps retry state even when `request_seq` advanced.
  The existing lease token, leased sequence, running status and live lease
  guards still fence settlement. The finalizer does not replace the latest
  requested sequence, payload or source; its dispatch-source conditional keeps
  the newer request's priority source.
- **New work is queued without being acknowledged early.** `applied_seq` does
  not advance on retry. The new request payload carries the latest revision,
  and ordinary and targeted acquisition still check the deadline. The real
  DM sweep follow-up test exercises the original regression path.
- **The provider deadline remains uncapped.** Existing classification uses
  `max(provider Retry-After, local failure ladder)`; this patch does not shorten
  either operand or introduce another retry loop. A 24-hour deadline survives
  request supersession. An expired provider deadline can be superseded.
- **Alert boundary is correct.** `forceOpen` is added only for a Fansly 429/5xx
  retry deadline strictly more than 30 minutes beyond the same `failedAt`
  instant used for persistence. The local ladder caps at 30 minutes, so it
  cannot alone trigger this new branch. Exactly 30 minutes does not force the
  first alert; 30 minutes plus 1 ms does. The existing incident key, deduplication,
  proxy incident precedence and successful-recovery resolution are reused.
  The neutral title now truthfully covers both threshold and first-failure
  incidents; no new notification kind is introduced.

## Scope and quality

The DB helper is deliberately provider-neutral: **future `rate_limit` and
`provider_5xx` retry state is preserved for OFAPI as well as Fansly**, including
deadlines derived solely from the local backoff ladder. This is coherent with
the shared retry contract; it should be stated in the decision/PR instead of
claiming the whole change is Fansly-only. The first-failure long-deadline alert
is specifically limited to `FanslyApiError`. Transient transport, configuration,
collection-policy and other retry classes keep their prior supersession behavior.

The change stays small: one named predicate, one SQL condition reused across
the related retry fields, and one alert condition. It fits the existing locked
request path and fenced finalizer rather than adding a scheduler, queue or flag.
The tests check externally meaningful state transitions, deadline boundaries,
latest work selection and the real DM follow-up path. No migration or new flag
is required by these code changes.

Explicit reset/pause-resume and unrelated dependency/gate transitions are not
newly redesigned by this patch. This review approves the requested queue/retry
race fix; it does not claim that every administrative state transition globally
enforces provider cooldowns.

## Validation boundary

The retained earlier validation reports `pnpm check` passing with 3,372 unit
tests and nine existing skips, plus five serial Docker-Postgres suites passing
64 tests. Those receipts precede the final notification-title/assertion edit.
The coordinator must attach its refreshed checks for the final source/base;
this review makes no claim that the new title delta has already been executed
by this reviewer. The numbered decision and publication remain coordinator work.


## Follow-up after main merge and documentation — 14 September 2026

**No actionable findings after comparison against main `478fca42`.** Candidate
head is `644b56b6`; Decision 322 is correctly allocated after main's Decision
321. The six-file behavioral patch has identical added/removed lines to the
previously reviewed candidate; the merged performance changes are inherited
from main. No manual adaptation of the cooldown behavior occurred.

Decision 322, the error-handling paragraph and the new cooldown runbook agree
with the implementation: shared rate-limit/5xx queue protection includes OFAPI,
manual queueing retains the latest work without clearing cooldown, the provider
lower bound remains uncapped, and only the long Fansly cooldown forces the
existing first-failure incident. The runbook states that rollback preserves
stored data but reopens the early-retry race. It adds no flag, probe or production
approval and does not claim global protection across administrative resets.

[Follow-up source hashes](review-followup-source-hashes.json) bind the merged
source and reviewed documents. Final tests against this merged base remain the
coordinator's next gate; this reviewer ran no test or production operation.
