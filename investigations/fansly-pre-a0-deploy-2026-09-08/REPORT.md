# Pre-A0 deployment verification — 8 September 2026

**Deployment passed; prerequisite acceptance is still open.** The owner approved
deploying `b47f552abb97f44a7c10ffad005a871c99d4ff18` with head catch-up disabled
and the normal automatic sync-pull v6 replay. No recovery flag, manual replay,
socket probe or A1 activation was authorized or performed.

## Deployed changes and tests

| Change | PR | Validation before merge | What it proves |
|---|---|---|---|
| Known-head debt and bounded recovery, decision 277 / migration 0172 | [#157](https://github.com/goslingmanagment/core/pull/157) | `pnpm check`: 3,099 passing unit tests; Docker PostgreSQL: 66 tests, zero skips; independent review closed; all five CI checks successful | Stale reads retain exact targets; attempts/backoff and chunk/restart continuity work; rollback preserves ordinary history progress |
| Reply parent/root repair, decision 278 / migration 0173 | [#158](https://github.com/goslingmanagment/core/pull/158) | `pnpm check`: 3,103 passing unit tests; Docker PostgreSQL: 55 tests, zero skips; independent review closed; all five CI checks successful | Retained v5 data repairs through ledger and serving projection; independent clocks preserve newer body material and explicit clears; existing replies, shadow lift and OFAPI behavior survive |

Both check runs retained nine existing unit skips and the existing type-error
ratchet (1,908 within budget). These are the recorded pre-merge tests, not tests
repeated during deployment. This turn also passed `build:production` and the
standard deployment script's dependency, revision and health checks.

## Runtime acceptance

The clean detached checkout of the exact merged revision was deployed with
`scripts/deploy-production.sh --mode dist-only --no-image-gc`. The script
finished successfully. API, worker and scheduler independently report image
revision `b47f552abb97`, healthy status and zero restarts. Migrations 0172 and
0173 are present. The protected sync health endpoint returned HTTP 200 during
deployment; a later loopback `/api/v1/health` read reported API/database OK.
The production-pinned Hub CLI was rebuilt to the same revision; the contract
hash is unchanged. No runtime code was edited after deployment.

At approximately 12:24 UTC, the authenticated Configuration view showed active
API/worker/scheduler heartbeats and the running/editor value `none` for
`fanslyDmHeadCatchupPageAllowlist`. The numeric override version was not exposed:
direct navigation to the JSON endpoint was blocked by the browser client.
Before any approved flip, refresh the dashboard and use its normal version-CAS
save. Do not reuse an assumed `expectedVersion`.

API logs contained 259 info entries and scheduler logs four info entries, with
no warnings/errors in the collected post-start window. Worker logs through
approximately 12:23 UTC contained no level-error entries, but did contain:

- Three completed canonicalization sweeps, lasting 193.485, 176.531 and
  208.375 seconds. Together: 24,005 scanned, 39,480 appended, 183,843 deduped,
  12,005 stamped; zero parser errors, unavailable-body skips or partition blocks.
- 12,000 unmapped **visits** across those sweeps. This is not a unique-row count
  or a per-family attribution; complete replay acceptance has not been shown.
- Two projection-duration warnings: 52.917 and 48.813 seconds against a
  45-second tick budget. These are work durations, not delivery latency.
- Thirteen golden-signal warnings involving historical canonicalization lag
  and the OFAPI v5 / sync-pull v6 backlog metrics. The canonicalization metric
  includes old observations replayed now; it cannot establish fresh-message p95.

Disk remained about 31 GiB free, 61% used. Database size rose from 31,930,129,431
bytes at 12:17:42 UTC to 31,982,615,575 at 12:23:01: **52,486,144 bytes**.
This includes all concurrent database activity and is neither replay-only
growth nor a steady-state forecast.

## Reply repair: one demonstrated repair, incomplete corpus

The six original exact IDs were read through the production Hub transcript CLI
at 12:21:16–12:21:22 UTC and compared with retained raw from the original
`[2026-09-07T01:45:00Z, 2026-09-08T01:45:00Z)` diagnostic window.

| Page | Parent | Root | Material check |
|---|---|---|---|
| lilly-1 | Repaired; matches raw | Repaired; matches raw | `textHtml` hash matches raw content; zero raw/served attachments |
| lilly-2 | Previously present link preserved | Still absent | Plain-text hash matches raw content; zero attachments |
| ari-1 | Still absent | Still absent | Plain-text hash matches raw content; zero attachments |
| lora-2 | Still absent | Still absent | Plain-text hash matches raw content; zero attachments |
| lora-1 | Still absent | Still absent | HTML parity pending; plain-text bytes are not the raw HTML bytes |
| lora-3 | Still absent | Still absent | HTML parity pending; plain-text bytes are not the raw HTML bytes |

All six exact IDs were returned from `message_archive`. Missing parents fell
from five to four in this sample. Five roots remain absent. The lilly-1 repair
was first observed at 12:21:20 UTC; this is not an event-latency percentile.
Its older retained material already repaired the link even though the later
September observation of the same message was still stamped v5.

Every transcript response carried `delivery_not_exhausted` and
`field_state_insufficient`; exit code 3 was retained. Exact returned fields
support the positive comparisons, but these reads do not certify corpus
completeness. No body was unavailable in the diagnostic raw window. The
994-message raw-reply corpus has not yet been fully compared with serving.
Nonempty attachments, explicit clears and stale-after-fresh cases still need
production acceptance; the integration tests cover them locally.

At 12:23:01 UTC the full sync-pull family had 12,887 v6 observations and
353,640 pending. The DM subset had 3,581 v6 and 64,997 pending; the oldest
pending DM was received on 10 July. Replay is progressing through retained
history, so the September cohort is not yet consumed. No manual acceleration
or parse-stamp reset was performed.

A separate post-deployment lilly-2 capture was positively readable through the
`page_dm_messages` fallback while its observation remained unparsed. This
proves that one hot read remained available; it does not prove unchanged
freshness for archive-only fields or all consumers.

## Known-head debt and recovery baseline

At 12:23:07 UTC, all completed unconfirmed recovery attempt counters were zero;
the allowlist remained `none`. The debt report showed 50 exact lilly-2 receipts
and one lora-1 receipt from the ordinary collector. It still held 2,708 pending
heads: ari-1 5, lilly-1 75, lilly-2 2,473, lora-1 76, lora-2 39, lora-3 40.
These are all-known-head debts, including older/hidden/excluded rows. They are
not the fixed diagnostic cohort below and are not an archive census.

The original fixed raw-ID cohort at 12:22:00 UTC:

| Page | Known heads | Still absent from captured message bodies |
|---|---:|---:|
| ari-1 | 64 | 1 |
| lilly-1 | 1,671 | 4 |
| lilly-2 | 5,615 | 2,371 |
| lora-1 | 43 | 1 |
| lora-2 | 21 | 0 |
| lora-3 | 13 | 0 |

Lilly-2 had 2,506 missing in the pre-deploy 11:56 UTC snapshot. The later
decrease is ordinary collection, not evidence that the new recovery flag
worked. Neither raw receipts nor a `complete` history status prove full archive
acceptance.

## Next owner gate, prepared but not executed

Proposed small-page canary: `none` → `ari-1`, observe for **60 minutes**, then
return to `none`. Starting and returning the flag both require the owner's
explicit approval of this bounded canary. Refresh effective state before the
change, record its actual version through the supported control, and abort on
a concurrent configuration conflict. No checkpoint reset or budget increase.

Ari-1 currently has two eligible exact targets:

- Conversation `952822347599994880`, message `953208142580178944`.
- Conversation `953353803074117634`, message `953354621215076352` — the original
  stale-follow-up case.

Three other ari-1 debts retain identity/exclusion reasons. Each selected target
uses the existing five-attempt/five-message-page search bounds and shared
physical-request budget; later targets may enter during the window. Activation
takes effect through the next ordinary full list sweep. Record debt, exact raw
receipts, serving fields, exclusions, backoff, exhausted IDs and 429/error logs
before/after. An unfinished attempt or absent archive row remains unresolved.
Rollback allows an in-flight request to finish and preserves ordinary history
continuity and all debt. Lilly-2 recovery remains a separate owner gate.

## Migration state

| Stage | State | Measured savings / latency | Remaining acceptance |
|---|---|---|---|
| Pre-A0 P1 stale head + lilly-2 queue | #157 deployed, flag off | Not measured | Small-page canary, separately approved lilly-2 recovery, exact raw and archive acceptance |
| Pre-A0 P2 reply link | #158 deployed, automatic replay active | First sample repair observed 12:21:20 UTC; no percentile | Four sample parents and five roots; wider corpus and freshness/growth checks |
| A0 + T0 | Not started | Not measured | All three prerequisites, then offline comparison and ≥7 complete days of shadow |
| C1 | Not started | Not measured | Begin only after A0 starts; measured trigger diagnosis and narrow fix |
| C2a / C2b / C2c | Not started | Not measured | Correctness → shadow → gated selection, as planned |
| W0 / B0 / B1 | Not started | Not measured | Management Session; explicit live-probe approval; capture/hints gates |
| A1 | Owner-gated; not started | Not measured | A0/T0 safe-stop and freshness evidence plus explicit yes |
| B2 | Not authorized | Not measured | Separate owner decision |

Provider-side deletion remains a future A0 discrepancy category; no head repair
for deletion was added. No reduction in polling or ≥50% savings is claimed.

## Evidence

[Runtime](evidence/runtime-final.txt), [effective configuration](evidence/configuration.txt),
[worker counters](evidence/worker-summary.json),
[full family backlog](evidence/replay-backlog-second.txt),
[reply comparison](evidence/reply-comparison.json),
[serving sample summaries](evidence/reply-serving-second-summary.json),
[raw sample hashes](evidence/reply-raw-six.txt),
[head debt](evidence/head-debt-second.txt),
[fixed cohort](evidence/fixed-cohort-after.txt).
SQL used `read_only`, `BEGIN READ ONLY` and 20–25 second statement timeouts.
No base-table grant was widened; denied archive/config/metrics/cursor reads
were not bypassed. Full local deployment logs remain in
`/tmp/hub-fansly-pre-a0-deploy-20260908/`; durable evidence omits transcript text
and credentials. This report is a local operator record, not an additional
implementation PR.
