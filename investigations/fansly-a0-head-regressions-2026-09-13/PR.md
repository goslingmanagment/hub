# test(sync): cover A0 old heads and pointer clearing

A0's old incoming/outgoing and deletion test supplied reason labels directly,
leaving the real sweep's classification untested. Add Postgres cases that apply
old incoming/outgoing heads and a non-null timestamp rollback below the virtual
stop, then verify the persisted diagnostics, updated heads and exact requests.

A small synthetic three-sweep corpus also reproduces the retained Lora-1
shape: a dangling list pointer becomes absent/null and remains absent. It pins
one metadata transition, preserves unknown material and does not infer when
message content disappeared. No production identifiers or payloads are copied.

Decision 320 records the change. Application code, policy, provider calls,
flags, head-repair semantics and the original A0 calendar gate are unchanged.

Validation:

- `pnpm check`: **3,366 passed, nine existing skips, 300 unit files**;
  strictness, lint and dashboard build passed.
- Serial Docker-Postgres: **26 passed, zero skips, two suites, 9.70 s**.
  Command: `pnpm exec vitest run --no-file-parallelism
  tests/fansly-dm-shadow.integration.test.ts
  tests/fansly-dm-conversations-sweep.integration.test.ts`.
- Two independent reviews passed: correctness of the handler/corpus paths
  and code quality/readability. No actionable findings remained.

The new cases prove persisted classification across resume, applied head
fields, exact four-list-request behavior, and one-time counting of a cleared
pointer. They do not establish safe early stopping or HTTP savings. No
production deployment, flag change or repair accompanies this test PR.
