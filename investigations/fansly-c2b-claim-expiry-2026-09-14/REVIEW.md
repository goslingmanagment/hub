# Independent C2b claim-expiry review

Reviewed 2026-09-14T00:51:26.532046+00:00 against main `b78752d0d1144a8457638ffb3ae0bda33455fde1`. Scope: audit finding 12 only, the seven source/test/document paths pinned below. Local source, test and decision review; no tests, production calls or application edits by this reviewer. Validation remains pending with the author.

## Verdict

No outstanding correctness, scope or readability findings. The one review correction was to qualify the new observation SQL selection and ordering (`o.payload`, `o.account_id`, `o.id`) under the repository SQL rule. The final test and manifest include that correction; behavior is unchanged.

## Contract and implementation

The existing five-minute claim deadline permits takeover when a worker stops. The new helper renews only an existing row with the original page, window, subject, exact claim token and claimed revision. It cannot insert a row, create a replacement token, increase visits, consume a newer requested revision or restore erased/completed state. Reusing the same TTL constant avoids two timeout policies. An expired unchanged claim can renew; an expired replaced claim cannot.

The private runtime helper renews and invokes the existing guarded settlement inside one `withOwnedPageSyncTransaction`. The update holds the claim row lock until settlement/commit. Existing page-lease checks before work and before commit fence execution ownership, while the settlement's exact-token, exact-revision and expiry checks remain intact. A page-lease loss rolls back renewal and settlement together. A newer requested revision R+1 remains pending when this claim settles R. This is a narrow completion fix, not a general bypass of the expiry predicate or a new execution lease.

On successful fetches, existing raw capture and observation persistence precede parsing, renewal and settlement. Losing claim ownership still leaves captured evidence without falsely certifying a refresh. The provider-error path records its failure receipt through the same owned helper, preserves the original thrown error and Retry-After value, and retains the previous behavior when receipt persistence itself fails. No selection, request count, provider transport, retry floor or shadow gate is changed.

The actual-erasure regression confirms update-only renewal cannot recreate removed state. Decision 328 and the existing shadow runbook distinguish claim takeover from page execution authority, preserve raw-first capture and accepted-revision accounting, and introduce no new flag, migration or stage-acceptance claim.

## Regression design

- Two receipt-repository cases exercise expiry refusal before renewal, completion after renewal, R+1 retention, replacement token/revision refusal with unchanged row state, and refusal after completion. Existing invalid/empty receipt and independent-window cases remain intact.
- The existing erasure test performs the real erasure flow before requiring the old claim renewal to return false.
- Four real-capture PostgreSQL cases cover success after deliberate DB expiry, a late 429, claim takeover during fetch and loss of the actual acquired page lease. A temporary database trigger requires raw observation persistence before a deadline can move forward, making raw-first ordering observable. One-fetch and receipt/check/visit assertions distinguish capture from certification; takeover and page-loss cases retain missing-receipt debt.
- Expiry is forced through explicit database state and supplied timestamps, without waiting five minutes or mocking global clocks. Trigger cleanup is in finally. The new cases exercise the actual capture path with a stubbed provider boundary rather than mirroring the private helper.

These are review conclusions about the code and test design, not passing test receipts. The author must retain final pnpm check and relevant serial PostgreSQL results before publication.

## Final reviewed fingerprints

Source manifest SHA-256: `6fe73b82220c27cabfa0bad751e47415882d3f136fa291d70d0835a64651241e`.

| File | SHA-256 |
| --- | --- |
| `packages/db/src/repositories/fan-earnings-refresh.ts` | `f4a13cc207bbf8fcb462125a37d6ce10f9016b9529ed39bd4a9af786afb54066` |
| `apps/runtime/src/services/sync/fan-earnings-capture.ts` | `fdb8e3e77c160b1f92a9a89931439423643f06e5e737962cbb51c893cb2fdb23` |
| `tests/fan-earnings-receipts.integration.test.ts` | `fbb76f0c085490e1c8cb93ecf5234c561830f96676f5de0a538002fdcd36a555` |
| `tests/fan-earnings-erasure.integration.test.ts` | `0f77cb08c2f1c9d37446831f78615c393b2138b9e72f8718e0dc732553e2d616` |
| `tests/fan-earnings-claim-expiry.integration.test.ts` | `1170b512eeb059243cda911484960ce84235c45c6ba567e8cc23ac6bae135204` |
| `docs/decisions.md` | `2eaf2c4de0e07378873a9172b82d49a5a7651f45e40677a2e0c39c65046e3c7a` |
| `docs/runbooks/fansly-earnings-shadow.md` | `961e156540436d8eb5bb468533eb03dcc53ccaae22847d32a5b0ea6c6a33c0db` |
