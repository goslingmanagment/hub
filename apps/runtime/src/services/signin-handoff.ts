import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import { CHATTER_SITE_ORIGIN, SIGNIN_CODE_TTL_SECONDS, WORKBOARD_ORIGIN, isSigninClient, type SigninClient } from "@agency_hub_core/contracts";
import {
  findDeviceTokenForUser,
  findHandoffGrant,
  findHandoffSession,
  revokeSessionOpenedBy,
  findPersonIdOfLogin,
  findUserById,
  insertHandoffCode,
  lockHandoffCode,
  markHandoffCodeUsed,
  type HandoffCodeRecord,
  isTestUser,
} from "@agency_hub_core/db";
import { randomToken, sha256Hex, type UserRole } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import {
  authenticateSessionById,
  createWebSessionTx,
  findLiveSession,
  recordAudit,
  roleCanUseSession,
  withAuditTransaction,
  type AuditContext,
} from "./auth.ts";
import { BadRequestError, ConflictError } from "./errors.ts";

/**
 * One sign-in for people across the names Hub serves (ecosystem plan §3.2).
 *
 * Cookies stay host-only. A sign-in crosses from one name to another by a
 * one-time code, and the SAME session row is planted on every name that has it,
 * so one sign-out (or one revocation) ends it on all of them at once. Hub is
 * the only source of who someone is; another machine's server (ContentOps)
 * gets «who is this» for a code and never the session token.
 *
 * What closes what (the PR's threat list):
 * - a code is 32 random bytes, stored as its sha256 only, accepted once (the
 *   first presentation spends it, under a row lock), within 60 s;
 * - a code is bound to its target: a browser code only on that origin, a
 *   server code only to that client's redeem — and a server code carries no
 *   session token at all, so it can never become a cookie;
 * - a browser code is bound to the browser that asked for it: the target's
 *   `authSsoBegin` sets a state cookie there and only its sha256 travels in
 *   the address; the accept wants the cookie whose hash it was minted for
 *   (no session fixation by a link: someone else's code is refused here);
 * - the planted session's token is sealed in the code's row with a key derived
 *   from the code itself (unreadable without the code, which is never stored)
 *   and dropped on use;
 * - `next` is a path of the target or a URL on one of the configured names,
 *   never the API, never anything else (no open redirect);
 * - a narrow session (from the extension) never travels: `authSso` treats it
 *   as no session, the accept never plants one on another name.
 */

/** A browser's state cookie on a target name: 10 minutes to type a password in. */
export const SSO_STATE_TTL_SECONDS = 600;

/** The state cookie. `__Host-` in production: Secure, Path=/, no Domain — a sibling name cannot set one. */
export function ssoStateCookieName(app: Pick<AppContext, "config">): string {
  return app.config.isProduction ? "__Host-agency_hub_sso_state" : "agency_hub_sso_state";
}

const PRODUCTION_CONSOLE_ORIGIN = "https://hub.gosling-agency.ru";
const PRODUCTION_TEAM_ORIGIN = WORKBOARD_ORIGIN;
/**
 * The team's names before its own (Workboard was `chatgoose.…/workboard/` until 2026-11-17): the chatters' site. It
 * stays one of Hub's names — the released extension frames the board from it, the static reports sign in there, a tab
 * opened before the move keeps working — and a Workboard page asked there leaves for the team's name, signed in
 * (`workboardOnFormerTeamRedirect`). A name configured as the team's or the console's is not a former one.
 */
const FORMER_TEAM_ORIGINS: readonly string[] = [CHATTER_SITE_ORIGIN];
const PRODUCTION_SIGNIN_CLIENTS: Readonly<Record<string, string>> = {
  contentops: "https://contentops.gosling-agency.ru/auth/hub/callback",
  taskindex: "https://tasks.gosling-agency.ru/auth/hub/callback",
  monitor: "https://monitor.gosling-agency.ru/auth/hub/callback",
};

