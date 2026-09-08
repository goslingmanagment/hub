# Review 2 — simplicity, executability, rollout realism, convention fit

Reviewer lens: **not a bug hunt.** Is this the simplest design that meets the goals, can it actually be
built and rolled out here, and does it fit the house rules? Read-only pass over
`ARCHITECTURE.md` + `evidence/{A,B,C,D}` against the repo at `582ef1cf`.
`investigations/fansly-events-architecture-2026-09-07/` was deliberately **not** read.

Verdict in one line: **the analysis is excellent and the target architecture is basically right, but the
document sells the wrong product, mis-classes its own kill switch, and has one silent
capture/erasure defect that would ship green.** The cheapest 80 % of the stated savings needs no
WebSocket at all, and the document already contains the mechanism.

Findings are ranked by impact. Each carries repo evidence and a concrete edit for the document.

---

## P1 — must change before this is executable

### P1-1. The headline sells request reduction; the socket actually buys freshness. The request reduction is available without it.

**Evidence.** The document's own §5.2 F designs a `bounded_catchup` walk: `GET /messaging/groups?sortOrder=1`
(newest first — `packages/fansly/src/adapter.ts:1157`, `sortOrder: params.sortOrder ?? 1`) page by page
until every `lastMessageId` on a page predates the window. That mechanism does not need a socket.
Applied to the ordinary 30-minute slot it replaces a 54.5-request full walk with 1–3 pages:

- C §3: `dm_conversations` = 47.9 dispatches/page/day × 54.5 requests = **15 680/day fleet (53.3 %)**.
- A bounded walk at the same 30-min cadence plus a certified full sweep every 6 h costs roughly
  `47.9 × 3 × 6 + 4 × 54.5 × 6 ≈ 2 170/day` — **−86 % on that lane, −46 % on the fleet**, i.e. essentially
  the whole "phase 1–3" saving (−49 %), with no socket, no new observation source, no new journal, no
  new custody surface, no new failure mode.
- The machinery is already 90 % wired. `unchangedPageStreak` is **computed and never read**
  (`apps/runtime/src/services/sync/executor-handlers.ts:3330`; the only other references are the
  cursor-state parse at `sync/cursor-state.ts:59,340,390`). And a partial walk is already **safe** against
  the destructive finalization: `markPageDmConversationsInvisibleByGeneration` runs only when
  `membershipCertified` (`generationSetCount === finalObservedCount`) **and**
  `providerTotalMode === "present"` (`executor-handlers.ts:3454-3465`), and
  `lastFullSweepCompletedAt` only advances on a certified sweep. A bounded pass simply does not certify,
  and nothing is hidden.

Meanwhile §4 row 5 scores this option at "−30…−50 % on `dm_conversations`, freshness unchanged" with
**no citation and no derivation** — sitting next to a measured 86.6 % byte-identity (C §7.2) it does not
reconcile with. And the header's "≈29 400 → ≈5 000–7 000 (−75…−80 %)" is the **phase-4** number; phases
1–3, which is what the 1 500–2 500-line estimate covers, deliver −49 % (§6).

