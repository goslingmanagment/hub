# OFAPI DM history sync — working investigation notes

Status: **working notes, not an accepted decision or implementation plan**  
Started: 2026-07-12  
Code/prod revision inspected: `1759351c440b`  
Scope: OnlyFans pages `lora-of` and `lora-vip-of`; read-only code, production DB/runtime, and official OFAPI documentation checks.

This file records facts, falsified hypotheses, design ideas, and open checks so later reviews do not inherit an outdated incident narrative. Update it as evidence changes; move accepted architecture into `docs/decisions.md` only after owner approval.

## Short conclusion

The current implementation conflates three different jobs:

1. capturing a new message;
2. reconciling the latest message (the conversation head);
3. downloading the entire historical conversation.

An outbound mass message is a real message fact and must be stored. It does **not** imply that the complete history of every recipient must be scraped immediately.

Target separation:

```text
new message capture       -> webhook, with Specific Message as bounded repair
conversation head         -> List Chats reconciliation
historical conversation   -> evidence-driven hydration or a separate bulk lane
```

## Verified production facts

Snapshot: 2026-07-12 17:16 UTC / 20:16 MSK. Counts are live and may grow.

- `lora-of` had no successful `dm_messages` run. Its checkpoint was pinned to one May-30 conversation. The same request returned a fast HTTP 404 seven times; the health breaker had no row for this conversation, so it could not clear the pin.
- `lora-vip-of` independently ran the exact adaptive ladder `limit=100 -> 20 -> 5`. Each attempt timed out after about 60 seconds. A chunk therefore ran for about 180 seconds despite a nominal 45-second chunk budget, processed zero messages, and recorded one conversation failure upsert.
- `page_dm_message_sync_health` held 94 rows: 88 active `vendor_opaque_timeout` rows and 6 non-failing sticky-limit rows.
- The active timeout rows were 43 on `lora-of` and 45 on `lora-vip-of`. Repeated failure of the same conversation updates its row; a new row means a newly discovered failing conversation, not simply a new run.
- 73 of 88 timeout rows matched the dominant May-30 preview fingerprint. The pinned 404 conversation matched it too but had no breaker row.
- The strict cohort contained about 8,345 visible, fan-mapped, model-head, unread-zero, locally empty, `pending_backfill` threads. About 8,331 shared one exact preview fingerprint.
- The dominant cohort is strongly mass-message-shaped, but historical raw List Chats payloads from the July-2 bootstrap were never captured. Therefore vendor `queueId` / `isFromQueue` provenance for that cohort is still unproved.
- Current captured List Chats `lastMessage` objects have only: `createdAt`, `fromUser`, `giphyId`, `id`, `isFree`, `isOpened`, `isTip`, `lockedText`, `mediaCount`, and `text`. They do not carry the richer `queueId` / `isFromQueue` shape shown in current documentation.
- Recent `messages.sent` webhooks do contain full message-shaped payloads and are projected into the hot/cold message planes. Therefore future outbound messages can be captured without a full history read.

## Corrected timeline

```text
2026-06-11  OFAPI DM Phase-2 code authored, behind default-off flag
2026-06-14  base OFAPI DM migration applied in production
2026-06-18  first relevant OnlyFans thread rows appeared
2026-07-02  main bootstrap materialized the large backlog (10,784 threads that day)
2026-07-06  slow-read timeout change reached production: 15s -> 60s
2026-07-11 16:33 MSK  migration 0086 / conversation breaker deployed
2026-07-11 17:31 MSK  migration 0088 / sticky preferred limits deployed
```

The July-11 breaker caused the **visible breaker-table growth and changed failure shape**. It did not create the underlying backlog. Before it, one timeout conversation pinned the stream; after it, timeout conversations were skipped/backed off and more failing conversations became observable. Non-5xx 4xx remained outside that breaker and a 404 recreated a total pin wedge.

## Confirmed code mechanisms

### Work generation

- Every new OFAPI chat defaults to `messageCoverageStatus='pending_backfill'`.
- `pending_backfill` unconditionally makes `needsDmMessagesFollowup` true.
- The candidate selector uses coverage both as a fact and as an executable work queue.
- The worker then calls live `GET /chats/{fan}/messages` to obtain historical messages.

This yields the amplification:

```text
one catalog/bootstrap cohort
-> thousands of pending threads
-> thousands of live per-chat history scrapes
```

### 404 wedge

The first-page conversation pin is persisted before the vendor request. A 404 is not classified as a conversation-local breaker failure, so the error is rethrown without clearing the pin. The next run starts from the same conversation.

### Timeout ladder

The chunk budget is 45 seconds, one slow read has a 60-second timeout, and the `100 -> 20 -> 5` probes run serially. Checking wall-clock only between probes cannot make the current three-distinct-conversations detector work; the first request already exceeds the chunk budget.

### Credit reservation

A request reserves an estimated credit before dispatch. A no-response timeout has indeterminate cost: the vendor may have processed and charged it before the client aborted. Therefore a blanket `finally` refund is unsafe.

Correct conceptual lifecycle:

```text
reserved
  -> settled(actual)       when response/_meta is known
  -> released              only when dispatch definitely did not happen
  -> indeterminate         timeout/connection loss after possible dispatch
```

### Durable-ingest fidelity gap

- The REST hot parser drops fields including PPV price, `isOpened`, and media details.
- The pull observation contains the response items but loses the request conversation id.
- Consequently model-sent REST events canonicalize with `conversationRef=null`.
- Background historical REST does not currently flow through the unified `dm_message_archive` candidate reducer as a proper `rest_backfill` writer.

This must be corrected before treating any new historical source as complete durable truth.

## Key product/data insight: outbound messages vs history

An outbound broadcast must be saved, preferably per recipient because opened/purchased/deleted state may diverge. But storing that message and fetching the full conversation are separate operations.

Desired behavior:

```text
model sends broadcast
-> messages.sent webhook stores the exact per-recipient message
-> no automatic full-history scrape

fan replies
-> inbound webhook stores the reply
-> that individual conversation becomes history-hydration eligible
```

If webhook capture missed a head, List Chats already provides its message id. The bounded repair should be `GET /chats/{chat}/messages/{message}`, not an unconditional full `GET /messages` walk.

For the historical May-30 cohort, the webhook-era fact is absent. The stored preview/head is not guaranteed to contain complete PPV/media/purchase/deletion information. Recover it through a verified historical source, not by promoting the preview into a message archive row.

## Candidate architecture (not yet accepted)

Keep existing factual coverage and failure state, and add only one orthogonal scheduling decision:

```text
message_coverage_status       factual: history absent/window/complete
history_hydration_state       scheduling: dormant | eligible
page_dm_message_sync_health   operational: failure/backoff/quarantine
```

Suggested properties:

- `history_hydration_state` is monotonic: `dormant -> eligible`; automatic downgrade is forbidden.
- Fansly remains eligible by default.
- A new OnlyFans thread is eligible only on individual evidence: inbound message, unread/fan head, known fan-message fact, spend, or explicit manual request.
- A model-sent webhook or List Chats head does not promote a dormant thread.
- Coverage remains truthful; dormant does not mean complete.
- Operational health counts failures for currently eligible conversations. Dormant historical backlog is reported separately as informational debt, not a live 503 condition.
- Candidate selection and follow-up generation must call the same load-bearing eligibility predicate.

Checkpoint semantics should represent committed progress, not a first-page in-flight claim:

```text
select candidate locally under the page lease
-> vendor request
-> capture + transactional projection
-> persist conversation/cursor only when another page remains
```

A failed first request then leaves no durable pin. Existing legacy pins need a one-time fenced cleanup on rollout.

## Bounded head reconciliation

The realtime/reconcile path should prefer:

1. webhook message fact;
2. exact Specific Message fetch for a missing known head;
3. full List Messages only for an eligible history hydration task.

This prevents Core from using a complete-history scrape merely to materialize one known outbound head.

## Historical bulk lane

Official OFAPI documentation exposes async Chat Messages Data Export with targeted `chatIds`, `maxChats`, `maxMessages`, and `skipMassMessages`. It is a candidate for historical bootstrap, not yet a proven solution: the exporter may share the same upstream scraper and its field fidelity is not equivalent to webhook payloads.

If adopted, require:

- quote before owner-approved start;
- bounded pilot;
- artifact checksum and `total_rows == rows_processed` verification;
- versioned parsing and per-field provenance;
- unified message-candidate reduction;
- explicit coverage manifests by page/conversation/date range;
- webhooks and bounded REST upgrades for fields absent from the export.

Desktop harvest remains another possible bulk-history source.

## Minimal controlled vendor probes

These are external, credit-consuming/stateful operations and require an owner gate.

1. Failing conversation: `List Messages?limit=5&skip_users=all`.
2. Same conversation: `GET .../messages/{knownHeadMessageId}`.
3. Existing known-good same-page control only if a fresh control is needed (recent natural successes already prove the direct route can work).
4. Targeted Chat Messages Data Export quote with `auto_start=false`; do not start without a second owner gate.
5. Optional Mass Message overview query around the campaign date to prove campaign identity/sent count; it does not itself prove per-recipient delivery mapping.

