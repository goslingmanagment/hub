/**
 * Operation 9b: which capture-journal payloads may be shown at all, and what has
 * to come out of them first.
 *
 * A DENYLIST CANNOT WORK HERE, and this was checked rather than assumed:
 * `RESTRICTED_OBSERVATION_KINDS` is exactly `["desktop.guard_audit"]` and is
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
  // Already trimmed of `content` before it reaches the journal.
  "dm_conversations",
  // Owner ruling (OPEN 13): IN, because `accountMedia`/`tips`/`storyOrders` live
  // here and they are exactly what a customs audit needs. Admitted only WITH the
  // signed-URL scrub below, which is pinned by golden fixtures.
  "dm_messages",
]);

/**
 * Kinds refused unconditionally, listed by name so a reader sees the reasoning
 * rather than inferring it from an omission. (The allowlist already refuses them;
 * this exists so a future widening has to delete a line that says why.)
 *
 *   account_me / account_lookup  vendor auth material and session state
 *   group_detail                 permission flags and user settings
 *   followers                    trimmed at capture; the journal row is not the fact
 *   earnings_accounts            payout account identifiers
 *   <endpoint>:failed            error bodies are outside the sink allowlist
 */
export const AGENT_OBSERVATION_PAYLOAD_DENYLIST: ReadonlySet<string> = new Set([
  "account_me",
  "account_lookup",
  "group_detail",
  "followers",
  "earnings_accounts",
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
  payload: Record<string, unknown>;
  signedUrlsRemoved: number;
  secretsRedacted: number;
  pathsRemoved: string[];
}

const MAX_SCRUB_DEPTH = 24;
const MAX_PATHS_REPORTED = 200;

function looksLikeSignedUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) {
    return false;
  }
  const queryStart = value.indexOf("?");
  if (queryStart < 0) {
    return false;
  }
  // Parsed by hand rather than with `new URL`: a malformed address must be
  // treated as suspicious, not thrown on, and `URL` rejects plenty of strings a
  // vendor happily emits.
  for (const pair of value.slice(queryStart + 1).split("&")) {
    const name = pair.split("=", 1)[0]?.toLowerCase() ?? "";
    if (SIGNATURE_QUERY_PARAMS.has(decodeURIComponent(name))) {
      return true;
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
export function scrubObservationPayload(payload: unknown): ObservationScrubResult {
  let signedUrlsRemoved = 0;
  let secretsRedacted = 0;
  const pathsRemoved: string[] = [];

  const note = (path: string) => {
    if (pathsRemoved.length < MAX_PATHS_REPORTED) {
      pathsRemoved.push(path);
    }
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
  return {
    // A payload that is not a JSON object at the top is not servable as one.
    payload: walked !== null && typeof walked === "object" && !Array.isArray(walked)
      ? walked as Record<string, unknown>
      : {},
    signedUrlsRemoved,
    secretsRedacted,
    pathsRemoved,
  };
}

/** At most this many payload reads per owner session per UTC day. */
export const AGENT_OBSERVATION_PAYLOAD_SESSION_CAP = 25;
