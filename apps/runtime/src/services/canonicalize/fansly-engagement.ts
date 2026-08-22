// WP-F2 — the `fansly-engagement` canonicalizer family (v1, projection-only).
//
// TWO LAYERS, IN THIS ORDER, and the order is the whole design.
//
// LAYER 1 — `notification.observed`, ONE VERBATIM EVENT PER ROW, ALWAYS, FOR
// EVERY CODE, known or not. `platform_notifications` rebuilds from this event
// ALONE, so a code nobody can name today still reaches the table by replay when
// somebody names it tomorrow. (v1 of the plan had no such event, which meant an
// unknown code could never reach the table at all.)
//
// LAYER 2 — typed derivations IN ADDITION, never INSTEAD. A 2007 row emits its
// verbatim event AND a `media.purchase_notification_observed`; deleting the
// second changes what we can query, never what we hold.
//
// WHY THAT SPLIT EARNED ITSELF, in this exact family: `reference/fansly_api_spec.md`
// §3.1 was wrong on EIGHT of sixteen notification codes (A22-1), including BOTH
// purchase events — it filed Media Purchases under "PostLikeUndo/PostLikeRedo".
// A design that typed first and stored the typed result would have lost two live
// money streams into a like-noise bucket with no way back. Layer 1 means the
// labels being wrong cost labels.
//
// FOUR RULES, each with the cost of breaking it:
//
// 1. **TIME (§3.2b).** Every event here is RECEIPT-TIME: `occurredAt` is the
//    observation's `receivedAt`, and the provider instant is a typed field in
//    `data` AND part of the natural key. A receipt-time draft is by
//    construction inside `clampDraftOccurredAt`'s window, so an event from this
//    family can NEVER carry `occurredAtClamped` — its presence would prove the
//    family dated the draft at provider time after all, and a fixture asserts
//    exactly that. The failure it prevents is concrete: `domain_events` is
//    monthly-partitioned, and the deep backfill drafts notifications from
//    months whose partitions may be DETACHED. Dated at provider time they would
//    fail `ExecFindPartition` (23514) forever.
// 2. **CODES, NOT LABELS (A1, A22-2).** `rawTypeCode` travels through as the
//    integer the platform sent. An unrecognized code still emits its layer-1
//    event AND raises `fansly_notification_unknown_type` — journaled and
//    surfaced, never dropped, never absorbed into a neighbour's label.
// 3. **MONEY IS MILLS, THROUGH THE SHARED CONSTRUCTORS.** `accountMediaPrice`
//    is already mills on the wire ($80 ↔ 80 000, §2.3), and it travels as a
//    decimal STRING built by `millsFromInteger` — JSON cannot carry a bigint
//    and a float would re-open the 1000× footgun.
// 4. **NOTHING HERE WRITES A LIKE.** No layer-2 event names a liker, a like
//    state or `post_likes`. Zero live occurrences of 1002/2002/5003/1004/1005
//    in the 200-row census, and client code proves the CLIENT's intent, not the
//    SERVER's behaviour ([E4]). The v1 plan's "2007/2008 = media-like
//    undo/redo, flip post_likes.state" is refuted and deleted.
//
// SECONDS, NOT MILLISECONDS. `createdAt` and `acknowledgedAt` on a notification
// row are epoch SECONDS — verified across all 200 rows of the 2026-08-19
// capture. They are multiplied here, once, rather than sent through the
// <1e12 heuristic: a heuristic that guesses right today is a 1970 row the day
// the platform changes units, and this lane's rows are the ones nothing can
// re-fetch.

import { millsFromInteger } from "@agency_hub_core/shared";
import {
  fanslyNotificationConfidence,
  fanslyNotificationLabel,
  FANSLY_NOTIFICATION_LABEL_VERSION,
  isFanslyPurchaseNotificationType,
  isKnownFanslyNotificationType,
} from "@agency_hub_core/shared";

import {
  asNumber,
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
  type CanonicalizeRunContext,
} from "./types.ts";
import { contentHash } from "./sync-pull.ts";

export const FANSLY_ENGAGEMENT_CANONICALIZER_VERSION = 1;
const SCHEMA_VERSION = 1;

/** The `observations.kind` values this family claims. Registered in
 *  `observation-kinds.ts`; the ratchet fails otherwise. */
export const FANSLY_ENGAGEMENT_CANONICALIZED_KINDS = ["notifications"] as const;

const CANONICALIZED_KIND_SET: ReadonlySet<string> = new Set(
  FANSLY_ENGAGEMENT_CANONICALIZED_KINDS,
);

/** Raised for a code the label module cannot name. The ROW is still written. */
export const FANSLY_NOTIFICATION_UNKNOWN_TYPE_DIAGNOSTIC = "fansly_notification_unknown_type";

