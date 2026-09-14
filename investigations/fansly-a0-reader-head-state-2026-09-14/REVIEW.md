# Independent A0 reader-head-state review

Verdict: no actionable findings in the frozen candidate
`5f247b4312ea60ab2b81625a4ca49bd8046fb3cf`, based on
`4d9cac4acffbbf1cbb17b74cac0b4d76f01ce65d`. This is a source, documentation,
composition and retained-test-receipt review. The reviewer did not run tests or
perform production actions for this review.

## Correctness and scope

The new classifier matches the actual Agent transcript source preference:
`dm_message_archive` before `message_archive` before hot. It applies tombstone
dominance across scoped candidates and uses the current page's exact account
binding for account-wide tombstones. A tombstone without a scoped candidate does
not invent a transcript row. Null/foreign bindings do not broaden the lookup.
The winning source determines pending state; empty hot text is not treated as
pending. Queries select state columns without message bodies or previews.

Each target is scoped by page, platform, conversation group and message ID; hot
resolution follows that current group instead of trusting a cached thread hint.
Archive-only groups remain eligible without a hot thread. The returned ordinal
and key preserve per-target lookups, including duplicate inputs. The explicit
100-target bound matches a provider list page.

The handler reads advertised heads before applying that list page. It preserves
the original hot-presence SQL/counter and capture-debt meaning, then observes
reader state separately. The seven new counters are nullable scalars: saved
legacy and mid-sweep cursors remain unknown through completion. Unknown reader
evidence prevents a complete diagnostic receipt; it does not block the business
sweep, change polling/cadence or certify provider completeness. The existing
virtual stop and business checkpoint path are unchanged. Flag none does not
invoke the snapshot helper.

Both data reads share one read-only repeatable-read transaction. The helper
recomputes the remaining monotonic query allowance before each data query, caps
it at five seconds and the remaining dispatch allowance, and refuses a second
read after exhaustion. Documentation correctly excludes an end-to-end deadline
for uncancellable pool checkout, setup/cleanup and network return. Failure marks
both diagnostic reads unknown and preserves normal sweep execution.

## Migration, measurement and code quality

0194 is additive, uses a controlled definer search path and fixed SQL, and quotes
only typed internally selected IDs. Caller READ ONLY/repeatable-read and installed
statement/lock limits are checked before sampling. PUBLIC execute is revoked;
existing read_only receives only function execution. No broad table grants or
credential path are added. The probe returns a current stored-head plan, not
reader coverage; archive-only conversations without a stored thread are outside
that cost sample. The runtime and probe SQL are pinned by a parser-based test.
0192 remains byte-identical. Application rollback retains the unused new function.

The new production modules are small, with one purpose per helper. Extraction
of the old hot SQL permits one shared snapshot without changing its semantics.
The duplicated fixed probe SQL is deliberate and covered by the fidelity pin.
D335 and the runbook preserve seven-day, discrepancy, churn/outage and A1 gates;
they make no historical reader, full transcript, event latency or realized
HTTP-savings claim.

All incoming main decision bytes and exports survive composition. D335's exact
row/section is the only decision addition, separated by one blank line; only
the two intended repository exports were added. All 16 topic paths listed as
unchanged in the composition receipt match the pre-rebase topic byte-for-byte.

## Validation and operator artifact

Independently verified compressed and decompressed hashes of both final logs,
exit codes and tested head. `pnpm check` passed 3,762 tests with nine existing
skips across 327 files. All eight serial PostgreSQL suites passed: 84 tests,
including 13 reader parity/snapshot cases and both 17-case cost-probe variants.
The tests exercise actual transcript precedence, cross-source tombstones, foreign
scope, capture-debt limits, snapshot consistency, decreasing/expired budgets,
pre-apply handler behavior, disabled/failing diagnostics, migration identity,
function privileges, caller limits and stored-ID SQL syntax. Initial failed
exploratory runs remain separately retained; they are not represented as passes.

Also reviewed the coordinator's unexecuted private `release/measure-reader.py`
(SHA-256 `44328e9c31f1044d14987f3f20e7c5fb101b66348f9290cb935b07167bf26ad5`).
Relative to the reviewed PR193 collector, only decision/function/scope/plan/output
names changed. It makes at most one serial call per six fixed pages, validates
role/transaction/timeouts, retains raw results and hashes, stops on first failure,
and preserves unmeasured versus zero. Its process deadlines and no-fallback/no-retry
behavior are unchanged. It is ready for separately authorized post-deployment use;
this review did not execute it or establish production query cost.

## Frozen source fingerprints

All 18 hashes below were independently verified against the frozen commit and
working files; validation receipts name that exact commit.

