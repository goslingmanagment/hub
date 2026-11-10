/**
 * Люди and Человек — the data layer (spec §4.3, §4.4). The screens read only
 * this file; query keys start with "people", except the shared reads of src/shared/reads.ts.
 *
 * ── The future contract (phase 2, spec §2.7) ───────────────────────────────
 * `teamPeopleSummary { from, to, pageLabel? }` → `{ people: PersonSummary[],
 * team: TeamQuality }`: everyone of the period in ONE request — the state of
 * their access, now (on shift since / last seen), the period's work against the
 * window before, the quality numbers (reply median, unanswered at the end of a
 * shift, AI share) and the AI spend, with the page filter applied by Hub; an
 * unknown `userId` is a 404. And `teamPersonShifts { userId, from, to,
 * pageLabel? }` → `PersonShift[]` with the slow numbers already in each row.
 *
 * ── The phase-1 adapter over today's operations ────────────────────────────
 *   - `teamShiftSales` { days, until?, pageLabel? } — everyone's shifts of the
 *     period with money and the window before, cut at the same point: the
 *     table's money and the card's shifts. One request for the whole team.
 *   - `teamChatterNumbers` { from, to, userId? } — reply median, unanswered at
 *     the end, AI share, per shift and per period. Without `userId` it is one
 *     request for everyone, but slow on production (up to most of a minute):
 *     the quality columns fill in when it answers. All pages: Hub does not cut
 *     it by page.
 *   - `teamChatterStats` { days, userId } — the card only: every sale of the
 *     shifts (the ribbon's beads), the visits, price and reply-speed buckets
 *     against the team, best fans. It counts `days` back from TODAY, so the
 *     card reads from the period's first day to today and keeps the period's
 *     days; the price and speed buckets cannot be cut and say so. Hub answers an
 *     unknown `userId` with the FIRST person: every answer is checked.
 *   - `teamShifts` { from } — the last 7 days (the longest it reads): who is
 *     on shift NOW and when each person's last shift ended (the status does
 *     not follow the period, and never the extension's last use).
 *   - `adminListUsers` (owner) — role, access state, pages;
 *     `adminAiSpend` (owner) — AI spend by person for the period.
 *   - «Продажи → Цена, Скорость» read exactly what «Что продаёт» reads for its
 *     chatter panel — `teamSalesPpv` / `teamSalesReplies` through the sales
 *     group's data layer (`useSalesPpv`, `priceView`, `MIN_SAMPLE`…): one
 *     window, one comparison (everyone together), one small-sample rule, so
 *     one chatter shows the same shares on both screens (X1).
 *
 * The three quality numbers (D1) come only through `qualityOfChatterNumbers`
 * (a shift) and `averageQuality` (a period: «…, в среднем за смену») of the
 * review's rules — never `week.*` or `composed.reply / messages`.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { millsToNumber, sumMills } from "@agency_hub_core/shared";
import { addDays, daysInRange, moscowDayEnd, moscowDayOf } from "@agency_hub_core/ui/moscow";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { median } from "@agency_hub_core/ui/shiftReview";
import { CHATTER_SHIFTS_MAX_WINDOW_DAYS } from "@agency_hub_core/contracts";
import { kernel } from "@/shared/hub";
import { shiftSalesQuery, usersQuery } from "@/shared/reads";
import { MAX_DAYS, MIN_SAMPLE, priceView, readWindow, speedView, useSalesPpv, useSalesReplies, type ReadWindow } from "@/screens/sales/data";
import { averageQuality, perHourMills, qualityOfChatterNumbers, type PeriodQuality as AveragedQuality, type ShiftQuality } from "@/shared/metrics";
import { useMe } from "@/shared/useMe";

const MINUTE = 60_000;
/** The longest window of every team read Hub has today. */
export const READ_MAX_DAYS = 31;

type ShiftSales = KernelOperationResponse<"teamShiftSales">;
type ChatterNumbersAnswer = KernelOperationResponse<"teamChatterNumbers">;
type ChatterStatsAnswer = KernelOperationResponse<"teamChatterStats">;
type AdminUser = KernelOperationResponse<"adminListUsers">[number];
type NumbersBlock = ChatterNumbersAnswer["chatters"][number]["shifts"][number]["numbers"];
export type Stats = NonNullable<ChatterStatsAnswer["stats"]>;
export type SaleKind = Stats["shifts"][number]["sales"][number]["kind"];

