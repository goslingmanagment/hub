// Fansly notification type codes → labels (WP-F2, §5 "Shared label modules").
//
// STORAGE ALWAYS HOLDS THE RAW INTEGER (A22-2). This module is a READ-TIME
// label table and nothing else: a re-derivation is a version bump plus a
// projection rebuild, never a data rewrite, because `platform_notifications`
// stores `type_code` raw and the verbatim `notification.observed` event can
// replay every row — including the codes this table gets wrong.
//
// IT HAS BEEN WRONG BEFORE, AND THAT IS THE POINT. `reference/fansly_api_spec.md`
// §3.1 was wrong on EIGHT of sixteen codes, including BOTH purchase events
// (A22-1, verified line-by-line against the client's own filter arrays at
// `fansly-app-bundle-2026-08-20/analysis/main.pretty.js:192262–192330`):
//
//   code   the spec said        the client says          cost of the error
//   2007   PostLikeUndo         Media Purchases          a purchase read as like-noise
//   2008   PostLikeRedo         Media Purchases          same
//   1004   MediaLikeUndo        Post Replies             replies invisible
//   1005   MediaLikeRedo        Post Quotes              quotes invisible
//   1002   MediaLike            Post like                swapped with 2002
//   2002   PostLike             Account-media like       swapped with 1002
//   15007  SubscriberRenewalFail Expired Subscriptions   wrong churn signal
//   15011  SubscriptionCanceled Promotions               wrong churn signal
//
// WP-F2's layer 1 journals every row verbatim for every code, known or not, so
// the labels being wrong cost nothing but labels. Never import FBuddy's map:
// both maps are wrong about 2007/2008.
//
// ONE TABLE, TWO HOMES, AND THEY MUST AGREE. `reference/fansly_api_spec.md`
// §3.1 was rewritten from the same client arrays; the labels below are its
// renderer names in snake_case, except the four purchase codes, which take the
// platform's own FILTER label ("Media Purchases", "Locked Text Purchases",
// "Stream Ticket Purchases") because the money is the point and the renderer
// name buries it. Two tables in one repo disagreeing about these codes is the
// exact failure this package exists to document.
//
// THE PROMOTION RULE, unchanged and binding: `confirmed` requires TWO
// independent live examples agreeing with a second source. Client code proves
// the CLIENT's intent, not the SERVER's behaviour — so every client-derived
// label below is `inferred`, and 2007 is the only `confirmed` entry at ship
// time (its UI↔payload match is in §2.3: "Purchased your Media for $80/$50"
// against rows carrying `accountMediaPrice` 80 000 / 50 000, screenshot
// `07-notifications-page-1.png`).

/** Bumped whenever a mapping below changes. v1 is the A22-1 table. */
export const FANSLY_NOTIFICATION_LABEL_VERSION = 1;

export type FanslyNotificationConfidence = "confirmed" | "inferred";

export interface FanslyNotificationTypeRow {
  code: number;
  /** `null` for a code the client DECLARES but gives no filter label — 1003 is
   *  tab-grouped only. A null label is not a known type: it still raises the
   *  unknown-type anomaly, because "we cannot name it" is the honest answer. */
  label: string | null;
  confidence: FanslyNotificationConfidence;
  /** Where the label came from. A label with no source is a guess. */
  citation: string;
}

const CLIENT_FILTERS =
  "fansly-app-bundle-2026-08-20/analysis/main.pretty.js:192262-192330 (the notification "
  + "component's own tabMap and filters arrays, read directly)";

/**
 * The per-code table. Every row carries its provenance.
 *
 * The four PURCHASE codes route to the commerce lane; everything else with a
 * label routes to the generic engagement lane; a code absent from this table
 * gets a verbatim row and an anomaly and nothing else.
 */
