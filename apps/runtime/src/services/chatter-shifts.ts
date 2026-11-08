import {
  CHATTER_SHIFT_CLOSED_GRACE_MINUTES,
  CHATTER_SHIFT_CLOSED_SILENT_MINUTES,
  CHATTER_SHIFT_EDGE_BLOCK_GAP_MINUTES,
  CHATTER_SHIFT_EDGE_NEAR_MINUTES,
  CHATTER_SHIFT_END_IDLE_MINUTES,
  CHATTER_SHIFT_IDLE_PAUSE_MINUTES,
  CHATTER_SHIFT_LOOK_IN_JOIN_MINUTES,
  CHATTER_SHIFT_MIN_MESSAGES,
  CHATTER_SHIFT_MIN_WORKED_MINUTES,
  CHATTER_SHIFT_PAGE_MIN_MESSAGES,
  CHATTER_SHIFT_PIECE_MIN_MESSAGES,
  CHATTER_SHIFTS_MAX_WINDOW_DAYS,
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
  type Database,
  type ShiftSale,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, requireApiKeyUser, requireDashboardUser, type AuthPrincipal, type HumanAuthPrincipal } from "./auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.ts";

/**
 * The one definition of a chatter's shift, for the whole of Hub: the console's
 * «Смены» and «Числа», the cabinet's statistics and shift report, the morning
 * block, the AI spend. From the chat extension's activity and the messages the
 * person sent.
 *
 * THE BEAT (`clientActivity`). A device token's: the extension's background
 * names the pages it has open and how long ago the person was last active on
 * each. A page that is not the caller's is skipped, never an error: an
 * assignment taken away must not wedge the beat. The hub's clock dates the
 * beat; the client only says how long ago, so its clock never matters.
 *
 * THE WORK (`workOfMinutes`, pure), computed when read, always from everything
 * the person did, so a view of some pages never changes what a shift is:
 *
 * - A stretch runs from the first active minute until
 *   CHATTER_SHIFT_END_IDLE_MINUTES with no activity. The extension closing or
 *   the browser restarting ends nothing, now as afterwards: a stretch goes on
 *   until that long after its last action, the extension beating or not, and
 *   a break going on now is a pause of it already. A gap's first
 *   CHATTER_SHIFT_IDLE_PAUSE_MINUTES are work (reading, waiting for a fan), the
 *   rest is a pause; but with the extension then silent for
 *   CHATTER_SHIFT_CLOSED_SILENT_MINUTES or more (closed, the computer asleep),
 *   the work ends at its last open minute plus CHATTER_SHIFT_CLOSED_GRACE_MINUTES
 *   (owner, 2026-11-08): the time with it closed is no work.
 * - With CHATTER_SHIFT_MIN_WORKED_MINUTES of work and
 *   CHATTER_SHIFT_MIN_MESSAGES messages it is a SHIFT; else a VISIT, a look-in
 *   that is not counted as one. A stretch still going is a shift once it has
 *   CHATTER_SHIFT_PIECE_MIN_MESSAGES messages: a glance at the extension is no
 *   «смена идёт».
 * - Its edges. Its body runs from the first to the last piece of work (between
 *   two pauses) with CHATTER_SHIFT_PIECE_MIN_MESSAGES messages. The piece next
 *   to the body at its start or end, under CHATTER_SHIFT_EDGE_NEAR_MINUTES from
 *   it, is the shift whatever its messages: two last answers 20 minutes after
 *   the night. The pieces beyond, in blocks at most
 *   CHATTER_SHIFT_EDGE_BLOCK_GAP_MINUTES apart, are cut from the outside in
 *   while a block has under CHATTER_SHIFT_PIECE_MIN_MESSAGES: a look-in half an
 *   hour before it, answers one at a time at noon after a night shift — each a
 *   visit of its own.
 * - A look-in BEFORE a shift with CHATTER_SHIFT_PIECE_MIN_MESSAGES messages that
 *   ended at most CHATTER_SHIFT_LOOK_IN_JOIN_MINUTES before it began is its
 *   start, the gap a pause (owner, 2026-11-08): a morning's work before a break
 *   of over an hour is the day's shift, with its sales. One after a shift stays
 *   a look-in: answers after a night are no part of it.
 * - It belongs to the Moscow day holding most of it (`dayOfWork`), the day the
 *   payout sheet gives it: a night entered at 23:54 or at 00:08 is one day.
 * - It holds the sales (`workHoldsSale`) on the pages it worked, from the
 *   person's first action on the page to its end: a page taken over from a
 *   colleague at 02:20 is the person's money from 02:20. Worked is
 *   CHATTER_SHIFT_PAGE_MIN_MESSAGES messages there; a tab looked at is not. A
 *   visit holds those on the pages it wrote on, to a fan the person was the last
 *   to write to. Whose each one is, the old rule and the team's, is sale-rule.ts's.
 *
 * Database only: nothing here asks a platform or queues work.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

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

export interface SentMinute {
  /** The start of the minute, ms. */
  at: number;
  pageLabel: string;
  messages: number;
}

