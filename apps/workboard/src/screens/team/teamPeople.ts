import { useQuery } from "@tanstack/react-query";
import { teamPeopleQuery } from "@agency_hub_core/ui/people";
import { kernel } from "@/shared/hub";

export {
  liveLogins, personOfLogin, type RegistryLogin, type RegistryPerson, type TeamPeople,
} from "@agency_hub_core/ui/people/registry";

/**
 * Everyone of the registry the viewer reads (`teamPeople`), the part a chatter's screens may read too: Hub answers the
 * owner with everyone, anyone else with the people of their teams (products package T). The owner's cards and writes
 * stay in registry.ts.
 */
export function useTeamPeople() {
  return useQuery(teamPeopleQuery(kernel));
}
