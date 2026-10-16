// The site's live session, for Hub requests (plan §4.7; stage 1, amendment
// 15). Hub keeps no Fansly token for a browser page: the session lives in
// the browser's profile, and the operator takes it from the site's own API
// requests as they stop in Fetch.
//
// - The template: the headers the site's script set on its last API GET
//   with an `authorization`, in their order (Fansly's Angular interceptors:
//   accept, authorization, fansly-client-id, -ts, -session-id, -check), the
//   browser's own headers left out. A Hub request gets the template, with
//   its own `fansly-client-ts` and `fansly-client-check`, then the route's
//   headers the engine sent that the template does not have.
// - `fansly-client-ts`: as the site keeps it — its clock ± 5 s, refreshed
//   every 3 s, never going back (Fansly's bundle).
// - `fansly-client-check`: the site computes it for each of its requests —
//   cyrb53 of `<key>_<path>_<client id>` in hex, the key from the site's
//   public bundle (2026-10-11). It is checked against every value the site
//   computes itself: a different one means the site's algorithm or key
//   changed — an alarm, and no Hub request goes (amendment 15).
// - The fingerprint (plan §4.7): sha256 of the token and the client id. The
//   engine sends the one it expects with every request (`send`), the
//   operator says the live one in `state` and `check`: a request is never
//   released under another session than the one its headers were built
//   with.
// - Header parity (plan §4.7): the names and their order, never the
//   values, of a Hub request as Chrome sent it (requestWillBeSentExtraInfo)
//   against the site's last request to the same path. The cache's own
//   validators and the cookie jar's header are left out of the comparison:
//   they follow the browser's state, not the client. A difference means the
//   transport is not ready: the page stands, the owner gets an alarm.
//
// Kept in memory only, and forgotten with the browser (a new start learns it
// again): the values are never logged or written, and they are registered
// as secrets (shared/secrets.ts), so a line that carried one anyway would
// lose it.

import { createHash } from "node:crypto";

import { authorizationBytes } from "../egress/socket-gate.ts";
import { registerSecret } from "../shared/secrets.ts";

/** Fansly's key of fansly-client-check (public bundle, 2026-10-11). */
export const FANSLY_CHECK_KEY = "necvac-govry3-tybkYz";

/** Headers Chrome sets itself: not the site's script's, never copied. */
const BROWSER_HEADERS = new Set([
  "user-agent",
  "referer",
  "origin",
  "accept-encoding",
  "accept-language",
  "host",
  "connection",
  "cookie",
  "content-length",
  "priority",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "sec-fetch-storage-access",
  "upgrade-insecure-requests",
]);

/** The session's own headers: from the live session, never the engine's. */
export const SESSION_HEADERS = new Set(["authorization", "fansly-client-id", "fansly-session-id", "fansly-client-ts", "fansly-client-check"]);

/** Left out of the parity: they follow the cache and the cookie jar — and
 *  fansly-session-id the site's socket: a document sends it only once its
 *  socket is up, so the site's own requests to one path differ in it over a
 *  document's life (pilot 2, 2026-10-16). Hub's follow the latest template. */
const PARITY_IGNORED = new Set(["cookie", "if-none-match", "if-modified-since", "fansly-session-id"]);

/** cyrb53, as Fansly's bundle computes fansly-client-check. */
export function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function fanslyClientCheck(pathname: string, clientId: string, key = FANSLY_CHECK_KEY): string {
  return cyrb53(`${key}_${pathname}_${clientId}`).toString(16);
}

/** The session's fingerprint: sha256 of the token and the client id. */
export function sessionFingerprint(authorization: string, clientId: string): string {
  return createHash("sha256").update(`fansly-session/1\n${authorization}\n${clientId}`, "utf8").digest("hex");
}