export interface ComputedWork {
  kind: "shift" | "visit";
  startedAt: number;
  endedAt: number;
  ongoing: boolean;
  workedMinutes: number;
  /** A break going on now is one too: from the end of the work before it to now. */
  pauses: Array<{ from: number; to: number }>;
  /** The start of its last minute with an action, ms. */
  lastInputAt: number;
  /** The start of its last minute the extension beat in, ms: a silence since says the extension is closed or offline. */
  lastBeatAt: number;
  /** Active minutes per page. */
  pages: Map<string, number>;
  /** Messages per page. */
  messages: Map<string, number>;
  /** The pages whose sales it holds, and from when, ms. */
  salesSince: Map<string, number>;
}

/** Splits an ascending list where `apart` says two neighbours are. Pure. */
function splitWhere(values: readonly number[], apart: (gap: number) => boolean): number[][] {
  const parts: number[][] = [];
  let part: number[] = [];
  for (const value of values) {
    if (part.length > 0 && apart(value - part.at(-1)!)) {
      parts.push(part);
      part = [];
    }
    part.push(value);
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

/** The number of values below `limit` in an ascending list. Pure. */
function countBelow(values: readonly number[], limit: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < limit) low = middle + 1;
    else high = middle;
  }
  return low;
}

function addTo(map: Map<string, number>, key: string, by: number) {
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * The work of one person from their minutes (any order, any pages; one row per
 * page and minute) and their messages (any order), oldest first. `now` decides
 * whether the last stretch still goes. Pure.
 */
export function workOfMinutes(minutes: readonly ActivityMinute[], sent: readonly SentMinute[], now: number): ComputedWork[] {
  const activeAt = new Map<number, string[]>();
  const openAt = new Set<number>();
  for (const minute of minutes) {
    openAt.add(minute.at);
    if (!minute.input) continue;
    const pages = activeAt.get(minute.at);
    if (pages === undefined) activeAt.set(minute.at, [minute.pageLabel]);
    else pages.push(minute.pageLabel);
  }
  const inputs = [...activeAt.keys()].sort((a, b) => a - b);
  if (inputs.length === 0) return [];

  const open = [...openAt].sort((a, b) => a - b);
  const messages = [...sent].sort((a, b) => a.at - b.at);
  const messageAts = messages.map((one) => one.at);
  // Messages before each index of `messages`, to count a range at once.
  const messagesBefore = [0];
  for (const one of messages) messagesBefore.push(messagesBefore.at(-1)! + one.messages);
  const messagesIn = (from: number, to: number) => messagesBefore[countBelow(messageAts, to)]! - messagesBefore[countBelow(messageAts, from)]!;

  const pauseAfter = CHATTER_SHIFT_IDLE_PAUSE_MINUTES * MINUTE_MS;
  const endAfter = CHATTER_SHIFT_END_IDLE_MINUTES * MINUTE_MS;

  /** The end of work that stopped: its last open minute, or its last activity plus the idle that still counts. */
  const endOf = (lastInput: number) => {
    const lastOpen = open[countBelow(open, lastInput + pauseAfter + 1) - 1]!;
    return Math.min(lastOpen + MINUTE_MS, lastInput + pauseAfter);
  };

  const closedSilence = CHATTER_SHIFT_CLOSED_SILENT_MINUTES * MINUTE_MS;
  const closedGrace = CHATTER_SHIFT_CLOSED_GRACE_MINUTES * MINUTE_MS;
  /**
   * The idle after the action at `at` that is work, until `next` (the next action, or now in a break going on): up to
   * pauseAfter, but no further than the extension's last open minute plus closedGrace when it then went silent for
   * closedSilence or more — closed, or the computer asleep: the time with it closed is no work.
   */
  const idleWorked = (at: number, next: number) => {
    const counted = Math.min(next - at, pauseAfter);
    for (let index = countBelow(open, at); index < open.length && open[index]! < at + counted; index += 1) {
      const minute = open[index]!;
      if ((open[index + 1] ?? now) - minute >= closedSilence) return Math.min(counted, minute + closedGrace - at);
    }
    return counted;
  };

  const workOf = (part: readonly number[], end: number, ongoing: boolean): Omit<ComputedWork, "kind" | "salesSince"> & { firstSeen: Map<string, number> } => {
    let worked = 0;
    const pauses: Array<{ from: number; to: number }> = [];
    const pages = new Map<string, number>();
    const firstSeen = new Map<string, number>();
    part.forEach((at, index) => {
      const next = part[index + 1] ?? end;
      // Work that stopped ends within the idle that counts (`endOf`); one going on pauses from then to now.
      const idle = index + 1 < part.length || ongoing ? idleWorked(at, next) : Math.min(next - at, pauseAfter);
      worked += idle;
      if (next - at > idle) pauses.push({ from: at + idle, to: next });
      for (const page of activeAt.get(at)!) {
        addTo(pages, page, 1);
        if (!firstSeen.has(page)) firstSeen.set(page, at);
      }
    });
    const ownMessages = new Map<string, number>();
    const start = part[0]!;
    const lastInputAt = part.at(-1)!;
    const lastBeatAt = Math.max(lastInputAt, open[countBelow(open, end) - 1] ?? lastInputAt);
    for (let index = countBelow(messageAts, start); index < messages.length && messages[index]!.at < end; index += 1) {
      const one = messages[index]!;
      addTo(ownMessages, one.pageLabel, one.messages);
      if ((firstSeen.get(one.pageLabel) ?? Infinity) > one.at) firstSeen.set(one.pageLabel, one.at);
    }
    return {
      startedAt: start, endedAt: end, ongoing, workedMinutes: Math.round(worked / MINUTE_MS), pauses, lastInputAt, lastBeatAt, pages, messages: ownMessages, firstSeen,
    };
  };
  const finish = ({ firstSeen, ...work }: ReturnType<typeof workOf>, kind: ComputedWork["kind"]): ComputedWork => {
    const atLeast = kind === "shift" ? CHATTER_SHIFT_PAGE_MIN_MESSAGES : 1;
    const salesSince = new Map([...work.messages].filter(([, count]) => count >= atLeast).map(([page]) => [page, firstSeen.get(page)!] as const));
    return { kind, ...work, salesSince };
  };
  const messagesOf = (work: ReturnType<typeof workOf>) => [...work.messages.values()].reduce((sum, count) => sum + count, 0);
  const isShift = (work: ReturnType<typeof workOf>) => work.workedMinutes >= CHATTER_SHIFT_MIN_WORKED_MINUTES && messagesOf(work) >= CHATTER_SHIFT_MIN_MESSAGES;

  const nearEdge = CHATTER_SHIFT_EDGE_NEAR_MINUTES * MINUTE_MS;
  const blockGap = CHATTER_SHIFT_EDGE_BLOCK_GAP_MINUTES * MINUTE_MS;
  /**
   * How many pieces at one edge of a shift's body are the shift. `edge` — those
   * pieces, the one next to the body first: each one's gap from the piece nearer
   * the body, and its messages. The one next to the body, under `nearEdge` from
   * it, stays whatever its messages; the ones beyond, in blocks at most
   * `blockGap` apart, are cut from the outside in while a block has too few.
   */
  const edgeKept = (edge: ReadonlyArray<{ gap: number; messages: number }>): number => {
    const near = edge.length > 0 && edge[0]!.gap < nearEdge ? 1 : 0;
    let kept = edge.length;
    while (kept > near) {
      let from = kept - 1;
      let messages = edge[from]!.messages;
      while (from > near && edge[from]!.gap <= blockGap) {
        from -= 1;
        messages += edge[from]!.messages;
      }
      if (messages >= CHATTER_SHIFT_PIECE_MIN_MESSAGES) break;
      kept = from;
    }
    return kept;
  };

  /** A piece of work before it is computed: its active minutes and its end. */
  type Segment = { kind: ComputedWork["kind"]; part: number[]; end: number; ongoing: boolean };
  const stretches = splitWhere(inputs, (gap) => gap >= endAfter);
  const segments: Segment[] = [];
  stretches.forEach((stretch, index) => {
    const lastInput = stretch.at(-1)!;
    // Still going: the last stretch, under an hour since its last action, whether the extension beats now or not (a break).
    const going = index === stretches.length - 1 && now - lastInput < endAfter;
    const pieces = splitWhere(stretch, (gap) => gap > pauseAfter);
    const sent = pieces.map((piece, at) => messagesIn(piece[0]!, pieces[at + 1]?.[0] ?? (going ? now + 1 : piece.at(-1)! + pauseAfter)));
    // The body: from the first to the last piece with enough messages (once it is over; while it goes, to now).
    let first = 0;
    let last = pieces.length;
    if (!going) while (last - first > 1 && sent[last - 1]! < CHATTER_SHIFT_PIECE_MIN_MESSAGES) last -= 1;
    while (last - first > 1 && sent[first]! < CHATTER_SHIFT_PIECE_MIN_MESSAGES) first += 1;
    // Its edges: the piece next to it, and the blocks beyond with enough messages.
    if (!going) {
      last += edgeKept(pieces.slice(last).map((piece, at) => ({ gap: piece[0]! - pieces[last + at - 1]!.at(-1)!, messages: sent[last + at]! })));
    }
    first -= edgeKept(pieces.slice(0, first).reverse().map((piece, at) => ({ gap: pieces[first - at]![0]! - piece.at(-1)!, messages: sent[first - at - 1]! })));
    const body = pieces.slice(first, last).flat();
    const core = workOf(body, going ? now : endOf(body.at(-1)!), going);
    const shift = going ? messagesOf(core) >= CHATTER_SHIFT_PIECE_MIN_MESSAGES : isShift(core);
    if (!shift) {
      segments.push({ kind: "visit", part: stretch, end: going ? now : endOf(lastInput), ongoing: going });
      return;
    }
    if (first > 0) {
      const head = pieces.slice(0, first).flat();
      segments.push({ kind: "visit", part: head, end: endOf(head.at(-1)!), ongoing: false });
    }
    segments.push({ kind: "shift", part: body, end: core.endedAt, ongoing: going });
    if (last < pieces.length) segments.push({ kind: "visit", part: pieces.slice(last).flat(), end: endOf(lastInput), ongoing: false });
  });

  // A look-in with enough messages that ended at most LOOK_IN_JOIN before a shift began is its start, and so on back;
  // what lies between joins it too. Only before: answers after a shift stay a look-in.
  const joinBefore = CHATTER_SHIFT_LOOK_IN_JOIN_MINUTES * MINUTE_MS;
  const joined: Segment[] = [];
  for (const segment of segments) {
    if (segment.kind === "shift") {
      let start = segment.part[0]!;
      let from = joined.length;
      for (let before = joined.length - 1; before >= 0 && joined[before]!.kind === "visit" && joined[before]!.end >= start - joinBefore; before -= 1) {
        const visit = joined[before]!;
        if (messagesIn(visit.part[0]!, visit.end) < CHATTER_SHIFT_PIECE_MIN_MESSAGES) continue;
        from = before;
        start = visit.part[0]!;
      }
      if (from < joined.length) {
        const look = joined.splice(from).flatMap((visit) => visit.part);
        joined.push({ ...segment, part: [...look, ...segment.part] });
        continue;
      }
    }
    joined.push(segment);
  }
  return joined.map((segment) => finish(workOf(segment.part, segment.end, segment.ongoing), segment.kind));
}

/** The instant in the middle of a piece of work: the Moscow day holding most of it holds this (a tie: the day it began). Pure. */
export function middleOfWork(work: { startedAt: number; endedAt: number }): number {
  return Math.floor((work.startedAt + work.endedAt - 1) / 2);
}

/** The Moscow `YYYY-MM-DD` of an instant (Moscow has no DST: UTC+3). Pure. */
export function moscowDayOf(at: number): string {
  return new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);
}

