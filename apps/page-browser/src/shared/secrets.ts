// Secrets the page's processes hold in memory and must never write anywhere
// (plan §4.5, §4.7, §4.11): the engine's RPC token, the page's SOCKS5 login
// and password, the site's live session (its token, client and session ids,
// learned from the site's own requests — hub-requests/session.ts). What is
// never passed to a log is the first rule; this is the second: every line a
// log or a journal writes goes through `scrub`, and
// - a registered value that slipped into it anyway is cut out;
// - so is the value of any JSON key that names a header or a field that
//   carries a session or a password (`authorization`, `cookie`,
//   `fansly-session-id`...), whatever the value is — one never seen yet
//   included — and an `Authorization`-like value after "Bearer ".

const secrets = new Set<string>();

/** JSON keys whose string value never reaches a line. */
const SECRET_KEYS = /("(?:authorization|proxy-authorization|cookie|set-cookie|set-cookie2|fansly-session-id|fansly-client-id|fansly-client-check|password|passwd|session|token|access_token)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;
/** A bearer credential inside any text. */
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;

/** Remember a value that must never be written (and its JSON-escaped form). */
export function registerSecret(value: string): void {
  // Shorter values would cut ordinary words — and JSON's own `true`,
  // `false`, `null` — out of the lines.
  if (value.length < 6) return;
  secrets.add(value);
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value) secrets.add(escaped);
}

/** A line with every registered secret, every secret key's value and every
 *  bearer credential replaced by "[secret]". */
export function scrub(line: string): string {
  let out = line.replace(SECRET_KEYS, '$1"[secret]"').replace(BEARER, "$1[secret]");
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join("[secret]");
  }
  return out;
}

/** Tests only: forget what was registered. */
export function forgetSecrets(): void {
  secrets.clear();
}
