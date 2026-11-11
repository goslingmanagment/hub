import type { DemoHandlers } from "../core.ts";
import { creatorStatsHandlers } from "./money-creator-stats.ts";
import { insightsHandlers } from "./money-insights.ts";
import { moneyBudgetsHandlers } from "./money-budgets.ts";
import { revenueHandlers } from "./money-revenue.ts";

/** Demo answers of this area's screens (see demo/core.ts): Overview, the
 *  operations list, «Бюджеты», «Статистика» and «Аналитика». */
export const moneyHandlers: DemoHandlers = {
  ...revenueHandlers,
  ...creatorStatsHandlers,
  ...insightsHandlers,
  // Деньги → Бюджеты: the invented agency's months from its ledger (money-budgets.ts).
  ...moneyBudgetsHandlers,
};
