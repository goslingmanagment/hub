# Stage 24 — Desktop migration: SDK, stream v2, direct-read removal

**Repo(s):** desktop · **Depends on:** 20 (SDK), 21 (stream v2), 22 (device tokens); Q5
(resolved — release hygiene per stage-04) · **Passport:** roadmap.md §4, stage 24

**Status header.** No deviation from the master. Two verified sharpenings that shrink the
work: (1) the read-transport enum has **exactly one behavioral branch** — the composition
root's client construction (`apps/desktop/src/main/index.ts:411`); everything else is UI
(`HubSettings.tsx:127-135`, `SpendersSettings.tsx:28`) or log tagging
(`polling-sync.ts:260,506,537,566,631,654,673` — `transport:` telemetry fields, not control
flow). DP 8's removal is therefore small and precise. (2) In hub read mode the desktop
already reuses its OFAPI-shaped client against the hub gateway
(`buildHubOfApiReadBaseUrl` → `…/api/v1/ofapi/read`, `apps/desktop/src/main/ofapi/transport.ts:7-13`)
— so "remove direct mode" means deleting the *direct construction branch and its key*, not a
read-path rewrite. Scope guard note: this spec does not describe how the OFAPI or hub keys
are stored beyond naming the keychain seam (`secrets/keychain.ts`) — custody mechanics stay
as built.

## 1. Context

The desktop becomes a pure kernel client. Today it: hand-verifies a 971-line hub client
against an OpenAPI snapshot dated 2026-06-11 (`packages/shared/src/hub/client.ts:1-6`);
consumes SSE v1 with a proven resume/snapshot discipline (`sync/hub-sync.ts`); authenticates
with a bare chatter bearer key from the OS keychain; and still offers Direct-OFAPI reads —
a locally held team-wide OFAPI key one settings flip away (`store.ts:176`, default `'hub'`
`:236`), bypassing tenancy, capture (Stage 9), and credit attribution. Writes are already
hub-only by hard invariant (`ofapiWriteTransport: z.literal('hub')`, `store.ts:178`;
fail-closed `disabledDirectWrite`, `ofapi/transport.ts:16-18`) — that is DP 8's precedent,
now applied to reads.

**Entry criteria restated as facts to verify:**
- Stage 20 exited: `@kernel/sdk` stable under the dashboard for ≥2 weeks; desktop repo
  already carries the pin + contract-hash drift CI (stage-20 §2 wired it).
- Stage 21 exited: v2 conformance suite green; smoke consumer clean over 24 h; v1 serving
  untouched.
- Stage 22 exited: device tokens issuable (`agency_hub_device_` prefix), dual-accepted with
  chatter keys; SSE re-auth handles both.
- Stage 4's release discipline in effect (Q5 artifact-diff ritual; `x-client-version` header
  live).

**Deliverable:** a desktop release where: every hub call goes through the pinned SDK; SSE is
v2 (with a rollout-window-only v1 fallback flag); login is a one-time device-token flow;
Direct-OFAPI read mode is **gone** (settings enum collapsed to `hub`, direct branch and
`ofapiKey` construction deleted); chat freshness verified unchanged over a full week.

## 2. Changes

**desktop — SDK adoption** (`packages/shared/src/hub/` + `apps/desktop/src/main/hub/`):
- The hand-written `HubClient` operations (`client.ts:544-574`: `listPages`,
  `getFanProfile`/`putFanProfile`, `postUsageBatch`, `getOfapiCreditsSummary`,
  `createOfapiCommand`/`getOfapiCommand`/`cancelOfapiCommand`, `streamAiGateway`) re-implement
  as thin delegations to `@kernel/sdk` typed operations behind the **same `HubClient`
  interface** — callers (send engine, usage reporter, hub module) do not change in this stage.
  The SDK's runtime validation replaces the local zod schemas (`client.ts:132-503`) — the
  practice the SDK automated (target §13.6); the local schemas and `parseBody` die.
- Error taxonomy: `HubError` reasons map from `KernelApiError` categories
  (auth/validation/conflict/rate-limit/server — stage-20 §2); the send engine's
  indeterminate-outcome discipline (`engine.ts:9` — never auto-retry) is preserved by mapping
  timeouts/5xx to the same indeterminate class as today. **The outbox/verifier discipline is
  a keep, byte-for-byte in behavior** (`outbox.ts:321-350` claim-before-IO;
  `clientCommandId = localId` dedup, `engine.ts:342,355`; verifier `engine.ts:533-597`).
