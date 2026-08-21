// Sync-pull family canonicalizer (Stage 8). Reads the JOURNALED page payloads
// (observation kind = fetch endpoint). Declared coverage this version:
//
//   earnings_transactions (fansly)  → transaction.posted per item
//   dm_messages (onlyfans/OFAPI)    → message.received/sent per item — the
//                                     REST item id equals the webhook message
//                                     id, so the dedup key collides with the
//                                     webhook event (the cross-producer proof)
//
// Deliberately UNDECLARED (observations wait at parse_version 0 for a later
// canonicalizer version — capture now, parse later):
//   (v2) fansly dm_messages now DECLARED: direction resolves against the
//   per-run page->native-ref context map (see SyncPullCanonicalizeContext).
//   - onlymonster_* pages: the vendor is being retired (Stage 15); zero rows
//     in production since #67.
//   - subscribers/followers/identity/audience pages: next canonicalizer
//     version; their observations are already journaled and replayable.

import { createHash } from "node:crypto";

import { millsFromInteger } from "@agency_hub_core/shared";

import {
  asDate,
  asFanslyTimestamp,
  asNumber,
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
} from "./types.ts";

// v5 (WP-F0(b)): the SAME dm_messages / purchase_history observations now also
// yield the media plane — what was offered, at what price, and who bought it.
// Those four types are PROJECTION-ONLY riding a DELIVERABLE family, which is
// why the family declares `mixed: true` (§3.2a) and why bumping this constant
// re-parses months of already-journaled DM history (drafts dedupe; the rows are
// re-read and re-stamped). No flag gates emission: the driver stamps an
// observation whether or not the family produced events, so a flag-off family
// would consume its corpus irreversibly.
export const SYNC_PULL_CANONICALIZER_VERSION = 5;

/** Per-run context: page -> own platform-native account id. Direction of a
 *  Fansly DM (sent vs received) is decidable only against the page's OWN
 *  account ref; the sweep builds this once per run — the canonicalizer
 *  itself stays pure. */
export interface SyncPullCanonicalizeContext {
  nativeAccountRefByAccountId: ReadonlyMap<number, string | null>;
}

export const SYNC_PULL_CANONICALIZED_KINDS: ReadonlySet<string> = new Set([
  "earnings_transactions",
  "dm_messages",
  // v3 (Stage 16 parse side): shapes derived from the extension's
  // production-proven parsers (chatgoose shared/types.ts) — the ramp
  // VERIFIES rather than discovers; units confirmed mills by core's own
  // treatment of the same endpoint family (executor-handlers totalGross).
  "fan_earnings_stats",
  "fan_earnings_monthly",
  "purchase_history",
]);

function fanslyEarningsTransactions(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const data = observation.payload.data;
  if (!Array.isArray(data)) {
    return [];
  }

  const events: CanonicalEventDraft[] = [];
  for (const item of data) {
    if (!isRecord(item)) {
      continue;
    }
    const transactionId = asString(item.transactionId);
    if (!transactionId) {
      continue;
    }
    events.push({
      type: "transaction.posted",
      occurredAt: asDate(item.createdAt, observation.receivedAt),
      fanIdentityRef: asString(item.correlationAccountId) ?? asString(item.senderId),
      transactionRef: transactionId,
      data: {
        rawType: asNumber(item.type),
        amount: asNumber(item.amount),
        // A46 (W8.2, forward-only): Fansly amounts are MILLS; the OFAPI
        // transaction.posted twin carries DOLLARS (float). Declared on
        // newly-emitted events only — pre-fix events are immutable facts,
        // so consumers reading historical rows must keep branching on
        // platform (fansly → mills, onlyfans → dollars) when amountUnit is
        // absent. No family version bump: a replay would only dedupe
        // (txn:<id> keys), never rewrite the existing rows.
        amountUnit: "mills",
        destinationAmount: asNumber(item.destinationAmount),
        destinationTax: asNumber(item.destinationTax),
        status: asNumber(item.status),
        walletId: asString(item.walletId),
      },
      schemaVersion: 1,
      dedupKey: `txn:${transactionId}`,
    });
  }
  return events;
}

function ofapiRestMessages(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const items = observation.payload.items;
  if (!Array.isArray(items)) {
    return [];
  }

  const events: CanonicalEventDraft[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const messageId = asString(item.id);
    if (!messageId) {
      continue;
    }
    const fromUser = isRecord(item.fromUser) ? item.fromUser : {};
    const senderId = asString(fromUser.id);
    const direction = item.isSentByMe === true ? "sent" : "received";
    events.push({
      type: `message.${direction}`,
      occurredAt: asDate(item.createdAt, observation.receivedAt),
      // For sent messages the payload names only the sender (the model); the
      // fan is the conversation partner, known to the webhook-side event this
      // one dedupes against — null here is honest, not lossy.
      fanIdentityRef: direction === "received" ? senderId : null,
      conversationRef: direction === "received" ? senderId : null,
      messageRef: messageId,
      data: {
        text: asString(item.text),
        price: asNumber(item.price),
        isTip: item.isTip === true,
        isFree: item.isFree === true,
      },
      schemaVersion: 1,
      dedupKey: `msg:${direction}:${messageId}`,
    });
  }
  return events;
}

