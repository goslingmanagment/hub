/**
 * Group home-money: Главная and Деньги (design/screens/home-money.md). The routes
 * and what they render.
 */
import { Navigate, Route, useLocation } from "react-router";
import { useAuthMe } from "@/api/queries";
import { OwnerRoute } from "@/components/layout/OwnerRoute";
import { named, Owner } from "./shared.js";

const OverviewPage = named(() => import("@/pages/OverviewPage"), "OverviewPage");
const TransactionsPage = named(() => import("@/pages/money/TransactionsPage"), "TransactionsPage");
const AiCostsPage = named(() => import("@/pages/money/costs/ai/AiCostsPage"), "AiCostsPage");
const ReconciliationPage = named(() => import("@/pages/money/costs/anthropic/ReconciliationPage"), "ReconciliationPage");
const OfapiCostsPage = named(() => import("@/pages/money/costs/onlyfans-api/OfapiCostsPage"), "OfapiCostsPage");

/**
 * «Деньги» opens on «Расходы → ИИ», which is the owner's. A team lead who comes
 * there (by `/money`, or the address itself) lands on his section's home,
 * «Операции», not on a refusal (design/build-rules.md, R0б). The owner's check
 * stays: nothing of the costs is asked for before the role is known.
 */
function CostsHome() {
  const { data } = useAuthMe();
  const location = useLocation();
  if (data && data.user.role !== "owner") return <Navigate to="/money/transactions" replace state={location.state} />;
  return <OwnerRoute><AiCostsPage /></OwnerRoute>;
}

export function homeMoneyRoutes() {
  return (
    <>
      <Route index element={<OverviewPage />} />
      <Route path="money/transactions" element={<TransactionsPage />} />
      <Route path="money/costs/ai" element={<CostsHome />} />
      <Route element={<Owner />}>
        <Route path="money/costs/anthropic" element={<ReconciliationPage />} />
        <Route path="money/costs/onlyfans-api" element={<OfapiCostsPage />} />
      </Route>
    </>
  );
}