export const FANSLY_NOTIFICATION_TYPES: readonly FanslyNotificationTypeRow[] = Object.freeze([
  // ── money ────────────────────────────────────────────────────────────────
  {
    code: 2007,
    label: "media_purchase",
    confidence: "confirmed",
    citation:
      "UI↔payload match (§2.3): the notifications page renders \"Purchased your Media for "
      + "$80\" and \"$50\" against 2007 rows carrying accountMediaPrice 80000/50000 — "
      + "screenshot 07-notifications-page-1.png — and the client files 2007 under Media "
      + "Purchases. Two independent sources agreeing on live examples.",
  },
  {
    code: 2008,
    label: "media_purchase_bundle",
    confidence: "inferred",
    citation:
      `${CLIENT_FILTERS} files 2008 under Media Purchases; its six live rows carry `
      + "accountMediaPrice 14990×3, 15000, 20000, 140000 and the 3×14 990 matches A12's "
      + "3 × $14.99 bundle sale. Bundle-shaped until one UI match promotes it [E4].",
  },
  {
    code: 32007,
    label: "locked_text_purchase",
    confidence: "inferred",
    citation:
      `${CLIENT_FILTERS} declares 32007 as the Locked Text Purchases filter. Absent from `
      + "every prior version of the plan and from the spec; zero live examples so far.",
  },
  {
    code: 45012,
    label: "stream_ticket_purchase",
    confidence: "inferred",
    citation:
      `${CLIENT_FILTERS} declares 45012 as the Stream Ticket Purchases filter. Absent from `
      + "every prior version of the plan and from the spec; zero live examples so far.",
  },

  // ── engagement: likes, replies, quotes ───────────────────────────────────
  // Zero live occurrences of all five (§2.3). They moved from NO label to an
  // inferred one on 2026-08-20; no field-level semantics are claimed, and
  // NOTHING derived from them is written to `post_likes` ([E4]).
  {
    code: 1002,
    label: "post_like",
    confidence: "inferred",
    citation: `${CLIENT_FILTERS}. The spec said "MediaLike" — swapped with 2002.`,
  },
  {
    code: 2002,
    label: "account_media_like",
    confidence: "inferred",
    citation: `${CLIENT_FILTERS}. The spec said "PostLike" — swapped with 1002.`,
  },
  {
    code: 1004,
    label: "post_reply",
    confidence: "inferred",
    citation: `${CLIENT_FILTERS}. The spec said "MediaLikeUndo" — wrong entirely.`,
  },
  {
    code: 1005,
    label: "post_quote",
    confidence: "inferred",
    citation: `${CLIENT_FILTERS}. The spec said "MediaLikeRedo" — wrong entirely.`,
  },
  {
    code: 5003,
    label: "message_like",
    confidence: "inferred",
    citation: `${CLIENT_FILTERS}. The spec agrees on this one.`,
  },
  {
    code: 1003,
    label: null,
    confidence: "inferred",
    citation:
      `${CLIENT_FILTERS} carries 1003 in the tab map with NO filter label. Declared but `
      + "unnameable: it is journaled verbatim and surfaced as an unknown type until a "
      + "label exists.",
  },

  // ── engagement: follows, tips, subscriptions ────────────────────────────
  {
    code: 3002,
    label: "follow",
    confidence: "inferred",
    citation:
      `${CLIENT_FILTERS} declares 3002 beside 3003 under the Followers filter, both dispatching `
      + "to the Follow renderer (`reference/fansly_api_spec.md` §3.1); the CODE selects which "
      + "correlation field holds the follower id. No live example in the 200-row census.",
  },
  {
    code: 3003,
    label: "follow",
    confidence: "inferred",
    citation:
      "97 live rows in the 200-row census (§2.3), metadata absent, filed under Followers and "
      + `dispatching to the Follow renderer (${CLIENT_FILTERS}, mirrored in `
      + "`reference/fansly_api_spec.md` §3.1). UNCONFIRMED in meaning: no UI match has been "
      + "taken against a 3003 row.",
  },
  {
    code: 7001,
    label: "tip_received",
    confidence: "inferred",
    citation:
      "26 live rows in the 200-row census (§2.3), metadata absent, declared in the tips "
      + `filter group (${CLIENT_FILTERS}). A22-2 also records a legacy/current pair on the `
      + "wallet side (7001/7101) — a reason to store the code, not the label.",
  },
  {
    code: 15006,
    label: "subscription_renew",
    confidence: "inferred",
    citation:
      `${CLIENT_FILTERS} files 15006 under Subscribers, dispatching to the Subscription-renew `
      + "renderer (`reference/fansly_api_spec.md` §3.1); it also led the UI's own eight-code "
      + "CSV. No live example in the census.",
  },
  {
    code: 15007,
    label: "expired_subscriptions",
    confidence: "inferred",
    citation:
      `${CLIENT_FILTERS} declares 15007 as Expired Subscriptions; the spec said `
      + "\"SubscriberRenewalFail\", which is a different churn signal (A22-1). 15 live rows.",
  },
  {
    code: 15011,
    label: "promotions",
    confidence: "inferred",
    citation:
      `${CLIENT_FILTERS} declares 15011 as Promotions; the spec said `
      + "\"SubscriptionCanceled\", which is a different churn signal (A22-1).",
  },
  {
    code: 15016,
    label: "subscription_history_renew",
    confidence: "inferred",
    citation:
      "26 live rows carrying metadata {\"subscriptionStreak\": N} (§2.3), filed under "
      + `Subscribers and dispatching to the Subscription-history-renew renderer `
      + `(${CLIENT_FILTERS}, mirrored in \`reference/fansly_api_spec.md\` §3.1).`,
  },
]);

const TYPE_ROWS_BY_CODE: ReadonlyMap<number, FanslyNotificationTypeRow> = new Map(
  FANSLY_NOTIFICATION_TYPES.map((row) => [row.code, row]),
);

/** The Fansly admin/alert family. A22-1 found 24001 and 24002 declared and the
 *  renderer generic across the band, so the BAND is what is labelled — a new
 *  member is a known alert, not an unknown type. */
