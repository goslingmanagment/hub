import { useQuery } from "@tanstack/react-query";
import { kernel } from "./hub.js";

export type Role = "owner" | "team_lead" | "chatter";

/**
 * Who a screen or a menu item is for (app/routes.tsx, app/Shell.tsx). The
 * team's part of Workboard is the owner's and the team leads'; a chatter has a
 * part of their own (owner, 2026-11-10): their own shifts and reports, sales only.
 * Hub refuses a chatter every team read anyway.
 */
export const TEAM: readonly Role[] = ["owner", "team_lead"];
export const OWNER: readonly Role[] = ["owner"];
export const CHATTER: readonly Role[] = ["chatter"];

/** Where Workboard opens: «Сегодня», every role's home (products plan §2.3); the role changes what is in it. */
export function homePath(_role?: Role | null): string {
  return "/today";
}

/** Who is signed in (`me`). A 401 sends to the console's sign-in by itself (hub.ts). */
export function useMe() {
  const query = useQuery({
    queryKey: ["me"],
    queryFn: () => kernel.me(),
    staleTime: 5 * 60_000,
  });
  const user = query.data?.user;
  // A narrow session (opened from the extension) opens the chatter's part alone, whatever the
  // person's role: Hub refuses it every team and owner read, so the screens and the menu follow.
  const narrow = query.data?.narrow === true;
  return {
    ...query,
    user,
    role: (narrow ? "chatter" : user?.role ?? null) as Role | null,
    /** The person's own role, for what the menu says about them. */
    accountRole: (user?.role ?? null) as Role | null,
    narrow,
    /** The owner: Доступ and the money are theirs only (Hub checks it too). */
    isOwner: !narrow && user?.role === "owner",
    /** The agency's owner, not the test team's: accounts, AI spend and agents' proposals are read by him alone (Hub
     *  refuses the test owner them, so the screens leave those blocks out, as for a team lead). */
    fullOwner: !narrow && user?.role === "owner" && query.data?.test !== true,
    /** The person's teams by model id (products package T): in, given «видит», leading; null — the owner, or not read. */
    teams: query.data?.teams ?? null,
    /**
     * Opens «Команда» (products plan §2.3): the owner, a team lead, or a chatter who leads a team by its records (package
     * T: authority comes from the records, so a chatter with one leads that team and stays a chatter). Never a narrow session.
     */
    leadsTeam: !narrow && (user?.role === "owner" || user?.role === "team_lead" || (query.data?.teams?.lead.length ?? 0) > 0),
  };
}
