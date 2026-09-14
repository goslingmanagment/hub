# Independent paired-metadata review

Reviewed at 2026-09-13T22:52:04.229514+00:00 by independent agent
`w0_role_tests`. Verdict: **no remaining actionable findings in this source
scope**. This is a static correctness, privacy, bounds and readability review;
it does not certify a live paired observation or completion of W0.

The reviewer did not edit implementation/tests, execute tests, start sockets,
read production, change flags or create a commit during this review. The earlier
C2b read and earlier DB-test implementation are separate tasks. The paired
comparator, key plumbing and launcher changes reviewed here were authored by
other agents.

## Finding and closure

P2: the initial comparator examined only retained records and omitted the live
probe's receive/retain counters and termination reason. After one valid service
frame, a dropped oversized frame could produce `incompleteInput:false`.

Closed on re-review: live counters must be safe integers with nonnegative
retained count, received >= retained, and retained exactly equal to array length.
Missing receipts are preserved, and any non-deadline stop marks interruption.
Either condition contributes to `incompleteInput`. The regression fixture
retains a matching reference alongside one dropped frame, requires incomplete
input, and then checks rejection of inconsistent retained counts.

## Checked invariants

- Both export paths compute the same domain-separated fingerprint from actual
  32-byte experiment-key contents; unequal or missing fingerprints refuse
  comparison, including when records are empty.
- Operator-supplied windows are explicit and strictly validated. Comparison
  uses their half-open overlap; live declared windows cannot exceed the probe
  timestamps. Offline windows remain supplied evidence, not certified capture.
- Keys include service, event type, reference field and HMAC entity ID. Group
  references are not matching identities. Repeated references remain ambiguous;
  no greedy occurrence pairing is used. Entity matches never imply event
  identity, payload/version equality or independent receivers.
- Empty/control-only input is inconclusive. Excluded, malformed, partial and
  unknown input remains visible. Fan-out, session equality, account binding,
  receiver independence, event identity, payload equality and capture
  completeness stay unverified even if a report is compared with itself.
- Output copies only fixed field names, validated timestamps/numeric codes and
  bounded HMAC identifiers. Arbitrary input fields, correspondence, provider
  tokens and key bytes are not serialized. CLI failures are fixed text.
- File readers reject public/nonregular/symlink inputs and bound reads even if
  files grow. Comparison bounds records, per-record nodes, references and output
  size. Outputs are exclusive private files.
- The launcher validates the optional key, uses its own exclusive 0600 copy,
  rejects Docker mount CSV injection characters, mounts read-only, and removes
  only the copy. Cancellation/timeout retains owned-container cleanup.
- Changes remain small modules with direct control flow; no new business writer,
  polling policy, receiver retry loop or stage-gate inference was introduced.

## Validation boundary

The retained coordinator targeted run had 46 passing tests and one failure:
Node 26's DEP0205 warning violated an empty-stderr assertion. The reviewed
follow-up assertion checks absence of the synthetic secret while the test still
requires successful execution, valid comparison output and private output mode.
The reviewer did not rerun it. The coordinator owns final `pnpm check`, serial
Docker-Postgres validation and their retained receipts. No live paired run,
fan-out proof, event-to-reader latency or savings result is established here.

## Reviewed SHA-256 values

| File | SHA-256 |
|---|---|
| `scripts/fansly-ws/compare-records.ts` | `af07e74b166c7d257e9c2c02453651d6887b3f471a4bd2cbf8327bb4c9588809` |
| `scripts/fansly-ws/compare.ts` | `310cc0cdb66d28bcc263c5020af5f9e44d682f4fa5255c5006c201600692b78a` |
| `scripts/fansly-ws/compare-cli.ts` | `52227bd73dc0029c73df6626ac0673aa8bda921c690bf65c02beff25514d6e59` |
| `scripts/fansly-ws/correlation-key.ts` | `5eb0308afcdd7bee19c22444515181de0042730eacd5f0b177a0eeefdab84c46` |
| `scripts/fansly-ws/private-file.ts` | `a82dcd5e6f375f62717787964a55d687677ac7ca4ac5fbdfe56c570cc425fa35` |
| `scripts/fansly-ws/report.ts` | `3e08fdedfe8426d11fea23742e8b457067ece92854638b3ed3c716f77fe539f1` |
| `scripts/fansly-ws/probe.ts` | `bbb9b90b3b36c6994e36fef30f4ab38166e2ebc60c299dd90936a4fb89d91799` |
| `scripts/fansly-ws/run-probe.py` | `f90b6834a73832967ef149ec5c36b11c4d9436fa850e0e8899b62bdf92a49d03` |
| `scripts/fansly-ws/diagnostic.ts` | `099b2cf74940a1089c2d81ab38d898b54e3e5daa70543f22e8fe89d435201fbb` |
| `scripts/fansly-ws/diagnostic-fields.ts` | `08a3b7aec6285e44481d849f643d8079c4d55c7de3825025c6fe80e319a627c0` |
| `tests/fansly-ws-compare.test.ts` | `ba51ef8d2e632fa944f40a99102427a34510afc57889fc610e949b3f96acd099` |
| `tests/fansly-ws-compare-cli.test.ts` | `a24f908ae720304dcb25ebd3d3e7e289fc59757cb29b6f21db659e87501e5c3f` |
| `tests/fansly-ws-correlation-key.test.ts` | `de122fdd4f4bf34119c79c3d856dffc89a6549153e45ab51f7276b911d936b1b` |
| `tests/fansly-ws-report.test.ts` | `cf281588de823648e069632180cd007ecfe0a1c33f79e868d7257765c770c1fd` |
| `tests/fansly-probe-args.test.ts` | `5e2a52b39b3c127441298b2b34098ed1e550a9891e669d3c7d20b021dee02f35` |
| `tests/fansly-probe-launcher.py` | `a8ff27dfe58a3930148efd580f72e059e3f5a56a6be6614fc77fa2d6e89610b8` |