export const FANSLY_NOTIFICATION_ALERT_FAMILY_MIN = 24001;
export const FANSLY_NOTIFICATION_ALERT_FAMILY_MAX = 24999;
export const FANSLY_NOTIFICATION_ALERT_FAMILY_LABEL = "fansly_alert";

/**
 * THE COMMERCE CODES. All four route to `media.purchase_notification_observed`
 * and to the `subject_refresh_state` dirty mark; NONE of them writes to
 * `post_likes` (the v1 plan's "2007/2008 = media-like undo/redo, flip
 * post_likes.state" is refuted and deleted, §2.3).
 */
export const FANSLY_NOTIFICATION_PURCHASE_CODES: readonly number[] = Object.freeze([
  2007,
  2008,
  32007,
  45012,
]);

const PURCHASE_CODE_SET: ReadonlySet<number> = new Set(FANSLY_NOTIFICATION_PURCHASE_CODES);

/**
 * [A22] THE DEGRADED-PATH FALLBACK SET — the client's FULL declared filter set,
 * in the client's own order.
 *
 * An earlier draft used the eight codes the walked UI happened to send
 * (`15006,15016,3002,3003,7001,2007,2008,15007`). That list silently excludes
 * `32007` (Locked Text Purchases) and `45012` (Stream Ticket Purchases), BOTH
 * of which are money, on exactly the path where a silent gap is least
 * affordable. The narrow CSV must never be used.
 *
 * It controls CAPTURE only: it assigns no labels and is never advertised as
 * exhaustive — which is why the first call of every poll goes UNFILTERED (A1).
 */
export const FANSLY_NOTIFICATION_DECLARED_TYPE_CODES: readonly number[] = Object.freeze([
  24001,
  24002,
  1002,
  2002,
  5003,
  1004,
  1005,
  7001,
  3002,
  3003,
  2007,
  2008,
  15006,
  15016,
  15007,
  15011,
  32007,
  45012,
]);

export const FANSLY_NOTIFICATION_DECLARED_TYPE_CSV = FANSLY_NOTIFICATION_DECLARED_TYPE_CODES
  .join(",");

/**
 * The declared set, split into the client's filter groups. The handler iterates
 * these only when even the full CSV comes back visibly filtered — one group per
 * call, so a provider that refuses the wide form still yields every group it
 * will serve. Every declared code appears in exactly one group (pinned).
 */
export const FANSLY_NOTIFICATION_TYPE_GROUPS: readonly (readonly number[])[] = Object.freeze([
  Object.freeze([2007, 2008, 32007, 45012]),
  Object.freeze([1002, 2002, 5003]),
  Object.freeze([1004, 1005]),
  Object.freeze([7001]),
  Object.freeze([3002, 3003]),
  Object.freeze([15006, 15007, 15011, 15016]),
  Object.freeze([24001, 24002]),
]);

function isAlertFamily(code: number): boolean {
  return code >= FANSLY_NOTIFICATION_ALERT_FAMILY_MIN
    && code <= FANSLY_NOTIFICATION_ALERT_FAMILY_MAX;
}

/**
 * `<label>` for a code this version can name, `unknown:<code>` otherwise.
 *
 * THE GUARD ORDER MATTERS, the same way it does in `fansly-stat-types.ts`: the
 * per-code table is consulted FIRST, so a member of the alert band that ever
 * gets its own row wins over the band label rather than being absorbed by it.
 */
export function fanslyNotificationLabel(code: number): string {
  if (!Number.isSafeInteger(code)) {
    return `unknown:${String(code)}`;
  }
  const row = TYPE_ROWS_BY_CODE.get(code);
  if (row !== undefined) {
    return row.label ?? `unknown:${code}`;
  }
  if (isAlertFamily(code)) {
    return FANSLY_NOTIFICATION_ALERT_FAMILY_LABEL;
  }
  return `unknown:${code}`;
}

/** The confidence of the label above, or `null` when there is no label. */
export function fanslyNotificationConfidence(
  code: number,
): FanslyNotificationConfidence | null {
  if (!Number.isSafeInteger(code)) {
    return null;
  }
  const row = TYPE_ROWS_BY_CODE.get(code);
  if (row !== undefined) {
    return row.label === null ? null : row.confidence;
  }
  // The band's own reading is client-derived like every other one here.
  return isAlertFamily(code) ? "inferred" : null;
}

/** True when this label version can NAME the code. A false raises
 *  `fansly_notification_unknown_type` — and the verbatim row is written
 *  anyway (A1: journaled and surfaced, never dropped). */
export function isKnownFanslyNotificationType(code: number): boolean {
  return !fanslyNotificationLabel(code).startsWith("unknown:");
}

/** True for the four codes that are MONEY. */
export function isFanslyPurchaseNotificationType(code: number): boolean {
  return Number.isSafeInteger(code) && PURCHASE_CODE_SET.has(code);
}
