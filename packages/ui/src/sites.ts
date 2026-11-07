/**
 * The names nginx serves Hub's web apps under in production. A session is a
 * host-only cookie, so a sign-in on one name does not carry to another. One
 * copy for the console (apps/dashboard/src/lib/sites.ts re-exports it) and
 * Workboard.
 */

/** The admin console, for the owner and team leads (Workboard lives under it, at /workboard/). */
export const CONSOLE_ORIGIN = "https://hub.gosling-agency.ru";

/** The name the console answered on before it had its own. */
export const LEGACY_CONSOLE_ORIGIN = "https://gosling-agency.ru";

/** The chatters' site. Only /account, /join and /login are the console's app there; every other path is a static page. */
export const CHATTER_SITE_ORIGIN = "https://chatgoose.gosling-agency.ru";

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
