# OFAPI webhook repair: production acceptance, 2026-09-08

## Release and authorization

The owner explicitly approved the prepared deployment and bounded local replay
with “да”. PR [#156](https://github.com/goslingmanagment/core/pull/156) merged as
`a6631a709991c3735daa5ad479443e912bcd99bd`; its tree exactly matched the tested PR
head `d44d54351e5c1d1446c489aab7aaf76ec1e00b55`.

Local `pnpm check` passed (3,090 unit tests, nine existing skips; no added
typecheck debt). The 244 focused tests passed across 25 serial suites. All PR
[CI jobs](https://github.com/goslingmanagment/core/actions/runs/34179509050),
including three integration shards and Quality Gate, passed on that head.

The standard deploy command used `--mode auto --no-image-gc` and verified
`https://gosling-agency.ru`. It completed successfully. All three runtime roles
independently reported source label `a6631a709991` and image
`sha256:7dcfa446a5497c448b94aa7fadf4151e5bcc5e3cd7fc807539d8bbdb207cc695`.
API and scheduler started at 10:10:51 UTC; worker at 10:10:57 UTC.
API, worker, scheduler and Postgres were healthy. Read-plane SQL confirmed
`0171_canonicalize_sweep_cursors.sql` as the latest applied migration.
Root disk: 79 GiB total, 47 GiB used, 31 GiB available (60%).

## Bounded repair

The overnight prepared 170 rows had already progressed on the old background
sweep by the time approval arrived. Fresh pre-deploy debt had accumulated.
The new frozen repair window was
`[2026-09-07T23:45:00Z, 2026-09-08T10:14:00Z)`.

The census included every pending row in that window for the six requested
kinds, without a source or account filter. All 84 rows were normal
`webhook / ofapi:webhook` receipts and resolved by current native binding only
to pages 8 and 9. Their captured `account_id` is null; an `--account` filter
would incorrectly skip them.

| Page | Received messages | Offline | Online | Total |
|---|---:|---:|---:|---:|
| 8 | 2 | 32 | 33 | 67 |
| 9 | 1 | 8 | 8 | 17 |
| Total | 3 | 40 | 41 | 84 |

The deployed CLI ran these arguments first with `--dry-run`, then unchanged in
write mode through `docker exec agency-hub-worker-1`:

```sh
node apps/runtime/dist/cli.js events:replay \
  --from 2026-09-07T23:45:00Z --to 2026-09-08T10:14:00Z \
  --kind messages.received --kind messages.sent \
  --kind subscriptions.new --kind subscriptions.expired \
  --kind users.online --kind users.offline
```

Preview: scanned 84, would append 84, no errors, unmapped rows, binding conflicts
or partition blocks. Write at 10:14:54 UTC: scanned 84, appended 84, stamped 84,
with the same zero error/conflict counts.

At 10:15:17 UTC all 612 non-typing normal webhook observations since the lower
bound were at parser v5: page 8 had 467 and page 9 had 145. Pending current-page
debt was zero. This repair used retained local observations; it issued no remote
redelivery and did not resend messages.

## History recovery

The automatic collector resumed the exact failed scan
`ca170eee-6211-44c5-851e-8d4a3bb4d498` and completed at
`2026-09-08T10:15:30.450Z`. Its original fractional wire bounds remained
`2026-09-07T23:45:27.398Z` through `2026-09-08T00:51:07.638Z`.
The authenticated normal dashboard GET confirmed `state=complete`, offset 91,
`errorCode=null`, and two newly inserted attempts (other attempt identities
already existed). These are 91 examined rows, not 91 new inserts.
The retained successful page is observation 2283035, received at 10:15:29.337 UTC.

The retained page contained all three `23:45:27.000Z` attempts that the previous
fractional comparison rejected. Read-plane inspection confirmed 91 attempts,
earliest `23:45:27Z`, latest `00:47:03Z`.

After that automatic scan completed, the normal dashboard's free last-day read
created scan `0f2bac57-4c75-4a35-b13c-26e3fda2aa26`, with normalized bounds
`2026-09-07T10:20:00.000Z` through `2026-09-08T10:20:00.999Z`.
Its first page saved 100 attempts. A subsequent provider response sent HTTP 200
headers but its body timed out after 60 seconds; the saved offset remained 100
with `history_response_body_failed`. This was a distinct transport timeout, not
the repaired `history_window_failed`. The same scan resumed from offset 100 via
“Продолжить сбор истории”, processed another 20 pages and reached offset 2100,
with 553 newly inserted attempts and no window-validation failure.
The final continuation completed that same scan at 10:23:22.070 UTC: 2,248
examined attempts, 553 newly inserted, offset 2248, `errorCode=null`. The
provider-visible closed day is complete. Later arrivals belong to the next
overlapping automatic window; this is not a claim of global provider coverage.
Independent aggregation of the retained responses confirmed 2,248 distinct
attempt IDs. Twenty-two attempts failed, across 22 delivery UUIDs; every one of
those delivery UUIDs also had a successful attempt in the same captured window.
No delivery with a recorded failure lacked a recorded success in that window.

## Fresh receipt acceptance

At 10:22:20.933 UTC the read plane confirmed four real post-deploy receipts at
parser v5, covering both current pages:

| Observation | Page | Kind | Received at UTC |
|---|---:|---|---|
| 2283202 | 8 | users.online | 10:21:21.892 |
| 2283203 | 8 | users.online | 10:21:22.290 |
| 2283204 | 8 | users.offline | 10:21:25.440 |
| 2283211 | 9 | users.offline | 10:22:13.602 |

The last row was therefore canonical within 7.4 seconds of receipt; this is an
observation bound, not a latency percentile. The surrounding background sweeps
at 10:21:42 and 10:22:46 each scanned 4,000 historical unmapped observations,
appended/stamped zero and remained at old IDs (176756 and 221482 respectively).
Fresh canonicalization progressed independently through the receipt path.

Final read-plane snapshot at 10:23:54.489 UTC: page 8 had seven post-deploy v5
receipts and page 9 had one. Both had zero pending non-typing observations since
the repaired lower bound. All four production service containers remained
healthy; root disk still had 31 GiB available.

The first fresh callbacks arrived after a quiet interval that began before the
deploy. The provider's newest history attempt in the first last-day page was
10:05:55 UTC, consistent with Hub's then-latest receipt at 10:05:52 UTC. No
synthetic webhook, remote redelivery or outbound message was used for this check.

## Scope and evidence limits

Registration remains stable with 31 applied event types and both page bindings
at generation 1. Collection policy remains version 6, with all five optional
groups applied and free history collection enabled. These are persisted remote
confirmation plus current local state; no registration write was issued.

SQL used only `read_only` within read-only transactions. That role cannot read
the recovery journal, registration tables or cursor rows directly; normal
authenticated dashboard GET responses provided those operational summaries.
The readable Postgres table statistics showed 12 cursor rows and 142 updates,
corroborating active persistent traversal. No restart was induced solely to test
cursor survival in production; regression tests cover that property.

Historical unbound observations remain retained and unstamped. The existing
`obs_backlog_webhook_ofapi_v5` warning includes them and is not evidence that the
84 current receipts still need repair. Background sweeps continue with no parser
errors or binding conflicts in the inspected post-deploy log window.

Deploy and replay command logs are retained locally in
`/tmp/hub-webhook-deploy-20260908.log`,
`/tmp/hub-webhook-replay-preview-20260908.log` and
`/tmp/hub-webhook-replay-apply-20260908.log`.
