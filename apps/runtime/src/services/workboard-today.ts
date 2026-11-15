import {
  listGoingShifts,
  listPersonDayLineRows,
  listHandoverComments,
  listMatterPageLabels,
  listPersonLoginRows,
  listPersonScheduleSlotRows,
  listUnnotedShiftsOf,
  type PersonScheduleSlotRow,
  type TeamFacts,
  type TodayShiftRow,
} from "@agency_hub_core/db";
import { customOrderCode, type WorkboardTodayResponse } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import { requireSessionUser, type HumanAuthPrincipal } from "./auth.ts";
import { moscowDayOf } from "./chatter-shifts.ts";
import { awaitingGivingOf, waitsSince } from "./custom-orders/readers.ts";
import { ruleSlotsOf } from "./sale-homes.ts";
import { slotRuns, type RuleSlot } from "./sale-rule.ts";
import { pagesOfModels, personOfLogin, teamFactsFor, teamsOfPerson } from "./teams.ts";

/**
 * Workboard «Сегодня» (products plan §2.3, §3; package W): what the day's home shows beyond the person's own shifts
 * (those are `accountShifts`, services/own-shift-rows.ts). Database only, read-only, no money of people.
 *
 * - Everyone: «От прошлой смены» — the comment a colleague left for the next shift on their report, on the person's
 *   pages; the custom orders shot and not given yet on those pages.
 * - A person who leads a team by its records, and the owner (every team of his realm): per team, who is on a shift now
 *   (the shift rows, shift-rows.ts), whom the schedule names now and who is not on a shift, the hours of the next three
 *   days no slot covers (the registry's slots, read as the «whose sale» rule reads them: `slotRuns`); yesterday's
 *   shifts on the teams' pages with no note of a lead. A narrow session (from the extension) leads nothing here.
 */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** A slot that began less than this ago does not yet make a person «не вышел». */
const LATE_AFTER_MS = 15 * MINUTE_MS;
/** The gaps' step and horizon. */
const GAP_STEP_MS = 30 * MINUTE_MS;
const GAP_HORIZON_MS = 3 * DAY_MS;
/** How far back «От прошлой смены» looks. */
const HANDOVER_MS = 36 * HOUR_MS;
/** A lead record this fresh (or none yet) shows the card «Первый день». */
const FIRST_DAY_MS = 3 * DAY_MS;

