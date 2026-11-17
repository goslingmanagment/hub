import { CHATTER_SITE_ORIGIN, CONTENTOPS_ORIGIN, WORKBOARD_ORIGIN } from "@agency_hub_core/contracts";
/**
 * The names nginx serves Hub's web apps under in production. A session is a
 * host-only cookie on each name; a sign-in on one is planted on another by
 * a one-time code (`/api/v1/auth/sso`, the runtime's signin-handoff.ts). One
 * copy for the console (apps/dashboard/src/lib/sites.ts re-exports it) and
 * Workboard.
 */

/** Hub, the owner's place (the console). A Workboard address asked for here leaves for the team's name (one address for Workboard). */
export const CONSOLE_ORIGIN = "https://hub.gosling-agency.ru";

/** The name the console answered on before it had its own. */
export const LEGACY_CONSOLE_ORIGIN = "https://gosling-agency.ru";

/** The team's name: Workboard's one address (/workboard/), every role's, with the team's /login, /join and /account (since 2026-11-17). */
export { WORKBOARD_ORIGIN };

/**
 * The chatters' site: every path outside /workboard/, /api/ and the console app's /account, /join and /login is a
 * static page there (ChatGoose's site, the static reports). Workboard's name until 2026-11-17: its sign-in and account
 * pages are still the team's, and Hub's server sends a Workboard page asked there on to the team's name, signed in.
 */
export { CHATTER_SITE_ORIGIN };

/** ContentOps, the content's own product: a model's plan, inbox and library at `/<model>/<section>` (its sign-in is Hub's). */
export { CONTENTOPS_ORIGIN };

/** ContentOps' own entry through Hub's sign-in (its `/auth/hub/start`: one step, no second password). */
export const CONTENTOPS_SIGNIN_HREF = `${CONTENTOPS_ORIGIN}/auth/hub/start`;

/** The owner's outside tools (TaskIndex, the server monitor): each signs in through Hub on its own page. */
export const TASKS_ORIGIN = "https://tasks.gosling-agency.ru";
export const MONITOR_ORIGIN = "https://monitor.gosling-agency.ru";

/**
 * A model's place in ContentOps. Its models are Hub's model slugs in lower
 * case (`Lora` → `/lora/…`); with no model, ContentOps' own start (its root
 * opens where its person was last: a section has no address without a model).
 */
export function contentopsHref(modelSlug: string | null, path: string): string {
  return modelSlug ? `${CONTENTOPS_ORIGIN}/${encodeURIComponent(modelSlug.toLowerCase())}/${path}` : `${CONTENTOPS_ORIGIN}/`;
}

const PRODUCTION_CONSOLE_ORIGINS: ReadonlySet<string> = new Set([CONSOLE_ORIGIN, LEGACY_CONSOLE_ORIGIN]);

/**
 * The origin an invitation's link (`/join#…`) opens on, for a console running on `consoleOrigin`: a production console
 * sends people to the team's name. Any other origin — a local build, a test — is the whole app on one name and serves
 * those pages itself.
 */
export function joinOriginFor(consoleOrigin: string): string {
  return PRODUCTION_CONSOLE_ORIGINS.has(consoleOrigin) ? WORKBOARD_ORIGIN : consoleOrigin;
}

/** Locally the two names are these (any port): `*.localhost` never leaves this machine. */
const LOCAL_CONSOLE_HOST = "hub.localhost";
const LOCAL_TEAM_HOST = "chatgoose.localhost";

/**
 * Which name `origin` is: the console's (the owner's place), the team's (Workboard's name, and the chatters' site that
 * was it: their sign-in and account pages are the team's), or neither — a local build on one name, a test. Locally
 * `http://hub.localhost:<port>` and `http://chatgoose.localhost:<port>` play the console and the team.
 */
export function siteOf(origin: string): "console" | "team" | null {
  if (origin === CONSOLE_ORIGIN) return "console";
  if (origin === WORKBOARD_ORIGIN || origin === CHATTER_SITE_ORIGIN) return "team";
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname === LOCAL_CONSOLE_HOST) return "console";
    if (url.hostname === LOCAL_TEAM_HOST) return "team";
  } catch {
    return null;
  }
  return null;
}

/**
 * The console's name for a team's page, the team's name (Workboard's) for the console's (same scheme and port
 * locally), or null when `origin` is neither.
 */
