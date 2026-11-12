import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { PlaceFrame } from "@agency_hub_core/ui/components/Place";
import { carriedHref, consoleDays, placeName, waitingCount, waitingQuery } from "@agency_hub_core/ui/place";
import { matchScreen, menuItemAt, placeMenu, type MenuItem } from "@agency_hub_core/ui/screens";
import { useLogout } from "@/api/queries";
import { kernel } from "@/api/sdk";
import { ACCOUNT_SCREEN, SIGNED_OUT_LOGIN } from "@/lib/navigation";
import { ALL_PAGES_PARAM, pageFromSearch } from "@/lib/pageParam";
import { isPeriodKey, periodParam } from "@/lib/period";
import { clearDashboardSession } from "@/lib/queryClient";
import { usePageFilterStore } from "@/stores/pageFilterStore";
import { usePeriodStore } from "@/stores/periodStore";

/**
 * The console inside the frame of the owner's place (packages/ui Place.tsx):
 * the one menu, the same in Workboard. A Workboard item carries the page this
 * console shows and its period when Workboard has it too (30 or 14 days).
 */
export function ConsoleFrame({ user, searchOpen, setSearchOpen, children }: {
  user: { username: string; role: string };
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  children: ReactNode;
}) {
  const location = useLocation();
  const logout = useLogout();
  const remembered = usePageFilterStore((state) => state.page);
  const storedPeriod = usePeriodStore((state) => state.period);
  const waiting = useQuery({ ...waitingQuery(kernel), meta: { suppressGlobalError: true } });

  // What this screen shows: the page in the address (or every page by link), else the one picked by hand;
  // its period when it has the remembered one, else that one.
  const search = new URLSearchParams(location.search);
  const page = search.get("page") === ALL_PAGES_PARAM ? null : pageFromSearch(search) ?? remembered;
  const screen = matchScreen(location.pathname)?.screen;
  const raw = periodParam(search);
  const period = screen?.period?.class === "shared" && isPeriodKey(raw) ? raw : storedPeriod;
  const hrefOf = (item: MenuItem) => (item.app === "console" ? item.to : carriedHref(item, { page, days: consoleDays(period) }));

  async function signOut() {
    if (logout.isPending) return;
    try {
      await logout.mutateAsync();
      clearDashboardSession();
      window.location.assign(SIGNED_OUT_LOGIN);
    } catch { /* The mutation keeps the failure; an unconfirmed sign-out is said under the account. */ }
  }

  return (
    <PlaceFrame
      here={{ app: "console", basename: "" }}
      brand={placeName("place")}
      menu={placeMenu(user.role)}
      current={menuItemAt(location.pathname)}
      hrefOf={hrefOf}
      counts={{ waiting: waitingCount(waiting) }}
      account={{
        name: user.username,
        role: user.role,
        signOut: () => void signOut(),
        signingOut: logout.isPending,
        signOutFailed: logout.isError,
        // Workboard's screen, a page load on this host.
        onAccount: () => window.location.assign(ACCOUNT_SCREEN),
      }}
      searchOpen={searchOpen}
      setSearchOpen={setSearchOpen}
    >
      {children}
    </PlaceFrame>
  );
}
