# Independent review

Two existing reviewers worked read-only; only the coordinator ran tests.

## Correctness and data boundary — review_pr162

Reviewed the parser, payload-storage seam and migrations 0186–0188. The initial
review approved the six-field sanitizer only if complete `{events, rejection}`
behavior, numeric JSON types and row ordering are preserved. Real PG regressions
compare both parser results, including partial-invalid inputs and fingerprints.

Two P2 findings were fixed and independently re-reviewed:

- Attached-only inventory could silently omit retained detached data. The final
  scope inventories observation and event partitions and counts scoped rows in
  detached tables. Empty historical monthlies from migration 0077 stay visible.
- Compressed `pg_column_size` did not bound decoded JSON size. CAS catalog size
  is now checked before body lookup; compressed bodies are explicitly unavailable
  before text/array expansion. Unknown data cannot pass the audit.

Unexpected nested event fields are withheld through scalar guards. Final SQL
re-review found no actionable issues. Full export and receipt-join costs were
left to local measurement; production performance remains unmeasured.

## Readability and operation — quality_c1

Reviewed the reader, exporter, comparator, parser/projector and PG fixtures.
The reviewer found two actionable defects:

- Waiting only for child `exit` could hang forever after spawn failure or a
  process ignoring SIGTERM. Cleanup now observes spawn failure/close and has a
  bounded termination/escalation path. Export success follows clean cleanup.
- An empty-only corpus could pass with no compared fan/window. Verification now
  requires a nonzero matched count; a provider zero remains a valid matched row.

Both were fixed and independently re-reviewed. The reviewer found the small
module boundaries appropriate. Tests cover
spawn ENOENT, ignored SIGTERM, clean EOF, failed collection/cleanup and empty-only
results.

The final pass found three test/documentation issues, also fixed and re-reviewed:

- The final equal-time update concealed intermediate A-B-A and stale-arrival
  failures. Each intermediate result now checks the audit and exact source ID.
- The scale-test title claimed partition coverage while its captures use one
  month. The title now describes only the exercised batch pagination.
- The old execution record mixed its historical stage states with the new C2a
  row. It now dates that update and labels the other statements as historical.

Final review: all findings closed; no new defects in the re-read changes.
No reviewer ran tests or made production calls. The coordinator subsequently
passed `pnpm check` and all 44 relevant Docker-Postgres tests; see VALIDATION.md.
