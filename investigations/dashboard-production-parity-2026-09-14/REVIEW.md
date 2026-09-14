# Independent dashboard restoration review

2026-09-14. Reviewer: `/root/w0_browser_discovery`, independent of the import.

**R1 is closed by the formatting-only follow-up below; no outstanding findings
remain in this review scope.** The initial review found one readability issue
and no confirmed correctness or integration regression in the inspected paths. The finding below is tied to the owner's
explicit request, not a proposal for a broader component refactor. No code or
tests were edited, no application tests or browser scenarios were run, and no
production/provider action was performed. Only this review was written.

## R1 — Split the two touched JSX blocks over readable lines

`apps/dashboard/src/pages/OfapiMarketing.tsx:166` and `:167` contain the analytics
and history sections on single lines of 2,502 and 2,030 characters. Both lines are
part of this PR's changed hunks. Main already had 2,459/1,988-character versions;
the imported production change retains and slightly extends that inherited debt.
This is not a newly discovered runtime regression, but publishing it unchanged
would repeat the precise 2,000-character-line pattern the owner rejected.

Smallest fix: format those two touched JSX sections across readable lines, keeping
expressions, attributes and element order unchanged. No component extraction,
state-machine redesign or unrelated formatting is needed. Keep the original
103-file byte-parity receipt as import evidence and record this file's narrow
formatting-only exception rather than continuing to claim byte parity afterward.
Review the resulting syntax/AST equivalence and let the planned candidate checks
cover the final file. I made no formatting changes myself.

## Independently verified source and scope

The candidate is based on main `0a08365fbefa545397f4e91a2eae3fca7c36c444`.
All 103 paths named by the five original transfer steps are currently byte-exact
with local production reference `380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`:
74 dashboard files, 15 tests, one strictness-ratchet file and 13 dated historical
investigation files. I compared file bytes, not only the importer's success flags.
The source manifest hashes to
`89cad1acd4f1449bf26813fa1c3cb698e96ff6b37eaf7225dc3a8fe1decf2a38`.

The current diff consists of those paths plus historical decision restoration.
Decisions 296–300 match the production source verbatim; existing main decision
bodies remain present unchanged. Runtime, database/migrations, contracts, SDK,
deployment and CI files are unchanged from main. The App route tree is also
unchanged: its diff is only the lazy-loading fallback. Newer main earnings-audit,
A0 regression and deployment work is preserved. This proof refers to local source
commits, not a fresh production read or complete release parity.

## Correctness and integration review

- Mutation identity is passed in variables for notes and every changed Workboard
  mutation. The SDK params and success-cache invalidations use the submitted
  page/fan, rather than hook options that an offline observer can replace after
  navigation. All changed call sites pass that scope explicitly. The existing
  snooze-body assertion was not introduced as a substitute for a new contract.
- Workboard actions check visible targets and admission state. Undo holds an
  immutable page/fan target and consumes its receipt before dispatch, including
  when the reply is lost. A later GET does not reactivate that receipt. Toasts
  validate mounted/original-page context; these client guards do not imply a
  server contact-ID/CAS guarantee that the API lacks.
- Fan-note drafts are keyed by page/platform/fan and principal. A late save clears
  only the original unchanged submitted draft. Hydration retains reviewed
  rowVersion, coverage fingerprint, caps, expiry, consent and idempotency key;
  an uncertain retry reuses the same body. Re-review preserves limits but clears
  mark-read consent. These payloads use the existing SDK/server contracts.
- Configuration focus is implemented as visibility/filter state on the existing
  mounted form. Item keys stay stable, hidden rows retain editors, and staged
  dialogs receive the complete item map and boot flags. Draft versions, write
  receipts and transitive dependencies are not replaced by a narrowed feature
  map. Modal focus uses a stable ref while its current target follows the view.