function fanslyDmMessages(
  observation: CanonicalizableObservation,
  context: SyncPullCanonicalizeContext | undefined,
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload) || observation.accountId == null) {
    return [];
  }
  const ownRef = context?.nativeAccountRefByAccountId.get(observation.accountId) ?? null;
  if (ownRef === null) {
    // Undecidable without the page's own account ref. Rare (every live page
    // carries one); such rows stamp with zero events and are recoverable via
    // events:replay --parse-version once the mapping lands (recorded edge).
    return [];
  }
  const messages = observation.payload.messages;
  if (!Array.isArray(messages)) {
    return [];
  }

  const events: CanonicalEventDraft[] = [];
  for (const item of messages) {
    if (!isRecord(item)) {
      continue;
    }
    const messageId = asString(item.id);
    if (!messageId) {
      continue;
    }
    const senderId = asString(item.senderId);
    const direction = senderId !== null && senderId === ownRef ? "sent" : "received";
    // Fansly DM tip totals arrive in MILLS (normalizeDmTipAmountCents ÷10
    // precedent); keep mills in the event data.
    const tipMills = asNumber(item.totalTipAmount);
    events.push({
      type: `message.${direction}`,
      // Fansly DM createdAt arrives in epoch SECONDS (fixture-proven); the
      // bare asDate treated it as ms → 1970 events in the pre_2024 partition
      // (audit known finding #2). The heuristic conversion matches the
      // hot-table path (normalizeFanslyTimestamp). Historical 1970 events
      // are healed by the events:repair-fansly-1970 superseding campaign —
      // replay alone cannot heal (the msg dedup key drops re-emissions).
      occurredAt: asFanslyTimestamp(item.createdAt, observation.receivedAt),
      fanIdentityRef: direction === "received" ? senderId : null,
      conversationRef: asString(item.groupId),
      messageRef: messageId,
      data: {
        text: asString(item.content),
        tipAmountMills: tipMills !== null && tipMills > 0 ? Math.round(tipMills) : 0,
        isTip: tipMills !== null && tipMills > 0,
      },
      schemaVersion: 1,
      dedupKey: `msg:${direction}:${messageId}`,
    });
  }
  events.push(...fanslyPurchaseEvents(observation));
  // v5: the same observation also carries the media plane. These are
  // projection-only types on a deliverable family — the mixed append (§3.2a)
  // is what makes that legal.
  events.push(...fanslyMediaPlaneEvents(observation, { origin: "dm_sidecar", ownRef }));
  return events;
}

export function canonicalizeSyncPullObservation(
  observation: CanonicalizableObservation,
  context?: SyncPullCanonicalizeContext,
): CanonicalEventDraft[] {
  switch (observation.kind) {
    case "earnings_transactions":
      return observation.platform === "fansly" ? fanslyEarningsTransactions(observation) : [];
    case "dm_messages":
      if (observation.platform === "onlyfans") {
        return ofapiRestMessages(observation);
      }
      return observation.platform === "fansly" ? fanslyDmMessages(observation, context) : [];
    case "fan_earnings_stats":
      return observation.platform === "fansly" ? fanslyEarningsObserved(observation, false) : [];
    case "fan_earnings_monthly":
      return observation.platform === "fansly" ? fanslyEarningsObserved(observation, true) : [];
    case "purchase_history":
      return observation.platform === "fansly"
        ? fanslyPurchaseHistory(observation, context)
        : [];
    default:
      return [];
  }
}

interface EarningsAggregate {
  grossMills: number;
  netMills: number;
  breakdown: Array<{ type: number | null; grossMills: number; netMills: number }>;
}

// Deep key-sorted copy: a replacer-array JSON.stringify would WHITELIST keys
// recursively and silently drop nested fields (breakdown[].type) from the
// hash — a snapshot differing only there would wrongly dedupe to nothing.
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])]),
    );
  }
  return value;
}

