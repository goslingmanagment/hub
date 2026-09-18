# Independent W0 composition review on main 4ecbfc83

Reviewed on 2026-09-14 by `/root/review_w0_runner`: no findings. This is a
read-only Git/source composition review; no tests, branch changes, provider
requests or production actions were performed. Fresh CI remains required.

| Input | Exact identity |
| --- | --- |
| Previous W0 head | `8ad930c5b169e85d805b33d3680710bf3325d31f` |
| Incoming main | `4ecbfc839fa47a5951d785f374774e4fa9942ba7` |
| Common base | `ce0a44b0d6778f8bd371c105f26d31f9abe8b8bd` |
| Reviewed merge commit | `3f5894565d83260908e8e336e94c379232460180` |
| Reviewed tree | `bedba486d2a79944f835d06acb00a8aac8a345f2` |

Compared all 2,296 paths and file modes across the base, both parents and the
merge. Except for the deliberate decision insertion, the complete tree is the
exact union of its parents, with no overlapping edits or unexpected changes.
All 34 W0 source, configuration, script, test and test-fixture paths are
byte-identical to the previous W0 head. All six incoming main runtime/database
and test paths are byte-identical to main. Topic runbook and retained research
and evidence paths are preserved as part of the same whole-tree check.

The exact Decision 325 body and reference row precede Decision 326. Removing
these two insertions recovers the entire main decisions file byte-for-byte,
including Decisions 326, 327 and 330. No main text was rewritten to resolve the
append-only conflict.

## WebSocket lint interaction

The W0 lint configuration is unchanged (SHA-256
`bdbf7669f551fa84ab1d2fb17d052937db96ee0a1dc7904b335e5396de99d09a`).
Its WebSocket restrictions apply to four incoming files:

- `apps/runtime/src/services/sync/executor-handlers.ts`
- `apps/runtime/src/services/sync/fansly-dm-conversations.ts`
- `packages/db/src/repositories/fansly-dm-head-debt.ts`
- `packages/db/src/repositories/page-dm.ts`

None contains a `WebSocket` identifier or a `ws`/`undici` import specifier;
the added history-selection branches do not create a WebSocket rule conflict.
The two incoming integration tests are outside that additional rule's file
globs. The global money and existing HTTP restrictions are unchanged. The
incoming code does not change platform branches or the transport resolver.

The CI workflow exactly matches main, including the 4 GiB static-check budget
(SHA-256 `3f8b9318fabb991f1ec5c37952c2dd1d24b35b6e1eb92c223c15d3b5b27b905f`).
This static review does not substitute for the new head's required CI run or
claim any new live W0 coverage.