// ─────────────────────────────────────────────── The future contract's shapes

export type PersonRole = "owner" | "team_lead" | "chatter";
export type PersonState = "active" | "invited" | "disabled";

/** Now, whatever the period: from the shifts only. */
export interface PersonNow {
  /** The start of the shift going on now; null — not on a shift. */
  onShiftSince: string | null;
  /** The end of the person's last shift Hub was asked about; null — none in `quietDays`. */
  lastShiftEnd: string | null;
  /** How many days back «no shift» is known (the reads' reach); 0 — not known. */
  quietDays: number;
}

export interface WorkTotals {
  shifts: number;
  workedMinutes: number;
  salesNetMills: number;
  /** Per worked hour; null without worked time. */
  perHourMills: number | null;
}

/** The period's work, against the window of the same length right before (cut at the same point). */
export interface PeriodWork extends WorkTotals {
  /** Of `salesNetMills`: sales another chatter's shift holds too. */
  overlapNetMills: number;
  /** null — Hub did not have the person's activity for the whole window before. */
  previous: WorkTotals | null;
}

/**
 * How the person answers and writes, all pages: the three numbers of the
 * review's rules, each the average over the period's finished shifts
 * («…, в среднем за смену»), and how many replies came within an hour.
 */
export interface PeriodQuality extends AveragedQuality {
  replies: number;
  /** Of the replies, answered within an hour. */
  repliesWithinHour: number;
}

/** One row of «Люди»: the future `teamPeopleSummary.people[]`. */
export interface PersonSummary {
  userId: number;
  username: string;
  /** null — not known to this viewer (a team lead does not read the accounts). */
  role: PersonRole | null;
  state: PersonState | null;
  disabledAt: string | null;
  pages: string[];
  now: PersonNow;
  /** null — no shift in the period nor in the window before. */
  work: PeriodWork | null;
  /** undefined — not here (still being read, or Hub did not answer: see the list's `quality` state); null — none (no finished shift). */
  quality: PeriodQuality | null | undefined;
  /** undefined — still being read or not the viewer's to see; null — none. */
  aiSpendMicroUsd: number | null | undefined;
}

/** A person outside the table: no shift in the period. */
export interface PersonRef {
  userId: number;
  username: string;
  state: PersonState;
  disabledAt: string | null;
  role: PersonRole;
}

/** One sale of a shift: a bead on the ribbon. */
export interface ShiftSale {
  at: string;
  netMills: number;
  kind: SaleKind;
  pageLabel: string;
  fanName: string | null;
  /** Another chatter's shift holds it too, and neither wrote to the fan. */
  overlap: boolean;
}

/** The per-shift numbers that take long to count: the review's three (D1), and the replies within an hour. */
export interface ShiftNumbers extends ShiftQuality {
  messages: number;
  replies: number;
  repliesWithinHour: number;
}

/** One shift of the person: the future `teamPersonShifts[]`. */
export interface PersonShift {
  startedAt: string;
  endedAt: string;
  ongoing: boolean;
  /** The Moscow day holding most of the shift. */
  date: string;
  workedMinutes: number;
  pauses: { from: string; to: string }[];
  /** The pages it worked, the most messages first. */
  pages: string[];
  salesNetMills: number;
  overlapNetMills: number;
  sales: number;
  perHourMills: number | null;
  /** undefined — not here (still being read, or Hub did not answer); null — none for this shift (it goes on). */
  numbers: ShiftNumbers | null | undefined;
  /** Every sale, for the ribbon; undefined — not read (the period is older than Hub reads). */
  saleList: ShiftSale[] | undefined;
}

/** Work outside a shift (too short or too few messages): not in the money. */
export interface PersonVisit {
  startedAt: string;
  endedAt: string;
  workedMinutes: number;
  messages: number;
}

// ─────────────────────────────────────────────── Windows of today's operations

/** The period as `teamShiftSales` takes it: `days` up to `until`. null — longer than Hub reads. */
export function salesWindow(period: ResolvedPeriod): { days: number; until?: string } | null {
  if (period.days > READ_MAX_DAYS) return null;
  const spec = period.spec;
  if (spec.kind === "week") return { days: 7, until: addDays(spec.monday, 6) };
  if (spec.kind === "range") return { days: period.days, until: period.to };
  return { days: period.days };
}

