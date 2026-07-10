# Wave 2 design notes — corrections program (fastreply-corrections branch)

Companion to `docs/fastreply-freshness-build-spec.md` (frozen; Wave 2 section + v7
amendment 8 + v8 tightenings govern). This note records the two derivations the spec
left to the build session: the first-event dedup discipline and the Fansly repair
slice. Nothing here overrides the spec.

## 1. First events vs superseding events — dedup key discipline

The spec pins superseding events to dedup key `msg:<dir>:<id>:<fpHex>`. It does not
say which key a **first** event appended by the reconciler uses (preamble 2: Wave-1
REST-only rows "legitimately get their first events appended"). Derivation:

- **First event for a message (revision 1) always uses the canonical key
  `msg:<dir>:<id>`** — whoever emits it (the canonicalizer for webhook-sourced
  observations, or the reconciler for REST-only / command-only rows). This makes the
  race disappear by construction: if the reconciler appends the first event for a
  command-confirmed send and the `messages.sent` webhook arrives late, the
  canonicalizer's emission dedups against the claim silently — the exact
  cross-producer proof the ledger was built on.
- **Superseding events (revision ≥ 2) use `msg:<dir>:<id>:<fpHex>`**, schemaVersion 2,
  DATA carries `supersedesEventId` + `fingerprint` (hex) + the COMPLETE merged head.
  No top-level column, no new event type (both explicitly rejected).

`emitted_fingerprint` bookkeeping in the reducer:
- INSERT from **webhook** source → `emitted_fingerprint = material_fingerprint`,
  `emitted_event_id NULL`: the same journal row that fed the reducer feeds the
  canonicalizer, which emits the first event with the same material; if canonicalize
  wedges, the observation backlog gauge fires (that lane is already monitored) —
  setting emitted here is what keeps the reconciler from mass-appending a redundant
  event per fresh webhook message (the preamble-1 hazard, steady-state form).
- INSERT from **rest_reconcile** or **command** source → `emitted_fingerprint NULL`:
  no canonicalizer emits message events for these sources (readthrough has no family
  by design; command_result canonicalizes to `command.settled` only) — the reconciler
  appends the FIRST event (canonical key) and then sets emitted.
- UPDATE with material change (any source) → material_fingerprint advances, emitted
  stays → the reconciler appends a SUPERSEDING event and advances emitted +
  `revision_no`.

Reconciler event lineage (`observation_id`, never faked): REST-advanced rows use
`rest_material_observation_id`; webhook/command rows resolve through
`observation_keys (source, source_idempotency_key)` — webhook journal keys and
`cmd:<id>:<state>` keys are observation idempotency keys by construction. Unresolvable
→ skip-and-count (with the null-ref stubs, preamble 3).

## 2. Fansly 1970 repair — the head store difference (owner-flagged slice)

**OF mechanism:** dm_message_archive is the persistent material head; fingerprints
live on the row; the minutely reconciler drives `material != emitted`.

**Fansly difference:** Fansly messages have NO dm_message_archive row (that store is
OFAPI post-settle, OF-only) and exactly ONE source (the journaled sync-pull
`dm_messages` observation). There is no multi-source merge, so there is no persistent
head to maintain and no steady-state reconciler for Fansly. Derivation:

- **The "reduced head" for a single-source platform IS the corrected canonical
  fact** re-derived from the source observation (amendment 8's "never raw wave-1
  rows/provenance" guards the OF multi-source merge; with one source the observation
  IS the material). The repair fingerprint = sha256("dm-material-v1\0" +
  canonicalJson(corrected fact)) — used ONLY as the dedup-key discriminator + DATA
  field of the superseding event. No fingerprint columns for Fansly; no new store
  (rejected-by-minimalism, consistent with "no second ledger").
- **The repair is a one-shot owner-run campaign** (`events:repair-fansly-1970` CLI,
  dry-run default, keyset-paged, bounded), NOT a minutely reconciler: walk
  `domain_events` where `occurred_at < 2000-01-01` and type in
  (message.received|message.sent) — these live in the `pre_2024` partition, sized by
  the audit's runbook query; join the source observation by `observation_id`;
  re-derive the corrected fact with the FIXED timestamp conversion; append the
  superseding event with `occurredAt` = corrected time (lands in the correct
  partition; the 1970 original stays in pre_2024 — the ledger is append-only, the
  mistake stays recorded), `supersedesEventId` = the 1970 event id,
  `observation_id` = the ORIGINAL observation. Idempotent: the fp dedup key makes
  re-runs no-ops.
- **Healing:** the message_archive projector's same-message superseding merge
  replaces the archive row's material INCLUDING `occurred_at` (the archive is the
  only Fansly serving store with the 1970 damage; `page_dm_messages` always used the
  seconds/ms heuristic and is correct).
- **Source-bug fix, no version bump:** `fanslyDmMessages` switches from `asDate` to a
  seconds/ms-aware conversion (the `normalizeFanslyTimestamp` heuristic: value ≥ 1e12
  = ms, else seconds). New observations canonicalize correctly at the current family
  version. A version bump would replay every old dm_messages observation whose events
  dedup to nothing (audit Appendix D proved replay cannot heal) — the campaign IS the
  heal, so the bump is pure waste and is deliberately not done.

## 3. Sends-as-facts + the raced seam (scope restatement)

The defect: `executeOfapiCommand` ignores `finalizeOfapiCommand`'s return on BOTH the
confirm and failure paths, while the webhook verifier checks it. A webhook-confirmed
command racing the executor's direct confirm currently records a second (deduped)
observation — and on the failure path can record a `failed_*` command_result for a
command that is actually CONFIRMED (wrong fact, currently possible). Fix: the executor
checks the finalize result; a no-op finalize = lost race → log + skip the observation
and the fact emission; the actual command state is reported.

Sends-as-facts (text/media sends only): the DIRECT-confirm path feeds a
`command`-source candidate into the reducer (platformMessageId, conversationId = fan
id, text from the command payload, priceMills via mills constructors for media sends,
messageCreatedAt = confirm time — fill-only material that a later webhook upgrades
under W). The WEBHOOK-confirm path does NOT emit a candidate: the same journal row
already drives the webhook candidate through the cold-archive lane. Row source =
'command' (enum pre-reserved), `source_journal_id NULL`, `source_idempotency_key` =
`cmd:<id>:confirmed` (the command_result observation's key — real lineage),
emitted NULL → the reconciler appends the first `message.sent` event with the
canonical key, dedupe-proof against a late webhook.
