/**
 * Workboard «Сегодня» and the person's paired shifts (products package W) in the demo: `accountShifts` plays the server
 * — the same three reads paired by the one pairing (contracts own-shift-rows.ts) — and `workboardToday` answers by the
 * role. `hub-demo-scenario`: `today-first` — a team lead's first days (the card «Первый день»); `today-noteam` — a team
 * lead with no team yet; `today-empty` — nothing anywhere (every empty state); `chatter-lead` — the chatter leads «Mia
 * Hart» (shell.ts).
 */
import { comparisonOf, ownShiftsWindow, pairShiftsWithReports, previousReportedMills, type KernelOperationResponse } from "@agency_hub_core/contracts";

import { demoError, isDemoReply, queryNumber, queryString, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_MODELS, demoUserByRole } from "../world.ts";
import { accountHandlers } from "./account.ts";
import { accountReports } from "./account-shift-reports.ts";
import { chatterLeads } from "./shell.ts";
import { shiftReportHandlers } from "./shift-reports.ts";
import { teamWorld } from "./team-world.ts";

type Shifts = KernelOperationResponse<"accountShifts">;
type Today = KernelOperationResponse<"workboardToday">;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const moscowDay = (at: number) => new Date(at + 3 * HOUR_MS).toISOString().slice(0, 10);
const iso = (at: number) => new Date(at).toISOString();

function accountShifts(request: DemoRequest): Shifts {
  const days = queryNumber(request, "days", 7);
  const until = queryString(request, "until");
  const now = request.now.getTime();
  const window = ownShiftsWindow({ days, until, now });
  const ask = (query: Record<string, string>) => ({ ...request, query });
  const stats = accountHandlers.accountChatterStats!(ask({ days: String(days), ...(until ? { until } : {}) }));
  const reports = accountReports(ask({ from: window.reportsFrom, to: window.reportsTo }));
  const previous = accountReports(ask({ from: window.previous.reportsFrom, to: window.previous.reportsTo }));
  const hub = shiftReportHandlers.shiftReportsList!(ask({ from: addDays(window.from, -1), to: window.to }));
  if (isDemoReply(stats)) throw new Error("demo: accountChatterStats refused the window");
  const read = isDemoReply(reports) ? null : reports;
  const postsRead = read?.postsRead ?? true;
  const ongoing = stats.shifts.find((shift) => shift.ongoing)?.startedAt ?? null;
  const cut = comparisonOf(window, now, ongoing);
  return {
    stats,
    window: { from: window.from, to: window.to, startsAt: iso(window.startsAt), endsAt: iso(window.endsAt) },
    reportsRead: read !== null,
    postsRead,
    rows: pairShiftsWithReports({ shifts: stats.shifts, reports: read?.reports ?? null, postsRead, window, hub: isDemoReply(hub) ? null : hub }),
    previous: {
      startsAt: iso(cut.startsAt), endsAt: iso(cut.endsAt), sameTime: cut.sameTime,
      reportedMills: previousReportedMills(isDemoReply(previous) || !previous.postsRead ? null : previous.reports, cut),
    },
    serverNow: request.now.toISOString(),
  };
}

function workboardToday(request: DemoRequest): Today {
  const now = request.now.getTime();
  const empty = request.scenario === "today-empty";
  const user = demoUserByRole(request.role);
  const today = moscowDay(now);
  const tomorrow = addDays(today, 1);
  const own = {
    handover: empty || user.role === "owner" ? [] : [{
      shiftId: 7001,
      person: { userId: 5, name: "Катя" },
      pages: ["mia-1"],
      endedAt: iso(now - 5 * HOUR_MS),
      comment: "Фан из Техаса ждёт видео к выходным, обещала ему ответ до вечера. Новенький на mia-1 спрашивал про скидку, я не обещала.",
    }],
    customsToGive: empty || user.role === "owner" ? [] : [
      { code: "K-14", pageLabel: "mia-1", fanName: "Jake", since: iso(now - 26 * HOUR_MS) },
    ],
  };
  const leads = request.narrow !== true && (user.role === "owner" || user.role === "team_lead" || chatterLeads(request));
  if (!leads) return { ...own, team: null, serverNow: request.now.toISOString() };
  const ledIds = user.role === "owner" ? DEMO_MODELS.map((model) => model.id) : request.scenario === "today-noteam" && user.role === "team_lead" ? [] : [1];
  const teams = DEMO_MODELS.filter((model) => ledIds.includes(model.id)).map((model) => ({
    modelId: model.id,
    name: model.name,
    leadName: model.id === 1 ? "Марта" : null,
    people: model.id === 1 ? 3 : 1,
    onShift: empty || model.id !== 1 ? [] : [{
      userId: 4, name: "Алекс", startedAt: iso(now - 3 * HOUR_MS - 12 * 60_000), endedAt: iso(now), pauses: [{ from: iso(now - 38 * 60_000), to: iso(now) }], pages: ["mia-1", "mia-2"],
    }],
    absent: empty || model.id !== 1 ? [] : [{ userId: 7, name: "Оля", start: "14:00", end: "22:00" }],
    gaps: empty ? [] : model.id === 1 ? [{ day: tomorrow, start: "02:00", end: "10:00" }, { day: addDays(today, 2), start: "22:00", end: "24:00" }] : [],
    noSchedule: empty || model.id !== 1,
  }));
  // Yesterday's closed shifts of the demo team (team-world.ts): their reviews open.
  const yesterday = moscowDay(now - DAY_MS);
  const reviews = empty ? [] : teamWorld(request.now).shifts
    .filter((shift) => !shift.ongoing && moscowDay(shift.startedAt) === yesterday && shift.user.role === "chatter")
    .slice(0, 4)
    .map((shift) => ({
      userId: shift.user.id, name: shift.user.name, startedAt: iso(shift.startedAt), endedAt: iso(shift.endedAt),
      pages: shift.pages.map((page) => page.pageLabel), workedMinutes: shift.workedMinutes,
    }));
  return {
    ...own,
    team: { firstDay: (request.scenario === "today-first" || request.scenario === "today-noteam") && user.role !== "owner", teams, reviews },
    serverNow: request.now.toISOString(),
  };
}

