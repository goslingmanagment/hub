# OFAPI owned media uploads and catalog

Decision #269; S7 of the September coverage plan. No production collector or
vendor subscription is enabled by deployment. Validation uses synthetic vendor
responses only; no upload or paid download is performed during development.

## Owner workflow

1. Open **OFAPI media** (`/ofapi-media`) and choose one mapped page. The initial
   view reads stored data only. Confirm the configured vendor key permits this
   account and uploads; the existing permission guard checks every request.
2. Choose an owned file and **Save source**. Hub checks the SHA-256, byte size,
   detected type and current account binding before retaining the exact bytes.
   This step has no vendor request. Supported file signatures are JPEG, PNG,
   GIF, WebP, MP4/M4A, WebM, MP3 and WAV. The direct-file ceiling is 100,000,000
   bytes. No arbitrary remote URL is accepted.
3. Select **Vault** for a reusable numeric media ID or **CDN** for material usable
   in one send. Enter a credit ceiling and **Preview upload**. Review the source,
   destination, bytes and estimate, then approve the frozen preview. It displays
   the frozen page ID/label and source filename/UUID/hash. Page and form controls
   remain disabled during async actions, and metadata approvals also carry their
   frozen page. A new owner action creates one upload; reopening the page does
   not upload again.
4. The minute sweep sends multipart `file` plus body field `async=true`, at most
   once. Progress distinguishes provider upload completion from `isReady`.
   Signed completion can settle the upload before the first status poll, including
   a callback captured before its original HTTP 202 has been parsed.
5. For vault media still converting, explicitly preview/approve **Refresh
   readiness**. **Copy verified media ID** rechecks the current account, job
   version and readiness on the server. Vault media needs `isReady=true`, no
   reported error and no explicit view denial. A completed CDN result is usable
   unless readiness is explicitly false or an error is reported; absent readiness
   stays unknown. Use the copied value in the existing desktop media selector.
6. CDN material is a capability for one send. The explicit owner handoff response
   may contain it; normal lists, canonical events, audits and analytics do not.
   Existing command custody rejects a second operation using a reserved token.
   A send with unknown outcome keeps that token quarantined. Copying is not a send.

## Collection controls and bounds

`vault_catalog` and `vault_files` remain off by default. An explicit owner job
permits only its frozen scope; it does not enable periodic collection. To enable
catalog collection, open **Settings → Collection**, select a single page's
`vault_catalog`, choose a scheduled mode, set interval and day call/credit/byte
limits, preview, and apply. Verify one run and its stored completeness before
changing another page or category. The `vault_files` category is used by approved
owned uploads; this batch does not turn it into an automatic paid binary download.

An unfiltered `vault_inventory` traversal beginning at offset zero can prove a
complete catalog only after all pages finish. Filtered, item-only, capped and
interrupted jobs remain partial. Vault lists, list details, release forms and
taggable performers use the closed read catalog. Readiness and technical metadata
are stored separately from inventory completeness. Missing fields remain unknown;
missing release-form fields do not erase previously observed references.

The global collection pause blocks the next physical request, including polling,
while retained responses and signed callbacks can still be parsed locally.
After unpausing, use **Resume approved upload** for an admission-paused job. The
owner's job-version and policy-version CAS resumes its capture and collection
rows together, keeping its cursor, original cap and source. Free polling is
allowed with the full original upload credit allowance already reserved. This
cannot revive an uncertain POST or increase its allowance. Capture/operator
recovery is required for unavailable evidence or an indeterminate upload; there
is no automatic upload retry.

The documented tariff is three credits per decimal MB, minimum one per file.
Hub rounds the preview upward to whole credits and reserves the owner's full
ceiling before upload. A maximum-size file needs at least 300 credits. Async
acceptance does not release the reservation. An explicit terminal `credits_used`
replaces the estimate idempotently; absent terminal billing stays unknown and
retains the reservation. An actual overrun is recorded before blocking handoff.
Inline HTTP 200 billing uses the captured response metadata. Status reads are
free but still count against the job's 100-request ceiling and byte limit. Each
job bounds stored response bytes to 16 MiB in addition to its owned source.

