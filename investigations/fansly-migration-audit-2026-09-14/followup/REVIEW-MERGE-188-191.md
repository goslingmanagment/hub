# Independent PR 188 + 191 composition review

Reviewed on 2026-09-14 by `/root/review_w0_runner`: no findings. The supplied
prospective merge tree is the exact union of the reviewed topic changes and
current main. No tests, branch mutations, network or production actions were
performed for this review. CI status remains a separate publication gate.

| Input | Exact identity |
| --- | --- |
| Main | `ce0a44b0d6778f8bd371c105f26d31f9abe8b8bd` |
| PR 188 | `ef8d56709227284b9b2d50f302f249e33898c4bc` |
| PR 191 | `d5cda4dd6481c65aec9a2d9ddc758748fe5f2cf8` |
| Prospective combined tree | `98056e2d361136eaf35af7c7d29812cd43e68580` |

Compared all 2,211 paths across the base, both heads and combined tree, including
blob identities and file modes. Outside the decisions file, 34 paths belong to
PR 188, 19 belong to PR 191, and 2,157 agree across both heads. Every combined
path matches its supplying side. There are no overlapping source, test, runbook
or evidence changes between these topics.

The decisions diff consists only of additions. Every existing main decision
body and reference row is retained. Decision 326 and its reference row exactly
match PR 188 and precede Decision 327; Decision 330 and its reference row exactly
match PR 191 and follow Decision 327. The relevant final order is
324 → 326 → 327 → 330.

PR 188 retains its four reviewed runtime/database files and one regression suite
byte-for-byte: bounded head debt still blocks history, exhausted debt remains
visible, and fresh pending history without an active target resumes from its
oldest cursor. The incoming main metadata-write correction remains intact.
PR 191 changes only its existing voice integration test: it waits for committed
completion before allowing the next fixture reset. It has no runtime change
and no interaction with DM selection or execution. Both inherit main's
unchanged 4 GiB static-check CI configuration.

## Combined source SHA-256

| Path | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/sync/executor-handlers.ts` | `03f56795ee2ac66026bfa8da90597edd58db87e82609d85a9b0fe30d0fa5b152` |
| `apps/runtime/src/services/sync/fansly-dm-conversations.ts` | `7331c010dec8ced4bf67560f38871a4032ae7bf3caceb1922e10b39ba85eca43` |
| `packages/db/src/repositories/fansly-dm-head-debt.ts` | `63256c9b40375b7199e06ba04a1cdee75d1dabe598d99e2078187703bd5c7468` |
| `packages/db/src/repositories/page-dm.ts` | `ed4992bdfdaf774621e846f57fca0d0fa5494c2419764352035f28bb87e33035` |
| `tests/fansly-dm-exhausted-head-history.integration.test.ts` | `837b894681a5a38a2aa21a1e770d03270e4be6083d3a62928a09526b85914d26` |
| `tests/voice-notes-service.integration.test.ts` | `af4e463560a2156ca25ae367cf8a88b75e94583dc447dbabb012e73a65ad4101` |
| `.github/workflows/ci.yml` | `3f8b9318fabb991f1ec5c37952c2dd1d24b35b6e1eb92c223c15d3b5b27b905f` |

This review does not combine PR 190 or waive fresh CI for its later main merge.
