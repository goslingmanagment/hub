Fansly earnings guarded integer ranges but summed amounts with raw number arithmetic and separately truncated projection values. Use the existing shared mills codec for both operations, following the kernel money contract.

`sumMills` accumulates bigint through `millsFromInteger`; `millsToNumber` preserves the existing numeric event and repository boundaries. Row and aggregate safe-integer checks, whole-observation refusal, negative adjustments, content fingerprints, replay identity and projection defaults remain unchanged. Decision 329 records this cleanup. No parser-version bump, unit conversion, new flag, data rewrite or incorrect production amount is claimed.

Validation against main `b78752d0`:
- `pnpm check`: 3,423 passed, nine existing skips, 304 files; strictness, lint and build passed.
- Four serial mandatory Docker-Postgres suites: 26 passed, no skips — earnings identity, projection, audit reconciliation and audit.
- Existing single-pass/refusal/identity checks remain, with three additional safe-integer-limit/refund cases.
- Independent correctness/readability review: no findings. Exact command receipts and stable source fingerprints are retained in the investigation.
