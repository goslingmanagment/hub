import { Navigate, useLocation, useParams } from "react-router";
import { GreetingsTab } from "./GreetingsTab";
import { ListTab } from "./ListTab";
import { TABS, type SalesTab } from "./parts";
import { PriceTab } from "./PriceTab";
import { SpeedTab } from "./SpeedTab";

/**
 * Продажи (it was «Что продаёт», spec §4.5; products plan §2.3): which prices and reply speeds work — by page or by
 * chatter — and the list of every sale with whose it is, every role's. Each tab its own address
 * (`/sales/price|speed|list`, the sleeping `greetings` still opens); the period, the page filter and the cut travel
 * between them. The team's own tabs, «Рассылки» and «Возврат фанов», are their own route (`team.tsx`): a chatter's
 * session never reaches their operations.
 */
export function SalesScreen() {
  const { tab } = useParams();
  const location = useLocation();
  const current = TABS.find((item) => item.tab === tab && !("team" in item))?.tab as SalesTab | undefined;
  if (current === undefined) return <Navigate to={{ pathname: "/sales/price", search: location.search }} replace />;
  switch (current) {
    case "price":
      return <PriceTab />;
    case "speed":
      return <SpeedTab />;
    case "greetings":
      return <GreetingsTab />;
    case "list":
      return <ListTab />;
    default:
      return <Navigate to={{ pathname: "/sales/price", search: location.search }} replace />;
  }
}
