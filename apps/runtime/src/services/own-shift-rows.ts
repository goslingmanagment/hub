import type { AccountShiftsQuery, AccountShiftsResponse } from "@agency_hub_core/contracts";
import { comparisonOf, ownShiftsWindow, pairShiftsWithReports, previousReportedMills } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import { requireSessionUser, type HumanAuthPrincipal } from "./auth.ts";
import { readAccountChatterStats } from "./chatter-stats.ts";
import { readAccountReports } from "./ledger-reports.ts";
import { handinActorOf, listShiftReports } from "./shift-handins.ts";

/**
 * A person's own shifts with their reports (products package W, `accountShifts`): «Мои смены» and «Сегодня» read the
 * rows paired here, by the one pairing (contracts own-shift-rows.ts); no screen pairs them again. Three sources, read
 * for the caller only: Hub's shifts (`accountChatterStats`, the sales by the rule), the ledger's reports (the post in
 * «Отчётность», the agent's draft), the reports handed in in Hub (`shiftReportsList`, behind the person's switch).
 * Sales only, no pay.
 */

const DAY_MS = 86_400_000;

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────── The read

type OwnShiftsApp = AppContext;

/** `accountShifts`: the caller's own shifts of the window with their reports. Any cookie session, the narrow one too. */
export async function readAccountShifts(app: OwnShiftsApp, principal: HumanAuthPrincipal, query: AccountShiftsQuery, now: Date = new Date()): Promise<AccountShiftsResponse> {
  requireSessionUser(principal);
  const window = ownShiftsWindow({ days: query.days, until: query.until, now: now.getTime() });
  const [stats, reports, previousReports, hub] = await Promise.allSettled([
    readAccountChatterStats(app, principal, { days: query.days, until: query.until }),
    readAccountReports(app, principal, { from: window.reportsFrom, to: window.reportsTo }, { now }),
    readAccountReports(app, principal, { from: window.previous.reportsFrom, to: window.previous.reportsTo }, { now }),
    listShiftReports(app, handinActorOf(principal), { from: addDays(window.from, -1), to: window.to }, now),
  ]);
  // Hub not answering fails the read; the ledger not answering leaves the shifts alone.
  if (stats.status === "rejected") throw stats.reason;
  const read = reports.status === "fulfilled" ? reports.value : null;
  const postsRead = read?.postsRead ?? true;
  const rows = pairShiftsWithReports({
    shifts: stats.value.shifts,
    reports: read?.reports ?? null,
    postsRead,
    window,
    hub: hub.status === "fulfilled" ? hub.value : null,
  });
  const ongoing = stats.value.shifts.find((shift) => shift.ongoing)?.startedAt ?? null;
  const comparison = comparisonOf(window, now.getTime(), ongoing);
  const before = previousReports.status === "fulfilled" && previousReports.value.postsRead ? previousReports.value.reports : null;
  return {
    stats: stats.value,
    window: { from: window.from, to: window.to, startsAt: new Date(window.startsAt).toISOString(), endsAt: new Date(window.endsAt).toISOString() },
    reportsRead: read !== null,
    postsRead,
    rows,
    previous: {
      startsAt: new Date(comparison.startsAt).toISOString(),
      endsAt: new Date(comparison.endsAt).toISOString(),
      sameTime: comparison.sameTime,
      reportedMills: previousReportedMills(before, comparison),
    },
    serverNow: now.toISOString(),
  };
}
