/**
 * Group home-money: Главная and Деньги (design/screens/home-money.md). The routes
 * and what they render.
 */
import { Navigate, Route, useLocation } from "react-router";
import { useAuthMe } from "@/api/queries";
import type { LegacyRule } from "@/lib/redirects";
import { Legacy } from "../legacy.js";
import { named, Owner } from "./shared.js";

const OverviewPage = named(() => import("@/pages/OverviewPage"), "OverviewPage");
const TransactionsPage = named(() => import("@/pages/money/TransactionsPage"), "TransactionsPage");
const AiCostsPage = named(() => import("@/pages/money/costs/ai/AiCostsPage"), "AiCostsPage");
const ReconciliationPage = named(() => import("@/pages/money/costs/anthropic/ReconciliationPage"), "ReconciliationPage");
const OfapiCostsPage = named(() => import("@/pages/money/costs/onlyfans-api/OfapiCostsPage"), "OfapiCostsPage");

/**
 * `/money`, the section's address, by role (design/build-rules.md, R0б). The
 * owner goes where the redirect table says («Расходы → ИИ»); a team lead, who
 * has no «Расходы», lands on his section's home, «Операции», not on a refusal.
 * The screens themselves keep their checks: a team lead who types
 * `/money/costs/…` is told «Нет доступа», and nothing of the costs is asked for.
 * ProtectedLayout renders this only once the role is known.
 */
export function MoneyIndex({ rule }: { rule: LegacyRule }) {
  const { data } = useAuthMe();
  const location = useLocation();
  if (data && data.user.role !== "owner") {
    return <Navigate to={{ pathname: "/money/transactions", search: location.search, hash: location.hash }} state={location.state} replace />;
  }
  return <Legacy rule={rule} />;
}

export function homeMoneyRoutes() {
  return (
    <>
      <Route index element={<OverviewPage />} />
      <Route path="money/transactions" element={<TransactionsPage />} />
      <Route element={<Owner />}>
        <Route path="money/costs/ai" element={<AiCostsPage />} />
        <Route path="money/costs/anthropic" element={<ReconciliationPage />} />
        <Route path="money/costs/onlyfans-api" element={<OfapiCostsPage />} />
      </Route>
    </>
  );
}
