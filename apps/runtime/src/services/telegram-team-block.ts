import {
  listFansWaitingSince,
  listFirstChatterActivities,
  listPageOpenCustoms,
  listShiftSales,
  listWinBackResults,
  type PageWaitingRow,
} from "@agency_hub_core/db";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { dayOfShift, moscowDayOf, netOf, readPeopleWork } from "./chatter-shifts.ts";
import { awaitingGivingOf, customOrdersReadOn, waitsSince } from "./custom-orders/readers.ts";
import { LOGINS_ALONE, homeCredit, openWindowFrom, readScreenHomes, readScreensRule, ruledSale, ruledWork } from "./sale-rule-screens.ts";
import { reportDateOfShift } from "./shift-rows.ts";

/**
 * Chat Memory week 5 (docs/plans/2026-10-24-chat-memory/week-5.md §3): the
 * morning report's team block — what waits for the owner. Shifts of the
 * report's business day, open customs, fans waiting since the night, and win
 * back of the last two weeks. A line shows only when it has something; nothing
 * at all — no block. (Hub's own marks and their disputes are gone: what a shift
 * pays is the chatter's posted report, which the agency ledger reads.)
 *
 * From the screens' switch on (sale-rule-screens.ts) a shift of a report date of
 * the switch's day or later is counted on its report date, and the day's sales
 * whose home is the owner's to decide (several shifts held one, none of their
 * people wrote last, no slot settles it) are a line of their own.
 */

const DAY_MS = 86_400_000;
const WAITING_HOURS = 6;
const WAITING_MAX_DAYS = 3;
const WIN_BACK_DAYS = 14;

export interface TeamBlockFacts {
  shifts: number;
  /** Customs paid and not delivered yet (an ordered, unpaid one waits for the fan, not the team). */
  customsOpen: number;
  oldestCustomPaidAt: Date | null;
  waiting: PageWaitingRow[];
  winBack: { attempts: number; matured72h: number; replied72h: number; matured7d: number; bought7d: number };
  /** With the screens' switch on: the day's sales that wait for the owner's decision whose they are. */
  decide?: { sales: number; netMills: number };
}

function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The block's lines (Telegram HTML); empty when there is nothing to say. Pure. */
export function renderTeamBlock(facts: TeamBlockFacts, now: Date): string[] {
  const lines: string[] = [];
  if (facts.shifts > 0) lines.push(`Смены за сутки: ${facts.shifts}`);
  if (facts.decide !== undefined && facts.decide.sales > 0) {
    lines.push(`Ждут вашего решения, чья продажа: ${facts.decide.sales} на ${formatUsdFromMills(facts.decide.netMills)}`);
  }
  if (facts.customsOpen > 0) {
    const oldest = facts.oldestCustomPaidAt === null ? "" : ` · самый старый оплачен ${Math.floor((now.getTime() - facts.oldestCustomPaidAt.getTime()) / DAY_MS)} дн назад`;
    lines.push(`Кастомы не отданы: ${facts.customsOpen}${oldest}`);
  }
  const waiting = facts.waiting.reduce((sum, page) => sum + page.waiting, 0);
  if (waiting > 0) {
    const payers = facts.waiting.reduce((sum, page) => sum + page.payers, 0);
    const pages = facts.waiting.slice(0, 4).map((page) => `${escapeHtml(page.pageLabel)} ${page.waiting}`).join(", ");
    lines.push(`Ждут ответа ${WAITING_HOURS}+ ч: ${waiting} (платили ${payers}) · ${pages}`);
  }
  const winBack = facts.winBack;
  if (winBack.attempts > 0) {
    lines.push(`Вернуть, ${WIN_BACK_DAYS} дн: ${winBack.attempts} попыток · ответили ${winBack.replied72h} из ${winBack.matured72h} · `
      + `купили ${winBack.bought7d} из ${winBack.matured7d}`);
  }
  return lines.length === 0 ? [] : ["👥 <b>Команда</b>", ...lines];
}

