# Independent observation review

`review_pr162` independently checked C1 raw receipts, both pagination manifests,
the combined timeline, source, worker logs and final C1 report/STATE.
`quality_c1` independently checked A0 raw data, manifest, cohorts, source and the
final A0 observation/STATE. Neither reviewer ran production operations or tests
or changed product code. Both final reviews are closed without open findings.

C1 verification covers 500 + 101 unique ordered runs, pinned upper 728676,
cursor 727169 and distinct per-page snapshot times. Aggregates are taken once.
All 133 valid decisions, 20 clean-queue requests, 20 linked exact-generation
terminals and two additional scheduled terminals match the evidence. Missing
decision 726189 and failed reconcile chunk 724951 remain visible. The new Ari-1
OR combination does not establish why its checkpoint was absent. A trigger
suppression, a redundant generation or actual deactivated identities are not
claimed. Both worker-log hashes and the 34/34 summary join were checked:
146 attempts are a subset of the cumulative 2384, with no double counting.

A0 verification covers 277 sweeps: 43 complete and 234 incomplete. The 20
post-worker sweeps contain 16 complete and four incomplete; all 100 unknown
material checks belong to Lora-1/4785. The other three incomplete sweeps have
either an overlap guard or no boundary, despite zero unknown checks.
Lilly-1/7356 is the only completed sweep with a state change below virtual stop.
The exact subtype is unknown and loss of a new message is not established.
Lora-2's two new lost-report receipts describe diagnostics, not message loss.

The current source's projection-age calculation and 5-second material timeout
match 2c6b42b7. The earlier local P2 proof remains applicable to the unchanged
query, but a missed production alarm has not been measured. Ordinary runtime
health and an image/source label do not prove the new release's deploy gate.
The historical successful 66d6 gate and new unknown gate are explicitly separate.

One P3 wording finding was fixed and re-reviewed: the C1 report originally
called the hashes of report.json files "manifest hashes". The final text
correctly names them report hashes recorded in the manifests. Data did not change.

Both reviewers confirmed the evidence boundaries: no measured provider-event
freshness, HTTP savings, A0 acceptance or justified C1 suppression. The task
remains diagnosis only, with the original A0 calendar gate preserved.