type Newcomers = KernelOperationResponse<"teamNewcomers">;

/** «Команда → Новички»: one newcomer stuck on the extension's sign-in, one in her first week with two shifts. */
function teamNewcomers(request: DemoRequest): Newcomers | ReturnType<typeof demoError> {
  const user = demoUserByRole(request.role);
  const leads = request.narrow !== true && (user.role === "owner" || user.role === "team_lead" || chatterLeads(request));
  if (!leads) return demoError(403, "Forbidden", "«Новички» are the team lead's");
  const now = request.now.getTime();
  if (request.scenario === "today-empty") return { newcomers: [], serverNow: request.now.toISOString() };
  const step = (id: "install" | "extension" | "pages" | "activity" | "payout", doneHoursAgo: number | null) => ({ step: id, done: doneHoursAgo !== null, doneAt: doneHoursAgo === null ? null : iso(now - doneHoursAgo * HOUR_MS) });
  const quality = (reply: number, unanswered: number, ai: number) => ({ replyMedianSeconds: reply, unansweredAtEnd: unanswered, aiUneditedShare: ai });
  return {
    newcomers: [
      {
        code: "nika", name: "Ника", state: "working", teams: ["Mia Hart"],
        start: {
          newcomer: false, signedUp: true, steps: [step("install", 120), step("extension", 119), step("pages", 118), step("activity", 100), step("payout", 90)],
          done: 5, total: 5, current: null, since: null, stuck: false,
          extension: { label: "Firefox · Windows · ChatGoose", signedInAt: iso(now - 119 * HOUR_MS), active: true },
          pages: [{ pageLabel: "mia-3", platform: "fansly", modelName: "Mia Hart" }], firstActivity: { at: iso(now - 100 * HOUR_MS), pageLabel: "mia-3" },
        },
        firstActiveAt: iso(now - 100 * HOUR_MS),
        shifts: [
          { userId: 10, startedAt: iso(now - 98 * HOUR_MS), endedAt: iso(now - 92 * HOUR_MS), ongoing: false, pages: ["mia-3"], workedMinutes: 331, quality: quality(412, 6, 0.12), noted: true },
          { userId: 10, startedAt: iso(now - 50 * HOUR_MS), endedAt: iso(now - 43 * HOUR_MS), ongoing: false, pages: ["mia-3"], workedMinutes: 388, quality: quality(305, 4, 0.2), noted: false },
        ],
        team: { shifts: 31, replyMedianSeconds: 246, unansweredAtEnd: 3.1, aiUneditedShare: 0.3, people: 3 },
      },
      {
        code: "sasha", name: "Саша", state: "set_up", teams: ["Mia Hart"],
        start: {
          newcomer: true, signedUp: true, steps: [step("install", 60), step("extension", null), step("pages", null), step("activity", null), step("payout", null)],
          done: 1, total: 5, current: "extension", since: iso(now - 60 * HOUR_MS), stuck: true, extension: null, pages: [], firstActivity: null,
        },
        firstActiveAt: null, shifts: [], team: null,
      },
    ],
    serverNow: request.now.toISOString(),
  };
}

export const todayHandlers: DemoHandlers = { accountShifts, workboardToday, teamNewcomers };