All probes must use the explicit direct `vendor:ofapi` route. Do not use the page read gateway or share a page proxy: the owner invariant is one page proxy per page, never one proxy for two pages.

Interpretation of the first two probes:

| List+`skip_users=all` | Specific Message | Interpretation |
|---|---|---|
| succeeds | succeeds | request-shape/enrichment cost is a likely simple bug |
| times out | succeeds | list-history endpoint is the pathological operation |
| 404 | 404 | stale/virtual/unavailable conversation or delivery |
| times out | times out | deeper vendor/upstream pathology |

## Ideas deliberately rejected or deferred

- Do not set historical coverage to `complete` for an unavailable/deferred chat.
- Do not use `summary_only` as a coverage state; it mixes known head material with historical completeness.
- Do not write truncated List Chats preview text into `page_dm_messages` or `dm_message_archive`; the latter feeds AI transcripts directly.
- Do not repair the historical cohort from raw fingerprint: the required July-2 raw capture does not exist.
- Do not hardcode chat ids, dates, or message text in runtime selection.
- Do not blindly delete breaker rows; preserve failure evidence and learned limits.
- Do not automatically re-admit on any head change: a new model broadcast changes thousands of heads simultaneously.
- Do not classify every 403 as auth without structured-body/account-health evidence.
- Do not refund all failed credit reservations in `finally`.
- Do not treat `stored_message_count=0 -> limit=5` as a root fix. It can multiply requests for healthy histories and limit 5 currently times out for the incident cohort too.
- Do not add a fourth endpoint-breaker table until demand gating and cross-run aggregation over existing health/HTTP-attempt data are evaluated.

## Open questions

1. Does `skip_users=all` materially change latency for one failing conversation?
2. Does Specific Message return the known head when List Messages times out or returns 404?
3. Is the May-30 cohort a vendor-recognized mass campaign, and can it be recovered through a targeted export without the same pathology?
4. What historical depth is actually required for cold, never-replied recipients?
5. Which individual evidence should promote a thread to eligible: fan activity only, or also active subscription/spend thresholds?
6. Does the product need a manual per-conversation history-hydration command?
7. Should indeterminate credit reservations receive durable attempt ids and be reconciled against later balance observations?

## Tentative safe implementation order

1. Owner-approved bounded vendor probes (`skip_users=all`, Specific Message).
2. First-page checkpoint/pin correction plus typed 404/401/429/403 handling.
3. Add the small orthogonal `history_hydration_state` and one shared eligibility predicate.
4. Route missing-head repair to webhook/Specific Message; keep full List Messages for eligible hydration only.
5. Replace the within-run three-probe ladder with one deadline-bounded attempt per chunk and persisted next-probe intent if adaptive sizing remains needed.
6. Seed existing OnlyFans eligibility from positive evidence only; leave unknown cold threads dormant without changing coverage.
7. Re-scope operational health to eligible failures while retaining dormant incident evidence.
8. Fix the full-fidelity observation/candidate/archive pipeline.
9. Evaluate a bounded historical bulk source and only then repair the legacy cohort in audited batches.

## Scope decision after comparing patch vs redesign vs rewrite

Working recommendation: choose a **localized OF DM history/head redesign**. Ship a small containment patch first, but do not treat it as the root fix. Do not rewrite the general scheduler/executor.

| Scope | Benefit | Residual problem | Verdict |
|---|---|---|---|
| Tiny error patch | Stops the active 404 pin and reduces one-run overshoot | Coverage still creates thousands of automatic live-history jobs; successful REST remains lossy | Necessary containment only |
| Localized OF redesign | Separates message/head capture from historical demand and keeps shared infrastructure | Historical bulk importer remains a separate follow-up | **Chosen boundary** |
| General sync rewrite | Could theoretically unify everything | Reopens lease, queue, fairness, concurrency, and Fansly risks without addressing the OF acquisition mismatch | Reject |

The general executor, one-job/one-chunk handoff, page leases, fairness, serving tables, archive reducer, erasure fences, and AI readers remain in place. Fansly's per-conversation crawl also remains: it has a different authoritative acquisition model. The OF-specific mistake is using a live OLTP list-history request as the automatic bulk-history source.

### The smallest durable conceptual model

Keep three independent facts:

```text
coverage             what historical range is actually stored
hydration intent     whether automatic historical acquisition is authorized
health               what failed while trying
```

Only one new load-bearing scheduling state is required:

```text
history_hydration_state = dormant | eligible
```

For implementation simplicity this can live directly on `page_dm_threads`, with optional last reason/evidence fields. A separate one-to-one intent table is justified only if review proves a need for independent audit/history or multiple intent records; do not add a table merely for abstraction.

The transition is monotonic (`dormant -> eligible`) and promotion comes from positive individual evidence. Coverage never changes merely because a thread is dormant.

### OF steady-state acquisition policy

```text
messages.sent/received webhook
  -> capture exact new message

List Chats
  -> reconcile head and unread

known head missing from material store
  -> bounded Specific Message repair (not full history)

eligible historical conversation
  -> bounded live gap repair or separate historical bulk lane

dormant historical conversation
  -> no live full-history scrape; coverage remains incomplete and visible
```

This policy needs a provider-specific selector seam. The shared selector should accept a provider policy/work kind rather than hardwire Fansly exclusion metadata and treat every `pending_backfill` row identically.

### Three shared seams worth repairing without a broad rewrite

1. **Checkpoint vs attempt claim:** a committed cursor must not double as a pre-I/O in-flight pin. First-page candidate ownership stays local/expiring; checkpoint advances only after capture+commit. This defect also exists in the Fansly non-deep path, so repair the seam once.
2. **Versioned capture envelope:** observations must carry request context plus verbatim response (`conversationRef`, cursor/limit, response, mapper version). The current response-only observation loses conversation identity for model-sent OF REST messages.
3. **Provider-specific acquisition policy:** share serving/canonical data structures, but let Fansly and OF decide differently how head repair and historical acquisition work.

These are focused seam corrections, not a rewrite of pg-boss, the executor FSM, page scheduling, or archive consumers.

### Rollout slices for the chosen boundary

1. **Containment:** 404/410 expiring isolation and pin release; 401 auth; body-aware 403; 429 rate; one deadline-bounded request per chunk; cross-run failure aggregation from existing health/HTTP attempts.
2. **Intent gate:** additive hydration state behind a default-off feature flag; dry-run classification; seed positive-evidence conversations eligible and cold unknowns dormant without changing coverage or deleting health evidence.
3. **Head repair:** add direct vendor Specific Message client support; webhook first, Specific Message only for bounded missing-head repair. Do not route through shared page proxy/read-gateway.
4. **Full-fidelity ingest:** introduce the v2 request+response observation envelope and reuse the existing message candidate reducer.
5. **Historical lane:** pilot Data Export/desktop harvest; add a bulk importer only after source fidelity, cost, and failure behavior are proven.

The `skip_users=all` and Specific Message probes remain valuable. Even if `skip_users=all` fixes latency, it is only a transport optimization: it does not justify turning every catalog row into an automatic full-history job.

### Simplest no-schema stop-loss considered

A two-file containment can exclude conversations whose current head is model-sent and `unread_count=0` from OF history candidate selection, health-failure counting, and follow-up generation. It can also clear an already pinned conversation matching that predicate and stop probes once the first timeout exhausted the wall-clock budget.

This is materially safer than detecting the incident cohort by date/text/hash and is a good emergency flag because a future fan head or unread signal automatically makes the conversation selectable again.

It is **not chosen as the final data model** unless the product explicitly accepts the policy “historical sync is needed only while a fan response is actionable.” Its limitations are:

- an engaged free fan whose latest message is the model's reply remains deferred until the next fan signal;
- there is no persisted manual/chat-open/AI hydration intent;
- 404 re-admission remains timer-based rather than tied to a head/evidence version;
- operational health can be green while historical backlog remains non-zero, requiring a separate clearly named completeness metric;
- it cannot express a future bulk-import request without adding another implicit predicate.

Therefore use the no-schema predicate as containment or as an explicitly approved product policy, not as an accidental replacement for an intent model.

## Multi-pass adversarial review addendum

Status: working synthesis after ten role-based review passes. This section supersedes the earlier recommendation that a single `history_hydration_state` column is sufficient. The column separates demand from coverage, but it does not prove that a historical range is contiguous or preserve per-conversation progress after fault isolation.

### Current production remains actively degraded

A later read-only snapshot on 2026-07-12 showed that the system was not organically draining:

- `lora-vip-of` continued to perform the exact `100 -> 20 -> 5` ladder on one newly selected conversation. Each request took about 60 seconds, so a nominal 45-second chunk ran for about 180 seconds, processed zero messages, and added one failure row.
- `lora-of` continued to fail quickly with HTTP 404 on the same persisted pre-I/O conversation pin.
- The two pages had about 12,472 `pending_backfill` conversations and only 12 rows claiming `complete`.
- Only 11 conversations across the two pages had any successfully captured `dm_messages` REST page in `sync_raw_payloads`.

