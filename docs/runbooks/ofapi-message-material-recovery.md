# OFAPI message material and AI freshness

A successful capture-first `ofapi_gateway_chat_messages` response commits its
message material to `message_archive` before it is returned to the desktop.
The raw observation commits first. Ledger append and the existing archive
reducer run in one transaction; the observation is stamped only after serving
material commits. Failure returns 503 and leaves the capture locally replayable.
Neither the request handler nor recovery repeats the vendor request.

Interactive ascending `last_id` tails and descending `first_id` history both
contain usable message facts. Their material parser validates message identity,
time and direction, independent of list order or pagination metadata. Strict
descending order, overlap and cursor checks remain in the background history
certificate parser. Saving a tail grants no coverage certificate.

Inline projection applies only the exact appended/deduped event batch. It does
not advance an account projection watermark: intervening ledger events still
belong to the normal sweep. Retry uses the same reducer and immutable event
identity, including recovery after a previous append committed without serving.
Erasure locks/fences, sticky deletion and monotonic purchase state remain in
effect. The AI union resolves overlapping REST copies using vendor-change and
material-observation clocks, with the webhook copy winning legacy ties.

## Repair captures stamped by materializer v2

Version 2 rejected ascending multi-message tails as `message_order_invalid`
and stamped them consumed. Version 3 accepts their message material. The normal
sweep keeps its pending floor at 2, so deployment alone does not replay all
historical v2 captures. Use the explicit bounded local repair below.

Preview on the deployed runtime containing this fix:

```sh
pnpm cli ofapi-message-material-replay \
  --page lora-vip-of \
  --from 2026-10-02T22:30:00Z \
  --to 2026-10-02T23:00:00Z \
  --limit 100
```

The dates are the receipt window of the reported incident, not the message
creation window. The CLI opens only a database context; it does not initialize provider clients
or run their credential preflight. Preview is a SQL READ ONLY transaction. It reports candidate
captures/items, skipped shapes and a resume cursor; candidate counts precede
erasure filtering and event deduplication. It prints no message bodies and
makes no OFAPI calls. Confirm page and window before executing on production.

With owner authorization, repeat the same command with `--execute`. A run is
limited to one page, a finite `[from,to)` window and at most 500 observations.
When `hasMore` is true, resume with `--after-id <nextAfterId>`. If `stoppedAt` is
set, execution exits nonzero and the cursor stays before the failed capture;
resolve the failure and retry that cursor (omit it if null). Unavailable raw
payloads, missing ledger partitions and active erasure locks do not trigger new
vendor requests, partition creation or parse-version resets. Invalid/non-message
captures are counted under `skipped`, not declared recovered.

## Verify

- Check the selected observations have parse version 3 and their material
  events retain original observation lineage and message creation time.
- Read the affected conversation through the AI transcript loader. Compare the
  actual message IDs, including the middle of the gap, with the captures;
  matching only the latest ID is insufficient.
- Check a new ascending chat read followed immediately by AI uses all displayed
  messages without waiting for a worker sweep. Successful serving guarantees
  visibility of that captured response, not knowledge of messages the provider
  has not delivered or completeness of older history.
- Re-running the same bounded repair must append nothing. Credit consumption,
  coverage certificates and account projection watermarks must not change.

The fix removes Hub's loss/delay after a response is captured. Delayed upstream
webhook delivery is a separate source condition and is not repaired by replay.
