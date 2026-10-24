import {
  CHATTER_SHIFT_END_IDLE_MINUTES,
  CHATTER_SHIFT_IDLE_PAUSE_MINUTES,
  CHATTER_SHIFTS_MAX_WINDOW_DAYS,
  CLIENT_ACTIVITY_LOST_MINUTES,
  type ClientActivityBody,
  type ClientActivityResponse,
  type TeamShift,
  type TeamShiftsQuery,
  type TeamShiftsResponse,
} from "@agency_hub_core/contracts";
import {
  countAuthoredSendsByMinute,
  findPageSummaryByLabel,
  listChatterActivityMinutes,
  recordChatterActivityBeat,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, requireApiKeyUser, requireDashboardUser, type AuthPrincipal, type HumanAuthPrincipal } from "./auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.ts";

/**
 * Chat Memory week 1 (docs/plans/2026-10-24-chat-memory/plan.md §2): the
 * actual shift of a chatter, from the chat extension's activity.
 *
 * THE BEAT (`clientActivity`). A device token's: the extension's background
 * names the pages it has open and how long ago the person was last active on
 * each. A page that is not the caller's is skipped, never an error: an
 * assignment taken away must not wedge the beat. The hub's clock dates the
 * beat; the client only says how long ago, so its clock never matters.
 *
 * THE SHIFT (`teamShifts`). Computed from the minutes when read
 * (`shiftsOfMinutes`, pure): in at the first active minute; a pause from the
 * CHATTER_SHIFT_IDLE_PAUSE_MINUTES-th idle minute to the next activity (the
 * idle minutes before it count as work: reading, waiting for a fan); out when
 * the extension closed or went silent CLIENT_ACTIVITY_LOST_MINUTES (the minutes
 * have a gap), or after CHATTER_SHIFT_END_IDLE_MINUTES idle — at the last
 * activity plus at most the idle minutes that still count.
 *
 * Database only: nothing here asks a platform or queues work.
 */

const MINUTE_MS = 60_000;

export async function recordClientActivity(
  app: AppContext,
  principal: HumanAuthPrincipal,
  body: ClientActivityBody,
): Promise<ClientActivityResponse> {
  // A cookie session → 403: the beat is a client's.
  requireApiKeyUser(principal);
  const now = new Date();
  const pages: Array<{ pageId: number; inputAt: Date | null }> = [];
  for (const entry of body.pages) {
    const page = await findPageSummaryByLabel(app.db, entry.pageLabel);
    if (!page || !canAccessPage(principal, page.id) || pages.some((known) => known.pageId === page.id)) continue;
    pages.push({ pageId: page.id, inputAt: entry.idleMs === null ? null : new Date(now.getTime() - entry.idleMs) });
  }
  await recordChatterActivityBeat(app.db, {
    userId: principal.user.id,
    instanceId: body.instanceId,
    at: now,
    pages,
    closed: body.closed ?? false,
  });
  return { recorded: pages.length, serverNow: now.toISOString() };
}

export interface ActivityMinute {
  /** The start of the minute, ms. */
  at: number;
  pageLabel: string;
  input: boolean;
}

export interface ComputedShift {
  startedAt: number;
  endedAt: number;
  ongoing: boolean;
  workedMinutes: number;
  pauses: Array<{ from: number; to: number }>;
  /** Active minutes per page. */
  pages: Map<string, number>;
}

/**
 * The shifts of one person from their minutes (any order, any pages; one row
 * per page and minute). `now` decides whether the last one is still going.
 * Pure.
 */
