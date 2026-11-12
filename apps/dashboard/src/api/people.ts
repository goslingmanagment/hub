import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { LOGINS_ONLY, peopleIndex, teamPeopleQuery, type PeopleIndex } from "@agency_hub_core/ui/people";
import { kernel } from "./sdk.js";

/**
 * Who a login is (packages/ui/src/people.ts, the same read and key as
 * Workboard's «Люди»): a team screen names the person, not the login. The
 * owner's and team leads' read; without it every login is itself.
 */
export function usePeopleIndex(role: string | undefined): PeopleIndex {
  const team = role === "owner" || role === "team_lead";
  const registry = useQuery({ ...teamPeopleQuery(kernel), enabled: team, meta: { suppressGlobalError: true } });
  return useMemo(() => (registry.data ? peopleIndex(registry.data.people) : LOGINS_ONLY), [registry.data]);
}
