# Fansly A1 bounded dialog polling

Decision 346. Delivered default-off. Do not interpret a deployment or a bounded
completion as acceptance of A0, savings, full-list coverage, or live freshness.

## Controls

| Live key | Default | Meaning |
|---|---|---|
| `FANSLY_DM_BOUNDED_ENABLED` | `false` | Master switch |
| `FANSLY_DM_BOUNDED_PAGE_ALLOWLIST` | empty | Exact comma-separated page labels; empty/none admits nobody |
| `FANSLY_DM_BOUNDED_POLICIES` | `{}` | Per-page objects with `fullIntervalMinutes`: 30, 60, 180 or 360 |

A policy example is `{"lilly-1":{"fullIntervalMinutes":30}}`. It retains full
walks in every original 1800-second slot. Missing, malformed or unlisted policy
also falls back to full. Longer intervals are explicit candidates, never an
automatic progression. Config admission is refreshed once per chunk.

The handler persists the scheduled/start slot when it opens a full sweep. A
00:00 full ending 00:12 still owes the 00:30 slot under full30; completion does
not start a new 30-minute timer. Existing in-progress full walks finish as full.
A full deadline reached during bounded continuation starts a new full at the
next chunk, without interpreting the bounded offset as a full continuation.

## What a bounded completion means

It checked a prefix using the existing page egress, rate limiter, raw-first
capture, lease/erasure fences, normalization, head debt and message follow-ups.
Its stop requires three fully unchanged pages, matching raw list/embedded head
IDs, descending known timestamps and a boundary strictly before the last
certified full's start minus 60 seconds. Equal timestamps reset the streak;
unknown markers and ordering violations disable early stopping for that walk.
Request caps apply to a dispatch; cursor progress survives subsequent dispatches.

It does not stamp membership generations, hide unseen threads, certify full
membership, renew full success or clear an existing failure. Reaching the end of
the provider list has the same limited meaning in bounded mode. Full-list
freshness comes only from the certified full completion. Its target follows the
page's live policy: `(fullIntervalMinutes + 30) × 60` seconds, so full30 and
unlisted pages keep 3600 and a 180-minute page is judged against 12 600
(Decision 366). Detailed status and lightweight summary both enforce this
independently of a recent bounded run, and both fall back to 3600 on the very
next read after the page leaves A1 (expect `delayed` until the fresh full
completes). `/health/sync` inherits the same target through the block's
`delayed` state (`stalled_streams`). The target only applies to a certified A1
proof; a legacy full cursor keeps 3600. The read paths derive it from config
alone, so a cadence or slot-offset mismatch (where the executor falls back to
full-every-slot) reads leniently. Bounded progress never shows a whole-list
percentage.

Mutable offsets may omit a group after delete+insert below the read offset with
unchanged totals. Timestamp order and zero observed misses cannot prove a stable
snapshot. Quiet changes to unread, flags, deletion and membership are detected
only by the certified full. Decision 366 accepted a 180-minute full on the five
deep inboxes (lilly-1, lilly-2, lora-1, lora-2, lora-3) after seven A0 days
showed no below-stop change carrying a new message, sixteen flag changes on a
column nothing reads, and 21/0/one-sweep changes to unread, visibility and heads;
WS hints cover new messages and conversations in between. Ari-1 keeps full30.

## Activation evidence

Development and default-off deployment can proceed before the A0 calendar gate.
Activation requires the accepted A0 report, explanation of the two historical
Lilly-2 reader_missing records, stop/churn fixtures, and evidence preserving the
freshness of the entire mutable scope. No online/presence result is inferred.

The accepted plan permits only one page/setting at a time, with explicit
30→60→180→360 decisions. Each step requires its own comparison window (at least
three days; seven for the first substantial change and complex inboxes), full
comparator, dropped-frame/churn checks, physical HTTP-attempt cost and reader
freshness evidence. The freshness target is never raised silently: it is derived
from the same per-page policy that lengthens the interval (Decision 366), so a
page reads as delayed exactly when its own accepted full is late. Decision 366
skipped the 60-minute rung and activated 180 on the five deep inboxes in one
authorized round; further rungs (360) still need their own evidence and decision.

## Rollback and verification

Disable the master flag or remove the page from the allowlist. At the next
chunk, a bounded cursor is abandoned and a new full starts at offset zero with
a generation above both stored rows and checkpoint metadata. A full already in
progress continues. Old binaries also reject `mode: "bounded"` and open a fresh
full. Preserve raw facts and cursor receipts; do not delete data as rollback.

After a default-off deploy verify the merged source/image and health of API,
worker and scheduler, with no flag flip. For a future canary, inspect the cursor
mode, frozen full proof, scheduler anchor, bounded progress, independent full
freshness and physical attempts. Test coverage includes cap/resume, off/deadline
rollback, full30 slots, raw-before-apply failure, full/bounded generation
separation, full-mode preservation and both status readers.
