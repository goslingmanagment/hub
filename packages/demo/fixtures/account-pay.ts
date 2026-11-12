import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { demoError, queryString, type DemoReply, type DemoRequest } from "../core.ts";
import { demoUserByRole } from "../world.ts";
import { demoPersonPay } from "./team-ledger.ts";

/**
 * «Мои деньги» (`accountPay`) of the demo chatter: the same book the owner sees in «Выплаты» (team-ledger.ts), the
 * days added up by date and nothing of the journal. The switch is on in the demo; the scenario cookie
 * `hub-demo-scenario=pay-off` turns it off (the screen as before).
 *
 * Invented data only.
 */

type Answer = KernelOperationResponse<"accountPay">;

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function accountPay(request: DemoRequest): Answer | DemoReply {
  const from = queryString(request, "from") ?? "";
  const to = queryString(request, "to") ?? "";
  if (!BUSINESS_DATE.test(from) || !BUSINESS_DATE.test(to) || to < from) return demoError(400, "Bad Request", "from и to — даты YYYY-MM-DD.");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > 62) return demoError(400, "Bad Request", "At most 62 days");
  const serverNow = request.now.toISOString();
  const off: Answer = { enabled: false, from, to, pay: null, serverNow };
  if (request.scenario === "pay-off") return off;
  const user = demoUserByRole(request.role);
  // The day before the window too: a night begun that evening is dated by it.
  const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const pay = demoPersonPay(user.username, dayBefore, to, request.now);
  if (pay === null) return off;
  const byDate = new Map<string, { amount: number; paid: number; unpaid: number }>();
  for (const day of pay.days) {
    const sum = byDate.get(day.date) ?? { amount: 0, paid: 0, unpaid: 0 };
    sum.amount += day.amountMills;
    sum.paid += day.paidMills;
    sum.unpaid += day.unpaidMills;
    byDate.set(day.date, sum);
  }
  return {
    enabled: true,
    from,
    to,
    pay: {
      accruedMills: pay.days.filter((day) => day.date >= from).reduce((sum, day) => sum + day.amountMills, 0),
      paidMills: pay.payouts.filter((payout) => payout.date >= from).reduce((sum, payout) => sum + payout.amountMills, 0),
      balanceMills: pay.balanceMills,
      oldestUnpaidDate: pay.oldestUnpaidDate,
      lastPayout: pay.lastPayout === null ? null : { date: pay.lastPayout.date, amountMills: pay.lastPayout.amountMills },
      days: [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, sum]) => ({
        date,
        amountMills: sum.amount,
        state: sum.unpaid > 0 ? "to_pay" : sum.paid > 0 ? "paid" : "none",
        paidMills: sum.paid,
        unpaidMills: sum.unpaid,
      })),
      reportsFrom: pay.reportsFrom,
      stale: pay.checks.stale,
      generatedAt: pay.generatedAt,
    },
    serverNow,
  };
}
