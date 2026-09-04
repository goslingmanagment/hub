# Workboard v2 — Priority System Design

> **Status:** retained design authority for existing Workboard v2 code and
> schema. The in-core product direction is deprecated by Decision #117; do not
> treat unimplemented sections as roadmap or approved work.
> **Unit convention:** all money in **mills** (`1 mill = $0.001`; `$100 = 100 000 mills`). Use `dollarsToMills` / `formatUsdFromMills` (`packages/shared/src/money.ts`). In formulas, `$x` means `mills/1000`.
> **Operates per model *page*** (`platform_account`), not per model. A model has several pages; cross-page anti-spam is a first-class concern.

This document specifies the algorithm (value, urgency, conversation quality, lifecycle, freeloader, closing-detector), the per-workflow playbooks, the data/API additions, the UX + color system, and a staged rollout. The engine is a synthesis of three competing designs, judged and red-teamed; design rationale is inline where it matters.

---

## 1. Design principles (non-negotiable)

1. **Four separate books of business, never one mixed feed.** `Subscribers · Spenders · Fresh mass · Old mass` are physically separate queries/lists. A fifth **Service** tab explains who is *not* in the queue and why.
2. **SLA ≠ global priority — by construction, not by tuning.** "Fan wrote last" can only re-order rows *inside one tab* (a `Need reply` status). It can never reach across tabs. A mass fan's "hi" lives in the Fresh/Old tab and is structurally incapable of appearing above a renew-off subscriber, who lives in a different list. This is guaranteed because **rankScore is only ever compared within a single tab** — there is no global merge step.
3. **Two stored axes, computed separately: Value and Urgency.** Value = "who matters" (slow-moving). Urgency = "why today" (fast-moving). They are stored as two numbers and only combined at the last step, only within a tab. This makes every row explainable ("high value, expiring tomorrow") and drives the UI directly (Value pip + Urgency bar + one "why now" line). No scary `0–100` is ever shown.
4. **A purchase is the strongest cross-cutting trigger.** Any settled purchase floats the fan to the top of their *current* tab, can move them between tabs, and outranks ordinary `Need reply`.
5. **A reply only counts if it needs a reply.** A two-layer closing-message detector keeps "ok / thanks / 😘" out of `Need reply`.
6. **A "hi" is visibility, not a priority lift.** Mass lifecycle (Fresh→Gray→Active→Dead) is automatic; promotion to "Active" needs *conversation evidence*, not a one-word ping.
7. **Old mass is residual.** It runs under a daily cap so it can never crowd the three priority books.
8. **Sparse data must announce itself.** The 25-message DM window, partial coverage, and Fansly's `unknown` sender role all degrade conversation signals — every derived claim carries a confidence marker and is damped toward neutral when thin.

---

## 2. Architecture: the Cartesian Board

Every fan is a point on a 2-D plane and a node in a lifecycle state machine.

```
        URGENCY  (why TODAY — fast, event-driven)
           ▲
   high V  │   ┌─────────────┬─────────────┐
   high U  │   │  steady care │  ACT NOW    │   ← top-right = valuable AND urgent
           │   ├─────────────┼─────────────┤
   low V   │   │  ignore/cap  │  reply/clock│
   low U   │   └─────────────┴─────────────┘
           └─────────────────────────────────▶  VALUE (who matters — slow)
```

- **`value_score` ∈ [0,100]** and **`urgency_score` ∈ [0,100]** are computed per `(page, fan)` and **persisted** on a `workboard_state` row (see §10). Persisting them (rather than re-deriving from the fragile 25-message tail on every read) is what makes the board **degrade gracefully on sparse data** and **not flap**.
- The **four tabs are the four lifecycle states** of an FSM; a fan is in exactly one tab. Transitions are event-driven and auditable (§8).
- **Ranking happens strictly inside a tab:** sort by urgency, weighted/broken by value (§7). The Service tab is status-only (not ranked).

> **Why two axes beat a single score (the judged decision).** Against an expected-value/"dollars-per-touch" engine and a pure cadence-decay engine, the two-axis + FSM model scored highest on fidelity, robustness, and legibility (44/45 vs 38 and 34). A single blended number (a) collapses the two decisions a chatter actually makes — *when* and *how much* — and (b) becomes fragile when a sparse conversation signal multiplies a real whale's score down. Separated, stored axes let a thin-data whale still rank by Value while Urgency is hedged. We then **grafted** the best of the other two engines: continuous **clock-bending** for the cadence/urgency ramp (from the cadence engine) and **velocity-over-LTV value economics** (from the EV engine). See §3–§4.

---

## 3. The Value axis — "who matters"

`value_score ∈ [0,100]`, recomputed nightly, nudged by events. Per-page LTV only (a per-page board uses per-page spend; never cross-page money).

Four components, each pre-clamped to `[0,1]`:

**(1) Realized LTV — log-normalized and recency-decayed.**
Spend is heavy-tailed, so a log keeps a $5 000 whale from being 50× a $100 fan on a linear scale; a recency decay keeps a *dormant* whale from sitting at the top forever.
```
L$        = fan_spend_lifetime.creator_net_amount_mills / 1000
Ln_raw    = ln(1 + L$) / ln(1 + LTV_REF$)              # LTV_REF$ = 1000  →  $1000 ≈ 1.0, $100 ≈ 0.67, $10 ≈ 0.35
ageDays   = days since last settled transaction
recencyMult = 0.5 + 0.5 * exp(-ageDays / 120)          # half-life ≈ 83d, floors at 0.5 (a real whale never zeroes)
Ln        = Ln_raw * recencyMult
```