function stableHash(value: unknown): string {
  // Order-independent content hash so an unchanged snapshot re-fetch
  // produces the same dedup key (spec: no new event on identical stats).
  const canonical = JSON.stringify(canonicalJson(value));
  let hash = 0;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = (hash * 31 + canonical.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** Both earnings kinds: rows aggregate per (fan, window); window = 'lifetime'
 *  for the stats snapshot, 'YYYY-MM' for monthly rows. Amounts are MILLS. */
function fanslyEarningsObserved(
  observation: CanonicalizableObservation,
  monthly: boolean,
): CanonicalEventDraft[] {
  const rows = Array.isArray(observation.payload) ? observation.payload : null;
  if (!rows) {
    return [];
  }

  const perKey = new Map<string, { fan: string; window: string; aggregate: EarningsAggregate }>();
  const poisonedKeys = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const fan = asString(row.correlationAccountId);
    if (!fan) {
      continue;
    }
    let window = "lifetime";
    if (monthly) {
      const year = asNumber(row.year);
      const month = asNumber(row.month);
      if (
        year === null ||
        month === null ||
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        year < 2000 ||
        year > 2200 ||
        month < 1 ||
        month > 12
      ) {
        continue;
      }
      window = `${year}-${String(month).padStart(2, "0")}`;
    }
    // A missing amount is provider-contract drift, not a real zero. The raw
    // observation remains durable for replay after a parser repair, but it
    // must not mint a plausible-looking zero snapshot into the money plane.
    const gross = asNumber(row.totalGross);
    const net = asNumber(row.totalNet);
    const key = `${fan}:${window}`;
    if (poisonedKeys.has(key)) {
      continue;
    }
    if (
      gross === null ||
      net === null ||
      !Number.isSafeInteger(gross) ||
      !Number.isSafeInteger(net)
    ) {
      // One malformed breakdown row invalidates the whole fan/window. Keeping
      // the other rows would mint a plausible but understated money snapshot.
      poisonedKeys.add(key);
      continue;
    }
    const entry = perKey.get(key) ?? {
      fan,
      window,
      aggregate: { grossMills: 0, netMills: 0, breakdown: [] },
    };
    const nextGrossMills = entry.aggregate.grossMills + gross;
    const nextNetMills = entry.aggregate.netMills + net;
    if (
      !Number.isSafeInteger(nextGrossMills) ||
      !Number.isSafeInteger(nextNetMills)
    ) {
      poisonedKeys.add(key);
      continue;
    }
    entry.aggregate.grossMills = nextGrossMills;
    entry.aggregate.netMills = nextNetMills;
    entry.aggregate.breakdown.push({
      type: asNumber(row.type),
      grossMills: gross,
      netMills: net,
    });
    perKey.set(key, entry);
  }

  const events: CanonicalEventDraft[] = [];
  for (const [key, { fan, window, aggregate }] of perKey) {
    if (poisonedKeys.has(key)) {
      continue;
    }
    events.push({
      type: "fan.earnings_observed",
      occurredAt: observation.observedAt ?? observation.receivedAt,
      fanIdentityRef: fan,
      data: {
        window,
        grossMills: aggregate.grossMills,
        netMills: aggregate.netMills,
        breakdown: aggregate.breakdown,
      },
      schemaVersion: 1,
      // Content-hashed: an unchanged snapshot re-fetch dedupes to nothing.
      dedupKey: `fan_earnings:${fan}:${window}:${stableHash(aggregate)}`,
    });
  }
  return events;
}

/** Inline DM order rows may omit orderId, while paginated order-history rows
 *  expose it as their cursor. Keep the historical composite dedup key for
 *  replay compatibility across both shapes. */
function fanslyPurchaseEvents(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const aggregation = isRecord(observation.payload.aggregationData)
    ? observation.payload.aggregationData
    : {};
  const rows = Array.isArray(observation.payload.accountMediaOrderHistory)
    ? observation.payload.accountMediaOrderHistory
    : Array.isArray(observation.payload.accountMediaOrders)
      ? observation.payload.accountMediaOrders
    : Array.isArray(aggregation.accountMediaOrders)
      ? aggregation.accountMediaOrders
      : null;
  if (!rows) {
    return [];
  }

  const events: CanonicalEventDraft[] = [];
  const dedupKeys = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const fan = asString(row.accountId);
    const mediaRef = asString(row.accountMediaBundleId) ?? asString(row.accountMediaId);
    if (!fan || !mediaRef) {
      continue;
    }
    // Production order rows use epoch SECONDS (verified against captured DM
    // observations). Treating them as milliseconds would silently materialize
    // PPV unlocks in 1970.
    const occurredAt = asFanslyTimestamp(row.createdAt, observation.receivedAt);
    const dedupKey = `ppv:${fan}:${mediaRef}:${occurredAt.toISOString()}`;
    if (dedupKeys.has(dedupKey)) {
      continue;
    }
    dedupKeys.add(dedupKey);
    events.push({
      type: "message.ppv_unlocked",
      occurredAt,
      fanIdentityRef: fan,
      data: {
        accountMediaId: asString(row.accountMediaId),
        accountMediaBundleId: asString(row.accountMediaBundleId),
        orderType: asNumber(row.type),
      },
      schemaVersion: 1,
      dedupKey,
    });
  }
  return events;
}

