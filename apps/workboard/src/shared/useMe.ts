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

/** Where Workboard opens for a role: a chatter's «Мои смены», the team's Смены. */
export function homePath(role: Role | null): string {
  return role === "chatter" ? "/my/shifts" : "/shifts";
}

/** Who is signed in (`me`). A 401 sends to the console's sign-in by itself (hub.ts). */
export function useMe() {
  const query = useQuery({
    queryKey: ["me"],
    queryFn: () => kernel.me(),
    staleTime: 5 * 60_000,
  });
  const user = query.data?.user;
  return {
    ...query,
    user,
    role: (user?.role ?? null) as Role | null,
    /** The owner: Доступ, disputes and the shift review are theirs only (Hub checks it too). */
    isOwner: user?.role === "owner",
  };
}
