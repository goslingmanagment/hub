import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { millsFromCents, millsPercentOf, millsToNumber, millsToWholeCents } from "@agency_hub_core/shared";

import { demoError, isDemoReply, queryString, type DemoHandlers, type DemoRequest } from "../core.ts";
import { clockOf, revenueHandlers } from "./money-revenue.ts";

/**
 * Деньги → Месяц (`teamLedgerMonth`): the ledger's month card. The demo ledger took Hub's facts 40 minutes ago (its
 * cut, `asOf`): its «Доход страниц» is the demo Hub's own income of the same Moscow month up to that moment, so a
 * month that goes on reads «равно Главной на …» while Главная has grown since, and a month that is over reads «равно
 * Главной»; the rest are the shares a ledger card has. Scenarios (`hub-demo-scenario`): `month-unknown` — the ledger
 * could not prove the month; `month-absent` — an older ledger without the read; `month-differs` — the ledger read
 * $12.40 less than Hub had by the cut; `month-down` — the ledger does not answer; `month-never` — the ledger never
 * computed the month.
 */

type Month = KernelOperationResponse<"teamLedgerMonth">;

const MODELS = [["Mia Hart", 78], ["Nova Lane", 17], ["Ivy Rose", 5]] as const;

function monthDays(month: string): { from: string; to: string } {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** A whole percent of an amount, in whole cents: the ledger's money is to the cent. */
const part = (mills: number, percent: number) => millsToNumber(millsFromCents(millsToWholeCents(millsPercentOf(mills, percent))));

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
  // What the ledger read from Hub: the month's income up to its cut. The read's end is exclusive (the next month's first day).
  const asOf = new Date(now.getTime() - 40 * 60_000);
  const [year, number] = month.split("-").map(Number) as [number, number];
  const nextMonth = new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
  const revenue = revenueHandlers.overviewRevenue!({
    ...request, query: { period: "custom", from: days.from, to: `${nextMonth}-01`, until: asOf.toISOString() },
  });
  const hub = isDemoReply(revenue) ? 0 : revenue.netEarningsMills;
  const pagesNet = part(hub, 100) - (request.scenario === "month-differs" ? 12_400 : 0);
  const offPlatform = month < now.toISOString().slice(0, 7) ? 410_000 : 150_000;
  const earned = part(pagesNet, 42) + part(offPlatform, 50);
  const arrived = part(earned, 55);
  const riding = part(earned, 20);
  const onPage = part(earned, 15);
  const hold = part(earned, 8);
  const stuck = earned - arrived - riding - onPage - hold;
  const models = MODELS.map(([model, share]) => ({
    model,
    pagesNetMills: part(pagesNet, share),
    offPlatformMills: model === "Mia Hart" ? offPlatform : 0,
    earnedMills: part(earned, share),
    arrivedMills: part(arrived, share),
    ridingMills: part(riding, share),
  }));
  const unknown = request.scenario === "month-unknown";
  return {
    month, ...days, served: true, serverNow,
    card: {
      status: unknown ? "unknown" : "proven",
      reason: unknown ? "проверка карточки не прошла: сумма выводов не сходится с переводами на $4.20" : null,
      asOf: asOf.toISOString(),
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