- The wildcard read path keeps its shape: the OFAPI-shaped read client
  (`ofapi/client.ts`) now *always* constructs against the hub gateway base
  (`buildHubOfApiReadBaseUrl`) using the SDK's passthrough helper for `ofapi/read/*`
  (stage-20 escape hatch) or, at minimum, the SDK-managed auth/fetch layer — read-gateway
  path-shape invariant (target §14) untouched.
- `getServerTimeOffsetMs` (`client.ts:589-598`) re-lands on the SDK's response hook (or a
  one-liner over any SDK response's `Date` header) — the clamp logic in the usage lane
  depends on it.

**desktop — stream v2** (`apps/desktop/src/main/sync/hub-sync.ts` + `hub-provider.ts`):
- `hub-sync.ts` swaps endpoint (`HUB_SSE_PATH` → `/api/v1/events/v2/stream`), resume
  (`?lastEventId=` numeric → opaque v2 cursor, persisted under a NEW settings key
  `hubSync.v2Cursor` — the v1 `hubSync.lastEventId` key is retained untouched for the
  fallback window), and 409 handling (v1 snapshot flow → v2 per-account snapshot at
  `/api/v1/events/v2/snapshot?accounts=…`, same page-and-apply structure as
  `recoverSnapshots`, `hub-sync.ts:255-339`). **Kept verbatim:** the WHATWG frame parser
  (`:49-127`), handle-then-checkpoint ordering (`:249-252`), 45 s byte-silence watchdog
  (`:28,346-351`), 30 s backoff cap + server `retry:` floor (`:24-26,464-466`),
  auth-failed permanent stop (`:362-364,435-439`).
