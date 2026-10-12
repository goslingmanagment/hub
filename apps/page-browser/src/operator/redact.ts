// A body to be written to disk, with what may be a secret or a person's
// contact taken out first (capture mode "redacted"). The in-memory inventory
// of the fifth pilot session found the login e-mail in `account/me` and in
// the accounts of `timeline/home`, a token field in `account/me` and a
// session-like field in `versioning`: a body is never written as it came.
//
// Taken out — the value becomes "[redacted:<category>]":
// - the whole value of every key whose name falls in a sensitive category
//   (the categories of the inventory: e-mail, password, token, session,
//   phone, 2FA, cookie, API key, id number, bank, birth), at any depth;
// - any string value that looks like an e-mail address or a JWT, whatever
//   its key; such a key itself is renamed `[redacted:<category>#n]`.
// The whole tree is walked (no sampling). A body that is not JSON, is over
// the size, or has more nodes than the bound is not written at all.

import { categoryOf } from "./inventory.ts";

// Linear in the string's length, whatever it holds: a regular expression
// searched along a long string (a 300 KB value without "@") is quadratic and
// stalled the operator on the stand until its watchdog killed it.
const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;
function looksLikeEmail(text: string): boolean {
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at > 0 && LOCAL_CHAR.test(text[at - 1]!) && DOMAIN.test(text.slice(at + 1, at + 256))) return true;
  }
  return false;
}
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
function looksLikeJwt(text: string): boolean {
  // Anchored, and only on a string with exactly two dots and a token's size.
  if (text.length < 26 || text.length > 16_384) return false;
  const first = text.indexOf(".");
  const second = first === -1 ? -1 : text.indexOf(".", first + 1);
  if (second === -1 || text.indexOf(".", second + 1) !== -1) return false;
  return JWT.test(text);
}
const MAX_NODES = 5_000_000;

export type Redacted = { ok: true; text: string; redactions: Record<string, number> } | { ok: false; reason: string };

export function redactBody(chunks: Buffer[] | null, over: boolean, maxBytes: number): Redacted {
  if (over || chunks === null) return { ok: false, reason: `over ${maxBytes} bytes` };
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  const redactions: Record<string, number> = {};
  const mark = (category: string): string => {
    redactions[category] = (redactions[category] ?? 0) + 1;
    return `[redacted:${category}]`;
  };
  let nodes = 0;
  let keys = 0;
  let overflow = false;
  const walk = (node: unknown): unknown => {
    if (++nodes > MAX_NODES) {
      overflow = true;
      return null;
    }
    if (typeof node === "string") {
      if (looksLikeJwt(node)) return mark("token");
      if (looksLikeEmail(node)) return mark("email");
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        // A key can be data too: an address or a token as a key goes.
        const name = looksLikeJwt(key) ? `[redacted:token#${++keys}]` : looksLikeEmail(key) ? `[redacted:email#${++keys}]` : key;
        if (name !== key) redactions.key = (redactions.key ?? 0) + 1;
        const category = categoryOf(key);
        out[name] = category !== null ? mark(category) : walk(child);
      }
      return out;
    }
    return node;
  };
  let result: unknown;
  try {
    result = walk(value);
  } catch (error) {
    // Nesting deeper than the stack: not written.
    return { ok: false, reason: `not walked: ${(error as Error).message.slice(0, 80)}` };
  }
  if (overflow) return { ok: false, reason: `over ${MAX_NODES} nodes` };
  return { ok: true, text: JSON.stringify(result), redactions };
}
