// Owner decision 2026-09-29 — one-off CloudFront signing tokens are stripped
// from Fansly pull bodies BEFORE they are journaled.
//
// A deliberate, owner-approved exception to the verbatim journal, in the same
// spirit as [A20] (services/sync/shared.ts, FANSLY_FAN_ACCOUNT_CAPTURE_ALLOWLIST):
// a field that changes on nearly every read makes every body unique and
// destroys the content-address dedup collapse the disk budget rests on. Since
// 2026-09-25 `/account/wallets/earnings/transactions` embeds full media records
// (`aggregationData.accountMedia`) whose signed URLs differ on every read, so
// hourly re-reads of an unchanged page stopped collapsing: ~40 catalog objects
// a day became ~390, about 170 MB a day on disk for transactions alone.
//
// WHAT IS REMOVED — the four CloudFront signing names, and nothing else:
//   * from a string that IS a URL (starts with http:// or https://) whose query
//     carries `Signature` or `Key-Pair-Id`: the `Policy`, `Signature`,
//     `Key-Pair-Id` and `Expires` params (both the custom-policy and the canned
//     form). Path, fragment and every other param keep their bytes and order; a
//     query left empty loses its `?`;
//   * from an object with a string `Signature` or `Key-Pair-Id` key (the
//     `locations[].metadata` form): those same four keys. The object stays,
//     even when it is left empty.
// `ngsw-bypass` is KEPT. It is Fansly's static Angular service-worker switch,
// the same on every read, not a token; keeping it keeps the stored URL in its
// served shape, and the agent-read scrub (modules/agent-read/observation-scrub.ts)
// treats it as a signed-URL marker, so those URLs stay withheld from agent reads
// exactly as before.
//
// A stripped URL can no longer be fetched. Nothing fetches these kinds' URLs
// (the canonicalizers keep ids only; signed locations were always
// "raw-journal-only"), and that is why the describer's sources are excluded by
// name below and the allowlist fails closed.

/**
 * The ONE named allowlist of Fansly pull kinds (= `sync_raw_payloads.endpoint`
 * = `observations.kind`) journaled with their CDN tokens stripped. Fail-closed:
 * a kind that is not named here, a new kind included, is journaled verbatim.
 * Every kind here carried signed URLs in production captures (2026-09-22..29),
 * except the two catalog batch kinds, which have not run in production yet and
 * serve the same account-media records as `vault_media`.
 * Widening it is a deliberate edit with a written reason, like [A20]'s list.
 */
export const FANSLY_CDN_TOKENS_STRIPPED_KINDS = [
  "earnings_transactions",
  "notifications",
  "posts",
  "post_replies",
  "account_lookup",
  "account_me",
  "account_stats",
  "media_offer_stats",
  "broadcast_stats",
  "broadcast_stats_deleted",
  "discovery_feed",
  "vault_media",
  "vault_albums",
  "uservault_albums",
  "account_media_batch",
  "account_media_bundle_batch",
] as const;

/**
 * Kinds whose signed URLs are READ LATER, named so the refusal is as legible as
 * the acceptance. The AI media describer (ai-media-describe/fansly-source.ts)
 * downloads media from the URLs journaled in the observation that
 * `ai_media_descriptions.source_observation_id` or
 * `message_media_offers.source_observation_id` points at: DM pages today (every
 * one on production), and it also understands the purchase-history shape. The
 * AI fast lane journals `dm_messages` too (fansly-fast-lane.ts).
 */
export const FANSLY_CDN_TOKENS_NEVER_STRIPPED_KINDS = [
  "dm_messages",
  "purchase_history",
  "purchase_history_contract_probe",
  "purchase_history_contract_storm",
] as const;

/**
 * Appended to `sync_raw_payloads.mapper_version` on every capture of a
 * stripped kind, so replay tooling can tell a pre-cutover verbatim row from a
 * stripped one. Observations carry no mapper field; their stripped bodies hold
 * no `Key-Pair-Id` at all, which is the same statement made by the body.
 */
export const FANSLY_CDN_TOKENS_STRIPPED_MAPPER_SUFFIX = "+cdn-tokens-stripped-v1";

/** Keyed by producer platform: OnlyFans, and a capture that names no platform,
 *  have no entry and are journaled verbatim. */
const STRIPPED_KINDS_BY_PLATFORM: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["fansly", new Set<string>(FANSLY_CDN_TOKENS_STRIPPED_KINDS)],
]);

/** CloudFront's signing names: the URL query params and the metadata keys. */
const SIGNING_NAMES: ReadonlySet<string> = new Set(["Policy", "Signature", "Key-Pair-Id", "Expires"]);

export function fanslyCdnTokenStripApplies(platform: string | null | undefined, kind: string): boolean {
  return STRIPPED_KINDS_BY_PLATFORM.get(platform ?? "")?.has(kind) ?? false;
}

function stripSignedUrl(value: string): string {
  if (!value.startsWith("https://") && !value.startsWith("http://")) {
    return value;
  }
  const queryStart = value.indexOf("?");
  if (queryStart < 0) {
    return value;
  }
  const fragmentStart = value.indexOf("#", queryStart);
  const queryEnd = fragmentStart < 0 ? value.length : fragmentStart;
  const pairs = value.slice(queryStart + 1, queryEnd).split("&");
  const names = pairs.map((pair) => pair.split("=", 1)[0] ?? "");
  if (!names.includes("Signature") && !names.includes("Key-Pair-Id")) {
    return value;
  }
  const kept = pairs.filter((_pair, index) => !SIGNING_NAMES.has(names[index]!));
  return `${value.slice(0, queryStart)}${kept.length > 0 ? `?${kept.join("&")}` : ""}${value.slice(queryEnd)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strip(value: unknown): unknown {
  if (typeof value === "string") {
    return stripSignedUrl(value);
  }
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    value.forEach((entry, index) => {
      const next = strip(entry);
      if (next !== entry) {
        copy ??= value.slice();
        copy[index] = next;
      }
    });
    return copy ?? value;
  }
  if (!isRecord(value)) {
    return value;
  }
  const signing = typeof value.Signature === "string" || typeof value["Key-Pair-Id"] === "string";
  let changed = false;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (signing && SIGNING_NAMES.has(key)) {
      changed = true;
      continue;
    }
    const next = strip(entry);
    changed ||= next !== entry;
    // A served `__proto__` key is data; plain assignment would set the
    // prototype instead and drop it from the body.
    Object.defineProperty(copy, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return changed ? copy : value;
}

/**
 * The strip described above, over any JSON value. Pure and idempotent, and it
 * NEVER mutates its input: lanes keep parsing their in-memory response after
 * the persist. Copy-on-write — what changed is new, untouched subtrees are
 * shared, and a value with nothing to strip comes back as the same reference.
 */
export function stripFanslySignedCdnTokens<T>(value: T): T {
  return strip(value) as T;
}