/** The facts of the block for the business day [from, to), as of `now`. */
export async function loadTeamBlockFacts(app: Pick<AppContext, "db"> & Partial<Pick<AppContext, "config">>, input: { from: Date; to: Date; now: Date }): Promise<TeamBlockFacts> {
  const [people, firstActivity, rule] = await Promise.all([
    readPeopleWork(app.db, { from: new Date(input.from.getTime() - DAY_MS), to: input.now, now: input.now, pages: "all" }),
    listFirstChatterActivities(app.db),
    readScreensRule(app.db),
  ]);
  // The shifts of the day as every other screen dates them (`dayOfShift`; by the rule, the report date).
  const firstDay = moscowDayOf(input.from.getTime());
  const lastDay = moscowDayOf(input.to.getTime() - 1);
  let shifts = 0;
  for (const [userId, person] of people) {
    shifts += person.work.filter((shift) => {
      if (shift.kind !== "shift") return false;
      const day = ruledWork(rule, shift) ? reportDateOfShift(shift) : dayOfShift(shift, firstActivity.get(userId)?.getTime());
      return day >= firstDay && day <= lastDay;
    }).length;
  }
  let decide: TeamBlockFacts["decide"];
  if (rule !== null) {
    const sales = (await listShiftSales(app.db, { pageIds: "all", from: input.from, to: input.to })).filter((sale) => ruledSale(rule, sale));
    const homes = await readScreenHomes(app.db, {
      sales, openFrom: openWindowFrom(input.now, [...people.values()].flatMap((person) => person.work)), now: input.now, live: rule.live,
    });
    // Whom a home credits is the one function's (`homeCredit`), with no screens' cut on purpose: a sale waiting for the
    // owner's decision waits whatever a screen's old count shows (the ledger reads the home, not the screen), so no old
    // shift's count and no work is asked — only the line of what no person takes.
    const waiting = sales.flatMap((sale) => {
      const home = homes.get(sale.transactionId);
      const outside = home === undefined ? null : homeCredit({ home, sale, pieces: new Map(), logins: LOGINS_ALONE }).outside;
      return outside?.line === "decide" ? [{ ...sale, netMills: outside.mills }] : [];
    });
    decide = { sales: waiting.length, netMills: netOf(waiting) };
  }
  const [customs, waiting, winBack] = await Promise.all([
    listPageOpenCustoms(app.db, { pageIds: "all", limit: 500 }),
    listFansWaitingSince(app.db, { now: input.now, minWaitHours: WAITING_HOURS, maxDays: WAITING_MAX_DAYS }),
    listWinBackResults(app.db, { from: new Date(input.now.getTime() - WIN_BACK_DAYS * DAY_MS), to: input.now, now: input.now, pages: "all" }),
  ]);
  let paidOpen = customs.filter((custom) => custom.state === "paid").length;
  let paid = customs.filter((custom) => custom.state === "paid").map((custom) => custom.paidAt).filter((at): at is Date => at !== null);
  // Package I: behind the owner's setting, the custom orders paid or shot and not given; off — the old table.
  if (await customOrdersReadOn(app)) {
    const orders = await awaitingGivingOf(app, { pageIds: "all", limit: 500 });
    paidOpen = orders.length;
    paid = orders.map(waitsSince);
  }
  paid.sort((a, b) => a.getTime() - b.getTime());
  return {
    shifts,
    ...(decide === undefined ? {} : { decide }),
    customsOpen: paidOpen,
    oldestCustomPaidAt: paid[0] ?? null,
    waiting,
    winBack: {
      attempts: winBack.reduce((sum, row) => sum + row.attempts, 0),
      matured72h: winBack.reduce((sum, row) => sum + row.matured72h, 0),
      replied72h: winBack.reduce((sum, row) => sum + row.replied72h, 0),
      matured7d: winBack.reduce((sum, row) => sum + row.matured7d, 0),
      bought7d: winBack.reduce((sum, row) => sum + row.bought7d, 0),
    },
  };
}
