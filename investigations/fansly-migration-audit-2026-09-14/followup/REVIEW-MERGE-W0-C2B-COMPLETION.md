# Independent W0, C2b and earnings-completion composition review

Reviewed on 2026-09-14 by `/root/review_w0_runner`: no actionable findings.
The W0/C2b tree preserves both topics exactly. PR 192 has disjoint code changes
and composes cleanly through the two shared documentation files. This review
does not waive fresh successful CI for any published head.

| Input | Exact identity |
| --- | --- |
| Common main | `4ecbfc839fa47a5951d785f374774e4fa9942ba7` |
| PR 190, C2b | `e87eab760f608aeaba3cd53cad5b16123623979a` |
| PR 167, W0 | `82fb9638111882d509c1f4f71e35c58353dd88a1` |
| Prospective W0 + C2b tree | `d59ed3121969cdfa48d7bd4690819691148581be` |
| PR 192, completion settlement | `b6349638d2f5b289d9b342be7a2403ea123a06d2` |

## Preservation and composition

Compared all 2,320 paths and file modes across main, W0, C2b and the supplied
combined tree. Every path except the combined decisions file matches its
supplying parent exactly. All 34 W0 and five C2b source/configuration/test paths
and all 11 topic review files are retained. The full-tree comparison also
preserves main's source, documentation and earlier reviews.

The exact D325 body/reference row precedes D326; the exact D328 body/reference
row precedes D330. Removing just the W0/C2b additions recovers the complete main
decisions file byte-for-byte. Main's D326, D327 and D330 remain unchanged.

PR 192 adds one runtime change in `fan-earnings.ts` and its separate regression
suite. Neither path overlaps W0 or C2b. Its combined path set contains 2,347
paths. The only shared changes are `docs/decisions.md` and
`docs/runbooks/fansly-earnings-shadow.md`. Three-way text merges of both files
against the exact common main succeed without conflicts; removing the retained
topic insertions recovers their original main bytes. The final decision order
is D325 → D326 → D327 → D328 → D330 → D331.

The synthetic three-topic documentation hashes are:

| File | SHA-256 |
| --- | --- |
| `docs/decisions.md` | `4485f5e1a0f79885e2f449ac077824825f67dcc3057d01adc21897e40e0dab6d` |
| `docs/runbooks/fansly-earnings-shadow.md` | `ec338913381af7b6a8ed95d5dce69bfa7c7ff8fa6a6ceb62e293894d266ea080` |

These hashes describe temporary text-merge results, not a committed three-topic
Git tree. No branch or index was modified by this review.

## Runtime interaction and code quality

- W0's shared page-context change extracts the existing modern/legacy Fansly
  credential decoder. The OnlyFans return remains before that decoder; normal
  Fansly earnings retains its session, proxy and egress key. Resolver parameter
  changes only narrow the required TypeScript fields. Probe snapshot isolation
  and its temporary database connection belong to the diagnostic path; they do
  not put normal earnings capture or settlement into a read-only transaction.
- C2b renews and settles the original receipt token/revision inside one owned
  transaction after raw capture. PR 192's new return occurs only for an already
  completed checkpoint belonging to the leased generation. That return makes
  no endpoint call and does not renew, settle, clear or conceal receipt debt.
  Normal and newer-generation walks still call the same C2b capture helper.
  An endpoint-capture or receipt-settlement exception prevents the handler's
  full-walk checkpoint write. Queue settlement can still fail after that write;
  PR 192 handles precisely that later boundary. Existing missing-receipt debt
  remains a reported limitation.
- The additional W0 WebSocket lint rules cover the two C2b source files and
  `fan-earnings.ts`. None contains a WebSocket identifier or a `ws`/`undici`
  specifier. There is no new lint-rule interaction or import cycle.
- The code keeps the existing abstractions: one small receipt-settlement
  helper, one guarded completion return, and focused W0 diagnostic modules.
  Across newly added TypeScript, JavaScript-module and Python source/test
  files, the largest is 275 lines and the longest line is 139 characters.
  No touched topic source file contains a line of 2,000 or more characters.
  The composition introduces no new framework, runtime flag or large combined
  module.

The completion test's final per-case logical clock change is compatible with
the reviewed eight scenarios. Its current SHA-256 is
`764673a9defb2ad8b75cc844b6e06478555c83bf9dc69b2ee4c2a96eaa235bdf`.
The prior fixed-clock expiry finding was withdrawn correctly: real lease expiry
is based on PostgreSQL's clock. This review does not revive that claim.

## Runtime fingerprints and validation limits

| File | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/sync/fan-earnings-capture.ts` | `fdb8e3e77c160b1f92a9a89931439423643f06e5e737962cbb51c893cb2fdb23` |
| `packages/db/src/repositories/fan-earnings-refresh.ts` | `f4a13cc207bbf8fcb462125a37d6ce10f9016b9529ed39bd4a9af786afb54066` |
| `apps/runtime/src/services/sync/fan-earnings.ts` | `0cfa7c51a5934adb1b5ab01a4bb5d78fa425180cc7fc75690495988d6a37fe0d` |

No tests, CI retries, provider calls or production actions were performed by
this reviewer. The review verifies composition and readable implementation;
it establishes neither production savings nor live event coverage, account
binding, C2c acceptance or permission to deploy.
