# Publishing and campaign action batch

The owner expanded the OFAPI scope on 2026-09-06 to include publishing,
campaigns and publication queues. This batch adds 27 closed action definitions,
typed vendor mappings, and Russian owner forms. The common action engine owns
authorization, durable approval, page/account binding, one-attempt dispatch,
encrypted request/response custody, credit accounting and UI execution.
This domain module does not perform network requests or choose credentials.

## Scope and behavior

| Operations | Count | Behavior |
|---|---:|---|
| Posts create/update/delete/archive/unarchive/pin toggle | 6 | Supports documented scheduling and Saved-for-later; keeps omitted update fields omitted |
| Post label create | 1 | Creates one named label |
| Comment create/delete/pin/unpin/like/unlike | 6 | Comment text, answer target and GIF are query parameters, as documented |
| Story create/delete/mark watched | 3 | Existing media, text/mention overlays, question sticker and canvas dimensions |
| Highlight create/update/delete/add story/remove story | 5 | Update requires the complete title, cover and story list; add sends the same story ID in path and body |
| Mass-message create/update/cancel | 3 | Explicit recipient selectors, PPV media/preview validation, scheduling, distinct create/update capabilities |
| General queue list/count/publish now | 3 | Bounded date window, IANA timezone and indexed type filters; publish-now may start a campaign |

Provider receipt and downstream completion remain distinct. Mass-message
create/update and queue publish return `resultKind=queue`. Scheduled/saved post
creation also returns a queue receipt. A post-update success can have an empty
body and is therefore an acknowledgement, not a fabricated resource. A story
resource may report `isReady=false`; a returned ID does not prove ready media.

The submitted campaign intent freezes the exact selected user IDs, list names
and exclusion/window selectors. OnlyFans resolves list membership at execution
time, including future scheduled execution. It does **not** freeze a list's
current members or prove delivery to all of them. The UI makes this limitation
visible. Existing campaign reads and webhook history remain the evidence for
progress. Cancel/unsend does not remove a buyer's access to purchased material.

## Validation and local limits

Schemas reject undeclared fields, account/method/body overrides, unsafe resource
IDs, duplicate IDs, unsupported story actions and incompatible scheduling.
Media references are limited to native vault IDs and OFAPI upload IDs; arbitrary
URLs, inline files and index-based previews are not admitted by this action
lane. Existing owned-file upload and media handoff provide media references.
The common engine must still verify page/account custody and reserve one-use
media before dispatch; syntax validation is not proof of ownership. This action lane has no retry
lineage and rejects `reuseProviderOperation=true`. Vault IDs can be reused,
while an already reserved OFAPI one-use upload token requires a fresh upload.
Replaying the same accepted intent reads its stored result without dispatch.

Hub bounds are 50 attached media, 100 IDs for labels/tags/highlight members,
50 campaign list selectors, 1,000 explicit campaign user IDs, 20 story text
overlays, 10 poll choices, 16,000 text characters and a 366-day queue query
window. They are local request bounds, not claims about vendor maximums.
Queue listing has the documented maximum of 100 elements per request and no
documented cursor; it must not claim a complete queue when the window is larger.

All Hub monetary inputs use integer cents and the existing named mills codec
for conversion to vendor USD. Mass messages support 0 or 3–200 USD, including
cents. Post update documents integer USD, 0 or 3–100; the contract enforces
whole dollars. Fundraising has a whole-dollar target of at least 10 USD and
nonempty whole-dollar tip presets no greater than that target.

Clock-dependent checks live in `ofapiPublishingAdmissionIssue`, separate from
the structural schema: new scheduled publication must be in the future, and
queue start must be today or later in the selected timezone. Replay of an
already accepted intent must remain readable after its scheduled time passes.

## Live documentation and unresolved vendor gaps

[publishing-vendor-evidence.json](./publishing-vendor-evidence.json) records all
27 live documentation URLs, request/query fields and the pinned schema hash.
Every operation was checked using its live Markdown OpenAPI block on
2026-09-06. For these 27 operations the live and pinned request bodies match.
The following ambiguities apply to both sources unless specified otherwise:

- [Create post](https://docs.onlyfansapi.com/api-reference/posts/send-post)
  mentions price in its preview description but declares no `price` property.
  Paid post **creation** is not claimed or guessed. The explicit price field
  exists for [post update](https://docs.onlyfansapi.com/api-reference/posts/update-post).
- Several fields are declared `string` while their descriptions/examples are
  arrays (`labelIds`, `rfTag`, update-post `mediaFiles`); the mapping follows the
  documented array examples, as the existing message composer does. Preview
  references use the selected media IDs; direct uploads and uploaded-file
  indexes are handled outside this lane.
- [Stories](https://docs.onlyfansapi.com/api-reference/stories/add-to-story)
  expose creation, deletion and mark-watched, but no update operation or
  `scheduledDate`. Story editing and scheduling remain a provider gap; no
  hidden local scheduler or invented vendor route is introduced. Overlays
  already exist in both the pin and live docs, although the staged plan does
  not describe their complete shape. Mention overlays require one `@username`
  and cause OnlyFans to add the mentioned creator to the story's release forms.
- [Post pin](https://docs.onlyfansapi.com/api-reference/posts/pin-unpin-post)
  is a toggle with no desired-state parameter. Its action is named
  `post_toggle_pin` and is never silently retried to obtain a desired boolean.
- [Campaign update](https://docs.onlyfansapi.com/api-reference/mass-messaging/update-mass-message)
  does not document create-only exclusions, recent-subscriber targeting,
  Saved-for-later or release tags; those fields are rejected on update.
  Create's recent-subscriber window cannot be combined with scheduling or
  Saved-for-later. Changing list membership later can change recipients.
- [Queue publication](https://docs.onlyfansapi.com/api-reference/queue/publish-queue-item)
  sends immediately regardless of the scheduled date. Its success is receipt
  evidence, particularly when the target is a mass message.

## Verification, spend and rollout

Targeted unit tests cover all 27 mappings plus negative resource-path and
cross-field cases, large IDs, money conversion, update omission, query-only
comment fields, strict overlays, recipient selection and clock/timezone
semantics. Targeted ESLint passes. The integrator runs `pnpm check`, the shared
engine integration suite and owner-form/browser acceptance against the stacked
batch before declaring the PR ready.

Development OFAPI spend: **0 credits**. Only public documentation was fetched;
tests use local fixtures and no provider mutations. Adapters reserve one credit
per documented operation; the common engine's actual-credit handling remains
authoritative. Adding a campaign does not constitute authorization to send a
real campaign during development. New collector settings remain off and are
unchanged by these definitions. After deployment the owner uses the common
action preview to review the precise page, targets, media, price and schedule,
then explicitly submits that operation. No user-subscription purchase endpoint
is added.