function header(headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

export type BuiltHeaders = { ok: true; headers: Array<[string, string]>; fingerprint: string } | { ok: false; why: string };

export interface SiteSessionOptions {
  /** Wall clock, ms. */
  now?: () => number;
  random?: () => number;
  /** The live fingerprint changed (a login, a new session). */
  onChange?: (fingerprint: string | null) => void;
  /** The site computed fansly-client-check another way than ours (once). */
  onCheckMismatch?: (path: string) => void;
  /** Names of a Hub request differ from the site's for the same path. */
  onHeaderMismatch?: (path: string, hub: string[], site: string[]) => void;
}

/** Paths a parity is kept for, at most. */
const PARITY_PATHS = 500;

export class SiteSession {
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #options: SiteSessionOptions;
  #template: Array<[string, string]> | null = null;
  #fingerprint: string | null = null;
  #checkOk: boolean | null = null;
  #checkAlarmed = false;
  #clientTs = 0;
  #clientTsAt = Number.NEGATIVE_INFINITY;
  /** The last names the site's and Hub's requests went with, by path. */
  readonly #siteNames = new Map<string, string[]>();
  readonly #hubNames = new Map<string, string[]>();
  #parityBroken = false;

  constructor(options: SiteSessionOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  /** The live session's fingerprint, or null when none was seen. */
  get fingerprint(): string | null {
    return this.#fingerprint;
  }

  /** The bytes of the site socket's authorization with the live token —
   *  what the socket gate lets go once a connection (egress/socket-gate.ts);
   *  null: no live session. The token itself stays here. */
  socketAuthorizationBytes(): number | null {
    const token = this.#template === null ? undefined : header(this.#template, "authorization");
    return token === undefined || token === "" ? null : authorizationBytes(token);
  }

  /** Our fansly-client-check matched the site's own (null: not seen yet). */
  get checkOk(): boolean | null {
    return this.#checkOk;
  }

  /** A request of the site's own to the API, as it stopped in Fetch. */
  note(request: { method: string; url: string; headers: Record<string, string> }): void {
    if (request.method.toUpperCase() !== "GET") return;
    const template: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(request.headers)) {
      if (!BROWSER_HEADERS.has(name.toLowerCase())) template.push([name, value]);
    }
    const authorization = header(template, "authorization");
    if (authorization === undefined || authorization === "") return;
    const clientId = header(template, "fansly-client-id") ?? "";
    for (const name of ["authorization", "fansly-client-id", "fansly-session-id"]) {
      const value = header(template, name);
      if (value !== undefined) registerSecret(value);
    }
    this.#template = template;
    const fingerprint = sessionFingerprint(authorization, clientId);
    if (fingerprint !== this.#fingerprint) {
      this.#fingerprint = fingerprint;
      this.#options.onChange?.(fingerprint);
    }
    const check = header(template, "fansly-client-check");
    const path = pathOf(request.url);
    if (check !== undefined && clientId !== "" && path !== null) {
      this.#checkOk = fanslyClientCheck(path, clientId) === check;
      if (!this.#checkOk && !this.#checkAlarmed) {
        this.#checkAlarmed = true;
        this.#options.onCheckMismatch?.(path);
      }
    }
  }

  /** The site's cached client time: its clock ± 5 s, refreshed every 3 s,
   *  never going back. */
  clientTs(): number {
    const now = this.#now();
    if (now - this.#clientTsAt >= 3000) {
      this.#clientTsAt = now;
      const next = now + (5000 - Math.floor(10_000 * this.#random()));
      if (next > this.#clientTs) this.#clientTs = next;
    }
    return this.#clientTs;
  }

  /** The headers of a Hub request to `pathname`: the site's template with
   *  its time and check, then the route's own (`extra`) the template lacks;
   *  or why there are none. */
  headersFor(pathname: string, extra: Record<string, string>): BuiltHeaders {
    const template = this.#template;
    const fingerprint = this.#fingerprint;
    if (template === null || fingerprint === null) return { ok: false, why: "no live session of the site yet: it made no API request with authorization" };
    if (this.#checkOk === false) return { ok: false, why: "the site computes fansly-client-check another way than the operator: the transport is not ready" };
    if (this.#parityBroken) return { ok: false, why: "a Hub request's headers differed from the site's: the transport is not ready" };
    const clientId = header(template, "fansly-client-id") ?? "";
    const out: Array<[string, string]> = [];
    for (const [name, value] of template) {
      const lower = name.toLowerCase();
      if (lower === "fansly-client-ts") out.push([name, String(this.clientTs())]);
      else if (lower === "fansly-client-check") out.push([name, fanslyClientCheck(pathname, clientId)]);
      else out.push([name, value]);
    }
    for (const [name, value] of Object.entries(extra)) {
      if (!out.some(([have]) => have.toLowerCase() === name.toLowerCase())) out.push([name, value]);
    }
    return { ok: true, headers: out, fingerprint };
  }

  /** The names a request went with (requestWillBeSentExtraInfo): of the
   *  site's, or of a Hub request. Compared per path; a difference is told
   *  once and keeps Hub requests from going until the browser starts anew. */
  noteSent(path: string, names: readonly string[], hub: boolean): void {
    const kept = names.map((name) => name.toLowerCase()).filter((name) => !PARITY_IGNORED.has(name));
    const mine = hub ? this.#hubNames : this.#siteNames;
    const theirs = hub ? this.#siteNames : this.#hubNames;
    mine.delete(path);
    mine.set(path, kept);
    if (mine.size > PARITY_PATHS) mine.delete(mine.keys().next().value!);
    const other = theirs.get(path);
    if (other === undefined || this.#parityBroken) return;
    if (other.length === kept.length && other.every((name, index) => name === kept[index])) return;
    this.#parityBroken = true;
    const [hubNames, siteNames] = hub ? [kept, other] : [other, kept];
    this.#options.onHeaderMismatch?.(path, hubNames, siteNames);
  }

  /** The work tab's document was replaced: the session goes on (its
   *  fingerprint and its headers stay), but the new document has no socket
   *  yet, so no fansly-session-id — Hub's requests go without it until the
   *  new document's own request shows one. Not waiting for that request:
   *  before the identity read its authorized GETs sit behind preflights the
   *  engine refuses (pilot 2, 2026-10-16). The names it sent are compared
   *  afresh; a broken parity stays broken. */
  newDocument(): void {
    this.#template = this.#template?.filter(([name]) => name.toLowerCase() !== "fansly-session-id") ?? null;
    this.#siteNames.clear();
    this.#hubNames.clear();
  }

  /** A new browser: nothing of the old session is kept. */
  reset(): void {
    const had = this.#fingerprint !== null;
    this.#template = null;
    this.#fingerprint = null;
    this.#checkOk = null;
    this.#checkAlarmed = false;
    this.#siteNames.clear();
    this.#hubNames.clear();
    this.#parityBroken = false;
    if (had) this.#options.onChange?.(null);
  }
}
