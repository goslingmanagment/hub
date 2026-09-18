# OnlyFansAPI implemented-request correctness audit

Target: **deployed 7fac98f310d673134c8dcb5dd6596e126e7f9e69**, inspected at `/tmp/hub-ofapi-audit-20260906/deployed`. The original workspace HEAD 582ef1cf was older; conclusions below are rechecked against the deployed target. Schema/docs downloaded by root on 2026-09-06: `openapi.yaml`, `llms-full.txt` in the parent directory.

Scope: client request construction, gateway parameter/response validation, background pagination, command transport/accounting, capture/export plans. No production/vendor calls, no repository edits and no Vitest invocation by this agent. Root owns the test suite and production audit. Request behavior below is reproduced with mocked fetch and in-memory dependencies; production occurrence/frequency is unverified.

Reproduction: `evidence/request-repro.mjs` and `evidence/request-repro-result.json` in this audit directory. Run from the deployed checkout with `node --import tsx/esm <absolute-path-to-request-repro.mjs>`. The harness imports the pinned code, replaces all HTTP with synthetic responses, and executes the real fan-identities source with only persistence/budget/telemetry dependencies stubbed. It performs no actual database or network operations. Source/output paths in the saved harness are explicitly pinned to the audit temporary directory.

## Confirmed findings

### R1 — P2: link and subscriber pagination can report complete with an explicit continuation

**Code:** `apps/runtime/src/services/sync/ofapi-fan-identities.ts:327` and `:420`; success returned at `:435`. Both phases use `page.items.length < pageLimit` (100) as the terminal condition and ignore `page.hasNextPage` and `page.nextPageUrl`.

**Trigger:** a short link/subscriber page with `data.hasMore=true`. The typed client already preserves that flag as `hasNextPage=true`, so the loss occurs in the consumer, after a correctly parsed response.

**Impact:** links on later pages and later subscribers are omitted, the current target is written to `completedTargetKeys`, and the stream returns `satisfied:true`. The same request revision will not revisit the skipped target. A later independent sweep may reattempt, but repeated short pages recreate the same blind spot. Conversely, a full terminal page still buys an unnecessary next page.

