# Project Kernel — Pass 2: Target Architecture

**Deliverable 2 of 3.** The original companion review and `decision-points.md` were never committed
to this repo; this retained document is historical evidence, not current authority.

**Provenance.** Written 2026-07-04 as Pass 2 of Project Kernel. Grounded in the Pass 2 review
(whose factual claims were re-verified against source for this document — the handful of
corrections found were recorded in the unretained `decision-points.md` §0) and in fresh code verification across all
three repos (core, ChatGoose Desktop, ChatGoose extension). This is the **end-state design** — the
architecture the system should have, judged against the mandate's priorities, not against
migration cost. Pass 3 owns the path.

**How to read this.** §1–§2 state the priorities and the model in one page. §3 (capture) is the
heart — it exists to close the review's one-way doors. §4–§9 specify the kernel's planes. §10
specifies each userspace client. §11–§12 cover analytics and the repository standard. §13 records
the alternatives that lost and why. §14 is the inventory Pass 3 needs. Ten forks in this design
are product calls; each is marked `→ DP n` and was argued in the unretained `decision-points.md`
— the target text below states my recommendation but does not pretend the fork is closed.

---

## 1. Design mandate and priorities

Judgment order, fixed by the mandate:

1. **Capture first.** Business facts — messages, payments, subscriptions, fan activity — land in
   the kernel durably, whichever component saw them first. Non-capture is an explicit, defended
   decision (§3.6), never a default.
2. **Maintainability.** One seam per concept; no naming traps; a new agent (human or AI) can find
   "who can do what", "where does X get written", "what happens when Y arrives" in one place each.
3. **Buildability.** New features, analytics, and whole products compose from accumulated data
   and a generated SDK without archaeology.
4. **Performance at 10×.** More pages, more chatters, more platforms — without redesign. Nothing
   in the target requires exotic infrastructure at today's scale, but nothing caps out at 10× either.

**The regret test.** Every "modest option" chosen anywhere in this document is a two-way door
(cheap to upgrade later). One-way doors — permanent data loss, baked-in schema debt, migrations
that get more expensive with time — always get the strong option now. This is why the ledger
(§3), provenance columns (§5.3), append-only grants (§7.2), and the tenancy root (§7.4 → DP 9)
are in the target even though today's product could limp along without them.

**What carries over.** The review's keep-list (§3 there) is not discarded by the rewrite — each
proven mechanism has a designated home in the new structure:

| Proven mechanism (review §3) | Where it lands in the target |
|---|---|
| Journal-first webhook receive | Generalized into the observation journal — the pattern becomes the law for *every* producer (§3.1, §3.3) |
| Settle-ordered event stream + 409 snapshot | Event stream v2 — same protocol, per-account ordering, multi-replica capable (§6.5) |
| Command outbox (both sides) | Unchanged semantics; becomes the template for every platform's write path (§4.1); redaction policy revised (§3.5 door 4.8) |
| Canonical transactions + rebuildable rollups | The model for **all** projections (§5.2); gains provenance + currency (§5.3) |
| Contract discipline (129/129 Zod) | Kept; extended one step into a consumed, generated SDK (§6.3) |
| Migration story (numbered SQL, advisory lock, drift gate) | Unchanged (§5.5) |
| Auth primitives (argon2id, digests, `assignedPageIds`) | Kept; generalized to all-roles sessions + append-only grants (§7) |
| Secrets envelope, SSRF guards, redaction | Unchanged (§8.3) |
| Config governance (2-axis registry, staged flips) | Kept; capture paths removed from its jurisdiction (§3.4) |
| Desktop client engineering (custody, outbox, crypto) | Kept; the desktop keeps its local excellence and loses its hoard (§10.1) |
| Workboard v2 pure engine | Extracted intact into the workboard service; event-driven recompute (§10.3) |
| Testcontainers CI, OFAPI webhook fixtures | Kept; extended to the whole family (§12.4) |
| Extension credential custody (memory-only) | Unchanged — explicitly preserved by DP 1's recommended option (§10.2) |
| `docs/decisions.md` | Becomes the family-wide standard (§12.2) |

---

## 2. The kernel model

The codename is the architecture. **core is the kernel**: it owns every privileged concern —
platform credentials, platform data, the ledger of what happened, money math, AI egress,
authorization. Every client surface is **userspace**: it holds no privileged state, sees only what
its grants allow, and does everything through the syscall surface (the generated SDK over the
kernel API). A process that wants a fact asks the kernel; a process that *observes* a fact hands
it to the kernel.

```
   PLATFORMS                      THE KERNEL (core)                          USERSPACE
┌────────────┐    ┌──────────────────────────────────────────────────┐   ┌──────────────┐
│ OnlyFans   │    │  INGEST                 LEDGER          SERVE    │   │ Desktop      │
│  (OFAPI)   ├───►│ ┌──────────┐   ┌─────────────────┐  ┌─────────┐ │◄──┤ (OnlyFans    │
│  webhooks/ │    │ │ adapters │──►│ observations    │  │ API +   │ │   │  workspace)  │
│  REST      │    │ │ webhook  │   │ (raw, forever)  │  │ SDK     │ │   ├──────────────┤
├────────────┤    │ │ receivers│   ├─────────────────┤  ├─────────┤ │◄──┤ Extension    │
│ Fansly     ├───►│ │ client   │──►│ domain_events   │─►│ event   │ │   │ (Fansly      │
│  REST      │    │ │ capture  │   │ (canonical)     │  │ stream  │ │   │  in-page)    │
├────────────┤    │ └──────────┘   └───────┬─────────┘  └─────────┘ │   ├──────────────┤
│ platform 3 │    │       ▲                ▼                        │◄──┤ Workboard    │
└────────────┘    │  ┌────┴─────┐   ┌─────────────┐   ┌──────────┐  │   │ (chatter app)│
      ▲           │  │ commands │   │ projections │   │ AI       │  │   ├──────────────┤
      └───────────┤  │ (outbox) │   │ (rebuildable│   │ gateway  │──┼──►│ Dashboard    │
   writes only    │  └──────────┘   │  read models│   └──────────┘  │   │ (owner       │
   via outbox     │                 └─────────────┘        │        │   │  console)    │
                  │                        ▼               ▼        │   └──────────────┘
                  │                 ┌──────────────────────────┐    │        ▲
                  │                 │ ANALYTICS LAKE (Parquet)  │───┼────────┘
                  │                 │ + query engine + metrics  │    │   (AI vendors reached
                  └─────────────────┴──────────────────────────┴────┘    ONLY via gateway)
```

Five planes, each specified below:

| Plane | Job | Section |
|---|---|---|
| **Capture** | Every observation journaled before anything else; canonicalized into domain events; never deleted | §3 |
| **Platform** | One adapter seam; provider-native in, canonical out; capabilities declared, not branched on | §4 |
| **Storage** | Ledger (append-only) / projections (rebuildable) / lake (analytical) — three planes, three rulebooks | §5 |
| **Serve** | Modular API, declarative authorization, generated SDK, per-account event stream | §6–§7 |
| **AI** | One gateway, kernel-held keys, features as kernel services, capture by construction | §9 |

---

## 3. The capture plane: observations and the fact ledger

The review's single worst finding is that the kernel schedules deletion of business facts and
watches others pass through uncaptured (review §4, graded F). The target's answer is not "raise
the retention numbers" — it is a structural change: **capture becomes a plane with its own
storage, its own rulebook, and no feature flags**, instead of a side effect scattered across
sync handlers, webhook processors, and projections.

### 3.1 The observation journal

One append-only journal of everything the system sees, generalizing the proven journal-first
webhook receive (`ofapi_webhook_events`) into the universal front door:

