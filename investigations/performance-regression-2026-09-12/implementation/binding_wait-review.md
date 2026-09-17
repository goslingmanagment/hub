# Independent review: binding-wait optimization

**Verdict: BLOCK the current candidate for release.** The correctness design is conservative and the coordinator's 43 tests passed, but the candidate has not met its performance/architecture acceptance gates. It adds persistent state and a join to the hot sweep without proving bounded deep-page work or benefit for the sampled production corpus. No source change, database process, test suite, production operation, commit or deployment was performed by this reviewer.

Reviewed worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-binding_wait-20260912`.

Base: `31b73a9691f32f8c33c3fe479bca68533c7048d6`.

Candidate `git diff --binary` SHA-256: `2ca190e383796b16b97ac7baf9d0db0d239ef92a75fc945cf6da7978d85bffda`.

The release integration additionally retains migration 0186 in the deployment rollback allowlist; that additive merge resolution does not address the blockers below.

## Release blockers

### 1. Bound the hint lookup at deep cursors and after sparse/stale hints

Location: `packages/db/src/repositories/domain-events.ts:1096-1100`, the new left join; keyset restriction remains only on `o.id` at lines 1071-1072.

The actual warm benchmark plan chooses a **Merge Left Join**, with its inner `canonicalize_binding_wait_pkey` index scan constrained only by `family_key = 'webhook:ofapi'`. The merge condition matches `(o.id, o.received_at)` to `(bw.observation_id, bw.received_at)`. The query does not itself bound that inner scan to the attempted observation page.

This admits prefix work: when observations start at a deep cursor, a merge scan may walk earlier hint keys to catch up. Exact replay and erasure can also leave stale hint prefixes after their observations stop qualifying. Repeating that prefix walk across pages can turn a bounded 200-observation page into work proportional to accumulated hints. The present receipt explains **only the first page**, where both sides begin together; it cannot establish the deep-page bound. A particular deeper query may choose a different plan, so the amount of production regression is not measured or asserted here.

Required resolution: make hint retrieval bounded to the selected page (for example, a constrained correlated primary-key lookup) and provide EXPLAIN ANALYZE receipts for early, middle and late cursors on a meaningfully larger hint corpus, including sparse eligible observations and obsolete hints. Merely demonstrating that the first page uses an index is insufficient. Keep the source visit/cursor budget unchanged.

### 2. Demonstrate applicability to the real waiting corpus before adding durable state

The coordinator's read-only production receipt at `2026-09-12T17:05:13.867302+00:00` sampled the first 2,000 webhook observations with `parse_version < 5` and `account_id IS NULL`, ordered by ID. **Every kind had `inline_no_ref = 0`.** Thus none of those sampled rows can benefit from this candidate, whose explicit eligibility is a non-null inline body with no catalog reference.

The sample includes 291 `users.typing` rows outside the declared canonicalizer kinds. Excluding those still leaves zero eligible inline-only rows among the 1,709 rows of declared kinds. This is a head sample, not a census of all waiting observations or an attribution of all `skippedUnmapped` visits. A current-cursor/tail sample may differ; that evidence is still required.

The synthetic benchmark exclusively uses eligible 8 KiB inline-only messages. It demonstrates that the mechanism can help those inputs, but it cannot justify adding a persistent table and hot-path join to a corpus dominated by ineligible storage modes. Required resolution: establish sufficient current production applicability and measured benefit, or redesign the candidate for the actual storage topology while proving the payload seam's availability/parity and repair contracts. Do not silently broaden caching to reference-backed bodies without a new correctness review.

## Runtime receipts inspected

All receipts were generated centrally by the coordinator and read independently here:

- `binding-wait-integration.log`: 4 files, **43 tests passed**, 8.17 seconds, run in the release worktree. These cover the new binding-wait cases, existing sweep behavior, budgets and retention-deleter contract.
- `binding-wait-benchmark.json`: actual repository query, payload seam, registry parser and driver; 4,000 synthetic messages, PostgreSQL 16; all source observations remained at parse version zero, no events/stamps, matching cursor positions.
- `binding-wait-eligibility.json`: the production sample described above, no payload output.

| Synthetic phase | Wall time | Payload bytes returned | Parser calls | Hint rows / total table bytes |
| --- | ---: | ---: | ---: | ---: |
| Disabled control | 172.39 ms | 33,630,893 | 4,000 | 0 / 16,384 |
| Enabled first fill | 505.26 ms | 33,630,893 | 4,000 | 4,000 / 786,432 |
| Enabled warm after reset | 75.49 ms | 0 | 0 | 4,000 / 786,432 |
| Enabled warm repeat | 76.01 ms | 0 | 0 | 4,000 / 786,432 |
| Disabled after warm | 175.05 ms | 33,630,893 | 4,000 | 4,000 / 786,432 |

The eligible warm case is approximately 2.3 times faster end to end, while the first fill is approximately 2.9 times slower than the disabled control. The warm first-page database plan itself took 1.476 ms versus 0.149 ms in the disabled control, reading 27 shared-buffer hits versus 20. This is consistent with paying more metadata/join work to avoid body transfer and parsing. It reinforces the need to verify real eligibility and deep cursors; it is not a production CPU saving forecast.

## Correctness and architecture findings

No confirmed fact-loss, attribution or replay blocker was found in the reviewed implementation within its current inline-only eligibility. In particular:

- A hint requires the existing shape gate and a successful nonempty parse followed by unresolved attribution. Zero drafts retain normal stamping; malformed/unavailable/throwing rows cannot establish a hint. No source row is deleted or terminally stamped to hide the backlog.
- Cached hits remain source visits. The keyset page, visit counters, maximum lag, page budget and cursor CAS still advance through the same observation rows. `skippedUnmappedCached` is explicitly a subset of `skippedUnmapped`, rather than a claim that SQL visits disappeared.
- The context hash covers the native-account context map, resolved current/historical attribution map and conflict set with stable sorting. The family version is separate. A same-target generation change need not invalidate a result when these parser/attribution inputs remain identical.
- The signature includes all fields currently read by the opted-in pure webhook canonicalizer and driver routing, including captured body hash, native reference, parse version, timestamps and storage identity. The current capture repository treats raw body/hash as immutable; reference backfill changes signature fields, reclaim changes reference/body-presence, and re-journal creates a new identity. A hypothetical in-place body repair that fails to maintain the capture hash would violate this assumption and could reuse stale evidence; the current source contains no such body-repair API.
- The remember statement compares its candidate signature against its source snapshot. A later concurrent source change can leave an obsolete hint, but subsequent reads compare the changed signature and miss it. The cache does not need to serialize all raw-row changes to remain safe; it must not claim that no obsolete hint can ever be inserted.
- Team-level exports derive all target IDs from the parsed payload before a hint is remembered. Any binding change invalidates the global context; normal all-target attribution and material-time erasure fencing run again on the miss.
- Exact receipt execution, CLI runs and dry runs bypass hints. Families with accepted-post ledger context are excluded. Reference-backed, dual-copy and pointer-only rows also bypass the shortcut, preserving current seam behavior; this conservatism is why the live sample does not benefit.
- Hint updates fail open after page work. One bounded insert batch replaces an existing hint, rather than appending one per version or context; successful background parsing clears the corresponding hints. Insert ordering is deterministic. Source write/dedup semantics are untouched.
- Migration 0187 is additive and empty, with key and hash-length checks; no historical source rewrite/backfill is introduced. Old runtimes ignore the table, so its rollback allowlist entry is appropriate. The retention deleter is restricted to this derived table.

The implementation is modest in executable size and fits the existing repository/driver/registry boundaries. Persistent state is nevertheless a real architecture cost: the table is bounded by the corpus ever classified, not a fixed cache size. Exact replay and erasure may leave inert identity/hash rows. The final decision note must explicitly document that lifetime, the absence of copied bodies/provider references, and that deleting/rebuilding this derived state cannot affect captured facts. These tradeoffs cannot be justified solely by green correctness tests.

## Gates for a revised candidate

1. Resolve both blockers with actual bounded plans and production-shape applicability evidence.
2. Preserve the existing regression cases: enabled/disabled outcomes and cursors; late binding repair; current/historical/conflict transitions; parser and envelope changes; team exports; malformed/zero drafts; exact/CLI/dry replay; storage transition and body unavailability; concurrent mutation before remember.
3. If eligibility broadens to catalog-backed rows, add tests for every read mode, readable/unreadable transitions, changed storage identity and capture repair. A cache-hit counter must not manufacture successful parity or body-availability evidence.
4. Re-run the serial central suites and benchmark after the concrete fix, then perform independent re-review of the new diff. Combined release type/lint/unit/build and deployment health verification remain coordinator gates.

## Reviewed content hashes

| File | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/canonicalize-driver.ts` | `84e0aa193c71eff44e988ec701032f227b9880e31c8479574a2bf47e82286147` |
| `apps/runtime/src/services/canonicalize/index.ts` | `0a835ab692bb4e1f26daf50ec10683df01d9299f634aa2c237950e1cefd6bcf6` |
| `packages/db/src/repositories/canonicalize-binding-wait.ts` | `ae7af502c42e5a25653150b902b121dc847e3656fcedd703bf73729105113445` |
| `packages/db/src/repositories/domain-events.ts` | `7c585a10ab233c0388552c0335c6146916488191f6e40132c04e5292a50464cb` |
| `packages/db/migrations/0187_canonicalize_binding_wait.sql` | `774042be14c14fda95acd8920b047ff453feb60a08e42627e0cccfdd83a17433` |
| `tests/canonicalize-binding-wait.integration.test.ts` | `ac25db0bcbed97123544068d301c705d5a84ad6aabfe0b3ab380b8d34828ca2b` |
