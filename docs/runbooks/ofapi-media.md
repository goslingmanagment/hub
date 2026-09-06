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
   destination, bytes and estimate, then approve the frozen preview. A new owner
   action creates one upload; reopening the page does not upload again.
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
or bypass the page/model erasure lock and material-time fence. Upload authority,
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
