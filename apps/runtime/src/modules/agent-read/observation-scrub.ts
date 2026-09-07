import { createHash } from "node:crypto";

/**
 * Operation 9b: which capture-journal payloads may be shown at all, and what has
 * to come out of them first.
 *
 * A DENYLIST CANNOT WORK HERE, and this was checked rather than assumed:
 * `RESTRICTED_OBSERVATION_KINDS` contains `desktop.guard_audit` and `ofapi_admin_accounts` and is
 * consulted only on the tiering/lake path, never on serving. It contains neither
 * `dm_messages` (signed CDN addresses) nor `account_me` (vendor auth material).
 * So the rule is an ALLOWLIST, fail-closed: a kind absent from the list below is
 * withheld, including every kind that has not been invented yet.
 *
 * The allowlist is copied from the reviewed contract appendix. It is deliberately
 * NOT derived from "every sync kind": that wider set admits precisely the kinds
 * the appendix forbids by name.
 */

/** Fansly pull names its observation kind after the endpoint it called. */
export const AGENT_OBSERVATION_PAYLOAD_ALLOWLIST: ReadonlySet<string> = new Set([
  "earnings_transactions",
  "purchase_history",
  "fan_earnings_stats",
  "fan_earnings_monthly",
  "subscribers",
  // RE-JUSTIFIED for [A20] (WP-F0(a)), because the widening this justification
  // was written before does NOT invalidate it — checked, not assumed:
  // `aggregationData.groups[].lastMessage` still goes through
  // `redactFanslyMessageLike` (sync/shared.ts), which drops `content` and
  // empties attachments/embeds/interactions/likes BEFORE the journal. That is
  // the content this line means, and it is still gone.
  // What [A20] added to this body is fan-ACCOUNT state — followsYou,
  // subscription/auto-renew, our own notes and lists, access and permission
  // flags — the agency's own customer material, which is exactly what the read
  // plane exists to serve. No message text, no CDN address, no vendor auth.
  // `tests/fansly-capture-allowlist.test.ts` pins both halves.
  "dm_conversations",
  // Owner ruling (OPEN 13): IN, because `accountMedia`/`tips`/`storyOrders` live
  // here and they are exactly what a customs audit needs. Admitted only WITH the
  // signed-URL scrub below, which is pinned by golden fixtures.
  "dm_messages",
  // ── endpoints-cover (WP-S1) ──────────────────────────────────────────────
  // Eight kinds admitted, each judged against what the CAPTURE side actually
  // journals rather than against what the endpoint is called.
  //
  //   account_stats                  the profile/media statistics response:
  //                                  counters and type codes. No fan identity,
  //                                  no message text, no delivery address.
  //   media_offer_stats              the per-media statistics response — seven
  //                                  stat keys and a media id ([E5]).
  //   earnings_stats_snapshot        the earnings breakdown and the month
  //   earnings_monthlystats_snapshot totals: business dates, revenue type codes
  //                                  and the agency's own money.
  //   tracking_links                 promo-link counters. A link REF is an id
  //                                  the creator minted, not an address.
  //   subscription_tiers             tier/plan/promo prices. Public catalogue.
  //   vault_albums                   album titles, counts and ids. No bytes:
  //                                  the vault walk fetches no media.
  //
  //   notifications                  ADMITTED FOR A REASON THAT LIVES ELSEWHERE.
  //                                  The kind's `accounts[]` sidecar is ALREADY
  //                                  [A20]-trimmed at capture, so what reaches
  //                                  the journal is fan-ACCOUNT state — the
  //                                  agency's own customer material — with no
  //                                  message content and no CDN address. That
  //                                  trim is a property of the capture path,
  //                                  not of this list, and it is the whole
  //                                  justification: widen the trim and THIS
  //                                  line must be re-justified, exactly as
  //                                  `dm_conversations` above was after [A20].
  "account_stats",
  "media_offer_stats",
  "earnings_stats_snapshot",
  "earnings_monthlystats_snapshot",
  "tracking_links",
  "subscription_tiers",
  "vault_albums",
  "notifications",
]);