/** The Moscow day a piece of work belongs to. Pure. */
export function dayOfWork(work: { startedAt: number; endedAt: number }): string {
  return moscowDayOf(middleOfWork(work));
}

/** Whether a sale is in this piece of work's money. Pure. */
export function workHoldsSale(work: Pick<ComputedWork, "salesSince" | "endedAt">, sale: { pageLabel: string; at: number }): boolean {
  const since = work.salesSince.get(sale.pageLabel);
  return since !== undefined && sale.at >= since && sale.at < work.endedAt;
}

/** How far back a message to a fan says who sold to them: as the facts of a sale in the shift report. */
export const SALE_LAST_WRITER_HOURS = 48;

/** The sales with a fan, as `listSaleLastWriters` asks for them. Pure. */
export function lastWriterQuery(sales: readonly ShiftSale[]): Array<{ transactionId: number; pageId: number; fanRef: string; at: Date }> {
  return sales.flatMap((sale) => (sale.fanRef === null ? [] : [{ transactionId: sale.transactionId, pageId: sale.pageId, fanRef: sale.fanRef, at: sale.occurredAt }]));
}

export interface PersonWork {
  username: string;
  /** The ids of the pages of their minutes, by label. */
  pageIds: Map<string, number>;
  /** Oldest first, on the pages in scope only. */
  work: ComputedWork[];
}

