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
// - `fansly-client-ts`: as the site's hidden interceptor sets it (Fansly's
//   getNowTs, client-ts.ts) — the clock with its last four digits from the
//   session's id (the template's fansly-session-id; without it the device's,
//   fansly-client-id), never going back. The time is the operator's clock:
//   Chrome runs on the same one, and the site adds the server's offset only
//   past 30 s of difference, which a host kept by NTP does not reach (six
//   real HARs: the formula at a request's own start gives the value it
//   sent, 407 of 408 — the one off crossed a 10 s step). No estimate of an
//   offset from the site's values, then: one more rule to be wrong. The
//   tail is checked against every value the site sends itself (the value's
//   own leading digits, so whatever its clock): a different one means the
//   site's formula changed — an alarm, and no Hub request goes, as with
//   fansly-client-check.
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
// - The socket's authorization (plan-b §4.1.9): its size from the token of
//   the site's own `session_active_session` in its storage (DOMStorage) — the
//   socket may authorize before the document's first API GET. Only the size
//   is kept, never the token. Until the storage was seen, the template's
//   token stands in.
// - Header parity (plan §4.7): the names and their order, never the
//   values, of a Hub request as Chrome sent it (requestWillBeSentExtraInfo)
//   against the site's last request to the same path. The cache's own
//   validators and the cookie jar's header are left out of the comparison:
//   they follow the browser's state, not the client. A difference is an
//   alarm (once for each difference) and the path learned afresh from the
//   site's next request to it; Hub's requests go on — they follow the
//   site's latest template. Hub stands only on a wrong fansly-client-check
//   or fansly-client-ts, or with no session or template.
//
// Kept in memory only, and forgotten with the browser (a new start learns it
// again): the values are never logged or written, and they are registered
// as secrets (shared/secrets.ts), so a line that carried one anyway would
// lose it.

import { createHash } from "node:crypto";

import { authorizationBytes } from "../egress/socket-gate.ts";
import { registerSecret } from "../shared/secrets.ts";
import { FanslyClientTsClock, fanslyClientTsTailMatches } from "./client-ts.ts";

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
  /** The live fingerprint changed (a login, a new session). */
  onChange?: (fingerprint: string | null) => void;
  /** The site computed a client header another way than ours (once each). */
  onCheckMismatch?: (path: string, header: "fansly-client-check" | "fansly-client-ts") => void;
  /** Names of a Hub request differ from the site's for the same path (once
   *  for each difference). */
  onHeaderMismatch?: (path: string, hub: string[], site: string[]) => void;
}

/** Paths a parity is kept for, at most. */
const PARITY_PATHS = 500;
/** Differences of the parity told, at most (a browser's life). */
const PARITY_TOLD = 100;

export class SiteSession {
  readonly #now: () => number;
  readonly #options: SiteSessionOptions;
  #template: Array<[string, string]> | null = null;
  #fingerprint: string | null = null;
  #checkOk: boolean | null = null;
  #checkAlarmed = false;
  /** The site's fansly-client-ts carried our formula's tail (null: none
   *  judged yet). */
  #tsOk: boolean | null = null;
  #tsAlarmed = false;
  /** The highest fansly-client-ts the document's site sent: one not above it
   *  is its cache's answer (getNowTs never goes back), not judged again. */
  #siteTsMax = 0;
  /** The document's getNowTs caches: its session service's, its device's. */
  #sessionTs = new FanslyClientTsClock();
  #deviceTs = new FanslyClientTsClock();
  /** The last names the site's and Hub's requests went with, by path. */
  readonly #siteNames = new Map<string, string[]>();
  readonly #hubNames = new Map<string, string[]>();
  /** The parity's differences told, as `hub names / site names`. */
  readonly #parityTold = new Set<string>();
  /** When the site's fansly-client-check, resp. fansly-client-ts, was first
   *  seen to differ from ours (wall ms): Hub's requests stand since. */
  #checkMismatchAtWall: number | null = null;
  #tsMismatchAtWall: number | null = null;
  /** The socket's authorization bytes from the site's stored session; null:
   *  none stored; undefined: the storage not seen yet. */
  #storedAuthorizationBytes: number | null | undefined = undefined;

