import { useQuery } from "@tanstack/react-query";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { teamPeopleQuery } from "@agency_hub_core/ui/people";
import { kernel } from "@/shared/hub";

/**
 * The team's people (`teamPeople`), the part a chatter's screens may read too: Hub answers the owner with everyone,
 * anyone else with the people of their teams (products package T). The owner's writes and cards stay in registry.ts.
 */
export type TeamPeople = KernelOperationResponse<"teamPeople">;
export type RegistryPerson = TeamPeople["people"][number];
export type RegistryLogin = RegistryPerson["logins"][number];

/** Everyone of the registry (`teamPeople`): the list, every card and every team screen's names read the same entry. */
export function useTeamPeople() {
  return useQuery(teamPeopleQuery(kernel));
}

/** The person holding a login, if any. */
export function personOfLogin(people: readonly RegistryPerson[], userId: number): RegistryPerson | null {
  return people.find((person) => person.logins.some((login) => login.userId === userId)) ?? null;
}

/** The logins that count: not deleted (a deleted login cannot be worked or switched off). */
export function liveLogins(person: Pick<RegistryPerson, "logins">): RegistryLogin[] {
  return person.logins.filter((login) => login.state !== "deleted");
}