/** The period as `teamChatterNumbers` takes it: `[from, to)` instants. A week ends on its Sunday even while it goes on. */
export function numbersWindow(period: ResolvedPeriod): { from: string; to: string } | null {
  if (period.days > READ_MAX_DAYS) return null;
  const last = period.spec.kind === "week" ? addDays(period.spec.monday, 6) : period.to;
  return { from: period.startsAt, to: moscowDayEnd(last) };
}

/** `teamChatterStats` counts days back from today: from the period's first day to today. null — further back than Hub reads. */
export function statsDays(period: ResolvedPeriod, today: string): number | null {
  const days = daysInRange(period.from, today);
  return days > READ_MAX_DAYS ? null : days;
}

// ─────────────────────────────────────────────── Small pure helpers

function shiftNumbersOf(block: NumbersBlock): ShiftNumbers {
  return {
    ...qualityOfChatterNumbers(block),
    messages: block.messages,
    replies: block.replies,
    repliesWithinHour: block.repliesWithinHour,
  };
}

type CountedShift = ChatterNumbersAnswer["chatters"][number]["shifts"][number];

/** The period's quality: the average over its finished shifts (a shift going on is not counted yet); null — none finished. */
function qualityOf(shifts: readonly CountedShift[]): PeriodQuality | null {
  const done = shifts.filter((shift) => !shift.ongoing);
  if (done.length === 0) return null;
  return {
    ...averageQuality(done.map((shift) => qualityOfChatterNumbers(shift.numbers))),
    replies: done.reduce((sum, shift) => sum + shift.numbers.replies, 0),
    repliesWithinHour: done.reduce((sum, shift) => sum + shift.numbers.repliesWithinHour, 0),
  };
}

const ROLES: ReadonlySet<string> = new Set(["owner", "team_lead", "chatter"]);

function stateOf(user: AdminUser): PersonState {
  if (user.disabledAt) return "disabled";
  return user.registrationState === "invited" ? "invited" : "active";
}

function latest(...values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const value of values) if (value && (best === null || value > best)) best = value;
  return best;
}

type NowShifts = KernelOperationResponse<"teamShifts">["shifts"];

/**
 * Now, from the shifts only: the last 7 days of every page (`recent`) and,
 * when the period runs to today on all pages, its shifts too (they reach
 * further back). Not the extension's last use: an open tab is not work (Л1).
 */
function nowOf(
  userId: number,
  recent: NowShifts | undefined,
  periodShifts: readonly ShiftSales["shifts"][number][],
  reach: { periodToday: boolean; periodDays: number },
): PersonNow {
  if (recent === undefined) return { onShiftSince: null, lastShiftEnd: null, quietDays: 0 };
  const mine = recent.filter((shift) => shift.userId === userId);
  const going = mine.find((shift) => shift.ongoing) ?? null;
  const fromPeriod = reach.periodToday ? periodShifts.filter((shift) => shift.userId === userId && !shift.ongoing) : [];
  const lastShiftEnd = latest(
    ...mine.filter((shift) => !shift.ongoing).map((shift) => shift.endedAt),
    ...fromPeriod.map((shift) => shift.endedAt),
  );
  const quietDays = Math.max(NOW_DAYS, reach.periodToday ? reach.periodDays : 0);
  return { onShiftSince: going?.startedAt ?? null, lastShiftEnd, quietDays };
}

// ─────────────────────────────────────────────── Reads (one place each)

/** The period's money of everyone (`teamShiftSales`): the table's and the card's. */
function useShiftSales(period: ResolvedPeriod, page: string | null) {
  const window = salesWindow(period);
  // A period Hub reads is the entry Смены and Выплаты share for the same request; a longer one is never read
  // by itself and keeps its own key (only «Обновлено» asks for it, as before).
  const shared = window === null ? null : shiftSalesQuery({ ...window, ...(page ? { pageLabel: page } : {}) });
  return useQuery<ShiftSales, Error, ShiftSales, readonly unknown[]>({
    queryKey: shared?.queryKey ?? ["people", "sales", window, page],
    queryFn: () => kernel.teamShiftSales({ query: { ...window!, ...(page ? { pageLabel: page } : {}) } }),
    enabled: window !== null,
    // A period going on moves: a shift earns. A closed one does not change.
    refetchInterval: period.current ? 2 * MINUTE : false,
    placeholderData: keepPreviousData,
  });
}