export interface SigninNames {
  /** The owner's place. */
  console: string;
  /** The team's place (Workboard on workboard.). */
  team: string;
  /** The team's names before its own (FORMER_TEAM_ORIGINS): Hub's names still, their Workboard pages lead to `team`. */
  formerTeams: ReadonlySet<string>;
  /**
   * Hub's own web apps: the names a code is minted and accepted on (the session
   * itself is planted only here), an accept may lead to, and a cookie change is
   * taken from.
   */
  hubOrigins: ReadonlySet<string>;
  /** Another service's server, by name → its callback URL; only the services with a capability of their own. */
  clients: ReadonlyMap<SigninClient, string>;
  /** Outside production a page on this machine also counts (a URL in `next`, a cookie change). */
  allowLoopback: boolean;
}

export function signinNamesOf(config: AppContext["config"]): SigninNames {
  const consoleOrigin = config.webConsoleOrigin ?? PRODUCTION_CONSOLE_ORIGIN;
  const teamOrigin = config.webTeamOrigin ?? PRODUCTION_TEAM_ORIGIN;
  const clients = new Map<SigninClient, string>();
  for (const [name, callback] of Object.entries(config.webSigninClients ?? PRODUCTION_SIGNIN_CLIENTS)) {
    if (isSigninClient(name)) clients.set(name, callback);
  }
  const formerTeams = new Set(FORMER_TEAM_ORIGINS.filter((origin) => origin !== teamOrigin && origin !== consoleOrigin));
  return {
    console: consoleOrigin,
    team: teamOrigin,
    formerTeams,
    hubOrigins: new Set([consoleOrigin, teamOrigin, ...formerTeams]),
    clients,
    allowLoopback: !config.isProduction,
  };
}

/** Where a name leads when nobody said: the team's place for the team's names, the root elsewhere. */
export function defaultLandingOf(origin: string, names: SigninNames): string {
  return origin === names.team || names.formerTeams.has(origin) ? `${origin}/workboard/` : `${origin}/`;
}

/** Workboard's address on a name (apps/workboard/src/base.ts). */
const WORKBOARD_PATH = "/workboard";

/**
 * Workboard has ONE address for every role, the team's name (products plan §2.3, decided for the owner): a page of
 * Workboard asked for on the console's name (`hub.…/workboard/shifts?days=30`, an owner's bookmark) is the same path
 * on the team's name, reached through the one-time hand-off so the owner arrives signed in; with nobody signed in on
 * the console's name the hand-off leads straight on (`silent`) and the team's name asks for the sign-in itself. The
 * browser keeps the address's `#…` across the redirects. Null: not such a page (another name, the API, Workboard's
 * built files, which a page already open may still ask for, the board's bare frame), or the two names are one.
 */
/** The parameters of «Ждут вас» that open one of Workboard's windows in place. */
const WORKBOARD_WINDOW_PARAMS = ["send", "dispute", "claim", "offPlatform", "nobody", "unlinked"] as const;

/**
 * Whether a request's path is one of Workboard's pages: under `/workboard`, but not its built files (a page already
 * open may still ask for them) and not the «Отчёт» board's frames for the extension (`/workboard/frame/*`, a bare page
 * wherever it is asked for: no redirect, no sign-in, never `me`; page-headers.ts BOARD_FRAME_PATHS).
 */
function isWorkboardPagePath(path: string): boolean {
  if (path !== WORKBOARD_PATH && !path.startsWith(`${WORKBOARD_PATH}/`)) return false;
  return !path.startsWith(`${WORKBOARD_PATH}/assets/`) && !path.startsWith(`${WORKBOARD_PATH}/frame/`);
}