export function peerOriginOf(origin: string): string | null {
  const site = siteOf(origin);
  if (site === null) return null;
  if (origin === CONSOLE_ORIGIN) return WORKBOARD_ORIGIN;
  if (origin === WORKBOARD_ORIGIN || origin === CHATTER_SITE_ORIGIN) return CONSOLE_ORIGIN;
  const url = new URL(origin);
  url.hostname = site === "console" ? LOCAL_TEAM_HOST : LOCAL_CONSOLE_HOST;
  return url.origin;
}

/** Workboard's name for a page on `origin` (itself on the team's name), or null — a local build on one name, a test. */
export function teamOriginOf(origin: string): string | null {
  const site = siteOf(origin);
  if (site === null) return null;
  if (origin === CONSOLE_ORIGIN || origin === CHATTER_SITE_ORIGIN) return WORKBOARD_ORIGIN;
  return site === "team" ? origin : peerOriginOf(origin);
}

/**
 * The names a sign-in page on `origin` asks, one after another, whether someone is signed in there (`silentSignInHref`):
 * on either of the team's two names the other one first (a chatter signed in on `chatgoose.` before Workboard had its
 * own name, or there for the static reports), then the console; on the console, the team's name. Empty — a local
 * build on one name, a test.
 */
export function silentSignInNamesOf(origin: string): string[] {
  if (origin === WORKBOARD_ORIGIN) return [CHATTER_SITE_ORIGIN, CONSOLE_ORIGIN];
  if (origin === CHATTER_SITE_ORIGIN) return [WORKBOARD_ORIGIN, CONSOLE_ORIGIN];
  const peer = peerOriginOf(origin);
  return peer === null ? [] : [peer];
}

/**
 * The address that plants this name's fresh sign-in on `target` too and leads
 * on to `next` (a URL, or a path of `target`): one-time code, a few redirects,
 * nothing to see. Opened with a page load, on this name.
 */
export function signInHopHref(target: string, next: string): string {
  return `/api/v1/auth/sso?${new URLSearchParams({ to: target, next }).toString()}`;
}

/**
 * The sign-in page's marker (`/login?…&sso=none`): do not ask another name.
 * Set on the way back from the last silent try, so they happen once per
 * arrival, and after a sign-out, so nobody is signed back in from another
 * name. Between two tries it carries how many names were asked (`sso=1`).
 */
export const NO_SILENT_SIGNIN = { param: "sso", value: "none" } as const;

/**
 * The silent try of a name arrived at without a session: ask another name
 * whether someone is signed in there (its full session only). Yes → that
 * session is planted here and the browser lands on `next`; nobody → straight
 * to `next`. Opened with a page load, on this name; `next` is a URL on this
 * name that carries NO_SILENT_SIGNIN (or the count of names asked), so it never loops.
 */
export function silentSignInHref(other: string, next: string): string {
  return `/api/v1/auth/sso/begin?${new URLSearchParams({ from: other, next, silent: "1" }).toString()}`;
}

/**
 * A Workboard address (`/workboard/shifts?days=30`) as a page on `origin` opens it. Workboard has one address, the
 * team's name: from the console's name or the chatters' site the browser goes there through the one-time hand-off,
 * signed in on the way; anywhere else (the team's name, a local build on one name) the address is this name's own.
 */
export function workboardEntryHref(origin: string, path: string): string {
  const team = teamOriginOf(origin);
  return team === null || team === origin ? path : signInHopHref(team, `${team}${path}`);
}

/**
 * Where a content manager's login is sent from any page of Hub's two names (products plan §4.1): ContentOps, signed
 * in through Hub. ContentOps signs in on the console's name, so from the team's name the session crosses there first
 * and the console sends it on; anywhere else, ContentOps' own entry at once.
 */
export function contentopsEntryHref(origin: string): string {
  const hub = siteOf(origin) === "team" ? peerOriginOf(origin) : null;
  return hub === null ? CONTENTOPS_SIGNIN_HREF : signInHopHref(hub, `${hub}/`);
}

/**
 * A Hub address (`/money/month`) as a page on `origin` opens it: from the team's name, on the console's name through
 * the one-time hand-off; anywhere else the address is this name's own.
 */
export function hubEntryHref(origin: string, path: string): string {
  const hub = siteOf(origin) === "team" ? peerOriginOf(origin) : null;
  return hub === null ? path : signInHopHref(hub, `${hub}${path}`);
}