/** The slow numbers (`teamChatterNumbers`): everyone, or one person. */
function useNumbers(period: ResolvedPeriod, userId?: number) {
  const window = numbersWindow(period);
  return useQuery({
    queryKey: ["people", "numbers", window, userId ?? null] as const,
    queryFn: () => kernel.teamChatterNumbers({ query: { ...window!, ...(userId === undefined ? {} : { userId }) } }),
    enabled: window !== null,
    staleTime: 5 * MINUTE,
    // One person's numbers take seconds and follow a period going on; everyone's take up to a
    // minute on production, so they are read again only on «Обновлено…» or a new period.
    refetchInterval: period.current && userId !== undefined ? 5 * MINUTE : false,
  });
}

/** How far back `teamShifts` reads: the person's last shift is known this far. */
const NOW_DAYS = CHATTER_SHIFTS_MAX_WINDOW_DAYS;

/** Who is on shift now and when each person's last shift ended: the last 7 days of `teamShifts`, every page. Read every minute while the tab is seen. */
function useNow() {
  return useQuery({
    queryKey: ["people", "now"] as const,
    // A minute short of the longest window, so the clocks of Hub and the browser never make it too long.
    queryFn: () => kernel.teamShifts({ query: { from: new Date(Date.now() - NOW_DAYS * 24 * 60 * MINUTE + MINUTE).toISOString() } }),
    staleTime: 30_000,
    refetchInterval: MINUTE,
  });
}

/** The accounts (`adminListUsers`): the owner's only. */
function useAccounts(enabled: boolean) {
  return useQuery({
    ...usersQuery,
    enabled,
    staleTime: MINUTE,
  });
}

/** AI spend by person for the period's days (`adminAiSpend`): the owner's only. */
function useAiSpend(period: ResolvedPeriod, enabled: boolean) {
  return useQuery({
    queryKey: ["people", "ai", period.from, period.to] as const,
    queryFn: () => kernel.adminAiSpend({ query: { from: period.from, to: period.to } }),
    enabled,
    staleTime: 5 * MINUTE,
    select: (answer) => new Map(answer.breakdowns.chatter.map((row) => [row.key, row.costMicroUsd])),
  });
}

/** A read's state for the screen: still coming, here, or failed (not a zero). */
export type ReadState = "loading" | "ready" | "failed" | "off";

function stateOfRead(query: { isPending: boolean; isError: boolean; data?: unknown }, enabled = true): ReadState {
  if (!enabled) return "off";
  if (query.data !== undefined) return "ready";
  if (query.isError) return "failed";
  return "loading";
}

/** How far the period's own shifts tell the last shift: only a period that runs to today, on every page. */
function reachOf(period: ResolvedPeriod, page: string | null): { periodToday: boolean; periodDays: number } {
  return { periodToday: period.current && page === null, periodDays: period.shownDays };
}

function workOf(chatter: ShiftSales["chatters"][number]): PeriodWork {
  return {
    shifts: chatter.shifts,
    workedMinutes: chatter.workedMinutes,
    salesNetMills: chatter.salesNetMills,
    perHourMills: chatter.perHourMills,
    overlapNetMills: chatter.overlapNetMills,
    previous: chatter.previous,
  };
}

// ─────────────────────────────────────────────── «Люди»

export interface PeopleList {
  /** Everyone with a shift in the period or the window before (and not switched off without one now). */
  rows: PersonSummary[];
  /** Active people without a shift in either window (the owner sees them). */
  idle: PersonRef[];
  /** Switched off, without a shift in the period. */
  disabled: PersonRef[];
  /** The team's middle, for the outliers: the median of the people's averages. */
  team: { replyMedianSeconds: number | null; unansweredAtEnd: number | null };
  /** Someone has a whole window before to compare with; false — nobody (Hub has not counted shifts that long). */
  comparable: boolean;
  /** The first day Hub has anyone's activity. */
  knownSince: string | null;
  main: ReadState;
  quality: ReadState;
  spend: ReadState;
  /** The period is longer than Hub reads. */
  tooLong: boolean;
  refreshing: boolean;
  updatedAt: number;
  /** The last read again failed: the numbers are of `updatedAt`. */
  stale: boolean;
  refresh: () => void;
  retryQuality: () => void;
}

