// `fansly-client-ts` as Fansly's web app sets it (bundle
// main.0498e26990eb6fa6.js, read 2026-10-22). Its visible header interceptor
// puts the clock ± 5 s there; a hidden one (`window._videoJsInitOld`, its
// strings in octal), registered after it and so the last word, overwrites it
// with a service's `getNowTs()`:
//
//   - a session signed in: the session service's — the tail from the
//     session's id, the value the same interceptor sends as
//     `fansly-session-id`;
//   - none: the device service's — the tail from the device's id, the value
//     it sends as `fansly-client-id`;
//   - no id at all: the time itself.
//
// getNowTs: the time (with the server's offset, which the app sets only past
// 30 s of difference) in decimal; its last four digits replaced by two pairs
// — `id[-1] XOR time[-6]`, then `id[-2] XOR time[-5]`, a one-digit result
// padded with `id[-3]`, resp. `id[-1]`; and never below a value the same
// service gave before. Six real HARs of the site agree: 405 of 405 requests
// with a session, 3 of 3 without one.
//
// Two copies, side by side — the operator's image carries no packages:
// packages/fansly/src/client-ts.ts (the Node pages' headers) and
// apps/page-browser/src/hub-requests/client-ts.ts (the operator's Hub
// requests). tests/fansly-client-ts.test.ts holds both to vectors Fansly's
// own code gave.

/** Fansly's formula (getNowTs without its cache), line for line: `timeMs`
 *  an integer of ms, `id` the session's or the device's. Self-contained: the
 *  stand's site runs its text (stand/fansly/front.ts). */
export function fanslyClientTs(timeMs: number, id: string | null | undefined): number {
  let k = String(timeMs);
  if (id) {
    const g = k.slice(0, -4);
    let c = (parseInt(id[id.length - 2]!) ^ parseInt(g[g.length - 1]!)).toString();
    if (c.length < 2) c += id[id.length - 1];
    let f = (parseInt(id[id.length - 1]!) ^ parseInt(g[g.length - 2]!)).toString();
    if (f.length < 2) f += id[id.length - 3];
    k = g + f + c;
  }
  return parseInt(k);
}

/** getNowTs with its cache: never below a value it gave before (Fansly keeps
 *  one per service, for as long as the document lives). */
export class FanslyClientTsClock {
  #cached = 0;

  next(timeMs: number, id: string | null | undefined): number {
    const value = fanslyClientTs(timeMs, id);
    if (this.#cached > value) return this.#cached;
    this.#cached = value;
    return value;
  }
}

/** Whether a `fansly-client-ts` the site sent carries the formula's tail for
 *  `id`: its last four digits are what the formula gives its leading ones,
 *  whatever the site's clock and offset. Only decimal values and ids are
 *  what the formula was seen to take: anything else is no match. */
export function fanslyClientTsTailMatches(value: string, id: string): boolean {
  if (!/^\d{6,16}$/.test(value) || !/^\d{3,}$/.test(id)) return false;
  return String(fanslyClientTs(Number(value), id)) === value;
}
