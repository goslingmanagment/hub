/**
 * Что продаёт — the data layer (spec §4.5). The screens read only this file.
 *
 * Phase 1: an adapter over today's operations, which all take `days` (whole
 * Moscow days back from today, today included):
 *   - Цена: `teamSalesPpv` { days ≤ 31 } — PPVs by page, by chatter (`chatters[]`) and price;
 *   - Скорость ответа: `teamSalesReplies` { days ≤ 31 } — reply delay against a purchase within 24 h;
 *   - Возврат фанов: `teamWinBackResults` { days ≤ 90 }, `teamWinBackApproaches` (owner) and the
 *     one write here, `teamWinBackApproachSave` (the console's body and texts:
 *     apps/dashboard/src/pages/team/TeamWinBackPage.tsx:141-178, api/team.ts:89-98);
 *   - Приветствия и охват: `teamGreetings` { days ≤ 31 }, `teamEmptyHours` { days ≤ 31 }.
 *
 * The period of the app (a week Mon–Sun, 14/30 days, a range) becomes the
 * smallest `days` that reaches its first day (`readWindow`): exact for any period
 * that ends today; an earlier one reads up to today, and the screen says so.
 * The page filter narrows the pages here, in the browser (Hub reads every page
 * the viewer reaches); a chatter's numbers cover all pages (Hub has no
 * chatter × page split yet). Both are phase-2 asks (`from`/`to`, `page`).
 *
 * Query keys start with "sales".
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { KernelOperationResponse, TeamWinBackApproachSaveBody } from "@agency_hub_core/contracts";
import { millsFromInteger, millsToNumber, sumMills } from "@agency_hub_core/shared";
import { addDays, daysInRange, type MoscowDay } from "@agency_hub_core/ui/moscow";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { kernel } from "@/shared/hub";

// ---------------------------------------------------------------- The window

/** The longest windows Hub reads (contracts: TEAM_SALES_MAX_DAYS, TEAM_COVERAGE_MAX_DAYS, win-back 90). */
export const MAX_DAYS = { sales: 31, coverage: 31, winBack: 90 } as const;

export interface ReadWindow {
  /** What the operation gets. */
  days: number;
  /** The first Moscow day the read covers. */
  from: MoscowDay;
  /** Today: every read here runs up to now. */
  to: MoscowDay;
  /** The read covers exactly the period on screen. */
  exact: boolean;
  /** The period starts earlier than Hub reads: its first days are left out. */
  clipped: boolean;
}

/** The smallest `days` whose window starts on the period's first day (at most `maxDays`). Pure. */
export function readWindow(period: Pick<ResolvedPeriod, "from" | "to">, today: MoscowDay, maxDays: number): ReadWindow {
  const wanted = daysInRange(period.from, today);
  const days = Math.max(1, Math.min(wanted, maxDays));
  const from = addDays(today, -(days - 1));
  return { days, from, to: today, exact: from === period.from && period.to === today, clipped: wanted > maxDays };
}

// ------------------------------------------------------------- Shared shapes

/** By what a list is cut: the address keeps it (`?by=chatters`). */
export type SalesBy = "pages" | "chatters";

/** A share and its sample: «24 % — 42 из 173». */
export interface Rate {
  hits: number;
  of: number;
}

export function share(rate: Rate): number | null {
  return rate.of > 0 ? rate.hits / rate.of : null;
}

/** Below these samples a share is shown, but quietly, as «2 из 4»: chance, not a fact. */
export const MIN_SAMPLE = { ppv: 20, replies: 20, winBack: 10, greetings: 10 } as const;

// --------------------------------------------------------------------- Price

export const PRICE_BUCKETS = [
  { key: "upTo10", label: "до $10" },
  { key: "10to25", label: "$10–25" },
  { key: "25to50", label: "$25–50" },
  { key: "50to100", label: "$50–100" },
  { key: "over100", label: "от $100" },
] as const;

export interface PpvCounts {
  sent: number;
  bought: number;
  /** Net of the bought ones (after the platform's commission), mills. */
  netMills: number;
}

export interface PpvCell extends PpvCounts {
  bucket: string;
  label: string;
}