export function usePeopleList(period: ResolvedPeriod, page: string | null): PeopleList {
  const { isOwner } = useMe();
  const sales = useShiftSales(period, page);
  const numbers = useNumbers(period);
  const now = useNow();
  const accounts = useAccounts(isOwner);
  const spend = useAiSpend(period, isOwner);

  const users = accounts.data ?? [];
  const byId = new Map(users.map((user) => [user.id, user]));
  const periodShifts = sales.data?.shifts ?? [];
  const reach = reachOf(period, page);
  const numbersById = new Map((numbers.data?.chatters ?? []).map((chatter) => [chatter.userId, chatter]));
  const qualityState = stateOfRead(numbers, numbersWindow(period) !== null);
  const spendState = stateOfRead(spend, isOwner);

  const rows: PersonSummary[] = [];
  const disabled: PersonRef[] = [];
  const listed = new Set<number>();
  for (const chatter of sales.data?.chatters ?? []) {
    const user = byId.get(chatter.userId);
    const state = user ? stateOf(user) : null;
    listed.add(chatter.userId);
    if (state === "disabled" && chatter.shifts === 0) {
      disabled.push({ userId: chatter.userId, username: chatter.username, state, disabledAt: user!.disabledAt, role: (ROLES.has(user!.role) ? user!.role : "chatter") as PersonRole });
      continue;
    }
    const counted = numbersById.get(chatter.userId);
    rows.push({
      userId: chatter.userId,
      username: chatter.username,
      role: user && ROLES.has(user.role) ? (user.role as PersonRole) : null,
      state,
      disabledAt: user?.disabledAt ?? null,
      pages: user?.assignedPages.map((ref) => ref.label) ?? [],
      now: nowOf(chatter.userId, now.data?.shifts, periodShifts, reach),
      work: workOf(chatter),
      quality: qualityState !== "ready" ? undefined : counted ? qualityOf(counted.shifts) : null,
      aiSpendMicroUsd: spendState === "ready" ? (spend.data!.get(String(chatter.userId)) ?? null) : undefined,
    });
  }

  const idle: PersonRef[] = [];
  for (const user of users) {
    if (listed.has(user.id) || user.deletedAt || user.role === "owner") continue;
    // Under a page filter, only the people of that page.
    if (page !== null && !user.assignedPages.some((ref) => ref.label === page)) continue;
    const ref: PersonRef = { userId: user.id, username: user.username, state: stateOf(user), disabledAt: user.disabledAt, role: (ROLES.has(user.role) ? user.role : "chatter") as PersonRole };
    if (ref.state === "disabled") disabled.push(ref);
    else idle.push(ref);
  }
  idle.sort((a, b) => a.username.localeCompare(b.username, "ru"));
  disabled.sort((a, b) => (b.disabledAt ?? "").localeCompare(a.disabledAt ?? ""));

  const working = rows.filter((row) => row.quality);
  const team = {
    replyMedianSeconds: median(working.map((row) => row.quality!.replyMedianSeconds).filter((value): value is number => value !== null)),
    unansweredAtEnd: median(working.map((row) => row.quality!.unansweredAtEnd).filter((value): value is number => value !== null)),
  };

  return {
    rows,
    idle,
    disabled,
    team,
    comparable: sales.data === undefined || (sales.data.previous !== null && rows.some((row) => row.work?.previous)),
    knownSince: sales.data?.knownSince ? moscowDayOf(sales.data.knownSince) : null,
    main: stateOfRead(sales, salesWindow(period) !== null),
    quality: qualityState,
    spend: spendState,
    tooLong: salesWindow(period) === null,
    refreshing: sales.isPlaceholderData || (sales.isFetching && sales.data !== undefined),
    updatedAt: sales.dataUpdatedAt,
    stale: sales.isRefetchError,
    refresh: () => {
      void sales.refetch();
      void numbers.refetch();
      void now.refetch();
      if (isOwner) {
        void accounts.refetch();
        void spend.refetch();
      }
    },
    retryQuality: () => void numbers.refetch(),
  };
}

// ─────────────────────────────────────────────── «Человек»

