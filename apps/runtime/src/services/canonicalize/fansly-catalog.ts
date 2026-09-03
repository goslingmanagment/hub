// WP-F3 — the `fansly-catalog` canonicalizer family (v1, projection-only).
//
// Nine observation kinds, one family, and the thing that makes it one family
// rather than nine parsers is the ROSTER. Read that part first; everything else
// here is ordinary row-to-event work.
//
// ── THE ROSTER, and why `missing_since` needs it ─────────────────────────────
//
// The catalog's entities disappear. A tier is retired, a gift code is revoked,
// an album is deleted, an automation is switched off. DP 7 forbids deleting the
// row, so the projection marks it `missing_since` — "the listing that should
// have named this stopped naming it, at T".
//
// A projector cannot derive that from the row events alone. Row events say what
// IS; nothing in them says what ISN'T, and the worst case is the honest one: a
// page whose five tiers all disappear serves an EMPTY listing, which produces
// zero row events and would leave five stale tiers reading as live forever.
//
// So each FULL listing also emits ONE `catalog.listing_observed` carrying the
// complete set of refs it served, keyed by the OBSERVATION that produced it —
// one roster per LOOK. The projector marks the complement missing and clears
// the mark on everything the roster still names, so `missing_since` becomes a
// REPLAYED fact rather than a sweep-time side effect, which is the only version
// of it that survives truncate-and-replay. (Keying the roster on the ref set's
// hash instead is the version that looked right and was wrong: a gift code that
// disappears and comes back UNCHANGED hashes to the roster it had before it
// vanished, so the event dedupes and the row stays marked forever.)
//
// ALBUM MEMBERSHIP GETS NO ROSTER, deliberately. Membership arrives from a
// PAGED walk, and a roster built from one page would claim the album contains
// only what that page showed — every walk would mark most of the album missing
// and the next page would un-mark it. A partial listing is not a listing.
//
// ── THE OTHER FOUR RULES ─────────────────────────────────────────────────────
//
// 1. **TIME (§3.2b).** Every event here is RECEIPT-TIME: `occurredAt` is the
//    observation's `receivedAt`, and the provider instant is a typed field in
//    `data`. A receipt-time draft is by construction inside
//    `clampDraftOccurredAt`'s window, so an event from this family can NEVER
//    carry `occurredAtClamped`, and a fixture asserts exactly that. The failure
//    it prevents: `domain_events` is monthly-partitioned, and an album created
//    in 2023 dated at provider time would fail `ExecFindPartition` (23514)
//    forever.
//
// 2. **SECONDS AND MILLISECONDS, PER FIELD — the trap this family is full of.**
//    ONE response mixes both: on `/uservault/albumsnew`, `albums[].createdAt`
//    and `aggregationData.albumContent[].createdAt` are MILLISECONDS while
//    `aggregationData.accountMedia[].createdAt` and the raw `media[]` rows are
//    SECONDS (verified 2026-08-19). Gift codes and promos are milliseconds.
//    Each field is decoded by the helper for ITS unit, never by a shared guess.
//
// 3. **MONEY IS MILLS, THROUGH THE SHARED CONSTRUCTORS.** Every price on the
//    wire is already mills (a $499.99 plan is 499 990), and it travels as a
//    decimal STRING built by `millsString` → `millsFromInteger`. And the
//    prices that matter are `plans[].price`, NEVER `tier.price`: all five
//    observed tiers carried `tier.price = 5 000` while their plans ranged
//    10 000 … 499 990. `tier.price` is emitted as `basePriceMills` so that no
//    consumer can read it as the price by accident.
//
// 4. **NO DELIVERY URLS, EVER.** `/vault/albumsnew` and `/media/vaultnew` both
//    embed raw `media[]` rows carrying `location`, `locations[]` and
//    `variants[]` — signed CDN material. This file reads none of them. The
//    bodies are journaled verbatim (DP 7) and the URLs stay there.

