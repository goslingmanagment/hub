// The names nginx serves this one app under in production. A session is a
// host-only cookie on each name; a sign-in on one is planted on the other by a
// one-time code. The names and the console → chatters' site rule are one copy
// with Workboard: packages/ui/src/sites.ts.
import { peerOriginOf, siteOf } from "@agency_hub_core/ui/sites";

export { CHATTER_SITE_ORIGIN, NO_SILENT_SIGNIN, peerOriginOf, signInHopHref, silentSignInHref } from "@agency_hub_core/ui/sites";

/** What the browser tab is called there; index.html names the console. */
export const CHATTER_SITE_TITLE = "ChatGoose";

/** Guarded: the settings tree also renders server-side in tests, where there
 *  is no window. Locally `chatgoose.localhost` plays the chatters' site. */
export function isChatterSite(): boolean {
  return typeof window !== "undefined" && siteOf(window.location.origin) === "team";
}

/** True only on the console's own name (`hub.`; locally `hub.localhost`). A
 *  local build on one name or a test is the whole app on one origin and serves
 *  the cabinet itself. Guarded like isChatterSite. */
export function isConsoleSite(): boolean {
  return typeof window !== "undefined" && siteOf(window.location.origin) === "console";
}

/** The other of the two names, from this page; null on a local build on one name or a test. */
export function peerSiteOrigin(): string | null {
  return typeof window === "undefined" ? null : peerOriginOf(window.location.origin);
}

/** index.html ships one title, the console's, to every name. */
export function applySiteTitle(): void {
  if (isChatterSite()) document.title = CHATTER_SITE_TITLE;
}