- Feature status requires current agreeing process values and required api/worker
  liveness, preserves pending/unknown/unavailable states, and treats shadow or
  request-only as limited modes. It describes configuration readiness, not
  successful execution or business impact. CSV scope presentation preserves the
  legacy empty-means-all versus diagnostic empty-means-none distinction,
  comma-only values, unknown labels and numeric storage's raw editor. Choice
  labels do not bypass the backend validator or staged-configuration protocol.
- Webhook saved-choice drafts retain their original version and survive polling.
  Apply and readback are separate operations; an unchanged already-applied/failed
  snapshot cannot prove the uncertain attempt completed. A separately acknowledged
  new intent does not itself send a request. Previously applied policy remains
  eligible for explicit reconciliation. There is no automatic retry of a paid
  operation introduced by these controls.
- Export quote recovery pins the original page and requires a fresh successful
  jobs query. It cancels that exact key before fetching, so an earlier initial GET
  cannot satisfy acknowledgement or replace the new result. A disabled recovery
  observer adds no polling timer. The UI distinguishes unknown quote creation,
  preparing a separate quote, and later paid collection approval; it does not
  pretend to supply missing durable server idempotency.
- Navigation preserves URL periods/filters and router back context. Login return
  targets pass the existing local-path validation, reject malformed encodings,
  external paths and login loops. Owner/server access boundaries are unchanged.
  Cached read failures are surfaced without promoting stale snapshots to current
  empty data; action receipts remain separate from refresh outcomes.

The new helpers are small, named for existing product behavior, and use React,
Router and TanStack Query already present in the codebase. I found no new generic
framework or duplicated backend policy in these reviewed paths. The large
pre-existing page modules do not justify an unrelated restructuring in this PR;
R1 is the bounded readability correction required here.

## Test meaning and limits

The mutation suite uses the installed MutationObserver and its offline queue,
then changes observer options before resuming; it asserts actual SDK target and
cache invalidation scope. Export tests use a real QueryClient, deferred old/new
reads, failed recovery and a competing page query. Draft/Undo tests distinguish
late responses, principal changes and consumed receipts. Feature tests compare
choices with the real config registry/validator and exercise missing roles,
stale values, scope tokens and non-serving modes. Navigation and form tests
check real component keys, links and server-rendered states.

Those are meaningful unit/contract checks. Structural/SSR tests do not establish
all mounted lifecycle, keyboard/touch or browser interactions. Historical browser
reviews are dated evidence of their original source; they are not a new browser
acceptance of this merge. Current `pnpm check`, relevant serial PostgreSQL tests,
new decision allocation and final patch review remain due before the new PR.
Known server limitations (AI config without CAS, Undo without contact identity,
export-create without durable request recovery, local drafts lost on unmount)
remain explicitly scoped; this restoration does not solve or newly create them.

## Reviewed snapshot

SHA-256 of the following sorted UTF-8 `sha256  path` lines with final LF:
`d1fd7e33aff6a1fbee7fb6db33e9dd93f4332ab40ef42eb32bd1ca968cfbb4a8`. This snapshot predates the requested formatting correction, new
decision and any subsequent publication documentation.