function clock(at: number): string {
  const minutes = Math.floor((at - Date.parse(`${moscowDayOf(at)}T00:00:00+03:00`)) / MINUTE_MS);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A slot's edge as `HH:MM` (an end of 24:00 stays so). */
function slotClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export interface TodayTeamMember {
  personId: number;
  name: string;
  /** The person's living logins. */
  userIds: number[];
  /** The pages of the team the person works (ids). */
  pageIds: number[];
}

/**
 * Who the schedule names at `now` (their slot on a page of the team began at least 15 minutes ago and still runs) and
 * who is not on a shift: `going` are the logins on a shift now. With the line that runs. Pure.
 */
export function absentNow(input: {
  members: readonly TodayTeamMember[];
  slots: readonly RuleSlot[];
  rows: readonly PersonScheduleSlotRow[];
  going: ReadonlySet<number>;
  now: number;
}): Array<{ member: TodayTeamMember; start: string; end: string }> {
  const absent: Array<{ member: TodayTeamMember; start: string; end: string }> = [];
  for (const member of input.members) {
    if (member.userIds.some((userId) => input.going.has(userId))) continue;
    let found: { start: string; end: string } | null = null;
    for (const userId of member.userIds) {
      for (const pageId of member.pageIds) {
        const runs = (at: number) => slotRuns(input.slots, { personId: userId, pageId, at });
        if (!runs(input.now) || !runs(input.now - LATE_AFTER_MS)) continue;
        // The line that runs, for its clock: the person's lines of the page, else the every-page ones.
        const own = input.rows.filter((row) => row.personId === member.personId);
        const line = [...own.filter((row) => row.pageId === pageId), ...own.filter((row) => row.pageId === null)]
          .find((row) => slotRuns(ruleSlotsOf({ slots: [row], logins: [{ personId: member.personId, userId }], from: new Date(input.now), to: new Date(input.now) }), { personId: userId, pageId, at: input.now }));
        found = { start: line ? slotClock(line.startMinute) : "", end: line ? slotClock(line.endMinute) : "" };
        break;
      }
      if (found !== null) break;
    }
    if (found !== null) absent.push({ member, ...found });
  }
  return absent;
}

/**
 * The hours from `now` over the next three days that no slot of the team covers: stepped by half an hour from the next
 * half hour, a step covered when a member's slot runs on a page of the team in it; uncovered steps joined into ranges
 * and cut at Moscow midnights. Pure.
 */
export function scheduleGaps(input: { members: readonly TodayTeamMember[]; slots: readonly RuleSlot[]; now: number }): Array<{ day: string; start: string; end: string }> {
  const first = Math.ceil(input.now / GAP_STEP_MS) * GAP_STEP_MS;
  const gaps: Array<{ day: string; start: string; end: string }> = [];
  let open: { day: string; from: number } | null = null;
  const close = (at: number) => {
    if (open === null) return;
    const ends = clock(at);
    gaps.push({ day: open.day, start: clock(open.from), end: ends === "00:00" ? "24:00" : ends });
    open = null;
  };
  for (let at = first; at < first + GAP_HORIZON_MS; at += GAP_STEP_MS) {
    const day = moscowDayOf(at);
    if (open !== null && open.day !== day) close(at);
    // Covered: in the middle of the step, any member on any page of the team they work.
    const middle = at + GAP_STEP_MS / 2;
    const covered = input.members.some((member) => member.userIds.some((userId) => member.pageIds.some((pageId) => slotRuns(input.slots, { personId: userId, pageId, at: middle }))));
    if (covered) close(at);
    else if (open === null) open = { day, from: at };
  }
  close(first + GAP_HORIZON_MS);
  return gaps;
}

/** The members of a team: the people (not left) working a page of the model, with their logins. */
function membersOf(facts: TeamFacts, modelId: number): TodayTeamMember[] {
  const pages = new Set(pagesOfModels(facts, [modelId]));
  const byPerson = new Map<number, Set<number>>();
  for (const row of facts.working) {
    if (!pages.has(row.pageId)) continue;
    byPerson.set(row.personId, (byPerson.get(row.personId) ?? new Set()).add(row.pageId));
  }
  return [...byPerson.entries()].map(([personId, pageIds]) => ({
    personId,
    name: facts.people.find((person) => person.personId === personId)?.name ?? "",
    userIds: facts.logins.filter((login) => login.personId === personId).map((login) => login.userId),
    pageIds: [...pageIds],
  })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/** A login's name: its person's, else the login itself. */
function nameOfLogin(facts: TeamFacts, userId: number, username: string): string {
  const personId = personOfLogin(facts, userId);
  return (personId === null ? null : facts.people.find((person) => person.personId === personId)?.name) ?? username;
}

const touches = (row: TodayShiftRow, labels: ReadonlySet<string>) => row.pageLabels.some((label) => labels.has(label));

type TodayApp = Pick<AppContext, "db">;

export async function readWorkboardToday(app: TodayApp, principal: HumanAuthPrincipal, now: Date = new Date()): Promise<WorkboardTodayResponse> {
  requireSessionUser(principal);
  const at = now.getTime();
  const facts = await teamFactsFor(app, principal);
  const personId = personOfLogin(facts, principal.user.id);
  const ownLogins = personId === null ? [principal.user.id] : facts.logins.filter((login) => login.personId === personId).map((login) => login.userId);
  const labels = await listMatterPageLabels(app.db);
  const labelsOfIds = (pageIds: readonly number[]) => new Set(pageIds.map((id) => labels.labelOf.get(id)).filter((label): label is string => label !== undefined));

  // The person's own part: the pages their login works.
  const myLabels = labelsOfIds(principal.assignedPageIds);
  const [handover, orders] = await Promise.all([
    myLabels.size === 0 ? Promise.resolve([]) : listHandoverComments(app.db, { since: new Date(at - HANDOVER_MS), exceptUserIds: ownLogins, limit: 20 }),
    principal.assignedPageIds.length === 0 ? Promise.resolve([]) : awaitingGivingOf(app, { pageIds: principal.assignedPageIds, limit: 200 }),
  ]);

  return {
    handover: handover.filter((row) => touches(row.shift, myLabels)).slice(0, 5).map((row) => ({
      shiftId: row.shift.id,
      person: { userId: row.shift.userId, name: nameOfLogin(facts, row.shift.userId, row.shift.username) },
      pages: row.shift.pageLabels.filter((label) => myLabels.has(label)),
      endedAt: row.shift.endedAt.toISOString(),
      comment: row.comment.trim(),
    })),
    customsToGive: orders.filter((order) => order.state === "shot").map((order) => ({
      code: customOrderCode(order.id),
      pageLabel: order.pageLabel,
      fanName: order.fanDisplayName ?? order.fanUsername ?? order.buyer,
      since: waitsSince(order).toISOString(),
    })),
    team: await teamPart(app, principal, facts, { personId, ownLogins, labelsOfIds, now: at }),
    serverNow: now.toISOString(),
  };
}

async function teamPart(
  app: TodayApp,
  principal: HumanAuthPrincipal,
  facts: TeamFacts,
  input: { personId: number | null; ownLogins: readonly number[]; labelsOfIds: (pageIds: readonly number[]) => Set<string>; now: number },
): Promise<WorkboardTodayResponse["team"]> {
  if (principal.narrowDeviceTokenId !== undefined) return null;
  const owner = principal.user.role === "owner";
  const test = principal.sandbox?.test === true;
  const records = facts.roles.filter((role) => role.personId === input.personId && role.kind === "lead");
  const realm = new Set(facts.models.filter((model) => model.test === test).map((model) => model.modelId));
  const led = owner ? [...realm] : teamsOfPerson(facts, input.personId).lead.filter((modelId) => realm.has(modelId));
  // A login of a team lead with no team yet sees the first-day card with «Вам пока не назначили команду»; a chatter who
  // leads nothing has no team part at all.
  if (led.length === 0 && principal.user.role !== "team_lead" && !owner) return null;
  const firstDay = !owner && (records.length === 0 || records.every((role) => input.now - role.grantedAt.getTime() < FIRST_DAY_MS));

  const yesterday = moscowDayOf(input.now - DAY_MS);
  // Who is scheduled on a day is the standing lines and the approved swaps' one-day lines of those days (0420); «Графика
  // нет» is about the standing lines alone.
  const [going, unnoted, slotRows, dayRows, logins] = await Promise.all([
    listGoingShifts(app.db),
    listUnnotedShiftsOf(app.db, yesterday),
    listPersonScheduleSlotRows(app.db),
    listPersonDayLineRows(app.db, { from: yesterday, to: moscowDayOf(input.now + 4 * DAY_MS) }),
    listPersonLoginRows(app.db),
  ]);
  const scheduled = [...slotRows, ...dayRows];
  const slots = ruleSlotsOf({ slots: scheduled, logins, from: new Date(input.now - DAY_MS), to: new Date(input.now + 4 * DAY_MS) });
  const goingLogins = new Set(going.map((row) => row.userId));

  const models = facts.models.filter((model) => led.includes(model.modelId)).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const teams = models.map((model) => {
    const pageLabels = input.labelsOfIds(pagesOfModels(facts, [model.modelId]));
    const members = membersOf(facts, model.modelId);
    const memberIds = new Set(members.map((member) => member.personId));
    const lead = facts.roles.find((role) => role.modelId === model.modelId && role.kind === "lead");
    return {
      modelId: model.modelId,
      name: model.name,
      leadName: lead === undefined ? null : facts.people.find((person) => person.personId === lead.personId)?.name ?? null,
      people: members.length,
      onShift: going.filter((row) => touches(row, pageLabels)).map((row) => ({
        userId: row.userId,
        name: nameOfLogin(facts, row.userId, row.username),
        startedAt: row.startedAt.toISOString(),
        pages: row.pageLabels.filter((label) => pageLabels.has(label)),
      })),
      absent: absentNow({ members, slots, rows: scheduled, going: goingLogins, now: input.now }).map(({ member, start, end }) => ({
        userId: member.userIds[0] ?? 0,
        name: member.name,
        start,
        end,
      })),
      gaps: scheduleGaps({ members, slots, now: input.now }),
      noSchedule: !slotRows.some((row) => memberIds.has(row.personId)),
    };
  });

  const teamLabels = input.labelsOfIds(pagesOfModels(facts, led));
  const own = new Set(input.ownLogins);
  const reviews = unnoted.filter((row) => !own.has(row.userId) && touches(row, teamLabels)).map((row) => ({
    userId: row.userId,
    name: nameOfLogin(facts, row.userId, row.username),
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    pages: row.pageLabels.filter((label) => teamLabels.has(label)),
    workedMinutes: row.workedMinutes,
  }));

  return { firstDay, teams, reviews };
}
