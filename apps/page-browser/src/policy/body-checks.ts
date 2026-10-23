// The checks of a body for the writes the map opens by their body
// (policy/operations.ts `CHECKED_ROWS`; owner decision 2026-10-23). The
// operator runs one on the bytes Fetch attached to the paused request, as
// they go to Fansly (intercept/checked.ts), and lets the request go only when
// it passes. Closed by default: whatever the check cannot read as the one
// body it opens is refused.
//
// The delivered mark: `POST /message/ack` with `{messageIds, type}` (the
// site's bundle: `ackMessages(type, ids)` posts `{messageIds: ids, type}`
// through Angular, which writes it with JSON.stringify; `chunkAckMessages`
// sends at most 25 ids a request, 200 ms apart, and tries a failed one no
// more). Type 1 — delivered — clears no unread; 2, 3 (read) and 4 (unread)
// are the chatters' to set. It passes only when:
//   - the body is UTF-8 JSON of an object with exactly the keys `messageIds`
//     and `type`, at most `MARK_BODY_MAX` bytes;
//   - `type` is the number 1;
//   - `messageIds` is a list of 1 to 25 strings of digits;
//   - the body is byte for byte that object as JSON.stringify writes it,
//     its keys in their order: no whitespace, no escape, no repeated key.
//     A server may read a repeated key's first value, or an escaped key as
//     another, where JSON.parse reads the last: the bytes that go are the
//     bytes that were read, or nothing goes.

import type { BodyCheck } from "./operations.ts";

/** What a check said: on, with a word for the journal; or why not. */
export type BodyVerdict = { ok: true; note: string } | { ok: false; why: string };

/** The delivered mark's type (the site's `ackMessages(1, …)`). */
export const DELIVERED = 1;
/** Ids a mark carries at most: the site's chunk. */
export const MARK_IDS_MAX = 25;
/** A delivered mark's body at most, in bytes: 25 ids of 64 bits take under
 *  700. */
export const MARK_BODY_MAX = 4096;

const DIGITS = /^[0-9]+$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function refuse(why: string): BodyVerdict {
  return { ok: false, why };
}

/** A mark's type in words, for the journal (never more of the body). */
function kindOf(type: unknown): string {
  if (typeof type !== "number") return `a mark whose type is no number (${type === null ? "null" : typeof type})`;
  if (type === 2 || type === 3) return `a read mark (type ${type})`;
  if (type === 4) return "an unread mark (type 4)";
  return Number.isInteger(type) && Math.abs(type) < 1000 ? `a mark of type ${type}` : "a mark of another type";
}

/** The delivered mark's check (see above). */
export function checkDeliveredMark(body: Buffer): BodyVerdict {
  if (body.length === 0) return refuse("no body");
  if (body.length > MARK_BODY_MAX) return refuse(`a body of ${body.length} bytes, over the ${MARK_BODY_MAX} a mark takes`);
  let text: string;
  try {
    text = UTF8.decode(body);
  } catch {
    return refuse("a body that is no UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("a body that is no JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refuse("a body that is no JSON object");
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("messageIds") || !keys.includes("type")) return refuse(`a body with ${keys.length} key(s), not exactly messageIds and type`);
  const { messageIds, type } = parsed as { messageIds: unknown; type: unknown };
  if (type !== DELIVERED) return refuse(kindOf(type));
  if (!Array.isArray(messageIds)) return refuse("messageIds that is no list");
  if (messageIds.length < 1 || messageIds.length > MARK_IDS_MAX) return refuse(`${messageIds.length} message ids, not 1 to ${MARK_IDS_MAX}`);
  if (!messageIds.every((id) => typeof id === "string" && DIGITS.test(id))) return refuse("a message id that is no string of digits");
  if (!Buffer.from(JSON.stringify(parsed), "utf8").equals(body)) return refuse("a body not as the site writes it (whitespace, an escape or a repeated key)");
  return { ok: true, note: `a delivered mark (type ${DELIVERED}) of ${messageIds.length} message id(s), its body checked` };
}

/** Each check by its name in the map. */
export const BODY_CHECKS: Readonly<Record<BodyCheck, (body: Buffer) => BodyVerdict>> = {
  delivered_mark: checkDeliveredMark,
};