import { fanslyRawMediaDrafts } from "./raw-media.ts";

import {
  asFanslyTimestamp,
  asNumber,
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
  type CanonicalizeRunContext,
} from "./types.ts";
import {
  buildMediaPlaneIndex,
  contentHash,
  mediaObservedDrafts,
  mediaPlaneSources,
  millsString,
  nonNegativeCount,
  recordArray,
} from "./sync-pull.ts";

export const FANSLY_CATALOG_CANONICALIZER_VERSION = 3;
const SCHEMA_VERSION = 1;

/** The `observations.kind` values this family claims. Registered in
 *  `observation-kinds.ts`; the ratchet fails otherwise. */
export const FANSLY_CATALOG_CANONICALIZED_KINDS = [
  "vault_albums",
  "uservault_albums",
  "subscription_tiers",
  "gift_codes",
  "automated_messages",
  "account_walls",
  "vault_media",
  "vault_album_walk_completed",
  "account_media_batch",
  "account_media_bundle_batch",
] as const;

const CANONICALIZED_KIND_SET: ReadonlySet<string> = new Set(FANSLY_CATALOG_CANONICALIZED_KINDS);

/** Raised when an automation's `messageTemplate` did not parse as an object.
 *  The ROW is still written, with `parseOk: false`. */
export const FANSLY_AUTOMATION_TEMPLATE_FALLBACK_DIAGNOSTIC =
  "fansly_automation_template_string_shape";

/**
 * The roster identities. One per FULL listing this family can observe; the
 * projector maps each to the table whose rows it can mark missing.
 *
 * `subscription_tiers` and `subscription_tier_plans` are two rosters from ONE
 * response on purpose: a tier can survive while one of its plans is retired,
 * and a single roster keyed on tiers would never notice.
 */
export const FANSLY_CATALOG_LISTING_KINDS = [
  "vault_albums:creator",
  "vault_albums:user",
  "subscription_tiers",
  "subscription_tier_plans",
  "gift_codes",
  "automated_messages",
  "page_walls",
] as const;

export type FanslyCatalogListingKind = typeof FANSLY_CATALOG_LISTING_KINDS[number];

/** The event types this family emits. Every one is registered in
 *  `PROJECTION_ONLY_DOMAIN_EVENT_TYPES` — one decision, never two.
 *  `media.observed` is deliberately absent: F0(b) minted that type and this
 *  family reuses its exact shape and dedup key with a different origin. */
export const FANSLY_CATALOG_EVENT_TYPES = [
  "vault.album_observed",
  "vault.album_membership_observed",
  "vault.album_walk_completed",
  "subscription.tier_observed",
  "subscription.tier_plan_observed",
  "promo.gift_code_observed",
  "automation.definition_observed",
  "page.wall_observed",
  "catalog.listing_observed",
] as const;

function pageRefOf(observation: CanonicalizableObservation): string {
  return String(observation.accountId);
}

/**
 * MILLISECOND instants: album `createdAt`, `albumContent[].createdAt`, gift-code
 * `createdAt`/`startsAt`/`endsAt`. Null stays null — a missing timestamp must
 * never become 1970.
 */
function msInstantIso(value: unknown): string | null {
  const raw = asNumber(value);
  if (raw === null || raw <= 0) {
    return null;
  }
  return asFanslyTimestamp(raw, new Date(0)).toISOString();
}

/** The rows of an array-shaped response, or of the first array-valued key of an
 *  object-shaped one. `/subscriptions/tiers`, `/subscriptions/giftcodes`,
 *  `/message/automated`, `/account/walls` and both `?ids=` routes all serve a
 *  BARE ARRAY once the `{success, response}` envelope is unwrapped. */
function envelopeArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (isRecord(payload)) {
    for (const value of Object.values(payload)) {
      if (Array.isArray(value)) {
        return value.filter(isRecord);
      }
    }
  }
  return [];
}