/** One page or one chatter: their PPVs by price. */
export interface PpvLine {
  key: string;
  kind: "page" | "chatter";
  name: string;
  userId: number | null;
  platform: string | null;
  total: PpvCounts;
  byPrice: PpvCell[];
  /** A page: of its PPVs, those Hub knows no author of. A chatter: null. */
  withoutAuthor: number | null;
}

export interface PriceView {
  from: string;
  to: string;
  /** The pages on screen, together (every page, or the chosen one). */
  all: PpvLine;
  pages: PpvLine[];
  /** By chatter: PPVs with an author, on every page (Hub does not split a chatter by page). */
  chatters: PpvLine[];
  /** The first PPV of each chat, by its price, the pages on screen together. */
  firstPpv: PpvCell[];
}

type PpvResponse = KernelOperationResponse<"teamSalesPpv">;

function sumPpv(cells: ReadonlyArray<PpvCounts>): PpvCounts {
  return {
    sent: cells.reduce((sum, cell) => sum + cell.sent, 0),
    bought: cells.reduce((sum, cell) => sum + cell.bought, 0),
    netMills: millsToNumber(sumMills(cells.map((cell) => cell.netMills))),
  };
}

/** Every bucket in its order, matched by key (never by position), missing ones as zeros. Pure. */
function priceCells(tables: ReadonlyArray<ReadonlyArray<PpvCounts & { bucket: string }>>): PpvCell[] {
  return PRICE_BUCKETS.map(({ key, label }) => ({
    bucket: key,
    label,
    ...sumPpv(tables.map((table) => table.find((cell) => cell.bucket === key) ?? { sent: 0, bought: 0, netMills: 0 })),
  }));
}

/** Money per one sent PPV, mills (whole): what a price brings, not only how often it is bought. Pure. */
export function perMessageMills(counts: PpvCounts): number | null {
  if (counts.sent === 0) return null;
  return millsToNumber(millsFromInteger(counts.netMills) / BigInt(counts.sent));
}

/** The price whose sent PPV brings the most money, among those with a fair sample. Pure. */
export function bestPrice(cells: readonly PpvCell[]): PpvCell | null {
  let best: PpvCell | null = null;
  for (const cell of cells) {
    if (cell.sent < MIN_SAMPLE.ppv) continue;
    if (best === null || (perMessageMills(cell) ?? 0) > (perMessageMills(best) ?? 0)) best = cell;
  }
  return best !== null && best.bought > 0 ? best : null;
}

/** The share of PPVs sent at the cheapest price (до $10). Pure. */
export function cheapShare(line: Pick<PpvLine, "total" | "byPrice">): number | null {
  const cheap = line.byPrice.find((cell) => cell.bucket === "upTo10");
  return line.total.sent > 0 && cheap ? cheap.sent / line.total.sent : null;
}

export function priceView(data: PpvResponse, page: string | null): PriceView {
  const pages: PpvLine[] = data.pages
    .filter((one) => page === null || one.pageLabel === page)
    .map((one) => ({
      key: `page:${one.pageLabel}`,
      kind: "page",
      name: one.pageLabel,
      userId: null,
      platform: one.platform,
      total: sumPpv([one.total]),
      byPrice: priceCells([one.byPrice]),
      withoutAuthor: one.withoutAuthor,
    }));
  const byPrice = priceCells(data.pages.filter((one) => page === null || one.pageLabel === page).map((one) => one.byPrice));
  const all: PpvLine = {
    key: "all",
    kind: "page",
    name: page ?? "Все страницы",
    userId: null,
    platform: null,
    total: sumPpv(byPrice),
    byPrice,
    withoutAuthor: pages.reduce((sum, one) => sum + (one.withoutAuthor ?? 0), 0),
  };
  const chatters: PpvLine[] = data.chatters.map((one) => ({
    key: `chatter:${one.userId}`,
    kind: "chatter",
    name: one.username,
    userId: one.userId,
    platform: null,
    total: sumPpv([one.total]),
    byPrice: priceCells([one.byPrice]),
    withoutAuthor: null,
  }));
  const firstPpv = priceCells(data.pages.filter((one) => page === null || one.pageLabel === page).map((one) => one.firstPpv));
  return { from: data.from, to: data.to, all, pages, chatters, firstPpv };
}

export function useSalesPpv(days: number) {
  return useQuery({
    queryKey: ["sales", "ppv", days],
    queryFn: () => kernel.teamSalesPpv({ query: { days } }),
    placeholderData: keepPreviousData,
  });
}