export function workboardOnConsoleRedirect(input: { here: string | null; method: string; url: string }, names: SigninNames): string | null {
  if (input.here === null || input.here !== names.console || names.console === names.team) return null;
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  const path = input.url.split(/[?#]/, 1)[0]!;
  if (!isWorkboardPagePath(path)) return null;
  // The old «Решения» on the console's name is the owner's «Ждут вас» in Hub now (products plan §2.2), unless the
  // address opens one of Workboard's windows (a dispute, a held send…): those are Workboard's, on the team's name.
  if (path === `${WORKBOARD_PATH}/decisions` || path === `${WORKBOARD_PATH}/decisions/`) {
    const query = new URL(input.url, "http://x").searchParams;
    if (!WORKBOARD_WINDOW_PARAMS.some((param) => query.has(param))) {
      const search = query.toString();
      return `/waiting${search ? `?${search}` : ""}`;
    }
  }
  const next = resolveBrowserNext(input.url, names.team, names);
  if (next === null) return null;
  return `/api/v1/auth/sso?${new URLSearchParams({ to: names.team, next, silent: "1" }).toString()}`;
}

/**
 * The header nginx sets on a former name of the team once Workboard's pages there leave for the team's name
 * (agency-site deploy/server-nginx.sh, the chatgoose step): the switch is nginx's, so the new name is checked live
 * before any old address leads to it, and one reload of nginx puts it back. A request that sends the header itself
 * only takes itself to the team's name.
 */
export const WORKBOARD_MOVED_HEADER = "x-workboard-moved";

/**
 * A Workboard page asked for on a former name of the team (`chatgoose.…/workboard/report/812?sale=9`: the released
 * extension's «Мои смены» and «Отчёт», Telegram messages, bookmarks, an agent's link): the same path and query on the
 * team's name, through the one-time hand-off, so whoever is signed in on the old name arrives signed in — a full
 * session as itself, a narrow one (the extension's, no password) as a narrow one of its device (`carryNarrowSession`);
 * nobody signed in there → straight on (`silent`), where the team's name asks for the sign-in. The browser keeps the
 * address's `#…` across the redirects. Only while nginx says Workboard moved (`moved`, WORKBOARD_MOVED_HEADER); never
 * the board's frames or Workboard's built files. Null: not such a request.
 */
export function workboardOnFormerTeamRedirect(input: { here: string | null; method: string; url: string; moved: boolean }, names: SigninNames): string | null {
  if (!input.moved || input.here === null || !names.formerTeams.has(input.here)) return null;
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  if (!isWorkboardPagePath(input.url.split(/[?#]/, 1)[0]!)) return null;
  const next = resolveBrowserNext(input.url, names.team, names);
  if (next === null) return null;
  return `/api/v1/auth/sso?${new URLSearchParams({ to: names.team, next, silent: "1" }).toString()}`;
}

/**
 * A page of the developer's own machine on the one-name dev setup
 * (`localhost`, `127.0.0.1`, `[::1]`, any port). Not `*.localhost`: a local
 * stand of several names configures them (WEB_CONSOLE_ORIGIN, WEB_TEAM_ORIGIN)
 * and its other names stay foreign, as in production.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** A bare origin as a browser sends it, or null. */
export function bareOriginOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

// Control characters, whitespace and backslashes: never in an address we lead to.
const UNSAFE_URL_CHARACTERS = /[\p{Cc}\s\\]/u;

/**
 * A path that stays a path of its origin after a URL parser's normalisation, wherever it is used (here, or echoed to
 * a service that builds a URL of it): as written and percent-decoded, no backslash, control character or whitespace,
 * no empty segment (`//`, `/%2F/`) and no dot segment (`/./`, `/../`) — `/.//host` folds into `//host`, a
 * protocol-relative address. The query and the fragment may carry anything a URL may.
 */
function isPlainPath(raw: string): boolean {
  if (!raw.startsWith("/") || UNSAFE_URL_CHARACTERS.test(raw)) return false;
  const path = raw.split(/[?#]/, 1)[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  return [path, decoded].every((form) => !UNSAFE_URL_CHARACTERS.test(form) && !form.includes("//") && !/(^|\/)\.{1,2}(\/|$)/.test(form));
}

function isApiPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return lower === "/api" || lower.startsWith("/api/");
}

/**
 * Where an accept on `target` may lead: a path of `target` (`/workboard/my/shifts`)
 * or a URL on one of the configured names (`https://hub.gosling-agency.ru/`),
 * normalized; `next` absent → the target's landing. Never another origin, never
 * the API, never a URL with credentials. Null — refused.
 */
export function resolveBrowserNext(raw: string | undefined, target: string, names: SigninNames): string | null {
  if (raw === undefined) return defaultLandingOf(target, names);
  if (raw.length > 2048 || UNSAFE_URL_CHARACTERS.test(raw)) return null;
  let url: URL;
  try {
    if (raw.startsWith("/")) {
      if (!isPlainPath(raw)) return null;
      url = new URL(raw, target);
      if (url.origin !== target) return null;
    } else {
      url = new URL(raw);
      const allowed = names.hubOrigins.has(url.origin) || (names.allowLoopback && isLoopbackOrigin(url.origin));
      if (!allowed || url.origin === "null") return null;
    }
  } catch {
    return null;
  }
  if (url.username || url.password || isApiPath(url.pathname) || url.pathname.includes("//")) return null;
  return url.href;
}

/**
 * A client's own path (it checks it again): `/`, `/plan?week=2`, as a path of the client's origin after
 * normalisation (isPlainPath). Null — refused.
 */
export function resolveClientNext(raw: string | undefined): string | null {
  if (raw === undefined) return "/";
  if (raw.length > 2048 || !isPlainPath(raw)) return null;
  const base = "http://client.invalid";
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  return url.origin !== base || next.startsWith("//") ? null : next;
}

/** A browser's state: the begin's random value, 32 bytes base64url. */
const STATE_VALUE = /^[A-Za-z0-9_-]{43}$/;
/** What travels in the address instead: its sha256, hex. */
const STATE_DIGEST = /^[0-9a-f]{64}$/;
/** A client's own state, echoed to its callback. */
const CLIENT_STATE = /^[A-Za-z0-9._~-]{16,256}$/;
const CODE_VALUE = /^[A-Za-z0-9_-]{43}$/;

export function newSsoState(): { state: string; digest: string } {
  const state = randomToken(32);
  return { state, digest: sha256Hex(state) };
}

export function isStateDigest(value: string): boolean {
  return STATE_DIGEST.test(value);
}

export function isClientState(value: string): boolean {
  return CLIENT_STATE.test(value);
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- The planted session's token, sealed by the code -------------------------

function sealKey(code: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(code, "utf8"), Buffer.alloc(0), Buffer.from("agency-hub sign-in handoff v1"), 32));
}

/** AES-256-GCM under a key only the code opens: `v1.<iv>.<ciphertext>.<tag>`. */
export function sealSessionToken(code: string, sessionToken: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(code), iv);
  const ciphertext = Buffer.concat([cipher.update(sessionToken, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function openSessionToken(code: string, sealed: string): string | null {
  const [version, iv, ciphertext, tag] = sealed.split(".");
  if (version !== "v1" || !iv || !ciphertext || !tag) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealKey(code), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// --- Minting --------------------------------------------------------------

function codeExpiry(): Date {
  return new Date(Date.now() + SIGNIN_CODE_TTL_SECONDS * 1000);
}

function newCode(): { code: string; digest: string } {
  const code = randomToken(32);
  return { code, digest: sha256Hex(code) };
}

/** The live FULL session behind this name's cookie and its person, or null (none, dead, narrow, deactivated). */
export async function liveFullSession(app: AppContext, sessionToken: string | undefined) {
  if (!sessionToken) return null;
  const session = await findLiveSession(app, sessionToken);
  if (!session || session.narrowDeviceTokenId !== null) return null;
  const user = await findUserById(app.db, session.userId);
  if (!user || user.disabledAt || user.deletedAt || !roleCanUseSession(user.role)) return null;
  return { session, user };
}

/** A code that plants `sessionToken` on `target` for the browser whose state hashes to `stateDigest`. */
export async function mintSessionCode(app: AppContext, input: {
  sessionToken: string;
  sessionId: number;
  userId: number;
  target: string;
  stateDigest: string;
  next: string;
}): Promise<string> {
  const { code, digest } = newCode();
  await insertHandoffCode(app.db, {
    codeDigest: digest,
    kind: "session",
    target: input.target,
    userId: input.userId,
    sessionId: input.sessionId,
    deviceTokenId: null,
    stateDigest: input.stateDigest,
    sealedSession: sealSessionToken(code, input.sessionToken),
    next: input.next,
    expiresAt: codeExpiry(),
  });
  return code;
}

/** A code another machine's server redeems for «who is this». No token in it. */
export async function mintServerCode(app: AppContext, input: {
  sessionId: number;
  userId: number;
  client: string;
  next: string;
}): Promise<string> {
  const { code, digest } = newCode();
  await insertHandoffCode(app.db, {
    codeDigest: digest,
    kind: "server",
    target: input.client,
    userId: input.userId,
    sessionId: input.sessionId,
    deviceTokenId: null,
    stateDigest: null,
    sealedSession: null,
    next: input.next,
    expiresAt: codeExpiry(),
  });
  return code;
}

/**
 * `authWebLink`: a one-time link that opens a NARROW web session of this
 * device's person in the team's place. `next` is a path of the team's name only:
 * the narrow session lives there and nowhere else.
 */
export async function issueWebLink(app: AppContext, input: {
  userId: number;
  deviceTokenId: number;
  next: string | undefined;
}): Promise<{ url: string; expiresAt: string }> {
  const names = signinNamesOf(app.config);
  if (input.next !== undefined && !input.next.startsWith("/")) {
    throw new BadRequestError("`next` must be a path of the team's place");
  }
  const next = resolveBrowserNext(input.next, names.team, names);
  if (next === null) {
    throw new BadRequestError("`next` must be a path of the team's place");
  }
  const { code, digest } = newCode();
  const expiresAt = codeExpiry();
  await insertHandoffCode(app.db, {
    codeDigest: digest,
    kind: "narrow",
    target: names.team,
    userId: input.userId,
    sessionId: null,
    deviceTokenId: input.deviceTokenId,
    stateDigest: null,
    sealedSession: null,
    next,
    expiresAt,
  });
  return { url: `${names.team}/api/v1/auth/sso/accept?${new URLSearchParams({ code }).toString()}`, expiresAt: expiresAt.toISOString() };
}

/**
 * A narrow session (the extension's one-time link, no password: `issueWebLink`) on a former name of the team, asked to
 * lead on to a Workboard page on the team's name (`workboardOnFormerTeamRedirect`): a narrow code of the same device
 * for the team's name, the same kind `issueWebLink` mints — the narrow session lives in the team's place, and that
 * place has moved. The address of its accept, or null: not that case (another name or target, not a Workboard page, no
 * live narrow session here), and the caller goes on as for nobody signed in. The device and its person are checked
 * again at the accept.
 */
export async function carryNarrowSession(app: AppContext, input: {
  here: string;
  target: string;
  next: string;
  sessionToken: string | undefined;
}): Promise<string | null> {
  const names = signinNamesOf(app.config);
  if (!input.sessionToken || !names.formerTeams.has(input.here) || input.target !== names.team) return null;
  let next: URL;
  try {
    next = new URL(input.next);
  } catch {
    return null;
  }
  if (next.origin !== names.team || !isWorkboardPagePath(next.pathname)) return null;
  const session = await findLiveSession(app, input.sessionToken);
  if (!session || session.narrowDeviceTokenId === null) return null;
  const { code, digest } = newCode();
  await insertHandoffCode(app.db, {
    codeDigest: digest,
    kind: "narrow",
    target: names.team,
    userId: session.userId,
    sessionId: null,
    deviceTokenId: session.narrowDeviceTokenId,
    stateDigest: null,
    sealedSession: null,
    next: input.next,
    expiresAt: codeExpiry(),
  });
  return `${names.team}/api/v1/auth/sso/accept?${new URLSearchParams({ code }).toString()}`;
}

// --- Accepting on a name ----------------------------------------------------

export type AcceptOutcome =
  /** Set this cookie on this name and lead to `next`. */
  | { kind: "cookie"; sessionToken: string; expiresAt: Date; next: string; clearState: boolean }
  /** The browser already has the person's full session here: keep it, lead on. */
  | { kind: "keep"; next: string }
  /** Nothing to set; lead to `next` (the code's, when there was one) without a session. */
  | { kind: "refused"; reason: string; next: string | null; clearState: boolean };

function spendable(code: HandoffCodeRecord, now: Date): string | null {
  if (code.usedAt !== null) return "used";
  if (code.expiresAt <= now) return "expired";
  return null;
}

/**
 * The accept on `here` (the origin the request came to): the first
 * presentation of a code spends it, whatever the outcome — a stolen or guessed
 * code gets one try, never more.
 */
export async function acceptHandoffCode(app: AppContext, input: {
  code: string;
  here: string;
  stateCookie: string | undefined;
  currentSessionToken: string | undefined;
}): Promise<AcceptOutcome> {
  if (!CODE_VALUE.test(input.code)) {
    return { kind: "refused", reason: "malformed", next: null, clearState: false };
  }
  return withAuditTransaction(app, async (dbTx) => {
    const tx = { ...app, db: dbTx };
    const code = await lockHandoffCode(dbTx, sha256Hex(input.code));
    if (!code) {
      return { kind: "refused", reason: "unknown", next: null, clearState: false } as const;
    }
    const unspendable = spendable(code, new Date());
    if (unspendable !== null) {
      return { kind: "refused", reason: unspendable, next: code.next, clearState: code.kind === "session" } as const;
    }
    await markHandoffCodeUsed(dbTx, { id: code.id });
    if (code.kind === "server" || code.target !== input.here) {
      return { kind: "refused", reason: "wrong_target", next: null, clearState: false } as const;
    }

    if (code.kind === "session") {
      // The browser that asked: its state cookie hashes to what the code was minted for.
      if (!input.stateCookie || !STATE_VALUE.test(input.stateCookie) || code.stateDigest === null
        || !sameDigest(sha256Hex(input.stateCookie), code.stateDigest)) {
        return { kind: "refused", reason: "state", next: code.next, clearState: true } as const;
      }
      const sessionToken = code.sealedSession === null ? null : openSessionToken(input.code, code.sealedSession);
      const live = sessionToken === null ? null : await liveFullSession(tx, sessionToken);
      if (!live || live.session.id !== code.sessionId || live.user.id !== code.userId) {
        return { kind: "refused", reason: "session_gone", next: code.next, clearState: true } as const;
      }
      return { kind: "cookie", sessionToken: sessionToken!, expiresAt: live.session.expiresAt, next: code.next, clearState: true } as const;
    }

    // narrow: the device token it will live by must be alive, its person active.
    const deviceTokenId = code.deviceTokenId!;
    const device = await findDeviceTokenForUser(dbTx, { deviceTokenId, userId: code.userId });
    const user = await findUserById(dbTx, code.userId);
    const now = new Date();
    if (!device || device.revokedAt || device.expiresAt <= now
      || !user || user.disabledAt || user.deletedAt || !roleCanUseSession(user.role)) {
      return { kind: "refused", reason: "device_gone", next: code.next, clearState: false } as const;
    }
    // This browser already holds the person's full session here: a narrow one would only take rights away. The same
    // PERSON of the registry, not only the same login: the owner works a chatter's login in his own extension, and
    // that link must not replace his owner session on the team's name with a chatter's narrow one.
    const current = await liveFullSession(tx, input.currentSessionToken);
    if (current && await samePerson(dbTx, current.user.id, user.id)) {
      return { kind: "keep", next: code.next } as const;
    }
    const created = await createWebSessionTx(app, dbTx, { userId: user.id, narrowDeviceTokenId: deviceTokenId });
    await recordAudit({ db: dbTx }, {
      source: "api",
      actorUserId: user.id,
      targetUserId: user.id,
      eventType: "auth.narrow_session_opened",
      metadata: { username: user.username, deviceTokenId, sessionId: created.sessionId },
    });
    return { kind: "cookie", sessionToken: created.sessionToken, expiresAt: created.expiresAt, next: code.next, clearState: false } as const;
  });
}

/** Two logins of one person of the registry (`person_logins`), or the same login. A login no person holds is itself alone. */
async function samePerson(db: AppContext["db"], leftUserId: number, rightUserId: number): Promise<boolean> {
  if (leftUserId === rightUserId) return true;
  const left = await findPersonIdOfLogin(db, leftUserId);
  return left !== null && left === await findPersonIdOfLogin(db, rightUserId);
}

// --- Another machine's server ---------------------------------------------

export interface SigninUser {
  id: number;
  username: string;
  role: UserRole;
}

export interface SigninPerson {
  user: SigninUser;
  /** The agency's owner: TaskIndex and server-monitor open only for them. */
  owner: boolean;
}

const NOT_REDEEMABLE = "This sign-in code cannot be redeemed: it is unknown, used, expired or not this client's";

/** Its first presentation spends the code, whatever the outcome. */
export async function redeemServerCode(app: AppContext, input: {
  client: string;
  code: string;
}, audit: AuditContext): Promise<SigninPerson & { grant: string; expiresAt: string }> {
  if (!CODE_VALUE.test(input.code)) {
    throw new ConflictError(NOT_REDEEMABLE);
  }
  // A refusal must still spend the code: the transaction commits, then the error is thrown.
  const outcome = await withAuditTransaction(app, async (dbTx) => {
    const code = await lockHandoffCode(dbTx, sha256Hex(input.code));
    if (!code) return null;
    if (spendable(code, new Date()) !== null) return null;
    if (code.kind !== "server" || code.target !== input.client || code.sessionId === null) {
      await markHandoffCodeUsed(dbTx, { id: code.id });
      return null;
    }
    const status = await sessionStatus(dbTx, code.sessionId, code.userId);
    // A test person (sandbox/realm.ts) signs in to no other service but ContentOps, and never as the owner.
    if (!status || (status.test && input.client !== SANDBOX_HANDOFF_CLIENT)) {
      await markHandoffCodeUsed(dbTx, { id: code.id });
      return null;
    }
    const grant = randomToken(32);
    await markHandoffCodeUsed(dbTx, { id: code.id, grantDigest: sha256Hex(grant) });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "auth.signin_code_redeemed",
      targetUserId: status.user.id,
      metadata: { client: input.client, username: status.user.username, sessionId: code.sessionId },
    });
    return { user: status.user, owner: status.user.role === "owner" && !status.test, grant, expiresAt: status.expiresAt.toISOString() };
  });
  if (outcome === null) {
    throw new ConflictError(NOT_REDEEMABLE);
  }
  return outcome;
}

/** Whether a redeemed sign-in is still alive. Reads only. */
export async function checkServerGrant(app: AppContext, input: {
  client: string;
  grant: string;
}): Promise<({ active: true; expiresAt: string } & SigninPerson) | { active: false }> {
  const grant = await findHandoffGrant(app.db, sha256Hex(input.grant));
  if (!grant || grant.target !== input.client) return { active: false };
  const status = await sessionStatus(app.db, grant.sessionId, grant.userId);
  return status && (!status.test || input.client === SANDBOX_HANDOFF_CLIENT)
    ? { active: true, user: status.user, owner: status.user.role === "owner" && !status.test, expiresAt: status.expiresAt.toISOString() }
    : { active: false };
}

/**
 * The person behind a server grant, as Hub's principal (products package C2: ContentOps acts as the signed-in person):
 * null when the grant is unknown, another client's, its session over, or a test person's to any client but ContentOps.
 * The principal is the session's own (authenticateSessionById): every read is cut and every change is recorded as that
 * person's, never as the service's key.
 */
export async function principalOfServerGrant(app: AppContext, input: { client: string; grant: string }) {
  const grant = await findHandoffGrant(app.db, sha256Hex(input.grant));
  if (!grant || grant.target !== input.client) return null;
  const status = await sessionStatus(app.db, grant.sessionId, grant.userId);
  if (!status || (status.test && input.client !== SANDBOX_HANDOFF_CLIENT)) return null;
  return authenticateSessionById(app, grant.sessionId, grant.userId);
}

/** A full session by id, while it signs in, and its person while active. */
async function sessionStatus(db: AppContext["db"], sessionId: number, userId: number) {
  const session = await findHandoffSession(db, sessionId);
  if (!session || session.userId !== userId || session.revokedAt || session.expiresAt <= new Date()
    || session.narrowDeviceTokenId !== null) {
    return null;
  }
  const user = await findUserById(db, userId);
  if (!user || user.disabledAt || user.deletedAt || !roleCanUseSession(user.role)) return null;
  return { user: { id: user.id, username: user.username, role: user.role }, expiresAt: session.expiresAt, test: await isTestUser(db, user.id) };
}

/** The one service a test person may be handed to (sandbox/realm.ts): ContentOps, the content manager's product. */
const SANDBOX_HANDOFF_CLIENT = "contentops";

/**
 * Another service's «Выйти» (products plan C4): the Hub session behind its grant ends — only when that service's own
 * page opened it (`auth_sessions.opened_by`); a session the person opened in Hub stays, whatever the grant. null —
 * nothing was ended.
 */
export async function revokeOpenedSession(app: Pick<AppContext, "db">, input: {
  client: string;
  grant: string;
  openedBy: "contentops";
}): Promise<{ userId: number } | null> {
  const grant = await findHandoffGrant(app.db, sha256Hex(input.grant));
  if (!grant || grant.target !== input.client) return null;
  return revokeSessionOpenedBy(app.db, { sessionId: grant.sessionId, openedBy: input.openedBy });
}