/**
 * The roster event: "this FULL listing named exactly these refs, at this
 * observation".
 *
 * ONE ROSTER PER LOOK — the dedup key carries the OBSERVATION id, not just the
 * content hash, and that is a correction rather than a convenience. Hashing the
 * ref set alone looked right and was wrong in one direction that matters: a
 * gift code that disappears and comes back UNCHANGED produces a roster
 * identical to the one before it disappeared, so the event dedupes, the
 * projector never sees it, and the row stays marked `missing_since` forever
 * even though the platform is serving it again. A set returning to a previous
 * shape is a different FACT from a set that never changed, and only the look
 * tells them apart.
 *
 * Replay is still a no-op: the same observation replays to the same key. The
 * cost is one small event per listing per sweep — seven a day on a page whose
 * production ledger already appends ~1 971 a day.
 *
 * Refs are SORTED so a provider that reorders its rows produces the same
 * `contentHash`, which stays in `data` as the cheap "did the set change?" read.
 */
function listingDraft(
  observation: CanonicalizableObservation,
  listingKind: FanslyCatalogListingKind,
  refs: readonly string[],
): CanonicalEventDraft {
  const pageRef = pageRefOf(observation);
  const sorted = [...new Set(refs)].sort();
  const material = { listingKind, refs: sorted, count: sorted.length };
  const hash = contentHash(material);
  return {
    type: "catalog.listing_observed",
    // RECEIPT TIME (§3.2b). "When we looked" is exactly what a roster is about.
    occurredAt: observation.receivedAt,
    data: { ...material, contentHash: hash },
    schemaVersion: SCHEMA_VERSION,
    dedupKey: `cataloglisting:v1:${pageRef}:${listingKind}:${observation.id}:${hash}`,
  };
}

// ── vaults ───────────────────────────────────────────────────────────────────

type VaultKind = "creator" | "user";

function albumDrafts(
  observation: CanonicalizableObservation,
  vaultKind: VaultKind,
): CanonicalEventDraft[] {
  const payload = observation.payload;
  if (!isRecord(payload)) {
    return [];
  }
  const pageRef = pageRefOf(observation);
  const albums = recordArray(payload.albums);
  const drafts: CanonicalEventDraft[] = [];
  const refs: string[] = [];

  for (const album of albums) {
    const albumRef = asString(album.id);
    if (albumRef === null) {
      continue;
    }
    refs.push(albumRef);
    const material = {
      vaultKind,
      albumRef,
      ownerAccountRef: asString(album.accountId),
      // NULL on the system albums (type 38000 / 5000 / 1000) — which is why
      // nothing downstream treats a title as identity.
      title: typeof album.title === "string" ? album.title : null,
      description: typeof album.description === "string" ? album.description : null,
      // RAW platform integer. NULL on creator-made albums.
      albumType: asNumber(album.type),
      status: asNumber(album.status),
      pos: asNumber(album.pos),
      // AS SERVED, and NON-UNIQUE: Σ over a page double-counts, because the
      // system albums are views over the same media (§2.3, verified: Σ = 16 939
      // over 27 albums, with 38000 and 5000 sharing one lastItemId).
      itemCount: nonNegativeCount(album.itemCount),
      lastItemRef: asString(album.lastItemId),
      thumbnailRef: asString(album.thumbnailId),
      public: asNumber(album.public),
      version: asNumber(album.version),
      // MILLISECONDS on this field (see the header's rule 2).
      createdAtPlatform: msInstantIso(album.createdAt),
    };
    const hash = contentHash(material);
    drafts.push({
      type: "vault.album_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `album:v1:${pageRef}:${vaultKind}:${albumRef}:${hash}`,
    });
  }

  // The album-content sidecar: `/uservault/albumsnew` serves it, the creator
  // vault does not (its membership comes from the `/media/vaultnew` walk).
  const aggregation = isRecord(payload.aggregationData) ? payload.aggregationData : {};
  drafts.push(
    ...membershipDrafts(observation, recordArray(aggregation.albumContent), vaultKind),
    ...fanslyRawMediaDrafts(observation),
  );

  // The roster LAST, after the rows it describes.
  drafts.push(listingDraft(
    observation,
    vaultKind === "creator" ? "vault_albums:creator" : "vault_albums:user",
    refs,
  ));
  return drafts;
}

