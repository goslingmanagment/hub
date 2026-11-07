/**
 * Люди and Человек — the data layer (spec §4.3, §4.4). The screens read only
 * this file; query keys start with "people".
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
 *   - `teamShifts` { from } — the last 24 hours: who is on shift NOW (the
 *     status does not follow the period).
 *   - `adminListUsers` (owner) — role, access state, pages, last use of the
 *     extension; `adminAiSpend` (owner) — AI spend by person for the period.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { millsToNumber, sumMills } from "@agency_hub_core/shared";
import { addDays, daysInRange, moscowDayEnd, moscowDayOf } from "@agency_hub_core/ui/moscow";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { kernel } from "@/shared/hub";
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

/** Now, whatever the period. */
export interface PersonNow {
  /** The start of the shift going on now; null — not on a shift. */
  onShiftSince: string | null;
  /** The last moment the person was seen working: a shift's end or the extension's last use. */
  lastSeenAt: string | null;
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

/** How the person answers and writes; all pages. */
export interface PeriodQuality {
  /** Shifts these numbers are of (a shift going on is not counted yet). */
  shifts: number;
  messages: number;
  replies: number;
  replyMedianSeconds: number | null;
  /** Of the replies, answered within an hour. */
  repliesWithinHour: number;
  /** Fans whose message stood unanswered at a shift's end, per shift on average. */
  waitingAtEnd: number;
  /** Messages written with the extension's Reply and Fix, of all messages; null without messages. */
  aiShare: number | null;
  composed: { hand: number; reply: number; fix: number; other: number };
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

/** The per-shift numbers that take long to count. */
export interface ShiftNumbers {
  messages: number;
  replyMedianSeconds: number | null;
  repliesWithinHour: number;
  replies: number;
  waitingAtEnd: number;
  aiShare: number | null;
  ppvSent: number;
  ppvBought: number;
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

function perHour(netMills: number, minutes: number): number | null {
  if (minutes <= 0) return null;
  return Number((BigInt(netMills) * 60n) / BigInt(minutes));
}

function aiShareOf(composed: { reply: number; fix: number }, messages: number): number | null {
  return messages > 0 ? (composed.reply + composed.fix) / messages : null;
}

/** A change in percent; null when there is nothing to compare with. */
export function changePct(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function qualityOf(block: NumbersBlock, shifts: number): PeriodQuality {
  return {
    shifts,
    messages: block.messages,
    replies: block.replies,
    replyMedianSeconds: block.replies > 0 ? block.replyMedianSeconds : null,
    repliesWithinHour: block.repliesWithinHour,
    waitingAtEnd: block.waitingAtEnd,
    aiShare: aiShareOf(block.composed, block.messages),
    composed: block.composed,
  };
}

function shiftNumbersOf(block: NumbersBlock): ShiftNumbers {
  return {
    messages: block.messages,
    replyMedianSeconds: block.replies > 0 ? block.replyMedianSeconds : null,
    repliesWithinHour: block.repliesWithinHour,
    replies: block.replies,
    waitingAtEnd: block.waitingAtEnd,
    aiShare: aiShareOf(block.composed, block.messages),
    ppvSent: block.ppvSent,
    ppvBought: block.ppvBought,
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

function nowOf(userId: number, recent: NowShifts | undefined, periodShifts: readonly ShiftSales["shifts"][number][], user: AdminUser | undefined): PersonNow {
  const mine = (recent ?? []).filter((shift) => shift.userId === userId);
  const going = mine.find((shift) => shift.ongoing) ?? null;
  const lastEnd = latest(
    ...mine.filter((shift) => !shift.ongoing).map((shift) => shift.endedAt),
    ...periodShifts.filter((shift) => shift.userId === userId && !shift.ongoing).map((shift) => shift.endedAt),
  );
  return { onShiftSince: going?.startedAt ?? null, lastSeenAt: latest(lastEnd, user?.lastActiveAt) };
}

// ─────────────────────────────────────────────── Reads (one place each)

/** The period's money of everyone (`teamShiftSales`): the table's and the card's. */
function useShiftSales(period: ResolvedPeriod, page: string | null) {
  const window = salesWindow(period);
  return useQuery({
    queryKey: ["people", "sales", window, page] as const,
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

/** Who is on shift now: the last 24 hours of `teamShifts`. Read every minute while the tab is seen. */
function useNow() {
  return useQuery({
    queryKey: ["people", "now"] as const,
    queryFn: () => kernel.teamShifts({ query: { from: new Date(Date.now() - 24 * 60 * MINUTE).toISOString() } }),
    staleTime: 30_000,
    refetchInterval: MINUTE,
  });
}

/** The accounts (`adminListUsers`): the owner's only. */
function useAccounts(enabled: boolean) {
  return useQuery({
    queryKey: ["people", "accounts"] as const,
    queryFn: () => kernel.adminListUsers(),
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
  /** The team's middle, for the outliers: the median of the people's reply medians, of their unanswered at the end. */
  team: { replyMedianSeconds: number | null; waitingAtEnd: number | null };
  main: ReadState;
  quality: ReadState;
  spend: ReadState;
  /** The period is longer than Hub reads. */
  tooLong: boolean;
  refreshing: boolean;
  updatedAt: number;
  refresh: () => void;
  retryQuality: () => void;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
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
      now: nowOf(chatter.userId, now.data?.shifts, periodShifts, user),
      work: workOf(chatter),
      quality: qualityState !== "ready" ? undefined : counted ? qualityOf(counted.week, counted.week.shifts) : null,
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
    waitingAtEnd: median(working.map((row) => row.quality!.waitingAtEnd)),
  };

  return {
    rows,
    idle,
    disabled,
    team,
    main: stateOfRead(sales, salesWindow(period) !== null),
    quality: qualityState,
    spend: spendState,
    tooLong: salesWindow(period) === null,
    refreshing: sales.isPlaceholderData || (sales.isFetching && sales.data !== undefined),
    updatedAt: sales.dataUpdatedAt,
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
  main: ReadState;
  quality: ReadState;
  tooLong: boolean;
  refreshing: boolean;
  updatedAt: number;
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
    now: nowOf(userId, now.data?.shifts, periodShifts, user),
    work: chatter ? workOf(chatter) : sales.data ? { shifts: 0, workedMinutes: 0, salesNetMills: 0, perHourMills: null, overlapNetMills: 0, previous: null } : null,
    quality: qualityState !== "ready" ? undefined : counted ? qualityOf(counted.week, counted.week.shifts) : null,
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
        perHourMills: perHour(shift.salesNetMills, shift.workedMinutes),
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
    main: stateOfRead(sales, salesWindow(period) !== null),
    quality: qualityState,
    tooLong: salesWindow(period) === null,
    refreshing: sales.isPlaceholderData || (sales.isFetching && sales.data !== undefined),
    updatedAt: sales.dataUpdatedAt,
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
  /** Per page: sales and minutes on it. */
  pages: { pageLabel: string; platform: string | null; netMills: number; sales: number }[];
  /** Personal paid messages by price, against the team on the same pages (the statistics' window). */
  byPrice: RateRow[];
  ppv: { sent: number; bought: number; netMills: number };
  /** Replies to a waiting fan by delay, and whether the fan bought within a day. */
  byDelay: RateRow[];
  /** The window of the price and speed buckets, when it is wider than the period (a past period: up to today). */
  wider: { from: string; to: string } | null;
  /** Fans written to in the period's shifts and, of them, who paid before the shift's end. */
  fans: { written: number; paid: number } | null;
}

const KIND_ORDER: readonly SaleKind[] = ["ppv", "tip", "subscription", "post"];

/** The period's cut of a person's statistics. Pure. */
export function personSalesOf(stats: Stats, period: ResolvedPeriod, today: string, page: string | null): PersonSales {
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
  const topFans = [...fans.values()].sort((a, b) => b.netMills - a.netMills).slice(0, 5);

  const platformOf = new Map(stats.pages.map((one) => [one.pageLabel, one.platform]));
  const pages = new Map<string, { pageLabel: string; platform: string | null; netMills: number; sales: number }>();
  for (const sale of sales) {
    const one = pages.get(sale.pageLabel) ?? { pageLabel: sale.pageLabel, platform: platformOf.get(sale.pageLabel) ?? null, netMills: 0, sales: 0 };
    one.netMills = millsToNumber(sumMills([one.netMills, sale.netMills]));
    one.sales += 1;
    pages.set(sale.pageLabel, one);
  }

  // The buckets are the statistics' whole window: from the period's first day to today.
  const wholeWindow = period.from === addDays(today, -(stats.days - 1)) && period.to === today;

  return {
    byKind,
    totalNetMills,
    topFans,
    pages: [...pages.values()].sort((a, b) => b.netMills - a.netMills),
    byPrice: stats.ppv.byPrice.map((cell) => ({ key: cell.bucket, label: cell.bucket, hits: cell.bought, base: cell.sent, teamHits: cell.teamBought, teamBase: cell.teamSent, netMills: cell.netMills })),
    ppv: { sent: stats.ppv.sent, bought: stats.ppv.bought, netMills: stats.ppv.netMills },
    byDelay: stats.replies.byDelay.map((cell) => ({ key: cell.bucket, label: cell.bucket, hits: cell.bought, base: cell.replies, teamHits: cell.teamBought, teamBase: cell.teamReplies, netMills: null })),
    wider: wholeWindow ? null : { from: addDays(today, -(stats.days - 1)), to: today },
    fans: shifts.length === 0 ? null : {
      written: shifts.reduce((sum, shift) => sum + shift.fansWritten, 0),
      paid: shifts.reduce((sum, shift) => sum + shift.fansPaid, 0),
    },
  };
}
