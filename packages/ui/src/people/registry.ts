/**
 * The people registry as both products draw it (products plan §4.3): Hub «Люди» (who a person is and what they may)
 * and Workboard «Команда» (the team at work). Types of the registry's answers and the pure helpers both read; no
 * reads, no writes: each app asks Hub with its own client (Hub: apps/dashboard/src/pages/people/registry.ts, Workboard:
 * apps/workboard/src/screens/team/registry.ts) and hands the answers to these.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { KernelApiError } from "../hubClient.js";
import { weekdaysWords } from "./words.js";

/** The team's people (`teamPeople`): the owner gets everyone, anyone else the people of their teams (products package T). */
export type TeamPeople = KernelOperationResponse<"teamPeople">;
export type RegistryPerson = TeamPeople["people"][number];
export type RegistryLogin = RegistryPerson["logins"][number];
/** The owner's card of one person (`adminPerson`): every slot, the pay terms, the agents' proposals. */
export type OwnerCard = KernelOperationResponse<"adminPerson">;
export type PayTerm = OwnerCard["payTerms"][number];
export type Slot = OwnerCard["scheduleSlots"][number];
export type Proposal = OwnerCard["proposals"][number];
export type CreatedPerson = KernelOperationResponse<"adminPersonCreate">;
/** A page of the catalog (`adminPages`), as the forms choose working pages from it. */
export type AdminPage = KernelOperationResponse<"adminPages">[number];

/** The person holding a login, if any. */
export function personOfLogin(people: readonly RegistryPerson[], userId: number): RegistryPerson | null {
  return people.find((person) => person.logins.some((login) => login.userId === userId)) ?? null;
}

/** The logins that count: not deleted (a deleted login cannot be worked or switched off). */
export function liveLogins(person: Pick<RegistryPerson, "logins">): RegistryLogin[] {
  return person.logins.filter((login) => login.state !== "deleted");
}

/** The latest moment any of the person's logins was seen; null — never. */
export function lastSeenOf(person: Pick<RegistryPerson, "logins">): string | null {
  let best: string | null = null;
  for (const login of person.logins) if (login.lastSeenAt && (best === null || login.lastSeenAt > best)) best = login.lastSeenAt;
  return best;
}

/** Import notes the owner has not marked «Сверено». */
export function unsettledNotes(person: Pick<RegistryPerson, "importNotes">): number {
  return person.importNotes.filter((note) => note.settledAt === null).length;
}

/**
 * Whom a team lead's «Команда» shows: the people on the lead's pages — working
 * one of them, or with a shift there in the period (`worked`) — humans only.
 * The owner sees everyone.
 */
export function onPagesOf(person: RegistryPerson, pages: ReadonlySet<string> | null, worked: boolean): boolean {
  if (pages === null) return true;
  if (person.kind !== "human") return false;
  return worked || person.workingPages.some((page) => pages.has(page.pageLabel));
}

/** Hub's words of a refused write, for the screen: the reason it gave, else the status. */
export function refusal(error: unknown): { status: number | null; reason: string | null; message: string } {
  if (!(error instanceof KernelApiError)) return { status: null, reason: null, message: "" };
  const body = error.body as { reason?: unknown; message?: unknown } | null;
  return {
    status: error.status,
    reason: typeof body?.reason === "string" ? body.reason : null,
    message: typeof body?.message === "string" ? body.message : error.message,
  };
}

/** Pages under their models, in the catalog's order. */
export function pagesByModel(pages: readonly AdminPage[]): { modelSlug: string; modelName: string; pages: AdminPage[] }[] {
  const groups = new Map<string, { modelSlug: string; modelName: string; pages: AdminPage[] }>();
  for (const page of pages) {
    const group = groups.get(page.modelSlug);
    if (group) group.pages.push(page);
    else groups.set(page.modelSlug, { modelSlug: page.modelSlug, modelName: page.modelName, pages: [page] });
  }
  return [...groups.values()];
}

/**
 * For the list and the card header: one person's slot now in a few words — the hours «08:00–16:00», the days «пн–пт»,
 * and the pages with a line of their own «своя на ivy-2».
 */
export function slotSummary(person: Pick<RegistryPerson, "schedule" | "pageSchedules">): { main: string | null; hours: string | null; days: string; extra: string | null } {
  const general = person.schedule;
  const hours = general ? `${general.start}–${general.end}` : null;
  const days = general ? weekdaysWords(general.weekdays) : "";
  const own = person.pageSchedules.map((slot) => slot.pageLabel).filter((label): label is string => label !== null);
  const extra = own.length === 0 ? null : `своя на ${own.join(", ")}`;
  return { main: hours ? `${hours}${days ? `, ${days}` : ""}` : null, hours, days, extra };
}