/**
 * Album membership, from either shape: `aggregationData.albumContent[]` on the
 * uservault listing, or `albumMedia[]` on a `/media/vaultnew` page. The two
 * carry related, but not identical, keys. Live creator-vault rows name the raw
 * file with `mediaId` and carry no `mediaOfferId`; user-vault rows may carry
 * both. The file id is therefore the membership identity and the offer id is
 * optional metadata.
 *
 * Each source observation is a sighting: membership identity remains stable,
 * but a new title or a later sighting must not disappear behind binary dedup.
 */
function membershipDrafts(
  observation: CanonicalizableObservation,
  rows: readonly Record<string, unknown>[],
  vaultKind: VaultKind,
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  for (const row of rows) {
    const albumRef = asString(row.albumId);
    const mediaRef = asString(row.mediaId);
    if (albumRef === null || mediaRef === null) {
      continue;
    }
    const material = {
      vaultKind,
      albumRef,
      // Present on user-vault albumContent rows, absent on the live creator
      // vault walk. Never substitute mediaId: one raw file can back several
      // offers, so the ids are not interchangeable.
      mediaOfferRef: asString(row.mediaOfferId),
      // The membership row's OWN id — the vault walk's `before` cursor, and a
      // different value from `mediaOfferRef`.
      memberRef: asString(row.id),
      customFilename: typeof row.customFilename === "string" ? row.customFilename : null,
      mediaOfferType: asNumber(row.mediaOfferType),
      bundleRef: asString(row.mediaOfferBundleId),
      mediaRef,
      mediaType: asNumber(row.mediaType),
      previewRef: asString(row.previewId),
      // MILLISECONDS on this field.
      createdAtPlatform: msInstantIso(row.createdAt),
    };
    const hash = contentHash(material);
    drafts.push({
      type: "vault.album_membership_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: 3,
      dedupKey: `albummem:v3:${pageRef}:${vaultKind}:${albumRef}:${mediaRef}:${hash}:obs:${observation.id}`,
    });
  }
  return drafts;
}

/**
 * `/media/vaultnew` — one page of one album's membership.
 *
 * `albumMedia[]` is membership; the technical allowlist reads raw `media[]`.
 * Offer and bundle sidecars reuse the existing media-plane event builder.
 * Signed locations and variants remain only in the retained capture body.
 */
function vaultMediaDrafts(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  const payload = observation.payload;
  if (!isRecord(payload)) {
    return [];
  }
  const drafts = [
    ...membershipDrafts(observation, recordArray(payload.albumMedia), "creator"),
    ...fanslyRawMediaDrafts(observation),
  ];
  const sources = mediaPlaneSources(payload);
  if (sources.media.length > 0 || sources.bundles.length > 0) {
    drafts.push(
      ...mediaObservedDrafts(observation, sources, buildMediaPlaneIndex(sources), "vault"),
    );
  }
  return drafts;
}

/**
 * `/account/media?ids=` and `/account/media/bundle?ids=` — the batch hydration.
 *
 * Both serve a BARE ARRAY of the same card shapes F0(b) already parses, so the
 * rows are wrapped into the envelope `mediaPlaneSources` expects and handed to
 * the SAME draft builder. Reimplementing the permission/sale/shape decoding
 * here would give `creator_media` a second writer with its own bugs.
 */