**Why this matters for the decision.** The honest case for the socket is: *freshness — 30 minutes to
seconds, and it works with the browser off.* That is a real product argument (needs-reply latency,
chatter response time, the AI lane's transcript). It is not the argument the document leads with, and an
owner reading §0 will approve a −80 % request cut that the proposed work does not deliver.

**Edit.**
1. Rewrite the header and §0.2/§0.3 to lead with freshness; state −49 % for phases 1–3 and put the
   −78 % where it belongs (phase 4, `fan_earnings` + `followers_reconcile`, separate flags, separate work).
2. Add a **Phase 0.5 to §9: the bounded incremental walk alone** — 30-min bounded pass + 6-h certified
   full sweep, no socket, no new source, one live config key, roughly 300 lines. Measure the real saving.
   It de-risks phases 2–3 (the catch-up code is the hardest part of them and gets proven first) and it is
   the correct answer if the socket is later blocked by M3 or by Fansly's answer to open question §10(5).
3. Re-score §4 row 5 with the derivation above, or delete the number.

### P1-2. `fanslyWsSourceMode` cannot be a "staged" key. The one-flag rollback is not implementable as written.

**Evidence.** `packages/shared/src/config-settings.ts:225-237`:

```ts
if (descriptor.runtimeApply !== "boot") return { ok: false, error: `Config key is not staged (boot-applied): ${key}` };
if (typeof value !== "boolean")        return { ok: false, error: `${key} expects a boolean` };
```

All 23 `editability: STAGED` keys in `packages/shared/src/config-registry.ts` are booleans; 21 are
`runtimeApply: "boot"`, i.e. **applied once at process start** — a flip needs a worker restart. §0.6
("`off` closes the sockets", "rollback is one flag"), §5.2 A (supervisor reads the mode per page), §7.1
("sockets close within a heartbeat") and §9's phase-2/3 rollback column all require a **live** key.

The house pattern for exactly this shape exists and is not "staged":
`aiTranscriptFreshUnionMode` (`off/shadow/serve`), `fanslyReplayMode` (`off/shadow/on`),
`captureCasReadMode` (`inline/shadow/serve`), `agentHydrationAutoApproveMode` (`off/shadow/enforce`) —
all `editability: EDITABLE, runtimeApply: "live"` with `enumValues`, several with an explicit
"PATCH-only transitions: upward stepwise, any rollback allowed" note.

**Edit.** §5.3: `fanslyWsSourceMode` → `kind: "string", editability: EDITABLE, runtimeApply: "live",
enumValues: ["off","shadow","live"]`, with the stepwise-up/any-rollback note copied from
`captureCasReadMode`. Then say plainly that the #70 staged ritual (`stagedGroup`/`stagedOrder`/`requires`)
does **not** apply — this is the live-key ramp discipline instead (one lane, one value, owner-approved,
audited), which is what the Fansly lanes already use (`fanslyPostEngagementRefreshEnabled` is
`EDITABLE + live` for precisely this reason).

### P1-3. `representation='exact_bytes'` is not producible in this codebase — and it *disables the erasure*.

**Evidence.**
- No writer produces it: `capture-cas-dual-write.ts:328,342` hardcode `representation: "canonical_json"`,
  and `packages/db/src/repositories/capture-payloads.ts:727-730` pins
  `ENVELOPE_REPRESENTATION = { observation: "canonical_json", raw_payload: "canonical_json" }`; an
  observation reference to an `exact_bytes` object is rejected as `representation_mismatch` at `:789`.
  `capture-payload-parity.ts:263` says it outright: *"No pull-capture writer produces exact_bytes in this slice."*
- Worse: `capture-payload-erasure.ts:248-267` + `erasure/capture-catalog.ts:143-150` make the erasure
  planner **refuse to plan a run** when an `exact_bytes` body is in scope, pinned by
  `tests/erasure-capture-catalog.integration.test.ts:405`. A journal written this way would silently
  block subject erasure for that page.
- And "CAS pointer-only works as it does for pull" is false for a direct journaller: CAS runs **inside
  `persistRawPayload` only**, behind two fail-closed page allowlists (`captureCasDualWritePages`,
  `captureCasPointerOnlyPages`, `config-registry.ts:331,333`). A path calling `insertObservation`
  directly gets no CAS at all.

**Edit.** §5.2 B: drop `exact_bytes`; write the frame as `canonical_json` (the frame *is* JSON — nothing is
lost), and state that WS journal rows carry no CAS reference in v1. If exact wire bytes are wanted later,
that is its own slice with its own erasure work, and it must say so.

### P1-4. The new observation source has no stated erasure reachability — and the default would make it unreachable.

**Evidence.** `apps/runtime/src/services/erasure/index.ts:522-533` finds fan-material observations with

```sql
select id from observations
where account_id in <pageIds> and <payloadMatchPredSql(fanRef)>
```

§5.2 B specifies `native_account_ref`, `producer`, `kind`, `platform` — and **never says what `account_id`
is**. If a WS row's `account_id` is not the page id, an entire plane of fan message content becomes
invisible to the Stage 28.4 erasure while remaining fully readable. Nothing fails at build time; the
defect only shows up in a subject-erasure run.

**Edit.** §5.2 B: state `account_id = page.id` explicitly, alongside `native_account_ref`. §5.3: add an
erasure-reachability integration test to the phase-1 deliverables — the pattern already exists
(`tests/erasure-endpoint-scour-convergence.integration.test.ts` covers observations, events, projections
and the raw journal for the endpoint-scour plane). Also note the known hole: `ws_message_deleted` /
receipt frames carry ids only, so the payload text match will not reach them — say whether that is
accepted.

### P1-5. Phase 0(b) runs evidence A's *hostile* probes on a model's account, and drops A's own precaution.

**Evidence.** A §11 S1 says, verbatim: *"Run first on a **low-value test account**, through that page's own
proxy."* A §11 M1 is "open 2, then 5, then 10 sockets with the same token"; S2 is "deliberately reconnect
20 times in 60 s". §9 phase 0(b) folds T1/T2/T5, A1/A2, G1, **M1/M3**, P1, C1–C6 into one probe run "with
the canary page's token", i.e. a model's live session.

There is a materially cheaper and safer sequence, and evidence A supports it:

- **0(a) — two-tab tap, zero new connections.** A §10: *"every browser tab runs its own Angular app and
  its own `wsv3`"*. Running `evidence/ws-tap-snippet.js` in **two tabs of the model's own browser** and
  sending one test DM answers **M3 (fan-out vs load-balanced) and M4** — the single highest-risk unknown —
  with zero new sessions, zero new IPs, and zero owner-gated egress. It also yields C1–C6, G2/G3/G4, P3
  and the real per-day frame volume. This is most of the design-critical list, free.
- **0(b) — throwaway Fansly account, from the VPS.** T1, T2, T3, T4, T5, S1, S2, M1, A1, A4, A8, and P1
  (watch its own badge from a second account) all belong here. This is exactly A §11 S1's instruction and
  it costs nothing but an account.
- **0(c) — one benign long-hold on the canary page**, through its proxy, no reconnect storms, no
  concurrent sockets, off-peak, with the chatter told — only after 0(a) and 0(b) are clean.

Precautions the document **does** list: page proxy never direct-IP (correct, and A §11 T5/S1 agree),
owner gate on the probe, token masked in the tap, one canary page. Precautions it is **missing**: the
low-value-account-first rule; separation of benign from hostile probes; an **abort rule** (which close
code or `t=0` code stops the probe immediately); a time-box; off-peak scheduling; and a plan for the
chatter if M4 shows the model's browser losing messages mid-probe.

**Edit.** Split §9 phase 0 into 0(a)/0(b)/0(c) as above, move M1 and S2 out of any model account, and add
the abort rule and time-box to the checklist.

### P1-6. Phase 3's first flip bundles three behaviours behind one value. That is not the #70 ritual.

`shadow → live` simultaneously turns on (i) the inline hot projection, (ii) the dirty-set REST
follow-ups, and (iii) the `/health/sync` freshness override. Each has a different blast radius: (i) writes
chatter-visible rows, (ii) changes egress against Fansly, (iii) changes what "green" means. The document's
own hard rule is one flag, one verification window, never bundled.

**Edit.** §9 phase 3 → three steps: `live` = inline projection only (health override active, reconcile
untouched at 30 min, follow-ups off); then a separate live boolean for the dirty-set follow-ups; then the
`fanslyDmReconcileIntervalMinutes` ladder 30 → 60 → 180 → 360 (which the document already stages
correctly). Also state the projection rollback explicitly — see P2 below.

### P1-7. Cut the `fansly-ws` canonicalizer family from v1. It is redundant by the document's own design, and it is the riskiest item in the plan.

**The argument is internal to the document.** §5.2 D item 3 deliberately does *not* advance
`newest_stored_message_id` so that the existing candidate selector re-reads the thread over REST with full
`aggregationData`. So **every** WS message already produces a REST `dm_messages` read, which the existing
`sync-pull` family canonicalizes into the same `message.*` events. The `fansly-ws` family therefore emits a
second event for every message and relies on producing a **byte-identical canonical subset** for
content-hash dedup — from a payload that structurally lacks the media/account aggregation the REST body
carries. That byte-identity requirement is stated as a test to be written against phase-0 fixtures (§5.2 C,
C1); it is the one thing in the plan that can be wrong in a way projections cannot repair.

Cutting it also removes real weight: the closed union `CanonicalizerFamily.source`
(`canonicalize/index.ts:69`) would need a new member; every family joins the **minutely sweep's family
rotation**, which already blew pg-boss's 900 s handler expiration once and now runs under a wall-clock
budget (`tests/canonicalize-budget.test.ts` header: *"the families at the END of the registry sat at
parse_version 0 for a quarter of an hour, and the reconciles after the sweep never ran at all"*); and the
HealthFloor comes free with the family (`health-floors.ts:75` is built from `CANONICALIZER_FAMILIES`), so
it goes too.

**Edit.** §5.2 C: **all** `ws_*` kinds are `RAW_ONLY_OBSERVATION_KINDS` in v1 with a one-line reason
(`observation-kinds.ts` supports exactly this and its header spells out the protocol). State that
`message_archive` / the AI transcript / Agent Read Plane are fed by the REST follow-up, as today, only
faster; and that DP 7 is satisfied by the journal regardless. Add the family in phase 4, when there is a
live corpus and a reason (e.g. follow-ups being budget-starved).

---

## P2 — should change; each is a real cost or a wrong number

**P2-1. §2.1's `notifications` row is contradicted by the evidence.** C §3 measures 16.1 dispatches/page/day
(~1.5 h) at **5.0 requests per dispatch**; the document says "head-poll every 30 min, ~1 call". The 480/day
total is right, the shape is not. *Edit: correct the row; it changes nothing downstream but it is the kind of
number a later reader will build on.*

**P2-2. "289 отказов (0,055 %)" is wrong by 1.4×.** 289 / 379 237 (C §2.2) = **0.076 %**. No denominator in
C yields 0.055 %; 289/0.00055 implies 37 532 requests/day, +27 % over the measured steady state. (The error
originates in C §5; C §5's own taxonomy rows also sum to 259, not 289.) *Edit: 0.076 %, and fix C.*

**P2-3. §6's target-state line is attributed to a source that does not contain it, and does not add up.**
Its components sum to **15 250–16 000**, not "≈15 000"; −49 % holds only for the rounded figure
(components give −45.6…−48.1 %). "из C §8" is false — C §8's own breakdown is different and its 1-hour
extrapolation ("15 680 → ~650/day at 1 h") is ~12× low. `/group ≈50–200` has **no measurement anywhere** in
A/B/C/D. And the header's "−75…−80 %" does not cover its own 5 000–7 000 band (that band is −76…−83 %),
while C §8 concludes 4 500–6 000 / 80–85 %. *Edit: publish one band, derive it in the document, and stop
citing C §8 for it.*

**P2-4. `followers_reconcile` is a 48-hour stream, and its 3 469/day looks like a stuck recovery loop, not a
cadence.** `packages/db/src/repositories/page-sync.ts:245`: `cadenceSeconds: 172800`. The observed ~4.2 h
(C §3) comes from `page-sync.ts:1061-1066`:

```ts
const followersReconcileNeedsRecovery = page.platform === "fansly" && (
  page.lastFollowerSyncAt === null ||
  (now - page.lastFollowerSyncAt) > SYNC_STREAM_POLICY.followers_reconcile.cadenceSeconds * 1000 ||
  page.followerCount !== page.activeFollowerCount);
```

`followerCount !== activeFollowerCount` is plausibly **permanently true** on a growing page, re-requesting
the stream forever. If so, phase 4's "−3 000/day" is a **predicate fix, not an events project**. *Edit: §2.1
row and §9 phase 4 — flag this for investigation before designing follow/unfollow ingestion; it may be the
cheapest 12 % in the whole document.*

**P2-5. The OnlyFans precedent is journal-then-project-with-a-status-column, not one transaction.**
`ofapi-webhook-capture.ts:149-170` journals in its own transaction and stamps
`projectionStatus: 'pending'`; `projectDmMessageEvent` opens a **separate** transaction
(`ofapi-dm-projection.ts:209`), driven later by the event worker (`ofapi-events.ts:109`) or the sweep
(`:558`). §5.2 D's "in one transaction with the journalling" mis-describes it — and the real shape is
*better* for the argument §5.2 D makes about `projection_debt` (#137). *Edit: adopt the actual shape and cite
it; the phrase "в одной транзакции" should go.*

**P2-6. §5.2 D item 3 contradicts the code it depends on.** `refreshPageDmConversationWindow`
(`packages/db/src/repositories/page-dm.ts:779`, writes at `:906`) recomputes `newestStoredMessageId`
along with `storedMessageCount`, `oldestStoredMessageId`, `lastFanMessageAt`, `lastModelMessageAt` — and the
OF projection calls it. Keeping `newest_stored_message_id` still means **skipping** that call, which also
freezes `storedMessageCount` and takes the thread out of the retention prune's accounting — and makes §7.3
item 10 (hydration fingerprint vs `storedMessageCount`) moot. *Edit: say which call is skipped and what
that costs; delete or rewrite §7.3 item 10.*

**P2-7. The stub thread is invisible to the very selector that is supposed to enrich it.** The dm_messages
candidate WHERE (`page-dm.ts:1096-1113`) requires `c.is_visible = true`, **`c.fan_id is not null`**,
`dmMessageSyncEligibleSql`, no circuit-breaker window — and the selector is `limit 1`. §5.2 D item 4's
"partner unknown" stub has `fan_id = null`, so a brand-new conversation gets no message read until
`GET /group/{id}` + a fan upsert lands; and one drain re-reads **one** thread. *Edit: state the enrichment
rate honestly in §5.2 E (it is bounded by 1 thread per `dm_messages` dispatch, not by the follow-up budget),
and either keep the `/group` arm for exactly this reason or accept that new conversations wait for the
reconcile.*

**P2-8. §7.3 item 5 needs three call sites, and its anchor points at the wrong function.** The overlap proof
is `fansly-dm-messages.ts:253-257` (`getExistingPageDmMessageIds` → `overlapFound = page.items.some(...)`);
`:39-63` is `resolveDmConversationCoverageStatus`, the consumer. `overlapFound` is also read at
`executor-handlers.ts:4077-4081` and `targeted-thread-backfill.ts:599-602`. *Edit: fix the anchor and say
"three call sites".*

**P2-9. Adding a `source` value is six places and one contract regeneration, not one migration.** Tracing
`ofapi_capture` (migration 0098:470-476): (1) migration `drop constraint` + `add constraint … not valid`
(shape pinned by `tests/migration-invariants.test.ts:158`); (2) `packages/db/src/schema.ts:3333`
`OBSERVATION_SOURCES` **and** `:3392` the drizzle CHECK; (3) `packages/contracts/src/routes-agent.ts:709`
`agentObservationSourceEnum` — comment reads "= CHECK `observations_source_check`, **exactly seven**" — a
client-visible zod enum, so `pnpm contracts:generate` (contract hash, SDK surface,
`reference/agency-hub.openapi.json`); (4) `canonicalize/index.ts:69`'s closed
`CanonicalizerFamily.source` union — only needed if P1-7 is rejected; (5)
`packages/hub-agent-cli/src/commands.ts:603`; (6) `services/observation-kinds.ts` (the document has this
one). `observation_keys` needs nothing — `insertObservation` writes it (`repositories/observations.ts:151`).
*Edit: §5.3's "Контракты/SDK: только чтение … auth-декларации не затрагиваются" is true about auth and
misleading about contracts. Say `pnpm contracts:generate` runs, and that clients need no re-vendor because
they consume no new operation.*

**P2-10. Incident kind: six code sites + three generated artifacts, and migration 0124 is the wrong model.**
0124 is the G5 capture-payload-refs migration. The incident-kind models are `0078_proxy_missing_incident_kind.sql`,
`0107_…`, `0112_…`. The mirrors (from the commit that shipped 0124's own `capture_payload_parity` value):
`packages/db/src/schema.ts:256`, `packages/db/src/repositories/notifications.ts:37`,
`packages/contracts/src/routes.ts:3031`, `notification-incidents.ts` (union `:748`, two exhaustive switches
`:118`/`:198`, subKey branches `:69`/`:76`, `GlobalIncidentKind` `:735-747`),
`apps/dashboard/src/pages/notifications/NotificationsIncidentsTab.tsx:32` — plus regenerated
`contract-hash.ts`, `sdk/meta.ts`, `agency-hub.openapi.json`, a line in `docs/error-handling.md`, and
`tests/notification-incident-messages.test.ts`. *Edit: fix the citation and the count.*

**P2-11. Don't add a `messagesLive.source` field, and 12 h is the wrong deadman.**
`syncStatusReasonSchema.code` is `z.string().nullable()` and the block's `metrics` is
`z.record(z.string(), z.unknown())` (`routes.ts:2678,2719`) — new reason codes and new metric keys cost
**zero** contract churn; a new top-level `source` field costs a regeneration. Separately, a 12-hour deadman
sits above the worst-case reconcile (6 h) and 12× the stream's own `freshnessSlaSeconds: 3600`
(`page-sync.ts:262`), so a silently-dead socket can hold `/health/sync` green through two whole reconcile
windows. *Edit: reuse `statusReason.code`; set the deadman to `2 × fanslyDmReconcileIntervalMinutes`.*

**P2-12. The shadow-coverage metric is computable, but state its denominator and its reader.** Two things
the document omits: (a) the "REST-found" set is only the messages the walk happened to fetch — threads never
re-read never enter the denominator, which biases coverage **up**; (b) the CLI cannot read bodies with
`payload->>` — since migration 0128 a row's inline body may be NULL and live only in the catalog, so it must
go through the capture-payload read seam. Sample size: on the proposed canary (lora-2, **143 dm_messages/day**,
C §2.5) seven days is a few thousand messages at best, so "≥99.5 %" tolerates a handful of misses and is not a
tight gate. *Edit: say the gate measures **freshness** coverage — completeness is guaranteed by the reconcile
in every mode — name the read seam, and state the minimum message count below which the gate does not bind.*

**P2-13. The egress premise is wrong; the conclusion is right.** `createProxyRequestDispatcher` is **not**
cached — `egress/resolver.ts:107-119` builds a fresh `Agent` per resolution and `close()`s it — and the
resolver already raises `ProxyMissingError` (`resolver.ts:100-106`), so a WS transport going through
`resolveEgress` gets #124 for free. The real hazard is different: `buildDispatcherOptions()`
(`packages/shared/src/http-client.ts:33-43`) is tuned for 5-second-apart REST calls
(`connections: 1`, `keepAliveTimeout`, `keepAliveMaxTimeout`); a 24/7 upgraded socket needs its own option
set, and this repo has **zero** existing `WebSocket` usage in `apps/` or `packages/` (undici 7.27.2 is
present; `apps/runtime` imports only `type Dispatcher`). *Edit: replace the "cached agent would be eaten"
sentence with "a dedicated dispatcher with WS-appropriate timeouts", and note this is the first long-lived
socket in the codebase.*

**P2-14. Phase 2 flips two keys; say which first, and say what the allowlist contains.** Order matters:
`fanslyWsSourceMode=shadow` first (inert while the fail-closed allowlist is empty), then the allowlist —
that is the real flip. And say it is a **CSV of page labels**: every Fansly lane allowlist uses
`isPageAllowlisted(effective.<key>, page.label)`
(`apps/runtime/src/services/sync/fansly-stream-scheduling.ts:72-129`), while the neighbouring
`captureCas*Pages` keys use **numeric page IDs** — precisely the mix-up the registry comments at
`config-registry.ts:177-184` already exist to prevent. Copy that "FAILS CLOSED: empty = NO pages (the
OPPOSITE of the Fansly new-stream allowlist)" note verbatim.

**P2-15. §0 overstates against the body in three places.** (a) §0.3 states the 6-hour reconcile as the
change; §5.2 F ships `fanslyDmReconcileIntervalMinutes` default **30** (today's behaviour) and reaches 360
only at the end of a multi-week ladder (§9 phase 3). (b) §0.4 states the presence conclusion as near-fact
("сокет его не трогает"), while §7.1 treats `P1 = yes` as a **stop-the-project** condition and §0.5 does not
list presence among the main risks. (c) §0.6's "one flag" is not implementable as specified (P1-2).
*Edit: align the three.*

**P2-16. Two smaller mechanical omissions.** `packages/platform-core/src/index.ts:44-50` has
`webhooks: boolean` and `presenceSource` but **no `events` field** — §5.3's
`capabilities.events = "fansly_ws"` needs the interface extended first. And
`scripts/check-raw-fetch.mjs` is a single-pattern script against a **scalar** `budget` in
`scripts/raw-fetch-budget.json`; adding `new WebSocket(` at budget 0 changes both the script and the budget
file's shape — not the drop-in §5.2 H implies. (The ESLint side is fine as written: `eslint.config.mjs:90-97`
bans value imports of `undici`, `:157-161` exempts `apps/runtime/src/services/egress/**`, and the proposed
transport lives there.)

**P2-17. No `docs/decisions.md` entry and no runbook are planned.** Family law: a numbered decision appends
its Quick Reference row in the same change. Last number is **249** (`docs/decisions.md:252`), so this takes
**250**. `docs/runbooks/` is where "is the socket alive / how do I turn it off" belongs — an owner who has to
read a 375-line architecture document at 3 a.m. does not have a rollback procedure.

**P2-18. Filtering typing and pong at the capture edge deserves a named decision.** §5.2 B opens with "every
frame is journalled" and then exempts `t=2` and 5/22. Typing is defensibly not a business fact, and the
reason (volume) is honest — but a filter *at the capture edge* is exactly the shape DP 7 exists to forbid,
so it should be a written decision with the volume number behind it (C6, currently unmeasured), not a bullet.

**P2-19. Missing entirely: back-pressure on `observations`.** The only stated back-pressure is "close the
socket if Postgres is unavailable". The frame rate is unknown (C6), evidence A flags
`wallets.updated`, `chats.visibility_updated`, `media.liked`, `users.typing` as high-volume, and C5
(broadcast to 50k fans) is an open question the document itself raises in §7.1 — while migration 0124 records
that `observations` + `sync_raw_payloads` are already ~34k rows/day and ~19 GB of TOAST *on a box whose free
space is why the G5 project exists*. **Add:** a per-page frames/hour cap that degrades to counters (and, past
a second threshold, closes the socket with an incident), and a hard requirement that phase 0(a)'s tap
produces a measured frames/day figure **before** shadow is enabled on any page.

---

## P3 — accuracy and polish

- **Anchor drift** (all real, all off by a little): `executor-handlers.ts:3460` → the call is **3461**;
  `page-sync.ts:176-446` → `SYNC_STREAM_POLICY` is **175-447**; `canonicalize/index.ts:120-247` →
  **120-245**; `http-client.ts:62-97` → `createSocksProxyDispatcher` is **60-101** (and `connections: 1`
  lives at `:35`/`DISPATCHER_CONNECTIONS`, `:14`); `fansly-dm-messages.ts:39-63` → the overlap proof is
  **253-257** (P2-8). Accurate as cited: `shared.ts:83-228`, `schema.ts:3391-3393`,
  `ofapi-dm-sync.ts:552-573`, `sync-status.ts:1394`, `page-dm.ts:247-264`, `page-dm.ts:1054-1060`,
  `page-sync.ts:1012-1019 / 1590-1611 / 1930-1933`, `executor.ts:805` (and the "17 streams" count is right —
  18 minus `fan_identities`), `ofapi-events.ts:407-446`, `eslint.config.mjs:90-97,157-161`,
  and **migration 0150 is the correct next number** (`packages/db/migrations` ends at 0149).
- **§5.2 G mis-states the OF gate.** `overrideMessagesLiveBlockWithOfapiIngest` has no platform check at
  all; the gate is a page-ID **set** built at `sync-status.ts:1579-1585` and consumed at `:1709`.
  Generalizing it is four edit sites in one file and adds **no** `platform ===` branch — easier than the
  document claims, which is worth saying since the platform-branch budget is a hard rule.
- **`snowflake.ts` exports only `fanslyFollowIdToDate`** with `FOLLOW_RELATION_EPOCH_MS`. The document's two
  decodings check out numerically, but the only export is named and typed for follow relations — §5.2 F's
  `lastMessageId` decoding needs a generalized export (or a note that the epoch is shared).
- **There is no lock-namespace registry.** 58211 (OFAPI event worker), 58212 (scheduler leader), 43101
  (`sync/locking.ts`), 9_003_001, 9_002_001 are bare per-module constants whose only collision guard is a
  prose comment (`scheduler-leader.ts:6`). "A new ns" has nothing to register with and nothing to catch a
  clash — pick a number and put it beside the others with a comment.
- **The lease is probably redundant.** Workers are not leader-elected (only the scheduler role is), a
  **session** advisory lock already gives exactly-one and releases automatically on disconnect, and
  `startOfapiEventWorker` additionally hard-asserts `ofapiEventWorkerReplicas === 1`
  (`ofapi-events.ts:391-398`). Keep `fansly_ws_sessions` as a status/health row; drop the
  `lease_owner/lease_token/lease_expires_at` + 30 s heartbeat machinery unless a second worker replica is
  actually planned.
- **`startWorkerServices` is `worker-services.ts:179`** — a new long-lived service starts after the
  `ensure*Queue` block, takes `abortController.signal` or returns a `.stop()` handle, and must be torn down
  in the returned `shutdown()` (`:607-635`). Worth one line in §5.2 A.
- **Window labelling.** C declares 14 days (Aug 24 – Sep 6) and a 6-day steady-state sub-window (Sep 1–6),
  and uses an **undeclared 2-day window (Sep 5–6)** for the sweep geometry and byte-identity. So §2.1's
  "12,5 из каждых 30 минут" and §0.2's "87 %" rest on **two days**, not six. Say so.
- **§2.1 arithmetic.** Rows sum to **29 422** (C §3's own footer); the header rounds to 29 400; C §2.2's
  all-rows figure is 29 431. Percentages sum to **99.4 %**. Harmless, but state which total is which.
- **Canary rationale is half-evidenced.** "средний инбокс" is supported (lora-2 4 637/day, lora-3
  3 741/day, ranks 3–4 of 6). "**есть ночная активность**" is **unsupported** — C has no per-page intra-day
  data at all; its hourly table is fleet-wide. And **lilly-1** (2 438/day but **228 dm_messages/day**, more
  DM traffic than either lora page) fits the criteria at least as well and is not discussed.
- **Unsourced numbers** worth either sourcing or marking as estimates: §4 var.3 "300–500 МБ на страницу";
  §7.1 "сокет живёт ~3 минуты" (the only measured datum is 17 handshakes / 84 min ≈ one per 4.9 min);
  §6 "workboard пересчёт через 5 с"; §7.3 п.8 "gate мемоизирован 15 мин"; §5.2 E "десятки /group" vs §6
  "≈50–200"; §9 "−5 700/сутки" for `fan_earnings` (implies a residual of 24/day against C §8's "a few
  hundred a day" floor — should be ≈−5 400).

---

## Answers

### 1. Is this the simplest design that meets the goals?

**The target shape is right; the v1 scope is not the smallest one that meets the goals.** Hub-side socket,
frames journalled before parsing, inline hot projection, coalesced follow-ups through the existing executor,
reconcile gated inside the handler (never by cadence — the L1 slot trap at `page-sync.ts:1590-1611`/`:1930-1933`
is real and correctly avoided), bounded catch-up after gaps: every one of those is the right call, and each
reuses an existing seam rather than inventing one. That is good engineering and it fits this codebase.

**Cut or defer for v1** (each with its reason):

| Cut | Why |
|---|---|
| The `fansly-ws` **canonicalizer family** + its HealthFloor → all kinds `RAW_ONLY` | Redundant by §5.2 D item 3's own design (every WS message triggers a REST re-read that canonicalizes anyway), and it carries the plan's only unrepairable risk: byte-identical canonical subsets for hash dedup from a payload that lacks aggregation data. Also removes the closed-union edit and the minutely-sweep budget pressure. (P1-7) |
| The **`/group/{id}` follow-up arm** + `fanslyWsFollowupCallsPerHour` | The stub thread is invisible to the dm_messages selector anyway (`fan_id is null`, P2-7); the 30-minute reconcile fills new conversations in. Keep only the coalesced `dm_messages` request. Removes a budget key, a producer, and a pacing question. |
| **`fanslyWsJournalPresence`** and the presence branch | Nothing consumes it in v1; C6/P4 are unmeasured. Pure option value. |
| The **lease** (owner/token/TTL/heartbeat) on `fansly_ws_sessions` | A session advisory lock already gives exactly-one and auto-releases; workers are not leader-elected and the OFAPI precedent asserts replicas === 1. Keep the row for status/health. |
| **`messagesLive.source`** as a new field | `statusReason.code` is an open string and `metrics` an open record — same information, zero contract regeneration. (P2-11) |
| The **`grace` window** arithmetic | Until G1 is measured, set `grace = 0` and catch up on every reconnect — the document itself says that costs 1–3 pages. One constant instead of a policy. |
| `exact_bytes` / CAS on the WS journal | Not producible and it blocks erasure planning. (P1-3) |

**Missing but necessary:**

1. `account_id = page.id` on WS observations + an erasure-reachability test (P1-4) — the only silent
   correctness defect in the document.
2. Back-pressure / a frame-rate cap on `observations`, with a measured frames-per-day figure required
   before shadow (P2-19).
3. A **live** kill switch (P1-2) — without it, §0.6, §7.1 and §9's rollback columns are all fiction.
4. A phase-0 safety split that honours evidence A's own "low-value test account first" (P1-5), plus an
   abort rule and a time-box.
5. An explicit **projection rollback**: `mode → off` stops new writes but does not repair rows already
   written; the repair is one forced full reconcile per page. Name the command.
6. An explicit statement of the chatter-visible drift window: `unread_count` and workboard needs-reply are
   event-derived between reconciles, so at 360 minutes a missed frame means a wrong badge for up to six
   hours. That is a product decision, not a technical footnote.
7. A decisions.md entry (#250) and a runbook (P2-17).
8. A concrete stop rule for M3 — what is measured on the model's browser, by whom, and what result kills
   variant 1.

**Comparison with §4.** Mostly fair, with two problems. **Row 5 is mis-scored** (P1-1): the "cheap partial
step" is the same bounded walk the document designs in §5.2 F, and it plausibly delivers ~−86 % on the
53 % lane rather than −30…−50 %. That changes the shape of the whole proposal — it does not defeat it (row 5
genuinely does not fix freshness, which is the real goal), but it should be the first phase. **Row 1's
"Кастодия сессии: без изменений" understates A6**: evidence A calls the management-session probe *"the single
biggest security win available and it is cheap to test"*, and §9 lists it as "опционально". A 24/7 socket
holding a model's full session token from a VPS is a different custody posture from a REST call that holds it
for 200 ms, even if the secret is the same secret. Row 2 (extension) is fairly rejected as a **primary**
source but under-used: it is the free answer to M3/M4 (P1-5) and the only way to implement the fallback §7.1
itself proposes ("Hub socket only when the model's browser is closed"). Rows 3 and 4 are fairly scored;
row 3's "300–500 MB per page" has no source.

### 2. Are the phases really staged one flag at a time, with measurable gates and real rollbacks?

**Partly.** Phase 1 is genuinely inert and its rollback ("additive migration, code asleep") is honest — one
caveat worth a line: the `observations_source_check` change is a `drop constraint` + `add constraint … not
valid` (`tests/migration-invariants.test.ts:158` pins that shape), so it takes a brief ACCESS EXCLUSIVE lock
on the largest table but no scan. Phase 4's "each package its own flag" is right. **Phase 2 flips two keys
without stating the order** (P2-14). **Phase 3's first step bundles three behaviours** (P1-6). And **no phase
has a working rollback at all** until the kill switch is a live key (P1-2).

Gates: phase-2's are measurable (coverage, reconnects, unknown share, gap time). Phase-3's "полная сверка
находит 0 тредов с head, неизвестным проекции" is a genuinely good, falsifiable gate — it is the right one.
"workboard needs-reply не расходится с ручной проверкой" is not a metric; replace it with the reconcile's own
head-repair count over the window. The projection rollback is missing (above).

**Shadow coverage is computable** — both sides land in `observations` with message ids, and the lead time
comes from `received_at` — with two caveats the document must state: the denominator is only the messages
REST happened to fetch (biased up), and the CLI must read bodies through the capture-payload seam because a
row's inline body may be NULL since migration 0128 (P2-12). **99.5 % is sensible as a freshness gate** and
should be labelled as such: completeness is guaranteed by the reconcile in every mode, so the gate is about
whether the socket is worth trusting for latency, not about whether data is lost. On the proposed canary the
7-day sample is a few thousand messages, so state the minimum count below which the number means nothing.

**Cheaper Phase 0: yes, materially** — the two-tab tap answers the highest-risk unknown (M3/M4) with zero new
connections, and a throwaway account answers everything hostile. **Is anything unsafe: yes** — the document
folds A §11's M1 (2/5/10 concurrent sockets) and S2 (20 reconnects in 60 s) onto a model's live session,
against evidence A's own S1 instruction. Listed precautions (page proxy never direct-IP, owner gate, masked
token, one canary) are correct but insufficient; missing are the low-value-account rule, an abort rule, a
time-box, off-peak scheduling, and telling the chatter. See P1-5.

### 3. Convention fit

**Right:** migration **0150** is the correct next number; the config keys are correctly identified as live
per-chunk reads; the fail-closed allowlist instinct is right; `WRITTEN_OBSERVATION_KINDS` + `RAW_ONLY` with a
reason is exactly the protocol `observation-kinds.ts` documents; the HealthFloor really is free with a family
(`health-floors.ts:75` maps `CANONICALIZER_FAMILIES`); no new mutation route means the auth-declaration pin is
genuinely untouched; the platform-branch claim holds (and is easier than claimed — see P3); the ESLint undici
wall is correctly read and the transport is correctly placed under `services/egress/`; refusing to raise
cadence because of the L1 slot trap is exactly right and the trap is real.

**Wrong or omitted:** the staged/editable class (P1-2, the biggest one); `exact_bytes` and CAS (P1-3);
erasure reachability (P1-4); the six-place `source` checklist including the client-visible
`agentObservationSourceEnum` and the contracts regeneration (P2-9); the incident-kind count and the wrong
model migration (P2-10); `platform-core.capabilities` has no `events` field and the raw-fetch ratchet is not a
drop-in (P2-16); the allowlist's label-vs-ID semantics (P2-14); no decisions.md entry and no runbook (P2-17);
and no named tests — the pins this work will trip are `observation-kind-coverage`, `health-floor-names`,
`notification-incident-messages`, `config-registry`, `migration-invariants`, `canonicalize-budget`, plus new
integration tests in root `tests/` under Testcontainers (`erasure-*`, `page-dm`, `sync-status`).

### 4. Effort

| Phase | Production | Tests | Notes |
|---|---:|---:|---|
| 1 — substrate | ~1 100 | ~560 | migration, schema, sessions repo, 5 config keys (4 files each), kinds, incident (6 sites), health override, guards 7.3/1–2, ratchet, coverage CLI |
| 2 — shadow | ~1 260 | ~920 | transport, supervisor, journal + frame classification, metrics, worker registration, **bounded catch-up** |
| 3 — live | ~590 | ~600 | inline projection, dirty-set, reconcile gating, health activation, deadman |
| **Total** | **~2 950** | **~2 080** | **≈5 000 lines**, ~35–45 source files, ~12 test files, 1 migration, plus ~2 000 lines of *regenerated* contract artifacts to review |

**"1 500–2 500 lines including tests" is optimistic by roughly 2×.** In this repo tests routinely exceed
production code (404 files in `tests/`, a pin culture, Testcontainers integration suites), and the estimate
appears to price the happy path only. Taking the P1-7 and dirty-set cuts brings it to ~**3 800–4 300**, which
is a defensible number to publish.

**Riskiest implementation item: the bounded catch-up mode inside `fanslyDmConversationsChunk`.** That handler
runs ~740 lines (`executor-handlers.ts:2778`–~3520) and carries, in one place: generation stamping,
membership certification (`membershipCertified` / `destructiveFinalization` / `lastFullSweepCompletedAt`),
the G3 erasure fence (`tryAcquireDmArchiveWriterFenceLock`), and offset pagination over a list that reorders
underneath it — a failure mode that already accounts for **149 of the 289** recorded failures (C §5). A second
walk mode in there is where a real incident comes from, and it is *also* the P1-1 phase-0.5 deliverable —
which is an argument for building it first, alone, with the socket nowhere in sight.

Runner-up: the `exact_bytes` / CAS / erasure interaction (P1-3, P1-4), because it is **silent** — nothing
fails at build or in tests; it surfaces the day someone runs a subject erasure.

### 5. Readability for the owner

§0 is well written and mostly accurate, with four defects: it leads with a **−75…−80 %** figure that belongs
to phase 4 while the proposed work delivers −49 % (P1-1, P2-3); §0.3 states the 6-hour reconcile as *the
change* when it is the far end of a multi-week ladder; §0.4 presents the presence conclusion as settled while
§7.1 makes `P1 = yes` a stop-the-project condition; §0.6's "rollback is one flag" is not implementable as
specified (P1-2).

Internal contradictions in the body: §5.2 D item 3 vs `refreshPageDmConversationWindow` (P2-6), which also
makes §7.3 item 10 self-cancelling; §5.2 B's "every frame is journalled" vs its own exemption list (P2-18);
§5.2 D's "in one transaction" vs the OF precedent it cites (P2-5); §5.2 E "десятки /group" vs §6 "≈50–200".

Number consistency between §2.1, §6 and evidence C: §2.1 reproduces C §3 **exactly** for every stream —
except the `notifications` cadence, which C contradicts (P2-1) — but the failure **rate** is wrong (P2-2), the
window labels hide a 2-day sub-window behind a 6-day heading (P3), and §6's target line is attributed to C §8
while being the author's own and not summing to its stated total (P2-3). Claims with no source at all are
listed in P3.

### 6. Five lines for the owner

1. **Yes, eventually — but not as the first move, and not for the reason the document leads with.** The
   socket buys **freshness** (30 minutes → seconds, browser off); the −80 % request cut is mostly a separate
   phase-4 project.
2. **Do this first, on its own: the bounded conversation walk.** No socket, no new plumbing, ~300 lines — it
   plausibly removes ~85 % of the biggest lane (15 680 → ~2 200 calls/day) and it builds the hardest piece of
   the socket plan under low stakes.
3. **Then the live protocol test — but cheaper and safer than proposed:** two browser tabs on the model's own
   session answer the highest-risk question (does a second socket steal the browser's events) for free, and a
   throwaway Fansly account takes the aggressive probes. Do **not** open ten sockets or storm-reconnect on a
   model's account.
4. **Before any code ships, four things must change in the document:** the kill switch must be a live key
   (as specified it needs a restart), the journal must be erasure-reachable and must not use `exact_bytes`
   (as specified it would block subject erasure), and the frame journal needs a volume cap on a box we are
   already short of disk on.
5. **Budget honestly: ~4 000–5 000 lines over three phases, not 1 500–2 500** — and expect the go/no-go to
   land at the end of the live test, not now.