This keeps the paginated `dm_messages` lane an active stop-loss priority independently of the final historical architecture.

### New root-level defect: inventory is not coverage proof

`page_dm_threads.oldest_stored_message_id`, `newest_stored_message_id`, and `stored_message_count` are recomputed from all physical hot rows. On OnlyFans those rows can be independent webhook islands. The OF history walk nevertheless uses the physical oldest row as its backfill cursor, any stored-row overlap as a completion condition, and physical row count as retention progress.

Counterexample:

```text
stored webhook facts: 300 and 100
missing range:         299 ... 101

physical oldest = 100
legacy backfill starts at/below 100
=> the missing middle range is never traversed
```

The same problem affects the cap: 199 unrelated webhook islands plus one traversed provider row can satisfy a physical count of 200 without proving a contiguous 200-message window.

Production makes this edge realistic rather than academic:

- 326 pending OF conversations held multiple hot messages spanning more than one day;
- 112 of them spanned more than seven days;
- only a tiny number of conversations had successful REST-history pages.

Therefore:

- physical hot extrema/count are inventory only;
- overlap with an arbitrary hot row is not a verified anchor;
- bounded hot pruning makes hot-only anchors even less valid;
- parse skips must create materialization debt and must not silently certify materialized coverage.

### Per-page checkpoint cannot isolate multiple paginated conversations correctly

The page has one `dm_messages` checkpoint. A partial conversation page can commit its rows and cursor; a later chat-local timeout writes health, clears the page pin, and moves on. The health row does not preserve the cursor, active target, or verified anchor. Multiple quarantined conversations therefore cannot retain their independent progress.

Restarting from the head and stopping at any newly stored partial row can close the walk before reaching the previously verified anchor. Persisting only three cursor fields in the health row is still insufficient once sparse rows, retention depth, target changes, parse debt, and bulk imports are considered.

### List Chats contains a useful message fact that Core currently discards

Every `dm_conversations` page is already durably captured. Production's recent `lastMessage` objects consistently contained:

```text
createdAt, fromUser, giphyId, id, isFree, isOpened,
isTip, lockedText, mediaCount, text
```

Exact replay with Core's `normalizeDmMessageText` matched the existing archive text for 606/606 observed List Chats head occurrences. The earlier ad-hoc SQL result suggesting 100 text mismatches used a different normalization and is withdrawn.

The source is still fill-grade rather than full-fidelity:

- production heads did not include price, media arrays, queue id, reply graph, or changed time;
- 25/606 occurrences were media-bearing or non-free and need richer enrichment when the archive lacks them.

Correct use:

```text
plain text List Chats head -> materialize through the message reducer
rich/incomplete missing head -> bounded Specific Message repair
head fact                  != proof of historical completeness
```

This removes unnecessary Specific requests for ordinary heads and fixes the conceptual mistake of using a full-history crawl merely to materialize one known message.

### Full List Chats sweep is not the primary repair

Core requested `limit=100`, but recent production responses consistently contained 10 rows. With roughly 12.5k visible chats, a full sweep would require about 1,249 requests at the observed behavior, would be vulnerable to offset drift while chats reorder, and would still return only the current partial-fidelity head.

A controlled `limit=100`/`skip_users=all` vendor probe may explain the cap. Even a successful parameter fix would make a sweep cheaper, not turn it into a historical source.

### Bare model-head deferral is rejected as a permanent rule

The simple predicate `last sender=model AND unread=0` is a good incident-shape detector but a bad final product policy. Production contains model-head conversations with known earlier fan activity and hundreds of spenders. A model reply after a fan message must not erase the conversation's historical intent.

Emergency containment should pause the legacy paginated OF history lane as a whole while keeping webhook capture and List Chats reconciliation alive. It should not silently classify absence of evidence as `dormant`.

### Preferred target candidate: two acquisition contours

The strongest current candidate avoids a long-lived per-chat pagination FSM in the live path:

```text
LIVE CONTOUR
  messages.sent/received webhook
    -> exact durable message fact

  List Chats
    -> head/unread reconcile
    -> materialize plain-text head from the already captured payload

  active individual signal
    -> at most one bounded recent-page read, or Specific Message
    -> always partial context, never complete history

ARCHIVE CONTOUR
  async Chat Messages Data Export
    -> quoted and owner-started
    -> artifact/checksum/row-count capture
    -> idempotent import through MessageFactCandidate
    -> coverage advances only for a certified scope/range
```

This keeps Decision #49's product objective of eventual history while superseding its fragile transport choice. Cold outbound-only conversations do not create live per-chat crawls, but their known heads and full history remain archive obligations.

The hybrid is preferred only if the Data Export pilot proves its scope, truncation, IDs, fidelity, cost, retry behavior, and completeness semantics. If the export returns useful rows without a completeness certificate, it may import facts but cannot set `complete`.

### Fallback if live pagination remains necessary

If certified bulk history is unavailable and paginated per-chat history must remain, use typed fixed-target acquisitions plus verified coverage segments. Do not use one `conversation_id`-PK row that overwrites target/cursor/min/max.

Minimum semantic split:

```text
mutable work:
  work kind, immutable target generation, verified anchor,
  cursor, lease/CAS version, failure/backoff

immutable proof:
  source/protocol, captured range, materialized range,
  parse debt, provider exhaustion, archive verification
```

Completion may occur only on exact connection to a verified segment or certified provider exhaustion. Arbitrary hot overlap is never enough.

### Live campaign reconciliation

OFAPI documents `chat_queue.updated/finished`, but Core is not subscribed. Current production `messages.sent` events all expose queue-like identifiers while `isFromQueue=false`; this corpus does not prove mass-recipient fanout or correlation semantics.

Safe sequence:

1. subscribe to `chat_queue.*` journal-only;
2. observe the next natural campaign without generating one;
3. correlate unique recipient message IDs against the finished aggregate after a grace window;
4. run a bounded export repair only on a proven deficit.

Do not correlate campaigns by message text.

### Product/SLO separation

One health flag must no longer mix live availability and historical completeness.

Operational readiness should cover:

- webhook and projection lag;
- active exact-head lag;
- bounded recent-tail failures for active conversations;
- auth/rate/credit blocks affecting the active lane;
- projection debt and PPV/tombstone violations.

Separate informational/completeness state should cover:

- dormant/requested/exporting historical debt;
- verified export ranges;
- legacy unknown/legacy claimed complete rows;
- cold rich-head enrichment debt.

Current breaker rows must be retained as evidence but should not make live readiness red merely because a cold historical scrape failed.

### Safe rollout boundary

Common prefix before choosing bulk-only versus typed segments:

1. owner-gated pause of only the OF paginated `dm_messages` lane;
2. preserve webhook projection and `dm_conversations`;
3. deploy an explicit contained mode, default inert, then flip separately;
4. type 404/410, 401, 429, and structured 403;
5. one physical slow attempt per chunk, `retries=0`, with lease/deadline/reservation admission before dispatch;
6. remove the pre-I/O first-page pin and fence scheduling mutations;
7. materialize captured List Chats heads through the durable reducer;
8. run Specific/List+`skip_users`/Data Export quote probes under owner gates;
9. choose bulk-only if certified; otherwise shadow and canary typed acquisitions.

Rollback must never return directly to the legacy poison loop. An old binary ignores a new history-mode config, so old-image rollback first requires an old-compatible `OFAPI_DM_SYNC_ENABLED=false` or durable per-stream pause.

### Remaining owner decisions

1. Accept the product change that full OF history is asynchronous while active recent context has a tighter SLO.
2. Decide which individual signals request a recent tail; spend/subscription alone must not be assumed without approval.
3. Approve the bounded vendor probes and, separately, any export start after its quote.
4. Supersede the transport-specific portions of decisions #49/#52 if the export contour is accepted.

## Final arbiter synthesis

After the tenth role-based pass, the preferred target is the two-contour hybrid above, with one correction to the arbiter's wording:

- the projected `last_message_preview` is not a message fact and must never be promoted;
- the durably captured raw `dm_metadata.items[].lastMessage` is a fill-grade message fact for the exact fields it actually contains, because production replay matched its normalized text to archive truth for 606/606 observations;
- materializing those fields through `MessageFactCandidate` does not advance historical coverage;
- rich or incomplete heads still require Specific Message or a higher-fidelity source.

### Minimal schema for the preferred hybrid

1. `ofapi_dm_export_runs`: durable external-job/outbox state, quote/start separation, vendor id, request scope, status, artifact checksum, row counters, parser version, errors, and CAS version.
2. `page_dm_history_certificates`: append-only per-conversation results tied to one export/import, including snapshot head/time, requested tier, materialized count, truncation/exhaustion, debt count, coverage assertion, and archive verification.
3. Target-scoped operational health for `specific_head` and `recent_window`; failure identity includes the target message/head version so a new head bypasses an old 404. Export failures belong to the export run, not the conversation breaker.
4. Durable PPV purchase/open annotation before any hot prune.

