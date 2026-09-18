# DM shadow timeout rationale — independent review

**APPROVE.** No correctness, regression, architecture or wording blocker found. The replacement accurately describes diagnostic behavior and removes an unsupported causal claim about provider sweeps.

Reviewer: `/root/review_earnings_parse_fix`; this agent did not author the DM comment change.
Reviewed the staged change in `/Users/dmitriy/code/goose/.worktrees/hub-performance-fixes-20260912`, limited to `packages/db/src/repositories/fansly-dm-shadow.ts:57-60`, plus the author's proposed append-only decision correction in `dm_shadow_docs-author.md`.

## Independent findings

- The staged hunk replaces four standalone comment lines with four standalone comment lines. I independently compared HEAD and staged content after removing standalone `//` lines: all remaining bytes are identical. The worktree file also equals the staged file. The 5-second material read, separate 500-millisecond report write, SQL parameters/query, transaction boundaries and executable behavior are untouched. `git diff --cached --check` for this file passed.
- `services/sync/dm-shadow-material.ts:9-14` catches a failed material read and returns `null`. The conversation loop translates that to unknown `materialConfirmed` evidence at `fansly-dm-conversations.ts:875-878`; it does not choose a provider-stop path.
- `advanceDmShadow` updates diagnostic state, including `unknownMaterialChecks` and the candidate `stopPage`. Its contract at `dm-shadow.ts:50-51` explicitly says the caller continues the real sweep. The caller stores the result in diagnostics, while request/wall-clock budgets, provider completion, checkpoints and membership certification continue to govern actual traversal/finalization.
- Unknown material prevents a certified complete shadow report (`fansly-dm-conversations.ts:1221-1224`). It does not roll back the business page or force a different provider-pagination decision. Decision 284 independently states that the full sweep continues past the virtual stop.
- Therefore Decision 293's assertion that 500-ms cancellations "forced the full sweep" is not supported by the control path. The new comment is accurate: the unchanged 5-second limit gives this diagnostic statement longer to finish; a timeout leaves material evidence unknown while normal pagination proceeds under its existing conditions.

The proposed append-only decision correction is also accurate and appropriately preserves history. It does not infer fewer provider requests, reduced SQL work or a five-second total-operation bound from a PostgreSQL statement timeout. Pool acquisition and other work remain outside that statement timer. The input cap of 100 heads is not a claim about every physical row the SQL plan may examine.

## Validation boundary and identity

No test suite, DB, provider call, production action, source edit, commit or push was performed for this review. Extra tests are unnecessary for this comment-only correction; static byte comparison proves the runtime code is unchanged. The only reviewer write is this report.

Staged file SHA-256: `620f6ce53bdb8c221c57450a78c4b929a9e11ff9baabb9c31a1666d91d68ffe7`.

Exact staged file hunk (`git diff --cached --binary -- packages/db/src/repositories/fansly-dm-shadow.ts`) SHA-256: `727e3e7f19c3a02547fe98008f1cb9be9ca3624700bdbcaaf8774d0105402b0f`.

This approval covers the DM comment and the author's stated decision correction only. It does not review the separately staged payload-batching changes or this agent's own replay implementation.