// ── WP-F0(b): the media plane ───────────────────────────────────────────────
//
// The journaled DM/purchase responses have always carried `attachments[]`,
// `accountMedia[]` with `permissions.permissionFlags[].price`, `saleStats`,
// `accountMediaBundles[]` and `accountMediaOrders[]`. v4 read the order rows
// alone (message.ppv_unlocked). v5 reads the rest.
//
// THREE THINGS THAT ARE EASY TO GET WRONG AND ARE PINNED BY TESTS:
//
// 1. TIME. media/order/attachment events are RECEIPT-TIME (§3.2b): occurredAt
//    is the observation's receivedAt and the provider instant is a typed field
//    in `data`. They can therefore never carry a clamp marker — its presence
//    would prove the family dated the draft at provider time after all. Only
//    `message.material_observed` is provider-dated (the archive's occurred_at
//    IS the message time), which is exactly why the append-side partition
//    census exists.
// 2. MONEY. Fansly prices are MILLS on the wire. They travel as decimal
//    STRINGS through `millsFromInteger` — the same convention the OFAPI
//    material head uses — because JSON.stringify cannot serialize a bigint and
//    a float would re-open the 1000x footgun. `saleStats.total` is NET (A12);
//    a sparse saleStats yields NULL, never 0.
// 3. COEXISTENCE. `message.ppv_unlocked` keeps running unchanged, keyed by
//    `ppv:<fan>:<mediaRef>:<ts>`. `media.order_observed` is the ORDER-identity
//    lane feeding media_orders. They describe one purchase from two
//    identities and are NEVER summed.

const MEDIA_PLANE_SCHEMA_VERSION = 1;

/** Deep, key-sorted sha256 of the material a row carries — the dedup key's
 *  changing half. An unchanged re-fetch produces the same key and appends
 *  nothing; a changed price or sale counter mints exactly one new event. */
function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}

/** Wire mills → decimal string, or null. Refuses anything that is not a
 *  non-negative safe integer: a negative or fractional "price" is provider
 *  drift, and a plausible-looking rounded number is worse than an honest null. */
function millsString(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return millsFromInteger(value).toString();
}

function nonNegativeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The three sidecar arrays, wherever this response carries them: inline on
 *  the DM page, or under aggregationData on the purchase-history shapes. */
function mediaPlaneSources(payload: Record<string, unknown>) {
  const aggregation = isRecord(payload.aggregationData) ? payload.aggregationData : {};
  const media = recordArray(payload.accountMedia).length > 0
    ? recordArray(payload.accountMedia)
    : recordArray(aggregation.accountMedia);
  const bundles = recordArray(payload.accountMediaBundles).length > 0
    ? recordArray(payload.accountMediaBundles)
    : recordArray(aggregation.accountMediaBundles);
  const orders = recordArray(payload.accountMediaOrderHistory).length > 0
    ? recordArray(payload.accountMediaOrderHistory)
    : recordArray(payload.accountMediaOrders).length > 0
    ? recordArray(payload.accountMediaOrders)
    : recordArray(aggregation.accountMediaOrders);
  return { media, bundles, orders, messages: recordArray(payload.messages) };
}

interface PermissionSummary {
  /** EVERY permissions.permissionFlags[] row, verbatim — a media row can carry
   *  several prices (tier-gated, promo, verification-gated) and picking one
   *  silently would invent a winner. */
  entries: Record<string, unknown>[];
  /** The primary entry's price: the first entry that names one. */
  priceMills: string | null;
}

function permissionSummary(row: Record<string, unknown>): PermissionSummary {
  const permissions = isRecord(row.permissions) ? row.permissions : {};
  const entries = recordArray(permissions.permissionFlags);
  let priceMills: string | null = null;
  for (const entry of entries) {
    const price = millsString(entry.price);
    if (price !== null) {
      priceMills = price;
      break;
    }
  }
  return { entries, priceMills: priceMills ?? millsString(row.price) };
}

interface SaleSummary {
  salesCount: number | null;
  salesNetMills: string | null;
  salesPendingMills: string | null;
}

/** A12: `saleStats.total` is what the creator KEEPS (net), not the gross the
 *  fan paid. An absent saleStats is NULL everywhere — "not served", not zero. */
function saleSummary(row: Record<string, unknown>): SaleSummary {
  const stats = isRecord(row.saleStats) ? row.saleStats : null;
  if (stats === null) {
    return { salesCount: null, salesNetMills: null, salesPendingMills: null };
  }
  return {
    salesCount: nonNegativeCount(stats.sales),
    salesNetMills: millsString(stats.total),
    salesPendingMills: millsString(stats.pending),
  };
}

