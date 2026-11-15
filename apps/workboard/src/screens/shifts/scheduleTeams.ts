import { isChatTeamRole, type KernelOperationResponse } from "@agency_hub_core/contracts";

/**
 * «Смены → График»'s teams (products package W): the people the viewer reads, grouped by the models of their working
 * pages — the chat team only (contracts chat-team.ts: chatters and team leads, not left); a content manager working the
 * pages is not on it. A person is in the team of each model of their working pages, with their every-page slot and a
 * page's own line of that team's pages. Pure (tests/workboard-today.test.ts).
 */

export type TeamPerson = KernelOperationResponse<"teamPeople">["people"][number];
export type ScheduleSlot = NonNullable<TeamPerson["schedule"]>;

const DAY_MINUTES = 1440;

export interface Team {
  slug: string;
  name: string;
  people: Array<{ person: TeamPerson; pages: string[]; slots: ScheduleSlot[] }>;
}


/** The teams of the people the viewer reads: a person is in the team of each model of their working pages. */
export function teamsOf(people: readonly TeamPerson[]): Team[] {
  const teams = new Map<string, Team>();
  for (const person of people) {
    // The chat team (chat-team.ts): chatters and team leads; a content manager with working pages is not on it.
    if (person.kind !== "human" || person.state === "left" || !isChatTeamRole(person.role)) continue;
    const models = new Map<string, { name: string; pages: string[] }>();
    for (const page of person.workingPages) {
      const model = models.get(page.modelSlug) ?? { name: page.modelName, pages: [] };
      model.pages.push(page.pageLabel);
      models.set(page.modelSlug, model);
    }
    for (const [slug, model] of models) {
      const team = teams.get(slug) ?? { slug, name: model.name, people: [] };
      // The person's every-page slot, and a page's own line of this team's pages where it differs.
      const own = person.pageSchedules.filter((slot) => slot.pageLabel !== null && model.pages.includes(slot.pageLabel));
      const slots = [...(person.schedule ? [person.schedule] : []), ...own];
      team.people.push({ person, pages: model.pages, slots });
      teams.set(slug, team);
    }
  }
  return [...teams.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .map((team) => ({ ...team, people: team.people.sort((a, b) => (a.slots[0]?.startMinute ?? DAY_MINUTES) - (b.slots[0]?.startMinute ?? DAY_MINUTES)) }));
}