/**
 * Kinds refused unconditionally, listed by name so a reader sees the reasoning
 * rather than inferring it from an omission. (The allowlist already refuses them;
 * this exists so a future widening has to delete a line that says why.)
 *
 *   ofapi_admin_accounts         creator identities and auth state; session material is removed at capture
 *   account_me / account_lookup  vendor auth material and session state
 *   group_detail                 permission flags and user settings
 *   followers                    trimmed at capture; the journal row is not the fact
 *   earnings_accounts            payout account identifiers
 *   payout_methods               the creator's OWN payout credentials — provider 2
 *                                (Paxum) returns a full plaintext email address, and
 *                                the only sanctioned reader of that field is the
 *                                WP-F7 canonicalizer, which turns it into a mask.
 *                                Absence from the allowlist above already refuses it;
 *                                this line is here so a future widening has to delete
 *                                a sentence that says why.
 *   payout_requests              money OUT. No fan appears on these rows, so it is not
 *                                customer material the read plane exists to serve, and
 *                                every row names a payout method by ref — serving it
 *                                would make the method listing reachable by join.
 *   post_replies                 ANOTHER ACCOUNT'S AUTHORED CONTENT, and the one
 *                                WP-S1 considered and refused. The walk's body carries
 *                                fans' own reply prose plus an `accounts[]` sidecar of
 *                                their profiles — material a fan wrote and published
 *                                under a post, not material this agency produced. The
 *                                PROJECTION of it IS served (the `comments` dataset,
 *                                behind `read:messages`, with an audit row per read);
 *                                the raw journal body is not, because the projection is
 *                                what the erasure module can reach and a journal row is
 *                                what it cannot. This line exists so a future widening
 *                                has to delete a sentence rather than add one.
 *   <endpoint>:failed            error bodies are outside the sink allowlist
 */
export const AGENT_OBSERVATION_PAYLOAD_DENYLIST: ReadonlySet<string> = new Set([
  "ofapi_admin_accounts",
  "account_me",
  "account_lookup",
  "group_detail",
  "followers",
  "earnings_accounts",
  // WP-F7. See the note above: both are refused by absence already, and named
  // here so the refusal carries its reason.
  "payout_methods",
  "payout_requests",
  // WP-F5 / WP-S1. Refused by absence already; named so the refusal carries its
  // reason. See the block comment above.
  "post_replies",
]);

export function agentObservationPayloadAllowed(kind: string): boolean {
  if (kind.endsWith(":failed")) {
    return false;
  }
  if (AGENT_OBSERVATION_PAYLOAD_DENYLIST.has(kind)) {
    return false;
  }
  return AGENT_OBSERVATION_PAYLOAD_ALLOWLIST.has(kind);
}

/**
 * Query parameters that mark a URL as a SIGNED delivery address. Any URL carrying
 * one is removed whole, never truncated: half a signed URL is still a leak of the
 * policy document, and a stripped one is a broken string pretending to be data.
 */
const SIGNATURE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "signature",
  "policy",
  "key-pair-id",
  "keypairid",
  "expires",
  "token",
  "ngsw-bypass",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-algorithm",
  "x-amz-date",
  "x-amz-expires",
  "x-amz-signedheaders",
  "sig",
  "sp",
  "st",
  "se",
  "sv",
  "sr",
]);

/** Object keys whose VALUE is secret regardless of shape. */
const SECRET_KEY_PATTERN = /(password|secret|token|authorization|cookie|session|api[_-]?key|bearer|credential|signature|checkoutkey)/i;

export interface ObservationScrubResult {
  /** null when the body is not a JSON OBJECT this walker can traverse. The caller
   *  turns that into an explicit `withheldReason`; an empty `{}` with no reason
   *  would be a silent hole pretending to be an empty payload. */
  payload: Record<string, unknown> | null;
  signedUrlsRemoved: number;
  secretsRedacted: number;
  pathsRemoved: string[];
}

const MAX_SCRUB_DEPTH = 24;
const MAX_PATHS_REPORTED = 200;

/**
 * `pathsRemoved` entries are `z.string().min(1).max(200)` on the wire, and a
 * violation is a 500 raised by the SERIALIZER — after the audit row was written
 * and after the caller was told nothing. Two real payload shapes produced one: a
 * scalar or array at the top level notes the ROOT, whose path is the empty string,
 * and a deep object with long JSON keys notes a path over 200 characters.
 *
 * The root gets a nonempty marker, and an over-long path is truncated with a
 * digest of the whole thing appended — bounded, and still distinguishable from
 * every other truncated path.
 */
