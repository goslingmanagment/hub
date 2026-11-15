/**
 * Where an invitation's or a new password's link opens (products plan, package C4): the one rule, for Hub «Люди»
 * (packages/ui teamAccess.ts) and for the test team's seed alike. A content manager's login ends in ContentOps' own
 * «Придумайте пароль»; everyone else's opens the chatters' site. The secret travels in the fragment: it never reaches
 * a server log as a path.
 */

/** The chatters' site and Workboard's one address (packages/ui sites.ts re-exports it). */
export const CHATTER_SITE_ORIGIN = "https://chatgoose.gosling-agency.ru";

/** ContentOps, the content's own product (packages/ui sites.ts re-exports it). */
export const CONTENTOPS_ORIGIN = "https://contentops.gosling-agency.ru";

/** A login whose only product is ContentOps: its links and its sign-in are ContentOps' own. */
export function opensContentopsOnly(role: string | null | undefined): boolean {
  return role === "content_manager";
}

/** The link of a secret for a login of `role`; `chatterSiteOrigin` is where everyone else's opens. */
export function joinLink(secret: string, role: string | null | undefined, chatterSiteOrigin: string = CHATTER_SITE_ORIGIN): string {
  return `${opensContentopsOnly(role) ? CONTENTOPS_ORIGIN : chatterSiteOrigin}/join#${secret}`;
}