/** Shape/mime/duration only. The `media` object also carries `location`,
 *  `locations[]` and every `variants[]` entry — signed CDN URLs that stay
 *  raw-journal-only and never enter an event or a projection. */
function mediaShape(row: Record<string, unknown>) {
  const media = isRecord(row.media) ? row.media : null;
  if (media === null) {
    return { mediaType: null, mimeType: null, width: null, height: null, durationMs: null };
  }
  let durationMs: number | null = null;
  if (typeof media.metadata === "string" && media.metadata.length > 0) {
    try {
      const metadata: unknown = JSON.parse(media.metadata);
      const seconds = isRecord(metadata) ? metadata.duration : null;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
        durationMs = Math.trunc(seconds * 1000);
      }
    } catch {
      // A metadata blob we cannot read is not a parse failure: the row still
      // carries its identity, price and sale counters.
    }
  }
  return {
    mediaType: asNumber(media.type),
    mimeType: asString(media.mimetype),
    width: asNumber(media.width),
    height: asNumber(media.height),
    durationMs,
  };
}

interface MediaPlaneIndex {
  mediaById: Map<string, Record<string, unknown>>;
  bundleById: Map<string, Record<string, unknown>>;
  bundleRefsByMediaRef: Map<string, string[]>;
  buyerRefsBySubjectRef: Map<string, string[]>;
}

function bundleMemberRefs(bundle: Record<string, unknown>): string[] {
  const ids = Array.isArray(bundle.accountMediaIds)
    ? bundle.accountMediaIds.flatMap((value) => {
      const ref = asString(value);
      return ref === null ? [] : [ref];
    })
    : [];
  if (ids.length > 0) {
    return ids;
  }
  return recordArray(bundle.bundleContent).flatMap((entry) => {
    const ref = asString(entry.accountMediaId);
    return ref === null ? [] : [ref];
  });
}

function buildMediaPlaneIndex(sources: ReturnType<typeof mediaPlaneSources>): MediaPlaneIndex {
  const mediaById = new Map<string, Record<string, unknown>>();
  for (const row of sources.media) {
    const ref = asString(row.id);
    if (ref !== null) {
      mediaById.set(ref, row);
    }
  }
  const bundleById = new Map<string, Record<string, unknown>>();
  const bundleRefsByMediaRef = new Map<string, string[]>();
  for (const bundle of sources.bundles) {
    const bundleRef = asString(bundle.id);
    if (bundleRef === null) {
      continue;
    }
    bundleById.set(bundleRef, bundle);
    for (const memberRef of bundleMemberRefs(bundle)) {
      const refs = bundleRefsByMediaRef.get(memberRef) ?? [];
      if (!refs.includes(bundleRef)) {
        refs.push(bundleRef);
      }
      bundleRefsByMediaRef.set(memberRef, refs);
    }
  }
  const buyerRefsBySubjectRef = new Map<string, string[]>();
  for (const order of sources.orders) {
    const buyer = asString(order.accountId);
    if (buyer === null) {
      continue;
    }
    for (const subject of [asString(order.accountMediaId), asString(order.accountMediaBundleId)]) {
      if (subject === null) {
        continue;
      }
      const buyers = buyerRefsBySubjectRef.get(subject) ?? [];
      if (!buyers.includes(buyer)) {
        buyers.push(buyer);
      }
      buyerRefsBySubjectRef.set(subject, buyers);
    }
  }
  return { mediaById, bundleById, bundleRefsByMediaRef, buyerRefsBySubjectRef };
}

