// WP-F7 — the `fansly-payouts` canonicalizer family (v1, projection-only).
//
// Two observation kinds, one family. Read the credential rule first; the rest
// is ordinary row-to-event work.
//
// ── THE CREDENTIAL RULE, AND WHY THE MASKING HAS TO BE OURS ─────────────────
//
// `/payments/payoutmethods` serves `metadata` as a JSON-ENCODED STRING — a
// string containing JSON, not an object — and the two live providers are
// asymmetric in exactly the way that decides this design:
//
//   providerId 2  (Paxum. NOT PayPal: the API spec says PayPal and A22-4
//                 refuted it from the app bundle, which renders provider 2
//                 with `paxum.webp` and names Paxum in its compliance copy.)
//                 `metadata` decodes to `{email}` and the server returns the
//                 creator's FULL address in plaintext.
//   providerId 30 (USDT) decodes to `field0…field10`, where `field1` is
//                 ALREADY server-masked: 38 `X` plus four visible characters.
//
// One provider hands us a credential and the other does not. So masking cannot
// be "trust what the platform sends" — it has to be something this file does,
// on purpose, with a shape a fixture can bite. `maskedLabel` is the ONLY value
// derived from `metadata` that ever leaves this family. The full body stays in
// the raw journal, kept 100 years under DP 7 and unreachable from the agent
// read plane (neither kind is on `AGENT_OBSERVATION_PAYLOAD_ALLOWLIST`, which
// is an allowlist and fails closed).
//
// THE DECODE IS PROVIDER-KEYED, NOT SHAPE-KEYED, and that is the whole defence
// against the provider nobody has met yet. A future provider 99 with its own
// `field0…fieldN` wallet payload decodes to NOTHING: no branch matches it, its
// `maskedLabel` is null, its `providerLabel` is `unmapped:<id>`, and not one
// character of its metadata enters an event or a projection. A shape-keyed
// decoder ("looks like fields, mask field1") would have quietly published
// whatever that provider chose to put in field1.
//
// ── THE OTHER FOUR RULES ────────────────────────────────────────────────────
//
// 1. **TIME (§3.2b).** Every event here is RECEIPT-TIME: `occurredAt` is the
//    observation's `receivedAt`, and the provider instant is a typed field in
//    `data`. A receipt-time draft is by construction inside
//    `clampDraftOccurredAt`'s window, so an event from this family can NEVER
//    carry `occurredAtClamped`, and a 2023-dated fixture asserts exactly that.
//    It matters here: the walked history reaches back to 2025-06-23 and
//    `domain_events` is monthly-partitioned, so a payout dated at provider time
//    would fail `ExecFindPartition` (23514) forever.
//
// 2. **MILLISECONDS, ON BOTH INSTANTS.** `createdAt` and `updatedAt` are
//    13-digit Unix ms on this route. They are decoded by an ms-ONLY helper
//    rather than the seconds-or-ms heuristic: this family has no seconds field
//    anywhere, and a heuristic that could be wrong is a heuristic that will be.
//
// 3. **MONEY IS MILLS, THROUGH THE SHARED CONSTRUCTORS.** `amount` is ALREADY
//    mills on the wire — the same unit the kernel uses, proved against the
//    rendered UI on seven independent fields ($131 = 131 000). There is NO
//    scaling anywhere in this family; the value travels as a decimal STRING
//    built by `millsString` → `millsFromInteger`.
//
// 4. **THE STATUS MAP IS ONE CODE DEEP.** All 83 observed requests carried
//    `status = 8` = `Processed`. Every other payout status is unknown, so the
//    integer and the label are emitted TOGETHER with a confidence, `8` is never
//    treated as "the success code" in a conditional, and an unknown code
//    becomes `unmapped:<code>` — never a guess. The capture handler raises one
//    anomaly per unseen code.
//
// ── THE ROSTER ──────────────────────────────────────────────────────────────
//
// The method listing is a FULL array, so it also emits ONE
// `payout.method_list_observed` per LOOK carrying the complete ref set. Row
// events say what IS; nothing in them says what ISN'T, and the case that
// matters most is the one that produces no row events at all — a creator who
// removes their last payout method serves `[]`. Keying the roster on the
// observation rather than on the ref set is the correction WP-F3's projection
// test found: a method removed and re-added UNCHANGED hashes to the roster it
// had before it vanished, so the event would dedupe and the row would stay
// marked forever.
//
// PAYOUT REQUESTS GET NO ROSTER, deliberately. They arrive from an OFFSET-paged
// walk, and a roster built from one page of ten would claim the page holds the
// whole history — every page would mark the other seventy-three missing and the
// next page would un-mark them. A partial listing is not a listing.

