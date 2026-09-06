# Validation evidence

This file records evidence provenance separately from endpoint coverage. The integrator appends final combined checks and durable browser evidence before release approval. Tests below used synthetic vendor responses; no paid OFAPI canary was dispatched.

## Fable and Astra collection screen

The supplied Fable logs were read directly on 2026-09-06. [The extracted cost evidence](fable-cost-evidence.json) retains the model, phase, source log SHA-256, session ID, usage and `costBasis=list`; it omits prompt/source text. Review cost was **$5.297285** and implementation cost **$15.703225**, totaling **$21.000510 at listed model pricing**. The review reports `is_error=false`. The implementation reports `is_error=true` despite `subtype=success`; its final result states that the session limit was reached. Its code contribution therefore required subsequent integration and validation, rather than counting that run as a completed successful implementation. These numbers are engineering model cost, not OFAPI credits or a claim about a settled invoice. Astra's total cost is unavailable in these logs and is not inferred.

Fable contributed the S-UI review and a partial implementation. Astra integrated/reviewed the resulting code and completed the remaining work. Runtime policy behavior is covered by the collection-policy integration tests and `tests/dashboard-ofapi-collection.test.ts`; the owner screen is a real SDK consumer with server-enforced revision, pause and allowance behavior.

**Integrator browser-evidence entry pending:** add the durable local API/browser QA artifact here, including source revision, actual server-backed policy CAS/pause/draft persistence results, screenshots if retained, and material limitations. A session-level report or static mockup alone is not the completion evidence. The integrator has reported these checks against local PostgreSQL/API/Vite; this audit does not independently substitute that report for the durable artifact.

## Gap patch verification

Gap commit `decd928fa460e35c21e30da4c0a0ccf82e4a67e2` passed `pnpm check`: 2,825 unit tests passed, nine existing tests skipped, typecheck, lint and dashboard build green. The targeted suite exercised user-list capture→canonical→rebuild→owner/CRM, free event-catalog capture and unchanged registration; the follow-up 15/15 run included corrected older expectations and the new catalog UI test. Later integration must rerun applicable checks on the combined revision.

Generated SDK compilation also passed from that clean commit using `scripts/vendor-sdk.mjs`; the contract hash was `a644ac36838ebbba065aa118407f2e89959a5dd1e94d65603fcf602dd729c624`. Temporary output was `/tmp/hub-gap-sdk-validation`; no client vendor directory was manually edited.

## Independent PR139 CI regression check

[CI run 34048310800](https://github.com/goslingmanagment/core/actions/runs/34048310800), source `c3ca6ad4ef89e5bfa0ab905149f5be244de68e50`, exposed two causes: the generic capture lease rejected legacy `fleet_tail`/`pilot_chats` account exports merely because their target carried a `profile`; and the queue-retention fixture omitted `ensureOfapiCollectionQueues` despite the new queue being in the retention registry. Shard 2 had one failure and shard 3 had ten. These were concrete failures, not classified as infrastructure flakes.

Backport `552e9785` uses the same closed five-profile typed-export exclusion already present in the later media batch and adds the missing queue initializer to the earlier read/export test fixture. The three affected suites—`ofapi-capture-operator.integration.test.ts`, `ofapi-capture-repository.integration.test.ts`, and `queue-retention.integration.test.ts`—passed **64/64**, no skips, in 15.59 seconds on that isolated commit. ESLint and diff whitespace checks passed. This is focused regression evidence; final combined CI must still validate the propagated review heads.

## Final integration

Coverage source is frozen at `41679950c9926bf4137d9002b54a52015fa42740`; the static extractor verifies all referenced code/test/consumer files are tracked, all 294 method/path rows and 32 event names are unique, and no operation or source signature is unresolved. Runtime source was clean at extraction. Pending integrator append: final validation revision, PR heads, ordered migration/application validation, final `pnpm check` and PostgreSQL integration results, actual vendor-SDK compilation, and browser evidence for media/marketing/content controls. Preserve failures and corrections that affect the accepted release behavior. Do not add individual batch test totals as if they were independent tests.
