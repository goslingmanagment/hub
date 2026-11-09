import { Navigate, useLocation, useParams } from "react-router";
import { GreetingsTab } from "./GreetingsTab";
import { TABS, type SalesTab } from "./parts";
import { PriceTab } from "./PriceTab";
import { SpeedTab } from "./SpeedTab";
import { WinBackTab } from "./WinBackTab";

/**
 * Что продаёт (spec §4.5): which prices, reply speeds, win-back approaches and
 * greetings work — by page or by chatter. Four tabs, each its own address
 * (`/sales/price|speed|win-back|greetings`); the period, the page filter and the
 * cut travel between them.
 */
export function SalesScreen() {
  const { tab } = useParams();
  const location = useLocation();
  const current = TABS.find((item) => item.tab === tab)?.tab as SalesTab | undefined;
  if (current === undefined) return <Navigate to={{ pathname: "/sales/price", search: location.search }} replace />;
  switch (current) {
    case "price":
      return <PriceTab />;
    case "speed":
      return <SpeedTab />;
    case "win-back":
      return <WinBackTab />;
    case "greetings":
      return <GreetingsTab />;
  }
}
