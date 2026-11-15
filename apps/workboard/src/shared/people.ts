import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { LOGINS_ONLY, peopleIndex, teamPeopleQuery, type PeopleIndex } from "@agency_hub_core/ui/people";
import { kernel } from "./hub.js";
import { useMe } from "./useMe.js";

/**
 * Who a login is on this screen (packages/ui/src/people.ts): the registry's
 * person and their display name. Everyone's read: Hub answers anyone but the
 * owner with the people of their teams (products package T).
 */
export function usePeopleIndex(): PeopleIndex {
  const { role } = useMe();
  const registry = useQuery({ ...teamPeopleQuery(kernel), enabled: role !== null });
  return useMemo(() => (registry.data ? peopleIndex(registry.data.people) : LOGINS_ONLY), [registry.data]);
}