A general `history_hydration_state` column is not required for this end-state. Live recent work is created by an individual persisted signal; full historical work is created by an export run.

### Certificate rule

An imported row is a fact. It becomes coverage proof only when all relevant conditions are established:

```text
artifact checksum and scope verified
no undocumented truncation
mass messages included when required
all rows parsed and reduced
zero unresolved projection debt
archive verification complete
provider exhaustion or requested tier proven per conversation
```

Unknown condition means `facts_only`, never `complete`.

### Economic gate

Data Export is cheaper per row, not automatically cheap in total. A worst-case regular-tier fleet export is approximately:

```text
12,472 conversations * 200 rows / 20 rows per credit
= 124,720 credits
```

before spender-tier uplift. The May-30 one-message cohort is orders of magnitude smaller. Therefore rollout is cohort- and quote-gated: active/manual first, then spenders, then the remaining fleet only with an explicit owner budget decision.

### Explicit fallback trigger

Use typed fixed-target acquisitions plus immutable verified segments only if the bounded export/harvest pilot cannot provide a certifiable and affordable historical source. Fallback triggers include:

- timeout/404 cohort absent from export;
- per-chat truncation/exhaustion cannot be distinguished;
- message identity/conversation/direction/time/text fidelity is insufficient;
- mass/PPV rows are excluded without an authoritative supplement;
- async job/download/import cannot be resumed idempotently;
- quote exceeds the accepted budget;
- completion misses the agreed historical SLO.

Fallback applies first to active/spender/manual cohorts. It never restores the legacy fleet-wide crawler or its `oldestStoredMessageId`/any-overlap protocol.

## Independent re-investigation — 2026-07-13

### Verdict

The earlier report's central diagnosis is directionally correct, but the independent pass found a stronger result:

1. Production has **two different active failures**: `lora-of` is still pinned on one fast 404, while `lora-vip-of` is still cycling many conversations through three 60-second timeouts.
2. The primary root cause is older than both failures: Core turns the factual state “historical coverage is unverified” into an instruction to crawl every discovered OF conversation.
3. The coverage algorithm is not merely theoretically unsound. Production contains a concrete conversation that committed two pages, lost its only cursor on a later timeout, restarted from the head, hit its own stored row, and was then marked `complete` while the failed deeper page remained unfetched.
4. A pre-I/O durable claim is not intrinsically wrong. The defect is that one page checkpoint is simultaneously a work claim and the only committed per-conversation cursor, while error handling does not have a total release/preserve policy. A typed acquisition job may correctly persist a claim before I/O.
5. The smallest correct live fix does not require history schema: stop implicit OF history work, materialize the already-captured List Chats `lastMessage` as a point fact, use Specific Message only for bounded repair, release/quarantine chat-scoped 404s, and allow one slow attempt per chunk.
6. Schema is justified only when historical hydration is actually requested. In that case the real state is a typed acquisition job plus independently verifiable coverage evidence; `pending_backfill`, physical extrema, or a lone eligibility boolean cannot represent it safely.
7. Async Data Export is a plausible historical backend, not yet a proven one. Contrary to one statement in the earlier synthesis, its documented `1 credit / 20 rows` is **five times the theoretical per-row cost** of a successful 100-row List Messages page (`1 credit / up to 100`), although it can still be much cheaper than the current failed-request loop.

No production mutation, restart, deployment, paid vendor probe, or export creation/start was performed.

### Independence and evidence boundary

Phase 1 was completed and written to `/tmp/ofapi-phase1-independent-2026-07-13.md` before this file was opened. Independent passes covered runtime/control flow, production DB/logs, leases and wall clock, coverage and archive models, official vendor semantics, the smallest patch, architectural alternatives, rollout/reliability, and hostile falsification. Agents were explicitly forbidden from reading this report during Phase 1 and challenged one another with counterexamples rather than voting.

Revision boundary:

- working checkout: `chore/docs-cleanup` at `dc3672959c38abbf63f8d244d913982c11d56d3a`;
- local `main` / `origin/main`: `86a6dd4a220cd9fe8615d4e6156d1cef11b7840d`;
- production api/worker/scheduler image labels: `86a6dd4a220c`, an exact match to current main;
- all source line references below are against deployed `86a6dd4`, not the divergent working checkout;
- primary read-only production snapshot: 2026-07-13 11:04–11:29 UTC.

The repository intent remains useful but is not treated as runtime truth:

- Decision #49 deliberately reused Fansly history/coverage machinery for OF and states that every new chat receives the REST bootstrap/reconcile treatment (`docs/decisions.md:428-438`).
- Decision #52 explicitly made `dm_message_archive` webhook-forward-only, with no historical REST backfill (`docs/decisions.md:467-472`).
- Stage 3 already recorded two stuck timeout conversations as an independent anomaly (`docs/migration-history/stages/stage-03-ofapi-staged-capture-enablement.md:103-107,156`).
- Stage 7 intended observations to retain the whole response (`docs/migration-history/stages/stage-07-observation-journal-producers.md:57-70`), but its implementation note acknowledges OF captures only `{items}` because the client discarded the envelope (`:245`).
- Stage 10 intended raw/observation replay into the platform-neutral archive (`docs/migration-history/stages/stage-10-platform-neutral-message-archive.md:48-60`), but the current OF pull canonicalizer is too lossy to fulfill that intent with full conversation fidelity.

### Current production status

Final snapshot at `2026-07-13 11:29:36Z`:

| Surface | `lora-of` | `lora-vip-of` |
|---|---:|---:|
| `dm_messages` state | `pending`, request 176 / applied 0 | `running`, request 270 / applied 0 |
| Successful `dm_messages` run | none | none |
| Current pin | chat `560433668`, backfill, cursor null | chat `104526877`, backfill, cursor null at snapshot |
| Pin/checkpoint behavior | unchanged since `2026-07-12 15:55:41Z` | changes as timeout candidates rotate |
| `consecutive_failures` | 39 | 0 because partial yields reset page failure streak |
| eligible conversations | 4,466 | 8,036 |
| `pending_backfill` | 4,457 | 8,033 |
| `complete` | 9 | 3 |
| stored count = 0 | 4,219 | 6,850 |
| head mismatch | 4,218 | 6,769 |
| model head | 4,354 | 7,809 |
| failing conversation-health rows | 43 | 91 |
| currently quarantined | 0 | 76 |
| maximum per-chat failure count | 7 | 11 |

The page-9 lease was fresh (`lease_heartbeat_at=11:29:31Z`, expiry `11:31:31Z`) during its 180-second run. pg-boss `sync.page.execute` uses a 900-second expiry and 30-second heartbeat. This falsifies lease expiry, task theft, or scheduler zombie handling as the current root.

At the same snapshot:

- `ofapi_credit_state.spent_credits=913`;
- last observed vendor balance was 31,256;
- the current deployment still had zero successful page-9 `ofapi_chat_messages` responses;
- the page-8 checkpoint still pointed to internal conversation `75438016` / chat `560433668`;
- its latest logged request at 10:34:51Z failed 404 in 633 ms and the run failed in 694 ms.

Earlier same-day aggregates remain representative:

- page 8: repeated fast 404 runs against the same pin;
- page 9: 216 post-deploy runs inspected, 215 with exactly one conversation failure and three requests; no run reached three distinct failures;
- representative run `sync_runs.id=355168`: roughly 60.004 s at limit 100, 60.004 s at 20, 60.007 s at 5, and 180.226 s total.

Relevant live flags were enabled in all runtime roles: DM projection, DM sync, cold archive, credit ledger, readthrough/corrections reconcile; pruning was off; REST delay was 500 ms; DM daily budget 3000; balance floor 500; egress pacer remained `shadow`.

#### Reproducible production evidence

The main point-in-time queries were:

```sql
SELECT clock_timestamp() AS snapshot_utc,
       p.label, s.status, s.request_seq, s.applied_seq,
       s.consecutive_failures, s.succeeded_at,
       s.lease_heartbeat_at, s.lease_expires_at,
       c.state AS checkpoint, c.updated_at AS checkpoint_updated
FROM page_sync_states s
JOIN pages p ON p.id = s.page_id
LEFT JOIN page_sync_cursors c
  ON c.page_id = s.page_id AND c.stream = s.stream
WHERE p.label IN ('lora-of', 'lora-vip-of')
  AND s.stream = 'dm_messages'
ORDER BY p.label;

SELECT p.label,
       count(*) FILTER (WHERE t.is_visible AND t.fan_id IS NOT NULL) AS eligible,
       count(*) FILTER (WHERE t.message_coverage_status = 'pending_backfill') AS pending,
       count(*) FILTER (WHERE t.message_coverage_status = 'complete') AS complete,
       count(*) FILTER (WHERE t.stored_message_count = 0) AS stored_zero,
       count(*) FILTER (
         WHERE t.last_message_id IS DISTINCT FROM t.newest_stored_message_id
       ) AS head_mismatch
FROM page_dm_threads t
JOIN pages p ON p.id = t.platform_account_id
WHERE p.label IN ('lora-of', 'lora-vip-of')
  AND t.is_visible AND t.fan_id IS NOT NULL
GROUP BY p.label
ORDER BY p.label;
```

