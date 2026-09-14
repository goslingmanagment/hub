# Independent static CI heap follow-up review

Reviewed 2026-09-14T00:50:44.749913+00:00 at `c28efafe5cadb80780b9bcd34bacc10e2f0fbf0f`, against `bfdb14404a520ddfa8aab1bf64011db10b362ab4`. Local source and retained-receipt review only; no tests, production actions or source edits by this reviewer.

No actionable findings. The only executable change is four workflow lines declaring `NODE_OPTIONS=--max-old-space-size=4096` under the `static` job. Existing Typecheck, lint, contract regeneration, build, image smoke, unit tests, integration matrix, exact-source metadata, Quality Gate aggregation and main-only publication conditions remain unchanged. No continue-on-error, skip, type debt or coverage exception was added. The strictness checker still treats a compiler process failure without TypeScript diagnostics as failure.

The setting applies to host-side Node processes in this job. Docker build/run commands do not forward it as an argument or environment option, and Dockerfile/runtime configuration is unchanged. Integration and publication jobs do not inherit a sibling job environment. Existing unit and integration scripts explicitly retain their own 8192 MiB limit; this change therefore does not claim every test process is capped at 4096 MiB. Application, package, script, test, lockfile and Dockerfile bytes are identical to the pre-follow-up head.

The retained CI raw log independently confirms compiler heap exhaustion at approximately 2030 MiB and `tsc` SIGABRT, rather than a successful typecheck. Its decompressed SHA-256 matches `receipt.json`: `281d689c4b2e0b302d8845225f5e105ad5e9ab0dac4ee49d5d4c8267e189c2af`. The retained local check log matches its receipt (`661c62ffa05f989874382984dda7be2a9410d1aed4853ca6bcba66fd03b5c308`); the receipt declares the new host budget and exit 0. Fresh CI, including the separate container build, remains the publication/merge gate; this review does not substitute a local result for that gate.

The Decision 323 append describes this limited build prerequisite without changing migration stage acceptance or deployment authorization.

| Reviewed file | SHA-256 |
| --- | --- |
| `.github/workflows/ci.yml` | `3f8b9318fabb991f1ec5c37952c2dd1d24b35b6e1eb92c223c15d3b5b27b905f` |
| `docs/decisions.md` | `6abb08975ba81c5b7b1f01ccbe7b5ff3d275df69571b5291f15f8d157894c112` |
| `investigations/dashboard-production-parity-2026-09-14/ci-failure/static-job.log.gz` | `001b0c777e72012513410556c65c7ba091f2152fb357221effa179fbe66375e0` |
| `investigations/dashboard-production-parity-2026-09-14/static-heap-validation/check.log.gz` | `5f6c8a84e5fd91863cf6dead083324e104a93dc449c98ded24a0da6e7f486905` |
