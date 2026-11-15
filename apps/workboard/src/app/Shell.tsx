import { Suspense, useState, type ReactNode } from "react";
import { Navigate, Outlet, useLocation, useMatches, useNavigate, type UIMatch } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ErrorState, Skeleton } from "@agency_hub_core/ui";
import { PlaceFrame } from "@agency_hub_core/ui/components/Place";
import { crossHref, productHome, productLinks, productName, waitingCount, waitingQuery, type MenuCountView } from "@agency_hub_core/ui/place";
import { menuItemAt, productMenu, type MenuItem } from "@agency_hub_core/ui/screens";
import { NO_SILENT_SIGNIN } from "@agency_hub_core/ui/sites";
import { kernel, queryClient, signInHref } from "@/shared/hub";
import { carryParams } from "@/shared/links";
import { usePeopleIndex } from "@/shared/people";
import { startOpen, useAccountStart } from "@/shared/start";
import { useOwnPayOn } from "@/shared/ownPay";
import { useMe } from "@/shared/useMe";
import { useRestoredPeriod } from "@/shared/usePeriod";
import { useScrollMemory } from "@/shared/scroll";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { WorkboardPalette } from "./Palette.js";
import { BASENAME, type ScreenHandle } from "./routes.js";

/** The router's basename as a prefix of the host's addresses: "" when Workboard is served at the root. */
function base(): string {
  return BASENAME === "/" ? "" : BASENAME;
}

/** «Ждут вас»: the one read both products show (packages/ui/src/place.ts). */
function useWaitingCount(enabled: boolean, owner: boolean): MenuCountView | null {
  const read = useQuery({ ...waitingQuery(kernel), enabled });
  // The owner's Workboard list is Workboard's cut of everything (the rest is Hub's «Ждут вас»); anyone else's is whole.
  return enabled ? waitingCount(read, owner ? "workboard" : undefined) : null;
}

/**
 * What makes a new instance of the screen: its route, and for a deep page the
 * object it shows (`handle.screenKey`, routes.tsx). Tabs of one card or one
 * screen keep the screen — and its state — mounted.
 */
function useScreenKey(): string {
  const matches = useMatches() as UIMatch<unknown, ScreenHandle | undefined>[];
  const leaf = matches.at(-1);
  if (!leaf) return "";
  return `${leaf.id}:${leaf.handle?.screenKey?.(leaf.params) ?? ""}`;
}

/**
 * The signed-in person's name, as every screen names people: the registry's display name of the person holding the
 * login (the team's registry; a chatter's own «Начало» read), the login itself only when no person holds it. The
 * login stays the subject of the account screen.
 */
function useOwnName(): string | null {
  const { user, role } = useMe();
  const people = usePeopleIndex();
  const start = useAccountStart();
  if (!user) return null;
  if (role === "chatter") return start.data?.person?.displayName ?? user.username;
  return people.nameOf(user.id, user.username);
}

/** A screen's place while its code loads: the header's height and a sheet. */
export function ScreenFallback() {
  return (
    <div className="wb-fallback" aria-busy>
      <Skeleton width={180} height={28} radius={6} />
      <Skeleton height={320} radius={12} />
    </div>
  );
}

/**
 * Workboard's frame, every role's (products plan §2.3): the product's frame of packages/ui (Place.tsx) with
 * Workboard's name, its clay accent and its menu from the one table — the role changes what is in the menu, not the
 * frame. The name opens the switcher when the person has more than one product (`me.products`). Workboard's items
 * keep the period and the page of this screen. A chatter's menu has two items and no search.
 */
function WorkboardFrame({ children }: { children: ReactNode }) {
  const me = useMe();
  const { user, role, accountRole } = me;
  const location = useLocation();
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  // «Начало» is listed while a newcomer has a step open (the address still opens it).
  const start = useAccountStart();
  // «Деньги»: the owner's always; anyone else's only while their right «видит свои деньги» is on.
  const ownPay = useOwnPayOn(role !== null && !me.isOwner);
  const menu: { upper: MenuItem[]; lower: MenuItem[] } = role === null ? { upper: [], lower: [] } : productMenu("workboard", role, { newcomer: startOpen(start.data), leads: me.leadsTeam, money: me.isOwner || ownPay });
  const waiting = useWaitingCount(menu.upper.some((item) => item.count === "waiting"), role === "owner");
  const ownName = useOwnName();
  const own = carryParams(location.search).toString();
  const origin = window.location.origin;
  const hrefOf = (item: MenuItem) => (item.app === "workboard" ? `${item.to}${own ? `?${own}` : ""}` : crossHref(item.app, item.to, origin));
  if (!user || role === null) return null;
  const chatter = role === "chatter";
  return (
    // The chatter's phone rules of the screens (app.css `[data-part="chatter"]`) hang on this wrapper.
    <div className="wb-frame" data-part={chatter ? "chatter" : undefined}>
      {searchOpen && <WorkboardPalette role={role} onClose={() => setSearchOpen(false)} />}
      <PlaceFrame
        here={{ app: "workboard", basename: base() }}
        brand={productName("workboard")}
        home={productHome("workboard")}
        products={productLinks(me.data?.products, "workboard", origin)}
        search={!chatter}
        menu={menu}
        current={menuItemAt(`${base()}${location.pathname}`)}
        hrefOf={hrefOf}
        counts={{ waiting }}
        account={{ name: ownName ?? user.username, role: accountRole, signOut, onAccount: () => navigate("/account") }}
        searchOpen={searchOpen}
        setSearchOpen={setSearchOpen}
      >
        {children}
      </PlaceFrame>
    </div>
  );
}

/** Signed out: the sign-in page does not ask the other name (no silent sign-back-in). */
function signOut() {
  void kernel.logout().catch(() => undefined).finally(() => {
    queryClient.clear();
    window.location.assign(`${signInHref(import.meta.env.BASE_URL)}&${NO_SILENT_SIGNIN.param}=${NO_SILENT_SIGNIN.value}`);
  });
}

/**
 * Workboard: its frame (the sidebar on the left, sticky, full height) and the
 * screen on the right using all the width there is. A broken screen keeps the frame.
 */
export function Shell() {
  const location = useLocation();
  // A bare address opens the period last used in this tab (D3); the address then says it — a chatter's too.
  const restored = useRestoredPeriod();
  // «←» comes back to the same place of the page; a new screen opens at its top (D16).
  useScrollMemory();
  const screenKey = useScreenKey();
  const main = (
    <main className="wb-main">
      {restored !== null ? (
        <Navigate replace to={{ pathname: location.pathname, search: restored, hash: location.hash }} state={location.state as unknown} />
      ) : (
        <ErrorBoundary key={screenKey} resetKey={location.pathname} fallback={<div className="wb-content"><ErrorState title="Не удалось открыть экран" onRetry={() => window.location.reload()}>Что-то сломалось в самом экране. Перезагрузка обычно помогает; данные в Hub не тронуты.</ErrorState></div>}>
          <Suspense fallback={<ScreenFallback />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      )}
    </main>
  );
  return <WorkboardFrame>{main}</WorkboardFrame>;
}