export function shiftsOfMinutes(minutes: readonly ActivityMinute[], now: number): ComputedShift[] {
  // One entry per minute: open on some page, active on which.
  const byMinute = new Map<number, Set<string>>();
  for (const minute of minutes) {
    const active = byMinute.get(minute.at) ?? new Set<string>();
    if (minute.input) active.add(minute.pageLabel);
    byMinute.set(minute.at, active);
  }
  const open = [...byMinute.keys()].sort((a, b) => a - b);
  const lost = CLIENT_ACTIVITY_LOST_MINUTES * MINUTE_MS;
  const pauseAfter = CHATTER_SHIFT_IDLE_PAUSE_MINUTES * MINUTE_MS;
  const endAfter = CHATTER_SHIFT_END_IDLE_MINUTES * MINUTE_MS;

  const shifts: ComputedShift[] = [];
  let current: { start: number; lastOpen: number; inputs: number[]; pages: Map<string, number> } | null = null;

  const close = (end: number, ongoing: boolean) => {
    if (current === null) return;
    const { start, inputs, pages } = current;
    let worked = 0;
    const pauses: Array<{ from: number; to: number }> = [];
    inputs.forEach((at, index) => {
      const next = inputs[index + 1] ?? end;
      worked += Math.min(next - at, pauseAfter);
      if (next - at > pauseAfter && index + 1 < inputs.length) pauses.push({ from: at + pauseAfter, to: next });
    });
    shifts.push({ startedAt: start, endedAt: end, ongoing, workedMinutes: Math.round(worked / MINUTE_MS), pauses, pages });
    current = null;
  };
  /** Where a shift that stopped hearing from the person ends: its last open minute, or its last activity plus the idle that still counts. */
  const endOf = (shift: { lastOpen: number; inputs: number[] }) =>
    Math.min(shift.lastOpen + MINUTE_MS, shift.inputs.at(-1)! + pauseAfter);

  for (const at of open) {
    const active = byMinute.get(at)!;
    if (current !== null) {
      const lastInput = current.inputs.at(-1)!;
      // The extension closed or went silent between the two minutes, or the person was idle long enough to be gone.
      if (at - current.lastOpen > lost || at - lastInput >= endAfter) close(endOf(current), false);
    }
    if (current === null) {
      if (active.size === 0) continue;
      current = { start: at, lastOpen: at, inputs: [], pages: new Map() };
    }
    current.lastOpen = at;
    if (active.size > 0) {
      current.inputs.push(at);
      for (const page of active) current.pages.set(page, (current.pages.get(page) ?? 0) + 1);
    }
  }
  if (current !== null) {
    const shift: { lastOpen: number; inputs: number[] } = current;
    const stillHere = now - shift.lastOpen <= lost && now - shift.inputs.at(-1)! < endAfter;
    close(stillHere ? Math.min(now, shift.inputs.at(-1)! + endAfter) : endOf(shift), stillHere);
  }
  return shifts;
}

/** The window of a read: [from, to), at most CHATTER_SHIFTS_MAX_WINDOW_DAYS. Pure. */
export function teamShiftsWindow(query: Pick<TeamShiftsQuery, "from" | "to">, now: Date): { from: Date; to: Date } {
  const to = query.to === undefined ? now : new Date(query.to);
  const from = query.from === undefined ? new Date(to.getTime() - 24 * 60 * MINUTE_MS) : new Date(query.from);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new BadRequestError("`from` must be before `to`");
  }
  if (to.getTime() - from.getTime() > CHATTER_SHIFTS_MAX_WINDOW_DAYS * 24 * 60 * MINUTE_MS) {
    throw new BadRequestError(`The window is at most ${CHATTER_SHIFTS_MAX_WINDOW_DAYS} days`);
  }
  return { from, to };
}

export async function listTeamShifts(
  app: AppContext,
  principal: AuthPrincipal,
  input: { query: TeamShiftsQuery; pageScope: readonly number[] | undefined },
): Promise<TeamShiftsResponse> {
  // A cookie session of the owner or a team lead; a chatter and every device token are refused.
  requireDashboardUser(principal);
  const now = new Date();
  const { from, to } = teamShiftsWindow(input.query, now);

  let pages: "all" | readonly number[] = input.pageScope ?? "all";
  if (input.query.pageLabel !== undefined) {
    const page = await findPageSummaryByLabel(app.db, input.query.pageLabel);
    if (!page) throw new NotFoundError(`Page "${input.query.pageLabel}" was not found`);
    if (!canAccessPage(principal, page.id)) throw new ForbiddenError("Page access denied");
    pages = [page.id];
  }

  const rows = await listChatterActivityMinutes(app.db, { from, to, pages });
  const sends = await countAuthoredSendsByMinute(app.db, { from, to, pages });

  const people = new Map<number, { username: string; minutes: ActivityMinute[] }>();
  for (const row of rows) {
    const person = people.get(row.userId) ?? { username: row.username, minutes: [] };
    person.minutes.push({ at: row.minute.getTime(), pageLabel: row.pageLabel, input: row.input });
    people.set(row.userId, person);
  }

  const shifts: TeamShift[] = [];
  for (const [userId, person] of people) {
    for (const shift of shiftsOfMinutes(person.minutes, now.getTime())) {
      const authoredMessages = sends
        .filter((send) => send.userId === userId && send.minute.getTime() >= shift.startedAt && send.minute.getTime() < shift.endedAt)
        .reduce((sum, send) => sum + send.sends, 0);
      shifts.push({
        userId,
        username: person.username,
        startedAt: new Date(shift.startedAt).toISOString(),
        endedAt: new Date(shift.endedAt).toISOString(),
        ongoing: shift.ongoing,
        workedMinutes: shift.workedMinutes,
        pauses: shift.pauses.map((pause) => ({ from: new Date(pause.from).toISOString(), to: new Date(pause.to).toISOString() })),
        pages: [...shift.pages].map(([pageLabel, activeMinutes]) => ({ pageLabel, activeMinutes })).sort((a, b) => b.activeMinutes - a.activeMinutes),
        authoredMessages,
      });
    }
  }
  shifts.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { from: from.toISOString(), to: to.toISOString(), shifts, serverNow: now.toISOString() };
}
