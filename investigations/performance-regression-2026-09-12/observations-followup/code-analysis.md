# Independent code analysis: repeated observation reads

Read-only review of release `96a86c1fcdde` at `/Users/dmitriy/code/goose/.worktrees/hub-performance-fixes-20260912`. No source edits, tests, or production probes performed by this reviewer. Production counters and metadata below were supplied by the coordinator; actual query plans remain the acceptance arbiter.

## Finding

The dominant monthly-PK fetch counters are consistent with the replay selector's physical access path, but the counters alone do not identify a query. `listObservationsForReplay` filters a parse-version range, one source and usually a set of kinds, then requests the first 200 rows in global numeric observation-id order (`packages/db/src/repositories/domain-events.ts:1036-1075`).

The current indexes offer either id ordering without parse/source/kind keys (monthly PK) or parse/source/kind filtering without id ordering (`0144`: `(parse_version, source, kind, received_at)`). An empty family is particularly vulnerable to an estimated-small LIMIT plan that actually walks the whole PK to prove absence. The coordinator reports parent `reltuples=-1`; parent estimates therefore merit investigation, but this reviewer has not attributed the plans to missing parent statistics yet.

Adding only `(parse_version, source, kind, id)` does not alone guarantee a bounded plan for the unchanged SQL. A parse-version range and multiple kinds cross index prefixes; the suffix is not in global id order. Forcing filter-then-sort for every family can replace an empty-family problem with repeated sorting of the large unbound webhook corpus.

## Existing precedent and candidate

`apps/runtime/src/services/health-floors.ts:96-176` already documents and solves this same range-versus-order problem for the oldest-pending timestamp: one equality-bound `(parse_version, source, kind)` lateral probe per version/kind, followed by an outer aggregate. It uses `0144` and has an actual-plan test in `tests/minutely-job-query-plans.integration.test.ts`.

Subject to representative old/new plans, a replay counterpart is a defensible local optimization:

1. Add a parse-leading replay index `(parse_version, source, kind, id)`, with `received_at` available to identify the exact physical envelope. Include `account_id` only if supporting scoped selection through the same covered path earns its size/write cost.
2. Probe at most `limit` eligible ids per equality-bound version/kind prefix, then choose the first `limit` globally by numeric id. A prefix cannot contribute more than global N to the global first N; this retains the exact ordered result.
3. Fetch full envelopes only for the final selected page, in the same SQL statement, by **both `(id, received_at)`**. Avoid fetching a page of large inline payloads for every prefix and then discarding most of them. Return the same fields and qualified numeric `ORDER BY` as today.
4. Preserve every account/time/cursor predicate before each per-prefix LIMIT. An account/time filter applied only after candidate limiting can drop eligible rows. Dedupe input kinds: existing `IN` treats repeated kinds as one.

Do not silently copy the health-floor's `generate_series(0, version-1)` into this general repository function. The observation table has **no `parse_version >= 0` constraint** (`0054_observations.sql:23`), and this API currently means all integers below its upper bound, optionally above the supplied lower bound. Negative versions, sparse/high versions, fractional or huge caller bounds need exact existing semantics or the old-query fallback. A schema constraint solely to make this optimization easy broadens the change unnecessarily.

A possible way to preserve all stored integer versions without generating an unbounded range is an index-backed recursive next-distinct-version probe: fixed source/kinds and parse bounds, ordered by parse_version, next iteration `parse_version > previous`. Then probe each actual version and deduplicated declared kind. This needs a real plan proof; do not assume the recursive access path is efficient. Exact observation-id reads and callers without source/nonempty declared kinds can initially retain their proven original path. `kinds: []` currently means unrestricted in this repository function; changing that to no rows would be a behavior change.

No persistent cache, binding-wait status, version stamp, cursor reset, received-at horizon or exclusion of unbound rows belongs in this fix.

## Query families and entry points

Registry is `apps/runtime/src/services/canonicalize/index.ts:151-289`: 13 families. The sweep generally adds two query passes because earnings and sync split capture/replay.

