/**
 * Where an invitation's or a new password's link opens (products plan, package C4): the one rule, for Hub «Люди»
 * (packages/ui teamAccess.ts) and for the test team's seed alike. A content manager's login ends in ContentOps' own
 * «Придумайте пароль»; everyone else's opens Workboard's name. The secret travels in the fragment: it never reaches
 * a server log as a path.
 */

/**
 * Workboard's one address, every role's, on its own name since 2026-11-17 (owner's word): Workboard under `/workboard/`,
 * and the team's sign-in, invitation and account pages (packages/ui sites.ts re-exports it).
 */
export const WORKBOARD_ORIGIN = "https://workboard.gosling-agency.ru";

/**
 * The chatters' site: ChatGoose's pages (install, how to start), the static reports behind Hub's sign-in, the board's
 * frames for the extension. Workboard's name until 2026-11-17: a Workboard page asked there is sent on to
 * WORKBOARD_ORIGIN, signed in (the runtime's signin-handoff.ts). packages/ui sites.ts re-exports it.
 */
export const CHATTER_SITE_ORIGIN = "https://chatgoose.gosling-agency.ru";

/** ContentOps, the content's own product (packages/ui sites.ts re-exports it). */
export const CONTENTOPS_ORIGIN = "https://contentops.gosling-agency.ru";

/** A login whose only product is ContentOps: its links and its sign-in are ContentOps' own. */
export function opensContentopsOnly(role: string | null | undefined): boolean {
  return role === "content_manager";
}

/** The link of a secret for a login of `role`; `teamOrigin` is where everyone else's opens. */
export function joinLink(secret: string, role: string | null | undefined, teamOrigin: string = WORKBOARD_ORIGIN): string {
  return `${opensContentopsOnly(role) ? CONTENTOPS_ORIGIN : teamOrigin}/join#${secret}`;
}
