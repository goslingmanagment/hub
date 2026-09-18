# Combined canonicalization integration sanity review

**APPROVE — no integration blockers.** Reviewed the frozen staged replay change in `/Users/dmitriy/code/goose/.worktrees/hub-performance-fixes-20260912` over HEAD `5d0475e290cc6b7da465aa6f83b17db07a4aea00` (unmapped batching, with earnings single-parse already integrated). Scope is only those three canonicalization changes and Decision 311; my separately authored preview/DM-comment changes were excluded.

- The allocator/query portion is byte-identical to the approved replay author source. Borrowing runs once after both reserved turns, consumes only remaining nonempty pages under the original deadline, resumes the existing cursor and excludes wrapped/EOF traversal. The outer loop correctly destructures `budgetExhausted`; page-end CAS and turn-marker behavior survived integration.
- The complete batch filter, shared account resolver and run binding-map construction are byte-identical to committed batching. Eligible candidates still cannot append under the same immutable map used downstream; mapped/export/ambiguous rows retain individual reads. A resolver is created within each selected page, so no prefetched payload crosses a page or borrowed pass.
- The entire row-processing block is byte-identical to committed batching plus earnings. Payload resolution still happens before the optional prepared parse. Accepted earnings drafts reuse that result; rejection diagnostics do not rerun the parser. Legacy families keep their prior branch. Binding checks, dry-run, zero-draft stamp, partition/erasure guards, append/checkpoint and failure outcomes remain in their original order.
- Current registry scopes remain compatible: earnings and sync-pull opt into split traversal; webhook uses the bounded body resolver without opting into split passes. Decision 311 accurately describes the final allocator and its evidence limits.

The working driver equals its staged version. Both diff checks pass, and the two staged replay test files match the previously approved final hashes. I performed only source/static comparisons and wrote this report; no suite, DB or production operation was launched. Root's combined `pnpm check` and integration gates are still required for release; this report does not claim their completion.

Approved identity:

| Item | SHA-256 |
| --- | --- |
| Complete staged patch, including Decision 311 | `a662edc750537b38e765fb4b79f29bfe1d864646b404415734b1a24f37b41a72` |
| Combined `canonicalize-driver.ts` | `27b0a7eee47f25d503f23953efd9d2d401cf7f040272d54e63ffbcf0d8f83e32` |
| `payload-reader.ts` | `0410a027e11e010f15c22f3b389c976e9726b58b6c0a049d78509ba5e7aa3db3` |
| `canonicalize/index.ts` | `e5fce8283a7c6f02eb63142fc4b56b52502f1f1ded56adfd1b67d4875afbbccd` |
| `canonicalize-budget.test.ts` | `122fcd1ba163d020307116962d925f4e4c1ab2c7bdafde77e811dbc099f636c9` |
| `canonicalize-pass-partition.integration.test.ts` | `ab61ff4dc8e4328baec146d797ee999eec2a08c99119f2b79bba447da201991d` |

Reviewer: `/root/fix_preview_scope`, not an author of these three fixes.
