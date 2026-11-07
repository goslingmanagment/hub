import { useQuery } from "@tanstack/react-query";
import { kernel } from "./hub.js";

export type Role = "owner" | "team_lead" | "chatter";

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
