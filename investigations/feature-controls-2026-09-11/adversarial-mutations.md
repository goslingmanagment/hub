# Adversarial mutation review

Reviewed `c0cd21c3..d08d969c` independently on 2026-09-12. All line references in the findings refer to **d08d969c**, before follow-up fixes. Read the working agreement, Decisions 286/294/295, relevant contract declarations and the error-handling canon, then traced client intent to server persistence. No suites, browser writes, real write APIs or production operations were used for this review. Existing reports and green tests were not acceptance evidence.

## New regressions

### M1 — P2: Retained Undo can retract another contact after an unknown result

Location: `apps/dashboard/src/pages/WorkboardV2Page.tsx:148-150,184-191,203-206`.

1. A fan has an earlier contact Y. Marking **Готово** appends X and shows Undo.
2. Undo retracts X on the server, but its response is lost, or the recompute after the retraction fails.
3. The client keeps the original actionable toast (`preventDefault`, dismiss only on confirmed success) and records an unknown action.
4. A successful queue refresh clears the unknown action without identifying the retracted contact. Clicking the retained Undo calls the endpoint again.
5. The second call retracts Y. Y may be an older contact or another operator's more recent contact.

The endpoint takes page/fan only. `apps/runtime/src/modules/workboard/report.ts:327-349` calls `retractLastWorkboardContact` and then recomputes. `packages/db/src/repositories/workboard-v2.ts:652-669` chooses the newest **unretracted** row, without a receipt ID, actor constraint or idempotency key. A second request therefore has a different effect. The toast timer can be paused while the pointer remains over it; an immediate post-write error also leaves time for a refresh and second click. Sonner 2.0.7 `dist/index.js:823-828` confirms the new `preventDefault` bypasses its usual action dismissal.

Baseline `WorkboardV2Page.tsx:143-159` dismissed the action toast on click. The server weakness existed, but the repeated-Undo path through this same receipt is new. A safe client containment must consume a receipt on its first admitted attempt, including unknown outcomes; a list GET must not reactivate it.

### M2 — P2: Retrying a failed webhook apply can lock all recovery controls until unmount

Location: `apps/dashboard/src/pages/settings/OfapiWebhookRecovery.tsx:33-35,74-78,92`.

Start Apply from policy `vN/failed`. The operation is attempted and fails again, retaining version N and `failed`, but the browser does not receive its response. `readbackRequired` records baseline `vN/failed`. Every subsequent successful GET of `vN/failed` fails `webhookReadbackResolvesAction`, because the failed-state branch explicitly requires a baseline other than `failed`. The whole surface stays unavailable, including Save, history capture and local replay.

`apps/runtime/src/services/ofapi-webhook-recovery.ts:261-283` catches application failures and settles the same policy version. `packages/db/src/repositories/ofapi-webhook-recovery.ts:118-130` changes state/token without increasing that version. The wire policy exposes no apply token or attempt ID. Thus this is also a genuine evidence limit: merely accepting any `failed` GET as proof of refusal would be unsafe. The missing recovery is an explicit acknowledgement to start a separate intent after reading the current state, while preserving that the earlier result is unknown. The new unconditional UI block did not exist in the baseline.

### M8 — P2: Switching fan routes deletes an unsent note draft

Location: `apps/dashboard/src/pages/FanProfilePage.tsx:59-65`.

Enter a note on fan A without submitting, navigate directly to fan B while the same FanProfile component remains mounted, then return to A. The new route effect executes `setNoteBody("")` on each route change. A's text is permanently discarded even though the user did not save or discard it. The baseline retained a single textarea state; that incorrectly exposed A's text in B's form, but did not delete it on route change. Preventing the wrong-fan presentation does not require deleting the unsent input: the fix needs a draft map by route within the mounted component, isolated by principal.

This is a new data-loss regression, distinct from the pre-existing loss on full unmount/reload. It was initially classified too narrowly as a boundary/non-finding; this report corrects that classification. A late completion must also clear only its matching submitted draft, without clearing B or a revised A.

## Material pre-existing risks retained in the changed flows

### M3 — P1: A queued mutation can change page/fan after route navigation

Locations: `apps/dashboard/src/api/pages.ts:306-314`; `apps/dashboard/src/api/workboard.ts:59-66,81-91,95-114`; `apps/dashboard/src/pages/FanProfilePage.tsx:147-155`.