function mediaObservedDrafts(
  observation: CanonicalizableObservation,
  sources: ReturnType<typeof mediaPlaneSources>,
  index: MediaPlaneIndex,
  origin: string,
): CanonicalEventDraft[] {
  const pageRef = String(observation.accountId);
  const drafts: CanonicalEventDraft[] = [];

  for (const row of sources.media) {
    const mediaOfferRef = asString(row.id);
    if (mediaOfferRef === null) {
      continue;
    }
    const permissions = permissionSummary(row);
    const sales = saleSummary(row);
    const shape = mediaShape(row);
    const material = {
      subject: "media" as const,
      mediaOfferRef,
      ownerAccountRef: asString(row.accountId),
      mediaRef: asString(row.mediaId),
      previewRef: asString(row.previewId),
      bundleRefs: index.bundleRefsByMediaRef.get(mediaOfferRef) ?? [],
      ...shape,
      priceMills: permissions.priceMills,
      permissionEntries: permissions.entries,
      permissionFlags: asNumber(row.permissionFlags),
      likeCount: nonNegativeCount(row.likeCount),
      ...sales,
      // The provider instants live HERE, typed — never in occurredAt (§3.2b).
      createdAtPlatform: fanslyInstantIso(row.createdAt),
      deletedAtPlatform: fanslyInstantIso(row.deletedAt),
      servedPurchased: typeof row.purchased === "boolean" ? row.purchased : null,
      servedAccess: typeof row.access === "boolean" ? row.access : null,
      firstOrigin: origin,
    };
    const hash = contentHash(material);
    drafts.push({
      type: "media.observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: MEDIA_PLANE_SCHEMA_VERSION,
      dedupKey: `media:v1:${pageRef}:${mediaOfferRef}:${hash}`,
    });
  }

  for (const bundle of sources.bundles) {
    const bundleRef = asString(bundle.id);
    if (bundleRef === null) {
      continue;
    }
    const permissions = permissionSummary(bundle);
    const sales = saleSummary(bundle);
    const material = {
      subject: "bundle" as const,
      bundleRef,
      ownerAccountRef: asString(bundle.accountId),
      previewRef: asString(bundle.previewId),
      memberRefs: bundleMemberRefs(bundle),
      memberPositions: recordArray(bundle.bundleContent),
      priceMills: permissions.priceMills,
      permissionEntries: permissions.entries,
      permissionFlags: asNumber(bundle.permissionFlags),
      ...sales,
      createdAtPlatform: fanslyInstantIso(bundle.createdAt),
      deletedAtPlatform: fanslyInstantIso(bundle.deletedAt),
      servedPurchased: typeof bundle.purchased === "boolean" ? bundle.purchased : null,
      servedAccess: typeof bundle.access === "boolean" ? bundle.access : null,
      firstOrigin: origin,
    };
    const hash = contentHash(material);
    drafts.push({
      type: "media.observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: MEDIA_PLANE_SCHEMA_VERSION,
      dedupKey: `mediabundle:v1:${pageRef}:${bundleRef}:${hash}`,
    });
  }

  return drafts;
}

/** Fansly instants are epoch SECONDS on these rows; null stays null so a
 *  missing timestamp never becomes 1970. */
function fanslyInstantIso(value: unknown): string | null {
  const seconds = asNumber(value);
  if (seconds === null || seconds <= 0) {
    return null;
  }
  return asFanslyTimestamp(seconds, new Date(0)).toISOString();
}

