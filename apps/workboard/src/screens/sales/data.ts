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
 * smallest `days` that reaches its first day (`readWindow`). A period that ends
 * before today is that read minus the read of the days after it (both at once,
 * one answer): every count here belongs to one moment — a message, a reply, a
 * pick, a subscription, a clock hour — so the difference is exactly the period
 * (X2). What is not a sum (a median, distinct fans) the difference cannot give:
 * such a read says so (`partial`) and the screen leaves those numbers out.
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
import { REPLY_FAST_SECONDS, REPLY_NORM_SECONDS } from "@agency_hub_core/ui/shiftReview";
import { kernel } from "@/shared/hub";

// ---------------------------------------------------------------- The window

/** The longest windows Hub reads (contracts: TEAM_SALES_MAX_DAYS, TEAM_COVERAGE_MAX_DAYS, win-back 90). */
export const MAX_DAYS = { sales: 31, coverage: 31, winBack: 90 } as const;

export interface ReadWindow {
  /** What the operation gets: whole Moscow days back from today, today included. */
  days: number;
  /** A period that ends before today: the days after it, read too and taken away. Null: the period runs to today. */
  minusDays: number | null;
  /** The first Moscow day the numbers cover. */
  from: MoscowDay;
  /** The last one: the period's last day (never after today). */
  to: MoscowDay;
  /** The numbers cover exactly the period on screen. */
  exact: boolean;
  /** The period starts earlier than Hub reads: its first days are left out. */
  clipped: boolean;
  /** Nothing of the period is within Hub's reach: there is nothing to read. */
  beyond: boolean;
}

/** The read that gives the period: from its first day (at most `maxDays` back), minus the days after it. Pure. */
export function readWindow(period: Pick<ResolvedPeriod, "from" | "to">, today: MoscowDay, maxDays: number): ReadWindow {
  const wanted = daysInRange(period.from, today);
  const days = Math.max(1, Math.min(wanted, maxDays));
  const from = addDays(today, -(days - 1));
  const to = period.to < today ? period.to : today;
  const beyond = to < from;
  const after = to < today ? daysInRange(addDays(to, 1), today) : 0;
  return {
    days,
    minusDays: after > 0 && !beyond ? after : null,
    from,
    to: beyond ? from : to,
    exact: !beyond && from === period.from && to === period.to,
    clipped: wanted > maxDays,
    beyond,
  };
}

/** The window of an answer: the read's own when it runs to today, else up to the day after the period. Pure. */
function cutTo(whole: { to: string }, after: { from: string }): string {
  return new Date(Math.min(Date.parse(whole.to), Date.parse(after.from) - 1)).toISOString();
}

const nonNegative = (value: number) => Math.max(0, value);

/** `a − b` of two sums of mills, never below zero. Pure. */
function millsMinus(a: number, b: number): number {
  const left = millsFromInteger(a) - millsFromInteger(b);
  return left > 0n ? millsToNumber(left) : 0;
}

/**
 * One read of a window: for a period up to today the operation itself; for an
 * earlier one, the read from its first day and the read of the days after it,
 * fetched together (one moment, one answer), the second taken away.
 */