## Capture, replay and recovery

Owned bytes are `operator/ofapi.media_source.v1` observations. Physical responses
are `ofapi_capture/ofapi.media_upload_response.v1`; signed callbacks retain their
original webhook kind and source. No source is projected before it is captured.
The canonical writer verifies the observation envelope, then appends deduplicated
`ofapi.media_observed` facts and vault-native `media.file_observed` facts with an
atomic projection checkpoint and applies the serving row in the same transaction.
The registered `ofapi_media` projection rebuilds only derived catalog rows and its
watermark. Replays cannot regress a newer observation, duplicate ledger material,
or bypass the page/model erasure lock and material-time fence. The shared native
raw-media writer applies the same fence for both platforms. An event already
loaded when erasure begins cannot recreate an erased row; lock contention defers
the projector without advancing its watermark, while later observations remain
admissible. Upload authority,
source bytes, policy and spend records survive ordinary projection rebuilds.
Governed erasure explicitly removes the owned sources and catalog with the page's
other captured data.

The worker leases exact `media_upload` IDs even while the old mirror background
flag remains false. Legacy capture sweeps and the generic read collector exclude
these specialized jobs. Restarting the worker resumes captured parsing or a known
free poll; it does not repeat a dispatched stateful request.

## Live documentation and discrepancies

Verified 2026-09-06 without authenticated vendor requests:

- [Vault upload](https://docs.onlyfansapi.com/api-reference/media-vault/upload-media-to-vault)
  documents direct multipart upload, async body input, HTTP 202 with a prefixed
  upload identity and polling URL, and HTTP 200 with `data.id`. A 200 response
  may have `isReady=false`; Hub captures completion without claiming readiness.
- [CDN upload](https://docs.onlyfansapi.com/api-reference/media/upload-media-to-the-only-fans-cdn)
  returns a one-use prefixed identity and does not add the file to the vault.
  Hub supports both documented inline 200 and async 202 response families.
- [Status](https://docs.onlyfansapi.com/api-reference/media/get-upload-status) and
  the [upload guide](https://docs.onlyfansapi.com/introduction/guides/uploading-media)
  document free status reads and optional completion/failure callbacks. Async is
  a body parameter, not a query parameter. The status URL must be the exact HTTPS
  vendor origin, account and returned upload ID, without query or credentials.
- The guide advertises 1 GB for URL uploads, while endpoint descriptions say the
  subscription determines that limit. This batch accepts owned direct files only,
  so it does not assume an account's unverified URL-upload entitlement.
- The [credit table](https://docs.onlyfansapi.com/introduction/essentials/credits)
  prices uploads by bytes. Example response credits in the pinned schema are not
  a fixed per-upload price. The live direct-vault endpoint supersedes older
  descriptions that discuss only temporary CDN uploads.

Collection controls route owned-media actions to `/ofapi-media`; generic HTTP collection jobs reject `vault_files` before creating any durable job. The core messages/payments/audience categories retain their existing configurable collectors but advertise no generic one-off executor. Uploads still create their bounded task through the specialized owner approval flow.

## Desktop media images (ChatGoose Desktop)

ChatGoose Desktop shows image previews in the thread, the chat gallery and the
PPV composer's vault, and full-size photos in a lightbox. The hub decides per
file how the desktop may fetch it; **bytes never pass through or rest on the
hub** — they live only in the chatters' encrypted desktop cache. The hub keeps
locators (known file URLs), one decision-log row per resolve and the agency's
paid-download budget (migration 0210).

### Where file URLs come from

- **Webhooks** `messages.received` / `messages.sent`: canned-signature URLs
  (`Expires` + `Signature`, about 23 h, not bound to an address). Recorded in
  `processOfapiWebhookEvent` before the frame fans out; `messages.deleted`
  stops serving media known only through that message.
- **Read gateway** reads of chat messages, one message, the chat gallery, the
  vault list and one vault item: custom-policy URLs (`Policy` with an
  `IpAddress` condition — only OFAPI's proxy can fetch them). Recorded
  synchronously in `executeOfapiReadGatewayRequest` on both the capture-first
  and the proxy path, before the response is returned. OFAPI may also return
  `cdn.fansapi.com` URLs for files it already caches; those are free as is.
- **Recovery** (local, no vendor call, no credits):
  `node apps/runtime/dist/cli.js ofapi:media-locators:recover --hours 48`
  rebuilds locators from `ofapi_webhook_events.payload` and the
  `ofapi.interactive_response.v1` / `ofapi.collection_read_response.v1`
  observations of the window. Older observations never overwrite newer ones.

A daily job (the OFAPI events cleanup, 02:30 UTC) clears URLs whose signature
expired more than 7 days ago; the row keeps its linkage (chat/message or vault
item, access flags, whether a free URL was ever seen).

### The decision (`POST /api/v1/ofapi/media/resolve`)

Input is only (account, media id, `thumb|full`, surface, `auto|click`) and a
client `requestId` — never a URL. The account grant is the read gateway's.
`thumb` is thumb → squarePreview → preview (never the full file); `full` is
served for photos in jpg/jpeg/png/webp only. Outcomes, in order:

| Outcome | When | OFAPI calls | Credits |
|---|---|---|---|
| `refused` | deleted, locked (`canView=false`), processing (`isReady=false`), non-photo `full`; or the `media_previews` policy refuses (off, page ceiling) | none / refused before dispatch | 0 |
| `free_url` | an Expires-signed OnlyFans URL with more than 120 s left | none | 0 |
| `ofapi_cache` | a known `cdn.fansapi.com` URL; or HEAD (manual redirect) → `cdn.fansapi.com`, then GET (manual) for a GET-presigned URL | 0 or 2 | 0 |
| `paid` | HEAD → `dl.fansapi.com`, HEAD there for Content-Length, price = max(1, ceil(3 × bytes / 1e6)), budget admission, then GET (manual) → `dl.fansapi.com` | 2 + 1 CDN HEAD | price (estimated) |
| `cap_blocked` | `auto` over the daily budget (`daily_cap`, `retryAt` = next UTC midnight) or of unknown size (`size_unknown`) | as above, no GET | 0 |
| `source_expired` | no live URL left; `reread` names the message or vault item a click may refresh | none | 0 |
| `unavailable` / `error` | 404/410/401/403/422 from OFAPI, binding or key scope; transport, 402, 429, unexpected redirect | as made | 0 |
| `pending` | another resolve holds the file (single flight, up to 120 s or until its report) | none | 0 |

Redirects are never followed and Authorization never travels to a CDN host;
every hop is https to an allowlisted host (`cdn*.onlyfans.com`,
`cdn.fansapi.com`, `dl.fansapi.com`). The host of the Location actually handed
out decides free vs paid. A paid admission is returned when nothing was handed
out (refusal, 403, unexpected host); a hand-out keeps its charge until
reconciliation whatever the desktop later reports. A repeated `requestId`
returns the recorded answer without a second charge; `pending` is final for
its `requestId` (retry with a new one). The desktop reports each transfer to
`POST /api/v1/ofapi/media/reports` (≤100 per call, idempotent by `resolveId`);
a paid resolve becomes `confirmed` on a reported success and `unknown`
otherwise — a lost report is unknown, never zero. Both routes accept only a
chatter device token and are rate-limited per device (resolve 300/min).

### Limits

1. **Agency budget**: `OFAPI_MEDIA_DAILY_CAP_CREDITS` (default 100) credits
   per UTC day for all paid media downloads together
   (`ofapi_media_daily_budget`). `auto` passes only while used + price ≤ cap
   (atomic conditional update); a `click` always passes and is logged
   `over_cap`. Env-only: a change needs a redeploy.
2. **Category ceiling** `media_previews` (see
   [collection policy](ofapi-collection-policy.md)): off until the owner
   applies it. The free HEAD/cached GET (`ofapi_media_probe`) reserves 0; the
   paid GET (`ofapi_media_download`) reserves its price, so the per-page
   `dailyCreditLimit` is an emergency ceiling on all media downloads,
   clicks included. Free URLs work while the category is off.

Paid resolves also write an estimated `ofapi_credit_ledger` row (operation
`ofapi_media_download`, linked from the log's `ledger_entry_id`), so the
forecast and the burn monitor see them. A re-read made only to refresh media
URLs (desktop read intent `media-context-v1`) is marked in the ledger: on the
capture path its attempt's `surface` ends in `:media_context`, on the proxy
path the ledger row has `details.context = 'media'`.

### Owner enable steps

1. Deploy the hub (migration 0210 is additive and listed as rollback
   compatible). Until then a new desktop shows images as unavailable.
2. Optionally run the recovery command above so today's webhook URLs are
   usable at once.
3. **Settings → Collection**: for each OnlyFans page select `media_previews`,
   mode **On demand**, daily credit limit **300** (the suggested emergency
   ceiling per page, clicks included), preview and apply. One category per
   apply.
4. Keep `OFAPI_MEDIA_DAILY_CAP_CREDITS=100` unless deciding otherwise.
5. Watch the statistics below for three days.

Rollback: redeploy the previous image. The media routes disappear; the
desktop shows "unavailable" quietly. The tables stay and are reused on the
next deploy.

### Statistics: credits per day on media

```sql
select accrual_day, outcome, surface, media_type, variant, trigger,
       count(*) resolves, sum(credits_estimated) credits,
       count(*) filter (where over_cap) over_cap,
       count(*) filter (where had_free_url_expired) missed_free
from ofapi_media_fetch_log where accrual_day >= current_date - 30
group by grouping sets ((accrual_day), (accrual_day, outcome),
                        (accrual_day, outcome, surface, media_type, variant, trigger))
order by accrual_day desc, credits desc nulls last;
```

Re-reads made for media (1 credit per message read, per gallery/vault page):

```sql
select (l.occurred_at at time zone 'utc')::date as day, count(*) reads, sum(l.credits) credits
from ofapi_credit_ledger l
left join ofapi_request_attempts a on a.id = l.attempt_id
where l.occurred_at >= current_date - 30
  and (a.surface like '%:media_context' or l.details ->> 'context' = 'media')
group by 1 order by 1 desc;
```

Reconciliation. The accrual job (00:40 UTC) also stores the previous day's
free vendor usage, grouped by endpoint, in `ofapi_vendor_usage_snapshots`
(`refreshOfapiVendorUsage`). Its `api/{account}/media/download/{cdnUrl}`
row (credit type `media_scrape`) is the vendor truth; the aggregate is never
apportioned back to files:

```sql
with vendor as (
  select (s.scope ->> 'from')::date as day,
         sum((r ->> 'credits')::numeric) as vendor_credits, sum((r ->> 'requests')::int) as vendor_requests
  from ofapi_vendor_usage_snapshots s
  cross join lateral jsonb_array_elements(s.data -> 'results') r
  where s.scope ->> 'groupBy' = 'endpoint' and s.scope ->> 'from' = s.scope ->> 'to'
    and r ->> 'endpoint' = 'api/{account}/media/download/{cdnUrl}'
    and s.id = (select max(id) from ofapi_vendor_usage_snapshots l where l.scope = s.scope)
  group by 1
), hub as (
  select accrual_day as day, sum(credits_estimated) as hub_credits,
         count(*) filter (where outcome = 'paid') as paid_resolves
  from ofapi_media_fetch_log group by 1
)
select coalesce(v.day, h.day) as day, h.hub_credits, h.paid_resolves, v.vendor_credits, v.vendor_requests,
       v.vendor_credits - coalesce(h.hub_credits, 0) as difference
from vendor v full join hub h on h.day = v.day
where coalesce(v.day, h.day) >= current_date - 30
order by 1 desc;
```

A repeated `paid` for one `path_sha256` shows how long OFAPI keeps its cache;
`missed_free` counts files whose free URL had expired before anyone looked,
the measure of whether prefetching would pay off (there is no prefetch).
