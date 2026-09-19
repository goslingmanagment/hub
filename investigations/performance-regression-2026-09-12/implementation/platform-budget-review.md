# Platform comparison budget — independent exception review

**APPROVE the exact two-site adjustment: 155 → 156 in the seed-count commit, then 156 → 157 in the batching commit, with separate written notes.** No objection to this exception; no runtime rewrite or counting-rule change is needed.

I read the current counting script, budget history, the two actual source sites and their diffs against `31b73a9691f32f8c33c3fe479bca68533c7048d6`. An independent static comparison found **155 baseline sites and 157 current sites, exactly these two additions and no removals** under the ratchet's directory/file exclusions:

| Site | Meaning and justification |
| --- | --- |
| `tests/page-sync-seed-count.integration.test.ts:49` | The fixture factory selects the existing Fansly or OnlyFans page constructor to test both providers. This is a test-only provider branch; it adds no production routing or platform behavior. The test directory is deliberately included in the counter, so the site should remain visible and its one-unit cost should be recorded. |
| `apps/runtime/src/services/canonicalize-driver.ts:553` | `row.platform !== null` checks whether an envelope has a usable scope before considering it for prefetch. It applies the same missing-scope rule to every provider and does not choose behavior by a provider name. It belongs to the independently reviewed batching custody guard; changing its syntax merely to avoid the regex would obscure the accounting. |

`CLAUDE.md:60–63` explicitly permits this: “a deliberate new branch bumps the budget WITH a written justification.” The budget file already retains notes for reviewed exceptions. The proposal follows that rule while leaving the regex, exclusions and fail-on-over-budget behavior unchanged. It does not create allowance beyond the two observed additions.

Suggested append-only notes in `scripts/platform-branch-budget.json`:

1. **155 → 156:** “2026-09-12: +1 for the seed-count integration fixture's Fansly/OnlyFans page factory. Tests are included in this ratchet; the branch selects existing fixture constructors and adds no runtime provider logic.”
2. **156 → 157:** “2026-09-12: +1 for the canonicalization batching guard's `platform !== null` validation. This provider-agnostic missing-scope check conservatively excludes ambiguous envelopes from prefetch; it adds no provider routing.”

Fold each adjustment into the commit that introduced its site. Preserve the prior budget notes. The TypeScript strictness allowance remains **1,897**; this approval does not authorize raising it or changing any other gate.

Reviewer: `/root/fix_preview_scope`, independent of both introducing fixes. I changed no code or budget and ran no suite/DB/production operation; only this review report was written. Static source counting is evidence for the exact budget delta, not a claim that the coordinator's final gates have subsequently passed.