function useWindowRead<T>(name: string, window: ReadWindow, read: (days: number) => Promise<T>, minus: (whole: T, after: T) => T, enabled = true) {
  return useQuery({
    queryKey: ["sales", name, window.days, window.minusDays] as const,
    queryFn: async () => {
      if (window.minusDays === null) return read(window.days);
      const [whole, after] = await Promise.all([read(window.days), read(window.minusDays)]);
      return minus(whole, after);
    },
    placeholderData: keepPreviousData,
    enabled: enabled && !window.beyond,
  });
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

/** The labels never break inside: «от\u00a0$100» stays one piece at the end of a line. */
export const PRICE_BUCKETS = [
  { key: "upTo10", label: "дешевле\u00a0$10" },
  { key: "10to25", label: "$10–25" },
  { key: "25to50", label: "$25–50" },
  { key: "50to100", label: "$50–100" },
  { key: "over100", label: "от\u00a0$100" },
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

/**
 * The price whose sent PPV brings the most money, among those with a fair
 * sample — and only when there are at least two such prices to choose from:
 * «the best» of one is no news. Pure.
 */
export function bestPrice(cells: readonly PpvCell[]): PpvCell | null {
  const fair = cells.filter((cell) => cell.sent >= MIN_SAMPLE.ppv);
  if (fair.length < 2) return null;
  let best: PpvCell | null = null;
  for (const cell of fair) {
    if (best === null || (perMessageMills(cell) ?? 0) > (perMessageMills(best) ?? 0)) best = cell;
  }
  return best !== null && best.bought > 0 ? best : null;
}

/** A price with too few messages that still shows more money per message than the best: said in words, not drawn. Pure. */
export function richerSmallPrice(cells: readonly PpvCell[], best: PpvCell | null): PpvCell | null {
  if (best === null) return null;
  const bar = perMessageMills(best) ?? 0;
  let found: PpvCell | null = null;
  for (const cell of cells) {
    if (cell.sent === 0 || cell.sent >= MIN_SAMPLE.ppv || cell.bought === 0) continue;
    const value = perMessageMills(cell) ?? 0;
    if (value > bar && (found === null || value > (perMessageMills(found) ?? 0))) found = cell;
  }
  return found;
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

type PpvTable = PpvResponse["pages"][number]["byPrice"];

/** Bucket by bucket (by key), never below zero, a sale never above its sends. Pure. */
function ppvMinus(whole: PpvTable, after: PpvTable): PpvTable {
  return whole.map((cell) => {
    const later = after.find((one) => one.bucket === cell.bucket);
    if (!later) return cell;
    const bought = nonNegative(cell.bought - later.bought);
    return { bucket: cell.bucket, sent: Math.max(bought, nonNegative(cell.sent - later.sent)), bought, netMills: millsMinus(cell.netMills, later.netMills) };
  });
}

/** The PPVs of a period that ended before today: the read from its first day minus the days after it. Pure. */
export function ppvMinusAfter(whole: PpvResponse, after: PpvResponse): PpvResponse {
  const pages = whole.pages.flatMap((page) => {
    const later = after.pages.find((one) => one.pageLabel === page.pageLabel);
    if (!later) return [page];
    const byPrice = ppvMinus(page.byPrice, later.byPrice);
    const total = sumPpv(byPrice);
    return total.sent === 0 ? [] : [{ ...page, total, byPrice, firstPpv: ppvMinus(page.firstPpv, later.firstPpv), withoutAuthor: Math.min(total.sent, nonNegative(page.withoutAuthor - later.withoutAuthor)) }];
  });
  const chatters = whole.chatters.flatMap((chatter) => {
    const later = after.chatters.find((one) => one.userId === chatter.userId);
    if (!later) return [chatter];
    const byPrice = ppvMinus(chatter.byPrice, later.byPrice);
    const total = sumPpv(byPrice);
    return total.sent === 0 ? [] : [{ ...chatter, total, byPrice }];
  });
  return { ...whole, to: cutTo(whole, after), pages, chatters };
}

export function useSalesPpv(window: ReadWindow) {
  return useWindowRead("ppv", window, (days) => kernel.teamSalesPpv({ query: { days } }), ppvMinusAfter);
}

// --------------------------------------------------------------------- Speed

export const DELAY_BUCKETS = [
  { key: "under5m", label: "до 5 мин" },
  { key: "5to15m", label: "5–15 мин" },
  { key: "15to60m", label: "15–60 мин" },
  { key: "1to6h", label: "1–6 ч" },
  { key: "over6h", label: "больше 6 ч" },
] as const;

/** The owner's norm of a reply (07.11): 5–10 minutes — the review's own constants. */
export const REPLY_NORM_MINUTES = { from: REPLY_FAST_SECONDS / 60, to: REPLY_NORM_SECONDS / 60 } as const;

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

type ReplyTable = RepliesResponse["pages"][number]["byDelay"];

function repliesMinus(whole: ReplyTable, after: ReplyTable): ReplyTable {
  return whole.map((cell) => {
    const later = after.find((one) => one.bucket === cell.bucket);
    if (!later) return cell;
    const bought = nonNegative(cell.bought - later.bought);
    return { bucket: cell.bucket, replies: Math.max(bought, nonNegative(cell.replies - later.replies)), bought };
  });
}

/** The replies of a period that ended before today (the same rule as `ppvMinusAfter`). Pure. */
export function repliesMinusAfter(whole: RepliesResponse, after: RepliesResponse): RepliesResponse {
  const cut = <Line extends { byDelay: ReplyTable }>(line: Line, later: Line | undefined): Line[] => {
    if (!later) return [line];
    const byDelay = repliesMinus(line.byDelay, later.byDelay);
    const total = sumReplies(byDelay);
    return total.replies === 0 ? [] : [{ ...line, total, byDelay }];
  };
  return {
    ...whole,
    to: cutTo(whole, after),
    pages: whole.pages.flatMap((page) => cut(page, after.pages.find((one) => one.pageLabel === page.pageLabel))),
    chatters: whole.chatters.flatMap((chatter) => cut(chatter, after.chatters.find((one) => one.userId === chatter.userId))),
  };
}

export function useSalesReplies(window: ReadWindow) {
  return useWindowRead("replies", window, (days) => kernel.teamSalesReplies({ query: { days } }), repliesMinusAfter);
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
  /** An approach: its place in the extension's list, 1… (null: the list is not known). */
  order: number | null;
  /** An approach as the list has it (for the one write). */
  approach: Approach | null;
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

export const NO_COUNTS: WinBackCounts = { attempts: 0, sent: 0, matured72h: 0, replied72h: 0, matured7d: 0, bought7d: 0, matured30d: 0, spent30dMills: 0 };

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

/**
 * The results by approach and by chatter. With the owner's list every approach
 * of it has a row — one nobody picked in the period too (zeros), so the list
 * and its on/off live in the same table (spec r2) — with its place in the list.
 */
export function winBackView(rows: readonly WinBackRow[], approaches: readonly Approach[] | undefined, window: { from: string; to: string }): WinBackView {
  const listed = new Map((approaches ?? []).map((approach, index) => [approach.id, { approach, order: index + 1 }]));
  const group = (kind: "approach" | "chatter"): WinBackLine[] => {
    const byId = new Map<number, WinBackRow[]>();
    for (const row of rows) {
      const id = kind === "approach" ? row.approachId : row.userId;
      const list = byId.get(id);
      if (list) list.push(row);
      else byId.set(id, [row]);
    }
    const lines: WinBackLine[] = [...byId.entries()].map(([id, own]) => {
      const first = own[0]!;
      const known = kind === "approach" ? listed.get(id) : undefined;
      return {
        key: `${kind}:${id}`,
        kind,
        id,
        name: kind === "approach" ? known?.approach.label ?? first.approach : first.username,
        active: known ? known.approach.active : null,
        order: known?.order ?? null,
        approach: known?.approach ?? null,
        counts: sumWinBack(own.map(countsOf)),
        parts: own.map((row) => {
          const part = kind === "approach" ? undefined : listed.get(row.approachId);
          return {
            key: kind === "approach" ? `chatter:${row.userId}` : `approach:${row.approachId}`,
            kind: kind === "approach" ? "chatter" as const : "approach" as const,
            id: kind === "approach" ? row.userId : row.approachId,
            name: kind === "approach" ? row.username : part?.approach.label ?? row.approach,
            active: part ? part.approach.active : null,
            order: part?.order ?? null,
            approach: part?.approach ?? null,
            counts: countsOf(row),
            parts: [],
          };
        }),
      };
    });
    if (kind === "approach") {
      for (const [id, { approach, order }] of listed) {
        if (byId.has(id)) continue;
        lines.push({ key: `approach:${id}`, kind, id, name: approach.label, active: approach.active, order, approach, counts: { ...NO_COUNTS }, parts: [] });
      }
    }
    return lines;
  };
  return { from: window.from, to: window.to, all: sumWinBack(rows.map(countsOf)), approaches: group("approach"), chatters: group("chatter") };
}

/**
 * The last week whose purchases are counted (spec r2, D9): a 14-day read up to
 * today has every attempt older than 7 days matured — those written 7–13 days
 * ago, about one calendar week back. Pure.
 */
export function maturedWeek(rows: readonly WinBackRow[], today: MoscowDay): { from: MoscowDay; to: MoscowDay; bought7d: number; matured7d: number } {
  const total = sumWinBack(rows.map(countsOf));
  return { from: addDays(today, -(LAST_MATURED_DAYS - 1)), to: addDays(today, -7), bought7d: total.bought7d, matured7d: total.matured7d };
}

/** The read behind «the last matured week». */
export const LAST_MATURED_DAYS = 14;

/** That read as a window: 14 days up to today. */
export function lastMaturedWindow(today: MoscowDay): ReadWindow {
  return { days: LAST_MATURED_DAYS, minusDays: null, from: addDays(today, -(LAST_MATURED_DAYS - 1)), to: today, exact: true, clipped: false, beyond: false };
}

/** The picks of a period that ended before today: row by row (approach × chatter), each count never below what follows from it. Pure. */
export function winBackMinusAfter(whole: WinBackResponse, after: WinBackResponse): WinBackResponse {
  const rows = whole.rows.flatMap((row) => {
    const later = after.rows.find((one) => one.approachId === row.approachId && one.userId === row.userId);
    if (!later) return [row];
    const attempts = nonNegative(row.attempts - later.attempts);
    if (attempts === 0) return [];
    const sent = Math.min(attempts, nonNegative(row.sent - later.sent));
    const matured72h = Math.min(sent, nonNegative(row.matured72h - later.matured72h));
    const matured7d = Math.min(sent, nonNegative(row.matured7d - later.matured7d));
    const matured30d = Math.min(sent, nonNegative(row.matured30d - later.matured30d));
    return [{
      ...row,
      attempts,
      sent,
      matured72h,
      replied72h: Math.min(matured72h, nonNegative(row.replied72h - later.replied72h)),
      matured7d,
      bought7d: Math.min(matured7d, nonNegative(row.bought7d - later.bought7d)),
      matured30d,
      spent30dMills: matured30d === 0 ? 0 : millsMinus(row.spent30dMills, later.spent30dMills),
    }];
  });
  return { ...whole, to: cutTo(whole, after), rows };
}

type WinBackResponse = KernelOperationResponse<"teamWinBackResults">;

export function useWinBackResults(window: ReadWindow, enabled = true) {
  return useWindowRead("win-back", window, (days) => kernel.teamWinBackResults({ query: { days } }), winBackMinusAfter, enabled);
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
  /** The read is a difference (a past period): the greetings' medians are not known. */
  partial: boolean;
  /** Hub's list holds its latest 100 broadcasts only: older ones of the period may be missing. */
  listCut: boolean;
}

/** A read of greetings or empty hours: `partial` — a past period, where what is not a sum is unknown. */
type WindowRead<T> = T & { partial?: boolean; listCut?: boolean };
export type GreetingsRead = WindowRead<GreetingsResponse>;
export type EmptyHoursRead = WindowRead<EmptyHoursResponse>;

/** The greetings of a period that ended before today: the counts by subscription; the medians unknown. Pure. */
export function greetingsMinusAfter(whole: GreetingsRead, after: GreetingsRead): GreetingsRead {
  const cutoff = Date.parse(after.from);
  const pages = whole.pages.flatMap((page) => {
    const later = after.pages.find((one) => one.pageLabel === page.pageLabel);
    if (!later) return [{ ...page, greetingMedianSeconds: null }];
    const newSubscribers = nonNegative(page.newSubscribers - later.newSubscribers);
    const greeted = Math.min(newSubscribers, nonNegative(page.greeted - later.greeted));
    const deliveries = nonNegative(page.broadcasts.deliveries - later.broadcasts.deliveries);
    const sent = nonNegative(page.broadcasts.sent - later.broadcasts.sent);
    if (newSubscribers === 0 && sent === 0) return [];
    return [{
      ...page,
      newSubscribers,
      autoWelcomed: Math.min(newSubscribers, nonNegative(page.autoWelcomed - later.autoWelcomed)),
      greeted,
      greetingMedianSeconds: null,
      repliedWithinHour: Math.min(greeted, nonNegative(page.repliedWithinHour - later.repliedWithinHour)),
      boughtGreeted: Math.min(greeted, nonNegative(page.boughtGreeted - later.boughtGreeted)),
      boughtNotGreeted: Math.min(newSubscribers - greeted, nonNegative(page.boughtNotGreeted - later.boughtNotGreeted)),
      recent: Math.min(newSubscribers, nonNegative(page.recent - later.recent)),
      broadcasts: {
        sent,
        deliveries,
        replied: Math.min(deliveries, nonNegative(page.broadcasts.replied - later.broadcasts.replied)),
        bought: Math.min(deliveries, nonNegative(page.broadcasts.bought - later.broadcasts.bought)),
      },
    }];
  });
  return {
    ...whole,
    to: cutTo(whole, after),
    pages,
    broadcasts: whole.broadcasts.filter((cast) => Date.parse(cast.sentAt) < cutoff),
    partial: true,
    listCut: whole.broadcasts.length >= BROADCASTS_MAX,
  };
}

/** The empty hours of a period that ended before today: the hours by the clock; who wrote and waited unknown. Pure. */
export function emptyHoursMinusAfter(whole: EmptyHoursRead, after: EmptyHoursRead): EmptyHoursRead {
  const cutoff = Date.parse(after.from);
  const pages = whole.pages.map((page) => {
    // The page's first shift came after the period: nothing of it was counted.
    if (page.shiftsSince === null || Date.parse(page.shiftsSince) >= cutoff) {
      return { ...page, shiftsSince: null, hoursWithFans: 0, emptyHours: 0, emptyByHour: page.emptyByHour.map(() => 0), fans: 0, payers: 0, waitedOverHour: 0, waitedNetMills: 0 };
    }
    const later = after.pages.find((one) => one.pageLabel === page.pageLabel);
    const hoursWithFans = nonNegative(page.hoursWithFans - (later?.hoursWithFans ?? 0));
    return {
      ...page,
      hoursWithFans,
      emptyHours: Math.min(hoursWithFans, nonNegative(page.emptyHours - (later?.emptyHours ?? 0))),
      emptyByHour: page.emptyByHour.map((value, hour) => nonNegative(value - (later?.emptyByHour[hour] ?? 0))),
      fans: 0,
      payers: 0,
      waitedOverHour: 0,
      waitedNetMills: 0,
    };
  });
  return { ...whole, to: cutTo(whole, after), pages, partial: true };
}

/** Hub's longest broadcast list (contracts: TEAM_BROADCASTS_MAX). */
export const BROADCASTS_MAX = 100;

export function greetingsView(data: GreetingsRead, page: string | null): GreetingsView {
  const pages = data.pages.filter((one) => page === null || one.pageLabel === page);
  const totals: GreetingsTotals = {
    newSubscribers: pages.reduce((sum, one) => sum + one.newSubscribers, 0),
    greeted: pages.reduce((sum, one) => sum + one.greeted, 0),
    boughtGreeted: pages.reduce((sum, one) => sum + one.boughtGreeted, 0),
    notGreeted: pages.reduce((sum, one) => sum + Math.max(0, one.newSubscribers - one.greeted), 0),
    boughtNotGreeted: pages.reduce((sum, one) => sum + one.boughtNotGreeted, 0),
    recent: pages.reduce((sum, one) => sum + one.recent, 0),
  };
  return {
    from: data.from,
    to: data.to,
    pages,
    broadcasts: data.broadcasts.filter((one) => page === null || one.pageLabel === page),
    totals,
    partial: data.partial === true,
    listCut: data.listCut === true || data.broadcasts.length >= BROADCASTS_MAX,
  };
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
  /** The read is a difference (a past period): the hours are known, who wrote and waited in them is not. */
  partial: boolean;
}

const DAY_MS = 86_400_000;

export function coverageView(data: EmptyHoursRead, page: string | null): CoverageView {
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
    partial: data.partial === true,
  };
}

export function useGreetings(window: ReadWindow) {
  return useWindowRead<GreetingsRead>("greetings", window, (days) => kernel.teamGreetings({ query: { days } }), greetingsMinusAfter);
}

export function useEmptyHours(window: ReadWindow) {
  return useWindowRead<EmptyHoursRead>("empty-hours", window, (days) => kernel.teamEmptyHours({ query: { days } }), emptyHoursMinusAfter);
}