Cache two fan screens A and B, go offline, submit a note for A, then navigate to B before reconnecting. The pending mutation's variables contain only the note body. The hook's page/fan closure is replaced by B. On reconnect the queued mutation sends A's text to B's URL. Contact/snooze and their Undo hooks likewise carry only fan/body variables and can change page after a Workboard route switch. Recompute has the same page-only closure issue.

This follows the installed implementation, not an assumption about React: `@tanstack/react-query` 5.90.21 `src/useMutation.ts:30-40` retains one observer and updates its options; query-core 5.90.20 `src/mutationObserver.ts:91-92` updates options on the current pending mutation; `src/mutation.ts:184-190` executes the **current** `options.mutationFn`; the default online network mode can pause the first attempt. The new FanProfile `currentRoute` check protects textarea clearing after a response, not the POST address.

The server checks the page/fan named in the received URL (`audience/index.ts:229-246`), so it correctly accepts B if B is accessible; it has no knowledge that the user reviewed A. Workboard resolves page access before inserting the supplied fan ID (`workboard/report.ts:283-293`). No unauthorized-page bypass is claimed. These hooks are unchanged from the baseline. Freeze routing identity in variables and use those variables for success invalidation as well.

### M4 — P2: Unknown note/contact results are not idempotent and cannot be settled by an arbitrary list read

Locations: `apps/dashboard/src/pages/FanProfilePage.tsx:152-158`; `apps/dashboard/src/pages/WorkboardV2Page.tsx:148-150,212-238`.

A note can be committed before the HTTP response is lost. The UI reports **Failed to add note**, leaves the body available and permits a repeat. `packages/db/src/repositories/fan-metadata.ts:50-69` unconditionally inserts another row; the contract body (`routes.ts:1831`) has no intent key. Workboard contact likewise inserts each call (`workboard-v2.ts:564-573`) before recompute; a recompute failure can leave its projection unchanged while the contact fact already exists. Refreshing that old projection is not a receipt readback. Repeating contact adds another log row; repeating snooze moves its deadline from the new `now()` (`workboard-v2.ts:619-624`).

The baseline already had these server/API limitations and blind error retries. The new Workboard warning improves presentation but does not establish an idempotent recovery contract. M1 is the distinct new Undo regression.

### M5 — P2: AI settings conflict detection does not prevent server lost updates

Locations: `apps/dashboard/src/components/ai/AiPageDashboard.tsx:136-166`; `apps/dashboard/src/api/workboard.ts:131-140`.

Two owners read the same settings. A edits the cap; B saves a new model; A saves before a new GET reaches A. The client's JSON comparison still matches A's last read and sends all three overrides. `apps/runtime/src/modules/workboard/ai-analytics.ts:142-155` upserts without an expected version, overwriting B's model. The body contract (`routes.ts:1521`) has no CAS version. This is pre-existing and explicitly acknowledged in Decision 295.

The added receipt logic is not independent readback: the hook writes the mutation response into the report query with `qc.setQueryData` before the form's success callback. `retainAiSettingsReceipt` then compares the receipt to that same response and can clear it without a subsequent GET. No claim that the UI now enforces server CAS is supportable.

### M6 — P2: An unknown classifier start can be repeated as a new paid reclassification

Locations: `apps/dashboard/src/components/ai/AiPageDashboard.tsx:273-290`; `apps/runtime/src/modules/workboard/ai-analytics.ts:171,205-219`.

Start full reclassification; lose the start response; let that run finish; click the still-available start again after the run is no longer running. The UI retains no unknown run identity and reports only that startup failed. The server deduplicates **currently running** jobs, not the request intent. A second reclassification supersedes the newly created cache and can spend again. There is a useful durable run log, but the client does not correlate the failed start with it before enabling a new intent. Both client and server behavior predate this diff.

### M7 — P2: Screen-local keys and unknown guards are lost on unmount/reload/auth recovery

Locations: `OfapiMediaPage.tsx:27-38,97-119`; `OfapiActions.tsx:71-78,105-116`; `OfapiExportsPage.tsx:43-49,70-80` under `apps/dashboard/src/pages/`.

After an upload is accepted but its response is lost, leaving and reopening Media discards the reviewed request ID. Re-previewing the same source allocates a fresh UUID. `apps/runtime/src/services/ofapi-media-sources.ts:218-266` deduplicates by page/request ID, and its active slot includes that ID, so it permits a separate upload/charge for the same source. This is a concrete duplicate-intent risk, not loss of the original server job.