function accountMediaBatchDrafts(
  observation: CanonicalizableObservation,
  subject: "media" | "bundle",
): CanonicalEventDraft[] {
  const rows = envelopeArray(observation.payload);
  if (rows.length === 0) {
    return [];
  }
  const envelope = subject === "media"
    ? { accountMedia: rows }
    : { accountMediaBundles: rows };
  const sources = mediaPlaneSources(envelope);
  return [...mediaObservedDrafts(
    observation,
    sources,
    buildMediaPlaneIndex(sources),
    "account_media_batch",
  ), ...fanslyRawMediaDrafts({ ...observation, payload: envelope })];
}

// ── subscription tiers — FEAT-002 ────────────────────────────────────────────

/**
 * A plan's length in days.
 *
 * `billingCycle` FIRST, and that order is the correction: the plan document
 * names `plans[].duration`, and the live capture has no such key — all nine
 * observed plans carried `billingCycle` (30 / 60 / 90) instead. `duration` DOES
 * exist one level down, on `promos[]`, which is exactly how a reader ends up
 * writing the wrong field name. `duration` is still accepted as a fallback so a
 * provider rename is survivable without a code change.
 */
function planDurationDays(plan: Record<string, unknown>): number | null {
  return nonNegativeCount(plan.billingCycle) ?? nonNegativeCount(plan.duration);
}