import {
  asNumber,
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
  type CanonicalizeRunContext,
} from "./types.ts";
import { contentHash, millsString, recordArray } from "./sync-pull.ts";

export const FANSLY_PAYOUTS_CANONICALIZER_VERSION = 1;
const SCHEMA_VERSION = 1;

/** The `observations.kind` values this family claims. Registered in
 *  `observation-kinds.ts`; the ratchet fails otherwise. */
export const FANSLY_PAYOUTS_CANONICALIZED_KINDS = [
  "payout_methods",
  "payout_requests",
] as const;

const CANONICALIZED_KIND_SET: ReadonlySet<string> = new Set(FANSLY_PAYOUTS_CANONICALIZED_KINDS);

/** The event types this family emits. Every one is registered in
 *  `PROJECTION_ONLY_DOMAIN_EVENT_TYPES` — one decision, never two. */
export const FANSLY_PAYOUTS_EVENT_TYPES = [
  "payout.method_observed",
  "payout.method_list_observed",
  "payout.observed",
] as const;

/** Raised when a method's `metadata` was a string that did not parse as JSON.
 *  The ROW is still written, with `metadataParseOk: false` and a null label —
 *  a method we could not read and a method with nothing to read are different
 *  facts, and only this flag tells them apart. */
export const FANSLY_PAYOUT_METADATA_UNPARSED_DIAGNOSTIC = "fansly_payout_metadata_unparsed";

/**
 * The payout-request status map. ONE code deep, and it stays that way until a
 * second one is OBSERVED — not inferred from a bundle, not borrowed from
 * another enum. `8` is the only value 83 live rows ever carried, and its UI
 * label is `Processed`.
 */
export const PAYOUT_STATUS_LABELS: ReadonlyMap<number, string> = new Map([
  [8, "Processed"],
]);

/** Whether a payout status code has an OBSERVED label. Used by the capture
 *  handler to decide whether a code is worth an anomaly. */
export function isMappedPayoutStatus(code: number): boolean {
  return PAYOUT_STATUS_LABELS.has(code);
}

export interface PayoutStatus {
  statusCode: number | null;
  statusLabel: string | null;
  statusConfidence: "mapped" | "unmapped";
}

/**
 * `(code, label, confidence)` — the three together, always.
 *
 * An unknown code is `unmapped:<code>`, never a name. A payout that failed,
 * was cancelled or was reversed reported as "Processed" is not a cosmetic
 * error: it is money the agency believes arrived.
 */
export function payoutStatus(value: unknown): PayoutStatus {
  const code = asNumber(value);
  if (code === null || !Number.isSafeInteger(code)) {
    return { statusCode: null, statusLabel: null, statusConfidence: "unmapped" };
  }
  const label = PAYOUT_STATUS_LABELS.get(code);
  return label === undefined
    ? { statusCode: code, statusLabel: `unmapped:${code}`, statusConfidence: "unmapped" }
    : { statusCode: code, statusLabel: label, statusConfidence: "mapped" };
}

