/**
 * The addresses of a person in the two products (products plan §4.3): Hub «Люди» (`/people/:ref/:tab?`, who the person
 * is and what they may) and Workboard «Команда» (`/workboard/team/:ref/:tab?`, the person at work). A ref is the
 * registry's code, or the number of a login no person holds. One card is never drawn twice: each links the other.
 */

/** The tabs of the person's card in Hub; «Человек» is the bare address. */
export const HUB_PERSON_TABS = ["person", "logins", "pages", "teams", "history"] as const;
export type HubPersonTab = (typeof HUB_PERSON_TABS)[number];

/** The tabs of the person's card in Workboard «Команда»; «Работа» is the bare address. */
export const TEAM_PERSON_TABS = ["work", "sales", "schedule"] as const;
export type TeamPersonTab = (typeof TEAM_PERSON_TABS)[number];

/** Hub's card of a person (a path of Hub): `/people/alex`, `/people/alex/logins`. */
export function hubPersonPath(ref: string | number, tab: HubPersonTab = "person"): string {
  return `/people/${encodeURIComponent(String(ref))}${tab === "person" ? "" : `/${tab}`}`;
}

/** Workboard's card of a person (a path of the host, under /workboard/): `/workboard/team/alex/schedule`. */
export function teamPersonHref(ref: string | number, tab: TeamPersonTab = "work"): string {
  return `/workboard/team/${encodeURIComponent(String(ref))}${tab === "work" ? "" : `/${tab}`}`;
}