function tierDrafts(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  const tierRefs: string[] = [];
  const planRefs: string[] = [];

  for (const tier of envelopeArray(observation.payload)) {
    const tierRef = asString(tier.id);
    if (tierRef === null) {
      continue;
    }
    tierRefs.push(tierRef);
    const plans = recordArray(tier.plans);
    const tierMaterial = {
      tierRef,
      ownerAccountRef: asString(tier.accountId),
      name: typeof tier.name === "string" ? tier.name : null,
      color: typeof tier.color === "string" ? tier.color : null,
      pos: asNumber(tier.pos),
      // `tier.price` — A BASE, NOT A PRICE. 5 000 on all five observed tiers
      // while their plans ranged 10 000 … 499 990. The name is the guardrail.
      basePriceMills: millsString(tier.price),
      maxSubscribers: nonNegativeCount(tier.maxSubscribers),
      subscriptionBenefits: Array.isArray(tier.subscriptionBenefits)
        ? tier.subscriptionBenefits
        : [],
      includedTierRefs: Array.isArray(tier.includedTierIds) ? tier.includedTierIds : [],
      // The served array, VERBATIM — the proof that the normalized rows below
      // dropped nothing on the way out.
      plans,
    };
    const tierHash = contentHash(tierMaterial);
    drafts.push({
      type: "subscription.tier_observed",
      occurredAt: observation.receivedAt,
      data: { ...tierMaterial, contentHash: tierHash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `tier:v1:${pageRef}:${tierRef}:${tierHash}`,
    });

    for (const plan of plans) {
      const planRef = asString(plan.id);
      if (planRef === null) {
        continue;
      }
      planRefs.push(planRef);
      const planMaterial = {
        tierRef,
        planRef,
        status: asNumber(plan.status),
        durationDays: planDurationDays(plan),
        // THE PRICE TRUTH (FEAT-002). Max observed live: 499 990.
        priceMills: millsString(plan.price),
        useAmounts: asNumber(plan.useAmounts),
        // Verbatim: a promo is money with a deadline, and it belongs with the
        // plan it discounts.
        promos: recordArray(plan.promos),
      };
      const planHash = contentHash(planMaterial);
      drafts.push({
        type: "subscription.tier_plan_observed",
        occurredAt: observation.receivedAt,
        data: { ...planMaterial, contentHash: planHash },
        schemaVersion: SCHEMA_VERSION,
        dedupKey: `tierplan:v1:${pageRef}:${tierRef}:${planRef}:${planHash}`,
      });
    }
  }

  drafts.push(listingDraft(observation, "subscription_tiers", tierRefs));
  drafts.push(listingDraft(observation, "subscription_tier_plans", planRefs));
  return drafts;
}

// ── gift codes ───────────────────────────────────────────────────────────────

/**
 * `original_price` is snake_case on the wire, amid otherwise camelCase keys —
 * the single most likely field in this package to be read by the wrong name and
 * come back a silent NULL. Both spellings are accepted; the served one wins.
 */
function giftCodeOriginalPriceMills(row: Record<string, unknown>): string | null {
  return millsString(row.original_price) ?? millsString(row.originalPrice);
}

function giftCodeDrafts(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  const refs: string[] = [];

  for (const row of envelopeArray(observation.payload)) {
    const codeRef = asString(row.id);
    if (codeRef === null) {
      continue;
    }
    refs.push(codeRef);
    const material = {
      codeRef,
      // The redeemable string. It is the page's OWN promo code, shown in the
      // creator's own UI — not a credential, and useless without the offer it
      // names.
      code: typeof row.code === "string" ? row.code : null,
      label: typeof row.label === "string" ? row.label : null,
      linkType: asNumber(row.type),
      status: asNumber(row.status),
      planRef: asString(row.planId),
      // What it costs today (0 on a full-comp code) …
      priceMills: millsString(row.price),
      // … and what it would have cost without it. NEVER summed with the
      // tracking half's revenue columns: different basis (§2.3).
      originalPriceMills: giftCodeOriginalPriceMills(row),
      durationDays: nonNegativeCount(row.duration),
      maxUses: nonNegativeCount(row.maxUses),
      uses: nonNegativeCount(row.uses),
      paymentMethodRequired: asNumber(row.paymentMethodRequired),
      newSubscribersOnly: asNumber(row.newSubscribersOnly),
      version: asNumber(row.version),
      // MILLISECONDS on all three.
      createdAtPlatform: msInstantIso(row.createdAt),
      startsAtPlatform: msInstantIso(row.startsAt),
      endsAtPlatform: msInstantIso(row.endsAt),
    };
    const hash = contentHash(material);
    drafts.push({
      type: "promo.gift_code_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `giftcode:v1:${pageRef}:${codeRef}:${hash}`,
    });
  }

  drafts.push(listingDraft(observation, "gift_codes", refs));
  return drafts;
}

// ── automated messages ───────────────────────────────────────────────────────

interface AutomationTemplate {
  parseOk: boolean;
  templateType: number | null;
  senderRef: string | null;
  messageText: string | null;
  attachmentRefs: Record<string, unknown>[];
}

/**
 * `messageTemplate` — a JSON OBJECT in all seven live values (verified
 * 2026-08-19). The superseded claim that it is a single-quoted Python-repr
 * pseudo-JSON STRING is refuted by the capture and withdrawn.
 *
 * The STRING branch survives anyway, covered by one fixture, because the March
 * corpus carried that shape and A27's caveat holds: one response is one example.
 * When the string is valid JSON it is parsed and `parseOk` stays TRUE — the
 * encoding changed, the content did not. When it is not, `parseOk` is FALSE and
 * the row lands with no `messageText`.
 *
 * That distinction is the whole reason `parse_ok` is a column: an automation
 * with no text and an automation whose text we could not read look identical in
 * storage, and only one of them is a bug worth chasing.
 */
export function parseAutomationTemplate(
  value: unknown,
  onFallback?: () => void,
): AutomationTemplate {
  const unparsed: AutomationTemplate = {
    parseOk: false,
    templateType: null,
    senderRef: null,
    messageText: null,
    attachmentRefs: [],
  };
  let template: unknown = value;
  if (typeof template === "string") {
    onFallback?.();
    try {
      template = JSON.parse(template);
    } catch {
      return unparsed;
    }
  }
  if (!isRecord(template)) {
    return unparsed;
  }
  return {
    parseOk: true,
    templateType: asNumber(template.type),
    senderRef: asString(template.senderId),
    messageText: typeof template.content === "string" ? template.content : null,
    // `[{contentType, contentId}]` — id-relations only, never a URL.
    attachmentRefs: recordArray(template.attachments),
  };
}

/**
 * `triggerMetadata` arrives as a JSON STRING (`{"subscriptionTierId": …}` on
 * the tier-triggered automations, `""` on the rest). Parsed when it is a valid
 * JSON object, `{"raw": …}` when it is a string that is not, `{}` when absent.
 * Nothing is dropped: this is the field where the platform's own encoding does
 * the hiding.
 */
export function parseAutomationTriggerMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return { raw: value };
  }
  if (value.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { raw: value };
  } catch {
    return { raw: value };
  }
}