/**
 * The payout-provider map. TWO codes, both observed live, and the label is a
 * READ-TIME convenience over an integer that is always stored raw.
 *
 * Provider 2 is **Paxum**, not PayPal (A22-4): the spec's claim was refuted
 * from the app bundle, which renders provider 2 with `paxum.webp` and names
 * Paxum in its compliance copy. Getting this wrong would put the wrong
 * processor's name on a money-out record.
 */
export const PAYOUT_PROVIDER_LABELS: ReadonlyMap<number, string> = new Map([
  [2, "paxum"],
  [30, "usdt"],
]);

/**
 * `providerId` arrives as a STRING on the wire (`"2"`, `"30"`) among otherwise
 * numeric-looking fields. It is normalized to an integer because it is an ENUM
 * CODE, not an identifier — the "provider ids stay TEXT" rule guards snowflake
 * ids from JS number precision, and a two-digit enum has no precision to lose.
 *
 * A value that is not a non-negative integer returns null, and the LABEL still
 * records what was served, so nothing is silently dropped.
 */
export function payoutProviderId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** `paxum` (2), `usdt` (30), `unmapped:<what was served>` for anything else.
 *  Derived from the provider code ALONE — never from `metadata`. */
export function payoutProviderLabel(rawValue: unknown, providerId: number | null): string {
  if (providerId !== null) {
    const label = PAYOUT_PROVIDER_LABELS.get(providerId);
    if (label !== undefined) {
      return label;
    }
    return `unmapped:${providerId}`;
  }
  const served = typeof rawValue === "string" && rawValue.length > 0 ? rawValue : "unknown";
  return `unmapped:${served}`;
}

/**
 * THE EMAIL MASK, pinned: `<first character>***@<domain>`.
 *
 *   "lora.viexx@example.com"  ->  "l***@example.com"
 *
 * The local part is reduced to ONE character. That is deliberate: the domain
 * alone answers "which processor account is this" for an operator reading a
 * money-out record, and the local part is the half that identifies a person.
 * A fixed three asterisks rather than one per hidden character, because a
 * length-preserving mask leaks the length.
 *
 * The shape is also enforced by the DATABASE — migration 0141 CHECKs that any
 * `masked_label` containing an `@` matches `^.\*\*\*@` — so a regression here
 * fails at the INSERT rather than at a code review.
 *
 * Anything that is not a plausible address returns null: half a mask is worse
 * than an honest absence.
 */
export function maskPayoutEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) {
    return null;
  }
  return `${value.slice(0, 1)}***@${value.slice(at + 1)}`;
}

/**
 * THE WALLET-FIELD MASK, pinned: `****<the four visible characters>`.
 *
 *   "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1a2b"  ->  "****1a2b"
 *
 * `field1` on provider 30 is ALREADY server-masked (38 `X` plus four visible),
 * so this keeps only the suffix the UI itself renders as "ending in …". It does
 * NOT trust that the server will keep masking it: the same four characters come
 * out whether the field arrives masked or in full, which is the point.
 *
 * Fewer than four characters returns null rather than a short suffix.
 */
export function maskPayoutWalletField(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 4) {
    return null;
  }
  return `****${value.slice(-4)}`;
}

interface PayoutMethodMetadata {
  /** FALSE when `metadata` was a string that did not parse as JSON. */
  parseOk: boolean;
  /** OURS. Null for every provider this file does not know by number. */
  maskedLabel: string | null;
}

/**
 * Decode `metadata` far enough to produce a mask, and no further.
 *
 * The parsed object is a LOCAL: nothing derived from it but `maskedLabel`
 * escapes this function, and for an unknown provider not even that. The parse
 * still runs for an unknown provider — but only to answer "was this readable
 * at all", which is a structural fact about the response and carries none of
 * its content.
 */