// --------------------------------------------------------------------- Speed

export const DELAY_BUCKETS = [
  { key: "under5m", label: "до 5 мин" },
  { key: "5to15m", label: "5–15 мин" },
  { key: "15to60m", label: "15–60 мин" },
  { key: "1to6h", label: "1–6 ч" },
  { key: "over6h", label: "больше 6 ч" },
] as const;

/** The owner's norm of a reply (07.11): 5–10 minutes. */
export const REPLY_NORM_MINUTES = { from: 5, to: 10 } as const;

export interface ReplyCounts {
  replies: number;
  /** Of them: the fan bought within 24 hours after the reply. */
  bought: number;
}

export interface ReplyCell extends ReplyCounts {
  bucket: string;
  label: string;
}

export interface ReplyLine {
  key: string;
  kind: "page" | "chatter";
  name: string;
  userId: number | null;
  total: ReplyCounts;
  byDelay: ReplyCell[];
}

export interface SpeedView {
  from: string;
  /** 24 hours before now: a later reply's day for a purchase is not over. */
  to: string;
  all: ReplyLine;
  pages: ReplyLine[];
  chatters: ReplyLine[];
}

type RepliesResponse = KernelOperationResponse<"teamSalesReplies">;

function sumReplies(cells: ReadonlyArray<ReplyCounts>): ReplyCounts {
  return { replies: cells.reduce((sum, cell) => sum + cell.replies, 0), bought: cells.reduce((sum, cell) => sum + cell.bought, 0) };
}

function delayCells(tables: ReadonlyArray<ReadonlyArray<ReplyCounts & { bucket: string }>>): ReplyCell[] {
  return DELAY_BUCKETS.map(({ key, label }) => ({
    bucket: key,
    label,
    ...sumReplies(tables.map((table) => table.find((cell) => cell.bucket === key) ?? { replies: 0, bought: 0 })),
  }));
}

/** Replies of these buckets together. Pure. */
export function repliesIn(line: Pick<ReplyLine, "byDelay">, buckets: readonly string[]): ReplyCounts {
  return sumReplies(line.byDelay.filter((cell) => buckets.includes(cell.bucket)));
}

export const FAST = ["under5m"] as const;
export const SLOW = ["1to6h", "over6h"] as const;

export function speedView(data: RepliesResponse, page: string | null): SpeedView {
  const shown = data.pages.filter((one) => page === null || one.pageLabel === page);
  const pages: ReplyLine[] = shown.map((one) => ({
    key: `page:${one.pageLabel}`,
    kind: "page",
    name: one.pageLabel,
    userId: null,
    total: sumReplies([one.total]),
    byDelay: delayCells([one.byDelay]),
  }));
  const byDelay = delayCells(shown.map((one) => one.byDelay));
  const chatters: ReplyLine[] = data.chatters.map((one) => ({
    key: `chatter:${one.userId}`,
    kind: "chatter",
    name: one.username,
    userId: one.userId,
    total: sumReplies([one.total]),
    byDelay: delayCells([one.byDelay]),
  }));
  return { from: data.from, to: data.to, all: { key: "all", kind: "page", name: page ?? "Все страницы", userId: null, total: sumReplies(byDelay), byDelay }, pages, chatters };
}

export function useSalesReplies(days: number) {
  return useQuery({
    queryKey: ["sales", "replies", days],
    queryFn: () => kernel.teamSalesReplies({ query: { days } }),
    placeholderData: keepPreviousData,
  });
}

// ------------------------------------------------------------------ Win-back

export interface WinBackCounts {
  /** The chatter picked the approach. */
  attempts: number;
  /** … and wrote to the fan within 48 hours: the funnel's base. */
  sent: number;
  /** Of the written, those 72 hours old, and of them the answered. */
  matured72h: number;
  replied72h: number;
  /** Of the written, those 7 days old, and of them the paying. */
  matured7d: number;
  bought7d: number;
  /** Of the written, those 30 days old, and what those fans paid in the 30 days (gross). */
  matured30d: number;
  spent30dMills: number;
}