| Source / lane | Version range normally queried | Kinds |
|---|---|---|
| ofapi_capture / read_collections | `< 1` | ofapi.collection_read_response.v1 |
| ofapi_capture / ofapi-posts | `>= 7 AND < 8` | ofapi.posts_page.v1 |
| webhook / ofapi | `< 5` | declared webhook kinds |
| pull / posts | `< 8` | posts, post_tips |
| pull / earnings | capture `< 1`; replay `>= 1 AND < 7` | fan_earnings_stats, fan_earnings_monthly |
| pull / sync | capture `< 1`; replay `>= 1 AND < 6` | earnings_transactions, dm_messages, purchase_history |
| pull / stats | `< 2` | 11 declared stats kinds |
| pull / engagement | `< 1` | notifications |
| pull / catalog | `< 3` | 10 declared catalog kinds |
| pull / comments | `< 1` | post_replies |
| pull / payouts | `< 1` | payout_methods, payout_requests |
| command_result / result | `< 1` | every kind of source |
| client_capture / desktop | `< 2` | 13 declared desktop/harvest kinds |

Additional consumers of the same repository selector: `ofapi-dm-readthrough.ts:375` (readthrough kind, below v2) and `ofapi-capture-materialization.ts:168` (two ofapi_capture kinds). These restart their local traversal at the head per run. They need equality/result tests if the shared selector changes.

## Required regression boundaries

- `canonicalize-driver.ts:445-507`: keep disjoint capture/replay predicates, reserved turns, continuation borrowing, original page/time allowance and opposite-turn persistence. A SQL optimization should not need driver edits.
- `canonicalize-driver.ts:524-545,753-755`: preserve exact ordered page, empty/partial EOF and page-level cursor CAS. Empty and partial pages wrap; full pages resume forward. No early negative cache or exclusion may hide late binding repair.
- `canonicalize-driver.ts:280-290`: source, lane, parser version, requested version floor and all query scopes form durable cursor identity. Leave identity unchanged when row set/order are unchanged.
- CLI/exact/dry paths retain existing deterministic eligibility and no background cursor reads/writes. Exact-id lookup should remain cheap.
- Preserve simultaneous `accountId` and `accountIds` intersection, null-account behavior, explicit empty account set, time half-open interval and strictly-after id.
- `canonicalize-driver.ts:548-560`: the previous release deliberately reads mapped payloads individually at their own processing turn. A new selector must not resolve/prefetch catalog bodies. Full envelope retrieval in the same original listing statement does not justify widening payload-reader lifetime.
- Join by id **and received_at**, keep id numeric until presentation. Do not join by `id::text`; do not introduce bare `ORDER BY id` after a text alias.

## Migration and verification

Follow `0144_observations_health_floor_idx.sql` rather than plain parent `CREATE INDEX`: no-transaction migration; parent `ON ONLY`; concurrent builds for currently attached ordinary leaf relations; cleanup only deterministic invalid candidate leaf indexes; attach leaves; future `PARTITION OF` creation inherits the parent index. Last migration is `0186_ops_metrics_recent_series.sql`, so next available is currently 0187. Preserve existing indexes and detached/parked partitions.

Keep `parse_version` leading. The `0144` comment records a real regression from source-leading indexing: the harvest lookup selected a broad source index instead of its narrow typed/legacy partial indexes. `tests/capture-queryable-columns.integration.test.ts` is therefore a mandatory collateral-plan check for any new observations index.

Benchmark first/deep/empty and dense-pending cases with actual generated SQL, matching results and buffers as well as latency. Include a large settled majority, large unmapped webhook prefix, positive-version replay, mixed versions/kinds, multiple months with id order crossing receipt order, negative/sparse versions and scope edge cases. Run the same selector with old implementation as a result oracle. Existing cursor/budget, capture CAS/erasure, readthrough/materializer and minutely plan tests provide relevant integration coverage. No parallel DB suites.

This review establishes a plausible code-level cause and safe design constraints, not a demonstrated speedup or approval of an unimplemented fix.
