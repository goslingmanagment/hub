# Independent historical-marker read-plan review

**No outstanding findings.** Reviewed the final SQL locally before execution;
no production call, PostgreSQL execution, test or source change was performed.

Reviewed historical-debt-markers.sql SHA256:
`1ec13cd22aaaef2ba3551c891e2ed7000dff2e666bd94a09a13a8ef2d38a8b11`.

## Resolved findings

1. **P2 — Avoid materializing a whole list body per item.** The initial
   MATERIALIZED items CTE carried `s.body` for every expanded data row. Around
   284 list pages with 100 items each could multiply the retained body volume
   by roughly 100 before the target join. The final items CTE retains only
   envelope fields and one item; matches joins sources back after the exact
   target comparison. The avoidable whole-body multiplication is removed.
2. **P2 — Preserve duplicate aggregation-group ambiguity.** The initial
   `LIMIT 1` selected one matching aggregation group without reporting
   duplicates, while runtime's Map retains the last matching group. The final
   query exports a count and sanitized markers for every matching group.
   Multiple matches remain explicit and must not be interpreted as a unique
   runtime head or assigned an array order that SQL does not promise.

## Scope and limits checked

- Independently parsed all 106 literal group/message pairs; all are unique
  and exactly equal the 106 rows in current-debt.stdout. Every saved row's
  scope_count is 106. This is a current uncaptured-debt candidate set only.
- The two exact G6917/G6918 start/finish bounds match the retained A0 report.
  Observation selection is page 5, Fansly, pull, dm_conversations and those
  time windows. Each lateral scan has ORDER BY received_at,id and LIMIT 201,
  with an explicit may_be_capped sentinel. The account/time predicates match
  the existing observation account/received index; no all-history scan is
  requested by the SQL.
- Body lookup uses the retained bucket-month/object-ID pair. Missing bodies,
  malformed data arrays, observed item counts, envelope receipts and source
  idempotency keys stay visible. Empty-window LEFT JOIN placeholders do not
  invent unavailable-body counts because aggregates use count(s.id).
- Array expansion is limited to selected retained responses. The query has
  no explicit per-response byte or element cap, so its statement deadline is
  still essential; the row cap alone is not a hard memory guarantee.
- The exact group plus advertised message ID join prevents pairing one
  conversation with another debt ID. Outputs contain envelope identifiers,
  time, flags and embedded head markers, not message text or credentials.
- Syntax was reviewed statically. The SQL starts REPEATABLE READ READ ONLY,
  sets statement_timeout=5s and lock_timeout=100ms before the one read SELECT,
  and ends ROLLBACK. The coordinator's planned external 8s plus 1s kill grace
  and 20s local process bound remain executor requirements; this review did
  not run or observe that command.

## Interpretation

Neither matching debt markers nor their absence reconstructs the historical
reader snapshot. Debt may have been captured later, already closed without
being reopened, or affected by an erased thread or a concurrent material
write after the diagnostic read. Absent source bodies, a capped window,
malformed arrays or duplicate aggregation groups remain explicit unknowns.

The observation idempotency key supplies the producer's run/sequence envelope,
not request offset. Matching windows and page counts alone do not prove a
specific candidate appeared below stop. A present raw head also does not prove
it was readable before list application. Current reader checks, exact historical
pre-apply state, provider loss and provider deletion are separate claims.