- Frame mapping: v2 frames are `{accountId, accountSeq, type, occurredAt, data}` with the
  canonical vocabulary (stage-21 §2). A new `mapDomainFrame` in the shared protocol layer
  translates canonical types onto the existing local ingest calls in `handleHubEvent`
  (`hub-provider.ts:532-645`): `message.received/sent` → `polling.ingestHubMessage`,
  `message.deleted` → `data.messages.markDeleted`, `presence.*`/`typing`/read-state → their
  current handlers. Unknown `type`s are ignored by contract (v2's forward-compat rule) — the
  v1 union's 10 members (`protocol/index.ts:308-320`) must all have a v2 mapping before
  cutover; the conformance test enumerates them.
- **Rollout-window-only v1 fallback:** a settings-store field `hubSyncProtocol:
  z.enum(['v2','v1'])`, default `'v2'`, NOT surfaced in UI — flippable via the existing
  settings-file mechanism per the ops runbook if v2 misbehaves on a machine. The field and
  the v1 code path are deleted in the release after fleet confirmation (declared here;
  kernel-side v1 retirement is Stage 25's).

**desktop — device-token login (Stage 22 adoption):**
- First-run/one-time UI: chatter enters username + password → SDK session login →
  `POST /api/v1/auth/device-tokens` (label = machine name) → raw token stored as a new
  keychain secret `hubDeviceToken` (`secrets/keychain.ts:10-17` SECRET_NAMES extends);
  the SDK client authenticates with it thereafter. The legacy `hubApiKey` secret remains
  accepted (kernel dual-acceptance, Stage 22) and is used as fallback if no device token is
  present — removal of chatter-key support is a later, kernel-declared retirement, not this
  release.
- SSE v2 re-auth rides the same token (Stage 22 wired the device-token branch server-side).

**desktop — direct-read removal (DP 8, the point):**
- `OFAPI_READ_TRANSPORTS`/branching die: `ofapiReadTransport: z.literal('hub')`
  (`store.ts:176` — the write path's `:178` precedent, applied); stored settings migrate by
  parse-coercion (any persisted `'direct'` value becomes `'hub'` on load — settings-store
  version bump per its existing mechanism).
- `index.ts:400-408` (direct client with local `ofapiKey`) deleted; `index.ts:411` branch
  collapses to unconditional hub construction. The `ofapiKey` keychain secret is
  decommissioned: the app deletes it on first run of this version (it has no remaining
  reader), and the owner rotates the team OFAPI key kernel-side afterwards (ops step — the
  key may have been present on N machines).
- `HubSettings.tsx:127-135` transport toggle removed; `SpendersSettings.tsx:28` hub-check
  simplified to true; `polling-sync.ts` `transport:` telemetry fields become the constant
  `'hub'` (kept one release for dashboard/log continuity, then dropped).
- Break-glass during a kernel outage is an **ops runbook** (owner issues a temporary key;
  documented kernel-side), not a client feature — reads during an outage come from the local
  SQLite cache as today (DP 8's accepted trade).

**desktop — release:** staged fleet rollout on the existing feed, one machine first
(auto-update Windows-only, `updater.ts:19-21`; macOS manual step in the rollout note).

## 3. Schema & data migration

**No local schema migration** (`SCHEMA_VERSION` stays 16): the v2 cursor and protocol flag
ride the settings stores; the keychain gains `hubDeviceToken` and drops `ofapiKey` (file-per-
secret store, no migration). **No kernel schema change.** "No data migration" is explicit —
local caches carry over; the v2 cursor starts at "now" with a one-time v2 snapshot recovery
to re-baseline (the 409/snapshot flow doubles as the initialization path, exactly as v1's
did).

## 4. Client compatibility

- **Desktop (chatters):** one visible change — the one-time device-token login; everything
  else (chat UX, sends, local cache, AI dock) identical. During rollout, machines on the old
  version keep working: v1 SSE still served (retires in Stage 25), chatter keys still
  accepted (Stage 22 dual-acceptance), old hand-written client routes unchanged.
- **Extension / dashboard / workboard:** untouched.
- **Kernel:** sees SDK-shaped traffic (same wire contracts by construction), v2 SSE
  connections replacing v1 per machine, device-token principals replacing key principals
  machine-by-machine.

**Compatibility invariants (target §14), each named:** SSE v1 frame protocol — preserved
kernel-side until Stage 25; the desktop's v1 *consumption* ends here (that is the
retirement's precondition). Command-outbox intake semantics — untouched (same
`clientCommandId` dedup, same 200/202/409 handling through the SDK). Chatter bearer keys —
still accepted; desktop *adopts* device tokens, retirement is declared kernel-side after
24+32 confirm. Fan-profile PUT/GET — same routes via SDK. Read-gateway path shape —
unchanged (`/api/v1/ofapi/read/...`). Auto-update feed continuity — same URL/trust model.

## 5. Tests & verification

**New tests (desktop):** SDK-delegation contract tests per operation (the existing hub client
tests re-pointed — same fixtures, SDK transport mocked at fetch level); v2 frame-mapping
unit tests covering all 10 v1-era event kinds + unknown-type tolerance; v2 cursor
persistence/resume + handle-then-checkpoint ordering test (crash between handle and
checkpoint replays, never skips — the `hub-sync.ts:249-252` property, re-proven on v2);
409 → per-account snapshot recovery integration (against the v2 conformance fixtures from
stage-21); device-token login flow + keychain fallback test; settings coercion test
(`'direct'` → `'hub'`); compile-time proof: `ofapiReadTransport` literal type removes the
direct branch (grep gate: `'direct'` remaining only in the AI transport enum until
Stage 31).

**Existing suites:** full `pnpm check`; send-engine suites (`apps/desktop/tests/send/*`)
green UNCHANGED — the crown-jewel proof that the SDK swap didn't touch outbox semantics.

**Production verification (exit criteria):**
- Fleet on the new version (feed telemetry via `x-client-version`).
- Zero desktop v1 SSE connections (server metrics — Stage 25's entry criterion is fed from
  here); v2 smoke counters show no gaps/dupes with fleet load.
- Direct-mode code deleted: repo grep for `ofapiReadTransport` shows the literal only;
  `ofapiKey` absent from SECRET_NAMES.
- Read-gateway request volume unchanged before/after per machine (no silent fallback path
  ever existed — verify anyway, passport rule).
- **Chat freshness over a full week unchanged** (crown jewel 1): message-visible latency
  spot-checks + owner check-in with the team; any staleness report during rollout = flip
  that machine's `hubSyncProtocol='v1'` and diagnose before proceeding.

## 6. Rollback

- Per-machine: the `hubSyncProtocol` fallback flag (v2→v1) for stream issues; feed rollback
  to the previous version for anything worse (auto-update serves whatever `latest.yml`
  names). Device-token login rolls back to the still-present `hubApiKey`.
- The `ofapiKey` deletion is the one destructive local step: it happens on first run of the
  new version, so a version rollback cannot restore direct reads on that machine — accepted
  and intended (DP 8); the ops runbook covers outage access. The kernel-side team key
  rotation happens only after fleet confirmation.
- Kernel-side nothing changes in this stage, so there is no kernel rollback surface.

## 7. Assumptions

1. **SDK ≥2 weeks stable under the dashboard** and its contract hash matches core@main (the
   drift CI proves it continuously).
2. **v2 carries every event kind the desktop consumes** — the 10-member union maps
   completely; a gap found during mapping is a Stage 21 defect (escalate there, don't
   work around).
3. **Dual credential acceptance (22) holds** through the whole rollout window; the desktop
   never needs both-at-once semantics beyond fallback-if-absent.
4. **The settings-file flip mechanism** is operable per machine without a rebuild (existing
   settings store) — that is what makes the v1 fallback "rollout-window-only" credible.
5. **DP 8's availability trade is accepted and documented**: kernel down ⇒ reads from local
   cache only; the runbook exists before the release ships (task 6).
6. **`ofapi/read/*` passthrough remains contract-stable** (target §14) until a later stage
   gives reads first-class SDK operations; nothing here depends on that future shape.

## 8. Task breakdown

1. **SDK delegation layer behind `HubClient` + error-taxonomy mapping + re-pointed contract
   tests.** Files: `packages/shared/src/hub/client.ts` (shrinks to interface + delegation),
   `apps/desktop/src/main/hub/index.ts`. Done-check: send-engine suites green unchanged.
   *(1 session)*
2. **v2 stream client + frame mapping + fallback flag + conformance/resume tests.** Files:
   `sync/hub-sync.ts`, `sync/hub-provider.ts`, `packages/shared/src/protocol/`. Done-check:
   all-kinds mapping test; crash-replay test. *(1 session)*
3. **Device-token login UI + keychain + SDK auth wiring.** Files: renderer settings/login
   feature, `secrets/keychain.ts`, hub module. Done-check: login flow test; fallback test.
   *(0.5–1 session)*
4. **Direct-read removal** (literal type, branch deletion, UI removal, `ofapiKey`
   decommission, settings coercion). Files: `settings/store.ts`, `main/index.ts`,
   `ofapi/transport.ts`, `HubSettings.tsx`, `SpendersSettings.tsx`. Done-check: grep gate;
   coercion test. *(0.5 session)*
5. **Ops runbook (break-glass reads) + rollout plan note (macOS manual step).** Done-check:
   runbook committed kernel-side (`docs/`), referenced from desktop CLAUDE.md at Stage 35.
   *(≤0.25 session)*
6. **(Last) Staged release:** one machine → 48 h → fleet; run production verification (§5)
   incl. the one-week freshness watch; then kernel-side team-key rotation; record results
   here. *(ops)*

## Progress

**Session 1 (2026-07-06, desktop branch `kernel/stage-24-sdk-stream-v2` off the stage-12 harvest
tip @ 3a1087f; core enablers on the chain branch `kernel/stage-21-event-stream-v2`; ordering
deviation per the standing owner "continue": deps 20/21/22 are green-local, not exited):**

§8 checklist — **Tasks 1–5 BUILT** (decision #95). Suites after the last code commits:
**core 188/1530**, **desktop 772 shared + 1223 app**, full `pnpm check` green.

- [x] **Task 0 (substrate — Stage 20 Task 6 partial)** — compiled vendored SDK:
  core `scripts/vendor-sdk.mjs` stages the runtime subset (sdk + contracts
  routes/sdk-runtime/cursor/policy + 3 dependency-free shared modules), compiles with core's
  toolchain, ships js+d.ts into desktop `packages/kernel-sdk` (zod-only dependency;
  kernel-sdk.vendor.json pins contract hash 05f951e2… + source commit; vendor test proves
  runtime import + hash agreement). Consumers see declarations only — desktop's stricter flags
  never re-litigate core source. Git-tag installs (DP 10) replace the mechanism at release.
  Core enablers: sdk-runtime exactOptionalPropertyTypes-clean, network wrap keeps
  abort/timeout in error.code, generated index re-exports routeSchemas/stream helpers/cursor.
- [x] **Task 1** (0fbac28) — HubClient = thin delegation over @kernel/sdk behind the SAME
  interface/error taxonomy/timeout budgets/HubFetch seam; per-timeout memoized clients
  (no shared timeout slot to race). **Send-engine suites green UNCHANGED (done-check).**
  Leniency deaths pinned by re-pointed tests (absent page fields / missing invalidCount =
  invalid-response; command payload echo contract-stripped); parseable-completedAt gate
  re-added on top of the contract element.
- [x] **Task 2 core half** (5cf9ef5) — v2 frames desktop-consumable (the #92 payload tail),
  all serve-time + additive: refs + accountRef on every frame; normalized message `payload`
  on message.received/sent from the source observation (same normalizer as v1 fanout;
  batched replay, order-preserving live chain); `event: ephemeral` typing lane off the v1
  fanout hub (never ledgered, no id, live-only). OpenAPI doc unchanged; conformance 12/12.
- [x] **Task 2 desktop half** (4b99d21) — hub-sync keeps parser/watchdog/backoff/auth-stop/
  handle-then-checkpoint verbatim; v2 endpoint + opaque cursor (NEW key hubSync.v2Cursor;
  lastEventId untouched for fallback); mapDomainFrame → existing SyncEvent union
  (handleHubEvent untouched — enriched fast path preserved); unknown types checkpoint
  without emitting; ephemeral applies without checkpoint; v2 409 = fresh-cursor handshake +
  per-account head refresh via polling (#92 — spec's page-and-apply predates that deviation).
  hubSyncProtocol v2/v1 settings-file flag, no UI. MAPPING FACTS: readStateChanged is
  local-only (server never sent it); subscriptions.renewed nudge has no ledger source —
  accepted loss (polling covers). Tests: mapping table 8, v2 consumer 7 (crash-replay,
  ephemeral no-checkpoint, 409 recovery), v1 suites pinned to protocol 'v1'.
- [x] **Task 3** (053ae24) — device-token sign-in (Settings → Hub): main captures the login
  session cookie off the raw response (no main-process cookie jar), issues via the SDK's
  static-headers seam, stores keychain hubDeviceToken, logs out the one-time session.
  resolveHubCredential (device token ?? chatter key) feeds ALL hub consumers; config
  fingerprint includes the resolved credential → issuance reconnects live.
- [x] **Task 4** (4de27b3) — direct reads DEAD (DP 8): ofapiReadTransport = z.literal('hub')
  (stored 'direct' coerces on load — pinned); ofapiKey left SECRET_NAMES and the compiler
  drove the sweep (Keys UI row, key-test provider, patch route, keyMeta, dev seeding —
  deeper than the spec's file list, recorded); deleteDecommissionedSecrets removes the file
  on every boot (rollback-proof by design). Grep gate: 'direct' only in the AI enum +
  frozen outbox migration DDL.
- [x] **Task 5** (core 907315b) — docs/runbooks/desktop-hub-outage-break-glass.md:
  DP 8 trade, owner-run break-glass (temporary key never on chatter machines), team-key
  rotation after fleet confirm, rollout plan (one machine → 48 h → fleet; macOS manual),
  per-machine v1 flip.
- [ ] **Task 6 (ops)** — staged release one machine → 48 h → fleet; §5 verification:
  fleet x-client-version, ZERO desktop v1 SSE connections (feeds Stage 25 entry), v2 smoke
  no gaps/dups under fleet load, grep gates on the release build, read-gateway volume per
  machine unchanged, ONE WEEK chat freshness unchanged (staleness → flip that machine to
  v1 + diagnose); then kernel-side team OFAPI key rotation.

Gotchas for the next session: the vendored SDK is REGENERATED (never hand-edited) — rerun
`node scripts/vendor-sdk.mjs ../chatgoose_desktop_fable/packages/kernel-sdk` after any core
contracts change and commit the refresh desktop-side (dist/ needs the package-local
.gitignore un-ignore); desktop settings adds require touching contract.ts SettingsVM +
store schemas/keys/defaults/patch + mockBridge + tests/{ai,hub}/helpers fixtures; the
ephemeral test in core is order-dependent on other tests' typing rows — assert on YOUR
account's frame, not the first one.