The false-completion proof is reproducible without inference from message text:

```sql
SELECT id, sync_run_id, captured_at, request_params,
       jsonb_array_length(response_payload->'items') AS items
FROM sync_raw_payloads
WHERE id IN (1322008, 1322009, 1322275)
ORDER BY id;

SELECT id, outcome, started_at, finished_at,
       stats->'checkpoint' AS checkpoint,
       stats->'requestTotals' AS requests
FROM sync_runs
WHERE id IN (343131, 343141, 343208)
ORDER BY id;

SELECT id, platform_conversation_id, message_coverage_status,
       stored_message_count, oldest_stored_message_id,
       newest_stored_message_id, last_message_sync_at
FROM page_dm_threads
WHERE id = 75624281;
```

The same-day reservation/attempt equality used:

```sql
SELECT s.spent_credits
       - COALESCE((
           SELECT sum(l.credits)
           FROM ofapi_credit_ledger l
           WHERE l.source = 'rest'
             AND l.occurred_at >= timestamptz '2026-07-13 00:00:00+00'
         ), 0) AS unreturned_reservations
FROM ofapi_credit_state s
WHERE s.id = 1;

SELECT count(*) AS failed_dm_attempts,
       count(*) FILTER (WHERE failure_kind = 'transport') AS transport_failures,
       count(*) FILTER (WHERE http_status = 404) AS http_404s
FROM sync_http_attempts
WHERE operation = 'ofapi_chat_messages'
  AND state = 'failed'
  AND started_at >= timestamptz '2026-07-13 00:00:00+00';
```

Representative worker log evidence:

```text
2026-07-13T10:34:51.861Z  dm_messages run started
2026-07-13T10:34:52.494Z  request failed status=404 durationMs=633
2026-07-13T10:34:52.549Z  run failed durationMs=688
```

### Root-cause causal chain

```text
List Chats page is captured
-> each new thread defaults to pending_backfill
-> pending_backfill alone requests dm_messages follow-up
-> selector treats pending coverage OR head mismatch as executable work
-> zero-row thread becomes full-history backfill
-> sole page checkpoint is pinned before I/O
-> List Chat Messages runs at 100
-> first-page timeout runs 20 then 5 in the same chunk
-> timeout/5xx clears pin and creates health debt
-> 404/401/403/429 bypass chat-local clearing and preserve pin
-> successful pages store lossy REST facts
-> any physical overlap/exhaustion/cap finalizes coverage
-> partial-progress timeout can delete the only cursor
-> scheduler immediately continues because partial is treated as healthy
```

Exact deployed code:

- factual state becomes work: `apps/runtime/src/services/sync/ofapi-dm-sync.ts:449-469,647-705,822-829`;
- generic candidate selection: `packages/db/src/repositories/page-dm.ts:922-1010`, especially `:988-996`;
- pin before I/O and mode selection: `ofapi-dm-sync.ts:894-988`;
- 60-second slow-read timeout: `apps/runtime/src/services/ofapi.ts:21-29,1379-1402`;
- `100 -> 20 -> 5`: `ofapi-dm-sync.ts:996-1077`;
- only opaque timeout/abort and 5xx are chat-isolatable: `:834-862`;
- timeout/5xx health write and pin clear: `:1080-1119`;
- 404/other 4xx rethrow before clear: `:1028-1034`;
- executor recognizes Fansly errors but not `OfapiApiError`: `apps/runtime/src/services/sync/executor.ts:76-82,186-271`;
- physical overlap and completion: `ofapi-dm-sync.ts:1194-1233`, coverage resolver `:471-487`;
- partial-page message/cursor commit without thread summary refresh: `:1253-1268`;
- one `(page,stream)` cursor: `packages/db/src/schema.ts:534-557`; health rows have no acquisition cursor at `:2795-2823`;
- cooperative 45-second budget: `apps/runtime/src/services/sync/chunk-budget.ts:5-55`.

Git chronology:

- `ad856463` (2026-06-11) introduced OF bootstrap, default pending coverage, and Fansly-derived coverage transitions.
- `46216dd` (2026-07-05) raised the slow chat timeout from 15 to 60 seconds after the stuck-chat problem already existed.
- `916e57d` (2026-07-11) added chat health, pin release for timeout/5xx, and the three-limit ladder.
- `f7b58a6` made a successful smaller limit sticky, which cannot help chats that also time out at 5.
- July 12 queue/lease fixes made long runs finish safely; they did not make the handler respect 45 seconds.

The July breaker therefore did three things: it fixed the old single-timeout pin, exposed the synthetic backlog, and tripled the cost/wall time of the first slow candidate. Page 8 later encountered a different error class—404—and became totally pinned again.

### New verified production data-corruption mechanism

The independent adversarial pass first derived this from code; a subsequent Phase-2 production query found an exact occurrence.

Conversation `514750406` (`page_dm_threads.id=75624281`) is now `complete` with 10 stored rows:

1. `sync_runs.id=343131` ended with cursor `7336587939265`. Raw row `1322008` fetched five items at limit 5 from `firstId=null`.
2. `sync_runs.id=343141` resumed that cursor. Raw row `1322009` fetched five items from `firstId=7336587939265`; the handler then attempted another page, exhausted four transport attempts over about 240 seconds, recorded one chat failure, and replaced the checkpoint with the empty state.
3. The fact that the handler attempted a third page proves the second response was non-terminal according to the live client.
4. After other timeout runs, `sync_runs.id=343208` selected the same conversation again. Raw row `1322275` restarted from `firstId=null`, returned five already-known head items, and the arbitrary-overlap rule finalized the thread.
5. `last_message_sync_at=2026-07-11 18:09:45.491Z`, exactly the restart capture time; the thread remains `complete`.

This is not a hypothetical sparse-island edge. Core discarded committed progress on a breaker path and then used its own refetched page as “coverage proof.” At least this production `complete` claim is false by Core's own preceding pagination evidence.

All 12 current `complete` rows require re-audit. Eleven have successful retained REST pages and one has none, but the retained payloads omit `_pagination`, `_meta`, and the terminal vendor URL, so even those eleven cannot be independently certified from raw capture alone. Do **not** change them back to `pending_backfill` before the implicit-work gate is deployed; that would enqueue them into the broken crawler again.

### Error and pin behavior

| Result | Current handler/executor behavior | Active pin |
|---|---|---|
| Conversation finalized successfully | messages/final summary/health/checkpoint transaction | cleared |
| Non-terminal successful page | messages and cursor transaction | preserved and advanced |
| Timeout/abort on first page after 100/20/5 | health/backoff, empty checkpoint, continue/yield | cleared; later recreated after health expiry |
| Timeout/5xx after prior successful pages | health/backoff, **committed cursor discarded** | cleared; progress becomes implicit/unsafe |
| 5xx | conversation health/backoff | cleared |
| 404 | thrown to generic executor retry; no health row | preserved indefinitely |
| 401/403 | thrown; OF error is not recognized as auth by executor | preserved; generic retry |
| 429 | thrown to page-level retry handling | preserved |
| other 4xx/unrecognized error | generic retry | preserved |
| wall/request-budget yield outside request | normal continuation | preserved |
| pinned chat already inside health window | current code discards pin and selects another | cleared, including any progressed cursor |
| health window expires | same thread is eligible again | recreated before I/O |

The old phrase “pre-I/O pin wedge” accurately describes the observed sequence, but it should not be read as “never persist a claim before I/O.” A durable, leased, typed job claim is correct crash behavior. What is wrong is using the only committed progress cursor as that claim and lacking a total error transition for every response class.

### Answers to the 17 investigation questions

