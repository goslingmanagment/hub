import {
  listChatterActivityMinutes,
  listConfirmedReports,
  listFansWaitingSince,
  listPageOpenCustoms,
  listShiftDisputes,
  listWinBackResults,
  type PageWaitingRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { shiftsOfMinutes, type ActivityMinute } from "./chatter-shifts.ts";

/**
 * Chat Memory week 5 (docs/plans/2026-10-24-chat-memory/week-5.md §3): the
 * morning report's team block — what waits for the owner. Shifts of the
 * report's business day and how many are confirmed, open disputes, open
 * customs, fans waiting since the night, and win back of the last two weeks.
 * A line shows only when it has something; nothing at all — no block.
 */

const DAY_MS = 86_400_000;
const WAITING_HOURS = 6;
const WAITING_MAX_DAYS = 3;
const WIN_BACK_DAYS = 14;
const DISPUTE_DAYS = 14;

export interface TeamBlockFacts {
  shifts: number;
  confirmed: number;
  disputesOpen: number;
  customsOpen: number;
  oldestCustomPaidAt: Date | null;
  waiting: PageWaitingRow[];
  winBack: { attempts: number; matured72h: number; replied72h: number; matured7d: number; bought7d: number };
}

function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The block's lines (Telegram HTML); empty when there is nothing to say. Pure. */
export function renderTeamBlock(facts: TeamBlockFacts, now: Date): string[] {
  const lines: string[] = [];
  if (facts.shifts > 0) lines.push(`Смены за сутки: ${facts.shifts} · подтверждено ${facts.confirmed}`);
  if (facts.disputesOpen > 0) lines.push(`Споры по продажам: ${facts.disputesOpen} — «Команда → Отчёты смен»`);
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
export async function loadTeamBlockFacts(app: Pick<AppContext, "db">, input: { from: Date; to: Date; now: Date }): Promise<TeamBlockFacts> {
  const minutes = await listChatterActivityMinutes(app.db, { from: new Date(input.from.getTime() - DAY_MS), to: input.now, pages: "all" });
  const people = new Map<number, ActivityMinute[]>();
  for (const minute of minutes) {
    const list = people.get(minute.userId) ?? [];
    list.push({ at: minute.minute.getTime(), pageLabel: minute.pageLabel, input: minute.input });
    people.set(minute.userId, list);
  }
  let shifts = 0;
  let confirmed = 0;
  for (const [userId, list] of people) {
    const dayShifts = shiftsOfMinutes(list, input.now.getTime())
      .filter((shift) => shift.startedAt >= input.from.getTime() && shift.startedAt < input.to.getTime());
    if (dayShifts.length === 0) continue;
    const reports = await listConfirmedReports(app.db, { userId, since: input.from });
    shifts += dayShifts.length;
    confirmed += dayShifts.filter((shift) => reports.some((report) => report.startedAt.getTime() === shift.startedAt)).length;
  }
  const [disputes, customs, waiting, winBack] = await Promise.all([
    listShiftDisputes(app.db, { from: new Date(input.now.getTime() - DISPUTE_DAYS * DAY_MS), to: input.now, pages: "all" }),
    listPageOpenCustoms(app.db, { pageIds: "all", limit: 500 }),
    listFansWaitingSince(app.db, { now: input.now, minWaitHours: WAITING_HOURS, maxDays: WAITING_MAX_DAYS }),
    listWinBackResults(app.db, { from: new Date(input.now.getTime() - WIN_BACK_DAYS * DAY_MS), to: input.now, now: input.now, pages: "all" }),
  ]);
  const paid = customs.map((custom) => custom.paidAt).filter((at): at is Date => at !== null).sort((a, b) => a.getTime() - b.getTime());
  return {
    shifts,
    confirmed,
    disputesOpen: disputes.filter((dispute) => dispute.resolution === null).length,
    customsOpen: customs.length,
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
