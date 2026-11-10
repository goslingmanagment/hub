import { Navigate, createBrowserRouter, useLocation, useParams, type Params, type RouteObject } from "react-router";
import { CHATTER, TEAM, homePath, useMe } from "@/shared/useMe";
import { AuthGate } from "./AuthGate.js";
import { NotFoundScreen } from "./NotFound.js";
import { RoleGate } from "./RoleGate.js";
import { Shell } from "./Shell.js";

/** The router's basename: Vite's `base` without its last slash (src/base.ts is the one constant). */
export const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

/**
 * A route's `handle`: what makes a new instance of its screen besides the route
 * (Shell keys the screen's error boundary by both). Without it, every address
 * of the route is one screen that stays mounted — the tabs of Что продаёт; the
 * person's card is one screen per person (its tabs keep it), the review one per
 * shift.
 */
export interface ScreenHandle {
  screenKey?: (params: Params) => string;
}

/** `/` is Смены for the team and «Мои смены» for a chatter, with whatever the address carried. */
function HomeRedirect() {
  const location = useLocation();
  const { role } = useMe();
  return <Navigate to={{ pathname: homePath(role), search: location.search }} replace />;
}

/**
 * `/people/:userId/shifts` is Работа now (D2: the shift table lives there): the
 * same person, period and page, and the same «←».
 */
function PersonShiftsRedirect() {
  const location = useLocation();
  const { userId } = useParams();
  return <Navigate to={{ pathname: `/people/${userId ?? ""}`, search: location.search, hash: location.hash }} state={location.state as unknown} replace />;
}

/**
 * `/my/reports` (the first chatter screen, «Мои отчёты») is «Мои смены» now: a
 * shift and its report are one row there. Its `?days=14|30` is the app's period.
 */
function MyReportsRedirect() {
  const location = useLocation();
  return <Navigate to={{ pathname: "/my/shifts", search: location.search }} replace />;
}

/** `/sales` opens its first tab. */
function SalesRedirect() {
  const location = useLocation();
  return <Navigate to={{ pathname: "/sales/price", search: location.search }} replace />;
}

/**
 * The team's screens, the owner's and team leads' (spec §3–4), one folder per
 * group under src/screens/, each loaded on first visit. Deep pages: Разбор
 * смены `/shifts/:userId/:shiftStart`, Человек `/people/:userId[/sales|access]`
 * (`/shifts` redirects to Работа).
 */
const teamScreens: RouteObject[] = [
  { path: "shifts", lazy: () => import("../screens/shifts/index.js").then((m) => ({ Component: m.ShiftsScreen })) },
  {
    path: "shifts/:userId/:shiftStart",
    handle: { screenKey: (params) => `${params.userId ?? ""}/${params.shiftStart ?? ""}` } satisfies ScreenHandle,
    lazy: () => import("../screens/review/index.js").then((m) => ({ Component: m.ReviewScreen })),
  },
  { path: "people", lazy: () => import("../screens/people/index.js").then((m) => ({ Component: m.PeopleScreen })) },
  { path: "people/:userId/shifts", element: <PersonShiftsRedirect /> },
  {
    path: "people/:userId/:tab?",
    handle: { screenKey: (params) => params.userId ?? "" } satisfies ScreenHandle,
    lazy: () => import("../screens/people/index.js").then((m) => ({ Component: m.PersonScreen })),
  },
  { path: "sales", element: <SalesRedirect /> },
  { path: "sales/:tab", lazy: () => import("../screens/sales/index.js").then((m) => ({ Component: m.SalesScreen })) },
  { path: "decisions", lazy: () => import("../screens/decisions/index.js").then((m) => ({ Component: m.DecisionsScreen })) },
  { path: "payouts", lazy: () => import("../screens/payouts/index.js").then((m) => ({ Component: m.PayoutsScreen })) },
  { path: "access", lazy: () => import("../screens/access/index.js").then((m) => ({ Component: m.AccessScreen })) },
];

/** A chatter's own part of Workboard (owner, 2026-11-10): their shifts with their reports, sales only — no pay, nobody else's. */
const chatterScreens: RouteObject[] = [
  { path: "my/shifts", lazy: () => import("../screens/my-shifts/index.js").then((m) => ({ Component: m.MyShiftsScreen })) },
  { path: "my/reports", element: <MyReportsRedirect /> },
];

/**
 * Every address, each group behind its role guard (RoleGate): a screen of the
 * team never mounts for a chatter, nor a chatter's for the team — one rule
 * here, not one per screen. A new chatter screen is one line of `chatterScreens`
 * and one item of the menu (Shell.tsx).
 */
const screens: RouteObject[] = [
  { index: true, element: <HomeRedirect /> },
  { element: <RoleGate roles={TEAM} />, children: teamScreens },
  { element: <RoleGate roles={CHATTER} />, children: chatterScreens },
  // The specimen of packages/ui: the demo and dev servers only, never a production build.
  ...(import.meta.env.DEV
    ? [{ path: "__specimen", lazy: () => import("../screens/specimen/SpecimenScreen.js").then((m) => ({ Component: m.SpecimenScreen })) }]
    : []),
  { path: "*", element: <NotFoundScreen /> },
];

export const router = createBrowserRouter(
  [
    {
      element: (
        <AuthGate>
          <Shell />
        </AuthGate>
      ),
      children: screens,
    },
  ],
  { basename: BASENAME },
);
