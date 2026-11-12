import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { LOGINS_ONLY, peopleIndex, teamPeopleQuery, type PeopleIndex } from "@agency_hub_core/ui/people";
import { kernel } from "./hub.js";
import { useMe } from "./useMe.js";

/**
 * Who a login is on this screen (packages/ui/src/people.ts): the registry's
 * person and their display name. The team's read; a chatter's screens keep
 * the logins as they are (Hub refuses them the registry).
 */
export function usePeopleIndex(): PeopleIndex {
  const { role } = useMe();
  const team = role === "owner" || role === "team_lead";
  const registry = useQuery({ ...teamPeopleQuery(kernel), enabled: team });
  return useMemo(() => (registry.data ? peopleIndex(registry.data.people) : LOGINS_ONLY), [registry.data]);
}
