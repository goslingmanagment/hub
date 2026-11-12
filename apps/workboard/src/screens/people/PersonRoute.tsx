import { Navigate, useLocation, useParams } from "react-router";
import { ScreenFallback } from "@/app/Shell";
import type { PersonTab } from "@/shared/links";
import { LoginCard } from "./PersonScreen.js";
import { PersonCard } from "./PersonCard.js";
import { personOfLogin, useTeamPeople } from "./registry.js";

const TABS: ReadonlySet<string> = new Set<PersonTab>(["work", "sales", "access", "schedule"]);

/**
 * `/people/:ref[/:tab]`. A code (`/people/alex`) is the person's card. A number
 * is a login's address, as every link of Workboard and the console still
 * makes (`/people/4`, `/people/4/access`): it lands on the card of the person
 * holding that login, with the same tab, period, page and «←»; a login no
 * person holds keeps its own card (LoginCard), so nothing it had goes out of
 * reach. A code made only of digits is looked up as a code when no login has
 * that number.
 */
export function PersonScreen() {
  const { ref = "", tab } = useParams();
  if (!/^\d+$/.test(ref)) return <PersonCard code={ref} />;
  return <LoginAddress userId={Number(ref)} tab={tab} />;
}

function LoginAddress({ userId, tab }: { userId: number; tab: string | undefined }) {
  const location = useLocation();
  const list = useTeamPeople();
  if (list.data === undefined && !list.isError) return <ScreenFallback />;
  const people = list.data?.people ?? [];
  const person = personOfLogin(people, userId);
  if (person) {
    // The whole query goes along (the period, the page, anything else the link carried), and the tab when it is one of the card's.
    const pathname = `/people/${encodeURIComponent(person.code)}${tab && TABS.has(tab) ? `/${tab}` : ""}`;
    return <Navigate replace to={{ pathname, search: location.search, hash: location.hash }} state={location.state as unknown} />;
  }
  if (people.some((one) => one.code === String(userId))) return <PersonCard code={String(userId)} />;
  return <LoginCard userId={userId} />;
}