  constructor(options: SiteSessionOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** The live session's fingerprint, or null when none was seen. */
  get fingerprint(): string | null {
    return this.#fingerprint;
  }

  /** The bytes of the site socket's authorization with the live token —
   *  what the socket gate lets go once a connection (egress/socket-gate.ts);
   *  null: no live session. From the site's stored session once its storage
   *  was seen; before, from the template's token. */
  socketAuthorizationBytes(): number | null {
    if (this.#storedAuthorizationBytes !== undefined) return this.#storedAuthorizationBytes;
    const token = this.#template === null ? undefined : header(this.#template, "authorization");
    return token === undefined || token === "" ? null : authorizationBytes(token);
  }

  /** The site's `session_active_session` as its storage holds it: its JSON
   *  (`{id, accountId, deviceId, token, metadata}`, Fansly's session model),
   *  or null — none. Only the authorization's size is kept. */
  noteStoredSession(value: string | null): void {
    let token: unknown = null;
    if (value !== null && value !== "") {
      try {
        token = (JSON.parse(value) as { token?: unknown } | null)?.token ?? null;
      } catch {
        token = null;
      }
    }
    this.#storedAuthorizationBytes = typeof token === "string" && token !== "" ? authorizationBytes(token) : null;
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
      if (!name.startsWith(":") && !BROWSER_HEADERS.has(name.toLowerCase())) template.push([name, value]);
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
      if (!this.#checkOk) this.#checkMismatchAtWall ??= this.#now();
      else this.#checkMismatchAtWall = null;
      if (!this.#checkOk && !this.#checkAlarmed) {
        this.#checkAlarmed = true;
        this.#options.onCheckMismatch?.(path, "fansly-client-check");
      }
    }
    // The time's tail, from the id the site's interceptor took it from: the
    // session's with one, else the device's. Without either the site sends
    // the bare time: nothing to judge.
    const ts = header(template, "fansly-client-ts");
    const tailId = header(template, "fansly-session-id") || clientId;
    const value = ts !== undefined && /^\d+$/.test(ts) ? Number(ts) : Number.NaN;
    if (ts !== undefined && tailId !== "" && path !== null && !(value <= this.#siteTsMax)) {
      if (Number.isFinite(value)) this.#siteTsMax = value;
      this.#tsOk = fanslyClientTsTailMatches(ts, tailId);
      if (!this.#tsOk) this.#tsMismatchAtWall ??= this.#now();
      else this.#tsMismatchAtWall = null;
      if (!this.#tsOk && !this.#tsAlarmed) {
        this.#tsAlarmed = true;
        this.#options.onCheckMismatch?.(path, "fansly-client-ts");
      }
    }
  }

  /** fansly-client-ts as the site would set it now (client-ts.ts): its
   *  session service's with a session id, else its device service's. */
  clientTs(sessionId: string | undefined, clientId: string): number {
    const now = this.#now();
    return sessionId ? this.#sessionTs.next(now, sessionId) : this.#deviceTs.next(now, clientId);
  }

  /** The headers of a Hub request to `pathname`: the site's template with
   *  its time and check, then the route's own (`extra`) the template lacks;
   *  or why there are none. */
  headersFor(pathname: string, extra: Record<string, string>): BuiltHeaders {
    const template = this.#template;
    const fingerprint = this.#fingerprint;
    if (fingerprint === null) return { ok: false, why: "no live session of the site yet: it made no API request with authorization" };
    if (template === null) return { ok: false, why: "the site's new document made no API request with authorization yet" };
    if (this.#checkOk === false) return { ok: false, why: "the site computes fansly-client-check another way than the operator: the transport is not ready" };
    if (this.#tsOk === false) return { ok: false, why: "the site computes fansly-client-ts another way than the operator: the transport is not ready" };
    const clientId = header(template, "fansly-client-id") ?? "";
    const sessionId = header(template, "fansly-session-id");
    const out: Array<[string, string]> = [];
    for (const [name, value] of template) {
      const lower = name.toLowerCase();
      if (lower === "fansly-client-ts") out.push([name, String(this.clientTs(sessionId, clientId))]);
      else if (lower === "fansly-client-check") out.push([name, fanslyClientCheck(pathname, clientId)]);
      else out.push([name, value]);
    }
    for (const [name, value] of Object.entries(extra)) {
      if (!out.some(([have]) => have.toLowerCase() === name.toLowerCase())) out.push([name, value]);
    }
    return { ok: true, headers: out, fingerprint };
  }

  /** Why no Hub request can be built now, whatever its path, or null — the
   *  reasons `headersFor` refuses with: first the transport's own, with since
   *  when (`client_check` while the site's last fansly-client-check or
   *  fansly-client-ts differed from ours), then no live session, then the
   *  new document's template not seen yet. */
  sendBlock(): { reason: "client_check" | "no_session" | "no_template"; sinceWall: number | null } | null {
    const since = [this.#checkOk === false ? this.#checkMismatchAtWall : null, this.#tsOk === false ? this.#tsMismatchAtWall : null].filter((at) => at !== null);
    if (this.#checkOk === false || this.#tsOk === false) return { reason: "client_check", sinceWall: since.length === 0 ? null : Math.min(...since) };
    if (this.#fingerprint === null) return { reason: "no_session", sinceWall: null };
    if (this.#template === null) return { reason: "no_template", sinceWall: null };
    return null;
  }

  /** The names a request went with (requestWillBeSentExtraInfo): of the
   *  site's, or of a Hub request. Compared per path; a difference is told
   *  once for each difference, and the path is learned afresh: the site's
   *  next request to it is the one compared. Hub's requests go on. */
  noteSent(path: string, names: readonly string[], hub: boolean): void {
    const kept = names.map((name) => name.toLowerCase()).filter((name) => !PARITY_IGNORED.has(name));
    const mine = hub ? this.#hubNames : this.#siteNames;
    const theirs = hub ? this.#siteNames : this.#hubNames;
    mine.delete(path);
    mine.set(path, kept);
    if (mine.size > PARITY_PATHS) mine.delete(mine.keys().next().value!);
    const other = theirs.get(path);
    if (other === undefined) return;
    if (other.length === kept.length && other.every((name, index) => name === kept[index])) return;
    this.#siteNames.delete(path);
    this.#hubNames.delete(path);
    const [hubNames, siteNames] = hub ? [kept, other] : [other, kept];
    const told = `${hubNames.join(",")} / ${siteNames.join(",")}`;
    if (this.#parityTold.has(told) || this.#parityTold.size >= PARITY_TOLD) return;
    this.#parityTold.add(told);
    this.#options.onHeaderMismatch?.(path, hubNames, siteNames);
  }

  /** The work tab's document was replaced: the session goes on (its
   *  fingerprint stays), but the headers were the old document's — the new
   *  one has no socket yet, so no fansly-session-id. Hub requests wait for
   *  its first API request with authorization, and the names it sent are
   *  compared afresh. Its script starts anew: so do its getNowTs caches. A
   *  wrong check or time stands until the site's next request says
   *  otherwise. */
  newDocument(): void {
    this.#template = null;
    this.#siteNames.clear();
    this.#hubNames.clear();
    this.#siteTsMax = 0;
    this.#sessionTs = new FanslyClientTsClock();
    this.#deviceTs = new FanslyClientTsClock();
  }

  /** A new browser: nothing of the old session is kept. */
  reset(): void {
    const had = this.#fingerprint !== null;
    this.#template = null;
    this.#fingerprint = null;
    this.#checkOk = null;
    this.#checkAlarmed = false;
    this.#tsOk = null;
    this.#tsAlarmed = false;
    this.#siteTsMax = 0;
    this.#sessionTs = new FanslyClientTsClock();
    this.#deviceTs = new FanslyClientTsClock();
    this.#siteNames.clear();
    this.#hubNames.clear();
    this.#parityTold.clear();
    this.#checkMismatchAtWall = null;
    this.#tsMismatchAtWall = null;
    this.#storedAuthorizationBytes = undefined;
    if (had) this.#options.onChange?.(null);
  }
}