| # | Answer |
|---:|---|
| 1 | **Actually broken now:** page 8 is 404-pinned; page 9 endlessly times out; both have zero successful stream runs; 12,490 threads are implicit history jobs; at least one `complete` claim is demonstrably false; REST archive provenance/fidelity is incomplete. |
| 2 | Both, on different pages. `lora-of` is pinned to 404 chat `560433668`; `lora-vip-of` rotates many timeout chats. |
| 3 | Yes. The ladder still runs and observed chunks are about 180 seconds despite a nominal 45 seconds. |
| 4 | Success, timeout/abort, and 5xx clear; successful partial pages preserve; 404/401/403/429/other 4xx preserve; timeout/5xx health expiry later allows re-pinning. A progressed pin is currently lost when the breaker clears it. |
| 5 | The July 11 breaker exposed an older June backlog and changed the visible/economic failure pattern. It did not create the backlog or original timeouts. |
| 6 | Every discovery defaults to `pending_backfill`; that status independently triggers follow-up and candidate admission. Zero stored rows then choose `backfill`. |
| 7 | Yes. `pending_backfill` is both an epistemic claim (“not proven complete”) and an implicit queue. |
| 8 | Yes for observed live traffic. In the last 24 h, 146 + 366 `messages.sent` events all reached hot, `dm_message_archive`, and `message_archive`. List Chats also carries the current `lastMessage` point fact. A contractual one-webhook-per-broadcast-recipient guarantee remains unproved. |
| 9 | Because head reconciliation and history hydration share one follow-up/candidate/mode path; the code has no separate live-head work kind. |
| 10 | No. Extrema/count summarize physical inventory and cannot establish a contiguous interval in the presence of webhook islands, imports, pruning, or parse skips. |
| 11 | Yes. It already happened in production after a partial cursor was cleared and the head page was refetched. Any unrelated sparse row can produce the same false terminal overlap. |
| 12 | No. One page cursor can represent one active serial walk only. Once multiple partially fetched chats are quarantined, health rows retain failures but not their target/cursor/verified anchor. |
| 13 | Only across fragmented stores. `sync_raw_payloads` keeps conversation/cursor/items/mapper version, but not the response envelope; `observations` keeps response items/source/parse version but loses request cursor and mapper version; parse failures are telemetry rather than durable source-linked outcomes. |
| 14 | No. Background REST pages do not write `dm_message_archive`; generic `message_archive` rows are lossy, and outbound pull events have null fan/conversation plus no reply/media fidelity. |
| 15 | Not fully. Reserve-before-call is a reasonable safety posture, but throws leave unattributed aggregate reservations until UTC rollover; failed calls do not increment the guard request count; a later-page logical request can make four transport attempts behind one reservation. The system can overcount, undercount, or double-represent actual/error spend depending on response metadata. |
| 16 | They are proximate operational failures. The root incident amplifier is generating fleet-wide history work without intent. For a genuinely requested history job, the same 404/timeout handling would still be a real reliability bug. |
| 17 | Yes. The overlooked simple root fix is to project the already-captured List Chats `lastMessage` and stop mapping `pending_backfill`/head mismatch to a full crawl. Specific Message is only the bounded fallback when that captured head is absent or too incomplete. |

### Message capture, observations, archive, and credits

#### Live and head facts

