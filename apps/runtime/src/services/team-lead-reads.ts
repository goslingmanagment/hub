import type { AuthPrincipal } from "./auth.ts";
import { ForbiddenError } from "./errors.ts";

/**
 * Hub is the owner's (products plan §2.2, decided for the owner): a team lead's place is Workboard. THIS TABLE is every
 * read a dashboard session (`session` and `monitoring` kinds, the owner's and team leads') may call that is the
 * console's alone — no Workboard screen calls it. A team lead is refused each of them before its handler runs
 * (api/server.ts, the policy hook); what Workboard reads stays theirs. tests/team-lead-reads.test.ts recomputes the
 * table from the contract and Workboard's code, so a new console read of those kinds fails it until it is written here.
 * When Workboard takes over a screen (Фаны, Продажи), its reads leave this table in the same PR.
 */
export const CONSOLE_ONLY_READS: ReadonlySet<string> = new Set([
  // Главная and Деньги: the agency's income.
  "overview", "overviewRevenue", "overviewRevenueDaily", "modelRevenueDaily", "pageRevenue", "pageRevenueDaily",
  "crossPageTransactions", "models",
  // The archive's conversations («Фаны» is Workboard's since products package M: its reads left this table).
  "archiveSearch",
  // Система: collection, OnlyFans API, agents' reports, the server's state.
  "syncOverview", "healthSync", "opsLive", "opsMetrics", "reportsList", "reportGet",
  "ofapiCollectionGet", "ofapiMediaGet", "ofapiVaultListsGet", "ofapiTypedExportList", "ofapiTypedExportRows", "ofapiProfileVisitorsGet",
]);

/** The refusal of a console-only read to a team lead; null for anyone else or another operation. */
export function teamLeadRefusal(routeKey: string, principal: AuthPrincipal | null | undefined): ForbiddenError | null {
  if (!principal || principal.kind === "agent" || principal.user.role !== "team_lead" || !CONSOLE_ONLY_READS.has(routeKey)) return null;
  return new ForbiddenError("Это раздел Hub, он у владельца. Ваше рабочее место в Workboard.");
}