Actions similarly keeps its admission map, selected receipt and pending record in the component. Reload creates a new map; a new ID for the same command can be prepared after an earlier dispatch is unknown. `services/ofapi-actions.ts:96-125` enforces identity/body/actor agreement for **the same ID**, not uniqueness of a command across new IDs. A second dispatch still requires user confirmation, and the old intent remains in the durable history. Quotes have no client idempotency key; the server active slot (`ofapi-typed-exports.ts:39-46`) can reject a conflicting active export, but this does not recover the original intent after that slot is released. The new quote acknowledgement is useful only while the screen remains mounted.

The baseline already lost these local records. Decision 295 explicitly limits the new controls to local screen state. An SDK 401 performs `window.location.assign` (`api/sdk.ts:20-21`), and a failed auth check unmounts the outlet (`ProtectedLayout.tsx:82-91`); both discard local drafts/guards. Hydration also stores attempts in component state, although its durable request CAS prevents a second decision from being applied. No durable cross-session recovery is claimed here.

## Confirmed boundaries and non-findings

- Hydration performs a transactional current-coverage check, version/state/expiry CAS, journal and audit (`packages/db/src/repositories/agent-hydration.ts:562-657`). Same-key/same-body replay returns the original decision (`handlers-hydration.ts:480-489`). The new frozen request body does not bypass those protections.
- Webhook redelivery is protected across distinct IDs for the same attempt: the server refuses an existing dispatching/accepted/indeterminate owner under its reservation lock (`services/ofapi-webhook-recovery.ts:199-213`). Losing the browser's preview alone does not cause a second redelivery of that attempt.
- Typed export approval and control use server versions. The unknown quote gap is creation of a different intent, not replay of an already-approved row.
- Typed Actions preserve the frozen binding/generation and one-attempt state (`services/ofapi-actions.ts:194-209,249-252`); same-ID repair cannot dispatch twice. The original actor is checked on prepare replay. A currently authenticated authorized owner can dispatch a prepared historical intent; no cross-principal access-control bypass was found.
- Marketing dispatch operates by the prepared intent ID. Its modal closes after a received result and only a state string is retained locally; recovery should use durable history. No newly introduced wrong-page or duplicate dispatch by the same intent was established.

## Follow-up implementation and validation

Coordinator authorized and the current working tree implements M1/M3/M8 in the owned client files:

- M1: `pages/daily/workboardUndo.ts` creates a receipt consumed synchronously before its first transport call. Both a received success and an unknown outcome consume it; a successful queue GET never renews it. Workboard dismisses an admitted receipt after the attempt settles and preserves preflight refusal without dispatch. The helper is separate from the API module so the page does not bypass its normal query mocks.
- M3: note, contact, snooze, unsnooze, contact Undo and recompute mutation variables carry the reviewed page/fan. The mutation function and success invalidation both use those variables, including a first attempt paused offline while the observer receives fresh options.
- M8: `pages/daily/fanNoteDrafts.ts` retains drafts by full route key while FanProfile remains mounted. FanProfile selects only the current route's draft. A successful response clears only its submitted matching draft. Principal changes hide and drop the prior principal's map; a late prior-principal response cannot clear the new principal's text. Nothing is persisted in browser storage.

`tests/adversarial-mutation-intents.test.ts` adds six tests using the installed TanStack MutationObserver/online queue, two tests for one-attempt Undo (including a committed retraction with a lost response, successful GET, and second click), and four tests for draft route/principal transitions. `tests/dashboard-fan-profile-page.test.ts` only gains the auth-query fixture required by the page's principal isolation.

This agent did not run suites. A standalone synthetic reproduction against the installed query-core confirmed the original paused-mutation bug: variables for A were delivered to B's replaced closure. A separate read-only esbuild harness loaded the actual fixed factories and Undo helper with a synthetic SDK: all six original targets/invalidation scopes held and the lost-response receipt dispatched once, preserving the older contact. Another harness loaded the actual draft reducer and checked A/B restoration, late completion, revised text and principal isolation. Both harnesses made zero HTTP requests. Scoped ESLint on the eight changed/new source/test files and `git diff --check` passed. Independent review and project-wide checks are coordinated by the parent agent; no claim about their outcome is made here.

Coordinator owns M2. M4–M7 remain material server/API or cross-session limitations. In particular, the server Undo endpoint still retracts the latest contact rather than a named contact under CAS: the one-attempt client fix prevents repeating the same receipt but cannot protect against another actor's intervening contact. Freezing page/fan does not bind a delayed request to a prior authenticated session; authorization still uses the session present at execution. The draft map is discarded on full unmount, reload and principal change. Broader server idempotency/CAS and durable recovery must not be represented as fixed by this scoped client patch.
