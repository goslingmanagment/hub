# Independent PR196 post-release review

Reviewed 2026-09-14T17:45:30.224115+00:00 from retained local files only.
**No actionable findings.** No production calls, tests, state edits, Git changes
or new deployment were performed by this reviewer.

## Release identity and bounded health evidence

Merged source `ac92197ba9760833ae035c3f5e8a90d084010fe6` and the tested
publication `9aac9988e6998ee8c16e7e313d733fb62d731a7c` resolve locally to the
same tree `fd06403e36223f6db36f6b0ac9b916fcd2f108e0`. The retained standard
`dist-only --recreate-scope apps --no-image-gc` deployment exited zero;
wrapper timestamps are 16:26:37.336666–16:29:31.792898 UTC. The log records
successful service, sync-health and dashboard verification and production-pinned
local CLI rebuild. It does not establish indefinite future health.

The 16:30:33–35 UTC Docker sample reports all three application roles running and
healthy with restart count zero, source label `ac92197ba976` and image
`sha256:ca60d6371efa39d256c929eec025f05d78edf97dba21076b82f58b1f5f8cc01d`.
PostgreSQL's retained image, startedAt, state, health and restart-count values
are byte-for-byte unchanged from the preflight sample; the deploy log also says
it preserved that service. Container IDs were not exported, so no stronger
independent identity claim is made from the Docker samples alone.

The schema export used `read_only` in REPEATABLE READ READ ONLY with 5s statement
and 100ms lock limits, an outer bounded psql process, and ROLLBACK. The after
ledger has 190 records: every prior 189 ID/appliedAt pair is unchanged, and only
`0194_fansly_dm_shadow_reader_probe.sql` was added (DB timestamp
16:28:50.211272 UTC). Reader-probe presence and EXECUTE are true; existing
material-probe EXECUTE remains true; direct message-table SELECT remains false.
The receipt does not export the production function definition, so exact
function-body identity rests on the release/migration provenance rather than a
separate live definition hash.

The configuration GET is read-only and records the same allowlisted values for
API, worker and scheduler: A0 on six pages, C2b on Lilly-1, head catch-up `none`.
Its observed/generated/instance heartbeat timestamps are distinct. It explicitly
retains unknown applied version and historical continuity; overrideVersion and
active role status are not promoted to that missing proof.

## Six SQL-cost samples

The collector hash matches the previously reviewed tool. All six calls are
serial, page-scoped, max 100, `read_only`, REPEATABLE READ READ ONLY, statement
5s/lock100ms; retained remote psql has an 8s limit plus 1s kill delay and local
remaining-budget bounds. Total local collector elapsed is 12.913s under 45s.
All calls exited zero with empty stderr. Independently verified all 20 runtime,
schema and per-sample stdout/stderr hashes and every sample-to-summary field.
Each sample has 100 unique conversation IDs and 100 unique conversation/message
pairs, a single EXPLAIN plan, and 100 root output rows.

| Page | Sampled heads | Planning ms | Execution ms | Shared hit/read blocks |
| --- | ---: | ---: | ---: | ---: |
| ari-1 | 100 | 15.761 | 128.655 | 1175 / 109 |
| lilly-1 | 100 | 5.109 | 4.818 | 1324 / 0 |
| lilly-2 | 100 | 5.117 | 70.977 | 1113 / 141 |
| lora-1 | 100 | 4.905 | 122.460 | 1035 / 270 |
| lora-2 | 100 | 4.821 | 96.664 | 1224 / 128 |
| lora-3 | 100 | 4.992 | 143.473 | 1102 / 188 |

These are one-time EXPLAIN measurements of the fixed exact-ID state query for
current stored visible heads, selected at each page's own transaction snapshot.
They are not the provider list's pre-apply candidates, six simultaneous snapshots,
a reader completeness result, or a representative hot-path p95. The plans include
mixed cache hits and reads; calling all samples warm would be inaccurate. Inner
Execution Time excludes planning, sampling, connection and outer function/CLI
cost. The approximately 2.0–2.5s local call times include SSH/process overhead and
are not reader latency. Remote DB timestamps and local receipt timestamps show
small clock offsets and must not be subtracted into cross-host latency.

The summary correctly leaves reader completeness, event-to-reader latency and
savings false/unmeasured. This SQL-only preparation makes no provider requests;
it does not change the original A0 clock or satisfy A1 acceptance. New emitted
reader counters require their own cumulative-report evidence and review.

