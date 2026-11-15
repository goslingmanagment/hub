import { Navigate, useLocation } from "react-router";
import { useMe } from "@/shared/useMe";
import { MassMessagesTab } from "./MassMessagesTab";
import { WinBackTab } from "./WinBackTab";

/**
 * The tabs of «Продажи» that are the team's, not a chatter's (routes.tsx `teamScreens`): «Возврат фанов» (the owner's
 * approaches and their write) and «Рассылки» (the owner's alone: anyone else opens the first tab).
 */
export function WinBackScreen() {
  return <WinBackTab />;
}

export function MassScreen() {
  const { isOwner } = useMe();
  const location = useLocation();
  if (!isOwner) return <Navigate to={{ pathname: "/sales/price", search: location.search }} replace />;
  return <MassMessagesTab />;
}
