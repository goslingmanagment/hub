# A0 head regression fixtures

Prepared on `test/fansly-a0-head-regressions` in the existing A0 worktree, from
main `e913b7a6056d991d5cd657789a834b435d86aeaa`. The tracked tree was clean before
branch creation; existing untracked evidence was preserved. Decision 320
records this narrow follow-up. No new flag requires a runbook change.

The real-sweep suite now checks three heads below an established virtual
stop: an old incoming message, an old outgoing message, and a non-null head
whose timestamp moves backward. Each case crosses a chunk boundary, reads the
durable report after application, checks the stored head and requires the
same four list requests without hydration.

The corpus suite now checks a synthetic three-sweep dangling-pointer clearing.
An unchanged null pointer supplies the negative control. The transition is
counted once, no timestamp/sender transition is fabricated, and unavailable
material remains unknown. This preserves the shape seen in the retained
Lora-1 investigation, without real identifiers or private payloads.

Existing tests already cover the mutable-offset blind spot, strict timestamp
boundary comparison, invalid markers, rejected generations, diagnostic failures,
flag rollback, scalar resume and a two-hour outage. The additions do not turn
those observations into a safe-stop proof or repair provider-deleted heads.

Validation completed on 13 September 2026:

- `pnpm check`: 3,366 tests passed in 300 unit files, nine existing skips;
  strictness, lint and dashboard build passed. The new corpus case ran here.
- Serial Docker-Postgres: 26 tests passed in two suites, zero skips, 9.70 s.
  Command: `pnpm exec vitest run --no-file-parallelism
  tests/fansly-dm-shadow.integration.test.ts
  tests/fansly-dm-conversations-sweep.integration.test.ts`.
  Both consumers of the changed helper and all three new handler cases ran.
- Independent correctness and readability review found no actionable issues.
  A separate independent correctness review also found no actionable issues.

Log hashes and source hashes are retained in `evidence/validation.json`.
No new flag requires a runbook change. The test change itself needed no
production query or mutation. A separate authenticated UI read at
01:00:36–41 UTC confirmed the existing A0 six-page and C2b lilly-1 values;
it did not reveal config versions or per-role application receipts.
No new savings, latency or A1 acceptance is claimed.