export function decodePayoutMethodMetadata(
  value: unknown,
  providerId: number | null,
  onUnparsed?: () => void,
): PayoutMethodMetadata {
  let decoded: unknown = value;
  if (typeof decoded === "string") {
    if (decoded.length === 0) {
      return { parseOk: true, maskedLabel: null };
    }
    try {
      decoded = JSON.parse(decoded);
    } catch {
      onUnparsed?.();
      return { parseOk: false, maskedLabel: null };
    }
  }
  if (!isRecord(decoded)) {
    return { parseOk: value === null || value === undefined, maskedLabel: null };
  }
  // PROVIDER-KEYED. A provider this file does not know by NUMBER decodes to
  // nothing, whatever its payload happens to look like.
  switch (providerId) {
    case 2:
      return { parseOk: true, maskedLabel: maskPayoutEmail(decoded.email) };
    case 30:
      return { parseOk: true, maskedLabel: maskPayoutWalletField(decoded.field1) };
    default:
      return { parseOk: true, maskedLabel: null };
  }
}

function pageRefOf(observation: CanonicalizableObservation): string {
  return String(observation.accountId);
}

/**
 * MILLISECOND instants, strictly. `createdAt` and `updatedAt` are 13-digit Unix
 * ms on both payout routes and this family has no seconds field anywhere, so a
 * seconds-or-ms heuristic would only ever be a way to be wrong. Null stays null
 * — a missing timestamp must never become 1970.
 */
function msInstantIso(value: unknown): string | null {
  const raw = asNumber(value);
  if (raw === null || raw <= 0) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** The rows of an array-shaped response, or of the first array-valued key of an
 *  object-shaped one. `/payments/payoutmethods` serves a BARE ARRAY once the
 *  `{success, response}` envelope is unwrapped. */
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
 * The roster event: "this FULL method listing named exactly these refs, at this
 * observation".
 *
 * ONE ROSTER PER LOOK — the dedup key carries the OBSERVATION id, not just the
 * content hash. A method removed and re-added UNCHANGED produces a roster
 * identical to the one before it disappeared, so hashing the set alone would
 * dedupe the event, the projector would never see it, and the row would stay
 * marked `missing_since` forever while the platform served it again.
 *
 * Refs are SORTED so a provider that reorders its array produces the same
 * `contentHash`, which stays in `data` as the cheap "did the set change?" read.
 */
function methodListingDraft(
  observation: CanonicalizableObservation,
  refs: readonly string[],
): CanonicalEventDraft {
  const pageRef = pageRefOf(observation);
  const sorted = [...new Set(refs)].sort();
  const material = { refs: sorted, count: sorted.length };
  const hash = contentHash(material);
  return {
    type: "payout.method_list_observed",
    // RECEIPT TIME (§3.2b). "When we looked" is exactly what a roster is about.
    occurredAt: observation.receivedAt,
    data: { ...material, contentHash: hash },
    schemaVersion: SCHEMA_VERSION,
    dedupKey: `payoutmethodlist:v1:${pageRef}:${observation.id}:${hash}`,
  };
}

function methodDrafts(
  observation: CanonicalizableObservation,
  context: CanonicalizeRunContext | undefined,
): CanonicalEventDraft[] {
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];
  const refs: string[] = [];

  for (const row of envelopeArray(observation.payload)) {
    const methodRef = asString(row.id);
    if (methodRef === null) {
      continue;
    }
    refs.push(methodRef);
    const providerId = payoutProviderId(row.providerId);
    const metadata = decodePayoutMethodMetadata(row.metadata, providerId, () => {
      context?.diagnostics?.record(FANSLY_PAYOUT_METADATA_UNPARSED_DIAGNOSTIC);
    });
    const material = {
      methodRef,
      ownerAccountRef: asString(row.accountId),
      // RAW platform code, always. The label beside it is derived from THIS and
      // from nothing else.
      providerId,
      providerLabel: payoutProviderLabel(row.providerId, providerId),
      // Observed live as 1 / 0 / 3 with NO rendered label anywhere in the UI.
      // Raw integers; naming them would be guesswork (FINDINGS §"Enum and
      // status codes" says so explicitly).
      type: asNumber(row.type),
      flags: asNumber(row.flags),
      status: asNumber(row.status),
      // THE ONLY THING `metadata` PRODUCES.
      maskedLabel: metadata.maskedLabel,
      metadataParseOk: metadata.parseOk,
      version: asNumber(row.version),
    };
    const hash = contentHash(material);
    drafts.push({
      type: "payout.method_observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      dedupKey: `payoutmethod:v1:${pageRef}:${methodRef}:${hash}`,
    });
  }

  // The roster LAST, after the rows it describes.
  drafts.push(methodListingDraft(observation, refs));
  return drafts;
}

