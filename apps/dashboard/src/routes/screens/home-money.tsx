/**
 * Group home-money: Главная and Деньги (design/screens/home-money.md). The routes
 * and what they render until each screen is rebuilt.
 */
import { Route, useSearchParams } from "react-router";
import { Segmented } from "@/components/ui/Segmented";
import { named, OfapiOffNotice, Owner } from "./shared.js";

const OverviewPage = named(() => import("@/pages/OverviewPage"), "OverviewPage");
const TransactionsPage = named(() => import("@/pages/TransactionsPage"), "TransactionsPage");
const UsagePage = named(() => import("@/pages/UsagePage"), "UsagePage");
const AiSpendPage = named(() => import("@/pages/AiSpendPage"), "AiSpendPage");
const AiReconciliationSection = named(() => import("@/pages/AiReconciliationSection"), "AiReconciliationSection");
const OfapiCreditsPage = named(() => import("@/pages/OfapiCreditsPage"), "OfapiCreditsPage");

/** «ИИ» of the costs, until its two old screens become one: both, a click apart. */
function AiCostsScreen() {
  const [search, setSearch] = useSearchParams();
  const view = search.get("view") === "people" ? "people" : "spend";
  return (
    <div className="space-y-6">
      <Segmented
        label="Что показать"
        value={view}
        onChange={(next) => {
          const query = new URLSearchParams(search);
          if (next === "people") query.set("view", next);
          else query.delete("view");
          setSearch(query);
        }}
        options={[
          { value: "spend", label: "На что ушло" },
          { value: "people", label: "Счета и сотрудники" },
        ]}
      />
      {view === "spend" ? <AiSpendPage /> : <UsagePage />}
    </div>
  );
}

function OnlyFansApiCostsScreen() {
  return (
    <div className="space-y-6">
      <OfapiOffNotice>Суммы и кредиты здесь — по 1 ноября.</OfapiOffNotice>
      <OfapiCreditsPage />
    </div>
  );
}

export function homeMoneyRoutes() {
  return (
    <>
      <Route index element={<OverviewPage />} />
      <Route path="money/transactions" element={<TransactionsPage />} />
      <Route element={<Owner />}>
        <Route path="money/costs/ai" element={<AiCostsScreen />} />
        <Route path="money/costs/anthropic" element={<AiReconciliationSection />} />
        <Route path="money/costs/onlyfans-api" element={<OnlyFansApiCostsScreen />} />
      </Route>
    </>
  );
}