```text
d2899ee72524963ac1dc081f462e44438835ddfc11426332ee6c783f57039427  apps/dashboard/src/App.tsx
264fe777a6b9a94becbb1e0f8bae39e0b07c923cbafbef6b9040725589fd9753  apps/dashboard/src/api/adminConfig.ts
862c01827821914dca000df360af142dd8bafdaa5a5c22c3b2d39bff85dfbbca  apps/dashboard/src/api/ofapiExports.ts
f5317c05c8b6640db6395a74f814743646be79e0ca7f75ab106fe6e38895a90d  apps/dashboard/src/api/pages.ts
b1e7bfeb4444c8b79fffce0f5adaffe4e9ba35be9240e336c9b1967768001062  apps/dashboard/src/api/sdk.ts
39d0bf255cb4ec989f28c1e769c7a13c12c44db39ceba6fce0d11a75f706bd7a  apps/dashboard/src/api/workboard.ts
b947a26cf34de41750da0b2974a09562827ef4617a47d6005966306f4eeaa279  apps/dashboard/src/components/ai/AiPageDashboard.tsx
7b9bab71f675fd27e1da1eea676e72f890b9a35a6f46d42971bb17b0cc8e5dab  apps/dashboard/src/components/ai/AiRunLog.tsx
69753105bf10e2226339b4117bf318a6a89f9dc538a5b0f0d6d07331d085fd3c  apps/dashboard/src/components/layout/DashboardShellContext.tsx
663db009e9e0af8f86aaef3dc494725ab9e1ed0c74ab0866e9515f27576682a3  apps/dashboard/src/components/layout/OwnerRoute.tsx
fa83c6d7394dceec02a72d3849c7b2fcccddcf98892450422192a176e93dea12  apps/dashboard/src/components/layout/ProtectedLayout.tsx
cad9da1d7dc333c08a7fbeea99500ea60160f574abc88f1b4c7c105f07b35b09  apps/dashboard/src/components/layout/Sidebar.tsx
16683943947904d2fa8caf4e1d130382f3164bb3c03f8a8ce96b4322c18c67a1  apps/dashboard/src/components/layout/Topbar.tsx
38c96e9b1f58e6b750b550799d4ef27fc4fa8bd5eb4acd360bd8ddaf9dd2e45a  apps/dashboard/src/components/page/workboard/v2/WorkboardV2Row.tsx
4f7016534b7111e34923dd5b9810f2957a19a73f88dc543cbfc5f6eead476454  apps/dashboard/src/components/shared/ErrorBoundary.tsx
74044d01465c958ca37fb48916b1ebf718467e200fe5a35e77c781f2a50dc7bd  apps/dashboard/src/components/shared/PeriodSelector.tsx
4ad684d8679c6def96b9f57f4191e81144e0b407533d0ba7b63d9b789da42219  apps/dashboard/src/lib/navigation.ts
3074c1eb62747050beb90d55d9796eac408c37d03e51a0784db5e81d4e9e89d9  apps/dashboard/src/pages/AgentHydrationPage.tsx
c344b93783f6e5165f260f637b7b1e8c7761ab83d185ba0a4d40edf3f4ca6cb9  apps/dashboard/src/pages/AiAnalyticsPage.tsx
ab4f90fc5e145e56ba31a27edb3734e6addbfe02ae2995b222878a0744ea0cea  apps/dashboard/src/pages/AnalyticsPage.tsx
541f3e431dc4ff356635880520cd6655e94a36303d899af96a173fb682b05cbd  apps/dashboard/src/pages/DeletedFansPage.tsx
ea7b931c89b652adad719945a23961068a2af7134222d73a04bed99214641388  apps/dashboard/src/pages/FanProfilePage.tsx
959cc64872f1de4728530843531d3041276f51120076c7b9b8669478833e258c  apps/dashboard/src/pages/FollowersPage.tsx
b7c971815307fe2bed5de66beb2a536c9251f452a8c2f12b1f7798dc676a9d87  apps/dashboard/src/pages/LoginPage.tsx
b8de85d554c9235cd1ac6def2b472e70a7b76afda07136692c35f8828e3b16f6  apps/dashboard/src/pages/NotificationsPage.tsx
8d6364becd59747967fbcfec986764f530cb1c05138d10f42a82edf806e645b3  apps/dashboard/src/pages/OfapiActions.tsx
a8b97e4f106ad3430c87d889e785458c1e2258fcf10e4e2e1a3404fc1f4a7b3e  apps/dashboard/src/pages/OfapiCreditsPage.tsx
10fcce34ab51c95eb196bfd364bffbb8d6b0dd3838142963cfdb75c7dad7afda  apps/dashboard/src/pages/OfapiExportsPage.tsx
4fb25283af04f57db46e2049a2942f85b0d65ecb8025ac2e271da031def906b6  apps/dashboard/src/pages/OfapiMarketing.tsx
7adfb52dea50acd80256d9c76f953e4ba3a3c98f41e5250ec66515851accfa1b  apps/dashboard/src/pages/OfapiMediaPage.tsx
5b96694b0442b60fdda7accc0e2c9e2d25f15d6e100aa244affe7882f72035d9  apps/dashboard/src/pages/OverviewPage.tsx
0c3dbc8bf9e9044956a1f64f36f6d1616360b78f5bdf89e7b4a398872da4bc41  apps/dashboard/src/pages/PageDetailPage.tsx
a7d7fa53961472d0575cc8b67b24291072af6b7d6f5d2c49c678dafc0bfc0c52  apps/dashboard/src/pages/SettingsPage.tsx
73b8a351f9ae87c4b4b5c187a2fde0096a2e70681a4048c2ff745ae23e91ec8f  apps/dashboard/src/pages/SpenderAutoListPage.tsx
e3aca14b7df1e35f04881ab2dcd0ef7126cf073cb57d072cf9f22dd3a1af3c74  apps/dashboard/src/pages/SubscribersPage.tsx
58c3c7064c78cdcce77d8304c01925dcb97b57405cc7caa9994b0e29b87553e2  apps/dashboard/src/pages/TopSupportersPage.tsx
233f3e5d602ab3bad3ebc7cbee8de431e7627e423ab87df623b20f9033439151  apps/dashboard/src/pages/TransactionsPage.tsx
63e7dea1f3b268ac564206a833105d7764ededbecf4af6a436f68754d49297a4  apps/dashboard/src/pages/UsagePage.tsx
7bb0f845d0e7b8345ee48c3e22353a3615288eafe89a8a05626bf5bc4cae3be8  apps/dashboard/src/pages/WorkboardV2Page.tsx
0ae3db55b3590b45c527162be17e546fc20cbfa569041a395fc63e727025e99e  apps/dashboard/src/pages/daily/ReadSection.tsx
59d45f653ff0683b0eb444f9be26961dea1ddf8dba0bc76d4b31ab51c37ff133  apps/dashboard/src/pages/daily/fanNoteDrafts.ts
4987101620feb5762269248315fdffa730260d495e31dd8c516549e55aa63399  apps/dashboard/src/pages/daily/workboardKeyboard.ts
5daf40b152d6668c4d1e5eb48360fdb8aa308fa3bcc7e2c3c6791abb6482cbeb  apps/dashboard/src/pages/daily/workboardUndo.ts
139dbc28b4cba21e89bd44d5833cd15bd31bd0362fab3207fe891083aa5c0cad  apps/dashboard/src/pages/dev/DbStatsPage.tsx
076755f661f303815c23d1d51eb206b455c6c55da72942a3372099fbaa29a09e  apps/dashboard/src/pages/dev/IncidentsPage.tsx
cf134eba24bcee9ff6c76352233283d90552caa7396fa804e28cf41f01180836  apps/dashboard/src/pages/dev/LogPage.tsx
ca2cb837f6cc3643c62b484c5ca084cb7c56862487a0612a978c893cee220f54  apps/dashboard/src/pages/dev/QueuePage.tsx
1f0ea01da9994613dd617b5c9d4aee5ddf6c708e415705cbe6536ef78c8b9eb8  apps/dashboard/src/pages/dev/SyncStatusPage.tsx
e04f97300f85b66326f664f447e94e0c06f647125b973fbf40307edb8831182b  apps/dashboard/src/pages/notifications/NotificationsIncidentsTab.tsx
7ef09ec23bd80a4afebf36b919eeecd96c237bf16340259440e6b338a1d1df38  apps/dashboard/src/pages/notifications/NotificationsReportsTab.tsx
a34eb607998ac35ceb7c682f99a4b33deb129ea8b77f694d05afd5d0201f6d58  apps/dashboard/src/pages/notifications/NotificationsSettingsTab.tsx
56cafa2a5ba152966cc3229d4650097101acd128282a1e77d8b560199570689a  apps/dashboard/src/pages/overview/PageSources.tsx
3fb088cacf00836e2d347b6595ae48e068be03e36d3f2b649d65eaeaedd92044  apps/dashboard/src/pages/settings/AgentKeysTab.tsx
cfce0844c592684ee44cfebf6c575748ce6e6d3c0678b77ff39192864db40c02  apps/dashboard/src/pages/settings/ConfigChoiceField.tsx
263600204aedc1e514d69983890a75a1c0de78b0038816bdee98530b06b2a485  apps/dashboard/src/pages/settings/ConfigurationEditors.tsx
181f5f8c7c004feb81deea0b9edd8ad8002ddc319c246cdaf071c06958245e09  apps/dashboard/src/pages/settings/ConfigurationTab.tsx
ff587831521cbe75f7acd05f1ab8f8b36069fb0113709a7f0485751b601f0a36  apps/dashboard/src/pages/settings/CreatePageModal.tsx
29b57f72a0c4801c771b408c8521b39ab5c62b5db915071bbf3891ec5c535e31  apps/dashboard/src/pages/settings/CredentialsTab.tsx
e9dab5442b09046a89ac97d0260e292a0b3421d6f4121deb7809712d24cd921c  apps/dashboard/src/pages/settings/FeaturesTab.tsx
2e456b008c776587c77dcea891efcec2581c2f57888bab3b10c649e22baa7ea7  apps/dashboard/src/pages/settings/OfapiBannedWords.tsx
30d0a6f1a402ad189083a32791c19a233bdfb75ce1ce72cd2217bc626fcb694f  apps/dashboard/src/pages/settings/OfapiContentEvidence.tsx
d5795aa5d25fccb0dde23444a8637d4742a653459b4b75541bad4337480556ea  apps/dashboard/src/pages/settings/OfapiStoredReads.tsx
8cd6f87fcd66f8286f168a750c92476fac3a83ead851dfc181162830452d3405  apps/dashboard/src/pages/settings/OfapiVendorEvidence.tsx
5e7fa53f92b711549960eab6c241a8d3fbe93157eaa9808d34b2fe921dde8f9f  apps/dashboard/src/pages/settings/OfapiWebhookRecovery.tsx
76618d2a949eff2028a4b6cb63d9da52dca625ac8d882b6f9f6cda7cbae8c0c8  apps/dashboard/src/pages/settings/PageAssignmentsEditor.tsx
bee0680e9eded2f5bff573de6b1dabb14b82dfbe8c59ecb0dee8ae4d7ce4dcca  apps/dashboard/src/pages/settings/UserPageAssignmentModal.tsx
c90b72e3d7d65f6526daeff7a493b5f7b0044b45c6148f8609d6597fb4380eb2  apps/dashboard/src/pages/settings/UsersTab.tsx
cf035e32cd0585df88f2ee70edf916d595f4ecbe498364ab699a35419be63d69  apps/dashboard/src/pages/settings/collection/CollectionTab.tsx
579164c504c2cabf541eb8c3e3d86ba6a83239afcb3e5c742fb0eb6341719c2b  apps/dashboard/src/pages/settings/configurationChoices.ts
3cd8e33906c01bea865dd9f4381739488854381d247ed29635ff48b087cd7a71  apps/dashboard/src/pages/settings/featureCatalog.ts
2ed06a07b65bdb8b9dd721fccd0a6c44b25640f48c49483790671891494b5160  apps/dashboard/src/pages/settings/features.css
04766e9279e70f30636fabc3857f6865e8262ff456d64c71c5578d8bb9157679  apps/dashboard/src/pages/settings/featuresView.ts
91a8d08c02bda3a0899b9f0ae41342f56adbc4016091d14b0e593fc855586035  apps/dashboard/src/pages/settings/sync/SyncPageDetail.tsx
f5c003db4b610c34a76b707fdaeca0a66febe0113acbcb7fe5e64e99cccabaf5  apps/dashboard/src/pages/settings/sync/SyncPageList.tsx
639ed915ad186c075e75ca0e1eeb88671a7503af22695fb6b69666f70a1bc728  docs/decisions.md
6e0ef568f6edd77bf1198bb6342a2cf15fb1b3830c1064a7f9a3d6535814f2d8  investigations/feature-controls-2026-09-11/ADVERSARIAL-REVIEW.md
83cb53de4d822be70787267c6d61e09db886357e80844d5ef91c17d85b9c8002  investigations/feature-controls-2026-09-11/CODE-QUALITY-REVIEW.md
7ae5d72bc46683474d2741c45806e089a8d6455f2faeb327597763b83c4272d0  investigations/feature-controls-2026-09-11/INVENTORY.md
d83b9edcd0237a829906f88f390911455579da7aec72d7c442dcfadca7f7204a  investigations/feature-controls-2026-09-11/PAGES-REVIEW.md
aa98668cb2a07cc41bf38eafc16e39ba2f8a6a9ef5103b75d6cc5759264e45ef  investigations/feature-controls-2026-09-11/REPORT.md
069b48d90561cd7320abb0e864e7fc1ed861e4dd3da833db6c16560d6739914e  investigations/feature-controls-2026-09-11/SETTINGS-PRESERVATION.md
8260bd2a7d2a91d6fe53f766f685ed4b6c2b6073e2c8e5850fbff28902fc7b3e  investigations/feature-controls-2026-09-11/adversarial-configuration.md
a51fffae327ba4a06b12e2e1ebf4bf0edd232dff29e14997bef34d4f061da167  investigations/feature-controls-2026-09-11/adversarial-mutations.md
5b9de9daa7ea79cfc5c9af10e389f918d61cfb6f443cd684045f29fcaf94aa56  investigations/feature-controls-2026-09-11/adversarial-navigation.md
9731480370b1892b257168165b6d101ec7487bb8440bfbf8325ade79d943473b  investigations/feature-controls-2026-09-11/pages-analytics-operations.md
0da62650b4ac293cdc292ce42833efa1139a829b8ba0b87ce700abf49924ce33  investigations/feature-controls-2026-09-11/pages-daily.md
41df95b885fd3655162354ec2a4f760e41cad1b3ef3ff3613737061af3937742  investigations/feature-controls-2026-09-11/pages-settings-diagnostics.md
c6c9c9e42d94981a3f013e4b5bb2df905dc43c24f07a7c973330569d16c08e92  investigations/feature-controls-2026-09-11/pages-shell.md
c0a420bf076a2d943e54fbe194deaebccd99947b9680a84fd60f66e5f0adbe92  scripts/strictness-ratchet.json
3a51045768f83985f9512a1850e8a1b498de8a80cd0e8906bc5e455dfbca9ac4  tests/adversarial-configuration-state.test.ts
dc6081e6f51744444aaadd4236dd9302c7f3e2a7c30a2c23c28cc7cbd0d5710f  tests/adversarial-mutation-intents.test.ts
f1d2125b2b19a0b9d5a503af96f3e9209b18ecbe5aaf516c4248d7b70f206a2b  tests/adversarial-navigation.test.ts
a7a25c89e33f73421078b1b2e5d41b0619b7dc90f2e0ca15d63fe5e5458c5aa7  tests/adversarial-webhook-recovery.test.ts
d50d248b8f95f9242863dcc090def59c3fbd1bcda9a0104c6a146b3c0d729adc  tests/dashboard-analytics-operations-review.test.ts
25c502136f2599fdfaf9b9c3e63588384c7c0a7f7caf820b83fc57fd215a947d  tests/dashboard-daily-page-review.test.ts
d3dd644f908e667bbce065420dcfa0fed860abc21d3e9523726b1245f1ed0445  tests/dashboard-export-recovery.test.ts
f35622261ad6dc94a81eaaf7ecdedd3dff912dba4a2af9fa911782d7bf55f554  tests/dashboard-fan-profile-page.test.ts
47d2e680cd95f4a28beb7cd44a2ff777bd4a1c8195d0f2d7d9d9fe8b2dd635c3  tests/dashboard-features.test.ts
6762b557d60d3fcd4b7cf5248af21518c51c36414020ad8e5c8c658587f1b2de  tests/dashboard-period-navigation.test.ts
4257d5ee3d57744bdb3970af9857ec2fc3c9348df193d82e62474682b8e8f16f  tests/dashboard-settings-diagnostics-review.test.ts
d8682b7682cae657f2adcb4885d66acb1743057659b9ca8cb5acbb52917b4d73  tests/dashboard-settings-navigation.test.ts
02c386e5139da966011fe7e29650b1e4a10226fd60ec18231526ce7ded828e8e  tests/dashboard-shell-review.test.ts
7a73dc6be0b22afe0b706fd862838b6d5ed47ceaf87728c9fef98759a41390b4  tests/dashboard-sync-layout.test.ts
2e1730147d9523428d9f70a9c27b9d1f74ea89833a9f0fc0ca5022c750bf3618  tests/dashboard-sync-surfaces.test.ts
```

