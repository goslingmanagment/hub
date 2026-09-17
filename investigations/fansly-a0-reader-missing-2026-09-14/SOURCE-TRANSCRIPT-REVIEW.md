# Transcript result: source contract and lookup limits

Reviewed locally against exact commit
`ac92197ba9760833ae035c3f5e8a90d084010fe6`, not the stale working checkout.
No production retry, new query, test, source change or migration gate change
was performed. This is a code/evidence review, not a new observation.

The retained result is a successful Agent API response with zero transcript
items and a zero post-dedup count in the requested scope. It does **not** classify
message ID `949097710298869762` across all dates or scopes, or associate that ID
with an aggregate A0 reader-missing occurrence.

## Why ok=true, exit 3 and no next cursor coexist

`handleAgentThreadMessages` deliberately sets `frozenSnapshot=false`, hence
`snapshotExhausted=false` on every page, including an empty final page. The
operation has no applied monotonic membership bound. `nextCursor=null` says that
this invocation did not produce a continuation; it does not freeze the mutable
population. The response correctly carries `mutable_sort_key` and
`no_frozen_snapshot` caveats.

`buildAgentEvidence` adds `delivery_not_exhausted` when snapshotExhausted is false.
The CLI returns `ok:true` when the API call succeeds, and exit 3 when
`--fail-on-partial` is present and blockers are nonempty. The retained invocation
has that flag. This is not a failed export or a reason to retry unchanged input.

Pinned source locations:

- `apps/runtime/src/modules/agent-read/handlers-threads.ts:863–868` — intentional
  unfrozen transcript delivery.
- `packages/contracts/src/routes-agent.ts:244–274` — caveat and exhaustion contract.
- `apps/runtime/src/modules/agent-read/epistemics.ts:176–177` — blocker derivation.
- `packages/hub-agent-cli/src/main.ts:49–54,304–315` — successful-call/partial exit
  distinction.

## What the empty transcript does and does not exclude

The invocation selects page `lilly-2`, conversation
`834268142812291072`, and `[2026-08-01T00:00:00Z,
2026-09-14T18:22:43.445192Z)`. No direction, sender-role, media, price, tip or
cursor filter was requested. It omits `--include-deleted`, so the route default
is true; a predicate's requested/applied booleans alone would not establish that
value, but the retained invocation and schema do.

The SQL first collects candidate message refs within that page/conversation and
window, then loads their versions from message_archive, dm_message_archive and
page_dm_messages. It selects one preferred source before applying the final
window: dm_message_archive, then message_archive, then hot. Therefore a preferred
known event time outside the window can exclude a ref whose older copy was
inside it. Timestamp filtering is half-open; **NULL event time passes the window
predicate**. It is not silently discarded.

No predicate excludes `content_pending` or an ID with a `pending:` prefix.
message_archive supplies its stored pending flag; dm_message_archive derives
pending from NULL message_created_at; hot rows supply false. The response exposes
pending as `content_pending` when a row is selected. This describes query behavior,
not evidence that a pending row exists for the target.

Deleted candidate versions dominate across the stores and are included with this
default. A chatless account tombstone can mark an existing candidate deleted, but
a chatless tombstone alone does not create a conversation-scoped candidate.
The archive capture floor is independently computed from message_archive only;
it is not a complete-history guarantee for all stores.

Pinned source locations:

- `packages/contracts/src/routes-agent.ts:1285–1294` — filters/default.
- `packages/hub-agent-cli/src/commands.ts:459–500` — transcript options.
- `packages/db/src/repositories/agent-transcript.ts:136–171,313–317,362–370` —
  NULL-inclusive windows, source selection and final filters.
- Same file `:195,232,267,288–300,409` — pending and tombstone behavior.
- `apps/runtime/src/modules/agent-read/handlers-threads.ts:947–949` — returned state.
- `packages/db/src/repositories/agent-read.ts:280–290` — archive-only floor.

Thus zero matches supports no currently selected deduplicated transcript rows for
this supplied scope/window in the count query. It does not distinguish an older
winning row, a different conversation/binding, a standalone unscoped tombstone or
no stored candidate. Those alternatives remain unclassified, not proposed causes.

## Existing exact-ID read surface

The Agent transcript query schema and CLI have no message-ID filter. The dataset
registry has no generic message-state dataset; message_media_sales is a different
purchase projection. Person resolution and full-text search do not establish an
exact message's serving state. Session archive/conversation listing routes are
also list surfaces, not an equivalent all-store exact-ID status operation.

`packages/db/src/repositories/fansly-dm-reader-heads.ts:16–21` implements the
needed no-window exact `(page, conversationRef, messageId)` classification
internally, but it has no Agent/CLI route. SQL migration
`0194_fansly_dm_shadow_reader_probe.sql:4,101,105–108` selects up to 100 current
stored heads internally and returns sampledHeads plus an EXPLAIN ANALYZE plan;
it neither accepts arbitrary target IDs nor returns their classified state rows.
The historical corpus function serves retained provider-list metadata, not
current all-store state.

No existing reviewed Agent/CLI or delegated SQL function was found that can
conclusively classify arbitrary ID `949097710298869762` independently of the
window. A transcript can positively expose that ID if its selected scope/time
matches, but this empty result does not furnish the missing exact-ID proof.
No broader access, new API or repeated request was attempted by this review.

## Evidence pins

| Artifact | SHA-256 |
|---|---|
| candidate-transcript.json | `9bce20b383b97c6717714c2869241ebe32f306090cf782ca2aeaf5f7a503d5f4` |
| candidate-transcript.execution.json | `b5101ad585b3f0d722b364a2841f6ad293f1923b7fb1937001d3c6da10ecf519` |
| ac921 agent-transcript.ts | `b891009a63f4dc0e9570196c9be599ffffe834690e66d7c24540175f988dd87b` |
| ac921 handlers-threads.ts | `1c64d95eb43b3de101c72e043f79353f5479d7574479ab049169a2725436b78e` |

The separate count-ceiling finding is recorded in UNRELATED-COUNT-FINDING.md.
It does not explain this zero-row result.
