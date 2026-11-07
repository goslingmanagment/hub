import { Navigate, createBrowserRouter, useLocation, type RouteObject } from "react-router";
import { AuthGate } from "./AuthGate.js";
import { NotFoundScreen } from "./NotFound.js";
import { Shell } from "./Shell.js";

/** The router's basename: Vite's `base` without its last slash (src/base.ts is the one constant). */
export const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

/** `/` is Смены, with whatever the address carried. */
function HomeRedirect() {
  const location = useLocation();
  return <Navigate to={{ pathname: "/shifts", search: location.search }} replace />;
}

/** `/sales` opens its first tab. */
function SalesRedirect() {
  const location = useLocation();
  return <Navigate to={{ pathname: "/sales/price", search: location.search }} replace />;
}

/**
 * Every screen of the spec (§3–4), one folder per group under src/screens/,
 * each loaded on first visit. Deep pages: Разбор смены `/shifts/:userId/:shiftStart`,
 * Человек `/people/:userId[/shifts|sales|access]`.
 */
const screens: RouteObject[] = [
  { index: true, element: <HomeRedirect /> },
  { path: "shifts", lazy: () => import("../screens/shifts/index.js").then((m) => ({ Component: m.ShiftsScreen })) },
  { path: "shifts/:userId/:shiftStart", lazy: () => import("../screens/review/index.js").then((m) => ({ Component: m.ReviewScreen })) },
  { path: "people", lazy: () => import("../screens/people/index.js").then((m) => ({ Component: m.PeopleScreen })) },
  { path: "people/:userId/:tab?", lazy: () => import("../screens/people/index.js").then((m) => ({ Component: m.PersonScreen })) },
  { path: "sales", element: <SalesRedirect /> },
  { path: "sales/:tab", lazy: () => import("../screens/sales/index.js").then((m) => ({ Component: m.SalesScreen })) },
  { path: "decisions", lazy: () => import("../screens/decisions/index.js").then((m) => ({ Component: m.DecisionsScreen })) },
  { path: "payouts", lazy: () => import("../screens/payouts/index.js").then((m) => ({ Component: m.PayoutsScreen })) },
  { path: "access", lazy: () => import("../screens/access/index.js").then((m) => ({ Component: m.AccessScreen })) },
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
