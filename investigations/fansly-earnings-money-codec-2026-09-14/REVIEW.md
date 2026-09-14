# Independent earnings money-codec review

Reviewed 2026-09-14T00:43:53.274357+00:00 against main `b78752d0d1144a8457638ffb3ae0bda33455fde1`. No actionable findings. Scope is the four-file codec change; no tests, production calls or source edits by this reviewer.

The helper pattern is sufficient for this existing contract. `sumMills` constructs every operand through `millsFromInteger` and accumulates bigint. `millsToNumber` converts the result back at the existing numeric event boundary. Row validation still precedes conversion, and aggregate safe-integer validation still follows it. Safe accepted results are identical to the old sum; an integer outside that range cannot round into the safe range during this conversion. Overflow, fractional/missing inputs and whole-observation refusal therefore retain their existing behavior. No database API or JSON field needs widening.

`millsToNumber(number)` in the projector uses `Math.trunc` through the named constructor, preserving supported finite number semantics, negative adjustments and the existing nonnumber gross-zero/net-null defaults. Non-finite fabricated event numbers are not a supported input contract. No promise of preserving their exact exception timing is needed. The projection still writes the same numeric repository API and retains all source-observation/time ordering guards.

No event field, breakdown sorting, content-fingerprint construction, dedup key, schema version, canonicalizer version or projection watermark changes. Consequently valid observations retain their fingerprint and replay identity. Single-pass parsing remains intact; this adds no second parse or hash.

The three added positive cases exercise both safe-integer limits and a mixed-sign refund sum through the real canonicalizer. Existing tests retain aggregate-overflow rejection, malformed-money poison handling, the real driver's whole-observation refusal without stamping/appending, row-order fingerprint stability, A-to-B-to-A identity and PostgreSQL projection/rebuild coverage. These are the relevant final validation gates; they were inspected, not rerun here.

The source change uses existing helpers directly, removes raw arithmetic at the two identified points, and adds no adapter, policy abstraction or parser-version churn. Decision 329 accurately limits the change to codec consistency and does not claim an incorrect historical amount or measured production repair. No new flag or runbook is necessary for this implementation-only change.

| Reviewed file | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/canonicalize/fansly-earnings.ts` | `8dbe8d7acd333bc6c8b959b77bfed222e3634bfcfe43f1bd7e8a9aa08d3d978c` |
| `apps/runtime/src/services/projections/fan-earnings.ts` | `86ca301979f09a55b48f20f2645d0f2bbcfa7ddebfe76634d46f4c052bdf11ce` |
| `tests/canonicalize-fansly-earnings.test.ts` | `efefdb28ff1b56801250ed9fd1f5ecf72678596b5b0a3e3d07d4cdc3717d8adf` |
| `docs/decisions.md` | `fb6e7a4acc9df1ca3e245dab5f30536ff9cf349f8f9534035b7ff70db24e2ae3` |

Final `pnpm check` and the relevant PostgreSQL suites remain pending for the coordinator; decision numbering must be reconciled before publication.