export interface PersonCard {
  /** null while not known; `missing` — Hub has no such person on the viewer's pages. */
  person: PersonSummary | null;
  missing: boolean;
  shifts: PersonShift[];
  visits: PersonVisit[];
  /** The first day Hub has the person's activity; before it the days are unknown, not empty. */
  knownSince: string | null;
  /** The sales of the shifts are read (the ribbon's beads). */
  salesRead: ReadState;
  /** Who is on shift now is known (the header's status): until then the status is a placeholder, so the line never moves. */
  nowKnown: boolean;
  main: ReadState;
  quality: ReadState;
  tooLong: boolean;
  refreshing: boolean;
  updatedAt: number;
  /** The last read again failed: the numbers are of `updatedAt`. */
  stale: boolean;
  refresh: () => void;
  retryQuality: () => void;
}

/** One person's statistics (`teamChatterStats`), checked to be theirs. Shared by the card's tabs. */
export function usePersonStats(userId: number, period: ResolvedPeriod, today: string) {
  const days = statsDays(period, today);
  const query = useQuery({
    queryKey: ["people", "stats", userId, days] as const,
    queryFn: () => kernel.teamChatterStats({ query: { days: days!, userId } }),
    enabled: days !== null && Number.isInteger(userId) && userId > 0,
    staleTime: MINUTE,
    refetchInterval: period.current ? 5 * MINUTE : false,
    // A new period keeps the same person's numbers until theirs come; never a neighbour's (the key holds the id).
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === userId ? previous : undefined),
  });
  const answer = query.data?.stats ?? null;
  // Hub answers an unknown id with the first person it knows: only the asked one's numbers count.
  const stats = answer && answer.user.userId === userId ? answer : null;
  const inPeriod = (date: string) => date >= period.from && date <= period.to;
  return {
    query,
    days,
    stats,
    /** The answer came and is someone else's (or nobody's). */
    stranger: query.data !== undefined && stats === null,
    inPeriod,
  };
}