## Follow-up: R1 closed

Independently inspected the correction against production source `380326368fe3`:
one diff hunk expands only original lines 166–167, from two lines to 102. All
other imported source/test files remain byte-identical to production. The source
manifest and report now accurately describe 102 byte-exact files and this one
formatting exception. No new/touched dashboard line exceeds 2,000 characters
when compared with the pinned import base `0a08365f`.

I independently transpiled both source versions with installed TypeScript 6.0.3
and compared every emitted JavaScript AST node kind and leaf text, including
compiled JSX child strings. They match exactly. A preliminary comparison of
printer output differed only in retained line layout; it was not treated as a
semantic difference. The AST comparison removes that formatting trivia.

- Original file SHA-256: `4fb25283af04f57db46e2049a2942f85b0d65ecb8025ac2e271da031def906b6`.
- Corrected file SHA-256: `c5a2f07b87041891935b239fa54560e0795ff2c4b2d7ea44d9de42719a3094d0`.
- Equal canonical emitted AST SHA-256: `1e044fd7acc2be98707f5e73d8f273b535a7350c48c33e68963991abd5a6448e`.
- Updated source-manifest SHA-256: `c80259eb97baa6447331fe2aa35565dc6cf6774c03b780d516d1b5faf7227dac`.

R1 is resolved without behavior or dependency changes. No application suite,
browser or production action was run for this follow-up. This approval covers
the narrow formatting exception; final main integration, decision allocation
and planned candidate validation remain separate requirements.

