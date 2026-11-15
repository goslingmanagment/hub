import { Navigate, Outlet, createBrowserRouter, useLocation, type Params, type RouteObject } from "react-router";
import { WORKBOARD_OLD_PATHS, workboardOldAddress } from "@agency_hub_core/ui/old-addresses";
import { START_PATH, startOpen, useAccountStart } from "@/shared/start";
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

/**
 * `/` is Смены for the team and «Мои смены» for a chatter, with whatever the
 * address carried — and «Начало» for a newcomer with a step still open (it
 * leaves once every step is done). The start's read is a chatter's only.
 */
function HomeRedirect() {
  const location = useLocation();
  const { role } = useMe();
  const start = useAccountStart();
  const asks = role === "chatter";
  if (asks && start.isPending) return null;
  const pathname = asks && startOpen(start.data) ? START_PATH : homePath(role);
  return <Navigate to={{ pathname, search: location.search }} replace />;
}

/**
 * The team's screens, the owner's and team leads' (spec §3–4), one folder per
 * group under src/screens/, each loaded on first visit. Deep pages: Разбор
 * смены `/shifts/:userId/:shiftStart`, Человек `/people/:ref[/sales|access|schedule]`
 * — a person's code, or a login's number that lands on its person (`/shifts`
 * redirects to Работа).
 */
const teamScreens: RouteObject[] = [
  { path: "people", lazy: () => import("../screens/people/index.js").then((m) => ({ Component: m.PeopleScreen })) },
  {
    path: "people/:ref/:tab?",
    handle: { screenKey: (params) => params.ref ?? "" } satisfies ScreenHandle,
    lazy: () => import("../screens/people/index.js").then((m) => ({ Component: m.PersonScreen })),
  },
  { path: "sales/:tab", lazy: () => import("../screens/sales/index.js").then((m) => ({ Component: m.SalesScreen })) },
  // «Ждут вас» (it was Решения at `/decisions`, which leads here): the list read from matters.
  { path: "waiting", lazy: () => import("../screens/waiting/index.js").then((m) => ({ Component: m.WaitingScreen })) },
  { path: "payouts", lazy: () => import("../screens/payouts/index.js").then((m) => ({ Component: m.PayoutsScreen })) },
];

/**
 * A chatter's own part of Workboard (owner, 2026-11-10): their shifts with their reports, sales only — no pay, nobody
 * else's; and a newcomer's «Начало» (package J).
 */
const chatterScreens: RouteObject[] = [
  { path: "start", lazy: () => import("../screens/start/index.js").then((m) => ({ Component: m.StartScreen })) },
  { path: "my/shifts", lazy: () => import("../screens/my-shifts/index.js").then((m) => ({ Component: m.MyShiftsScreen })) },
];

/**
 * The «Отчёт» board (package R): a shift's report, the person's own to hand in, someone else's to read (the owner, a
 * team lead, a colleague; Hub decides). The whole window, without Workboard's frame. `/report` — the person's own
 * shift that needs them most. Its frame for the extension (`/frame/report`) is outside the sign-in gate (`router`).
 */
const boardScreens: RouteObject[] = [
  { path: "report", lazy: () => import("../screens/report/index.js").then((m) => ({ Component: m.ReportScreen })) },
  {
    path: "report/:shiftId",
    handle: { screenKey: (params) => params.shiftId ?? "" } satisfies ScreenHandle,
    lazy: () => import("../screens/report/index.js").then((m) => ({ Component: m.ReportScreen })),
  },
];

/**
 * An old address of Workboard: where it leads now, with what it carried (packages/ui/src/old-addresses.ts). The
 * screen it lands on checks the role, as for anyone who opened it there.
 */
function OldAddress() {
  const location = useLocation();
  const to = workboardOldAddress(location) ?? { pathname: "/", search: location.search, hash: "" };
  return <Navigate to={to} state={location.state as unknown} replace />;
}

/**
 * Кастомы (package I): everyone's — the lead and the owner see every order, a
 * team lead and a chatter the orders of their pages (Hub decides).
 */