## Evidence fingerprints

The 20 recorded stdout/stderr hashes were checked against their exact raw bytes.
All ten stderr streams are empty (SHA256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
Additional retained evidence and raw SQL are pinned below; timestamps and hashes
identify this review's snapshot and do not claim continuously frozen production.

| File relative to release/ | SHA256 |
| --- | --- |
| `deploy-execution.json` | `18a13cebd5652c86127b3b6cac0664c1325e1295b2f11d28f4d4ce197318ff36` |
| `deploy.log` | `5afab89ddd3808a6a400cd66a3d90f2366bb11fa15737860d1ee030fa6ce9a3c` |
| `runtime-before.execution.json` | `fe0fad9029a54b8fc95b159070c4a66a90cf597ce32fd99073f8bf23586ea208` |
| `runtime-before.stdout` | `e4c4b4e18200ec02919c9b6b59b4404bb1c83cd3dfde60fffb07638fa2f1169e` |
| `runtime-after.execution.json` | `bbece3cfbe3bc74b6dbb79c0619d7c4e179358078b89b36bc4ec23470d205f2a` |
| `runtime-after.stdout` | `69102d14be9618b8c4fe67f66f6a1c16236aa97fd24e7afa81b9ea8d4212ea1a` |
| `schema-before.sql` | `1e7beb3ec3be9ae0770e1ec3e04a949c884779d5824df589bfc5f412c5fe66d7` |
| `migrations-before.execution.json` | `321ce01c5b637b3cd172e6dd5b2234e73131ae282a8abacc4e61ece88a901feb` |
| `migrations-before.stdout` | `93d6b0cc7b225d0257f8c8c4cf22621c080ad7fe28dbc57a16807ecdab48ab41` |
| `schema-after.sql` | `08cdec3bad9d1118aa2d654cf329c1f7fb8c68457be0a8eccbfa0d9c2fd3f743` |
| `migrations-after.execution.json` | `726d21ccdd72497893b723d4fd90ca400838a45738610d056c892f04fdd11772` |
| `migrations-after.stdout` | `5dfe154e901ac210826fec9feac3872313a902c8587545c3de3d8d179cb56a10` |
| `configuration-read.json` | `fd1d8a6c4ef5d857adf6eb751f3117d15794ecef5cc4a7bc8f3017b58faee620` |
| `measure-reader.py` | `44328e9c31f1044d14987f3f20e7c5fb101b66348f9290cb935b07167bf26ad5` |
| `measure-reader.execution.json` | `febf6b4761efe7815721fba667f44ad1ae73bd4adc3abd752381d49991894a5c` |
| `measure-reader.log` | `ce425d9ea0ef0f6c8416976d96f75cc0c83452a19bdb494038817161fc411b1b` |
| `reader-cost/summary.json` | `77bf481e5c9edd8ccd54147313c62e75072dd49ba4f965dea35bc31ec1d00ee3` |
| `reader-cost/ari-1.sql` | `48b0fd4b4a8841cd352e5d75b57c7e89cda9949113d01d6e62499f260b20cb32` |
| `reader-cost/ari-1.stdout` | `b91d5d6f8de5fad13c4822ca9b5d40c281cdcbb011cf6a303a0796e0868b5026` |
| `reader-cost/ari-1.execution.json` | `003d106fba2c7fa8173024995461002fd417e8204b335e42be1c7a2ec5d2dfa3` |
| `reader-cost/lilly-1.sql` | `1edc96eb55ced059a0c13a3ec89800d3937895b87679356bb1a1b533cbc24869` |
| `reader-cost/lilly-1.stdout` | `68f63699a2978570ad330382063c06b5d6ae4771e06e2d067969288d6e7e871d` |
| `reader-cost/lilly-1.execution.json` | `9f85648bb0965140340b5baf56d71a093463cd4407a3f1b800ffa9ee667dd3a4` |
| `reader-cost/lilly-2.sql` | `fe89770834a3907bf1926f0afaf6d28b88d2087f73b0ae278731384c233f0ca2` |
| `reader-cost/lilly-2.stdout` | `925d65784f928e063b97cc5b1b7842c7b1047981b83f4b86c3e6ce4e2771568d` |
| `reader-cost/lilly-2.execution.json` | `c3b4752e560decb2736c3f1a4476320b2568b8da55163d62c99d8879fd181d68` |
| `reader-cost/lora-1.sql` | `00f99ca851c1bde33cc3e0b611af77ff57f9af4b806e19afb7e0abd11db658d9` |
| `reader-cost/lora-1.stdout` | `d144913bf77ab5ba955f7eec0e4be025aef8892df035d40f13871281b834878d` |
| `reader-cost/lora-1.execution.json` | `9c0d8330428325a5a5de631814f5221159a33b93ad576bb2cd5ab45691dc0bd3` |
| `reader-cost/lora-2.sql` | `2a97283bc6544cfc2c8c56573ed81d95c8b2dfc3636162e354f28518a5cc6fa5` |
| `reader-cost/lora-2.stdout` | `a5f7429e1a755e4fd7b5a8b6f7b364002c8b4c05a88ef656c7dafe56d39910b5` |
| `reader-cost/lora-2.execution.json` | `f8b24a1542519387e0a4f31bb69d9c47d6a4c04ddd2af4d21683cff6314c3da8` |
| `reader-cost/lora-3.sql` | `800b360b1fd302449344d0e8ead1c6bf810466d14ccf2e6c02167a681031b0e9` |
| `reader-cost/lora-3.stdout` | `89767250cdff1372cedada8f5989c7a373516698cb1813ca14767ef8f170d20c` |
| `reader-cost/lora-3.execution.json` | `021ee28d7afdb45c8bbc4a710fd4ec50a12bf5963f49c225242ad7887ef418bf` |

## Runtime/configuration follow-up and four local state aliases

The follow-up Docker read actually ran 17:42:54.236862–17:42:57.924747 UTC
(approximately 17:43); its stdout is byte-identical to the earlier post-release
runtime sample and both output hashes verify. The configuration GET generated
17:46:09.265 UTC, retained at 17:46:27.830, reports the same three flags, desired
values, override versions, role instance IDs and reported values as the earlier
GET. Its unknown applied versions and historical continuity remain explicit.

Independently compared all four current STATE files with their exact retained
backups. All eight before/after hashes match state-alias-changes.json. The actual
changed top-level fields exactly equal the declared lists; no unlisted field
changed. Every prior runtime-boundary entry is preserved, with one release entry
appended. A0 gets one new reader_counter_release field; existing C1 and C2b
field naming/schema conventions remain unchanged. Existing observation clocks,
counters, qualifying-sweep counts and acceptance gates are unchanged. The new
release field explicitly does not reset clocks, reclassify old evidence or accept
A1. Numeric A0 pointers/counters are a separate pending update, outside this alias
review.

No findings in these updates. Current-value verification is scoped to the UI's
reported role values; it does not establish per-role applied version or continuous
flag history. Local state references to release/REPORT.md are a delivery pointer;
this review does not validate that final narrative before it is written.

| Backup file | Before SHA256 | After STATE SHA256 |
| --- | --- | --- |
| `state-before-reader-release-0.json` | `9ecc87fee29ea34eafd4c9b87e8dce5376d99432f63e9ab82fd367e6115000f6` | `d8472071ad79227268318fe93f310b8d92464994614c3b0f71327c230d813f9f` |
| `state-before-reader-release-1.json` | `e18d5c095af60f6a36c863371ec98e5f9edc719e5bdaede272889cecaa7b0207` | `c4ecc53753a8e786a1eb268a932130f679c86bb62544333987e25fa5ba2baad0` |
| `state-before-reader-release-2.json` | `3471f73e541b631c1ed73d6cdb075a259a4d128e1061f20ea23127245e6484a7` | `956e7e8359a77715bd9434a5b399fc60c5fa959e6fd326726ed847e675f8b028` |
| `state-before-reader-release-3.json` | `de1af5793cd02c44c14a0a19ce10ad49daa664aba57720345e8aa9c45cd16a50` | `b2d67673ce709903369e9800d7448a0bf541477229f0697afd6fbb8a81bf7562` |

Follow-up evidence SHA256:

- runtime-followup.execution.json: `3ad69cc5da0366916fbeced2ef5289151f00ace7c3211f8f1f520c2977d26e0a`
- runtime-followup.stdout: `69102d14be9618b8c4fe67f66f6a1c16236aa97fd24e7afa81b9ea8d4212ea1a`
- configuration-followup.json: `094a896602ee942215dd069ca357881c87f015cd171d30ab453b1f52d0687448`
- state-alias-changes.json: `4f02a6cda4e01a22a8d18573efd7e8165f9cb89ffec18404a10fc5349ef8c66e`
