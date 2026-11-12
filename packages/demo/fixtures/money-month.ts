import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { demoError, isDemoReply, queryString, type DemoHandlers, type DemoRequest } from "../core.ts";
import { clockOf, revenueHandlers } from "./money-revenue.ts";

/**
 * Деньги → Месяц (`teamLedgerMonth`): the ledger's month card. Its «Доход страниц» is the demo Hub's own income of
 * the same Moscow month (the custom window Главная counts), so the card reads «равно Главной»; the rest are the
 * shares a ledger card has. Scenarios (`hub-demo-scenario`): `month-unknown` — the ledger could not prove the month;
 * `month-absent` — an older ledger without the read; `month-differs` — the ledger read $12.40 less than Hub;
 * `month-down` — the ledger does not answer; `month-never` — the ledger never computed the month.
 */

type Month = KernelOperationResponse<"teamLedgerMonth">;

const MODELS = [["Mia Hart", 0.78], ["Nova Lane", 0.17], ["Ivy Rose", 0.05]] as const;

function monthDays(month: string): { from: string; to: string } {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** Whole cents in mills: the ledger's money is to the cent. */
const cents = (mills: number) => Math.round(mills / 10) * 10;

function teamLedgerMonth(request: DemoRequest): Month | ReturnType<typeof demoError> {
  if (request.role !== "owner") return demoError(403, "forbidden", "Только владелец");
  const now = clockOf(request);
  const month = queryString(request, "month") ?? now.toISOString().slice(0, 7);
  const days = monthDays(month);
  const serverNow = now.toISOString();
  if (request.scenario === "month-down") return demoError(503, "service_unavailable", "The ledger did not answer GET /v1/payouts/month");
  if (request.scenario === "month-absent") return { month, ...days, served: false, card: null, serverNow };
  if (request.scenario === "month-never") {
    return {
      month, ...days, served: true, serverNow,
      card: {
        status: "unknown", reason: "месяц ещё не считался", asOf: null, computedAt: null,
        pagesNetMills: null, offPlatformMills: null, turnoverMills: null, earnedMills: null, arrivedMills: null,
        ridingMills: null, holdMills: null, stuckMills: null, onPageMills: null, models: [], notes: [],
      },
    };
  }
  const revenue = revenueHandlers.overviewRevenue!({ ...request, query: { period: "custom", from: days.from, to: days.to } });
  const hub = isDemoReply(revenue) ? 0 : revenue.netEarningsMills;
  const pagesNet = cents(hub) - (request.scenario === "month-differs" ? 12_400 : 0);
  const offPlatform = month < now.toISOString().slice(0, 7) ? 410_000 : 150_000;
  const earned = cents(pagesNet * 0.42) + cents(offPlatform * 0.5);
  const arrived = cents(earned * 0.55);
  const riding = cents(earned * 0.2);
  const onPage = cents(earned * 0.15);
  const hold = cents(earned * 0.08);
  const stuck = earned - arrived - riding - onPage - hold;
  const models = MODELS.map(([model, share]) => ({
    model,
    pagesNetMills: cents(pagesNet * share),
    offPlatformMills: model === "Mia Hart" ? offPlatform : 0,
    earnedMills: cents(earned * share),
    arrivedMills: cents(arrived * share),
    ridingMills: cents(riding * share),
  }));
  const unknown = request.scenario === "month-unknown";
  return {
    month, ...days, served: true, serverNow,
    card: {
      status: unknown ? "unknown" : "proven",
      reason: unknown ? "проверка карточки не прошла: сумма выводов не сходится с переводами на $4.20" : null,
      asOf: new Date(now.getTime() - 40 * 60_000).toISOString(),
      computedAt: new Date(now.getTime() - 12 * 60_000).toISOString(),
      pagesNetMills: pagesNet,
      offPlatformMills: offPlatform,
      turnoverMills: pagesNet + offPlatform,
      earnedMills: earned,
      arrivedMills: arrived,
      ridingMills: riding,
      holdMills: hold,
      stuckMills: stuck,
      onPageMills: onPage,
      models,
      notes: ["mia-vip-of: страница без строки в таблице маршрутов, условия не согласованы, в цифру не входит"],
    },
  };
}

export const moneyMonthHandlers: DemoHandlers = { teamLedgerMonth };