- `apps/runtime/src/services/sync/dm-shadow-material.ts`: `bbecdb0e45850602118451fc9b2cab3a1c7d7bee7ada9cb33683d3eef23d9f32`
- `apps/runtime/src/services/sync/dm-shadow-state.ts`: `81b44ab046eb97e6ac722e55a7a98cfc2bc08072a1dbceedb57038a8fbfdd5d8`
- `apps/runtime/src/services/sync/dm-shadow.ts`: `3a7b4968f9aea17b31c128f305b007bfa078045b549be8b98d46ebd73c0fc03d`
- `apps/runtime/src/services/sync/fansly-dm-conversations.ts`: `13ac2f2c5e2e403941d18bc5bdb5f55468a783f2ad2f26bfed77a3e6c00ec5d3`
- `docs/decisions.md`: `c025a2f7d19d8d9edfb721e3f95573b5d1d325b887e06b762b582638c76e37eb`
- `docs/runbooks/fansly-events-shadow.md`: `be05b7cc7c7bb47d8fc37962657322a1b7be0220c02fc280b8057120649e34f6`
- `packages/db/migrations/0194_fansly_dm_shadow_reader_probe.sql`: `7ca1c3d59e62542dd5ec9e6cc386dbccc0a3eae1aa686410665dd77c3bcc2f9a`
- `packages/db/src/index.ts`: `8d3e528d4c3ba436b5db25565f41b80542e6e5f6feb1eee71b8d7226a19725a5`
- `packages/db/src/repositories/fansly-dm-reader-heads.ts`: `8cc85b375ba8739c4e6b159a112f39eb7659f82756b2c31652a25bed9681d04c`
- `packages/db/src/repositories/fansly-dm-shadow-snapshot.ts`: `c57ebbee58b02910131ae3aeb2767f57fb2b9997d782a1166642ad4e54ac950e`
- `packages/db/src/repositories/fansly-dm-shadow.ts`: `523ab3a309f1caae5c7a60ec3db372998f8eb85ded56951ea92f222164bfe144`
- `scripts/deploy-production.sh`: `fd35cf82b1aa79f72bfaf19997d1e2884725b7a37e0063bf60aaef4fe5266f41`
- `tests/dm-shadow-cursor.test.ts`: `b07184eede1a9e6e3cd407d5eaf052cb0fe53d0f7816811982b549d3471a81fe`
- `tests/dm-shadow.test.ts`: `643d71693768c60dc8f8ae6cc0d61c14e7ceeb68f4c0c368ee848862aaf328fd`
- `tests/fansly-dm-material-probe.integration.test.ts`: `ba13ac0cb9e518519505f8f85e6afae5f2159b43b13e3674dbaf8dba29d162df`
- `tests/fansly-dm-reader-heads.integration.test.ts`: `626b6e2a729ac4aff54d5c94f9fa704e56dd41a979598585ea5ec95702e828a8`
- `tests/fansly-dm-reader-query.test.ts`: `27aea453866ce23cf58b76dafa2e151118c7208ce25fef1ed1bd98bdb8c8ab34`
- `tests/fansly-dm-shadow.integration.test.ts`: `d9da13a24a4f9a69eebad96c751c95afc861ca3aaf4d53409719dea427f984ae`

## Publication prose consistency

REPORT.md and PR-DESCRIPTION.md match the verified head, final test counts and
receipt times. They retain initial failures, distinguish the existing typecheck
ratchet debt from a debt-free tree, and keep the new production cost, future
reader observations and original stage gates unmeasured/unaccepted. Their
pre-publication pending-review markers may now point to this clean review.

## Main 3baee9db composition follow-up

Reviewed rebased head `d09920e77773e164ab7402120b61382f08f34376` against main
`3baee9db69a479e470b9ed6da7af079b456af6c3` and prior reviewed publication
`5995f52c1c4fe8e041c0017deac38fe192bfa5e5`. All 17 non-decision topic
source/test/runbook paths remain byte-identical; all 18 current source pins verify.
The source/test patch is identical (SHA-256 `2e43ac13de92403e446c7846586e332944b0f13a3e0bddfe32e5258a54b536d7`).

All 2,410 main paths outside the intended source/doc modifications retain
their exact Git entries. The manual decision resolution preserves every main
byte, including D333 and D334, and appends the unchanged D335 row/section plus
one blank separator. Incoming W0 egress/observer/launcher modules are separate
from the A0 sweep/reader modules; no code conflict or new behavior was introduced
by this composition. No findings. Refreshed composition validation is pending
and will be reviewed separately; this check did not run tests or production calls.

## Main 3baee9db validation receipt follow-up

Verified both refreshed original/compressed log hashes, exit codes and exact
tested head `d09920e77773e164ab7402120b61382f08f34376`. Full `pnpm check`
passed 3,779 tests with nine existing skips in 329 files; all eight serial
PostgreSQL suites passed 84/84. All 18 source pins remain unchanged.

The composition receipt now explicitly distinguishes 2,423 total main paths,
2,410 unchanged Git entries and 13 existing paths changed by the intended topic;
these counts independently match the Git trees. This resolves the ambiguous
previous `mainPathsRetained` label without altering any source or test.

No findings remain. The composed candidate and retained validation are ready
for coordinator-authorized publication and fresh CI. No tests, branch mutations
or production actions were performed by this review.
