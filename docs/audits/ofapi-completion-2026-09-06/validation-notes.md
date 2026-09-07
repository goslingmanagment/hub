# Validation evidence

This file records evidence provenance separately from endpoint coverage. The integrator appends final combined checks and durable browser evidence before release approval. Tests below used synthetic vendor responses; no paid OFAPI canary was dispatched.

## Fable and Astra collection screen

The supplied Fable logs were read directly on 2026-09-06. [The extracted cost evidence](fable-cost-evidence.json) retains the model, phase, source log SHA-256, session ID, usage and `costBasis=list`; it omits prompt/source text. Review cost was **$5.297285** and implementation cost **$15.703225**, totaling **$21.000510 at listed model pricing**. The review reports `is_error=false`. The implementation reports `is_error=true` despite `subtype=success`; its final result states that the session limit was reached. Its code contribution therefore required subsequent integration and validation, rather than counting that run as a completed successful implementation. These numbers are engineering model cost, not OFAPI credits or a claim about a settled invoice. Astra's total cost is unavailable in these logs and is not inferred.

Fable contributed the S-UI review and a partial implementation. Astra integrated/reviewed the resulting code and completed the remaining work. Runtime policy behavior is covered by the collection-policy integration tests and `tests/dashboard-ofapi-collection.test.ts`; the owner screen is a real SDK consumer with server-enforced revision, pause and allowance behavior.

The [durable local API/browser QA record](browser/browser-qa.md) includes synthetic fixtures, source revision, actual policy CAS/pause/draft comparison, frozen upload/export previews, retained Smart Link confirmation and screenshots. A final API restart reused the stored QA data and the media/export flows were exercised again. It states the exact viewport and the absence of vendor clients/workers; it does not claim live-provider or production acceptance.

## Gap patch verification

Gap commit `decd928fa460e35c21e30da4c0a0ccf82e4a67e2` passed `pnpm check`: 2,825 unit tests passed, nine existing tests skipped, typecheck, lint and dashboard build green. The targeted suite exercised user-list capture→canonical→rebuild→owner/CRM, free event-catalog capture and unchanged registration; the follow-up 15/15 run included corrected older expectations and the new catalog UI test. Later integration must rerun applicable checks on the combined revision.

Generated SDK compilation also passed from that clean commit using `scripts/vendor-sdk.mjs`; the contract hash was `a644ac36838ebbba065aa118407f2e89959a5dd1e94d65603fcf602dd729c624`. Temporary output was `/tmp/hub-gap-sdk-validation`; no client vendor directory was manually edited.

## Independent PR139 CI regression check

[CI run 34048310800](https://github.com/goslingmanagment/core/actions/runs/34048310800), source `c3ca6ad4ef89e5bfa0ab905149f5be244de68e50`, exposed two causes: the generic capture lease rejected legacy `fleet_tail`/`pilot_chats` account exports merely because their target carried a `profile`; and the queue-retention fixture omitted `ensureOfapiCollectionQueues` despite the new queue being in the retention registry. Shard 2 had one failure and shard 3 had ten. These were concrete failures, not classified as infrastructure flakes.

Backport `552e9785` uses the same closed five-profile typed-export exclusion already present in the later media batch and adds the missing queue initializer to the earlier read/export test fixture. The three affected suites—`ofapi-capture-operator.integration.test.ts`, `ofapi-capture-repository.integration.test.ts`, and `queue-retention.integration.test.ts`—passed **64/64**, no skips, in 15.59 seconds on that isolated commit. ESLint and diff whitespace checks passed. This is focused regression evidence; final combined CI must still validate the propagated review heads.

## Final integration

Coverage and final runtime checks are frozen at `41679950c9926bf4137d9002b54a52015fa42740`. Later commits in PR142 add this audit and browser evidence without changing the contract or runtime. The extractor confirms 294 unique method/path rows, 32 unique event names, tracked evidence and no unresolved source signatures.

| Review batch / tested code | Complete local check | Additional focused integration |
|---|---|---|
| PR139 `f739af292c0730484ae5c7af0eea8fa082c257cb` | `pnpm check`: 261 files, 2,823 passed, 9 existing skips | 64 legacy-export/queue regressions and 33 admission/scheduling/transport cases passed in the isolated fixes before propagation |
| PR140 `3fc5368bd81450df7f62d38d82f3f2de1ebbe780` | `pnpm check`: 261 files, 2,823 passed, 9 existing skips | 6 PostgreSQL files, 58 passed: uploads, exports, reads, policy, raw-media erasure and governed page erasure |
| PR141 `7eb91e983d43e594a44b51cc8f03a8e2bbbd6484` | `pnpm check`: 264 files, 2,844 passed, 9 existing skips | 3 integration/form/dashboard files, 27 passed for Smart Links, secrets, command outcomes, rebuild and erasure |
| Final PR142 runtime `41679950c9926bf4137d9002b54a52015fa42740` | `pnpm check`: 266 files, 2,848 passed, 9 existing skips | 5 PostgreSQL files, 29 passed: content events, webhook lifecycle, reads and both erasure seams |

Each complete local check includes typecheck, lint, unit tests and dashboard build. Counts overlap across batches and must not be summed. The new transitive-contract staging test catches missing imported route files; actual SDK compilation then succeeded from the clean final source. The review-stack migrations were applied in filename order to the dedicated local QA database, and the resulting API booted successfully. Existing baseline migrations were not renamed; new batch migrations follow the order in the report.

Final desktop companion source is `8e36ff2fb1d6e87197ea3242bae2d279576341fa` in [desktop PR27](https://github.com/goslingmanagment/chatgoose_desktop_2/pull/27). Its generated manifest pins clean Hub source `41679950c9926bf4137d9002b54a52015fa42740` and contract hash `9b84eff9d5107f7cd916cae3fe7579e0fa0b0c85e80d736d2ff765356da3f617`. Desktop `pnpm check` passed: 552 shared tests plus 1,617 desktop tests, five existing skips, typecheck, lint and build. Installer release remains gated on the deployed Hub contract matching that hash.

The independent integration review fixed two additional P2 cases before these final checks: exhausted scheduled runs now retain partial evidence with `scheduled_run_exhausted` while permitting the next bounded interval; thrown final authority callbacks are classified before dispatch and release unused reservations. No HTTP request or credit receipt is fabricated for that rejection. Browser inspection also corrected conflicting button colors and misleading file-only byte-limit copy.

Full CI is attached to the exact review heads: [PR139 checks](https://github.com/goslingmanagment/core/pull/139/checks), [PR140 checks](https://github.com/goslingmanagment/core/pull/140/checks), [PR141 checks](https://github.com/goslingmanagment/core/pull/141/checks), [PR142 checks](https://github.com/goslingmanagment/core/pull/142/checks), and [desktop PR27 checks](https://github.com/goslingmanagment/chatgoose_desktop_2/pull/27/checks). Hub CI includes generated-contract freshness, production and Docker builds, browser-runtime smoke, unit tests and all three PostgreSQL integration shards. The latest head must pass its full gate before merge; an older run or a cancelled superseded run is not the acceptance evidence. The final PR descriptions carry the completed CI result without repeatedly changing this evidence-only commit.

No OFAPI calls, paid canaries, fan messages, external pixel tests, releases or production settings were changed. Development OFAPI spend is zero. The original checkout remains at `582ef1cf8a2de52eba6639ef775ddbe3e15ba74c` with the original untracked audit preserved; implementation and review work stayed in worktrees. Unmerged review worktrees are retained until their PRs are merged.