/** The event types this family emits. Every one is registered in
 *  `PROJECTION_ONLY_DOMAIN_EVENT_TYPES` — one decision, never two. */
export const FANSLY_ENGAGEMENT_EVENT_TYPES = [
  "notification.observed",
  "media.purchase_notification_observed",
  "engagement.notification_observed",
] as const;

function pageRefOf(observation: CanonicalizableObservation): string {
  return String(observation.accountId);
}

/**
 * Notification instants are epoch SECONDS. Returns null for anything that is
 * not a positive finite number — a fabricated 1970 is worse than an absent one.
 */
function secondsInstantIso(value: unknown): string | null {
  const raw = asNumber(value);
  if (raw === null || raw <= 0) {
    return null;
  }
  // Truncate rather than round: the wire carries whole seconds, and rounding a
  // scaled value is the shape the money-float ratchet hunts for — this is time,
  // and it should not look like a unit conversion.
  return new Date(Math.trunc(raw) * 1000).toISOString();
}

/**
 * `metadata` arrives as a JSON **string** on the wire — or as `null`, or (per
 * A27's standing caveat that one response is one example) as anything else the
 * platform decides to send.
 *
 * Parsed when it is valid JSON *object*; `{"raw": "<the string>"}` when it is a
 * string that is not; `{}` when it is absent. A string that parses to a scalar
 * (`"5"`, `"true"`) is ALSO wrapped as raw: a metadata column holding `5` would
 * be a shape no consumer can join on, and the string is preserved either way.
 * Nothing is ever dropped — this is the one field where the platform's own
 * encoding is doing the hiding.
 */