## Follow-up: merge with current main and Decision 323

Read-only follow-up on local merge `8d9606ca75316d2d8d2e4e5f4c999fa63c3ac00a` (original source import `ec12875b`) with main `478fca4220d3d07d61a9200d1860316e770cb4fe`, plus the uncommitted Decision 323. No new findings.

Independently rehashed all 103 imported paths: every manifest candidate hash matches the worktree; 102 files still equal production `380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`, with only the previously reviewed Marketing formatting exception. Runtime, packages, Dockerfile, workflows and all three deployment script paths have no diff from this main. Main decision sections remain exact (the quick-reference table has additive entries and retains every main row); historical Decisions 296–300 remain exact to production. The merge therefore does not change the previously reviewed source behavior or replace the performance restoration.

Decision 323 accurately limits this transfer to the five historical dashboard topics, identifies the 102+1 formatting relationship, requires current validation, and introduces no flag, backend behavior, migration or production permission. Its reservation follows the coordinator's separate Decision 322 topic and still needs normal publication sequencing.

Reviewed `docs/decisions.md` SHA-256: `ec180657733f85d63b5d853fa18c21140fa93a3806aa5ef7e402fbe719603379`. Reviewed manifest SHA-256: `819f99e75c995aeb75291cd042de1481b6e54023462880f2dc6be1353fb4f784`. The manifest now records the author's successful 3,574-test check (9 skips) and 153-test, 12-file PostgreSQL run; this reviewer did not rerun those commands and this follow-up independently establishes source/document composition only.