/**
 * A piece of work as a view of `labels` sees it; null — nothing of it there. A
 * shift that worked none of those pages is only a look-in at them. Pure.
 */
export function workOnPages(work: ComputedWork, labels: ReadonlySet<string>): ComputedWork | null {
  const only = (map: ReadonlyMap<string, number>) => new Map([...map].filter(([label]) => labels.has(label)));
  const pages = only(work.pages);
  const messages = only(work.messages);
  if (pages.size === 0 && messages.size === 0) return null;
  const salesSince = only(work.salesSince);
  return { ...work, kind: work.ongoing || salesSince.size > 0 ? work.kind : "visit", pages, messages, salesSince };
}

/**
 * Everyone's work in [from, to) (or one person's): computed from all their
 * minutes and messages whatever the pages asked, then cut to `pages`: a lead's
 * view of a page does not make a shift of the page's share of one.
 */
export async function readPeopleWork(
  db: Database,
  input: { from: Date; to: Date; now: Date; pages: "all" | readonly number[]; userId?: number },
): Promise<Map<number, PersonWork>> {
  const person = input.userId === undefined ? {} : { userId: input.userId };
  const [minutes, sends] = await Promise.all([
    listChatterActivityMinutes(db, { from: input.from, to: input.to, pages: "all", ...person }),
    countAuthoredSendsByMinute(db, { from: input.from, to: input.to, pages: "all", ...person }),
  ]);
  const scope = input.pages === "all" ? null : new Set(input.pages);
  const labels = new Set<string>();
  const people = new Map<number, { username: string; pageIds: Map<string, number>; minutes: ActivityMinute[]; sent: SentMinute[] }>();
  for (const minute of minutes) {
    const known = people.get(minute.userId) ?? { username: minute.username, pageIds: new Map<string, number>(), minutes: [], sent: [] };
    known.pageIds.set(minute.pageLabel, minute.pageId);
    known.minutes.push({ at: minute.minute.getTime(), pageLabel: minute.pageLabel, input: minute.input });
    people.set(minute.userId, known);
    if (scope?.has(minute.pageId)) labels.add(minute.pageLabel);
  }
  for (const send of sends) people.get(send.userId)?.sent.push({ at: send.minute.getTime(), pageLabel: send.pageLabel, messages: send.sends });

  const out = new Map<number, PersonWork>();
  for (const [userId, known] of people) {
    const all = workOfMinutes(known.minutes, known.sent, input.now.getTime());
    const work = scope === null ? all : all.flatMap((one) => workOnPages(one, labels) ?? []);
    if (work.length > 0) out.set(userId, { username: known.username, pageIds: known.pageIds, work });
  }
  return out;
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

/** A shift as `teamShifts` sends it. Pure. */
export function teamShiftOf(userId: number, username: string, shift: ComputedWork): TeamShift {
  return {
    userId,
    username,
    startedAt: new Date(shift.startedAt).toISOString(),
    endedAt: new Date(shift.endedAt).toISOString(),
    ongoing: shift.ongoing,
    workedMinutes: shift.workedMinutes,
    pauses: shift.pauses.map((pause) => ({ from: new Date(pause.from).toISOString(), to: new Date(pause.to).toISOString() })),
    lastInputAt: new Date(shift.lastInputAt).toISOString(),
    lastBeatAt: new Date(shift.lastBeatAt).toISOString(),
    pages: [...new Set([...shift.pages.keys(), ...shift.messages.keys()])]
      .map((pageLabel) => ({ pageLabel, activeMinutes: shift.pages.get(pageLabel) ?? 0, messages: shift.messages.get(pageLabel) ?? 0 }))
      .sort((a, b) => b.messages - a.messages || b.activeMinutes - a.activeMinutes),
    authoredMessages: [...shift.messages.values()].reduce((sum, count) => sum + count, 0),
  };
}

/** The pages a read is about: the viewer's, or the one asked (404 / 403 as every team read). */
export async function teamReadPages(
  app: AppContext,
  principal: AuthPrincipal,
  input: { pageLabel: string | undefined; pageScope: readonly number[] | undefined },
): Promise<"all" | readonly number[]> {
  if (input.pageLabel === undefined) return input.pageScope ?? "all";
  const page = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!page) throw new NotFoundError(`Page "${input.pageLabel}" was not found`);
  if (!canAccessPage(principal, page.id)) throw new ForbiddenError("Page access denied");
  return [page.id];
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

  const pages = await teamReadPages(app, principal, { pageLabel: input.query.pageLabel, pageScope: input.pageScope });

  // A day more on each side, so a shift the window only touches is whole.
  const people = await readPeopleWork(app.db, {
    from: new Date(from.getTime() - DAY_MS), to: new Date(Math.min(to.getTime() + DAY_MS, now.getTime())), now, pages,
  });

  const shifts: TeamShift[] = [];
  for (const [userId, person] of people) {
    for (const shift of person.work) {
      if (shift.kind !== "shift" || shift.startedAt >= to.getTime() || shift.endedAt <= from.getTime()) continue;
      shifts.push(teamShiftOf(userId, person.username, shift));
    }
  }
  shifts.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { from: from.toISOString(), to: to.toISOString(), shifts, serverNow: now.toISOString() };
}
