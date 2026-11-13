/**
 * Смены — the data layer (spec §4.1). The screen reads only this file.
 *
 * Future contract (phase 2, spec §2.7) — the shapes below are what the screen
 * needs, and what Hub should answer in one read each:
 *   - `teamNow`           → NowState: who is on a shift now, with live counters (fans waiting now);
 *   - `teamShiftJournal`  → ShiftsModel: every shift of the period with money, $/h and its quality —
 *                           `replyMedianSeconds` · `unansweredAtEnd` · `aiUneditedShare`, counted by Hub
 *                           by the shift review's rules (`@agency_hub_core/ui/shiftReview`, spec §3 r2) —
 *                           the chatter × day grid, page filters applied by Hub.
 *
 * Phase 1 adapter over today's operations (what the console's «Заработок» reads,
 * apps/dashboard/src/api/team.ts):
 *   - `teamShiftSales` { days, until?, pageLabel? } — the period's shifts with money, the grid, the window before;
 *   - `teamChatterNumbers` { from, to? } — per-shift numbers, read into the three quality numbers by
 *     `qualityOfChatterNumbers` (the prototype's stand-in until Hub counts them by the review's rules; in the
 *     demo they equal the review of the same shift). It knows no page filter and is slow on a whole team: the
 *     quality columns fill in later;
 *   - `teamAuthorship` { days ≤ 7 } — messages without an author (a data check, shown only for a current period);
 *   - `shiftReportNotes` { days, until?, pageLabel? } — what stands between a day's shifts and the report it is paid by,
 *     per person and day, for the note under a day's last shift alone (shared/reportNotes.ts); an error is no line,
 *     never a state.
 * Query keys start with "shifts". Polls only while the tab is visible (queryClient's default):
 * a minute for «now» and a current period, never for a closed one.
 */