export interface WinBackLine {
  key: string;
  kind: "approach" | "chatter";
  id: number;
  name: string;
  /** An approach: whether chatters see it now (null: the viewer may not read the list). A chatter: null. */
  active: boolean | null;
  counts: WinBackCounts;
  /** The other cut: an approach's chatters, a chatter's approaches. */
  parts: WinBackLine[];
}

export interface WinBackView {
  from: string;
  to: string;
  all: WinBackCounts;
  approaches: WinBackLine[];
  chatters: WinBackLine[];
}

type WinBackRow = KernelOperationResponse<"teamWinBackResults">["rows"][number];
export type Approach = KernelOperationResponse<"teamWinBackApproaches">["approaches"][number];

const NO_COUNTS: WinBackCounts = { attempts: 0, sent: 0, matured72h: 0, replied72h: 0, matured7d: 0, bought7d: 0, matured30d: 0, spent30dMills: 0 };

function sumWinBack(rows: ReadonlyArray<WinBackCounts>): WinBackCounts {
  const total = { ...NO_COUNTS };
  for (const row of rows) {
    total.attempts += row.attempts;
    total.sent += row.sent;
    total.matured72h += row.matured72h;
    total.replied72h += row.replied72h;
    total.matured7d += row.matured7d;
    total.bought7d += row.bought7d;
    total.matured30d += row.matured30d;
  }
  total.spent30dMills = millsToNumber(sumMills(rows.map((row) => row.spent30dMills)));
  return total;
}

function countsOf(row: WinBackRow): WinBackCounts {
  return {
    attempts: row.attempts,
    sent: row.sent,
    matured72h: row.matured72h,
    replied72h: row.replied72h,
    matured7d: row.matured7d,
    bought7d: row.bought7d,
    matured30d: row.matured30d,
    spent30dMills: row.spent30dMills,
  };
}

/** Written, but their 7 days are not over: their purchase is not counted yet. Pure. */
export function ripening(counts: WinBackCounts): number {
  return Math.max(0, counts.sent - counts.matured7d);
}

export function winBackView(rows: readonly WinBackRow[], approaches: readonly Approach[] | undefined, window: { from: string; to: string }): WinBackView {
  const activeOf = new Map((approaches ?? []).map((approach) => [approach.id, approach.active]));
  const group = (kind: "approach" | "chatter"): WinBackLine[] => {
    const byId = new Map<number, WinBackRow[]>();
    for (const row of rows) {
      const id = kind === "approach" ? row.approachId : row.userId;
      const list = byId.get(id);
      if (list) list.push(row);
      else byId.set(id, [row]);
    }
    return [...byId.entries()].map(([id, own]) => {
      const first = own[0]!;
      return {
        key: `${kind}:${id}`,
        kind,
        id,
        name: kind === "approach" ? first.approach : first.username,
        active: kind === "approach" ? activeOf.get(id) ?? null : null,
        counts: sumWinBack(own.map(countsOf)),
        parts: own.map((row) => ({
          key: kind === "approach" ? `chatter:${row.userId}` : `approach:${row.approachId}`,
          kind: kind === "approach" ? "chatter" as const : "approach" as const,
          id: kind === "approach" ? row.userId : row.approachId,
          name: kind === "approach" ? row.username : row.approach,
          active: kind === "approach" ? null : activeOf.get(row.approachId) ?? null,
          counts: countsOf(row),
          parts: [],
        })),
      };
    });
  };
  return { from: window.from, to: window.to, all: sumWinBack(rows.map(countsOf)), approaches: group("approach"), chatters: group("chatter") };
}

export function useWinBackResults(days: number) {
  return useQuery({
    queryKey: ["sales", "win-back", days],
    queryFn: () => kernel.teamWinBackResults({ query: { days } }),
    placeholderData: keepPreviousData,
  });
}

const APPROACHES_KEY = ["sales", "win-back-approaches"] as const;

/** The owner's list, retired ones included; the owner only (Hub checks it too). */
export function useWinBackApproaches(enabled: boolean) {
  return useQuery({
    queryKey: APPROACHES_KEY,
    queryFn: () => kernel.teamWinBackApproaches(),
    enabled,
  });
}

/**
 * The one write of the group, as the console's (api/team.ts:89-98): the same
 * operation and body; the answer is the list itself; the results re-read.
 */