function requestDrafts(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  const payload = observation.payload;
  if (!isRecord(payload)) {
    return [];
  }
  const pageRef = pageRefOf(observation);
  const drafts: CanonicalEventDraft[] = [];

  for (const row of recordArray(payload.data)) {
    const payoutRef = asString(row.id);
    if (payoutRef === null) {
      continue;
    }
    const status = payoutStatus(row.status);
    const material = {
      payoutRef,
      ownerAccountRef: asString(row.accountId),
      // ALREADY MILLS on the wire. No scaling, ever: $131 arrives as 131 000
      // and 131 000 is what the kernel stores.
      amountMills: millsString(row.amount),
      payoutMethodRef: asString(row.payoutMethodId),
      // The integer and the label TOGETHER, plus what we actually know about it.
      statusCode: status.statusCode,
      statusLabel: status.statusLabel,
      statusConfidence: status.statusConfidence,
      version: asNumber(row.version),
      // MILLISECONDS on both.
      createdAtPlatform: msInstantIso(row.createdAt),
      updatedAtPlatform: msInstantIso(row.updatedAt),
    };
    const hash = contentHash(material);
    drafts.push({
      type: "payout.observed",
      occurredAt: observation.receivedAt,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      // HASHED: a payout whose status moves is a REVISION — one new event and
      // one head update — while the fortieth re-read of an unchanged row
      // appends nothing.
      dedupKey: `payout:v1:${pageRef}:${payoutRef}:${hash}`,
    });
  }

  // NO ROSTER. See the header: an offset-paged page is not a listing.
  return drafts;
}

// ── the seam ─────────────────────────────────────────────────────────────────

/**
 * Shape gate. `false` leaves the row UNSTAMPED for a future parser instead of
 * consuming it with zero events — without it a drifted payload is
 * indistinguishable from a legitimately EMPTY response, and "capture now, parse
 * later" quietly becomes "capture now, never parse".
 *
 * An EMPTY method listing is deliberately parseable, and here it is
 * load-bearing: the empty roster is exactly what marks a creator's last payout
 * method `missing_since`.
 */
export function canParseFanslyPayoutsObservation(
  observation: Pick<CanonicalizableObservation, "kind" | "payload" | "accountId">,
): boolean {
  if (!CANONICALIZED_KIND_SET.has(observation.kind) || observation.accountId === null) {
    return false;
  }
  switch (observation.kind) {
    case "payout_requests":
      // `{total, data[]}`. A body with no `data` array is drift, not an empty
      // history — and the difference matters, because this lane's walk decides
      // when to stop from the row count.
      return isRecord(observation.payload) && Array.isArray(observation.payload.data);
    default:
      // The BARE ARRAY of methods. An object that wraps its array is accepted
      // too — `envelopeArray` reads either.
      return Array.isArray(observation.payload)
        || (isRecord(observation.payload)
          && Object.values(observation.payload).some((value) => Array.isArray(value)));
  }
}

export function canonicalizeFanslyPayoutsObservation(
  observation: CanonicalizableObservation,
  context?: CanonicalizeRunContext,
): CanonicalEventDraft[] {
  if (observation.accountId === null) {
    return [];
  }
  switch (observation.kind) {
    case "payout_methods":
      return methodDrafts(observation, context);
    case "payout_requests":
      return requestDrafts(observation);
    default:
      return [];
  }
}