export function parseNotificationMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  if (isRecord(value)) {
    // Already an object: the platform may serve it un-stringified one day.
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

/**
 * The price a purchase notification carries, in MILLS, as a decimal string.
 *
 * `accountMediaPrice` is already mills on the wire: the UI rendered "$80" and
 * "$50" against 80 000 and 50 000 (§2.3). Refuses anything that is not a
 * non-negative safe integer — a fractional or negative "price" is provider
 * drift, and a plausible-looking rounded number is worse than an honest null.
 */
export function purchasePriceMills(metadata: Record<string, unknown>): string | null {
  const value = metadata.accountMediaPrice;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return millsFromInteger(value).toString();
}

interface NotificationRowFacts {
  notificationRef: string;
  rawTypeCode: number;
  correlationRef: string | null;
  correlationGroupRef: string | null;
  metadataJson: Record<string, unknown>;
  occurredAtSeconds: string | null;
  acknowledgedAtSeconds: string | null;
}

function readRow(row: Record<string, unknown>): NotificationRowFacts | null {
  // `idString` is the platform's own precision-safe form; `id` is the same
  // value. Either is accepted, neither is invented.
  const notificationRef = asString(row.idString) ?? asString(row.id);
  const rawTypeCode = asNumber(row.type);
  if (notificationRef === null || rawTypeCode === null || !Number.isSafeInteger(rawTypeCode)) {
    // No id or no type is not a notification; it is a shape we do not
    // recognize, and the verbatim body is still in the journal for a parser
    // that does.
    return null;
  }
  return {
    notificationRef,
    rawTypeCode,
    correlationRef: asString(row.correlationId),
    correlationGroupRef: asString(row.correlationGroupId),
    metadataJson: parseNotificationMetadata(row.metadata),
    occurredAtSeconds: secondsInstantIso(row.createdAt),
    acknowledgedAtSeconds: secondsInstantIso(row.acknowledgedAt),
  };
}

/** Captured Fansly shapes use the group field for the actor. Follow code 3002
 * is the one documented exception and carries the actor in correlationId. */
function notificationActorRef(facts: NotificationRowFacts): string | null {
  return facts.rawTypeCode === 3002 ? facts.correlationRef : facts.correlationGroupRef;
}

function notificationDrafts(
  observation: CanonicalizableObservation,
  context?: CanonicalizeRunContext,
): CanonicalEventDraft[] {
  const payload = observation.payload;
  if (!isRecord(payload) || !Array.isArray(payload.notifications)) {
    return [];
  }
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];

  for (const raw of payload.notifications) {
    if (!isRecord(raw)) {
      continue;
    }
    const facts = readRow(raw);
    if (facts === null) {
      continue;
    }
    const known = isKnownFanslyNotificationType(facts.rawTypeCode);
    if (!known) {
      // A1: the row is written ANYWAY. The anomaly is how a new code becomes
      // visible; dropping it would make a platform change look like silence.
      context?.diagnostics?.record(FANSLY_NOTIFICATION_UNKNOWN_TYPE_DIAGNOSTIC);
    }

    // ── LAYER 1: verbatim, always ────────────────────────────────────────────
    const material = {
      notificationRef: facts.notificationRef,
      rawTypeCode: facts.rawTypeCode,
      correlationRef: facts.correlationRef,
      correlationGroupRef: facts.correlationGroupRef,
      metadataJson: facts.metadataJson,
      occurredAtSeconds: facts.occurredAtSeconds,
      acknowledgedAtSeconds: facts.acknowledgedAtSeconds,
      mappingVersion: FANSLY_NOTIFICATION_LABEL_VERSION,
      knownType: known,
    };
    const hash = contentHash(material);
    drafts.push({
      type: "notification.observed",
      // RECEIPT TIME. The provider instant is `occurredAtSeconds`, above.
      occurredAt: observation.receivedAt,
      fanIdentityRef: notificationActorRef(facts),
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `notif:v1:${pageRef}:${facts.notificationRef}:${hash}`,
    });

    if (!known) {
      // An unnameable code gets its verbatim row and its anomaly, and NOTHING
      // typed. Inventing a derivation for a code we cannot name is exactly the
      // mistake the spec made on eight codes.
      continue;
    }

    // ── LAYER 2: typed derivations, IN ADDITION ─────────────────────────────
    const label = fanslyNotificationLabel(facts.rawTypeCode);
    const confidence = fanslyNotificationConfidence(facts.rawTypeCode);

    if (isFanslyPurchaseNotificationType(facts.rawTypeCode)) {
      // MONEY. 2007 is `confirmed` (UI↔payload match); 2008, 32007 and 45012
      // are `inferred` from the client's own filter declarations, and the
      // confidence rides IN the event so a consumer can weigh it without
      // re-deriving the table.
      const purchaseMaterial = {
        notificationRef: facts.notificationRef,
        rawTypeCode: facts.rawTypeCode,
        label,
        confidence,
        correlationRef: facts.correlationRef,
        // NULL when the platform served no price. Never 0 — a free purchase
        // and an unserved price are different facts.
        priceMills: purchasePriceMills(facts.metadataJson),
        occurredAtSeconds: facts.occurredAtSeconds,
        mappingVersion: FANSLY_NOTIFICATION_LABEL_VERSION,
      };
      const purchaseHash = contentHash(purchaseMaterial);
      drafts.push({
        type: "media.purchase_notification_observed",
        occurredAt: observation.receivedAt,
        fanIdentityRef: notificationActorRef(facts),
        data: { ...purchaseMaterial, contentHash: purchaseHash },
        schemaVersion: SCHEMA_VERSION,
        dedupKey: `notifpurchase:v1:${pageRef}:${facts.notificationRef}:${purchaseHash}`,
      });
      continue;
    }

    // Everything else the label module can name: follows, tips, subscription
    // family, replies, quotes, likes, the Fansly alert band. TYPED FIELDS ONLY
    // WHERE CONFIRMED — which today is nowhere in this branch, so the event
    // carries the code, the label, the confidence and the correlation refs and
    // claims no field-level semantics at all.
    const engagementMaterial = {
      notificationRef: facts.notificationRef,
      rawTypeCode: facts.rawTypeCode,
      label,
      confidence,
      correlationRef: facts.correlationRef,
      correlationGroupRef: facts.correlationGroupRef,
      occurredAtSeconds: facts.occurredAtSeconds,
      mappingVersion: FANSLY_NOTIFICATION_LABEL_VERSION,
    };
    const engagementHash = contentHash(engagementMaterial);
    drafts.push({
      type: "engagement.notification_observed",
      occurredAt: observation.receivedAt,
      fanIdentityRef: notificationActorRef(facts),
      data: { ...engagementMaterial, contentHash: engagementHash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `notifengagement:v1:${pageRef}:${facts.notificationRef}:${engagementHash}`,
    });
  }

  return drafts;
}

/**
 * Shape gate. `false` leaves the row UNSTAMPED for a future parser instead of
 * consuming it with zero events — without it a drifted payload is
 * indistinguishable from a legitimately EMPTY page, and "capture now, parse
 * later" quietly becomes "capture now, never parse".
 *
 * An EMPTY page is deliberately parseable: the empty page at the end of the
 * deep backfill IS the retention-floor evidence, and refusing to stamp it would
 * make the sweep re-read it forever.
 */
export function canParseFanslyEngagementObservation(
  observation: Pick<CanonicalizableObservation, "kind" | "payload" | "accountId">,
): boolean {
  if (!CANONICALIZED_KIND_SET.has(observation.kind) || observation.accountId === null) {
    return false;
  }
  return isRecord(observation.payload) && Array.isArray(observation.payload.notifications);
}

export function canonicalizeFanslyEngagementObservation(
  observation: CanonicalizableObservation,
  context?: CanonicalizeRunContext,
): CanonicalEventDraft[] {
  if (observation.accountId === null) {
    return [];
  }
  switch (observation.kind) {
    case "notifications":
      return notificationDrafts(observation, context);
    default:
      return [];
  }
}