function automationDrafts(
  observation: CanonicalizableObservation,
  context: CanonicalizeRunContext | undefined,
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  const refs: string[] = [];

  for (const row of envelopeArray(observation.payload)) {
    const automationRef = asString(row.id);
    if (automationRef === null) {
      continue;
    }
    refs.push(automationRef);
    const template = parseAutomationTemplate(row.messageTemplate, () => {
      context?.diagnostics?.record(FANSLY_AUTOMATION_TEMPLATE_FALLBACK_DIAGNOSTIC);
    });
    const material = {
      automationRef,
      // RAW platform code (3 and 15 observed live). Never a label.
      triggerType: asNumber(row.triggerType),
      triggerMetadata: parseAutomationTriggerMetadata(row.triggerMetadata),
      // Stored AS SERVED — the platform's own units, not converted.
      delaySeconds: nonNegativeCount(row.delay),
      cooldownSeconds: nonNegativeCount(row.cooldown),
      templateType: template.templateType,
      senderRef: template.senderRef,
      messageText: template.messageText,
      attachmentRefs: template.attachmentRefs,
      parseOk: template.parseOk,
    };
    const hash = contentHash(material);
    drafts.push({
      type: "automation.definition_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `automation:v1:${pageRef}:${automationRef}:${hash}`,
    });
  }

  drafts.push(listingDraft(observation, "automated_messages", refs));
  return drafts;
}

// ── walls ────────────────────────────────────────────────────────────────────

function wallDrafts(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  const refs: string[] = [];

  for (const row of envelopeArray(observation.payload)) {
    const wallRef = asString(row.id);
    if (wallRef === null) {
      continue;
    }
    refs.push(wallRef);
    const material = {
      wallRef,
      ownerAccountRef: asString(row.accountId),
      name: typeof row.name === "string" ? row.name : null,
      description: typeof row.description === "string" ? row.description : null,
      pos: asNumber(row.pos),
      // Two INDEPENDENT flags on the wire; a wall can be neither, and one
      // boolean would lose which of the two it was.
      mainWall: typeof row.mainWall === "boolean" ? row.mainWall : null,
      defaultWall: typeof row.defaultWall === "boolean" ? row.defaultWall : null,
      private: asNumber(row.private),
      metadata: isRecord(row.metadata)
        ? row.metadata
        : typeof row.metadata === "string" && row.metadata.length > 0
        ? { raw: row.metadata }
        : {},
    };
    const hash = contentHash(material);
    drafts.push({
      type: "page.wall_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `wall:v1:${pageRef}:${wallRef}:${hash}`,
    });
  }

  drafts.push(listingDraft(observation, "page_walls", refs));
  return drafts;
}

// ── the seam ─────────────────────────────────────────────────────────────────

/**
 * Shape gate. `false` leaves the row UNSTAMPED for a future parser instead of
 * consuming it with zero events — without it a drifted payload is
 * indistinguishable from a legitimately EMPTY listing, and "capture now, parse
 * later" quietly becomes "capture now, never parse".
 *
 * An EMPTY listing is deliberately parseable, and here it is load-bearing: the
 * empty roster is exactly what marks a page's last tier `missing_since`.
 */