export function useSaveWinBackApproach() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: TeamWinBackApproachSaveBody) => kernel.teamWinBackApproachSave({ body }),
    onSuccess: (data) => {
      queryClient.setQueryData(APPROACHES_KEY, data);
      void queryClient.invalidateQueries({ queryKey: ["sales", "win-back"] });
    },
  });
}

// --------------------------------------------------- Greetings and coverage

type GreetingsResponse = KernelOperationResponse<"teamGreetings">;
export type GreetingsPage = GreetingsResponse["pages"][number];
export type Broadcast = GreetingsResponse["broadcasts"][number];
type EmptyHoursResponse = KernelOperationResponse<"teamEmptyHours">;
export type EmptyHoursPage = EmptyHoursResponse["pages"][number];

export interface GreetingsTotals {
  newSubscribers: number;
  greeted: number;
  boughtGreeted: number;
  notGreeted: number;
  boughtNotGreeted: number;
  /** Subscribed less than 7 days ago: their purchases may still come. */
  recent: number;
}

export interface GreetingsView {
  from: string;
  to: string;
  pages: GreetingsPage[];
  broadcasts: Broadcast[];
  totals: GreetingsTotals;
}

export function greetingsView(data: GreetingsResponse, page: string | null): GreetingsView {
  const pages = data.pages.filter((one) => page === null || one.pageLabel === page);
  const totals: GreetingsTotals = {
    newSubscribers: pages.reduce((sum, one) => sum + one.newSubscribers, 0),
    greeted: pages.reduce((sum, one) => sum + one.greeted, 0),
    boughtGreeted: pages.reduce((sum, one) => sum + one.boughtGreeted, 0),
    notGreeted: pages.reduce((sum, one) => sum + Math.max(0, one.newSubscribers - one.greeted), 0),
    boughtNotGreeted: pages.reduce((sum, one) => sum + one.boughtNotGreeted, 0),
    recent: pages.reduce((sum, one) => sum + one.recent, 0),
  };
  return { from: data.from, to: data.to, pages, broadcasts: data.broadcasts.filter((one) => page === null || one.pageLabel === page), totals };
}

export interface EmptyHoursLine extends EmptyHoursPage {
  /** Days the page is counted for (from its first shift in the extension): how often an hour of the clock could be empty. */
  daysCounted: number;
}

export interface CoverageView {
  from: string;
  to: string;
  pages: EmptyHoursLine[];
  /** Pages counted (with shifts in the extension), together. */
  totals: { hoursWithFans: number; emptyHours: number; fans: number; payers: number; waitedOverHour: number; waitedNetMills: number };
}

const DAY_MS = 86_400_000;

export function coverageView(data: EmptyHoursResponse, page: string | null): CoverageView {
  const windowStart = Date.parse(data.from);
  const windowEnd = Date.parse(data.to);
  const pages = data.pages
    .filter((one) => page === null || one.pageLabel === page)
    .map((one) => {
      const start = one.shiftsSince === null ? windowEnd : Math.max(windowStart, Date.parse(one.shiftsSince));
      return { ...one, daysCounted: Math.max(1, Math.ceil((windowEnd - start) / DAY_MS)) };
    });
  const counted = pages.filter((one) => one.shiftsSince !== null);
  return {
    from: data.from,
    to: data.to,
    pages,
    totals: {
      hoursWithFans: counted.reduce((sum, one) => sum + one.hoursWithFans, 0),
      emptyHours: counted.reduce((sum, one) => sum + one.emptyHours, 0),
      fans: counted.reduce((sum, one) => sum + one.fans, 0),
      payers: counted.reduce((sum, one) => sum + one.payers, 0),
      waitedOverHour: counted.reduce((sum, one) => sum + one.waitedOverHour, 0),
      waitedNetMills: millsToNumber(sumMills(counted.map((one) => one.waitedNetMills))),
    },
  };
}

export function useGreetings(days: number) {
  return useQuery({
    queryKey: ["sales", "greetings", days],
    queryFn: () => kernel.teamGreetings({ query: { days } }),
    placeholderData: keepPreviousData,
  });
}

export function useEmptyHours(days: number) {
  return useQuery({
    queryKey: ["sales", "empty-hours", days],
    queryFn: () => kernel.teamEmptyHours({ query: { days } }),
    placeholderData: keepPreviousData,
  });
}
