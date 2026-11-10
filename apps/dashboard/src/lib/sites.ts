// The names nginx serves this one app under in production. A session is a
// host-only cookie, so a sign-in on one name does not carry to another. The
// names and the console → chatters' site rule are one copy with Workboard:
// packages/ui/src/sites.ts.
import { CHATTER_SITE_ORIGIN, CONSOLE_ORIGIN } from "@agency_hub_core/ui/sites";

export { CHATTER_SITE_ORIGIN } from "@agency_hub_core/ui/sites";

/** What the browser tab is called there; index.html names the console. */
export const CHATTER_SITE_TITLE = "ChatGoose";

/** Guarded: the settings tree also renders server-side in tests, where there
 *  is no window. */
export function isChatterSite(): boolean {
  return typeof window !== "undefined" && window.location.origin === CHATTER_SITE_ORIGIN;
}

/** True only on the console's own production name. A local build or a test is
 *  the whole app on one origin and serves the cabinet itself. Guarded like
 *  isChatterSite. */
export function isConsoleSite(): boolean {
  return typeof window !== "undefined" && window.location.origin === CONSOLE_ORIGIN;
}

/** index.html ships one title, the console's, to every name. */
export function applySiteTitle(): void {
  if (isChatterSite()) document.title = CHATTER_SITE_TITLE;
}