export function usePersonCard(userId: number, period: ResolvedPeriod, page: string | null, today: string): PersonCard {
  const { isOwner } = useMe();
  const sales = useShiftSales(period, page);
  const numbers = useNumbers(period, userId);
  const now = useNow();
  const accounts = useAccounts(isOwner);
  const spend = useAiSpend(period, isOwner);
  const statsRead = usePersonStats(userId, period, today);
  const { stats } = statsRead;

  const user = accounts.data?.find((one) => one.id === userId && !one.deletedAt);
  const chatter = sales.data?.chatters.find((one) => one.userId === userId);
  const periodShifts = sales.data?.shifts ?? [];
  const reach = reachOf(period, page);
  const counted = numbers.data?.chatters.find((one) => one.userId === userId);
  const qualityState = stateOfRead(numbers, numbersWindow(period) !== null);
  const spendState = stateOfRead(spend, isOwner);

  const username = user?.username ?? chatter?.username ?? stats?.user.username ?? null;
  const known = username !== null;
  const settled = sales.data !== undefined && (!isOwner || accounts.data !== undefined) && (statsRead.days === null || !statsRead.query.isPending);
  const missing = settled && !known;

  const person: PersonSummary | null = username === null ? null : {
    userId,
    username,
    role: user && ROLES.has(user.role) ? (user.role as PersonRole) : null,
    state: user ? stateOf(user) : null,
    disabledAt: user?.disabledAt ?? null,
    pages: user ? user.assignedPages.map((ref) => ref.label) : (stats?.pages.map((one) => one.pageLabel) ?? []),
    now: nowOf(userId, now.data?.shifts, periodShifts, reach),
    work: chatter ? workOf(chatter) : sales.data ? { shifts: 0, workedMinutes: 0, salesNetMills: 0, perHourMills: null, overlapNetMills: 0, previous: null } : null,
    quality: qualityState !== "ready" ? undefined : counted ? qualityOf(counted.shifts) : null,
    aiSpendMicroUsd: spendState === "ready" ? (spend.data!.get(String(userId)) ?? null) : undefined,
  };

  // The sales of each shift, from the statistics (matched by the start; a page filter keeps that page's).
  const statsShifts = new Map((stats?.shifts ?? []).map((shift) => [shift.startedAt, shift]));
  const numbersByStart = new Map((counted?.shifts ?? []).map((shift) => [shift.startedAt, shift.numbers]));
  const salesRead: ReadState = statsRead.days === null ? "off" : stats ? "ready" : statsRead.query.isError ? "failed" : statsRead.query.isPending ? "loading" : "failed";

  const shifts: PersonShift[] = periodShifts
    .filter((shift) => shift.userId === userId)
    .map((shift) => {
      const fromStats = statsShifts.get(shift.startedAt);
      const block = numbersByStart.get(shift.startedAt);
      const saleList = salesRead === "ready"
        ? (fromStats?.sales ?? []).filter((sale) => page === null || sale.pageLabel === page)
        : undefined;
      return {
        startedAt: shift.startedAt,
        endedAt: shift.endedAt,
        ongoing: shift.ongoing,
        date: shift.date,
        workedMinutes: shift.workedMinutes,
        pauses: shift.pauses,
        pages: shift.pages.map((one) => one.pageLabel),
        salesNetMills: shift.salesNetMills,
        overlapNetMills: shift.overlapNetMills,
        sales: shift.sales,
        perHourMills: perHourMills(shift.salesNetMills, shift.workedMinutes),
        numbers: qualityState !== "ready" ? undefined : block ? shiftNumbersOf(block) : null,
        saleList,
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const visits: PersonVisit[] = (stats?.visits ?? [])
    .filter((visit) => statsRead.inPeriod(visit.date))
    .map((visit) => ({ startedAt: visit.startedAt, endedAt: visit.endedAt, workedMinutes: visit.workedMinutes, messages: visit.messages }));

  const knownSince = stats?.activitySince ?? sales.data?.knownSince ?? null;

  return {
    person,
    missing,
    shifts,
    visits,
    knownSince: knownSince ? moscowDayOf(knownSince) : null,
    salesRead,
    nowKnown: now.data !== undefined || now.isError,
    main: stateOfRead(sales, salesWindow(period) !== null),
    quality: qualityState,
    tooLong: salesWindow(period) === null,
    refreshing: sales.isPlaceholderData || (sales.isFetching && sales.data !== undefined),
    updatedAt: sales.dataUpdatedAt,
    stale: sales.isRefetchError,
    refresh: () => {
      void sales.refetch();
      void numbers.refetch();
      void now.refetch();
      void statsRead.query.refetch();
      if (isOwner) {
        void accounts.refetch();
        void spend.refetch();
      }
    },
    retryQuality: () => void numbers.refetch(),
  };
}

// ─────────────────────────────────────────────── «Продажи» of a person

export interface RateRow {
  key: string;
  label: string;
  /** Of `base`, how many came through (bought). */
  hits: number;
  base: number;
  teamHits: number;
  teamBase: number;
  netMills: number | null;
}

export interface PersonSales {
  /** The period's sales by kind (exact: from the shifts' sales). */
  byKind: { kind: SaleKind; netMills: number }[];
  totalNetMills: number;
  /** The fans who brought the most in the period's shifts, up to five. */
  topFans: { fanName: string | null; pageLabel: string; netMills: number; sales: number }[];
  /** The other paying fans (by name and page) and their money. */
  restFans: { count: number; netMills: number };
  /** Per page: sales and minutes on it. */
  pages: { pageLabel: string; platform: string | null; netMills: number; sales: number }[];
  /** Fans written to in the period's shifts and, of them, who paid before the shift's end (summed over the shifts, every page). */
  fans: { written: number; paid: number } | null;
}

const KIND_ORDER: readonly SaleKind[] = ["ppv", "tip", "subscription", "post"];

/** The period's cut of a person's statistics. Pure. */
export function personSalesOf(stats: Stats, period: ResolvedPeriod, page: string | null): PersonSales {
  const shifts = stats.shifts.filter((shift) => shift.date >= period.from && shift.date <= period.to);
  const sales = shifts.flatMap((shift) => shift.sales).filter((sale) => page === null || sale.pageLabel === page);
  const byKind = KIND_ORDER.map((kind) => ({ kind, netMills: millsToNumber(sumMills(sales.filter((sale) => sale.kind === kind).map((sale) => sale.netMills))) }));
  const totalNetMills = millsToNumber(sumMills(sales.map((sale) => sale.netMills)));

  const fans = new Map<string, { fanName: string | null; pageLabel: string; netMills: number; sales: number }>();
  for (const sale of sales) {
    if (sale.fanName === null) continue;
    const key = `${sale.pageLabel}\u0000${sale.fanName}`;
    const fan = fans.get(key) ?? { fanName: sale.fanName, pageLabel: sale.pageLabel, netMills: 0, sales: 0 };
    fan.netMills = millsToNumber(sumMills([fan.netMills, sale.netMills]));
    fan.sales += 1;
    fans.set(key, fan);
  }
  const ranked = [...fans.values()].sort((a, b) => b.netMills - a.netMills);
  const topFans = ranked.slice(0, 5);
  const rest = ranked.slice(5);
  const restFans = { count: rest.length, netMills: millsToNumber(sumMills(rest.map((fan) => fan.netMills))) };

  const platformOf = new Map(stats.pages.map((one) => [one.pageLabel, one.platform]));
  const pages = new Map<string, { pageLabel: string; platform: string | null; netMills: number; sales: number }>();
  for (const sale of sales) {
    const one = pages.get(sale.pageLabel) ?? { pageLabel: sale.pageLabel, platform: platformOf.get(sale.pageLabel) ?? null, netMills: 0, sales: 0 };
    one.netMills = millsToNumber(sumMills([one.netMills, sale.netMills]));
    one.sales += 1;
    pages.set(sale.pageLabel, one);
  }

  return {
    byKind,
    totalNetMills,
    topFans,
    restFans,
    pages: [...pages.values()].sort((a, b) => b.netMills - a.netMills),
    fans: shifts.length === 0 ? null : {
      written: shifts.reduce((sum, shift) => sum + shift.fansWritten, 0),
      paid: shifts.reduce((sum, shift) => sum + shift.fansPaid, 0),
    },
  };
}

// ─────────────────────────────────────────────── «Продажи → Цена, Скорость» of a person

export interface PersonRates {
  /** The window both reads cover (the panel's own): the period, or as much of it as Hub reads. */
  window: ReadWindow;
  /** The person's paid messages by price against everyone together; null — not here yet or failed (see `price`). */
  byPrice: RateRow[] | null;
  /** The person's replies by delay and whether the fan bought within a day, against everyone together. */
  byDelay: RateRow[] | null;
  price: ReadState;
  speed: ReadState;
  /** Below these samples a share is shown pale, «4 из 14»: the panel's rule. */
  min: { ppv: number; replies: number };
  retry: () => void;
}

/**
 * The person's prices and reply speeds as «Что продаёт» shows them in its
 * chatter panel (X1): the same reads and window, the same comparison —
 * everyone together on the pages on screen — and the same small sample.
 * The person's own numbers cover every page: Hub does not split a chatter by page.
 */
export function usePersonRates(userId: number, period: ResolvedPeriod, today: string, page: string | null): PersonRates {
  const window = readWindow(period, today, MAX_DAYS.sales);
  const ppv = useSalesPpv(window);
  const replies = useSalesReplies(window);
  const price = ppv.data ? priceView(ppv.data, page) : null;
  const speed = replies.data ? speedView(replies.data, page) : null;
  const myPrice = price?.chatters.find((line) => line.userId === userId) ?? null;
  const mySpeed = speed?.chatters.find((line) => line.userId === userId) ?? null;
  const byPrice = price === null ? null : price.all.byPrice.map((team) => {
    const mine = myPrice?.byPrice.find((cell) => cell.bucket === team.bucket);
    return { key: team.bucket, label: team.label, hits: mine?.bought ?? 0, base: mine?.sent ?? 0, teamHits: team.bought, teamBase: team.sent, netMills: mine?.netMills ?? 0 };
  });
  const byDelay = speed === null ? null : speed.all.byDelay.map((team) => {
    const mine = mySpeed?.byDelay.find((cell) => cell.bucket === team.bucket);
    return { key: team.bucket, label: team.label, hits: mine?.bought ?? 0, base: mine?.replies ?? 0, teamHits: team.bought, teamBase: team.replies, netMills: null };
  });
  return {
    window,
    byPrice,
    byDelay,
    price: window.beyond ? "off" : stateOfRead(ppv),
    speed: window.beyond ? "off" : stateOfRead(replies),
    min: { ppv: MIN_SAMPLE.ppv, replies: MIN_SAMPLE.replies },
    retry: () => {
      void ppv.refetch();
      void replies.refetch();
    },
  };
}
