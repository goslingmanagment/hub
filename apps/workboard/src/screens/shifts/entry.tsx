import { lazy, Suspense } from "react";
import { Navigate, useLocation } from "react-router";
import { Skeleton } from "@agency_hub_core/ui";
import { useMe } from "@/shared/useMe";

/**
 * One «Смены» (products plan §2.3, package W). A chatter's «Смены» opens «Мои» (their shifts with their reports) and has
 * «Команда» (the team's journal, `/shifts/team`); the owner and a team lead read the journal of their teams, and their
 * own shifts are that journal with `?mine=1`. Hub cuts every read to the viewer's teams.
 */
const Journal = lazy(() => import("./index.js").then((module) => ({ default: module.ShiftsScreen })));
const Mine = lazy(() => import("../my-shifts/index.js").then((module) => ({ default: module.MyShiftsScreen })));

function Loading() {
  return <div className="wb-content"><Skeleton height={320} radius={12} /></div>;
}

/** `/shifts`: a chatter's «Мои», anyone else's journal. */
export function ShiftsEntry() {
  const { role } = useMe();
  const location = useLocation();
  if (role === "chatter") return <Navigate to={{ pathname: "/shifts/mine", search: location.search, hash: location.hash }} replace />;
  return <Suspense fallback={<Loading />}><Journal /></Suspense>;
}

/** `/shifts/mine` (and every old «Мои смены»): a chatter's own; the owner's and a team lead's is the journal of theirs. */
export function MineEntry() {
  const { role } = useMe();
  const location = useLocation();
  if (role !== "chatter") {
    const search = new URLSearchParams(location.search);
    search.set("mine", "1");
    return <Navigate to={{ pathname: "/shifts", search: `?${search.toString()}`, hash: location.hash }} replace />;
  }
  return <Suspense fallback={<Loading />}><Mine /></Suspense>;
}