**Exact vendor support:** [List Tracking Links](https://docs.onlyfansapi.com/api-reference/tracking-links/list-tracking-links), [List Free Trial Links](https://docs.onlyfansapi.com/api-reference/free-trial-links/list-free-trial-links). In fresh OpenAPI, both `responses.200.content.application/json.schema.example` contain one item in `data.list`, `data.hasMore: true`, and `_pagination.next_page` pointing to offset 10/limit 10. The response schema declares `data.hasMore.type: boolean`. Tracking/trial subscriber responses also expose `data.hasMore`. Spenders use an array-only response family, so the fix must preserve a distinct completion rule for that endpoint; do not mechanically force a missing flag to false everywhere.

**Repro result:** `shortPageIdentities.result.satisfied=true`, only `tracking offset=0`, `subscribers link=10 offset=0`, `spenders link=10 offset=0` are called; offered link 20/page 2 is never fetched; `tracking:10:subscribers` is persisted complete despite `hasNextPage=true`.

**Test gap:** `tests/ofapi-fan-identities.integration.test.ts:51` helper always manufactures `hasNextPage:false`, including list-page test doubles. No short-page/true-continuation case exercises the contract. `tests/ofapi-refresh.test.ts` tests the analogous fans/active correction but not this consumer.

### R2 — P2: malformed successful list responses become a fabricated empty terminal page

**Code:** `apps/runtime/src/services/ofapi.ts:612` (especially fallback at `:619`, silent invalid-item drop `:624`, and missing continuation -> false at `:628`). Used by transactions, chargebacks, chats, messages, tracking/trial lists and users. `toFansListPage` was hardened, but the generic mapper was not.

**Trigger:** HTTP 200 JSON `{ "data": {} }`, an absent/misnamed list, or valid list plus omitted continuation evidence. JSON parsing succeeds. `observedListRequest` maps it to `{items:[],hasNextPage:false}` and returns success.

**Impact:** callers can report successful completion with missing data. Concrete downstream paths: transaction backfill stops at `apps/runtime/src/services/ofapi-transactions-backfill.ts:580`; chargeback reconcile marks `walkComplete=true` at `apps/runtime/src/services/ofapi-chargebacks-sync.ts:309`; fan identities moves to the next phase/completes targets. This is a failure to detect provider contract drift, not evidence that a normal empty response is invalid.

**Exact vendor support:** [List Transactions](https://docs.onlyfansapi.com/api-reference/transactions/list-transactions), fresh OpenAPI `/api/{account}/transactions` GET response declares `data.type: object` with properties `list`, `marker`, `hasMore`, `nextMarker`, and top-level `_pagination`. Chats/messages declare `data.type: array` with `_pagination`. Legitimate emptiness must be distinguished from the missing declared list family. The vendor's generated schema does not mark every property required; this finding rests on the documented wire shape plus Hub's capture/completion invariant, not a claim that an OpenAPI JSON Schema validator rejects every omitted property.

**Repro result:** `malformedTransactions` returns `items:[]`, `hasNextPage:false`, `nextMarker:null` on 200 `{data:{},_meta:{_credits:{used:1,balance:999}}}`. No exception is raised.

**Test gap:** current malformed-page rejection coverage is specific to `toFansListPage`, strict message/post capture and interactive shape checks. The typed generic transaction/chargeback/link methods lack equivalent malformed-envelope and invalid-item tests.

### R3 — P2: transient credential preflight failure is cached for the entire process lifetime

**Code:** `apps/runtime/src/services/ofapi.ts:733` through `:763`; bootstrap calls the preflight at `apps/runtime/src/bootstrap.ts:406` before normal use. `preflight ??=` caches unknown/denied results and rejected promises as well as verified results. There is no expiry or invalidation method.

**Trigger:** the initial `/whoami` returns 503/timeout, or preflight persistence fails once, followed by provider/database recovery.

**Impact:** all later state-changing operations using the same runtime client remain locally refused (`assertCredentialReady`) until the client/process is recreated, although a fresh read could now verify the credential. This is wider than one failed request and has no automatic recovery. Verified-team custody should remain fail-closed; retrying the read-only preflight does not require retrying any mutation.

**Repro result:** first and second `getCredentialPreflight()` both return `unknown/preflight_unavailable`; only one mock fetch is made although the next offered response is a valid expected team. No live claim about current preflight state.

**Contract context:** `/api/whoami` is a read-only credential identity endpoint. Hub's own explicit intended behavior is 'Preflight failure leaves database-only work available; stateful dispatch stays closed.' The problem is indefinite memoization after transient failure, not the initial refusal.

**Test gap:** `tests/ofapi-refresh.test.ts` covers wrong team, missing team, denied/unknown, and key isolation, but not a temporary failed preflight followed by recovery on the same client.

### R4 — P2: credit-accounting failure acknowledgement is ignored by commands and legacy gateway/admin calls

**Code:** `apps/runtime/src/services/ofapi.ts:1357` (`sendMessageRequest`), same unchecked `await reportCreditSpend` in typing/unsend/mark-read, `proxyReadRequest` and `requestCaptured`. Contrast: `observedListRequest` explicitly handles `creditSpendRecorded === false`. Sink behavior: `apps/runtime/src/services/ofapi-credits.ts:70` onward returns false after both ledger and physical-counter persistence fail and logs that the request path will stop.

**Trigger:** vendor responds successfully, while both configured credit persistence paths fail for that response; other DB operations remain usable.

**Impact:** these paths still return ordinary success; subsequent independent calls have no failure latch. A paid request can be missing from both accounting paths without a recoverable accounting disposition. The confirmed business result must be retained: changing a confirmed send into a resend/retry is not an appropriate fix. Preserve vendor confirmation and establish separate recoverable spend evidence / block further paid dispatch until accounting recovers.

**Repro result:** synthetic `onCreditSpend: () => false` is called once, yet `sendTextMessage` returns `{messageId:'123'}`. The reproduction establishes the ignored signal, not actual lost production charges.

**Test gap:** command tests assert ordinary ledger observations and one-attempt semantics, but not the negative acknowledgement from the production sink. Known `onCreditSpend` void test sinks are deliberately treated as success; this case is specifically explicit false.

### R5 — P2: accepted large numeric media IDs are silently rounded on the wire

**Code:** `apps/runtime/src/services/ofapi.ts:1308` converts every digit-only ID through `Number`; public accepted contract is `packages/contracts/src/routes.ts:4361`, allowing numeric strings of 1–30 digits; executor mirrors that pattern.

**Trigger:** a syntactically valid media ID string beyond the JavaScript safe integer range.

**Impact:** the one-attempt send targets a different ID or is rejected by OnlyFans; the persisted original payload no longer equals the request body. This is a boundary correctness defect; current real OnlyFans IDs observed in tests are smaller, so live practical incidence is not established.

**Repro result:** accepted input `'9007199254740993'` becomes `mediaFiles:[9007199254740992]` in the captured mock POST body.

**Vendor contract:** [Send Message](https://docs.onlyfansapi.com/api-reference/chat-messages/send-message) accepts OnlyFans vault IDs and OFAPI media identifiers in `mediaFiles`/`previews`. Its fresh generated `mediaFiles.items.type` is `file[]|string` and example mixes prefixed strings and numeric IDs. Either reject unsupported unsafe numeric strings before creating a command, or serialize a vendor-supported exact identifier representation; never round.

**Test gap:** numeric-wire test uses a small 10-digit ID only; no safe-integer boundary test.

### R6 — P3: read gateway still admits requests that violate required query/limit constraints

**Code:** `apps/runtime/src/services/ofapi-read-gateway.ts:302` uses 1–100 for `/user-lists`; required `ids` at `:254` and search `query` at `:220` are only validated when present because `parseQuery` iterates provided keys.

**Triggers/impact:** `/user-lists?limit=1` or `limit=100`, `/users/list` without ids, and `/chats/{id}/messages/search` without query pass local validation and reach vendor rejection rather than producing a correct local 400. Unlike R1/R2, this does not demonstrate silent data loss; severity is lower.

**Exact vendor constraints:** [List User Lists](https://docs.onlyfansapi.com/api-reference/user-lists/list-user-lists), OpenAPI `/api/{account}/user-lists` GET parameter `limit` description: 'Must be at least 10. Must not be greater than 50.' `/api/{account}/users/list` GET `ids.required:true`; `/api/{account}/chats/{chat_id}/messages/search` GET `query.required:true`.

**Repro result:** all four requests return `kind:'proxy'` unchanged. Correct plural gallery types now work in deployed target and are not an open finding.

**Test gap:** gateway tests exercise only user-lists limit=50 and valid ids/query, without the vendor-required absence/boundary cases.

## Additional verified behavior needing policy prioritization

- Legacy list retries cap a valid `Retry-After` seconds value at 60 seconds (`ofapi.ts:674–684`), and do not parse HTTP-date form. `Retry-After:600` becomes 60 seconds. Capture jobs cap at one hour; export polling ignores the header and uses fixed 5/15-minute polling. [Vendor rate-limit docs](https://docs.onlyfansapi.com/introduction/essentials/rate-limits) demonstrate honoring the seconds header. No live long-header occurrence was checked. Fixing all retry lanes requires preserving durable cursor/budget authority.
- Command HTTP 402 becomes `indeterminate/ofapi_http_402` (`ofapi-command-executor.ts:80` onward), whereas documented insufficient credit means a rejected request and the sync lane already has a dedicated insufficient-credit class. The repro confirms current classification; changing command recovery semantics deserves an explicit contract/test decision.
- Vendor now offers optional `Idempotency-Key` for message sends (24-hour stored response, replay costs zero). Current transport omits it. This is a coverage/improvement gap, not a breach of the current optional vendor contract or a reason to remove Hub's one-attempt law.
- Current media command v1 accepts only integer USD prices and a bounded subset of vendor fields. Fresh vendor schema supports decimal price (example 6.97), reply IDs, banned-word screening and more. This is deliberate narrower Hub command-contract coverage, not a faulty serialization of an accepted decimal price.

## Verified corrected / non-findings on this deployed target

- Gallery `photo/video/audio` compatibility aliases now normalize to vendor `photos/videos/audios`; `gif` is rejected.
- Search is routed before numeric message IDs and validates an ID-array response.
- Pinned messages are forwarded and excluded from certified full-history fallback.
- Fans/active parsing rejects missing list/continuation, and audience pagination follows verified vendor offset even on 19-row/empty nonterminal pages.
- Spender identity mapping uses `onlyfans_id` instead of local database id.
- OFAPI vendor egress is direct in the deployed policy; the old workspace's proxy-comment/dispatcher discrepancy is not an open production issue.
- Free `/usage/credits` balance polling replaces the paid chat ping.
- Basic command methods/path/body, one physical attempt, text/media response IDs, unsend/mark-read success parsing, capture bounded raw-body handling, and export quote/start/status request structure match the inspected vendor families. No live mutation or complete export cycle was executed.

## Memory usage for root synthesis

Used lightweight memory registry for prior audit boundaries and the known distinction between code/CI proof and production proof, then rechecked current code. Applicable citation: `MEMORY.md:277-294` (rollout `01a07179-3f24-7222-84cf-36d9bba835c7`). No factual finding above relies on stale memory. No memory file was edited.