**(2) Spend velocity / run-rate — rewards momentum (the chatter's lever).**
```
sN$       = sum settled creator_net in last N days / 1000     # exclude chargeback/refund/payout_reversal
r$        = max(s30$/30, s90$/90)                              # $/day; use the higher so a fresh spike isn't diluted by an old cold stretch
velBase   = clamp01(r$ / VEL_REF$)                            # VEL_REF$ = 5  →  $5/day sustained = 1.0
typeTilt  = clamp(0.8 + 0.6 * alaCarteShare90d, 0.8, 1.4)     # PPV/tip/post/stream share of 90d net; à-la-carte spend converts from DM, weight it up
Veln      = clamp01(velBase * typeTilt)
```

**(3) Tier / price — structural worth.** A $50/mo tier sub is more valuable to save than a $5 one even at equal LTV.
```
Tiern = clamp01(price$ / TIER_REF$)    # TIER_REF$ = 50; price$ from page_subscriptions.priceMills (fallback renewPriceMills). Non-subscribers: 0
```

**(4) Potential — a cold-start floor** so a brand-new high-tier sub / fresh follower isn't invisible at V≈0.
```
Potn = (L$ < 20 AND (isSubscriber OR followerSince within 14d)) ? 0.5*Tiern + 0.25 : 0
```

**Blend + flags:**
```
V = 100 * clamp01( wL*Ln + wVel*Veln + wT*Tiern + wP*Potn ) + flagBonus,   clamp [0,100]
wL = 0.35,  wVel = 0.35,  wT = 0.20,  wP = 0.10
flagBonus (fan_flags, global): whale +20, vip +12, risky -15   # risky lowers value (don't over-invest in chargeback risk); it does not zero them
```

> **Synthesis note — velocity vs LTV weighting.** The EV engine argued "weight run-rate *above* LTV" to avoid over-rewarding dead whales. We achieve that goal two ways at once: the **recency decay on LTV** already discounts dormant whales toward a 0.5 floor, *and* velocity is given equal weight to (already-decayed) LTV. We deliberately do **not** over-rotate to velocity, because the Urgency axis (`U_purchase`) already rewards the acute "just spent" moment — putting all the momentum weight in Value too would double-count it.

**Value confidence:** `high` if a lifetime row exists and ≥1 daily-spend row in 90d; `low` if `L$=0` with no daily rows (pure follower). Low-confidence Value renders with a hatched pip (§12).

**Value tier (for the UI pip), page-relative percentiles with a hard $ floor:** `whale` (top ~2% / $ floor) · `vip` (top ~10%) · `payer` (any real LTV) · `new` ($0). See calibration note §15.

---

## 4. The Urgency axis — "why today"

`urgency_score ∈ [0,100]`, recomputed nightly **and event-patched** on every purchase/inbound-message webhook. Urgency is the combination of six independent **drivers**, each of which also emits a short `whyNow` string; the **winning (argmax) driver's** string is what the row shows.

### 4.1 The six drivers

**(1) `U_purchase` — strongest cross-cutting trigger. Settlement-aware.**
Only fires on a **settled, still-active** earning transaction (`state=posted`, `isActive=true`, `canonicalType ∈ {subscription, tip, message_purchase, post_purchase, stream_tip}`, `net>0`). Chargeback/refund/payout_reversal never raise urgency (they raise a Service cooldown, §8).
```
h = hours since occurredAt
U_purchase = 95 * exp(-h / 36)            # half-life ≈ 25h: ~95 @0h, ~60 @24h, ~22 @72h, floor 0 after PURCHASE_FOLLOWUP_DAYS = 3
big buy (net ≥ $50): * 1.05  (cap 100)
```
This is the **only** driver allowed to exceed the SLA cap.

**(2) `U_expiry` — the renewal save (Subscribers only). Continuous, no day-boundary flapping.**
Piecewise-**linear interpolation** through anchor points (continuity is the graft from the cadence engine; it kills v1's step-band flap at midnight), evaluated on a **business-day boundary** (§9):
```
d = businessDaysUntil(subscriptionExpiresAt)        # computed at startOfBusinessDay, UTC-pinned
base = interp(d through {1:88, 3:78, 5:66, 7:54, 10:40, 14:28, 21:16, >21:0})
U_expiry = clamp(100, base * autoRenewMult)
autoRenewMult: false → 1.12   (renew-OFF is the real save target)
               null  → 1.05   (unknown)
               true  → 0.80   (will rebill anyway)
```
A renew-off sub at `d=2` → `interp≈83 × 1.12 ≈ 93`. (The intensify-before-expiry ladder lives here, not in cadence.)

**(3) `U_sla` — within-tab `Need reply`. NEVER global.**
Fires only when `needs_reply` is true (`lastMessageSenderRole='fan'` AND the tail passed the closing-detector, §6). Logarithmic: fast initial rise, then saturating.
```
h = hours unanswered (now - lastFanMessageAt)
U_sla = min(SLA_CAP, 30 + 22*ln(1 + h/6)) * openerDamp
SLA_CAP = 80
```
**The cap is the structural SLA guarantee:** `SLA_CAP(80) < U_expiry@1d(≈88) < U_purchase@0h(95)`. A waiting "hey" can lead its *own* tab but a fresh purchase or imminent expiry always outranks it — and because tabs are separate lists, a mass "hi" never even appears next to a subscriber.
`openerDamp ∈ [0.5,1]` decays the boost for **repeated low-content openers from the same fan** (anti-farming, §6/§14): each consecutive unanswered one-word opener (`hi`, `you up?`) without an intervening real exchange multiplies by 0.7 (floor 0.5).

**(4) `U_cadence` — the neglect floor, with clock-bending.**
Per-tab target interval `T_cad` (§7.5), **bent by conversation heat** (graft from the cadence engine: a hot 1:1 chat deserves a faster rhythm; a model-forced monologue a slower one):
```
T_eff   = T_cad * H_cq,   H_cq = 1 - 0.45*Q_eff        # Q_eff=+1 → 0.55× (come back fast); Q_eff=-1 → 1.45× (back off); neutral → 1×
over    = daysSinceContact - T_eff                     # daysSinceContact from the touch log (§11), backstopped by max(lastModel,lastFan)MessageAt
U_cadence = (over < 0) ? 0 : min(CAD_CAP, 20 + 6*over) # linear after threshold
CAD_CAP: subscribers 60, spenders 70, fresh 45, old 30 # old capped low so cadence there never crowds other tabs
```

**(5) `U_presence` — opportunistic, freshness-gated.** Best-effort only; never a reason to abandon a renewal.
```
U_presence = (observedFresh AND NOT presenceFeedTruncated) ?
             (externalPresenceAt ≤30min → 35 ; ≤120min → 20 ; else 0) : 0
observedFresh = externalPresenceObservedAt within 30 min   # red-team: stale/truncated presence must not reorder rows
```

**(6) `U_reactivation` — the Dead one-shot.** `25` for a 7-day window when a Dead fan crosses the sleep boundary (§8).

### 4.2 Combining drivers — dominant + capped bonus

Pure `max()` is the most legible ("U=90 means something is ~90 urgent") but under-ranks a fan with several medium reasons. Pure sum lets small things pile into a false alarm. We use **dominant-plus-capped-bonus**:
```
U = clamp(0, 100,  maxDriver + min(BONUS_CAP, 0.25 * sumOfOtherDrivers))
BONUS_CAP = 8
whyNow = argmax driver's string
```
The `+8` cap means two genuine medium signals (e.g. expiring-soon **and** waiting) get a real lift over a single slightly-higher signal, but no combination can leap a full severity tier — so purchase/expiry dominance is preserved. (This patches the winning engine's self-identified "lossy max()" weakness without re-introducing summation blow-ups.)

**Urgency confidence:** if DM `messageCoverageStatus='pending_backfill'`, the `U_sla` driver is capped at 50 (we may be missing the true last sender) and the row is marked low-confidence.

---

## 5. Conversation-quality modulator (Q)

`Q ∈ [-1, +1]` is **neither value nor urgency** — it is a modulator that (a) **gates** FSM transitions (Gray→Active needs real-talk evidence), (b) **bends the cadence clock** (`H_cq`, §4), (c) applies a small **±15% lever** on within-tab rank, and (d) feeds the **freeloader** counter. Built from `page_dm_threads` + the ≤25 stored `page_dm_messages`, always with a coverage marker.

```
m = model-msg count, f = fan-msg count over the stored window

Rq (ratio health; ~1:1 ideal, model-skew = chatter forcing it → penalized):
   ratio = m / max(f,1);  Rq = clamp(1.2 - 0.5*|ln(ratio)|, -1, 1);  floor fan-heavy at +0.7  (fan over-talking is never bad)
Iq (initiator; fan-first = strongest "this is real"):  fan-first +1 · model-first -0.3 · unknown 0
Lq (who wrote last — texture, not priority):  fan +0.3 · model -0.1 · closing-tail -0.3
Hq (latency; fast = hot):  ≤1h +1 · ≤6h +0.6 · ≤24h +0.2 · ≤72h -0.2 · >168h(weekly) -0.6

Q = clamp(0.35*Rq + 0.30*Iq + 0.10*Lq + 0.25*Hq, -1, 1)
```

**Sparse / partial / unknown-role handling (the key robustness rule):**
```
Q_eff = Q * qDamp * roleDamp
qDamp:  (coverage='complete' OR storedMessageCount ≥ 6) → 1.0
        storedMessageCount 2–5                         → 0.5
        storedMessageCount ≤ 1 OR 'pending_backfill'   → 0.0      # a lone "hi" yields Q=0: visibility, no lift
roleDamp: 1 - 0.6 * (share of stored msgs with senderRole='unknown')   # Fansly often returns 'unknown'; never compute a "clean ratio" over unknowns
```
> **Red-team fix — Fansly `unknown` sender role.** Fansly frequently returns `senderRole='unknown'` (system msgs, tip-carrying msgs, null partner). Two guards: (1) `roleDamp` shrinks Q when a material share of the window is unknown; (2) if the **tail** is `unknown` *and* the thread is unanswered, the row is routed to a **"needs human triage"** marker inside its tab rather than silently excluded from `Need reply` (so a real question that arrived as an unknown-role message is never buried). A per-thread `roleConfidence` is stored separately from `messageCoverageStatus`.

`Q_ACTIVE = 0.2` is the promotion threshold (Gray/Fresh → Active) and requires `qConfidence ≥ medium` **and** ≥2 non-closing fan messages.

---

## 6. Closing-message detector (gates `needs_reply`)

```
needs_reply = (lastMessageSenderRole = 'fan') AND NOT isClosing(tail)
```

**Layer 1 — hard, multilingual, exact-match (always, synchronous, free).** Applied to every fan-last thread in the nightly TS/SQL pass. Lowercase-trimmed full-string match (not "contains"), allowing a short combination and punctuation/emoji suffix:
- EN: `ok, okay, k, kk, thanks, thx, ty, tysm, gn, gm, bye, cya, np, yw, lol, lmao, cool, nice, alright`
- RU: `спасибо, спс, пока, ок, окей, ладно, хорошо, споки, доброй ночи, ага, угу, понял, ясно`
- Lone-emoji rule: content stripped of whitespace is 1–3 emoji and no letters → closing (`🙂 😘 ❤️ 👍 😍 🥰 😻 …`).
Match → `needs_reply=false`. Catches the obvious majority cheaply and deterministically.

> **Bare affirmatives are deliberately NOT in L1** (`yes, yeah, yep, yup, sure, да, давай`). Context-blind they read as acks, but after a sales prompt ("прислать видео?") they are a **conversion**. L1 cannot see the prior line, so it must not suppress them — the context-aware L2 judges them (→ `buy_signal`) instead. Only high-precision acks that almost never answer a sales question (`ok, ладно, ага`) stay in L1.

**Layer 2 — Haiku 4.5 classifier, async, surgical, _context-aware + semantic_.** Runs **only on the tail of threads unanswered > 24 h** that L1 did not decide. (Fresh <24h messages default to `needs_reply=true` so the chatter gets a chance to answer on time; most threads are either answered within a day or caught by L1 — so L2's volume is small.)
- **Reads the conversation, not the tail in isolation.** Each candidate is sent as the last ≤10 messages with roles (`fan`/`creator`), so "yes" after "want me to send it?" resolves correctly.
- **Semantic output**, not just a boolean: `state ∈ {buy_signal, question, complaint, smalltalk, cold, closing}` + `needs_reply` + a short `reason`. This feeds **both** the closing detector **and** the Urgency axis (§4) — a fresh-read `buy_signal` (90) sits just under a purchase and above the SLA cap; `complaint` (85) is high; a `cold` tail that still "needs a reply" is damped (×0.5 SLA) so age alone can't float it.
- **Model:** `claude-haiku-4-5` (per-page overridable).
- **Bulk:** ~15 conversations per request, JSON array `[{id, state, needs_reply, reason}]`, sync Messages API; nightly pg-boss job `workboard:classify-closing`.
- **Permanent per-message cache** keyed by `(platformMessageId, contentHash)` where `contentHash = hash(context+tail)` — a stale >24h tail's context doesn't change, so the verdict is reused; `state` + `reason` are persisted and surfaced in the "Детектор ответа" panel.

**Cost-and-cap mechanics (own tables):**
- **Adaptive daily cap** per page: `cap = clamp(0.5 * dailyUnansweredTailCount, capMin, capMax)`.
- **L2 spend priority:** Subscribers → Spenders → Fresh → Old, so the highest-value tails are classified first.
- **Over budget ≠ API error:** *over budget* → defer to the next run (do **not** flip to `needs_reply`). *API error* → stop, leave uncached, retry next run. Only a **genuinely-unclassified tail at cap** defaults to `needs_reply=true` — tagged **`unverified`**, ranked **below** classifier-confirmed `Need reply`, shown with a "не проверено" chip (§12.4).
- **Dead/archived/service fans are not classified.**

**Expected cost:** Haiku 4.5 = **$1/M input, $5/M output**. Even context-aware (~$0.0004/classified message) and with the permanent cache, on the order of **$1–3 per page per month** — cost is not the binding constraint; the daily call cap (latency to clear the backlog) is.

### 6.1 Per-page runtime settings + AI dashboard

The classifier is managed and monitored from a dedicated owner page (`/ai-analytics`), not buried in config:
- **`wb_closing_settings`** (per-page override; `null` column = inherit env): `enabled`, `daily_cap_max`, `model`. Resolved as `override ?? env`, gated by the presence of `ANTHROPIC_API_KEY`. The nightly job skips disabled pages and uses each page's effective cap + model.
- **Dashboard** (`GET /pages/:label/workboard/v2/ai`, owner-only mutations): effective settings + override editor, today/30d usage + estimated cost, coverage (tails / classified / pending / closings), **state distribution** ("what's happening in chats"), recent verdicts, and **"Classify now" / "Reclassify all"** actions (the latter clears the page cache server-side — the explicit-consent path to re-run the whole backlog with the new semantic prompt).
- **`wb_classifier_runs`** — append-only run log (one row per page per run; `trigger ∈ {cron, manual, reclassify}` + counts + tokens + cost). Surfaced as a live, filterable **run logger** at the bottom of the AI page (`GET /workboard/ai/runs`).

A compact read-only indicator stays on the Workboard v2 page and links to the dashboard.

---

## 7. How the axes are used per tab

Four separate SQL lists. `value_score`/`urgency_score`/`Q` are computed once per `(page,fan)`; each tab consumes them with its own filter, sort, caps, and emphasis. **Nothing flattens the queues.**

### 7.1 Unified within-tab rank (consistent in every tab)

```
rankScore = U * (1 + 0.15 * Q_eff)  +  βV_tab * value_score
βV_tab:  subscribers 0.10 · spenders 0.30 · fresh 0.05 · old 0.05

ORDER BY isPurchaseFollowup DESC,   -- an active purchase floats to the top of its tab
         rankScore DESC,
         value_score DESC,          -- value as the final tiebreak too
         fanId ASC
```
> **Synthesis note — why value is *additive* and why the weight is per-tab.** The winning engine used an additive value term in the Spenders tab only (an inconsistency the judge flagged). We make the form **uniform** (additive value in *every* tab) and vary only the **weight** `βV_tab`. Additive (not multiplicative) is correct because Value must be able to lift a **high-value, low-urgency** fan — e.g. a silent whale in Spenders — which a multiplicative weight on a small `U` cannot do. The weight is small for Subscribers/mass (urgency dominates, the U-bar tells the story) and large for Spenders, where the spec says LTV/recency is "likely the key factor."

**Secondary status (from `U`, shown as a section + chip):**
```
needs_reply         → "Ответить" (Need reply) badge   (independent of bucket; purchase supersedes it as "Follow up $")
U ≥ 50              → "Срочно" (Due now)
25 ≤ U < 50        → "Позже" (Later)
U < 25 OR gated     → "Не трогать сегодня" (Don't touch today)   # cooldown / snoozed / freeloader-throttled / cross-page-blocked
```

### 7.2 Tab 1 — Subscribers (`isSubscriber=true AND expiry>now`) · ranking tab
- **Driver mix:** `U_expiry` dominates; `U_purchase` can override; `U_sla` within-tab; `U_cadence` as floor.
- **Status overlay:** `autoRenew=false` → persistent red **"Откл. продление" (Renew OFF)** chip regardless of bucket; renew-off subs also get a tighter cadence (`T_cad=5`).
- **Includes all current subs** (not just ≤21d like v1) — far-out ones are simply low-urgency and sink.
- **Beats v1:** v1 sorted `expiry-tier → autoRenew → LTV` with a hard 21-day cutoff and no purchase/SLA/quality. v2 keeps the tier intuition inside a *continuous* `U_expiry`, adds purchase override, within-tab SLA, autoRenew as a multiplier (not just a sort key), and value as weight.

### 7.3 Tab 2 — Spenders (`not current sub AND lifetime LTV ≥ SPENDER_MIN`) · value-tilted ranking tab
- **`SPENDER_MIN = $100` (100 000 mills)** to match v1 / the existing codebase constant — see §15. Expired subs with spend land here.
- **Driver mix:** `U_purchase` (re-engage a recent buyer), `U_cadence` is the workhorse (the "≥ once / 14 d" floor → `T_cad=14`), `U_sla` within-tab, `U_presence`.
- **Value pulls hardest here** (`βV=0.30`): a 6-months-silent top-LTV fan still surfaces via cadence + value, but no longer sits frozen at the top forever the way v1's pure-LTV sort allowed.
- **Hard gate:** cadence cooldown (`COOLDOWN=3d` after an outbound with no reply) → "Don't touch today."
- **Beats v1:** v1 = LTV desc + a silence≥7/14d surfacing filter. v2 adds purchase follow-up, real cadence flooring, within-tab SLA, quality, presence — and stops dropping a fan merely because silence < 7d if they just purchased.

### 7.4 Tab 3 — Fresh mass (`LTV < SPENDER_MIN`, `mass_substate ∈ {fresh,gray}`, follower/thread age < `FRESH_WINDOW=30d`) · ranking tab with caps
- **Driver mix:** `U_sla` (a fresh fan who wrote a *real* opener is the point of this tab), `U_cadence` (small `T_cad=4`), `U_presence`.
- **"hi" handling:** a real opener → `needs_reply=true` → shows in this tab's `Need reply` section with `U_sla≤80`, ranked only against other Fresh fans. **Visibility, not a cross-tab lift.** Promotion to Active requires Q evidence (§8).
- **Cap:** `FRESH_DAILY_CAP=40` newly-surfaced fresh fans/page/day (so a 5 000-follower dump doesn't explode the board), FIFO by `followerSince`, re-ranked by `rankScore`.
- **Beats v1:** v1 had **no** mass handling at all.

### 7.5 Tab 4 — Old mass (`LTV < SPENDER_MIN`, `mass_substate ∈ {active, dead}`, older than `FRESH_WINDOW`) · cap-governed tab
- **Residual by definition:** governed by a **daily cap** (§7.6) so it can never crowd the other three. Within the cap it ranks by `rankScore`.
- **Driver mix:** `U_cadence` (capped low, `CAD_CAP=30`, `T_cad=30`), `U_sla` within-tab (capped), `U_reactivation` for the Dead one-shot, `U_presence`. Freeloader suppression bites hardest here (§9).
- **Beats v1:** new; the residual-cap mechanic is the core anti-crowding tool the spec demands.

### 7.6 The Old-mass daily budget (decoupled from same-day noise)
> **Red-team fix.** Coupling the cap to *same-day other-tab volume* (the winning engine's `0.15 × otherTabsActioned`) starves the long tail on quiet days — exactly when chatters have spare capacity. Instead base it on a **fixed page capacity budget minus committed higher-tab work**, with an absolute floor, plus a reserved sub-budget for Dead reactivations so they're never crowded out:
```
PAGE_DAILY_CAPACITY = 150        # configurable per page (est. human touch capacity)
DEAD_REACT_RESERVE  = 5          # reserved exclusively for Dead one-shot reactivations
OLD_MASS_DAILY_CAP  = max(OLD_FLOOR=15, PAGE_DAILY_CAPACITY - projectedHigherTabActionable) - DEAD_REACT_RESERVE
```
At cap → the tab shows a positive "done for today" state and routes the chatter to the highest-pressure priority book (§12.5).

### 7.7 Cross-page anti-spam (global gate; only removes/defers, never reorders across tabs)
A model has several pages; don't hit the same fan on two pages the same day. Using the touch log (§11):
```
exclude fan from page P's tabs if the same (modelId, fanId) was actioned today on a DIFFERENT page
  → move to Service "Контакт на другой странице сегодня"
UNLESS U_purchase active OR U_expiry(d≤3) active (genuine urgency overrides)
scope: per outreach REASON, not blanket — a fan who is a distinct relationship on a GFE page and a fetish page
       of the same model can legitimately be worked on both for different reasons (red-team fix)
```

### 7.8 Service tab (status only, not ranked)
Members: snoozed (`workboard_snoozes`), risky-flag holds, refund/chargeback cooldowns, cross-page-suppressed-today, freeloader-throttled, Dead-archived, needs-human-triage (unknown-role tails). Shows the reason + return date. **Diagnostics** sub-view shows per-fan `{value_score, urgency_score, winning driver, Q, qConfidence, valueConfidence, coverage, roleConfidence}` for full explainability.

---

## 8. Lifecycle state machine

Persisted in `workboard_state` (§10). Recomputed by nightly `workboard:recompute` (one batch per page) **and** event-patched on purchase/inbound webhooks. A fan is in exactly one tab.

**State derivation (first match wins):**
1. **service** — snoozed OR risky-hold OR refund/chargeback cooldown (14d) OR freeloader hard-ceiling OR cross-page-suppressed-today OR `archived`.
2. **subscribers** — `isSubscriber AND expiry>now`.
3. **spenders** — `LTV ≥ SPENDER_MIN AND not current sub` (expired subs with spend included).
4. **fresh_mass** — `LTV < SPENDER_MIN AND mass_substate ∈ {fresh,gray}` AND (follower <30d OR no prior real conversation).
5. **old_mass** — `LTV < SPENDER_MIN AND mass_substate ∈ {active,dead}`.
6. fallback **fresh_mass** (new follower default).

**Transitions:**
- **PURCHASE** (settled earning txn): set `followup_due_at=now`, fire `U_purchase`, re-derive tab (sub txn → Subscribers; tip/PPV that pushes LTV ≥ SPENDER_MIN → Spenders). Event-driven. A purchase always gets a **"Follow up $"** treatment that supersedes ordinary `Need reply`.
- **SUBSCRIBE** `isSubscriber false→true` → Subscribers immediately.
- **EXPIRY** `expiry` passes: `LTV ≥ SPENDER_MIN` → Spenders; else → Old mass (active). (`autoRenewOffDetectedAt` is used only for the live `U_expiry` multiplier; **no transit history exists**, so we never infer past lapses.)
- **FRESH→GRAY** (auto, no engagement): `followerSince > GRAY_AFTER=14d` AND zero fan messages ever AND ≥ `GRAY_TOUCHES=2` opening touches with no reply (counted from the **touch log**, §11).
- **GRAY/FRESH→ACTIVE** (auto, **requires real conversation**): `Q ≥ Q_ACTIVE=0.2` with `qConfidence ≥ medium` AND ≥2 non-closing fan messages. A lone "hi" (`storedMessageCount≤1` → `Q=0`) does **not** promote — exactly the spec's "active = replied, but only real conversation lifts priority."
- **ACTIVE→DEAD** (auto): `daysSinceContact > DEAD_AFTER=45d` with `Q < Q_ACTIVE` and no purchase.
- **DEAD→sleep→REACTIVATION** (one shot): on entering Dead, sleep until `now + SLEEP=75d` (60–90d band). At sleep end, schedule **one** reactivation (`U_reactivation=25` for 7d, draws the `DEAD_REACT_RESERVE` budget). If still no real reply → `archived` → Service ("Archived — no engagement"), excluded forever.
- **Resurrection:** any `archived/dead` fan who makes a real purchase → Spenders/Subscribers (people grow up, get money — a real payment always re-opens the relationship).

> **Red-team fix — hysteresis & settlement.** Transactions can be retro-flipped `isActive=false` (lost from sync window) or charged back in a later phase. To stop tab/status flapping: (1) purchase spikes & conversion credit require **settled, still-active** rows; (2) once promoted to Spenders/Subscribers, demotion requires a **confirmed refund/chargeback** (not a transient window-loss) plus a grace period; (3) a reversed purchase **cleanly unwinds** the promotion and flags the pattern for review. The schema's `inactiveReason` distinguishes "window loss" from a real refund — use it.

---

## 9. Determinism & data hygiene

> **Red-team fix — day-boundary nondeterminism.** Spend rollups bucket in **UTC** (`resolveBusinessTimeZone`), but period helpers default to Moscow time. If "today-30" or `daysToExpiry` are computed in a different zone than the rollups, windows and urgency bands flip depending on what hour the cron ran.
- **Pin all engine day-math to one zone** (UTC, matching `resolveBusinessTimeZone`). Compute `daysToExpiry` and `daysSinceContact` against `startOfBusinessDay`, not raw millisecond diffs, so band membership only changes at a defined daily boundary.
- **Recompute is idempotent w.r.t. run-hour.**
- **Velocity reads `transactions` directly for the recent window** (real-time) and `fan_spend_daily` only for older windows — a lagging on-demand rollup can't understate a fresh buyer.

---

## 10. Freeloader model (resource ceiling)

Goal: ~10 **meaningful** conversations over a **sliding 90-day** window with **zero conversion** → sharply cut frequency; soften automatically if they vanish and return.

**"Meaningful conversation" = a real two-way exchange.** A conversation *episode* = a contiguous DM burst separated from the next by a >24h gap. An episode counts as meaningful iff **fan sent ≥2 messages, ≥1 non-closing, AND the model replied ≥1**. A lone "hi", a model monologue, or a single closing token does **not** count.

**Persisted sliding counter (authoritative, not re-derived from the 25-msg tail):**
```
workboard_state.freeloader_episodes = list of meaningful-episode timestamps
conv90 = count in trailing 90d (prune older every eval → this is what makes the window slide/soften)
converted90 = any settled purchase in the same 90d window
```
**Throttle:**
```
if conv90 ≥ FREELOADER_N(=10) AND NOT converted90:  status='freeloader', FM=0.25 (T_cad ×4), rankScore -12
soft ramp 7 ≤ conv90 < 10:  FM = 1 - 0.75*(conv90-7)/3   ("cooling", amber chip)
```
- **Conversion clears it instantly** (`converted90` → status clears, FM=1.0, transitions per purchase rules — they finally paid, re-invest).
- **Vanish/return softening is automatic** (pruning drops `conv90` below threshold after silence).

> **Red-team fixes — don't abandon an about-to-convert fan; don't allow infinite re-entry.**
> - **Intent gate:** if recent Q is high/rising and latency is fast (classic pre-conversion behavior), **suppress the suppression** — never throttle a fan who is actively, healthily conversing.
> - **Never fully park an actively-conversing fan** in Service; reduce *frequency* instead. Only a fan who is *both* over the ceiling *and* gone quiet for 2 cycles moves to Service ("Resource ceiling — minimal touches", ≤1 touch/30d).
> - **Cumulative lifetime cap:** track lifetime meaningful-episodes-without-conversion; past `LIFETIME_FREE_CAP` (≈25) the baseline settles to ≤1 touch/30d that the return bonus can't fully reset — defeats the "chat hard, vanish 6 weeks, repeat" exploit.
> - **Return bonus is one-shot** per fan per long interval, not per every 21–30d gap.

Surfaced as a **"Халявщик/Cooling"** chip with the `conv90` count so the suppression is explainable.

---

## 11. The touch log (load-bearing prerequisite)

> **Red-team finding #1 (must-fix).** The codebase has **no outbound-message capability** — chatters send DMs manually inside Fansly/OnlyFans, and the system only learns a touch happened when the lagged DM sync ingests it (and only keeps 25 messages). So cooldowns, cross-page locks, "N attempts → Gray", and "≥ once / 14d" floors have no reliable real-time signal, and `lastModelMessageAt` conflates a real outreach with a one-word "ok".

**Add `workboard_contact_log`**, written by the **dashboard** the moment a chatter acts on a fan thread (open-to-work / mark Готово), *not* inferred from sync:
```
workboard_contact_log(
  id, model_id, platform_account_id, fan_id,
  business_date, acted_at, action enum('opened','handled','snoozed'),
  was_productive boolean   -- a real outreach: min content length, non-closing (set on Готово)
)
```
- Every **cadence floor, cooldown, cross-page lock, and attempt count reads from this log**; `lastModelMessageAt` is only a backstop.
- **"Cadence satisfied" requires `was_productive=true`** — a one-word "ok" does not reset the 14-day floor (anti-gaming, §14).
- Until the log has history, treat cooldown/anti-spam/attempt-count as **best-effort**, never as a hard gate that hides a high-value fan.

---

## 12. UX + visual system

**Stack:** React + Tailwind v4 (CSS-var tokens), Inter, `lucide-react`. **Reuse** the `getSyncUxTone(state) → {badge,dot,panel,text}` pattern and the shipped `RemainingBar` / `Badge` / `StatusDot` / `MoneyCell` / `Tooltip` / `EmptyState` / `TableSkeleton` / `TouchpointBadge` / `ChatPreviewPanel` / `PresencePanel` / `SnoozedSection`. **UI copy is Russian** (matching v1). Color always rides with an icon + label (never color alone); contrast verified on `#f9f8f6`/`#ffffff`.

### 12.0 Mental model the UI teaches
Four parallel **books of business**, each with its own economic job. The top of the screen answers *"which book do I open now?"*; inside a tab, *"who, in what order?"* The priority score is per-tab, never global.

### 12.1 Page shell
```
┌──────────────────────────────────────────────────────────────────────────────┐
│  @creatorpage · Fansly        [● 3 онлайн]   coverage ●●●○   ⌘K  ?              │  page bar
├──────────────────────────────────────────────────────────────────────────────┤
│  ◆ ФОКУС СЕЙЧАС — Спендеры   «4 недавние покупки + 6 остывают»     [Открыть →] │  Focus strip
├──────────────────────────────────────────────────────────────────────────────┤
│  Подписчики ●3 ⚠5 ·12 │ •4 Спендеры 18 │ Свежие 31 │ Старая база 7/40 │ Сервис 9│ tab bar + counters
├──────────────────────────────────────────────────────────────────────────────┤
│  [●Ответить 3] [⚠Срочно 5] [Позже 4] [Не сегодня]        🔍       Сорт: умная ▾ │ status filter pills
├──────────────────────────────────────────────────────────────────────────────┤
│  WORK LIST (grouped sections, sticky sub-headers)                              │
└──────────────────────────────────────────────────────────────────────────────┘
```
- **Focus strip** (a recommendation, not a tab): ranks the four books by a *book-pressure score* = `recent-purchase×3 + need-reply-with-value×2 + expiring-renew-off×2 + cadence-breach×1` (each capped so one screaming row can't dominate). **Old mass is excluded** from being the Focus unless every other book is empty. Deep-links into the recommended tab pre-filtered. Optional one-line "Next:" beneath.
- **Tab counters** read pressure without opening: `● need-reply · ⚠ due-now · total`; leading counters appear only when >0 (calm tabs read `Подписчики · 12`). A **recent-purchase pip `•4`** in `text-accent` prefixes the name — the single loudest signal. **Старая база** shows `used/budget` (`7/40`) instead of a total.
- **Secondary status = grouped collapsible sections** (not sub-tabs, not a flat chip list), in order: `◆ Недавняя покупка` → `● Ответить` → `⚠ Срочно` → `Позже` → `Не трогать сегодня` (collapsed). Filter pills are a focusing shortcut that scopes to a section. **This is where anti-flattening is made visible:** a Fresh "hi" can only ever sit in the Fresh tab's Need-reply section.

### 12.2 Row anatomy — priority without a scary number
Priority is shown on **three orthogonal, glanceable channels**:
1. **Urgency = 3px colored left rail + a verb-first "why-now" phrase** ("Истекает через 2д", "Ждёт ответа 3д", "Молчит 18д"). The rail is the only place urgency color touches the row, so scanning the left edge = scanning urgency.
2. **Value = `MoneyCell` LTV + a categorical tier chip** (Кит / VIP / Платит / Новый).
3. **A 14×14 "quadrant glyph"** plotting value (x) × urgency (y) as one dot in a 2×2 grid — pre-attentive "is this both valuable and urgent?" (`useId()` for the SVG defs id; dot fill from urgency tone, radius from value tier; dashed outline when low-coverage).

Compact row (table, `text-[12px]`, `hover:bg-hover/50`):
```
│▌│ ◳ │ [TP] Имя @handle [Кит] │ Tier │  LTV │ ⟳ │ why-now + ≤2 chips │ RemainingBar │ Ф·М │ [Готово][⏰▾][⧉][→] │
 │  └ quadrant glyph              │      │      │   └ rest of chips → +N pill on expand
 └ urgency rail
```
Row stays white; urgency color lives only in the rail + chips (the v1 full-row `OVERDUE_BG` tint is demoted to the rail to keep a long list calm). **Expanded** row (single-accordion) adds three zones — *Why-now* (all chips + detection timestamps + the closing-detector verdict), *Conversation quality* (initiator ↑, M:Ф ratio with health verdict, latency band, who-wrote-last), *History* (msg/purchase counts, tenure, lifecycle + transition date) — plus the 4-dot confidence meter and `ChatPreviewPanel` with closing tokens greyed.

### 12.3 Color system (all tones mirror `getSyncUxTone → {badge,dot,panel,text}`)
New file `pages/workboard/tone.ts`. Reuses the **exact** 1/3/7-day severity ladder from `RemainingBar`/`theme.ts` — no new severity palette.

**Secondary-status — `getStatusTone`:**

| Status | Icon (lucide) | badge / dot / text |
|---|---|---|
| `recent_purchase` | `BadgeDollarSign` | `border-accent/30 bg-accent/12 text-accent` · `bg-accent` |
| `need_reply` | `MessageSquareDot` | `border-accent/25 bg-accent/10 text-accent` · `bg-accent` |
| `due_now` | `AlarmClock` | `border-warning/30 bg-warning/12 text-warning-dark` · `bg-warning-dark` |
| `later` | `Clock` | `border-border bg-hover-alt text-text-secondary` · `bg-text-secondary` |
| `dont_touch_today` | `MoonStar` | `border-border bg-card text-text-muted` · `bg-text-muted` |

Purchase & need-reply share the **accent** hue (both "engage now") but separate by icon, section, and rank — purchase always above. Due-now uses **warning/amber** so "the schedule says act" reads distinctly from "the fan is waiting."

**Reason chips — `getReasonTone`** (`bg-{color}/15 text-{color}` + icon):

| Chip | RU label | Icon | Classes |
|---|---|---|---|
| `renew_off` | Откл. продление | `RefreshCwOff` | `bg-warning/15 text-warning-dark` |
| `expires_soon` | Истекает | `CalendarClock` | severity-driven: `text-danger` ≤1d · `text-warning-dark` ≤3d · else `text-warning` |
| `recent_purchase` | Покупка | `BadgeDollarSign` | `bg-accent/15 text-accent` |
| `replies_waiting` | Ждёт ответа | `MessageSquareDot` | `bg-accent/15 text-accent` |
| `fresh_day_n` | День N | `Sparkles` | `bg-fansly/15 text-fansly` |
| `vip_whale` | Кит / VIP | `Crown` | `bg-[#7c3aed]/12 text-[#7c3aed]` (violet = "person matters", distinct from money-green) |
| `freeloader` | Халявщик | `HandCoins` | `bg-text-muted/15 text-text-muted` |
| `cooldown` | Кулдаун | `Snowflake` | `bg-text-muted/15 text-text-muted` |
| `cold_start` | Мало данных | `HelpCircle` | `bg-border text-text-muted` |
| `cross_page_block` | Другая стр. сегодня | `ShieldAlert` | `bg-text-muted/15 text-text-muted` |
| `unverified` | Не проверено | `HelpCircle` | `bg-text-muted/10 text-text-muted` (L2 over-cap fallback) |

**Urgency-severity (left rail + glyph fill) — `getUrgencyTone`:** `critical` (≤1d / purchase <2h / SLA>72h) `border-l-danger` · `high` (≤3d / SLA 24–72h) `border-l-warning-dark` · `medium` (≤7d / cadence breach) `border-l-warning` · `normal` `border-l-border` · `muted` (don't-touch) `border-l-transparent`.

**Mass-lifecycle dots — `getLifecycleTone`:** `fresh` `bg-fansly` · `gray` `bg-text-muted` · `active` `bg-green` · `dead` `bg-text-muted/50` · `reactivation` `bg-warning` · `archived` `bg-text-muted/40`. **"Active" is green (alive) but adds NO rail color** — a "hi"-only Active fan shows a green dot and a *neutral rail* = "visible, not prioritized."

**Value tiers — `getValueTone`** (green-family for magnitude, distinct from the violet relationship chip): `whale` `bg-green/15 text-green` + `Crown` · `vip` `bg-green/12 text-green` · `payer` `bg-hover-alt text-text-secondary` · `new` `bg-card text-text-muted border`.

### 12.4 Recent-purchase & Replies-waiting treatments
- **Recent purchase** is the one event that reorders books and rows: pinned `◆ Недавняя покупка` micro-section at the **top of its tab** (above Need-reply), accent rail bumped to `border-l-[4px]`, the single allowed full-row wash `bg-accent/[0.04]`, a leading chip `◆ PPV $25 · 2ч` (amount via `MoneyCell`), a one-line nudge "Поблагодари и допродай", and a `→ Спендеры` ghost hint if the purchase graduated a mass fan. Rail fades `accent → warning` as the 48h window ages.
- **Replies waiting:** `MessageSquareDot` + accent dot (the dot **pulses only** for `critical` SLA >72h, not the whole list). Why-now shows wait-age + who. **Closing-detector transparency:** a row is in Need-reply only if it passed both layers; the expanded chat preview greys an excluded closing token ("закрывающее: «спасибо»") so the omission is trusted; a section footnote says "закрывающие сообщения скрыты". An **over-cap `unverified`** row carries the `HelpCircle` chip + tooltip "не проверено классификатором (лимит)" and ranks below verified.

### 12.5 Old-mass cap meter
When **Старая база** is active, a slim budget bar replaces the filter row:
```
Старая база — остаточный лимит на сегодня
▓▓▓▓▓▓▓░░░░░░░░░░  7 / 40 касаний · осталось 33        Сброс в 00:00
«Не мешает приоритетным вкладкам. Бери сверху — лучшие шансы первыми.»
```
Bar fill `bg-accent → bg-warning-dark` at ≥80% → `bg-text-muted` at cap. The list renders exactly the remaining budget (best-odds-first); below it a dimmed `opacity-50` "за лимитом" preview proves the queue continues *tomorrow* without being actionable (kills infinite-scroll dread). Each Готово decrements the meter. At cap → positive `EmptyState` (`CheckCircle2 text-green`, "Лимит на сегодня выполнен") + `[К приоритетным →]`. A purchase escapes the cap entirely (surfaces uncapped in Spenders).

### 12.6 Confidence / coverage
Four-dot meter `getCoverageTone`: `full ●●●●` / `good ●●●○` (green) · `partial ●●○○` / `sparse ●○○○` (warning-dark) · `none ○○○○` (muted). Shown as a page-bar chip (page sync coverage, links to Sync settings), a per-row micro-marker only when `partial` or worse, and the full meter in the expanded quality zone. **Low coverage caps loudness** — a `sparse`/`none` row renders `medium` urgency at most (never `critical`), hedged why-now ("возможно остывает"), dashed quadrant glyph.

### 12.7 Interactions (optimistic + toast + undo, like v1's `sonner`)
- **Готово** (`bg-green/15 text-green`, `Check`): marks contacted-today (writes the touch log §11), animates the row into "Не трогать сегодня", resets the cadence clock, advances cross-page anti-spam. If already touched on a sister page today the row arrives pre-stamped with the `cross_page_block` chip and Готово is disabled.
- **Отложить ▾ (snooze)** with **context-smart defaults**: sub >14d → *до 5-дн отметки* (snooze-to-touchpoint); sub ≤7d → *1д*; spender → *7д*; fresh → *3д*; old → *длинный сон* (→ reactivation track). Custom date row at the bottom. Routes to `Сервис → Отложенные` (reuses `useWorkboardSnooze`).
- **Undo:** every action toasts `[Отменить]` (6s) + a client-side `⌘Z` stack (last 10).
- **Keyboard triage:** `j/k` move · `Enter` expand · `e` Готово · `s` then `1/2/3` snooze · `c` copy link · `o` profile · `g`+`1–5` jump tab · `f` cycle filter · `⌘Z` undo · `?` help. Focus auto-advances after `e`/`s`; a "осталось N в секции" counter decrements (batch-completion feel).
- **Presence is ambient, not a book:** an online fan gets a green `StatusDot` + "онлайн" on the row; the page bar shows `● N онлайн` opening the existing `PresencePanel`. Presence influences the cross-book Focus strip only in the rare "Кит онлайн и ждёт ответа" moment.
- **Empty states read as success:** per-tab calm `EmptyState`s; a whole-board-done state ("На сегодня всё") shows the day's tally ("обработано 47 · покупок 6 · $340").

### 12.8 Two wireframes
**Subscribers** — purchase pinned on top, renew-off subs clustering into `Срочно` with reddening rails as expiry nears, a "hi" sitting in `Ответить` but never above the renew-off whale; a low-confidence row hedged "возможно остывает":
```
◆ НЕДАВНЯЯ ПОКУПКА (1) ───────────────────────────────────── (bg-accent/[0.04])
▌◳● [5d] Mike_T   [Кит] │Main│ $1,240 │⟳off│ ◆ Renew $20 · 1ч · поблагодари+допродай │██▌2д│Ф:1ч·М:4ч│[Готово][⏰▾]
● ОТВЕТИТЬ (3)  закрывающие сообщения скрыты ─────────────────────────────────
▌◳● [1d] Jen99    [VIP] │Main│   $612 │⟳off│ Фан ждёт ответа 3д (>72ч)              │█▏1д│Ф:3д·М:6д│[Готово][⏰▾]
▌◳  [7d] dmitry_v ●онлайн│Basic│  $95 │⟳on │ Ждёт ответа 6ч · онлайн сейчас         │████7д│Ф:6ч·М:3д│[Готово]
⚠ СРОЧНО (5) ─────────────────────────────────────────────────────────────────
▌◳  [1d] sara_w   [VIP] │Main│   $540 │⟳off│ Истекает завтра · откл. продление      │█▏1д│Ф:8д·М:2д│[Готово][⏰▾]
▌·   [5d] nina_k  Мало данных│Basic│ $20│⟳on│ Возможно остывает (мало данных)       │███▌5д│Ф:–·М:7д│[Готово]
```
**Old mass** — the cap meter is the hero; rows are calm (neutral rails — old mass is *eligible*, rarely *urgent*); `mike2` carries the freeloader chip from 11 dialogs / 0 conversions; a purchase escapes the cap:
```
CAP METER ─────────────────────────────────────────────────────────────────────
 Старая база — остаточный лимит на сегодня
 ▓▓▓▓▓▓▓░░░░░░░░░░  7 / 40 касаний · осталось 33          Сброс в 00:00
▌◳  greg_m   Мало данных│ $0 │Dead • реактивация│ Молчит 74д · 1 попытка │silent ███░│[Готово][⏰▾]
▌·   mike2   Халявщик   │ $0 │Active(тихо)      │ 11 диалогов, 0 покупок (3м)│silent ███│[Готово][⏰▾]
 за лимитом сегодня (превью, недоступно до завтра) ──────────── (opacity-50)
   roman_k · julia88 · pavel.s · …                                     +312 ещё
```

---

## 13. Data model additions (Drizzle + migrations)

All net-new tables; v1 tables untouched. Add hand-written numbered SQL in
`packages/db/migrations` and apply with `pnpm db:migrate`.

```
workboard_state (
  platform_account_id, fan_id,                         -- PK (page, fan)
  tab enum('subscribers','spenders','fresh_mass','old_mass','service'),
  mass_substate enum('fresh','gray','active','dead','archived') | null,
  value_score numeric(5,2), urgency_score numeric(5,2), q_score numeric(4,3),
  q_confidence enum('high','medium','low'), value_confidence enum('high','low'),
  role_confidence numeric(4,3),
  needs_reply boolean, needs_human_triage boolean,
  best_coverage_seen enum(...),                         -- monotonic; never regresses on a re-backfill
  followup_due_at, freeloader_episodes jsonb,           -- persisted sliding-window timestamps
  freeloader_status enum('none','cooling','freeloader','ceiling'),
  lifetime_free_episodes int,                           -- cumulative cap (anti re-entry abuse)
  reactivation_attempted_at, service_reason text | null,
  last_eval_at, updated_at
)

workboard_contact_log ( ... )                           -- §11; the load-bearing touch signal
wb_closing_cache (platform_message_id, content_hash, needs_reply, layer enum('l1','l2','over_cap'), model, classified_at)  -- §6 permanent per-message cache
wb_llm_usage_daily (platform_account_id, business_date, calls, input_tokens, output_tokens, est_cost_mills)              -- §6 per-page adaptive cap home (NOT ai_usage_events — it lacks platform_account_id & is keyed to a human userId)
workboard_actions (platform_account_id, business_date, tab, count)  -- daily capacity accounting for the Old-mass budget
```
> **Red-team fix #2 — the classifier has no home today.** `ai_usage_events` is keyed to a NOT-NULL human `userId`, has no `platform_account_id`, and its `feature` enum has no closing value. The per-page daily cap therefore **cannot** live there — hence `wb_llm_usage_daily`. (Optionally also mirror cost into `ai_usage_events` via a system actor for unified reporting, but the *cap* is enforced on the page-scoped table.)
> **Persisted, monotonic confidence** (`best_coverage_seen`) + persisted `freeloader_episodes` mean a transient `complete → pending_backfill` re-sync can't regress a row's confidence or lose freeloader counts — killing the "why did this person move?" coverage flap.

**New config / infra:** add `@anthropic-ai/sdk` to `apps/runtime`; add `ANTHROPIC_API_KEY` + `MESSAGE_CLASSIFICATION_*` to the Zod env schema (`packages/shared/src/config.ts`); init an Anthropic client at bootstrap (next to the Fansly/OnlyFans adapters); two pg-boss queues `workboard:recompute` and `workboard:classify-closing` (cron, mirroring the sync planner).

---

## 14. Anti-gaming (built in)

| Vector | Guard |
|---|---|
| Chatter clears Need-reply / resets cadence with a one-word "ok" | "Cadence satisfied" & "productive touch" read the **touch log** with a min-content/non-closing check (§11), not `lastModelMessageAt`. |
| Fan farms Need-reply by pinging "hi/you up?" daily | `openerDamp` decays the SLA boost for repeated unanswered low-content openers (§4.1); L2 distinguishes "opener needing a reply" from a content-free ping. |
| Free-chatter games the sliding window (chat, vanish 6 wks, repeat) | `LIFETIME_FREE_CAP` + one-shot return bonus + intent gate (§10). |
| Chatter under-messages to keep ratio "healthy 1:1" | Ratio is a low-weight, confidence-gated signal that **never scores a chatter**; don't expose the exact band; reward conversions, not ratio aesthetics. |
| Self-purchase/refund-cycling to spike priority | Spikes require **settled, still-active** revenue; a reversal cleanly unwinds and flags the pattern (§8). |
| Cherry-picking only whales (EV-style starvation of the tail) | Two-axis (not EV) ranking + the Old-mass **floor** budget guarantee the tail is surfaced; track tail-coverage as an operator metric. |

---

## 15. Calibration & open questions

- **Per-page percentile calibration.** `LTV_REF$=1000`, `VEL_REF$=5/day`, `TIER_REF$=50` are agency-wide priors. A page whose whales are $10k+ will saturate Value (everyone gold). **Recompute these as per-page/per-model percentiles** (e.g. `LTV_REF = p90 of page LTV`) once there's data; ship as constants first, learn later.
- **Outcome telemetry (needed to tune weights & detect gaming).** There is **no conversions-per-touch signal** today. Add it (joining the touch log to subsequent settled purchases) so weights can be fit and queue-gaming is distinguishable from real performance. Until then, all coefficients here are **defensible priors, not fitted values**.
- **`SPENDER_MIN` reconciliation.** Set to **$100** to match v1 / `SPENDER_RETENTION_NEEDS_REACTIVATION_LIFETIME_NET_MILLS`, so v2 doesn't suddenly flood Spenders with $20–99 micro-payers. Such micro-payers stay in mass but carry a "Платил" chip + small value floor so they're not lost. (Revisit if operators want a lower bar.)
- **DM window.** Raising the 25-message cap materially improves Q, episode counting, and closing detection; flagged as a high-value backend change.

---

## 16. Coefficient reference (defaults)

```
VALUE       LTV_REF$=1000 · recency half-life≈83d (exp(-age/120), floor 0.5) · VEL_REF$=5/day
            typeTilt=clamp(0.8+0.6*alaCarteShare,0.8,1.4) · TIER_REF$=50
            wL=0.35 wVel=0.35 wT=0.20 wP=0.10 · flags whale+20/vip+12/risky-15
URGENCY     U_purchase=95*exp(-h/36), big(≥$50)×1.05, window 3d
            U_expiry interp{1:88,3:78,5:66,7:54,10:40,14:28,21:16} × autoRenew{false1.12/null1.05/true0.80}
            U_sla=min(80,30+22*ln(1+h/6))*openerDamp[0.5–1] · U_cadence=min(CAD_CAP,20+6*over), over=daysSince−T_cad*H_cq
            CAD_CAP subs60/spenders70/fresh45/old30 · U_presence 35/20 (fresh<30min only) · U_reactivation 25/7d
            U = clamp(0,100, max + min(8, 0.25*Σothers))
QUALITY     Q=0.35Rq+0.30Iq+0.10Lq+0.25Hq · qDamp{≥6 or complete:1 / 2–5:0.5 / ≤1 or pending:0} · roleDamp=1−0.6*unknownShare · Q_ACTIVE=0.2
RANK        rankScore=U*(1+0.15*Q_eff)+βV*value_score · βV subs0.10/spenders0.30/fresh0.05/old0.05
STATUS      Due-now U≥50 · Later 25–49 · Don't-touch <25/gated
FSM         SPENDER_MIN=$100 · FRESH_WINDOW=30d · GRAY_AFTER=14d/2 touches · DEAD_AFTER=45d · SLEEP=75d · react 7d · refund cooldown 14d
CADENCE     T_cad subs7(renew-off5)/spenders14(whale10)/fresh4/old30 · COOLDOWN=3d
CAPS        FRESH_DAILY=40 · SPEND_SOFT=50 · SUB_SOFT=60 · PAGE_DAILY_CAPACITY=150 · OLD_FLOOR=15 · DEAD_REACT_RESERVE=5
FREELOADER  N=10 meaningful/90d & no conversion → FM=0.25, rank−12 · soft 7→10 · LIFETIME_FREE_CAP≈25 · intent-gate on
CLOSING     L1 multilingual list · L2 Haiku 4.5 on >24h tail · cap=clamp(0.5*tail,50,400) · over-budget→defer · error→retry · unverified ranked below
ANTI-SPAM   1 actionable page/model/day (reason-scoped); override on U_purchase or U_expiry(d≤3)
```

---

## 17. Staged rollout

Ship behind feature flags, Fansly first (matching v1 scope). Each stage stands alone and is independently shippable.

- **Stage 0 — beats v1 with zero ML.** `workboard_contact_log` (§11) + L1 closing list + the Value/Urgency engine on **spend/expiry/cadence only** (no Q, no L2, no presence) + the FSM tabs + within-tab ranking + secondary status + the UX shell (Focus strip, tabs, sections, rows, color tones, cap meter). *Needs no Anthropic, no new ML; already beats v1 on every tab.*
- **Stage 1 — conversation quality + clock-bending + freeloader (heuristic).** Add `Q` from the 25-msg window with confidence/role-confidence gating; cadence clock-bending (`H_cq`); the persisted freeloader sliding window with intent-gating. Still no LLM.
- **Stage 2 — L2 Haiku closing classifier.** Stand up the Anthropic client + `wb_closing_cache` + `wb_llm_usage_daily`; the Batches API nightly job on the >24h tail; adaptive cap + `unverified` ranking. Behind its own flag.
- **Stage 3 — presence, cross-page, calibration, telemetry.** Freshness-gated presence nudges; reason-scoped cross-page anti-spam; per-page percentile calibration; the conversions-per-touch telemetry loop (to fit weights and catch gaming).

> **Verdict (from red-team).** The scoring math is the low-risk part. The load-bearing risks are the three primitives that don't exist yet — the **touch log**, the **classifier infrastructure/cost-home**, and **reliable Fansly sender-role** — which is exactly why Stage 0 delivers a v1-beating board *without* them, and the ML/quality/presence layers come online behind flags only once their missing signals and confidence-stability are built and validated.

---

## 18. Build notes (engineer handoff)

- **Frontend new files:** `pages/workboard/tone.ts` (all `getXTone` helpers, `getSyncUxTone` shape), `components/page/workboard/v2/{FocusStrip,TabBar,StatusSection,WorkRow,WorkRowExpanded,QuadrantGlyph,CapMeter,CoverageMeter,ReasonChip}.tsx`. **Reuse verbatim:** `RemainingBar, Badge, MoneyCell, Tooltip, EmptyState, TableSkeleton, StatusDot, TouchpointBadge, ChatPreviewPanel, PresencePanel, SnoozedSection` and the `useWorkboard*` hooks. **Consolidate** the duplicated `TIER_COLORS` map (basic=pink/main=red/advanced=yellow/master=cyan/gfe=zinc) out of `WorkboardCard`/`WorkboardCompactRow` into `tone.ts`. `QuadrantGlyph` uses `useId()`; make its size a prop (generic-component convention).
- **Backend:** new repositories in `packages/db/src/repositories/workboard-v2.ts`; services in `apps/runtime/src/services/workboard-v2/`; new REST routes under `/api/v1/pages/{pageLabel}/workboard/v2` (paginated, `?tab=&status=&limit=&offset=`); pg-boss queues registered in `worker-services.ts`.
- **Contracts:** extend the row VM with `secondaryStatus, urgencySeverity, valueTier, reasonChips[], lifecycleState, whyNow, conversationQuality{initiator,modelMsgs,fanMsgs,ratioHealth,latencyBand,wroteLast}, recentPurchase{type,amountMills,at}|null, closingVerdict{layer,needsReply}, messageCoverageStatus, roleConfidence, crossPageBlockedToday`; page-level `oldMassBudget{used,total,resetsAt}`. Run `contracts:generate`; add integration tests + breadcrumbs per the new-pages checklist.
- **Calm-first defaults:** no animation except the critical-SLA pulse and the cap-meter decrement; everything else `transition-colors`; single-row accordion per tab; color always rides with icon + label.
- **v1 untouched:** v2 is additive (new tables, new routes, new components, new flag). The `workboard_snoozes` table and presence service are shared and extended, not modified.

---

### Appendix — the six worked hard cases

1. **Renew-off sub expiring in 2 days** → *Subscribers* tab, `U_expiry ≈ 83×1.12 ≈ 93`, red rail, "Откл. продление" chip, whyNow "Истекает через 2д — спаси подписку". A mass "hi" is in a different tab and never compared to it. *Structural, not luck.*
2. **High-LTV spender silent 14 days** → *Spenders*, `U_cadence` just crossing (~20; silent 18d → 44) **+ `βV·value`** (a V=85 whale adds ~25.5) → surfaces high in tab; a chatty $25 fan with higher U interleaves rather than burying it. whyNow "Топ-спендер, молчит 18д".
3. **Mass fan wrote "hi" then silent** → `needs_reply=true` (hi is an opener), *Fresh* tab, `storedMessageCount=1 → Q=0 → no promotion`. Shows in Fresh's Need-reply section with `U_sla≈45`. Visibility, zero cross-tab lift; repeated "hi"s decay via `openerDamp` then Gray after 14d.
4. **Freeloader at 10 conversations** → `conv90=10`, no conversion → FM=0.25, rank−12, `T_cad×4`; **but** if Q is rising + latency fast, the intent gate suppresses the suppression. Vanish 6 weeks → window prunes → softens. Buys → clears instantly → Spenders.
5. **Fan bought a PPV 1h ago** → purchase webhook, `U_purchase ≈ 92`, `isPurchaseFollowup=true` → top of its tab (Spenders, or Fresh→Spenders if the PPV crossed `SPENDER_MIN`), "Follow up $" supersedes Need-reply, whyNow "Купил(а) PPV час назад — поблагодари и допродай". Settlement-aware: a later chargeback cleanly unwinds it.
6. **Fan with almost no history (cold start)** → `Q forced 0`, value pip hatched, `U_sla` capped at 50 until coverage improves, small `Potn` value floor so a brand-new $50-tier sub isn't invisible; row shows the "Мало данных" chip and renders `medium` urgency at most. Nothing is asserted we can't back with data.
