// The names nginx serves this one app under in production. A session is a
// host-only cookie, so a sign-in on one name does not carry to another.

/** The admin console, for the owner and team leads: every path is this app. */
export const CONSOLE_ORIGIN = "https://hub.gosling-agency.ru";

/** The name the console answered on before it had its own. */
export const LEGACY_CONSOLE_ORIGIN = "https://gosling-agency.ru";

/** The chatters' site. Only /account, /join and /login are this app there;
 *  every other path is a static page, so no console route exists on it. */
export const CHATTER_SITE_ORIGIN = "https://chatgoose.gosling-agency.ru";

/** What the browser tab is called there; index.html names the console. */
export const CHATTER_SITE_TITLE = "ChatGoose";

const PRODUCTION_CONSOLE_ORIGINS: ReadonlySet<string> = new Set([
  CONSOLE_ORIGIN,
  LEGACY_CONSOLE_ORIGIN,
]);

/** Guarded: the settings tree also renders server-side in tests, where there
 *  is no window. */
export function isChatterSite(): boolean {
  return typeof window !== "undefined" && window.location.origin === CHATTER_SITE_ORIGIN;
}

/**
 * The origin of the chatters' pages that go with a console running on
 * `consoleOrigin`. A production console sends people to the chatters' site.
 * Any other origin — a local build, a test — is the whole app on one name and
 * serves those pages itself.
 */
export function chatterSiteOriginFor(consoleOrigin: string): string {
  return PRODUCTION_CONSOLE_ORIGINS.has(consoleOrigin) ? CHATTER_SITE_ORIGIN : consoleOrigin;
}

/** index.html ships one title, the console's, to every name. */
export function applySiteTitle(): void {
  if (isChatterSite()) document.title = CHATTER_SITE_TITLE;
}