const ROOT_PATH_MARKER = "$";
const MAX_PATH_LENGTH = 200;
const PATH_DIGEST_LENGTH = 32;

/** URL-decodes a query-parameter NAME, treating a malformed escape as suspicious
 *  rather than throwing. `decodeURIComponent("%ZZ")` throws, and a scrubber that
 *  throws on hostile input is not fail-closed, it is fail-crashed. */
function decodeParamName(raw: string): string {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Whether a string CONTAINS a signed delivery address.
 *
 * Deliberately not anchored to the start of the string. The first revision only
 * matched a value that WAS a URL, so a signed address embedded in a caption, an
 * HTML fragment or a JSON-in-a-string blob passed straight through — and the test
 * suite pinned that miss as if it were the design. Anything carrying a signature
 * parameter is a signed address wherever it sits.
 */
function looksLikeSignedUrl(value: string): boolean {
  const pattern = /https?:\/\/[^\s"'<>]*\?[^\s"'<>]*/gi;
  for (const match of value.matchAll(pattern)) {
    const url = match[0];
    const queryStart = url.indexOf("?");
    if (queryStart < 0) {
      continue;
    }
    // Parsed by hand rather than with `new URL`: `URL` rejects plenty of strings a
    // vendor happily emits, and a rejection here must never mean "safe".
    for (const pair of url.slice(queryStart + 1).split(/[&;]/)) {
      const name = decodeParamName(pair.split("=", 1)[0] ?? "");
      if (SIGNATURE_QUERY_PARAMS.has(name)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Walks the payload and removes signed URLs and secret-looking values.
 *
 * FAIL-CLOSED on structure: a value nested deeper than `MAX_SCRUB_DEPTH`, or of a
 * type this walker does not understand, is WITHHELD rather than passed through.
 * The alternative — "unknown shape, must be fine" — is how a scrubber quietly
 * stops scrubbing when a vendor adds a field.
 */
/** One reported path, forced inside the response schema's `[1, 200]` bound. */
export function boundedScrubPath(path: string): string {
  if (path === "") {
    return ROOT_PATH_MARKER;
  }
  if (path.length <= MAX_PATH_LENGTH) {
    return path;
  }
  const digest = createHash("sha256").update(path, "utf8").digest("hex")
    .slice(0, PATH_DIGEST_LENGTH);
  return `${path.slice(0, MAX_PATH_LENGTH - PATH_DIGEST_LENGTH - 1)}~${digest}`;
}

export function scrubObservationPayload(payload: unknown): ObservationScrubResult {
  let signedUrlsRemoved = 0;
  let secretsRedacted = 0;
  const pathsRemoved: string[] = [];

  const note = (path: string) => {
    if (pathsRemoved.length >= MAX_PATHS_REPORTED) {
      return;
    }
    pathsRemoved.push(boundedScrubPath(path));
  };

  const walk = (value: unknown, path: string, depth: number): unknown => {
    if (depth > MAX_SCRUB_DEPTH) {
      note(path);
      return null;
    }
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case "string":
        if (looksLikeSignedUrl(value)) {
          signedUrlsRemoved += 1;
          note(path);
          return null;
        }
        return value;
      case "number":
      case "boolean":
        return value;
      case "object":
        break;
      default:
        // functions, symbols, bigints: not JSON, so not something a payload can
        // legitimately hold. Withheld rather than coerced.
        note(path);
        return null;
    }
    if (Array.isArray(value)) {
      return value.map((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
    }
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (SECRET_KEY_PATTERN.test(key)) {
        secretsRedacted += 1;
        note(childPath);
        result[key] = null;
        continue;
      }
      result[key] = walk(entry, childPath, depth + 1);
    }
    return result;
  };

  const walked = walk(payload, "", 0);
  const servable = walked !== null && typeof walked === "object" && !Array.isArray(walked);
  if (!servable) {
    // An array or a scalar at the top is not the shape this operation serves, and
    // pretending it is an empty object would hide the refusal.
    note("");
  }
  return {
    payload: servable ? walked as Record<string, unknown> : null,
    signedUrlsRemoved,
    secretsRedacted,
    pathsRemoved,
  };
}

/** At most this many payload reads per owner session per UTC day. */
export const AGENT_OBSERVATION_PAYLOAD_SESSION_CAP = 25;