import { shiftIdleText, shiftIdleTitle } from "@agency_hub_core/ui/shiftLive";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CHATTER_SHIFT_PAGE_MIN_MESSAGES, type KernelOperationResponse } from "@agency_hub_core/contracts";
import { addDays, daysInRange, moscowDayEnd, moscowDayOf, moscowDayStart, type MoscowDay } from "@agency_hub_core/ui/moscow";
import { periodChunks, type ResolvedPeriod } from "@agency_hub_core/ui/period";
import { median } from "@agency_hub_core/ui/shiftReview";
import { shiftWhen, type ShiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { LOGINS_ONLY, type PeopleIndex } from "@agency_hub_core/ui/people";
import { loginsByPerson } from "./byPerson.js";
import { kernel } from "@/shared/hub";
import { shiftSalesQuery } from "@/shared/reads";
import { perHourMills, qualityOfChatterNumbers, type ShiftQuality } from "@/shared/metrics";

type SalesResponse = KernelOperationResponse<"teamShiftSales">;
type SalesShift = SalesResponse["shifts"][number];
type NumbersResponse = KernelOperationResponse<"teamChatterNumbers">;
type NumbersShift = NumbersResponse["chatters"][number]["shifts"][number];
type AuthorshipResponse = KernelOperationResponse<"teamAuthorship">;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The longest window `teamShiftSales` and `teamChatterNumbers` read (Moscow days). */
export const SHIFTS_MAX_DAYS = 31;
/** The longest window `teamAuthorship` reads. */
export const AUTHORSHIP_MAX_DAYS = 7;
/** Up to this many days the grid has a column a day; a longer period has a column per 7 days back from its end (D4). */
export const GRID_DAY_COLUMNS_MAX = 8;
/** The days of one column of a longer period. */
export const GRID_CHUNK_DAYS = 7;

// ─────────────────────────────────────────────────────────── The future contract

/** A page the shift wrote on. */
export interface ShiftPage {
  pageLabel: string;
  messages: number;
  /** CHATTER_SHIFT_PAGE_MIN_MESSAGES or more: the shift works the page, its sales count. */
  counts: boolean;
}

export type { ShiftQuality };

/** One row of the journal (`teamShiftJournal`). */
export interface JournalShift {
  /** `${userId}:${startedAt}`. */
  key: string;
  userId: number;
  username: string;
  startedAt: string;
  endedAt: string;
  ongoing: boolean;
  /** The Moscow day holding most of the shift: the payout sheet's day, the grid's column (Hub's, = `when.payDay`). */
  date: MoscowDay;
  /** Its one label and duration (D12): «вс, 1–2 нояб. 21:00–05:49», «8 ч 21 мин», the pauses only for a hint. */
  when: ShiftWhen;
  workedMinutes: number;
  pages: ShiftPage[];
  messages: number;
  salesNetMills: number;
  /** Of the sales: those another chatter's overlapping shift holds too. */
  overlapNetMills: number;
  perHourMills: number | null;
  /** null: not known (not read yet, Hub did not answer, or no numbers for this shift). */
  quality: ShiftQuality | null;
}

export interface Totals {
  shifts: number;
  workedMinutes: number;
  salesNetMills: number;
  perHourMills: number | null;
}

export interface GridColumn {
  /** The day, or the first day of a chunk. */
  key: string;
  /** A day, or (a period longer than GRID_DAY_COLUMNS_MAX) up to 7 days back from its end. */
  kind: "day" | "chunk";
  from: MoscowDay;
  to: MoscowDay;
  /** Days in the column: 1, or up to 7. */
  days: number;
  /** Today is inside. */
  today: boolean;
  /** Entirely ahead. */
  future: boolean;
  /** Entirely before Hub counted shifts: unknown, never a zero. */
  unknown: boolean;
}

export interface GridCell {
  column: GridColumn;
  salesNetMills: number;
  shifts: number;
  workedMinutes: number;
  /** The shifts behind the cell, the earliest first: one opens directly, several are a choice. */
  list: JournalShift[];
}

export interface GridRow {
  /** null: the whole team. */
  userId: number | null;
  username: string;
  totals: Totals;
  /** The window just before (cut at the same point while this one goes on); null — Hub did not have it all. */
  previous: Totals | null;
  /**
   * Worked now, the team has a window before but Hub has none for them: it began
   * to see them after that window began (half of it, or only now). Not «new»:
   * nothing to compare with.
   */
  unmatched: boolean;
  /** No shift in this window: only their window before is shown. */
  gone: boolean;
  cells: GridCell[];
}

export interface ShiftsWindow {
  /** What Hub is asked for. */
  days: number;
  until: MoscowDay | undefined;
  /** Shown days, both included (a week's days to come are listed empty). */
  from: MoscowDay;
  to: MoscowDay;
  /** The period is longer than Hub reads: its last SHIFTS_MAX_DAYS days are shown. */
  clipped: boolean;
}

export interface ShiftsModel {
  window: ShiftsWindow;
  columns: GridColumn[];
  team: GridRow;
  chatters: GridRow[];
  /** Newest first, a shift going on first. */
  journal: JournalShift[];
  /** The window before is known (there is something to compare with). */
  comparable: boolean;
  /** The first Moscow day Hub has activity for; null — none at all. */
  knownSince: MoscowDay | null;
  /** The team's usual numbers for the period, to spot an outlier. */
  norms: TeamNorms;
  today: MoscowDay;
  /** The period's sales no shift held: in look-ins and nobody's, by page («вне смен»). */
  outside: SalesResponse["outside"];
}

/** «Сейчас на смене» (`teamNow`). */
export interface NowShift {
  key: string;
  userId: number;
  username: string;
  startedAt: string;
  /** Its label and the time worked so far (D12): «18:02 – сейчас», «3 ч 10 мин», the pauses only for a hint. */
  when: ShiftWhen;
  workedMinutes: number;
  pages: string[];
  salesNetMills: number;
  messages: number;
  /** Fans waiting for an answer now; undefined — still counting; null — not known. */
  waitingNow: number | null | undefined;
  /** «без действий 25 мин · нет связи 20 мин»: a break or an end not yet known; null — at work now. */
  idle: string | null;
  idleHint: string;
}

export interface NowState {
  shifts: NowShift[];
  /** The last shift that ended in the last two days; null — none. */
  last: { userId: number; username: string; startedAt: string; endedAt: string } | null;
}

// ─────────────────────────────────────────────────────────── Pure helpers

/** What Hub is asked for, for a period of the app. */
export function shiftsWindow(period: ResolvedPeriod): ShiftsWindow {
  const { spec } = period;
  if (spec.kind === "week") {
    // The whole calendar week: Hub lists the days to come empty.
    return { days: 7, until: addDays(spec.monday, 6), from: spec.monday, to: addDays(spec.monday, 6), clipped: false };
  }
  if (spec.kind === "days") {
    return { days: spec.days, until: undefined, from: period.from, to: period.to, clipped: false };
  }
  const full = daysInRange(period.from, period.to);
  const days = Math.min(full, SHIFTS_MAX_DAYS);
  return { days, until: period.to, from: addDays(period.to, -(days - 1)), to: period.to, clipped: full > days };
}

function pagesOf(shift: Pick<SalesShift, "pages">): ShiftPage[] {
  return shift.pages
    .filter((page) => page.messages > 0)
    .map((page) => ({ pageLabel: page.pageLabel, messages: page.messages, counts: page.messages >= CHATTER_SHIFT_PAGE_MIN_MESSAGES }));
}

/**
 * The per-shift numbers of a shift. Without a page filter both reads cut the same
 * shift (services/chatter-shifts.ts), so the start matches. With one, Hub builds the
 * shift of that page's work alone, inside the whole one: the numbers of the whole
 * shift that overlaps it most.
 */
export function numbersFor(shift: { userId: number; startedAt: string; endedAt: string }, numbers: NumbersResponse | undefined): NumbersShift | undefined {
  const chatter = numbers?.chatters.find((one) => one.userId === shift.userId);
  if (!chatter) return undefined;
  const exact = chatter.shifts.find((one) => one.startedAt === shift.startedAt);
  if (exact) return exact;
  const start = Date.parse(shift.startedAt);
  const end = Date.parse(shift.endedAt);
  let best: NumbersShift | undefined;
  let bestOverlap = 0;
  for (const one of chatter.shifts) {
    const overlap = Math.min(end, Date.parse(one.endedAt)) - Math.max(start, Date.parse(one.startedAt));
    if (overlap > bestOverlap) {
      best = one;
      bestOverlap = overlap;
    }
  }
  return best;
}

function journalOf(sales: SalesResponse, numbers: NumbersResponse | undefined): JournalShift[] {
  return sales.shifts
    .map((shift): JournalShift => {
      const found = numbersFor(shift, numbers);
      return {
        key: `${shift.userId}:${shift.startedAt}`,
        userId: shift.userId,
        username: shift.username,
        startedAt: shift.startedAt,
        endedAt: shift.endedAt,
        ongoing: shift.ongoing,
        date: shift.date,
        when: shiftWhen(shift),
        workedMinutes: shift.workedMinutes,
        pages: pagesOf(shift),
        messages: shift.authoredMessages,
        salesNetMills: shift.salesNetMills,
        overlapNetMills: shift.overlapNetMills,
        perHourMills: perHourMills(shift.salesNetMills, shift.workedMinutes),
        quality: found ? qualityOfChatterNumbers(found.numbers) : null,
      };
    })
    .sort((left, right) => Number(right.ongoing) - Number(left.ongoing) || right.startedAt.localeCompare(left.startedAt));
}

/**
 * The grid's columns: a column a day up to GRID_DAY_COLUMNS_MAX days; a longer
 * period in chunks of 7 days back from its last day (D4: the last chunk is
 * full, the first holds the rest — 14 days are 7 + 7, 30 are 2 + 7 + 7 + 7 + 7).
 */
export function columnsOf(days: readonly string[], today: MoscowDay, knownSince: MoscowDay | null): GridColumn[] {
  const make = (kind: "day" | "chunk", from: MoscowDay, to: MoscowDay): GridColumn => ({
    key: from,
    kind,
    from,
    to,
    days: daysInRange(from, to),
    today: from <= today && today <= to,
    future: from > today,
    unknown: knownSince !== null && to < knownSince,
  });
  if (days.length <= GRID_DAY_COLUMNS_MAX) return days.map((day) => make("day", day, day));
  return periodChunks({ from: days[0]!, to: days.at(-1)! }, GRID_CHUNK_DAYS).map((chunk) => make("chunk", chunk.from, chunk.to));
}

type Daily = ReadonlyArray<{ date: string; salesNetMills: number; shifts: number; workedMinutes: number }>;

function cellsOf(columns: readonly GridColumn[], daily: Daily, shifts: readonly JournalShift[]): GridCell[] {
  return columns.map((column) => {
    const inside = daily.filter((day) => day.date >= column.from && day.date <= column.to);
    return {
      column,
      salesNetMills: inside.reduce((sum, day) => sum + day.salesNetMills, 0),
      shifts: inside.reduce((sum, day) => sum + day.shifts, 0),
      workedMinutes: inside.reduce((sum, day) => sum + day.workedMinutes, 0),
      list: shifts
        .filter((shift) => shift.date >= column.from && shift.date <= column.to)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    };
  });
}

function totalsOf(value: { shifts: number; workedMinutes: number; salesNetMills: number; perHourMills: number | null }): Totals {
  return { shifts: value.shifts, workedMinutes: value.workedMinutes, salesNetMills: value.salesNetMills, perHourMills: value.perHourMills };
}

/** The grid's columns of a window before Hub answered (the skeleton of the same shape). */
export function windowColumns(window: ShiftsWindow, today: MoscowDay): GridColumn[] {
  return columnsOf(Array.from({ length: daysInRange(window.from, window.to) }, (_, index) => addDays(window.from, index)), today, null);
}

// ─────────────────────────────────────────────────────────── Outliers

/** The team's usual shift for the period: the medians of its shifts. */
export interface TeamNorms {
  replyMedianSeconds: number | null;
  unansweredAtEnd: number | null;
  aiUneditedShare: number | null;
}

export const NO_NORMS: TeamNorms = { replyMedianSeconds: null, unansweredAtEnd: null, aiUneditedShare: null };

/**
 * The team's usual shift of the window: every shift of the whole team whose
 * middle falls in it (as Hub puts a shift on a day), whatever page is picked —
 * the quality numbers are the whole shift's, so a page filter never makes the
 * same number an outlier or not.
 */
function normsOf(numbers: NumbersResponse | undefined, window: ShiftsWindow): TeamNorms {
  if (!numbers) return NO_NORMS;
  const from = Date.parse(moscowDayStart(window.from));
  const to = Date.parse(moscowDayEnd(window.to));
  const known = numbers.chatters.flatMap((chatter) => chatter.shifts)
    .filter((shift) => {
      const middle = (Date.parse(shift.startedAt) + Date.parse(shift.endedAt)) / 2;
      return middle >= from && middle < to;
    })
    .map((shift) => qualityOfChatterNumbers(shift.numbers));
  return {
    replyMedianSeconds: median(known.flatMap((one) => (one.replyMedianSeconds === null ? [] : [one.replyMedianSeconds]))),
    unansweredAtEnd: median(known.map((one) => one.unansweredAtEnd)),
    aiUneditedShare: median(known.flatMap((one) => (one.aiUneditedShare === null ? [] : [one.aiUneditedShare]))),
  };
}

/** Rules of a quiet mark (one calm colour, no grading): a shift far from the team's usual. */
export const OUTLIER = {
  /** Answers twice as slow as the team's usual shift, and slower than the owner's norm («5–10 минут», its upper end). */
  replyTimes: 2,
  replyFloorSeconds: 10 * 60,
  /** Twice as many fans left waiting, and at least this many. */
  unansweredTimes: 2,
  unansweredFloor: 3,
  /** «ИИ без правки» this far above the team's usual (percentage points), and at least half of the texts. */
  aiAbovePoints: 0.25,
  aiFloor: 0.5,
} as const;

export function slowReply(quality: ShiftQuality, norms: TeamNorms): boolean {
  const value = quality.replyMedianSeconds;
  return value !== null && norms.replyMedianSeconds !== null
    && value >= OUTLIER.replyFloorSeconds && value >= norms.replyMedianSeconds * OUTLIER.replyTimes;
}

export function manyUnanswered(quality: ShiftQuality, norms: TeamNorms): boolean {
  return norms.unansweredAtEnd !== null && quality.unansweredAtEnd >= OUTLIER.unansweredFloor
    && quality.unansweredAtEnd >= Math.max(1, norms.unansweredAtEnd) * OUTLIER.unansweredTimes;
}

export function muchAi(quality: ShiftQuality, norms: TeamNorms): boolean {
  const value = quality.aiUneditedShare;
  return value !== null && norms.aiUneditedShare !== null && value >= OUTLIER.aiFloor && value >= norms.aiUneditedShare + OUTLIER.aiAbovePoints;
}

// ─────────────────────────────────────────────────────────── The period's model

export function buildModel(sales: SalesResponse, numbers: NumbersResponse | undefined, window: ShiftsWindow, people: PeopleIndex = LOGINS_ONLY): ShiftsModel {
  const today = moscowDayOf(sales.serverNow);
  const knownSince = sales.knownSince === null ? null : moscowDayOf(sales.knownSince);
  // A shift is a login's (its review, its link); its name is the person's.
  const journal = journalOf(sales, numbers).map((shift) => ({ ...shift, username: people.nameOf(shift.userId, shift.username) }));
  const columns = columnsOf(sales.team.daily.map((day) => day.date), today, knownSince);
  const comparable = sales.previous !== null;
  const team: GridRow = {
    userId: null,
    username: "Вся команда",
    totals: totalsOf(sales.team),
    previous: sales.previous === null ? null : totalsOf(sales.previous),
    unmatched: false,
    gone: false,
    cells: cellsOf(columns, sales.team.daily, journal),
  };
  // One row a person: their logins' numbers summed (Hub counts by login; the team's row is Hub's own sum, unchanged).
  const chatters = loginsByPerson(sales.chatters, people).map((chatter): GridRow => ({
    userId: chatter.userId,
    username: chatter.username,
    totals: totalsOf(chatter),
    previous: chatter.previous === null ? null : totalsOf(chatter.previous),
    unmatched: comparable && chatter.previous === null && chatter.shifts > 0,
    // No shift, but money the rule gave them with no work to hold it («вне смен», by name): a row with that money.
    gone: chatter.shifts === 0 && chatter.salesNetMills === 0,
    cells: cellsOf(columns, chatter.daily, journal.filter((shift) => chatter.userIds.includes(shift.userId))),
  }))
    // The owner's or a team lead's login without a shift here is not a row of who works shifts («Люди» lists them so).
    .filter((row) => !row.gone || (row.userId !== null && people.worksShifts(row.userId)));
  // Who worked first (Hub's order: the most money first); who did not, below.
  chatters.sort((left, right) => Number(left.gone) - Number(right.gone));
  return { window, columns, team, chatters, journal, comparable, knownSince, norms: normsOf(numbers, window), today, outside: sales.outside };
}

// ─────────────────────────────────────────────────────────── Reads

export interface ShiftsParams {
  window: ShiftsWindow;
  page: string | null;
  /** The period is still going: its numbers move. */
  current: boolean;
}

/** The period's `teamShiftSales` read: the entry Люди and Выплаты share when they ask for the same. */
function shiftsSalesQuery(window: ShiftsWindow, page: string | null) {
  return shiftSalesQuery({
    days: window.days,
    ...(window.until === undefined ? {} : { until: window.until }),
    ...(page === null ? {} : { pageLabel: page }),
  });
}

/**
 * The period: shifts with money (`teamShiftSales`), then their quality
 * (`teamChatterNumbers`, slower: the journal fills those columns when it answers).
 */
export function useShiftsPeriod({ window, page, current }: ShiftsParams) {
  const sales = useQuery({
    ...shiftsSalesQuery(window, page),
    placeholderData: keepPreviousData,
    refetchInterval: current ? MINUTE : false,
  });
  // The numbers read shifts by their start: a night shift that began the evening before the first day belongs to
  // it. Hub reads at most SHIFTS_MAX_DAYS: a window that long starts at its first midnight.
  const lead = window.days < SHIFTS_MAX_DAYS ? 12 * HOUR : 0;
  const numbersFrom = new Date(Date.parse(moscowDayStart(window.from)) - lead).toISOString();
  const numbersTo = current ? undefined : moscowDayEnd(window.to);
  const numbers = useQuery({
    queryKey: ["shifts", "numbers", numbersFrom, numbersTo ?? "now"] as const,
    queryFn: () => kernel.teamChatterNumbers({ query: numbersTo === undefined ? { from: numbersFrom } : { from: numbersFrom, to: numbersTo } }),
    staleTime: 5 * MINUTE,
    refetchInterval: current ? 5 * MINUTE : false,
  });
  return { sales, numbers };
}

/**
 * What stands between the period's shifts and the reports they are paid by (`shiftReportNotes`): one request for the
 * window and the page, the very parameters of the shifts' own read; everyone's days for the owner, their own for a
 * team lead (Hub decides). Only for the note under a day's last shift: the ledger away (or any other failure) is no
 * line, nothing else.
 */
export function useShiftNotes(window: ShiftsWindow, page: string | null, enabled: boolean) {
  const params = {
    days: window.days,
    ...(window.until === undefined ? {} : { until: window.until }),
    ...(page === null ? {} : { pageLabel: page }),
  };
  const query = useQuery({
    queryKey: ["shifts", "report-notes", params] as const,
    queryFn: () => kernel.shiftReportNotes({ query: params }),
    enabled,
    staleTime: MINUTE,
    retry: false,
  });
  return enabled && query.data !== undefined ? query.data.notes : null;
}

/**
 * «Сейчас на смене», independent of the period: the shifts of the last two
 * Moscow days with their money (a night shift belongs to the day holding most
 * of it), then how many fans wait for each running one.
 */
export function useNowOnShift(page: string | null) {
  const query = { days: 2, ...(page === null ? {} : { pageLabel: page }) };
  const sales = useQuery({
    queryKey: ["shifts", "now", query] as const,
    queryFn: () => kernel.teamShiftSales({ query }),
    refetchInterval: MINUTE,
  });
  const running = sales.data?.shifts.filter((shift) => shift.ongoing) ?? [];
  const earliest = running.reduce<string | null>((first, shift) => (first === null || shift.startedAt < first ? shift.startedAt : first), null);
  const waiting = useQuery({
    queryKey: ["shifts", "now-numbers", earliest] as const,
    queryFn: () => kernel.teamChatterNumbers({ query: { from: earliest! } }),
    enabled: earliest !== null,
    refetchInterval: 2 * MINUTE,
  });

  let state: NowState | undefined;
  if (sales.data) {
    const now = Date.parse(sales.data.serverNow);
    const shifts = running
      .map((shift): NowShift => {
        const found = waiting.data ? numbersFor(shift, waiting.data) : undefined;
        return {
          key: `${shift.userId}:${shift.startedAt}`,
          userId: shift.userId,
          username: shift.username,
          startedAt: shift.startedAt,
          // Going on: up to Hub's «now», the pauses so far only in the hint.
          when: shiftWhen({ startedAt: shift.startedAt, endedAt: Math.max(now, Date.parse(shift.endedAt)), ongoing: true, workedMinutes: shift.workedMinutes }),
          workedMinutes: shift.workedMinutes,
          pages: pagesOf(shift).map((one) => one.pageLabel),
          salesNetMills: shift.salesNetMills,
          messages: shift.authoredMessages,
          waitingNow: waiting.data ? (found ? qualityOfChatterNumbers(found.numbers).unansweredAtEnd : null) : waiting.isError ? null : undefined,
          idle: shiftIdleText(shift, sales.data!.serverNow),
          idleHint: shiftIdleTitle(shift),
        };
      })
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const last = sales.data.shifts
      .filter((shift) => !shift.ongoing)
      .reduce<SalesShift | null>((latest, shift) => (latest === null || shift.endedAt > latest.endedAt ? shift : latest), null);
    state = { shifts, last: last === null ? null : { userId: last.userId, username: last.username, startedAt: last.startedAt, endedAt: last.endedAt } };
  }
  return { state, sales, waiting };
}

// ─────────────────────────────────────────────────────────── Messages without an author

/** The goal: no more than this share without an author of what left while the extension was open. */
export const AUTHORSHIP_GOAL_PERCENT = 5;

export type AuthorshipPage = AuthorshipResponse["pages"][number];
export type AuthorshipCounts = AuthorshipPage["total"];

export interface AuthorshipState {
  from: string;
  to: string;
  pages: AuthorshipPage[];
  total: AuthorshipCounts;
  /** Of what left while the extension was open, without an author, percent; null — nothing left then. */
  inShiftPercent: number | null;
  /** The pages above the goal. */
  above: AuthorshipPage[];
}

export function withoutAuthorPercent(counts: { inShift: number; inShiftAuthored: number }): number | null {
  return counts.inShift === 0 ? null : (100 * (counts.inShift - counts.inShiftAuthored)) / counts.inShift;
}

export function aboveGoal(counts: { inShift: number; inShiftAuthored: number }): boolean {
  const percent = withoutAuthorPercent(counts);
  return percent !== null && percent > AUTHORSHIP_GOAL_PERCENT;
}

/**
 * How many of the pages' personal messages left without an author
 * (`teamAuthorship`). Hub reads it only back from today, at most 7 days: the
 * screen shows it only while the period goes on, with its own dates.
 */
export function useAuthorship(days: number, page: string | null, enabled: boolean) {
  const query = useQuery({
    queryKey: ["shifts", "authorship", days] as const,
    queryFn: () => kernel.teamAuthorship({ query: { days } }),
    enabled,
    staleTime: 5 * MINUTE,
    refetchInterval: enabled ? 5 * MINUTE : false,
  });
  let state: AuthorshipState | undefined;
  if (query.data) {
    const pages = query.data.pages.filter((one) => page === null || one.pageLabel === page);
    const total = pages.reduce<AuthorshipCounts>((sum, one) => ({
      personal: sum.personal + one.total.personal,
      authored: sum.authored + one.total.authored,
      inShift: sum.inShift + one.total.inShift,
      inShiftAuthored: sum.inShiftAuthored + one.total.inShiftAuthored,
    }), { personal: 0, authored: 0, inShift: 0, inShiftAuthored: 0 });
    state = {
      from: query.data.from,
      to: query.data.to,
      pages,
      total,
      inShiftPercent: withoutAuthorPercent(total),
      above: pages.filter((one) => aboveGoal(one.total)),
    };
  }
  return { state, query };
}