```
observations
  id                 bigint identity
  source             enum: webhook | pull | client_capture | readthrough | command_result | operator
  producer           text     -- 'ofapi:webhook', 'sync:fansly:transactions', 'extension@1.5.6',
                              -- 'desktop@0.1.27', 'read-gateway', 'cli:backfill'
  platform           text     -- FK → platforms.key; null for non-platform facts
  account_id         bigint   -- FK → pages.id; NULLABLE: unmapped accounts are still captured
  native_account_ref text     -- the account id as the provider named it (acct_…, Fansly id)
  kind               text     -- provider-native discriminator: webhook event type, endpoint
                              -- template ('GET /{acct}/chats'), or client capture kind
  payload            jsonb    -- verbatim, untrimmed
  payload_hash       bytea    -- sha256, for cross-producer dedup
  idempotency_key    text     -- unique (source, idempotency_key)
  observed_at        timestamptz  -- when the fact was true upstream (provider timestamp if any)
  received_at        timestamptz  -- when the kernel journaled it
  actor_principal_id bigint   -- nullable: which principal produced/carried the observation
  parse_version      int      -- canonicalizer version that last consumed this row
PARTITION BY RANGE (received_at), monthly
```

Rules:

- **Journal before everything.** HMAC/auth verification first, then the insert, then any
  processing — exactly the current webhook receiver's discipline, now applied to every producer.
  A crashed worker, a broken projection, an unparseable payload never loses the fact.
- **Nullable `account_id` is deliberate.** Today an OFAPI event for an unmapped account settles
  `skipped` and dies with the journal. In the target the observation is kept; when the account is
  mapped later, canonicalization re-runs over the retained raw rows (`parse_version` marks what
  has been consumed by which parser generation).
- **Trimming is forbidden at capture time.** The current Fansly follower payloads trimmed to
  three fields at capture (`shared.ts:91`) is the anti-pattern; adapters may *normalize into
  domain events* however they like, but the observation row keeps the whole payload.
