# Unmapped webhook payload batching — independent final review

**APPROVE.** Restricting the complete prefetch candidate set to rows that cannot append in this run closes the erasure regression in the rejected all-webhook version. The new discriminating DB control proves that the original finding was real and that the narrowed implementation preserves the earlier per-row behavior. No remaining correctness, regression, code-quality or architecture blocker was found in this patch.

Reviewer: `/root/fix_preview_scope`, not the batching author. I reviewed `binding-wait-unmapped-batch.patch`, the frozen author worktree, and the integrated release candidate against `3a6f4630ce80b648d889ae8e6cace964cfea31e0`. I read the actual driver, binding-map construction and webhook parser, both payload-reader paths, catalog SQL/schema/writer, all 10 expanded new integration cases, benchmark code, and the coordinator's new receipts. The unrelated DM-shadow comment was excluded because I authored that separate fix. No source edits, suites, DB, production, commits or deployment were performed by this reviewer. Working-tree and staged `git diff --check` passed.

## The erasure blocker is closed

The driver supplies the resolver only rows with null `accountId`, nonempty platform/native reference, no quarantined binding conflict, no `data_exports.*` kind and no account resolved by the run's platform-scoped binding map (`canonicalize-driver.ts:505–516`). This is a filter on the **entire candidate list**. Calling a batch helper conditionally while still passing mapped neighbors would not have fixed the problem; that error is absent here.

The same `resolveObservationAccountId` function is called at the original attribution stage (`:293–301`, `:586`). The current map is built before families run and is not mutated by the webhook parser. For an eligible non-export observation, the downstream `accountIds` is therefore `[null]` throughout this run. Positive drafts stop at `skippedUnmapped` before append. A dry run writes nothing, a shape refusal stays refused, and a valid zero-draft capture retains its existing stamp without creating canonical facts. Export body-derived targets, direct or native mapped rows and missing/ambiguous scope stay on the per-row reader. A binding repaired later is loaded on the next run and makes the row ineligible for batching.

The real `executeErasure` fixture commits page-B erasure after page A's first observation is stamped, while both envelope rows were already selected. The coordinator's receipts show:

| Driver | Outcome for two mapped pointer rows |
| --- | --- |
| Rejected broad batching | Test fails: appended 2, stamped 2, unavailable 0 |
| Pre-batch HEAD | Test passes: appended 1, stamped 1, unavailable 1 |
| Narrowed candidate | Passes within the new 69-test gate |

The fixture also asserts no B canonical events, no B observation, a retained page catalog row, and `object_missing` through the original reader after deletion. The mixed-page test records actual wire parameters and excludes direct-mapped, native-mapped, missing-ref, missing-platform and export neighbors from the batch. After binding repair, nine mapped observations explicitly use nine individual catalog queries, including no batch in the dry run. These tests distinguish the new scope from the rejected optimization instead of only checking a mocked predicate.

This approval does not claim to solve the pre-existing individual read-to-append race. It establishes that the optimization adds no prefetch interval for rows that can append canonical facts.

## Remaining correctness and resource checks

