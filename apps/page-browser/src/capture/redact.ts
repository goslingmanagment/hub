// What the stand's publish capture (capture/publish.ts) writes of a request
// and its answer, cut of its secrets first. The capture is there to show the
// site's publishing requests as they are — paths, bodies, units, ids — so it
// keeps them; what it must never keep is the account's session and identity:
// no authorization, cookie, session or client id, no token, no password, not
// the account's e-mail; and no signature that lets a URL be fetched.
//
//   bodies   Hub's own strip of Fansly's signed CDN tokens first
//            (capture/cdn-tokens.ts, as Hub journals reads); then every
//            field named like a secret (`SECRET_FIELD`) is "[redacted]",
//            whatever its value; every string that is one https URL has the
//            values of its signing params cut (`urlRedacted`); every e-mail
//            address in any string is "[e-mail]";
//   URLs     the values of their signing params cut: a part's storage URL
//            keeps where it goes and for how long, never what signs it;
//   headers  names always; values only of `KEPT_HEADERS`, which carry no
//            session (a Referer or Location loses its query).
//
// Every line goes through the journal's own scrubber besides
// (shared/secrets.ts): the session's registered values and secret keys.

import { stripFanslySignedCdnTokens } from "./cdn-tokens.ts";

/** Query params that sign a URL (S3's presigned and CloudFront's): their
 *  values are cut, their names kept. `X-Amz-Date` and `X-Amz-Expires` say
 *  when and for how long — they stay. */
const SIGNING_PARAM = /^(x-amz-signature|x-amz-credential|x-amz-security-token|signature|key-pair-id|policy|token|sig|access_token)$/i;

/** A field whose value is the account's secret or identity. */
const SECRET_FIELD = /^(e-?mail(address)?|.*_?email|password|passwd|.*password|token|.*token|access_?token|refresh_?token|session|session_?id|secret|.*secret|authorization|cookie|phone(_?number)?|ip(_?address)?|last_?ip|stream_?key|totp|otp|twofa.*)$/i;

/** One e-mail address inside any text. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** A string that is one https URL and nothing else. */
const LONE_HTTPS_URL = /^https:\/\/[!-~]+$/;

export const REDACTED = "[redacted]";
export const STRIPPED = "[stripped]";

/** The headers whose values are kept (lower case): none of them carries the
 *  session or the account. */
export const KEPT_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "access-control-max-age",
  "access-control-request-headers",
  "access-control-request-method",
  "cache-control",
  "content-encoding",
  "content-length",
  "content-type",
  "date",
  "etag",
  "location",
  "ngsw-bypass",
  "origin",
  "referer",
  "retry-after",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "server",
  "vary",
  "x-amz-request-id",
]);

/** A URL with the values of its signing params cut (names and order kept);
 *  a text that does not parse as one comes back with its e-mails cut only. */
export function urlRedacted(raw: string): string {
  const queryStart = raw.indexOf("?");
  if (queryStart < 0) return raw.replace(EMAIL, "[e-mail]");
  const fragmentStart = raw.indexOf("#", queryStart);
  const queryEnd = fragmentStart < 0 ? raw.length : fragmentStart;
  const pairs = raw
    .slice(queryStart + 1, queryEnd)
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");
      const name = equals < 0 ? pair : pair.slice(0, equals);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        // kept as written
      }
      return equals >= 0 && SIGNING_PARAM.test(decoded) ? `${name}=${STRIPPED}` : pair;
    });
  return `${raw.slice(0, queryStart)}?${pairs.join("&")}${raw.slice(queryEnd)}`.replace(EMAIL, "[e-mail]");
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return LONE_HTTPS_URL.test(value) ? urlRedacted(value) : value.replace(EMAIL, "[e-mail]");
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const safeKey = key.replace(EMAIL, "[e-mail]");
      // A served `__proto__` key is data.
      Object.defineProperty(out, safeKey, { value: SECRET_FIELD.test(key) && entry !== null && entry !== "" ? REDACTED : redactValue(entry), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/** A JSON body as the capture writes it (see above). */
export function bodyRedacted(value: unknown): unknown {
  return redactValue(stripFanslySignedCdnTokens(value));
}

/** Headers as the capture writes them: every name, in lower case; the value
 *  of a kept one (a Referer's or a Location's without its query), else
 *  "[not kept]". */
export function headersRedacted(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower.startsWith(":")) continue;
    if (!KEPT_HEADERS.has(lower)) {
      out[lower] = "[not kept]";
      continue;
    }
    const text = String(value);
    out[lower] = lower === "referer" || lower === "location" ? text.split(/[?#]/, 1)[0]! : text.replace(EMAIL, "[e-mail]");
  }
  return out;
}