Official [List Chats](https://docs.onlyfansapi.com/api-reference/chats/list-chats) returns a `lastMessage` object, not merely an ID. Core currently reduces it to head/preview fields (`ofapi-dm-sync.ts:340-398,654-687`) and throws away the opportunity to materialize a known point fact.

Official [`messages.sent`](https://docs.onlyfansapi.com/webhooks/available-events) supplies the new outbound message. Production observed 512 such events in 24 hours and all 512 were present in all three material stores. Across retained recent List Chats captures, 529 distinct head IDs were checked and all 529 already existed in hot and webhook archives. This is high-confidence operational evidence that the current full crawl is redundant for ordinary live heads.

It is not coverage proof:

- a webhook can be delayed or absent;
- List Chats exposes one current head, not the interval below it;
- broadcast recipient completeness is not explicitly guaranteed by current vendor docs;
- deletions, PPV annotations, and richer media/reply data can arrive separately.

Use the exact retained `lastMessage` fields as point facts with `list_chats_last_message` provenance. Never promote `last_message_preview` text by itself. If the captured object is rich/incomplete or missing, official [Get Specific Chat Message](https://docs.onlyfansapi.com/api-reference/chat-messages/get-specific-chat-message) is the bounded `(chat,message)` repair.

#### REST raw and observation fidelity

Successful OF pull capture calls `persistRawPayload` with:

```text
request: conversationId, limit, firstId
response: { items }
mapper: ofapi-dm-rest-v1
```

The raw companion therefore has enough context to re-map a page, but not enough to audit the acquisition protocol: `_pagination.next_page`, `_meta._credits`, rate limits, vendor cursor URL, and terminal evidence are absent. The observation dual-write keeps only `responsePayload`, so the canonicalizer loses conversation identity for model-sent rows (`apps/runtime/src/services/sync/shared.ts:80-135`; `packages/db/src/schema.ts:2531-2559`).

The canonical pull mapper at `apps/runtime/src/services/canonicalize/sync-pull.ts:99-140` intentionally emits outbound REST facts with null fan/conversation and omits reply/media/open/edit state. Production matches the source trace:

- historical OF REST raw: 749 unique messages on page 8, 23 on page 9;
- all 772 reached hot and platform-neutral `message_archive`;
- none reached OF-specific `dm_message_archive`;
- outbound generic archive rows lose fan/conversation;
- reply and media fields are absent.

This is not a violation of Decision #52, which intentionally made `dm_message_archive` webhook-only. It is an architectural mismatch if REST/export history is later claimed as full durable history.

#### Credit reservations

The guard reserves one credit per logical call before dispatch (`ofapi-dm-sync.ts:167-180,227-232`) and releases/increments usage only through `recordResponse` (`:234-250`). Thrown calls bypass settlement. Repository code explicitly treats the excess as conservative until UTC rollover (`packages/db/src/repositories/ofapi.ts:1105-1113`).

At 11:16:03Z:

```text
spent_credits - explicit REST ledger = 662
failed dm attempts                  = 642 timeouts + 20 404 = 662
```

One balance-reconciliation window gives stronger but still observational vendor evidence:

```text
05:35:23Z -> 10:15:12Z
vendor balance: 31,918 -> 31,611 (307)
known REST + webhook spend:          18.78
unexplained residual:               288.22 -> ledger 288
failed DM attempts in same window:  279 timeouts + 9 404 = 288
```

The near-exact correspondence makes one vendor credit per failed current attempt highly likely, but no failed response `_meta` exists to prove attribution. Official docs show that some OnlyFans-origin errors still consume a credit, but do not document client-timeout billing.

There is also a missing mechanism in the prior report: later-page calls use the default internal retry budget. One logical reservation may cover up to four transport attempts. If the vendor charges each processed attempt, the supposedly conservative guard can under-reserve. Credit state should therefore be request-attributed and recorded at the physical attempt boundary as `reserved`, `settled`, `released`, or `indeterminate`.

### Verified bugs ranked by severity

1. **Critical — false historical completion (observed in production).** Arbitrary overlap plus loss of the only progressed cursor marked chat `514750406` complete after a deeper page timed out. This can suppress all future recovery while presenting false certainty.
2. **High — implicit fleet-wide work generation (active).** 12,490/12,502 eligible conversations are coverage debt interpreted as jobs. This is the principal root cause and credit/egress amplifier.
3. **High — active page failures.** Page 8 is indefinitely 404-pinned; page 9 spends about 180 seconds and three failed calls per selected chat. Neither stream has ever succeeded.
4. **High — per-conversation progress is not durable.** One page checkpoint and cursor-free health rows cannot preserve multiple partial/quarantined acquisitions. The observed false-complete event is one consequence.
5. **High — historical archive fidelity gap.** REST history does not enter `dm_message_archive`; generic archive records lose conversation identity and rich message fields.
6. **Medium — credit accounting is indeterminate and unattributed.** Local reservations leak until rollover; physical retries can outnumber logical reservations; reconciliation can only post anonymous external drift.
7. **Medium — incomplete OF error classification.** 401/403 are not converted to whole-page auth pause; 404 has no local release; 429/other 4xx preserve the pin without a unified transition contract.
8. **Medium — observation/acquisition evidence is fragmented.** The response envelope, request cursor, mapper version, parse outcome, and failure target are not preserved together; breaker-handled failures barely appear in observations.
9. **Low/operational — health semantics hide the outage.** Repeated partial yields reset page failure streaks, so page 9 can show no last error while every vendor request fails.

### Incident causes, latent bugs, mismatches, observability, and symptoms

| Class | Findings |
|---|---|
| Incident causes | implicit history jobs; 404 not chat-isolatable; three slow probes inside one chunk; immediate continuation over a huge candidate pool |
| Latent/realized correctness bugs | sparse inventory treated as contiguous coverage; arbitrary overlap terminal; partial cursor discarded; parse skips can coexist with completion |
| Architectural mismatches | live point capture, head reconciliation, and history hydration share one work kind; Fansly acquisition policy reused for OF; REST/archive fidelity does not match historical-truth claims |
| Observability problems | successful page 9 partials appear healthy; failed timeout calls lack observation/credit attribution; raw response envelope missing; live readiness and historical completeness mixed |
| Consequences/symptoms | page-8 wedge, page-9 churn, shared-egress occupation, credit burn, 12.5k backlog, false `complete`, lossy archive rows |

### Phase-2 claim review

The classifications below apply to the important final claims in the earlier report; several earlier paragraphs were already superseded by that report's own addendum.

| Prior claim | Classification | Independent result |
|---|---|---|
| 404 pre-I/O pin wedge exists | **Confirmed** | Exact current pin, 39 failures, no health row, code path and worker log agree. |
| Pre-I/O persistence itself should simply be removed | **Partially correct** | Separate claim from committed cursor. A leased typed job may persist its claim before I/O; a volatile local candidate is not the only correct design. |
| `100 -> 20 -> 5` can turn 45 s into ~180 s | **Confirmed** | Repeated live runs and exact attempt durations prove it. |
| Three-distinct-chat provider breaker cannot fire | **Confirmed for current timeout mode** | No counterexample in 216 post-deploy runs; a fast 5xx cohort could still reach it, so the claim is not universal. |
| `pending_backfill` amplifies the backlog | **Confirmed** | 12,490 current pending rows; code and git blame show it is both fact and queue. |
| Physical inventory is mistaken for coverage proof | **Confirmed and strengthened** | A concrete production false-complete sequence now proves impact, not only possibility. |
| One page checkpoint cannot preserve multiple partial chats | **Confirmed; missing an important mechanism** | Prior report described the state deficiency but did not identify the nonterminal-summary omission plus breaker-clear/refetch sequence or the live chat `514750406` occurrence. |
| List Chats `lastMessage` is a point fact, not coverage | **Confirmed** | Official schema and 529/529 production head parity support it. Captured fields may be fill-grade rather than full-fidelity. |
| Webhook/head capture must be separate from history hydration | **Confirmed** | 512/512 recent outbound events reached hot and both archives without history reads. |
| Exact mass-broadcast provenance of the old cohort | **Plausible but unproved** | Shape is compelling, but retained bootstrap payload/campaign correlation is insufficient and official docs do not guarantee per-recipient fanout semantics. |
| Two-contour live/archive architecture | **Confirmed as direction, conditional in backend** | Live contour is justified now. Archive contour depends on export pilot/certificate semantics or typed pagination fallback. |
| Typed verified coverage segments | **Confirmed when exact coverage is promised** | Required for partial ranges or paginated fallback; a certified export manifest may serve as a coarser certificate if its guarantees are proven. |
| Reject `summary_only` as coverage status | **Confirmed** | It cannot represent sparse facts or intervals. The term may be a UI label, but not a load-bearing completeness state. |
| Reject permanent model-head deferral | **Confirmed** | Good emergency shape filter, bad product rule; model head can follow real fan engagement. Materialize the head and keep history intent separate. |
| Indeterminate credit reservations | **Confirmed; missing an important mechanism** | Prior lifecycle is right, but logical reservation vs physical retries can also under-reserve and failed calls do not consume the guard request count. |
| Data Export is cheaper per row | **Falsified** | Export is 1/20 rows; successful max-size List Messages is 1/100 rows. Export is theoretically 5x more per row, though operationally preferable to repeated failures. |
| Data Export can be the archive backend | **Plausible but unproved** | Async resumability is attractive; reply/media/edit/snapshot/deletion/completeness guarantees are missing. No quote/start probe was made. |
| One `history_hydration_state` column is sufficient | **Stale / superseded** | The earlier addendum already withdrew this. A boolean/enum separates demand but cannot carry target, cursor, retries, or proof. |
| General scheduler rewrite is needed | **Falsified by the report and independent evidence** | Scheduler lease/expiry is healthy; fix the OF work model and handler quantum. |
| Existing numeric snapshot remains current | **Stale** | Mechanisms persist, but counts, revisions, health rows, and request totals have advanced to the 2026-07-13 snapshot above. |

### Solution comparison

| Option | Verified bug solved / classification | What remains and correctness risk | Complexity, credits, Fansly, crash, rollback, edge cases |
|---|---|---|---|
| **A. Error-handling and pin-release only** | Fixes current page-8 404 wedge and OF auth classification. **Containment only.** | Page 8 then joins page 9's synthetic backlog; 180-second ladder, false coverage, archive loss, and unsolicited jobs remain. A 404 is not proof of permanent deletion. | Low/no schema. Credits remain high. Scope to OF, no Fansly change. Crash still relies on one page cursor. Easy revert; quarantine/revalidate rather than tombstone. |
| **B. One slow attempt per chunk** | Bounds one run and shared-egress occupancy; makes the 45-second quantum enforceable. **Containment.** | Infinite invalid backlog and immediate continuations can still burn one credit/run; no data correctness fix. | Low. Set timeout to remaining deadline and `retries=0`; persist next probe across chunks if retained. OF-only. Easy rollback. Must count failed attempts and add backoff. |
| **C. No-schema candidate filtering** | If limited to “ignore pure pending,” insufficient. If it stops **all implicit OF history** and replaces head mismatch with captured-head projection/bounded repair, it fixes the live root. **Root fix for live + containment.** | Cannot express requested history; multiple missed webhook messages remain unknown; coverage must stay pending. Model-head-only filtering is not a permanent policy. | Low–medium/no migration, near-zero head credits. Provider-scoped, Fansly unchanged. Idempotent replay/crash safe. Roll back by flag, but never re-enable legacy loop accidentally. |
| **D. Persisted history-hydration intent** | Separates unknown coverage from authorized work. **Root fix for history scheduling.** | A lone boolean/enum does not preserve target/cursor/proof; use a typed job row. | Medium/additive schema. Credits only for explicit jobs. OF first; Fansly migration optional. Job lease/CAS makes retry/crash safe. Rollback stops producers/workers and retains jobs/evidence. |
| **E. Separate live from historical synchronization** | Removes the central semantic conflation. **Root fix.** | Needs concrete backends and separate SLOs; does not by itself prove archive completeness. | Medium architectural change, incremental. Live costs near zero; history budgeted. Fansly may stay on old policy. Rollback each contour independently. |
| **F. Webhooks + List Chats + Specific Message** | Best live/head contour. Captures exact new facts and repairs one known target without crawling history. **Root live fix.** | Does not discover unknown multi-message gaps or pre-webhook history; broadcast contract, deletion, PPV enrichment need monitoring. | Low–medium. Webhooks/head projection ~0 incremental credits; Specific Message ~1/repair. OF-only. Idempotent reducer makes crash/retry safe. Easy flag rollback. |
| **G. Async OFAPI Data Export** | Can avoid pathological per-chat live scraping for explicit bulk recovery. **Conditional root historical backend.** | Documented fields are lossy; snapshot, deletion, truncation, ordering and completeness semantics unproved. `skipMassMessages` default must be set explicitly false. | Medium–high: external-job/outbox, download, checksum, parser, manifests. 1 credit/20 rows; potentially expensive. No Fansly effect. Crash-resumable if vendor ID/artifact state persisted. Rollback stops starts/imports; imported facts remain. Owner gate required. |
| **H. Typed per-conversation jobs + verified segments** | Correctly handles explicit targets, multiple gaps, partial progress, quarantine, crash, and coverage proof. **Strong root fix.** | Highest implementation/migration cost; must define segment merge, parse debt, pruning and target-version rules. | High/additive schema. Credits precisely budgeted. Provider-specific first; Fansly can opt in later. Strong lease/CAS rollback semantics. Never complete on arbitrary overlap. |
| **I. Hybrid live/archive design** | Combines F for live, G for bulk where sufficient, H for targeted/full-fidelity fallback. **Recommended root + containment path.** | Requires disciplined provenance and choosing which source can certify which fields/ranges. | Medium–high but sliceable. Lowest steady live spend; explicit historical budget. Fansly isolated. Each producer/worker independently disableable; facts/certificates survive rollback. |
| **J. General scheduler rewrite** | Does not inherently solve implicit jobs, false coverage, or archive loss. **Neither containment nor root fix.** | Reopens proven leases, fairness, queue, and all Fansly paths while preserving semantic bugs unless separately fixed. | Very high/risky. No guaranteed credit gain. Broad Fansly regression surface and difficult rollback. Reject. |

### Simplest safe immediate fix

There are two layers, neither executed in this investigation:

1. **Operational containment:** with owner approval, pause only the two OF `dm_messages` streams. Keep webhook projection and `dm_conversations` running. Do not use a broad old-image rollback unless `OFAPI_DM_SYNC_ENABLED=false` or durable stream pauses are already in place.
2. **Small code root fix for live:** deploy an OF-specific candidate/follow-up policy that:
   - does not treat `pending_backfill` or head mismatch as permission for pagination;
   - materializes the exact retained/new List Chats `lastMessage` through the normal durable reducer;
   - uses Specific Message only for a known missing or incomplete head;
   - leaves history coverage unchanged;
   - classifies chat-scoped 404 as expiring isolation, clears the legacy pin, and re-admits only on revalidation/new target;
   - maps OF 401/403 to account/page auth handling and 429 to explicit retry;
   - permits at most one deadline-bounded slow attempt per chunk;
   - counts every failed physical attempt against request/credit controls.

This is more correct than “clear the 404” alone and simpler than adding history schema before the product has requested history.

For any already-progressed legacy conversation, do not clear the only cursor and continue elsewhere. Either preserve/delay that exact cursor until retry or migrate it into a per-conversation job. Refreshing `oldestStoredMessageId` after every page is not a fix: sparse webhook islands still make physical extrema unsafe.

### Recommended long-term architecture

```text
LIVE / HEAD
  webhook raw journal
    -> MessageFactCandidate
    -> hot + dm_message_archive + message_archive

  captured List Chats lastMessage
    -> point-fact candidate with list_chats provenance
    -> no coverage transition

  known missing/rich head
    -> Specific Message typed repair
    -> target-scoped health

HISTORY / ARCHIVE
  explicit product/operator intent
    -> typed acquisition job
       {kind, reason, immutable target/range, cursor, lease/CAS,
        attempts/backoff, credit budget, mapper, terminal evidence}

  bulk and lossy-enough use case
    -> async Data Export job + artifact/checksum/row manifest

  full-fidelity or targeted fallback
    -> bounded paginated per-conversation job

  verified result
    -> append-only coverage segment/certificate
       {scope, source, boundaries, parse debt, terminal proof,
        archive verification}
```

The page checkpoint should remain discovery progress. Per-conversation acquisitions own their own cursor. Message rows are facts; coverage segments/certificates are proof. A job row is persisted hydration intent, so a separate `history_hydration_state` column is unnecessary unless the product needs durable eligibility independent of jobs.

Fansly remains unchanged initially. Shared serving tables, event reducers, archives, credit plumbing, and scheduler can remain; provider-specific acquisition policies decide what creates work.

### Rollout, observability, and rollback

#### Rollout order

1. Snapshot current states, cursors, health, raw captures, 12 complete rows, credit state, and run/attempt ids.
2. Owner-gated pause of OF paginated `dm_messages`; confirm webhook and List Chats streams continue.
3. Ship provider-policy/head-materialization code default-inert. Shadow-report:
   - legacy candidate count versus proposed history candidate count;
   - known List Chats heads, already materialized, repair-needed, rich/incomplete;
   - projected credit/request reduction.
4. Enable for one allowlisted OF page, then both. Do not hardcode chat IDs/text/dates.
5. Replay retained `dm_metadata` captures idempotently into point facts; coverage must not move.
6. Deploy typed error transitions and one-attempt deadline. Clear legacy 404 pin only through the new fenced transition; preserve evidence.
7. After the work gate is live, audit all 12 legacy `complete` claims. At minimum, mark the demonstrated false claim as unverified in the new certificate plane. Do not requeue via `pending_backfill`.
8. Separately quote—do not start—a tiny Data Export pilot. Start only after owner approves cost/scope. Compare against webhook, List Chats, REST raw, hot and both archives.
9. Choose export certificates or typed pagination fallback from pilot evidence; never restore fleet-wide legacy crawling.

#### Required metrics/SLOs

Live readiness:

- webhook receive/settle/projection/archive lag by event;
- List Chats head-known vs head-materialized vs bounded-repair debt;
- auth/rate/credit blocks for active head repair;
- request duration and hard chunk-deadline overrun;
- exact-target 404/timeout rates;
- hot/archive parity, PPV/tombstone/media debt.

Historical completeness (separate from readiness):

- dormant/requested/running/backoff/failed/completed jobs;
- per-job target/cursor/lease age/attempts and credits;
- verified segments/certificates versus facts-only imports;
- parse/projection/archive verification debt;
- legacy claimed-complete but uncertified rows.

Credit:

- physical attempt ID, logical request ID, reservation state and response `_meta`;
- indeterminate age and reconciliation attribution;
- vendor-balance drift not explained by request-attributed rows;
- credits per live repair and per historical row/job.

Health must not report green merely because a 180-second failure returned `partial`, and cold historical debt must not make the live lane unavailable.

#### Rollback

- First pause history producers/workers; never roll an old binary directly into an active legacy queue.
- Disable new head/job producers by flag; keep webhook capture and already-written facts.
- Additive job/certificate tables remain; do not drop or rewrite evidence on rollback.
- If reverting to an old image, set old-compatible `OFAPI_DM_SYNC_ENABLED=false` or preserve per-stream pauses before image rollback.
- Do not delete breaker rows, raw captures, observations, failed attempts, export artifacts, or certificates.

### Tests that prove the solution

Existing deployed-source tests were run:

```text
unit:        3 files / 20 tests passed
integration: 3 files / 24 tests passed
```

Commands:

```bash
pnpm exec vitest run \
  tests/ofapi-dm-sync.test.ts \
  tests/canonicalize-sync-pull.test.ts \
  tests/page-dm.repository.test.ts

pnpm exec vitest run --no-file-parallelism \
  tests/ofapi-dm-sync.integration.test.ts \
  tests/ofapi-dm-breaker.integration.test.ts \
  tests/page-dm.repository.integration.test.ts
```

Passing is not exculpatory. Current tests simulate immediate timeout errors, explicitly expect `100 -> 20 -> 5`, cover first-page failure but not progressed-page failure, omit 404 and real wall time, and one sync test codifies `pending_backfill -> follow-up`.

Required proof suite:

1. Discover thousands of OF chats without explicit history intent; assert zero pagination jobs and unchanged truthful coverage.
2. Materialize List Chats head idempotently; assert hot + both archive planes, exact source provenance, and no coverage transition.
3. Missing known head uses at most one Specific Message request and stops at the target.
4. 404 records target-scoped unavailable state, clears legacy pin, does not mark complete, and does not retry until new target/revalidation.
5. Full executor test: OF 401/403 pauses page/account work; 429 sets explicit page backoff.
6. Virtual-time/real-abort test: a 45-second chunk never starts a second slow call and finishes within bounded overhead.
7. Failed physical attempts consume request and credit admission; four internal retries cannot hide behind one reservation.
8. Timeout/error with `_meta` settles actual spend without retaining a duplicate reservation; no-response timeout remains request-attributed indeterminate.
9. Exact production regression: page 1 success, page 2 success, page 3 timeout, health expiry/retry; assert no restart-overlap can mark complete and exact cursor survives.
10. Sparse islands 1000 and 900; assert missing 999..901 prevents complete.
11. Delayed unrelated webhook overlap while provider says more; assert no completion.
12. Parse one invalid row in a terminal page; assert parse/materialization debt prevents certified coverage.
13. Two partial/quarantined conversations plus crash/restart; assert independent targets/cursors survive.
14. Segment merge property tests: only exact adjacency/verified overlap or certified terminal boundary can extend coverage.
15. REST/export outbound facts preserve conversation/fan, reply, media, open/edit, request cursor, mapper and source where the source supplies them.
16. Raw/observation linkage preserves request, verbatim response envelope, mapper, parse result, and credit metadata together.
17. Export import is idempotent across crash after download, after partial parse, and after facts-before-certificate.
18. Rollback drill: disable new worker; webhooks/head capture continue and no legacy history request restarts.
19. Unchanged Fansly candidate, checkpoint, retention and backfill regression suites.
20. Production shadow SQL gates: no 180-second chunks, no implicit OF history attempts, head/archive parity within SLO, and no new uncertified `complete`.

### Edge cases and remaining unknowns

- One List Chat Messages 404 does not prove permanent chat deletion; recent page-1 absence is expected for an old chat.
- Official docs do not promise that lower `limit` reduces server-side scrape cost; production shows it does not for the incident cohort.
- `first_id` is documented as inclusive, so echo removal is correct; the docs' example `next_page` uses a different `id` parameter, strengthening the need to preserve the vendor envelope.
- Webhook capture is excellent in observed production, but mass-broadcast per-recipient contractual completeness remains unproved.
- Data Export may share upstream scraping pathology and is lossy for reply/media/edit fields.
- Export `maxMessages` ordering, date-bound inclusivity, snapshot isolation, deleted messages, mass-message default, and per-chat terminal proof are undocumented.
- A completed export row is a fact, not automatically a coverage certificate.
- Hot pruning is disabled now, but any future pruning makes physical-overlap coverage even less defensible.
- Conversation heads can change during repair; target identity/version must be immutable so a new head bypasses an old target's 404.
- Deletion/tombstone and PPV annotation can arrive before or after the base message; reducers must remain monotonic/idempotent.
- The exact vendor reason for broad page-9 timeouts remains unknown. A paid probe was unnecessary for root-cause selection and would add cost without distinguishing the implicit-work bug.

Confidence:

- **Very high:** current 404 pin; current 180-second ladder; dual-use pending state; scheduler not root; false-complete mechanism and production occurrence; fragmented archive/observation fidelity.
- **High:** vendor currently charges approximately one credit per failed attempt; webhook/List Chats suffice for normal live heads; breaker exposed/amplified an older problem.
- **Medium:** mass-broadcast webhook guarantees; Data Export suitability as a certified historical backend.
- **Unknown:** permanent semantics of List Messages 404 and vendor cause of broad timeouts.

### Plain-language explanation

Core sees a list of thousands of conversations. It stores “we have not proved the full history” and then mistakenly reads that sentence as “download the full history now.”

On one account it keeps reopening one conversation the vendor says is unavailable. On the other account it tries the same slow request three times at smaller page sizes, so a 45-second job occupies about three minutes and is probably charged three times. New messages are already arriving through webhooks, and List Chats already contains the latest message, so most of this work is unnecessary.

Worse, when Core downloads part of a conversation and later times out, it can forget where it got to. When it starts again, it sees a message it stored itself and incorrectly declares the whole history complete. That has happened in production.

The practical fix is to keep live messages simple: store webhooks and the latest List Chats message, use one exact-message lookup for a missing head, and do not crawl history unless someone or a product feature explicitly asks for it. Historical downloads then get their own resumable jobs and proof of what range was actually captured.