- **Snapshot and repair:** each group is a fresh SQL snapshot, with no persistence across pages or runs. An eligible body's disappearance or repair after prefetch can change the diagnostic outcome of this one visit relative to individual reads; it cannot append under this run's mapping. The next visit reads it again. References are copied before the query and compared by both month and object ID before consumption; a changed reference uses the original current-reference read.
- **Body semantics:** only pointer-only rows receive prefetched results. Inline and dual-copy paths retain their existing mode behavior, shadow comparisons, fallback and object-identity behavior. Joined key presence distinguishes JSON `null` from an absent body. Object/body absence and representation mismatch preserve their explicit unavailable outcomes, not a zero-draft stamp. The envelope kind remains mandatory at the package boundary.
- **Failures and counters:** a batch failure falls back to individual reads. A failing individual fallback affects only its own row, while healthy siblings continue. The existing core reader still owns per-row warnings, counters and `CapturePayloadUnavailableError`. Mixed-mode tests compare complete outcomes and counters; duplicate references retain order and separate decoded values.
- **Memory:** each group contains at most eight candidates. Bodies above 512 KiB canonical logical bytes are deferred to the original single read; codec-derived, non-null catalog size metadata supplies the threshold. Batch results contain at most 4 MiB of small canonical JSON bytes, plus transport/decoded heap overhead. A large single body can coexist with at most seven prefetched small bodies. Consumed slots are cleared; page-level arrays/maps retain only the selected envelope references. This is a bounded addition to the previous one-body behavior, not a fixed RSS guarantee.
- **SQL shape:** the VALUES positions preserve order and duplicates. Each LATERAL lookup uses the full `(bucket_month, object_id)` key and returns at most one catalog/body pair. No historical observation-prefix join, new cache, hint write, migration, negative stamp or parser shortcut remains. The obsolete persistent-hint and all-webhook designs are outside the accepted diff.
- **Combined behavior:** the integrated driver retains the earnings prepared-parse branch unchanged; batching resolves only webhook bodies at the existing read stage. All parser/gate/dry-run/unmapped/append/checkpoint/stamp steps remain in their original order. The later replay-pass integration still requires the coordinator's combined gate.

## Independently inspected execution evidence

`binding-wait-unmapped-tests.log` records **5 files / 69 tests passed** in the integrated release worktree. `binding-wait-erasure-broad-control.log`, `binding-wait-erasure-prebatch-control.log` and `binding-wait-erasure-controls.json` record the discriminating failure/pass and restoration of the reviewed driver.

`binding-wait-unmapped-benchmark.json` compares the actual pre-batch HEAD driver and current driver through the real repository, payload seam and parser in fully migrated disposable PostgreSQL 16. The 4,000-row synthetic unmapped corpus is 90% presence (466–467 logical bytes) and 10% messages (2,095 bytes):

- Pointer control: 4,000 catalog queries, 1,379 ms; candidate and fresh repeat: 500 queries, 467/414 ms.
- All runs keep all 4,000 parser calls and the same run counters/cursor positions. Nothing is terminally classified or skipped to obtain the saving.
- Inline control/candidate: zero catalog queries, 55.4/54.2 ms, same result/cursor state.
- First and deep candidate EXPLAINs each execute eight primary-key object probes and eight primary-key JSON-body probes, one row per probe, 24+24 shared hits, no temporary reads/writes. The deep lookup does not rescan earlier IDs.

I inspected the script and recorded output; I did not launch them. These establish fewer catalog round trips and local elapsed-time benefit for eligible pointer rows, not a production CPU percentage or parser-work reduction.

## Reviewed identity

Frozen author patch SHA-256: `4783cbf09099d643de6bc23eaa6111300535771824a3fdf3ba35ea99739aa066`.

| Integrated release file | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/canonicalize-driver.ts` | `0bb8c28b19efb34e10be6123c3f808d0d53e3336c038403ef038b3439df548fa` |
| `apps/runtime/src/services/payload-reader.ts` | `0410a027e11e010f15c22f3b389c976e9726b58b6c0a049d78509ba5e7aa3db3` |
| `packages/db/src/repositories/capture-payloads.ts` | `b5b01661b6effbe9fe6cb60adb625f0f47e09f78429a88d016657191af933dbf` |
| `packages/db/src/index.ts` | `9c269b250a1840a803937a95e3187d65a1d05a7e34edcb99eed6f9237695f3b6` |
| `tests/capture-payload-barrel.test.ts` | `ba8d07aefb51623742637731592df1b17aeee622d6ac9cb2ee3784addf82f4c2` |
| `tests/capture-payload-batch.integration.test.ts` | `2fed7a626e4561e088be2e6cff1ea79eb58cf51c5266cc134f153b1cb4c836e4` |
