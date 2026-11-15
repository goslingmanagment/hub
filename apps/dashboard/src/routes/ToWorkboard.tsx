import { useLayoutEffect } from "react";
import { useLocation } from "react-router";
import { workboardHere } from "@/lib/navigation";
import { teamToWorkboard, WORKBOARD_HREF } from "@/lib/workboard";

/**
 * Leaves the console for Workboard: `location.replace`, so the old address is
 * not in the history and «Назад» goes to where the owner came from. Only
 * navigates; Workboard checks the sign-in and the rights itself.
 */
export function LeaveForWorkboard({ href }: { href: string }) {
  useLayoutEffect(() => {
    window.location.replace(href);
  }, [href]);
  return <div role="status" className="flex items-center justify-center h-full py-20 text-text-muted">Открываем Workboard…</div>;
}

/** An old address of «Команда» (`/team/*`, `/held-sends`): its Workboard screen (lib/workboard.ts), on the team's name. */
export function ToWorkboard() {
  const { pathname, search, hash } = useLocation();
  return <LeaveForWorkboard href={workboardHere(teamToWorkboard(`${pathname}${search}${hash}`) ?? WORKBOARD_HREF)} />;
}
