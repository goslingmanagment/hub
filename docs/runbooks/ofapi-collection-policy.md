# OFAPI collection policy and bounded work

S-POL separates a supported API from permission to start collecting. Deploying
migration 0159 creates revision 0 with no overrides and no new collectors enabled.
The closed `OFAPI_COLLECTION_LEGACY_OPERATIONS` list keeps pre-existing callers
under their existing controls until the owner applies a category policy. The
catalog exposes that list; a new collector being off does not claim to stop those
legacy paths. Any explicit category policy takes precedence over legacy controls.
A missing or malformed policy store fails closed and is never reconstructed from
environment flags.

Policy precedence is page override, default override, the enumerated legacy
caller baseline, then off. New callers must pass `collectionContext` with the
category and purpose (`background`, `interactive`, or `one_off`). `detail: true`
requires the category's `includeDetails` setting. A known quote must be passed as
`reservedCredits`; absent a quote the request is estimated and bounded by calls.

The owner uses the collection API's local GET and free preview, then applies one
category with the observed revision. A stale revision returns 409. Applying
changes writes policy and audit atomically, so `applied` means subsequent
transport admission reads the new state. These local statuses do not claim
remote webhook changes; shared event registration has its own readback workflow.

Background pause covers managed legacy list retries, capture workers and new
collectors. Explicit interactive requests keep their separate allowance; free
diagnostics and authorized send commands are separately classified. Mode `off`
stops new background and interactive reads for that category, including hydration.
One-off jobs need an explicit approval with page, category, call/credit/byte caps,
optional history window and selected IDs. Vault files require selected IDs.
Disabling a category pauses its queued/running jobs without resetting checkpoint.
Resuming a paused job requires owner CAS approval and retains its existing caps
and checkpoint. It cannot extend exhausted allowance.

Every physical managed request reserves once under a database lock. Category
budgets are separate for background, interactive and one-off work. Existing global
credit/floor/principal guards still apply in the governed capture transport.
Capture commits before collection accounting settlement; a settlement failure
leaves its reservation visibly pending and cannot discard the paid response.
Known charges above an estimate increase job consumption and stop further work.
In-flight responses and already accepted export/upload callbacks continue to be
retained after a pause. This is a limit on new managed requests, not a guarantee
about all charges to the OFAPI team.

The bounded executor consumes `ofapi.collection.run` payload `{jobId}`. It must
load `getOfapiCollectionJob`, use `collectionContext:{category,purpose:'one_off',jobId}`
at physical dispatch, cap response/download bytes to `max_bytes-used_bytes`, and
call `updateOfapiCollectionJob` after durable capture with checkpoint and measured
bytes. `listPendingOfapiCollectionJobs` recovers a lost queue wakeup. A scheduled
executor must read `getEffectiveOfapiCollectionPolicy`, respect `intervalMinutes`
and `maxCallsPerRun`, and retain its cursor; re-enabling cannot start automatic
historical catch-up. Those executors and the corresponding UI are prerequisites
for production activation, not implied by this policy module.

No production mutations or paid vendor probes are part of this batch. First
activation: deploy the reviewed code, read the baseline, select one page/category,
preview a limited on-demand pilot, apply its revision, explicitly request the
bounded job, then observe captured data, errors and actual credit attribution.
Increase cadence only in a separate reviewed policy edit after that window.

## `media_previews` (ChatGoose Desktop images)

The category admits only the OFAPI media transport of the desktop media
resolve service ([media runbook](ofapi-media.md#desktop-media-images-chatgoose-desktop)):
modes `off` and `on_demand`, purpose `interactive`, price unit
`calls_and_bytes`, no background executor and no one-off jobs. It is off until
the owner applies it; while off, every OFAPI-backed image resolves as
`refused` (`collection_off`) and only free webhook URLs and known OFAPI-cache
URLs are served. The redirect probe `ofapi_media_probe` (HEAD, or the GET of a
file OFAPI already caches) reserves 0 credits and so never consumes the
ceiling; the paid `ofapi_media_download` GET reserves its byte price
(3 credits per decimal MB, minimum 1). The page's `dailyCreditLimit` is
therefore an emergency ceiling on all paid media downloads of that page,
explicit clicks included, on top of the agency-wide
`OFAPI_MEDIA_DAILY_CAP_CREDITS` budget (default 100 per UTC day).

Recommended owner setting, per OnlyFans page: mode **On demand**, daily
credit limit **300**. Nothing is applied by deployment.
