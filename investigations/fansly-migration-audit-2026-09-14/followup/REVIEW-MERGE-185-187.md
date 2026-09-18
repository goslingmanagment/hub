# Independent composition review: merged PR185 + PR187

Reviewed 2026-09-14T01:16:59.916973+00:00 using existing local Git objects only.

**Approved composition; no actionable findings.** This approval covers the exact tree below, conditional on the coordinator's required green CI for the immutable PR head. It does not claim those checks are already complete and does not authorize deployment.

- Current main / merged PR185: `1fe9dbe74daa8a4fbfd452ac352f7f290a60b1e4`.
- PR187 head: `8ef70afac9a89252cabcdc5bd935512fb190467f`.
- Common base: `a9794e600dfbb10918800ab5b49241e33d7357a3`.
- Candidate merge tree: `7bc44a84fff7c7329e12c229f5b398a8d60fefd7`.

## Exact preservation

An independent full recursive Git-tree comparison, including blob identities and file modes, verified the union of both branch changes. Of 141 changed paths from main and 25 from PR187, the only shared path is `docs/decisions.md`. Every other candidate path is exactly the main blob/mode unless changed by PR187, in which case it is exactly the PR187 blob/mode. There are no extra candidate changes, missing main paths or altered topic evidence. This verification reads the coordinator's existing tree; it does not regenerate a merge or mutate the PR branch.

All five metadata topic source/test/runbook paths are byte-identical to the reviewed PR187 head. Their complete patches against new main also equal the PR's patches against a9794e60. The narrow current-metadata merge, immutable partner binding, owned checkpoint transaction and interleaved-write/lease tests therefore retain the reviewed behavior.

Removing only D327 and its quick-reference row reconstructs the complete main decision document (ignoring trailing whitespace). The D327 body equals the reviewed PR body. D323, D324 and D327 are ordered in both the quick table and full text; D323 retains its static compiler-budget clarification. No historical or current main decision is overwritten.

## Dashboard interaction

PR185 adds dashboard/UI behavior and its tests plus the reviewed static-job compiler budget. Between the common base and new main, runtime, shared/db/contracts/packages, Dockerfile, package declarations and lockfile remain unchanged. Thus the dashboard import changes no API contract, DB schema, metadata writer, exclusion policy, page lease, request budget or server capture boundary used by PR187. It does not introduce a new production dependency into that fix. Candidate dashboard, configuration workflow and strictness-ratchet bytes remain exactly current main; PR187 does not weaken or reverse them.

The combined type/test graph grows with the imported dashboard tests, so the current PR CI remains relevant. Prior local metadata validation and merged dashboard/fixture receipts retain their original scope; no new local tests or complete-combination passing result is claimed in this review. No source edits, production calls, branch changes or test execution were performed.

## Reviewed fingerprints

| Candidate path | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/sync/executor-handlers.ts` | `18d6882d4c9e04843fd77fe75790113b74984032041956a70126676719e88f9c` |
| `packages/db/src/repositories/page-dm.ts` | `482fedf8bdeb55db3df2b24b5f7392db3e3fbc6fb91a94dae0728e09548b63ec` |
| `tests/sync-handlers.test.ts` | `3422a1b1fcee1ba7a816d931ea4b958bde6d654d04800cd1aad66c3313e7404f` |
| `tests/fansly-dm-exclusion.integration.test.ts` | `b73c0e58ef2fadbfea591444441f38ebe53017350ec5c9a39e09031638affc76` |
| `docs/runbooks/fansly-dm-exclusion.md` | `7d7f1cb7ed75b1ea13943bb6f98fd8f8bc239213edd342a1629cfd0fa6c4f59e` |
| `docs/decisions.md` | `7020a55a9faed379686f0c25712f474a1ccb42553ca699d42cd14b384d1dad94` |
| `.github/workflows/ci.yml` | `3f8b9318fabb991f1ec5c37952c2dd1d24b35b6e1eb92c223c15d3b5b27b905f` |