const everyoneScreens: RouteObject[] = [
  // «Смены» and «Разбор смены» (products package T): the team's, a chatter's too — Hub cuts every read to the viewer's
  // teams (services/teams.ts); a chatter reaches them from «Смены» → «Команда».
  { path: "shifts", lazy: () => import("../screens/shifts/index.js").then((m) => ({ Component: m.ShiftsScreen })) },
  {
    path: "shifts/:userId/:shiftStart",
    handle: { screenKey: (params) => `${params.userId ?? ""}/${params.shiftStart ?? ""}` } satisfies ScreenHandle,
    lazy: () => import("../screens/review/index.js").then((m) => ({ Component: m.ReviewScreen })),
  },
  // «Фаны» (products package M): moved from the console; Hub answers by the viewer's teams.
  { path: "fans", lazy: () => import("../screens/fans/index.js").then((m) => ({ Component: m.FansScreen })) },
  { path: "fans/subscribers", lazy: () => import("../screens/fans/index.js").then((m) => ({ Component: m.FansSubscribersScreen })) },
  { path: "fans/followers", lazy: () => import("../screens/fans/index.js").then((m) => ({ Component: m.FansFollowersScreen })) },
  { path: "fans/gone", lazy: () => import("../screens/fans/index.js").then((m) => ({ Component: m.FansGoneScreen })) },
  { path: "fans/by-spend", lazy: () => import("../screens/fans/index.js").then((m) => ({ Component: m.FansBySpendScreen })) },
  { path: "fans/by-spend/:bucketKey", lazy: () => import("../screens/fans/index.js").then((m) => ({ Component: m.FansBySpendListScreen })) },
  {
    path: "fans/:pageLabel/:platform/:platformUserId",
    handle: { screenKey: (params) => `${params.pageLabel ?? ""}/${params.platform ?? ""}/${params.platformUserId ?? ""}` } satisfies ScreenHandle,
    lazy: () => import("../screens/fans/index.js").then((m) => ({ Component: m.FanScreen })),
  },
  { path: "fans/:platform/:platformUserId", lazy: () => import("../screens/fans/index.js").then((m) => ({ Component: m.FanAnyPage })) },
  { path: "customs", lazy: () => import("../screens/customs/index.js").then((m) => ({ Component: m.CustomsBoardScreen })) },
  // «Аккаунт и устройства» (the console's /account until 12.11): everyone's own, from the name menu; a narrow session
  // gets the way to the password there instead of the devices and the password.
  { path: "account", lazy: () => import("../screens/account/index.js").then((m) => ({ Component: m.AccountScreen })) },
  {
    path: "customs/:code",
    handle: { screenKey: (params) => params.code ?? "" } satisfies ScreenHandle,
    lazy: () => import("../screens/customs/index.js").then((m) => ({ Component: m.CustomOrderScreen })),
  },
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
  { element: <RoleGate roles={[...TEAM, ...CHATTER]} />, children: everyoneScreens },
  // The specimen of packages/ui: the demo and dev servers only, never a production build.
  ...(import.meta.env.DEV
    ? [{ path: "__specimen", lazy: () => import("../screens/specimen/SpecimenScreen.js").then((m) => ({ Component: m.SpecimenScreen })) }]
    : []),
  { path: "*", element: <NotFoundScreen /> },
];

export const router = createBrowserRouter(
  [
    // The extension's frame: no sign-in gate, never `me`; its requests go over the extension's port.
    { path: "frame/report", lazy: () => import("../screens/report/index.js").then((m) => ({ Component: m.FrameReportScreen })) },
    // Old addresses lead to new ones, whoever opens them (packages/ui/src/old-addresses.ts, one table).
    ...WORKBOARD_OLD_PATHS.map((path) => ({ path, element: <OldAddress /> })),
    // The board's demo pages (scenarios, the extension's part): the demo and dev servers only, never a production build.
    ...(import.meta.env.DEV
      ? [
        { path: "__report", lazy: () => import("../screens/report/demo.js").then((m) => ({ Component: m.ReportDemoIndex })) },
        { path: "__report/frame", lazy: () => import("../screens/report/demo.js").then((m) => ({ Component: m.ReportDemoFrame })) },
      ]
      : []),
    {
      element: (
        <AuthGate>
          <Outlet />
        </AuthGate>
      ),
      children: [{ element: <RoleGate roles={[...TEAM, ...CHATTER]} />, children: boardScreens }],
    },
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
