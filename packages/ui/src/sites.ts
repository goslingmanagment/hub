/**
 * The names nginx serves Hub's web apps under in production. A session is a
 * host-only cookie on each name; a sign-in on one is planted on the other by
 * a one-time code (`/api/v1/auth/sso`, the runtime's signin-handoff.ts). One
 * copy for the console (apps/dashboard/src/lib/sites.ts re-exports it) and
 * Workboard.
 */

/** The admin console, for the owner and team leads (Workboard lives under it, at /workboard/). */
export const CONSOLE_ORIGIN = "https://hub.gosling-agency.ru";

/** The name the console answered on before it had its own. */
export const LEGACY_CONSOLE_ORIGIN = "https://gosling-agency.ru";

/** The chatters' site and the team's place (Workboard at /workboard/). Only /account, /join and /login are the console's app there; every other path outside /workboard/ and /api/ is a static page. */
export const CHATTER_SITE_ORIGIN = "https://chatgoose.gosling-agency.ru";

/** ContentOps, the content's own product: a model's plan, inbox and library at `/<model>/<section>` (its sign-in is Hub's). */
export const CONTENTOPS_ORIGIN = "https://contentops.gosling-agency.ru";

/**
 * A model's place in ContentOps. Its models are Hub's model slugs in lower
 * case (`Lora` → `/lora/…`); with no model, ContentOps opens where its person
 * was last.
 */
export function contentopsHref(modelSlug: string | null, path: string): string {
  return modelSlug ? `${CONTENTOPS_ORIGIN}/${encodeURIComponent(modelSlug.toLowerCase())}/${path}` : `${CONTENTOPS_ORIGIN}/`;
}

const PRODUCTION_CONSOLE_ORIGINS: ReadonlySet<string> = new Set([CONSOLE_ORIGIN, LEGACY_CONSOLE_ORIGIN]);

/**
 * The origin of the chatters' pages that go with a console running on
 * `consoleOrigin`. A production console sends people to the chatters' site.
 * Any other origin — a local build, a test — is the whole app on one name and
 * serves those pages itself.
 */
export function chatterSiteOriginFor(consoleOrigin: string): string {
  return PRODUCTION_CONSOLE_ORIGINS.has(consoleOrigin) ? CHATTER_SITE_ORIGIN : consoleOrigin;
}

/** Locally the two names are these (any port): `*.localhost` never leaves this machine. */
const LOCAL_CONSOLE_HOST = "hub.localhost";
const LOCAL_TEAM_HOST = "chatgoose.localhost";

/**
 * Which of the two names `origin` is: the console's (the owner's place), the
 * team's (chatgoose., the team's place), or neither — a local build on one
 * name, a test. Locally `http://hub.localhost:<port>` and
 * `http://chatgoose.localhost:<port>` play the two.
 */
export function siteOf(origin: string): "console" | "team" | null {
  if (origin === CONSOLE_ORIGIN) return "console";
  if (origin === CHATTER_SITE_ORIGIN) return "team";
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

/** The other one of the two names (same scheme and port locally), or null when `origin` is neither. */
export function peerOriginOf(origin: string): string | null {
  const site = siteOf(origin);
  if (site === null) return null;
  if (origin === CONSOLE_ORIGIN) return CHATTER_SITE_ORIGIN;
  if (origin === CHATTER_SITE_ORIGIN) return CONSOLE_ORIGIN;
  const url = new URL(origin);
  url.hostname = site === "console" ? LOCAL_TEAM_HOST : LOCAL_CONSOLE_HOST;
  return url.origin;
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
 * The sign-in page's marker (`/login?…&sso=none`): do not ask the other name.
 * Set on the way back from a silent try, so it happens once per arrival, and
 * after a sign-out, so nobody is signed back in from the other name.
 */
export const NO_SILENT_SIGNIN = { param: "sso", value: "none" } as const;

/**
 * The silent try of a name arrived at without a session: ask the other name
 * whether someone is signed in there (its full session only). Yes → that
 * session is planted here and the browser lands on `next`; nobody → straight
 * to `next`. Opened with a page load, on this name; `next` is a URL on this
 * name that carries NO_SILENT_SIGNIN, so it never loops.
 */
export function silentSignInHref(other: string, next: string): string {
  return `/api/v1/auth/sso/begin?${new URLSearchParams({ from: other, next, silent: "1" }).toString()}`;
}