function orderObservedDrafts(
  observation: CanonicalizableObservation,
  sources: ReturnType<typeof mediaPlaneSources>,
  messageRefByMediaRef: Map<string, { messageRef: string; conversationRef: string | null }>,
  index: MediaPlaneIndex,
): CanonicalEventDraft[] {
  const pageRef = String(observation.accountId);
  const drafts: CanonicalEventDraft[] = [];
  const seen = new Set<string>();
  for (const order of sources.orders) {
    const buyerRef = asString(order.accountId);
    const bundleRef = asString(order.accountMediaBundleId);
    const mediaRef = asString(order.accountMediaId);
    const subjectRef = bundleRef ?? mediaRef;
    if (buyerRef === null || subjectRef === null) {
      continue;
    }
    // Order rows carry epoch SECONDS; the key rounds to the second because
    // that is the resolution the platform serves — the composite IS the
    // identity, since the live shape carries no order id (§2.3).
    const occurredAt = asFanslyTimestamp(order.createdAt, observation.receivedAt);
    const occurredAtSeconds = Math.floor(occurredAt.getTime() / 1000);
    const dedupKey = `mediaorder:v1:${pageRef}:${subjectRef}:${buyerRef}:${occurredAtSeconds}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    const carrier = messageRefByMediaRef.get(subjectRef) ?? null;
    const subjectRow = bundleRef !== null
      ? index.bundleById.get(bundleRef) ?? null
      : index.mediaById.get(subjectRef) ?? null;
    drafts.push({
      type: "media.order_observed",
      // Receipt-time (§3.2b): an order row for a 2024 purchase must not aim
      // an append at a 2024 partition. The provider instant is below.
      occurredAt: observation.receivedAt,
      fanIdentityRef: buyerRef,
      ...(carrier?.conversationRef ? { conversationRef: carrier.conversationRef } : {}),
      ...(carrier ? { messageRef: carrier.messageRef } : {}),
      data: {
        mediaOfferRef: subjectRef,
        mediaRef,
        bundleRef,
        buyerRef,
        orderType: asNumber(order.type),
        // No order id exists in the live shape. It stays null until a response
        // is observed carrying one, and only then — versioned — becomes a key.
        orderRef: asString(order.id),
        orderedAt: occurredAt.toISOString(),
        priceMills: subjectRow === null ? null : permissionSummary(subjectRow).priceMills,
        conversationRef: carrier?.conversationRef ?? null,
        messageRef: carrier?.messageRef ?? null,
      },
      schemaVersion: MEDIA_PLANE_SCHEMA_VERSION,
      dedupKey,
    });
  }
  return drafts;
}

function attachmentDrafts(
  observation: CanonicalizableObservation,
  sources: ReturnType<typeof mediaPlaneSources>,
  index: MediaPlaneIndex,
): {
  drafts: CanonicalEventDraft[];
  messageRefByMediaRef: Map<string, { messageRef: string; conversationRef: string | null }>;
} {
  const pageRef = String(observation.accountId);
  const drafts: CanonicalEventDraft[] = [];
  const messageRefByMediaRef = new Map<
    string,
    { messageRef: string; conversationRef: string | null }
  >();

  for (const message of sources.messages) {
    const messageId = asString(message.id);
    const attachments = recordArray(message.attachments);
    if (messageId === null || attachments.length === 0) {
      continue;
    }
    const conversationRef = asString(message.groupId);
    const entries = attachments.map((attachment, ordinal) => {
      const contentRef = asString(attachment.contentId);
      const bundleRow = contentRef === null ? null : index.bundleById.get(contentRef) ?? null;
      const mediaRow = contentRef === null ? null : index.mediaById.get(contentRef) ?? null;
      const subjectRow = bundleRow ?? mediaRow;
      if (contentRef !== null) {
        messageRefByMediaRef.set(contentRef, { messageRef: messageId, conversationRef });
      }
      const permissions = subjectRow === null
        ? { entries: [] as Record<string, unknown>[], priceMills: null }
        : permissionSummary(subjectRow);
      const sales = subjectRow === null
        ? { salesCount: null, salesNetMills: null, salesPendingMills: null }
        : saleSummary(subjectRow);
      const shape = mediaRow === null
        ? { mediaType: null, mimeType: null, width: null, height: null, durationMs: null }
        : mediaShape(mediaRow);
      return {
        pos: asNumber(attachment.pos) ?? ordinal,
        contentType: asNumber(attachment.contentType),
        contentRef,
        bundleRef: bundleRow === null ? null : contentRef,
        mediaOfferRef: bundleRow === null ? contentRef : null,
        priceMills: permissions.priceMills,
        permissionEntries: permissions.entries,
        mimeType: shape.mimeType,
        durationMs: shape.durationMs,
        // Whether the OFFER was bought is answered by order evidence in this
        // same response, never by the served `purchased` flag: that flag
        // describes OUR access to our own media, not the fan's.
        purchased: contentRef !== null && index.buyerRefsBySubjectRef.has(contentRef),
        access: subjectRow === null
          ? null
          : typeof subjectRow.access === "boolean"
          ? subjectRow.access
          : null,
        ...sales,
        buyerRefs: contentRef === null
          ? []
          : index.buyerRefsBySubjectRef.get(contentRef) ?? [],
      };
    });
    const buyerRefs = [
      ...new Set(entries.flatMap((entry) => entry.buyerRefs)),
    ];
    const material = {
      messageId,
      conversationRef,
      senderRef: asString(message.senderId),
      messageCreatedAt: asFanslyTimestamp(message.createdAt, observation.receivedAt).toISOString(),
      attachments: entries,
      buyerRefs,
    };
    const hash = contentHash(material);
    drafts.push({
      type: "message.attachments_observed",
      occurredAt: observation.receivedAt,
      ...(conversationRef ? { conversationRef } : {}),
      messageRef: messageId,
      data: { ...material, contentHash: hash },
      schemaVersion: MEDIA_PLANE_SCHEMA_VERSION,
      dedupKey: `msgatt:v1:${pageRef}:${messageId}:${hash}`,
    });
  }

  return { drafts, messageRefByMediaRef };
}

/**
 * A17-4 VARIANT B: the archive learns about Fansly purchase material through
 * the channel it ALREADY understands. No archive column is added; the head
 * fills the existing ones (material head, media list, price_mills) exactly as
 * services/ofapi-message-material.ts does for OFAPI.
 *
 * This is the ONE provider-dated lane in this family: occurredAt is the
 * message's own createdAt, because the archive's occurred_at IS the message
 * time. A pre-2024 message therefore trips the driver's clamp — the event
 * falls back to receipt time with `occurredAtClamped` + `occurredAtRaw`, while
 * `head.messageCreatedAt` keeps the TRUE time and the archive dates from it.
 */
function materialDrafts(
  observation: CanonicalizableObservation,
  sources: ReturnType<typeof mediaPlaneSources>,
  index: MediaPlaneIndex,
  ownRef: string | null,
): CanonicalEventDraft[] {
  const drafts: CanonicalEventDraft[] = [];
  for (const message of sources.messages) {
    const messageId = asString(message.id);
    const attachments = recordArray(message.attachments);
    if (messageId === null || attachments.length === 0) {
      continue;
    }
    const senderRef = asString(message.senderId);
    const isSentByMe = senderRef !== null && ownRef !== null && senderRef === ownRef;
    const media = attachments.flatMap((attachment) => {
      const contentRef = asString(attachment.contentId);
      if (contentRef === null) {
        return [];
      }
      const mediaRow = index.mediaById.get(contentRef) ?? null;
      const shape = mediaRow === null ? null : mediaShape(mediaRow);
      return [{
        id: contentRef,
        type: shape?.mimeType ?? (index.bundleById.has(contentRef) ? "bundle" : "other"),
        canView: mediaRow === null ? null : typeof mediaRow.access === "boolean"
          ? mediaRow.access
          : null,
        isReady: null,
        duration: shape?.durationMs === null || shape?.durationMs === undefined
          ? null
          : shape.durationMs / 1000,
      }];
    }).sort((left, right) => left.id.localeCompare(right.id));
    const priceMills = attachments.reduce<string | null>((carried, attachment) => {
      if (carried !== null) {
        return carried;
      }
      const contentRef = asString(attachment.contentId);
      if (contentRef === null) {
        return null;
      }
      const row = index.bundleById.get(contentRef) ?? index.mediaById.get(contentRef) ?? null;
      return row === null ? null : permissionSummary(row).priceMills;
    }, null);
    const tipMills = millsString(message.totalTipAmount) ?? "0";
    const messageCreatedAt = asFanslyTimestamp(message.createdAt, observation.receivedAt);
    const head = {
      nativeMessageId: messageId,
      textHtml: asString(message.content) ?? "",
      isSentByMe,
      senderPlatformUserId: senderRef,
      fanPlatformUserId: isSentByMe ? null : senderRef,
      // The archive dates a material row from HERE, not from the event's
      // occurredAt, so a clamped historical draft still lands on the true day.
      messageCreatedAt: messageCreatedAt.toISOString(),
      priceMills,
      isOpened: null,
      isNew: null,
      isTip: tipMills !== "0",
      tipAmountMills: tipMills,
      tipTextPlain: null,
      reply: null,
      media,
      // Fansly DM pages serve attachments and reply refs but no tip note —
      // the exact note lives in transaction_tip_contexts. Declaring tipText
      // unobserved keeps the archive's coalesce from wiping another
      // producer's value.
      fieldPresence: { media: true, reply: true, tipText: false },
      vendorChangedAt: null,
      materialObservedAt: observation.receivedAt.toISOString(),
      originClass: "fansly_dm_sidecar",
    };
    const fingerprint = contentHash(head);
    drafts.push({
      type: "message.material_observed",
      occurredAt: messageCreatedAt,
      ...(isSentByMe ? {} : senderRef ? { fanIdentityRef: senderRef } : {}),
      ...(asString(message.groupId) ? { conversationRef: asString(message.groupId) } : {}),
      messageRef: messageId,
      data: { head, fingerprint },
      schemaVersion: MEDIA_PLANE_SCHEMA_VERSION,
      dedupKey: `msg-material:${messageId}:${fingerprint}`,
    });
  }
  return drafts;
}

/** The whole media plane for one Fansly observation, in one pass. */
function fanslyMediaPlaneEvents(
  observation: CanonicalizableObservation,
  options: { origin: string; ownRef: string | null },
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload) || observation.accountId == null) {
    return [];
  }
  const sources = mediaPlaneSources(observation.payload);
  if (
    sources.media.length === 0
    && sources.bundles.length === 0
    && sources.orders.length === 0
    && sources.messages.length === 0
  ) {
    return [];
  }
  const index = buildMediaPlaneIndex(sources);
  const attachments = attachmentDrafts(observation, sources, index);
  return [
    ...mediaObservedDrafts(observation, sources, index, options.origin),
    ...attachments.drafts,
    ...orderObservedDrafts(observation, sources, attachments.messageRefByMediaRef, index),
    ...materialDrafts(observation, sources, index, options.ownRef),
  ];
}

function fanslyPurchaseHistory(
  observation: CanonicalizableObservation,
  context: SyncPullCanonicalizeContext | undefined,
): CanonicalEventDraft[] {
  const ownRef = observation.accountId == null
    ? null
    : context?.nativeAccountRefByAccountId.get(observation.accountId) ?? null;
  return [
    ...fanslyPurchaseEvents(observation),
    // purchase_history shares the DM sidecar shapes, so it feeds the same
    // plane — and an order seen in BOTH lanes dedupes to one media_orders row,
    // because both mint the same composite key.
    ...fanslyMediaPlaneEvents(observation, { origin: "order_history", ownRef }),
  ];
}
