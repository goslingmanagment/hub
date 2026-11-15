import { useLayoutEffect } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { registryTabLanding } from "@agency_hub_core/ui/old-addresses";
import { TEAM_PERSON_TABS } from "@agency_hub_core/contracts";
import { ScreenFallback } from "@/app/Shell";
import { hubHref } from "@/shared/links";
import { useMe } from "@/shared/useMe";
import { LoginCard } from "./PersonScreen.js";
import { PersonCard } from "./PersonCard.js";
import { personOfLogin, useTeamPeople } from "./registry.js";

const TABS: ReadonlySet<string> = new Set<string>(TEAM_PERSON_TABS);

/**
 * `/team/:ref[/:tab]`. A code (`/team/alex`) is the person's card. A number
 * is a login's address, as every link of Workboard and the console still
 * makes (`/team/4`, `/team/4/sales`): it lands on the card of the person
 * holding that login, with the same tab, period, page and «←»; a login no
 * person holds keeps its own card (LoginCard), so nothing it had goes out of
 * reach. A code made only of digits is looked up as a code when no login has
 * that number. The registry's old tab (`/team/:ref/access`, where every old
 * address of a person's access lands) opens Hub «Люди» for the owner and the
 * person's card here for anyone else (packages/ui old-addresses.ts).
 */
export function PersonScreen() {
  const { ref = "", tab } = useParams();
  const location = useLocation();
  const { isOwner } = useMe();
  const registry = registryTabLanding(location, isOwner);
  if (registry && "hub" in registry) return <LeaveForHub path={registry.hub} />;
  if (registry) return <Navigate replace to={registry.workboard} state={location.state as unknown} />;
  if (!/^\d+$/.test(ref)) return <PersonCard code={ref} />;
  return <LoginAddress userId={Number(ref)} tab={tab} />;
}

/** A page load to Hub, signed in on the way; the old address is not kept in the history. */
function LeaveForHub({ path }: { path: string }) {
  useLayoutEffect(() => {
    window.location.replace(hubHref(path));
  }, [path]);
  return <ScreenFallback />;
}

function LoginAddress({ userId, tab }: { userId: number; tab: string | undefined }) {
  const location = useLocation();
  const list = useTeamPeople();
  if (list.data === undefined && !list.isError) return <ScreenFallback />;
  const people = list.data?.people ?? [];
  const person = personOfLogin(people, userId);
  if (person) {
    // The whole query goes along (the period, the page, anything else the link carried), and the tab when it is one of the card's.
    const pathname = `/team/${encodeURIComponent(person.code)}${tab && TABS.has(tab) && tab !== "work" ? `/${tab}` : ""}`;
    return <Navigate replace to={{ pathname, search: location.search, hash: location.hash }} state={location.state as unknown} />;
  }
  if (people.some((one) => one.code === String(userId))) return <PersonCard code={String(userId)} />;
  return <LoginCard userId={userId} />;
}