export function canParseFanslyCatalogObservation(
  observation: Pick<CanonicalizableObservation, "kind" | "payload" | "accountId">,
): boolean {
  if (!CANONICALIZED_KIND_SET.has(observation.kind) || observation.accountId === null) {
    return false;
  }
  switch (observation.kind) {
    case "vault_albums":
    case "uservault_albums":
      return isRecord(observation.payload) && Array.isArray(observation.payload.albums);
    case "vault_media":
      return isRecord(observation.payload)
        && Array.isArray(observation.payload.albumMedia)
        // Empty is a valid exhausted page. A non-empty page is parseable only
        // when every membership has the identity the projector requires; this
        // is the row-level guard v1 lacked when it silently stamped live rows.
        && observation.payload.albumMedia.every((row) => (
          isRecord(row)
          && asString(row.albumId) !== null
          && asString(row.mediaId) !== null
        ));
    case "vault_album_walk_completed": {
      const p = observation.payload;
      return isRecord(p) && p.valid === true && p.vaultKind === "creator"
        && typeof p.walkRef === "string" && p.walkRef.length > 0
        && typeof p.albumRef === "string" && p.albumRef.length > 0
        && typeof p.startedAt === "string" && Number.isFinite(Date.parse(p.startedAt))
        && typeof p.completedAt === "string" && Date.parse(p.completedAt) >= Date.parse(p.startedAt)
        && Number.isSafeInteger(p.expectedCount) && Number(p.expectedCount) >= 0
        && Array.isArray(p.seenMediaRefs) && p.seenMediaRefs.every(x => typeof x === "string" && x.length > 0)
        && new Set(p.seenMediaRefs).size === p.expectedCount && p.seenMediaRefs.length === p.expectedCount
        && Array.isArray(p.observationRefs) && p.observationRefs.length === p.pages
        && Number.isSafeInteger(p.pages) && Number(p.pages) > 0
        && p.observationRefs.every(x => Number.isSafeInteger(x) && x > 0);
    }
    default:
      // The five array-shaped listings and the two batch routes. An object that
      // wraps its array is accepted too — `envelopeArray` reads either.
      return Array.isArray(observation.payload)
        || (isRecord(observation.payload)
          && Object.values(observation.payload).some((value) => Array.isArray(value)));
  }
}

export function canonicalizeFanslyCatalogObservation(
  observation: CanonicalizableObservation,
  context?: CanonicalizeRunContext,
): CanonicalEventDraft[] {
  if (observation.accountId === null) {
    return [];
  }
  switch (observation.kind) {
    case "vault_albums":
      return albumDrafts(observation, "creator");
    case "uservault_albums":
      return albumDrafts(observation, "user");
    case "vault_media":
      return vaultMediaDrafts(observation);
    case "vault_album_walk_completed": {
      if (!canParseFanslyCatalogObservation(observation) || !isRecord(observation.payload)) return [];
      const p = observation.payload;
      const data = {
        vaultKind: p.vaultKind, albumRef: p.albumRef, walkRef: p.walkRef,
        startedAt: p.startedAt, completedAt: p.completedAt, expectedCount: p.expectedCount,
        seenMediaRefs: p.seenMediaRefs, observationRefs: p.observationRefs, pages: p.pages,
        headRef: asString(p.headRef),
      };
      return [{ type: "vault.album_walk_completed", schemaVersion: 1,
        occurredAt: new Date(data.completedAt as string), data: { ...data, contentHash: contentHash(data) },
        dedupKey: `vaultwalk:v1:${observation.accountId}:${data.walkRef}` }];
    }
    case "subscription_tiers":
      return tierDrafts(observation);
    case "gift_codes":
      return giftCodeDrafts(observation);
    case "automated_messages":
      return automationDrafts(observation, context);
    case "account_walls":
      return wallDrafts(observation);
    case "account_media_batch":
      return accountMediaBatchDrafts(observation, "media");
    case "account_media_bundle_batch":
      return accountMediaBatchDrafts(observation, "bundle");
    default:
      return [];
  }
}