- **No capture flags.** The config registry keeps staged flags for *serving* features (a new
  projection's read endpoints, a new client surface). Whether an observed fact is journaled and
  canonicalized is not configurable. This kills the class of failure where projections default
  off while the journal expires (review §4.3).

### 3.2 Canonical domain events

Adapters translate observations into a platform-neutral, versioned event log — the layer
projections and clients actually consume:

```
domain_events
  id               bigint identity
  account_id       bigint NOT NULL          -- FK → pages.id
  account_seq      bigint NOT NULL          -- per-account monotonic; UNIQUE (account_id, account_seq)
  type             text NOT NULL            -- canonical vocabulary, below
  occurred_at      timestamptz NOT NULL
  fan_identity_id  bigint                   -- FK → platform_identities, when fan-scoped
  conversation_ref text / message_ref text / transaction_ref text   -- provider-native ids
  data             jsonb NOT NULL           -- canonical shape for the type
  schema_version   int NOT NULL
  observation_id   bigint NOT NULL          -- provenance: FK → observations
  dedup_key        text                     -- UNIQUE (account_id, dedup_key): survives multi-producer
PARTITION BY RANGE (occurred_at), monthly; append-only
```

**Canonical vocabulary** (initial set; grows additively):
`message.received`, `message.sent`, `message.deleted`, `message.ppv_unlocked`, `tip.received`,
`transaction.posted`, `transaction.adjusted`, `subscription.started`, `subscription.renewed`,
`subscription.expired`, `subscription.cancelled`, `follow.started`, `follow.ended`,
`presence.online`, `presence.offline`, `fan.profile_observed`, `fan.earnings_observed`,
`account.auth_changed`, `command.settled`.

Properties:

- **Multi-producer dedup is a feature, not a bug.** The same DM can arrive via OFAPI webhook,
  OFAPI REST backfill, gateway read-through, and (for Fansly) extension capture-through. The
  `dedup_key` (platform-native message/transaction id + type) collapses them into one domain
  event; the *observations* all survive with their distinct provenance. This is what makes it
  safe to run overlapping producers — the exact thing the current dual-vendor ping-pong
  (review §5.2) cannot do.
- **Re-canonicalization is routine.** When a mapping improves (the current `tips.received`
  "blocked pending live fixture" is the canonical example), the fix ships and a replay job
  re-derives events from retained observations. Capture now, understand later — the inverse of
  today's "understand first or lose it".
- **Per-account ordering, no global sequence.** `account_seq` is assigned at append under
  per-account serialization (§8.2). Global total order — today's `fanout_seq` — is dropped as a
  requirement because no consumer needs it: every client is account/page-scoped.

### 3.3 The producers

Six producer classes write observations. Everything the review found being discarded is one of
these:

| # | Producer | What it journals | Closes (review §) |
|---|---|---|---|
| 1 | **Webhook receivers** | Every verified webhook envelope, verbatim (today's behavior, kept) | 4.3 |
| 2 | **Pull sync handlers** | Every platform API response page the sync engine fetches — messages, transactions, subscribers, followers, earnings | 4.2, 4.8 |
| 3 | **Client capture** (extension, desktop) | Every platform response a client observes: Fansly transcripts, per-fan earnings stats, PPV order history, spender boards — batched `POST /ingest/observations`, async, fail-open with a durable client-side spool | 4.1 |
| 4 | **Gateway read-through** | Every OFAPI response the read gateway proxies: chat lists, message backfills, transactions | 4.4 |
| 5 | **Command results** | Every platform write's request + outcome (already durable in the outbox; the settle event also lands as `command.settled`) | 4.8 |
| 6 | **Operator actions** | Credential rotations, manual backfills, admin resets — as observations with `actor_principal_id` | 4.9 |

Client capture (producer 3) is the one genuinely new lane and the pivot of **DP 1**: it gives the
kernel everything the extension sees *without moving credentials anywhere* — the session material
stays in browser memory exactly as today; only observed data flows. The endpoint is
bearer-authenticated, idempotent (client-generated idempotency keys), size-capped per batch, and
rate-limited; the client keeps a persistent retry spool so a dead network never drops facts
(the desktop's crash-safe usage queue is the model — minus its delete-after-3-failures policy,
which is exactly the lossiness the target forbids).

### 3.4 Retention: tiering, never deletion

The retention model inverts today's policy. Today: business facts get deletion schedules,
ops telemetry grows forever. Target:

- **Business facts (observations, domain events, message archive, transactions, fan history):
  never deleted.** Aging partitions are *tiered*, not dropped: after a hot window (default 6
  months) partitions are exported to Parquet on object storage and detached from the hot DB; the
  lake (§11) makes them queryable forever. Logical deletion exists only as an audited, owner-only,
  break-glass erasure that writes tombstones (→ DP 7).
- **Ops telemetry (`sync_runs`, `sync_http_attempts`, heartbeats, queue history): bounded
  retention.** These are the *only* tables with deletion schedules in the target — the exact
  inverse of today (review §4.9's closing observation).
- **Cost defense, with numbers.** At a generous 10× estimate — 1M observations/day at ~2 KB
  average — the raw journal grows ~2 GB/day ≈ 730 GB/year, and Parquet compresses this class of
  JSON ~10:1, i.e. **~75 GB/year of object storage ≈ $1.80/month at commodity S3 pricing**.
  Realistic volumes (tens of thousands of events/day today) are two orders of magnitude lower.
  "Expensive to store" is not an available argument at this scale; nothing in this system's data
  is big. The one genuinely large class — media binaries — is the one explicit non-capture (§3.6).
- **Retention knobs leave the runtime config surface.** Today DM-archive retention is
  dashboard-editable down to 1 day (review §4.9). In the target, fact-class retention is not a
  config knob at all; tiering windows are deploy-time constants, and *erasure* is a procedure,
  not a setting.

### 3.5 Closing every one-way door

Traceability from the review's inventory (its §4) to the mechanism that closes it:

| Door (review) | Target mechanism |
|---|---|
| 4.1 Fansly dark | Extension capture-through (producer 3) + kernel-side Fansly sync extended to earnings-stats and order-history endpoints (§4.4) → both land as observations; canonicalizer dedupes. → DP 1 |
| 4.2 DM prune destroys the only copy | `messages` become domain events + a platform-neutral message archive projection (§5.4); the hot `page_dm_messages` table survives as a *bounded cache projection* — pruning it is now safe because it is rebuildable. The admin "reset messages_history" resets the projection, never the ledger. |
| 4.3 Webhook journal expires unconditionally | Journal = observations; no deletion, no flag-gating of capture (§3.1, §3.4) |
| 4.4 Read gateway discards proxied bodies | Gateway read-through producer (producer 4) — the credit spent on a read now also buys a captured fact |
| 4.5 Desktop-local one-way doors | Acceptance/insert telemetry, guard-audit events (full text), send audit, AI spend enter the client-capture lane; upload spool is durable, never self-deleting; `data.purge` purges the *device*, not the kernel's copy (§10.1) |
| 4.6 AI content never captured | Gateway captures prompts/completions/acceptance under an access-restricted class → DP 6 (§9.3) |
| 4.7 Histories collapsed to latest-state | Presence → `presence.online/offline` events (time series); subscriptions → lifecycle events; assignments → append-only grants (§7.2); workboard undo → compensating `contact.retracted` event, never row deletion |
| 4.8 Ingest-time lossiness | Currency + provenance columns on transactions (§5.3); actual platform fees captured where the vendor exposes them (verify against OFAPI's vendored `openapi.json` in Pass 3); command payload self-redaction dropped — the sent text is a kept business fact either way; follower payloads journaled whole |
| 4.9 Structural deletion doors | `pages` delete becomes tombstone-only (`status`, `deleted_at`); fact tables reference accounts with `ON DELETE RESTRICT`; cascade reserved for config/cache child rows; retention knobs de-configured |

### 3.6 What is deliberately not captured

Per the mandate, every non-capture is an explicit decision with a defense:

1. **Media binaries** (photos/videos in DMs and posts). Captured: full metadata, provider IDs,
   pricing, purchase state, URLs. Not captured: the bytes. Defense: this is the one genuinely
   large data class (TB-scale, unlike everything else); its analytical value is carried almost
   entirely by its metadata (what was sent, to whom, at what price, did it sell); and durable
   possession of creator media raises custody/liability questions that belong to the owner, not
   to a default. This is a *partial* one-way door (expired platform URLs are not refetchable) and
   is therefore surfaced rather than buried: revisit per-class if content analysis becomes a
   product goal.
2. **Typing indicators** are journaled as observations (they arrive on the webhook anyway; the
   marginal cost is one row) but get no canonical event and no projection. Defense: near-zero
   analytical value today; because the raw rows are retained, promoting them later is a two-way
   door — the definition of a safe deferral.
3. **Client UI telemetry** (clicks, navigation, session length in desktop/workboard). Not
   captured in this target. Defense: internal-tool product analytics is a separate, opt-in
   concern; nothing platform-sourced is lost; adding it later loses only the telemetry from
   before it ships. Two-way door.
4. **Full HTTP response headers** from platform calls. Captured: rate-limit and billing metadata
   (needed for pacing and credit accounting). Not captured: the rest. Defense: headers carry
   transport state, not business facts; payloads are kept whole.

Everything else the system observes is captured. In particular the target explicitly rejects
non-capture of: proxied read bodies ("we already served it"), unmapped-account webhooks ("no page
to attach to"), pre-webhook message history ("the archive is webhook-sourced"), AI acceptance
signals ("privacy of the chatter's workflow" — it is the product's own quality signal), and
outbound command payloads ("PII redaction" — the same text is already a captured `message.sent`).

---

## 4. The platform plane

### 4.1 The adapter contract

One seam, honestly typed, replacing the ~66 strict (`platform ===`) / ~120 broad branch sites and
the two hand-mirrored adapter classes. A platform integration is a package implementing:

```ts
interface PlatformAdapter {
  readonly key: string                       // 'onlyfans' | 'fansly' | …
  readonly capabilities: PlatformCapabilities

  // ingest
  pull: Partial<Record<CanonicalStream, PullHandler>>   // one bounded-chunk handler per stream
  webhook?: WebhookIntegration               // verify(rawBody, headers) + decode(observation) → DomainEvent[]
  canonicalize(observation: Observation): DomainEvent[] // total: every observation kind it produces

  // egress
  commands?: CommandExecutor                 // the outbox's platform half: execute(command) → result
  session: SessionCustodyDescriptor          // declares HOW credentials are held/refreshed — see note
}

interface PlatformCapabilities {
  streams: CanonicalStream[]                 // which of: account, transactions, subscriptions,
                                             // followers, conversations, messages, presence,
                                             // fan_earnings, purchase_history, top_spenders
  webhooks: boolean
  writes: CommandKind[]                      // [] for read-only platforms
  presenceSource: 'webhook' | 'poll' | 'none'
  billing: 'credit_metered' | 'flat' | 'session'   // drives pacing/budget wiring
}
```

- **The sync engine keeps its bones.** The planner → `page_sync_states` FSM → executor → bounded
  chunks design is proven and platform-agnostic already; only the *handlers* move behind the
  adapter. The stream set per page becomes `adapter.capabilities.streams` instead of hardcoded
  per-platform lists; the 4,142-line `executor-handlers.ts` decomposes into per-adapter handler
  modules.
- **The command outbox generalizes as-is.** Intake → dedup on `(page, principal, client_command_id)`
  → single-attempt execute → webhook-reconciled `indeterminate` — this is the write path for
  *every* platform that allows writes; `CommandKind` is adapter-declared.
- **Naming honesty is a hard rule.** `AppContext.adapter`/`onlyFansAdapter` (Fansly/OnlyMonster
  inversion) is replaced by a registry: `platforms.get(page.platform)`. The vendor is named where
  the vendor matters (`OfapiTransport`, not `OnlyFansAdapter` for a third-party aggregator).
- **`platform` stops being a 2-value pgEnum.** A `platforms` reference table (key, display name,
  adapter version) + text FK. Adding platform #3 is a row + a package, not a migration across 61
  tables.
- **Session custody note.** The `SessionCustodyDescriptor` declares *what kind* of credential a
  platform needs and its lifecycle (long-lived API key vs. browser-session material vs. OAuth).
  I am deliberately not specifying capture or relay mechanics for browser-session credentials —
  how session material is obtained or moved is a security-sensitive design area I am leaving to
  the owner (flagged, not forgotten; see DP 1's custody note). The kernel-side storage contract is
  unchanged from today: AES-256-GCM envelope, versioned key ring, never in logs or config views.

### 4.2 OnlyFans: one vendor of truth (→ DP 2)

The target has **one OnlyFans adapter, backed by OFAPI**, covering transactions, DMs, audience,
webhooks, and commands. OnlyMonster is retired. Reasons (argued fully in DP 2): OFAPI is already
the mandatory vendor for everything real-time and for writes; the split currently gives revenue
capture a single point of failure *anyway* (OnlyMonster exclusively feeds transactions) while
adding a second paid bill, a second money convention, a second ID namespace, and an unresolvable
"who wrote this row" ambiguity (`transactions` has no provenance column — verified). The two
prerequisites the migration must prove (Pass 3): OFAPI transaction history parity (including
actual fees — check the vendored `openapi.json`), and tips canonicalization (currently blocked on
a live fixture — capture-now-parse-later dissolves this class of blocker, §3.2).

The adapter seam is what makes this reversible: if OFAPI degrades, a second OnlyFans transport is
a new adapter implementation, not a re-fork of the codebase — and provenance columns (§5.3) mean
a future dual-feed period is reconcilable instead of ping-ponging.

### 4.3 Fansly: same pipeline, two producers (→ DP 1)

Fansly data flows through the identical capture pipeline: kernel-side pull sync (existing
adapter, extended with the two endpoint families only the extension calls today — per-fan
earnings stats and PPV order history) **plus** extension capture-through (§3.3, producer 3).
Dual producers are safe by construction (dedup at canonicalization) and complementary: server-side
sync gives completeness and independence from who is browsing; capture-through gives fidelity and
freshness exactly where chatters are working, at zero marginal API cost — those responses were
already fetched. The Fansly session-freshness asymmetry (extension auto-captures at every login;
kernel's pasted session rots) is real and is part of DP 1's custody note.

### 4.4 The litmus: adding platform #3

The target is correct if adding a third platform (say, Fanvue) means: write
`packages/platform-fanvue` implementing `PlatformAdapter`, add a `platforms` row, add credential
UI. No schema migration, no new branch sites, no event-stream changes, no client changes (clients
consume canonical events and the SDK). Anything in the design that would break this litmus is a
bug in the design.

---

## 5. Storage

### 5.1 Three planes, three rulebooks

| Plane | Contents | Mutability | Retention |
|---|---|---|---|
| **Ledger** | `observations`, `domain_events`, command records, grants, audit | Append-only (tombstones for break-glass erasure) | Forever; hot→Parquet tiering (§3.4) |
| **Projections** | Everything derived: threads/messages cache, fans, subscriptions, spend rollups, workboard state, credit state | Freely mutable, **rebuildable from the ledger by definition** | Prunable at will — pruning a projection is now a non-event |
| **Lake** | Parquet exports of ledger + snapshotted projections; metrics models | Immutable files | Forever |

The current schema's classification (review §2.2: ~11 fact tables, ~10 projections, ~14 ops,
~13 config) maps cleanly: fact tables migrate into or re-anchor onto the ledger; projection
tables keep their shapes but gain the rebuildable discipline; ops/config stay operational.

### 5.2 Projection discipline

Every projection (the current transactions→rollups design generalized):

- declares its **inputs** (event types consumed) and its **watermark** (per-account
  `account_seq` high-water — replacing today's per-projection ad-hoc watermarks);
- is **rebuildable by one command** (`kernel projection rebuild <name> [--account]`) from the
  ledger — CI proves this for every projection against fixtures;
- is **versioned**: bumping a projection's version triggers rebuild on deploy (the migration
  runner already knows how to gate on this);
- **never blocks capture**: projections consume post-append, exactly as today's post-settle
  hooks never block webhook settle.

The hot DM table (`page_dm_messages`, 200/1,000 cap) survives *as a projection* serving
interactive reads; the full history lives in the message archive projection (platform-neutral
successor of `dm_message_archive` — `ofapi_account_id NOT NULL` becomes `account_id` FK, sources
open to all producers) and, ultimately, in the ledger itself.

### 5.3 Schema standards

- **Money: one unit.** `amount_micros bigint` (micro-USD) + `currency char(3)` + raw provider
  amount/currency preserved on the observation. Micro-USD is the only integer unit that spans fan
  spend and AI cost (mills cannot express sub-mill AI prices — that is why the zoo grew).
  `packages/shared/money` exposes the single codec; lint bans raw arithmetic on money columns and
  the `toMills(number)`-style ambiguous constructors (the 1000× footgun dies by construction:
  constructors are named by source unit — `microsFromDollars`, `microsFromCents` — and there is
  no bare-number path). Alternative weighed in §13.8.
- **Provenance everywhere.** `transactions` (and every fact-derived row) carries
  `source_observation_id` (or `source` + `source_ref` where an aggregate has many). "Which system
  wrote this row" — the question the dual-vendor era could not answer — becomes a join.
- **Identity: one lane.** `platform_identities (platform, native_user_id)` is the single fan
  identity key; `fans` becomes its enrichment; the current three parallel OnlyFans identity lanes
  (review §6) collapse into it. Pages expose their platform-native IDs through the API
  (`GET /pages` returns them), killing both clients' username-match heuristics.
- **Naming honesty.** The `platform_account_id`-means-two-things trap is removed:
  child-table FK columns are `account_id` (→ `pages.id`); the provider-native id on `pages` is
  `platform_native_id`. `page_sync_cursors` accessed by `getCheckpoint` and
  `sync_http_attempts` written by `insertSyncRequestAttempt` get matching names.
- **Soft-delete for roots.** `pages`, `models`, `users` tombstone (`status`, `deleted_at`);
  FKs from fact tables are `RESTRICT`. Cascade survives only config/cache children.
- **Time.** `timestamptz` UTC everywhere (already true); business-date logic stays in one shared
  module; the Telegram-report Moscow/UTC split is resolved to a single declared reporting zone.

### 5.4 Postgres stays the system of record

One Postgres instance remains the OLTP + ledger + queue store (pg-boss). This is deliberate:
at this system's scale (see §3.4 numbers), a second storage system for the ledger (Kafka,
DynamoDB, etc.) buys operational burden and buys nothing else (§13.2). Native partitioning +
tiering keeps the hot set small. Object storage (any S3-compatible) is the one new stateful
dependency, serving the lake and tiered partitions.

### 5.5 Migrations

Unchanged: hand-written numbered SQL, advisory lock, contiguity guard, boot-time schema gate,
`db:generate` disabled, deploy rollback gated on migration delta. It is the best-engineered
subsystem in the family relative to its size, and it is exactly what agent-driven schema work
needs (reviewable SQL, no magic). One addition: projection-version gates (§5.2).

---

## 6. The kernel API

### 6.1 Modular decomposition

The 3,583-line `server.ts` (129 routes) decomposes into bounded-context modules, each owning its
routes, service, and repository — one deployable (modular monolith, §13.3), hard internal seams:

| Module | Owns (routes today ≈) | Notes |
|---|---|---|
| `identity` | auth, sessions, users, api-keys, grants | §7 |
| `catalog` | models, pages, credentials, proxies, onboarding | platform-neutral; adapters do verification |
| `ingest` | webhook receivers, client-capture endpoint, observations admin | §3 |
| `conversations` | threads, messages, archive search, fan profiles/summaries | serves desktop + extension + workboard |
| `finance` | transactions, revenue, spend rollups, reporting, spender views | canonical money module |
| `audience` | fans, subscriptions, follows, presence | |
| `workboard` | board reads, contact log, snoozes, classifier admin | §10.3; v1 retired, engine intact |
| `ai` | gateway, feature services, usage ledger, model routing | §9 |
| `ops` | sync health, credits, incidents, config, diagnostics | |
| `events` | stream + snapshot | §6.5 |

Composition root registers modules; a module's internals are import-restricted (lint-enforced, the
desktop's `no-restricted-imports` pattern — §12.4). Cross-module access goes through each module's
exported service interface, never its tables.

### 6.2 Declarative authorization

Authorization moves from ~150 imperative in-handler guard calls to the contract:

```ts
routeSchemas.getPageRevenue = {
  auth: { roles: ['owner', 'team_lead'], scope: 'page' },   // enforced, not documentation
  ...
}
```

One middleware resolves the principal, checks role, resolves scope (`page` → grant check via the
proven `assignedPageIds` primitive), and rejects — before any handler runs. Consequences:

- The `security:` field stops being able to lie: OpenAPI, SDK, and runtime derive from the same
  declaration.
- "Who can do what" becomes a generated table (contract → markdown), auditable in one look.
- The review's finding that **chatter API keys can read page revenue today** (30 any-principal
  routes) becomes structurally impossible to reintroduce silently: a route without an `auth`
  declaration fails CI.
- CLI admin surfaces route through the same policy layer with an `operator` principal.

### 6.3 Contracts → SDK

The pipeline stops one step short today (100% Zod contracts → OpenAPI + 14,753-line `api-types.ts`
that nothing imports — verified). The target completes it, changing the generation direction:

- **Generate the client from the Zod contracts directly** (not from OpenAPI): a build step in
  core emits `@kernel/sdk` — typed methods per operation, runtime response validation using the
  same Zod schemas, SSE helpers for the event stream and AI gateway, auth plumbing, retry/error
  taxonomy. This sidesteps the `$ref`-less OpenAPI problem entirely (the Zod-Fastify transform
  inlines every schema; deriving types from it is why the generated file is huge and unused).
- OpenAPI remains a *published artifact* for documentation and third parties, with shared
  components restored (register schemas with IDs so the emitter can `$ref` them).
- **All four surfaces consume the SDK**: dashboard, desktop, extension, workboard. Hand-written
  hub clients are deleted. The SDK is versioned with core; each client pins a version; a
  cross-repo CI check (§12.5) turns today's "sync is a CLAUDE.md convention" into a gate.
- Distribution per DP 10 (private npm registry or git-tag consumption — mechanism is Pass 3's
  choice; the target's requirement is only: generated, versioned, consumed, gated).

### 6.4 Versioning policy

`/api/v1` with additive evolution as the norm (clients tolerate unknown fields/frame types —
already the SSE contract's rule). Breaking changes ship as new operations, not new prefixes; the
`/api/v2` five-route pocket is folded back. Deprecations are marked in the contract
(`deprecated: true` + successor), surface in the SDK as compiler deprecations, and get a
removal date recorded in `decisions.md`.

### 6.5 The event stream v2

The proven SSE protocol, re-keyed for scale and platform neutrality:

- **Source**: `domain_events` (all platforms, all producers) instead of the OFAPI-only webhook
  journal. Fansly activity streams for the first time.
- **Ordering/resume**: frames carry `(account_id, account_seq)`; the resume cursor is an opaque
  token encoding per-account high-waters. The per-connection monotonic guard and
  checkpoint-after-handle discipline carry over per-account. `Last-Event-ID` gap beyond the hot
  window → the existing `409 sync_snapshot_required` + snapshot flow, now per-account.
- **Replay window**: bounded by partition tiering (months), not deletion (7 days) — snapshot
  recovery becomes rare instead of routine.
- **Fan-out**: unchanged LISTEN/NOTIFY hub per API replica; page-grant filtering per connection;
  60 s re-auth kept. Multiple API replicas need no coordination (each drains independently;
  ordering is per-account at the source).
- **Consumers**: desktop (as today), workboard app (board deltas ride the same stream as
  `workboard.state_changed` events), dashboard (replacing its 18-endpoint polling), extension
  (optional, for kernel-served fan context).

---

## 7. Identity and access

### 7.1 Principals

Three kinds, one table, one resolution path:

- **Humans** — owner, team_lead, chatter. **All human roles are session-capable** (argon2id
  password login; the current `roleCanUseSession` excludes chatter and is the workboard's real
  blocker — verified). `content_manager` is deleted (dead enum value with no credential path).
- **Devices** — a desktop install, an extension profile: bearer tokens **bound to a human**
  (issued on login, revocable per-device, expiring). The current chatter API key becomes this.
  Device tokens carry the human's grants; nothing is ever attributed to a bare device.
- **Operators** — CLI/automation principals for admin and jobs, so audit rows never say "null".

Auth mechanics (argon2id, digest-only storage, timing-equalized verify, backoff) carry over
unchanged. Whether the workboard app fronts this with first-party sessions or an OIDC IdP is
DP 4's auth sub-fork; the kernel's principal model is the same either way.

### 7.2 Grants, append-only

`user_page_assignments` (delete-on-unassign — "who was assigned when" is unanswerable today)
becomes an event-sourced grant log:

```
access_grants: principal_id, scope_type (org|model|page), scope_id,
               role_on_scope, granted_by, granted_at, revoked_by?, revoked_at?
```

Live permissions are the obvious projection (and keep the `assignedPageIds` enforcement shape
that already works); history is free. **Model-level grants** are first-class — "chatters get
access to the models assigned to them" (the workboard mandate) becomes `scope_type='model'`,
expanding to that model's pages, present and future. Access-grain policy for the workboard is
DP 4's second sub-fork.

### 7.3 The attribution invariant

Every kernel mutation records its acting principal. Already exemplary on commands
(`chatter_user_id NOT NULL ON DELETE RESTRICT`), AI usage, and fan profiles; the target extends
it to the gaps the review found: contact log (records the *model*, never the acting user —
verified), snoozes, gateway reads (principal dropped before the credit ledger), config staged
flips, manual syncs, erasures. Rule of thumb enforced by review + lint on repository signatures:
**no kernel write API without a principal parameter.**

### 7.4 Tenancy root (→ DP 9)

The target adds an `orgs` root table and `org_id` on the **root entities only** — `users`,
`models`, `pages`, `api principals`, `config_settings` scope (the unused `scope_type/scope_id`
columns finally earn their keep) — with a single row today. Child tables inherit tenancy through
their page/model FK; no smearing across 61 tables. Cost now: one column on ~6 tables and a
`WHERE` clause in root-level list queries. Cost of retrofitting later: the classic
multi-tenant-migration slog plus an unanswerable audit history. This is regret-test asymmetry at
its clearest — but whether multi-agency is a real future is the owner's call, so it is DP 9, not
a fait accompli.

---

## 8. Runtime topology

### 8.1 Processes

Same image, four roles (up from three), all horizontally scalable except the scheduler:

| Role | Cardinality | Runs |
|---|---|---|
| `api` | N | HTTP + SSE + SPA hosting; enqueue-only queue access (as today) |
| `worker` | M | Sync executor chunks, canonicalization, projections, commands — partitioned by account (§8.2) |
| `scheduler` | 1 active (advisory-lock leader election) | Cron enqueues only; stateless standby allowed |
| `analytics` | 0..1 | Lake exports, metrics builds; can also run inside `worker` at small scale |

### 8.2 Ordering without a singleton

The current worker is a structural singleton (asserted single replica + advisory lock + one
global `fanout_seq` — verified), which caps capture latency at 10×. The target replaces global
ordering with **per-account serialization**:

- Canonicalization and projections for one account are serialized (pg-boss group id per account —
  the group-serialization machinery already exists for egress groups; an advisory lock keyed on
  `account_id` is the fallback pattern and is already used per-page for spend ingest).
- `account_seq` is assigned inside that serialized section — monotonic per account by
  construction, regardless of worker count.
- Cross-account work spreads freely across M workers. The ceiling moves from "one process, one
  lane" to Postgres write throughput, which at these volumes is not a constraint.

### 8.3 Egress and pacing: one policy

Today three egress behaviors coexist (proxied gateway reads vs. hub-direct DM sync and command
sends — verified), and one 500 ms process-global slot serializes all OFAPI traffic. Target:

- **One egress resolver.** Every outbound platform call obtains its dispatcher from
  `resolveEgress(account)`; the HTTP client factory *requires* an egress context (no default
  path), and lint bans direct undici/fetch use outside it. Reads, writes, and syncs for an
  account leave from the same address by construction. SSRF guard and credential redaction stay
  where they are (they are correct).
- **Per-account pacing with priority classes.** The DB-backed rate-limit waiter generalizes:
  budgets keyed `(vendor, account)` with vendor-global caps layered above; three priority classes
  — interactive (gateway reads, presence) > commands > bulk sync — so a chatter's open chat never
  queues behind a backfill. Fairness across accounts replaces head-of-line blocking.
- **Auth-dead pages stop syncing.** Credential death (typed, not substring-matched) pauses the
  page's streams and opens an incident; the planner skips paused pages (the FSM already has the
  `paused`/`blocker` vocabulary — it gains the wiring).

### 8.4 Deployment

Containers as today; compose remains the baseline at current scale, with the deploy script's jobs
(build, ship, verify, gated rollback) moving into CI-driven pipelines with an image registry —
the 1,061-line SSH script's *checks* are good; its execution venue is the problem. The topology
is horizontally ready (stateless api, partitioned workers, leader-elected scheduler) so growing
past one VPS is a hosting decision, not an architecture project. New stateful dependency: object
storage only (§5.4).

### 8.5 Observability

Keep: pino + redaction, heartbeats, sync telemetry, incident engine. Add: per-plane golden
signals as first-class metrics — capture lag (webhook receive → observation), canonicalization
lag (observation → domain event), projection lag (event → read model), command settle time, SSE
delivery lag — exported and alertable. These five numbers *are* the kernel's health; today only
fragments of them exist inside `sync_runs` stats.

---

## 9. The AI plane

### 9.1 One gateway (→ DP 5)

All model traffic from every surface goes through the kernel's AI gateway: kernel-held provider
keys, per-page proxy egress, quotas/budgets, one usage ledger, model routing. Direct-from-client
vendor calls (desktop default today; extension always) end. The gateway already exists and is
well-built (review's judgment; the desktop's hub-AI mode is already wired behind a toggle —
verified); the target makes it the only lane. What this buys: real cost attribution (per feature,
per chatter, per model — today's client-reported lane has no cost and no page), enforceable
budgets, prompt/model governance in one place, capture (§9.3), key custody in the kernel instead
of on N machines, and OpenRouter as an actually-implemented second provider instead of a dead
enum value.

### 9.2 AI features as kernel services

The deeper move: prompt assembly relocates from clients into the kernel. Today the desktop and
extension each hold a prompt library, context loaders, model registries, and cost tables — the
same product logic, drifting independently, computing over partial local caches (review §8). In
the target a client calls a *feature*:

```
POST /ai/features/fast-reply   { conversationRef, tone?, draft?, personaId? }
```

and the kernel loads context from its own projections (transcript, spend, subscription, fan
summary — it has them all now, §3), assembles the prompt from the versioned kernel prompt
library, streams the completion, and records everything. Clients keep UI, hotkeys, insertion,
and human-action gating (the "AI never sends without explicit human action" invariant stays
client-side where the action is).

Two hard rules carry from the desktop's discipline: **prompts migrate byte-for-byte** (they are
tuned production assets; the anti-slop tuning is the value), and the escape/sanitize pipeline
(`escapeForPrompt`, safety preamble, output sanitizer) moves with them as a unit with its
regression tests. Per-feature model/effort/temperature tables become kernel config, editable per
org — not per machine.

### 9.3 Capture classes (→ DP 6)

The gateway captures, per generation: full prompt blocks, completion, model/params, token usage
and cost, feature, principal, conversation ref — and, closing the loop, the client-reported
**acceptance signal** (shown → inserted → edited → sent), today deliberately stripped on the
desktop wire. This is the training-and-evaluation dataset for the product's own core loop
("did the suggestion get used?") and the highest-value capture in the system after money. It is
also chatter/fan content, so it lands in a **restricted access class**: separate table
partition, owner-grant-only read path, excluded from general analytics exports by default,
erasure procedure applies. Whether to capture full content, or metadata + acceptance only, is the
owner's privacy fork — DP 6; the plumbing above supports either answer.

### 9.4 Usage ledger

One `ai_usage` ledger, gateway-authoritative: cost computed kernel-side from one pricing table
(micro-USD, §5.3). The client-reported batch lane and its lossy retry policy die with direct
mode. The workboard closing classifier (today a direct Anthropic SDK call bypassing the gateway —
verified) becomes an internal gateway consumer under the same ledger, budgets, and routing.

---

## 10. Userspace

### 10.1 Desktop (ChatGoose Desktop)

**Role: the OnlyFans chat workspace — a pure kernel client.** Keeps: its custody model
(SQLCipher, keychain, media token indirection), its outbox/verifier discipline, its SSE
consumption, its UI. Changes:

- **Local SQLite is a cache, by contract.** Pruning (5,000/chat, 31 days) becomes harmless
  because the kernel holds history; "backfill more" is an SDK call, not a loss. One-time note
  for Pass 3: today's local DBs hold facts core never captured — harvest before pruning (§14).
- **The hoard uploads.** Acceptance telemetry, guard-audit events (with text), send audit,
  AI/credit spend ledgers enter the client-capture lane (§3.3) on a durable spool.
  `cmd:data.purge` wipes the device, not the record.
- **Direct OFAPI read mode is removed** (→ DP 8). The transport enum collapses to `hub` for
  reads as it already did for writes. Break-glass access to OFAPI during a kernel outage is an
  ops runbook with the team key, not a client feature that bypasses tenancy.
- **AI via kernel features** (§9.2). The local prompt/cost/model machinery retires; dock UX stays.
- **Kernel-worthy shared logic moves home**: spender tiers, activity math, cost tables migrate
  into kernel modules (finance/audience/ai) and come back through the SDK — one answer on every
  machine.

### 10.2 Extension (ChatGoose, Fansly — Firefox MV3)

**Role: the Fansly in-page surface + the kernel's Fansly capture agent** (→ DP 1, DP 3). The
extension is architecturally inverted today — it observes the richest unobserved data source and
persists nothing (review §8) — but its code is well-contained and its custody is correct. Target:

- **Capture-through**: every Fansly REST response it fetches is mirrored to
  `POST /ingest/observations` (batched, spooled, fail-open — never blocking the chatter's UI).
  Credentials do not move; data does. Custody stays memory-only exactly as built.
- **Consumes the kernel**: AI via kernel features (its user-held vendor keys retire); fan
  summaries read/written through the kernel (already true); the spenders board becomes a kernel
  query (`finance` module) instead of a ~150-call Fansly rebuild per creator per 10 minutes —
  quota spent once, in the kernel, incrementally.
- **Keeps**: DOM integration (the 165-line contained fragility), toolbar/panel/overlay UX,
  hotkeys, personas (which move to kernel config so they stop being device-local).
- Its longer-term fate — indefinitely maintained surface vs. absorbed into the workboard app once
  that ships Fansly chat — is a product call: DP 3.

### 10.3 Workboard (the chatter application)

**Role: the standalone multi-user app where chatters log in and work their assigned models**
(→ DP 4 for shape, auth, and access grain). Kernel side:

- The `workboard` module serves board reads/mutations for **all platforms** (the v2
  compute-but-can't-serve OnlyFans split is deleted; v1 retires; the pure 822-line engine
  transfers intact).
- **Event-driven freshness**: domain events (message.received, transaction.posted,
  subscription.*, presence.*) enqueue debounced per-fan recomputes; the nightly full sweep
  remains as reconciler. The board reflects reality in seconds, not at 03:00 UTC (the review's
  "up to 24 h behind" finding).
- **Attribution + collaboration primitives**: contact log carries the acting principal (§7.3);
  undo is a compensating event; soft **claim leases** ("I'm working this fan") prevent two
  chatters colliding on one fan — a new small table, event-logged.
- Chatters authenticate as first-class humans (§7.1) with model-level grants (§7.2); every
  workboard read/write is grant-scoped by the same middleware as everything else (§6.2).
- App shape (SPA in core repo vs. own repo; served origin; session vs. IdP) — DP 4.

### 10.4 Dashboard

**Role: the owner/team-lead console** — catalog, credentials, config, sync health, credits,
finance reporting, user/grant admin. It sheds chatter workflows (workboard tabs move out) and
polling (consumes the event stream, §6.5). It remains in core's repo, served same-origin, on the
same SDK as everyone else.

---

## 11. Analytics as a product

The lake (§5.1) is the product surface, not a byproduct:

- **Contents**: monthly-partitioned Parquet of `observations` (tiered), `domain_events`, and
  snapshotted projections (transactions, fan spend, subscriptions, presence samples, workboard
  actions, AI usage). Partition layout `plane/table/year/month`.
- **Engine**: DuckDB over the lake as the default query engine — zero-ops, agent-friendly (an
  AI analyst session is `duckdb` + `SELECT`), fast at 100 GB scale. A standing warehouse
  (ClickHouse) is a documented graduation path when concurrent interactive dashboards demand it;
  the lake format is the durable asset either way, which is what makes the engine a two-way door
  (§13.4).
- **Metrics layer**: versioned SQL models in `core/analytics/models/` (plain SQL + a thin
  runner; dbt-style discipline without the framework) defining the canonical metrics — LTV,
  cohort retention, net revenue by page/model/day, chatter response SLAs, AI acceptance rate,
  spender lifecycle. Dashboard reporting, Telegram digests, and future products read *these
  definitions*, not ad-hoc handler SQL (the ~180-line inline `/overview` aggregation dies here).
- **What the accumulated data unlocks** (the point of capture-first): per-fan LTV curves and
  churn prediction (transactions + subscription lifecycle events), chatter performance and
  coaching (attribution + acceptance + response times), pricing analytics (PPV order history —
  captured for the first time via DP 1), presence-timed outreach (presence event series), prompt
  A/B evaluation (DP 6 content + acceptance). None of these require new capture once §3 lands —
  that is the test the current architecture fails and this one passes.

---

## 12. Repository & documentation standard

One standard across core, desktop, extension (and the workboard app wherever DP 4 puts it), so
the family reads as one product built to one bar. Designed for the stated future: **most
engineering is done by AI coding agents**, so the standard optimizes for orientation speed,
verifiable freshness, and machine-regenerable depth.

### 12.1 Repo skeleton (every repo)

```
README.md              # thin: what this is, how to run, where docs live
CLAUDE.md              # THE agent context file (see 12.3)
AGENTS.md              # one line: "Read CLAUDE.md." (anti-drift pointer)
docs/
  decisions.md         # numbered, append-only decision log + quick-ref table (core's format)
  specs/               # hand-curated, deliberately thin (PRD/SPEC class)
  generated/           # machine-generated maps & references — regenerated, never hand-edited
  prompts/             # the prompts that generate docs/generated/* (the Pass 1 pattern)
apps/  packages/  scripts/  tests/
```

### 12.2 Documentation taxonomy — three classes, three rules

| Class | Examples | Rule |
|---|---|---|
| **Hand-curated, thin** | README, CLAUDE.md, PRD/SPEC, decisions.md | Kept current *in the same change* that invalidates them (the desktop's discipline, now family law). Small enough that this is cheap. |
| **Machine-generated** | System maps (Pass 1 style), API reference, route/policy tables, schema catalog | Carry a banner: generation date + the command/prompt that regenerates them. Never hand-edited; regenerated on a cadence and after structural changes. Stale-by-date is visible, so trust is calibrated. |
| **Decision log** | `docs/decisions.md` per repo; cross-repo decisions live in core's and are referenced | Append-only, numbered, quick-reference table at top. Supersession is a new entry pointing back, never an edit. |

**Anti-deletion rule** (the family has a knowledge-deletion habit — the review documents
irrecoverably lost audit and design docs): removing or superseding any doc requires a tombstone
entry in `decisions.md` saying what was removed and why; deprecated specs get a banner, not
deletion. Generated docs are exempt (they regenerate).

### 12.3 Agent context files

Every repo carries a CLAUDE.md to the standard the desktop already set (it is the family's gold
standard and spot-checks clean — keep its shape): what this repo is in one paragraph; a
doc-routing table ("read X before doing Y"); hard rules **with rationale**; conventions; the
check command. Core's current state — 632 files, the money, no CLAUDE.md, conventions living in
one person's memory files — is the inversion to fix first. AGENTS.md is always a pointer, never
content (drift prevention). Session-runbook docs (the desktop's SESSIONS.md) are recommended
where multi-session work is the norm.

### 12.4 CI & toolchain standard

- **Every repo, every PR**: typecheck + lint + unit + build. (Desktop today: zero PR CI while
  shipping auto-updates. Extension: check only. This is the floor, not the ceiling.)
- **Core additionally**: full integration suite (Testcontainers) nightly + on release branches;
  the sync-critical subset on PR. The `--testNamePattern` allowlist drift problem is retired by
  tagging (`describe.concurrent` groups or explicit `@critical` tags) instead of name-matching.
- **Projection-rebuild proof**: CI rebuilds every projection from ledger fixtures (§5.2).
- **Lint as architecture enforcement** (the desktop's invention, family-wide): module-boundary
  imports, money-constructor bans, egress-context requirement, no-`platform ===` outside
  adapters, no direct vendor-SDK imports outside the gateway.
- **Toolchain harmonized**: one pinned pnpm, one TypeScript major, one vitest major, ESLint
  everywhere, tsconfig at the desktop's strictness (`strict` + `exactOptionalPropertyTypes` +
  `noUncheckedIndexedAccess`) — core is currently the weakest-typed repo in the family and the
  most critical, which is exactly backwards.
- **Extension repo migrates** from npm/commonjs to the family standard (pnpm, ESM) at its next
  natural rework (two-way door; timing is Pass 3's).

### 12.5 Cross-repo contract sync

Core publishes `@kernel/sdk` (§6.3) with a contract hash; each client repo pins a version and CI
fails on drift against core's main (a scheduled bump-PR flow keeps clients current). The
committed-OpenAPI-snapshot-plus-eyeballs convention retires. Fixture flow (the OFAPI webhook
fixtures the desktop repo captures and core consumes) becomes a versioned package instead of a
cross-repo file copy.

---

## 13. Alternatives weighed

Each major choice, its serious alternative, and why it lost. (Forks that are *product* calls are
in the unretained `decision-points.md`; these are the engineering calls I am making.)

1. **Event-sourced ledger vs. state-first with better retention.** The modest alternative —
   keep today's mutable tables, raise retention windows, add missing capture tables — was
   rejected on the regret test: it leaves every future fact-loss a policy accident away (the
   current system *is* this design, executed well, and it produced an F in capture); it cannot
   re-derive from raw when parsing improves (tips); and it makes multi-producer dedup ad hoc
   forever. The ledger costs projector discipline and ~75 GB/year of cheap storage (§3.4); it
   buys rebuildability, provenance, replay, and an analytics substrate. Not close.
2. **Postgres-as-ledger/bus vs. Kafka (or Redpanda/NATS).** Kafka's win is throughput and
   ecosystem at volumes this system will not see (≤ millions of small events/day even at 10×);
   its cost is a second stateful system, new failure modes, and agent-hostile ops. Postgres
   partitioned append-only tables + LISTEN/NOTIFY + pg-boss already implement the needed
   semantics and are proven in this codebase. Two-way door: the ledger schema is
   transport-agnostic; a bus can front it later without rewriting producers.
3. **Modular monolith vs. microservices.** Services would decouple deploys the team doesn't
   have and add network seams through what is naturally one transactional domain (capture →
   canonicalize → project). For AI-agent engineering, one repo/one process with lint-enforced
   module walls is strictly easier to hold in context. The event stream and SDK are the two
   places a future split would cut; both are designed as clean seams, so extraction later is a
   two-way door.
4. **DuckDB-over-Parquet lake vs. standing ClickHouse warehouse.** ClickHouse wins at high
   concurrent interactive analytics; it loses on ops weight for a team of ~1 + agents, and
   nothing in the near product needs sub-second dashboards over TB. The Parquet lake is the
   durable asset; DuckDB is a zero-ops query head on it; ClickHouse remains a documented
   graduation path reading the same lake. Choosing the lake *format* is the one-way-ish part and
   it is the part being chosen carefully.
5. **Per-account event ordering vs. keeping one global sequence.** Global `fanout_seq` is
   simpler and proven but is *the* structural singleton (verified: asserted single replica +
   advisory lock). No consumer needs cross-account order — every client is page-scoped. Losing
   global order costs a slightly richer resume token; it buys horizontal capture.
6. **Generating the SDK from Zod contracts vs. fixing OpenAPI codegen.** The OpenAPI route
   (fix `$ref` emission, then openapi-typescript + a fetch wrapper) stays standards-pure but
   fights the Zod-Fastify inliner and still yields types without runtime validation. Generating
   directly from `routeSchemas` reuses the schemas as validators in clients (the desktop already
   zod-validates every hub response by hand — this automates the existing best practice).
   OpenAPI stays as a published artifact, so external consumers lose nothing.
7. **One OnlyFans vendor vs. two.** Argued at DP 2 (product/cost dimensions belong to the
   owner); the engineering half of the argument is in §4.2: no provenance column + no
   exclusivity gate means dual-feeding the same table is unreconcilable today, and the adapter
   seam plus provenance makes single-vendor reversible.
8. **Micro-USD everywhere vs. keeping mills.** Mills are entrenched (decision #15, all
   reporting) but cannot represent AI costs (hence today's third unit) — any "one unit" outcome
   that keeps mills still carries micro-USD somewhere, i.e., keeps the zoo. Micro-USD spans both
   domains in bigint range (a $10 M lifetime is 10^13, comfortably inside int64), the migration
   is a mechanical ×1000, and the constructor-naming rule kills the footgun class either way.
   The runner-up (mills + micro-USD with strict suffixes and no floats) is acceptable if Pass 3
   finds the migration blast radius unjustifiable — flagged there, not silently decided.
9. **Kernel-side AI feature services vs. client-side prompt assembly through a dumb proxy
   gateway.** The proxy-only gateway (today's design) preserves client flexibility but leaves
   prompt libraries, cost tables, and context assembly duplicated per client and forever
   drifting, and it can only capture what clients choose to send. Feature services centralize
   the product's most-tuned asset and make capture structural. Cost: the kernel must hold all
   context — which §3 delivers anyway; and offline/latency independence — lost with direct mode
   regardless (DP 5).
10. **pg-boss vs. a dedicated queue (BullMQ/Redis, SQS).** pg-boss keeps the
    one-stateful-system property, supports the group-serialization the design leans on, and is
    proven here. Redis-class queues buy latency the workloads don't need and add a dependency.
    Two-way door behind the job-enqueue seam.
11. **Extension as capture agent vs. kernel-only Fansly sync (no extension capture).**
    Kernel-only keeps the extension simplest but leaves capture hostage to the pasted-session
    freshness problem and forgoes free observations of exactly the conversations being worked.
    Capture-through costs a batched upload path and dedup (already required for multi-producer
    OnlyFans). The custody-sensitive variant — automating session provisioning to the kernel —
    is deliberately left unspecified (§4.1 note); capture-through does not depend on it. → DP 1.
12. **Workboard as kernel module + SPA vs. separate service with its own store.** A separate
    service would re-create the client-side-compute problem one level up (its own cache of
    kernel data, its own drift). The engine is pure and the data is all kernel data; it is a
    module and a thin app. → DP 4 for the app's shape and auth.

---

## 14. Inputs for Pass 3

What the roadmap will need from this document's world, and the facts on the ground it must
respect. (No sequencing here — inventory only.)

**Perishable data — the clock is running.** Facts that exist today and are being actively
destroyed; Pass 3 should treat stopping these losses as its own early workstream, sequenced
however it judges safe:

| Perishable store | What's being lost | Mechanism |
|---|---|---|
| `ofapi_webhook_events` | Raw OnlyFans events incl. money events | Deleted at 7 days unconditionally, daily 02:30 UTC |
| `page_dm_messages` | All-platform DM history beyond 200/1,000 per conversation; **for Fansly this is the only copy** | Pruned on every sync finalize / webhook refresh |
| `sync_raw_payloads` | Raw platform responses | 180-day / 7-day (DM) hard delete |
| Desktop local SQLite (per machine) | Messages >5,000/chat; transactions >31 days; acceptance telemetry (3-strike upload deletion); guard audit (90-day TTL); one-click `data.purge` | Local pruning + lossy upload policy |
| `ofapi_commands` payloads | What chatters actually sent | Self-redaction 7 days after terminal state |
| Extension `storage.local` | Fan summaries not yet pushed (best-effort push) | Eviction + persona-deletion cascade |
| `workboard_contact_log` / classifier verdicts | Contact history / paid L2 verdicts | Hard-delete on undo / wholesale delete on reclassify |

**Recoverable-at-cost backfills** (possible once, before or during migration): OnlyMonster
transaction history (vendor retains history; refetchable while the account lives), OFAPI REST
message/transaction history (credit-metered), Fansly message backscroll via `before`-cursor
pagination (session-authenticated; the extension proves unbounded depth works), desktop local DBs
as a one-time harvest source for messages/transactions/telemetry core never saw.

**Unrecoverable** (gone; the roadmap should not chase them): webhook journals older than 7 days,
DM history already pruned where no REST backfill exists, discarded gateway read bodies, direct-AI
prompts/completions to date, presence history (only latest-state survives), assignment history.

**Compatibility invariants during migration** (contracts real clients depend on today):
the SSE `sync` frame union + `Last-Event-ID`/409-snapshot protocol (desktop pins it); the command
outbox intake semantics (dedup key, 200/202/409); chatter bearer keys (`agency_hub_core_` prefix)
until device tokens replace them; the fan-profile PUT/GET pair (extension + desktop); the
read-gateway path shape while it exists; desktop auto-update feed continuity.

**Ground-truth checks Pass 3 must make at execution time** (state drifts): production values of
the staged-flag graph (capture flags were default-off at review time; the enablement runbook has
been flipping them one by one); actual OFAPI transaction/fee payload shapes (vendored
`openapi.json` in the desktop repo is the reference); current OnlyMonster dependency surface;
whether any OnlyFans pages are dual-fed (the ping-pong hazard) before enabling OFAPI truth
ingest.

**Decision dependencies.** The roadmap cannot start until DP 1–DP 10 are answered; DP 2
(vendor), DP 5/6 (AI plane/capture), and DP 9 (tenancy root) gate schema decisions and should be
answered before any migration DDL is written; DP 4 (workboard shape) gates the identity work;
DP 10 (repo topology) gates where the SDK and workboard app land.

---

*End of target architecture. The forks are numbered and argued in
the unretained `decision-points.md`; nothing above should be read as closing them.*
