/**
 * The invented agency's ledger: every operation of every page, day by day,
 * generated from the page's daily net in world.ts. Overview, the revenue
 * charts and the operations list all read it, so a sum on one screen is the
 * sum of the rows on the next — the drill-down reconciles, as in the hub.
 */
import { between, daysAgo, demoError, hashString, isoDay, pick, rng, type DemoReply, type DemoRequest } from "../core.ts";
import { DEMO_DATA_PAGES, demoDailyNet, demoFans, demoPage, demoUserByRole, type DemoFan, type DemoPage } from "../world.ts";

export type LedgerType =
  | "subscription"
  | "tip"
  | "message_purchase"
  | "post_purchase"
  | "stream_tip"
  | "chargeback"
  | "refund"
  | "other";

export type LedgerState = "pending" | "posted" | "unknown";

export const LEDGER_BUCKET: Readonly<Record<LedgerType, "revenue" | "adjustment" | "unclassified">> = {
  subscription: "revenue",
  tip: "revenue",
  message_purchase: "revenue",
  post_purchase: "revenue",
  stream_tip: "revenue",
  chargeback: "adjustment",
  refund: "adjustment",
  other: "unclassified",
};

/** The order the hub lists sources in. */
export const LEDGER_TYPES: readonly LedgerType[] = [
  "subscription", "tip", "message_purchase", "post_purchase", "stream_tip", "chargeback", "refund", "other",
];

export interface LedgerTx {
  id: string;
  label: string;
  platform: DemoPage["platform"];
  type: LedgerType;
  rawType: number | string;
  state: LedgerState;
  netMills: number;
  grossMills: number;
  occurredMs: number;
  updatedMs: number | null;
  fan: DemoFan | null;
}

export const DAY_MS = 86_400_000;

/** Raw platform codes: Fansly's ledger integers, OnlyFans' words. */
const FANSLY_RAW: Readonly<Record<LedgerType, number>> = {
  subscription: 15001,
  tip: 7101,
  message_purchase: 2110,
  post_purchase: 2116,
  stream_tip: 45101,
  chargeback: 6102,
  refund: 6101,
  other: 6002,
};
const ONLYFANS_RAW: Readonly<Record<LedgerType, string>> = {
  subscription: "subscription",
  tip: "tip",
  message_purchase: "message",
  post_purchase: "post",
  stream_tip: "stream",
  chargeback: "chargeback",
  refund: "refund",
  other: "other",
};

/** Share of a day's money by source, per platform (and whether the page streams). */
function typeWeights(page: DemoPage): Array<[LedgerType, number]> {
  if (page.platform === "onlyfans") {
    return [["message_purchase", 0.5], ["tip", 0.2], ["subscription", 0.25], ["post_purchase", 0.05]];
  }
  const streams = page.label === "mia-1" || page.label === "nova-1";
  return [
    ["message_purchase", 0.42],
    ["tip", 0.26],
    ["subscription", 0.22],
    ["post_purchase", 0.07],
    ...(streams ? [["stream_tip", 0.03] as [LedgerType, number]] : []),
  ];
}

function weighted<T>(random: () => number, items: ReadonlyArray<[T, number]>): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1]![0];
}

/** A typical price of one operation before the platform's 20 %, dollars. */
function ticket(random: () => number, type: LedgerType): number {
  switch (type) {
    case "subscription": return pick(random, [3.99, 7.99, 7.99, 7.99, 11.99, 19.99]);
    case "tip": return pick(random, [4, 8, 8, 16, 16, 20, 40, 40, 80, 160]);
    case "message_purchase": return pick(random, [7.99, 11.99, 15.99, 19.99, 23.99, 31.99, 39.99, 47.99]);
    case "post_purchase": return pick(random, [3.99, 7.99, 11.99, 15.99]);
    case "stream_tip": return pick(random, [2, 4, 4, 8, 16]);
    default: return between(random, 2, 12);
  }
}

function dayNetMills(label: string, day: string): number {
  const point = demoDailyNet(label, new Date(`${day}T12:00:00Z`), 1)[0];
  return Math.round((point?.net ?? 0) * 1000);
}

const dayCache = new Map<string, LedgerTx[]>();

/** Every operation of a page on one UTC day (the whole day: callers cut at now). */
function generateDay(page: DemoPage, day: string): LedgerTx[] {
  const key = `${page.label}:${day}`;
  const cached = dayCache.get(key);
  if (cached) return cached;
  const target = dayNetMills(page.label, day);
  const random = rng(`ledger:${key}`);
  const weights = typeWeights(page);
  const drafts: Array<{ type: LedgerType; net: number }> = [];
  if (target > 0) {
    // Now and then a refund, a chargeback or an unclassified line; the day's
    // sales cover them, so the day's net stays the world's net.
    if (page.dailyNet >= 50 && random() < 0.05) drafts.push({ type: "refund", net: -Math.round(ticket(random, "message_purchase") * 800) });
    if (page.dailyNet >= 50 && random() < 0.018) drafts.push({ type: "chargeback", net: -Math.round(ticket(random, "tip") * 800) });
    if (random() < 0.03) drafts.push({ type: "other", net: Math.round(between(random, 1, 6) * 1000) });
    let sum = drafts.reduce((total, item) => total + item.net, 0);
    // Sales at the platforms' round prices (the creator's 80 %, in mills)…
    for (let guard = 0; guard < 2_000; guard += 1) {
      const type = weighted(random, weights);
      const net = Math.round(ticket(random, type) * 800);
      if (sum + net > target) break;
      drafts.push({ type, net });
      sum += net;
    }
    // …and the rest of the day as one more tip: tips come in any amount.
    const rest = target - sum;
    if (rest > 0) drafts.push({ type: "tip", net: rest });
  }
  const fans = demoFans(page.label).filter((fan) => fan.totalSpent > 0);
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const items: LedgerTx[] = drafts
    .filter((draft) => draft.net !== 0)
    .map((draft, index) => {
      // US evenings: most money lands between 14:00 and 04:00 UTC.
      const hour = (14 + Math.floor(random() * 14)) % 24;
      const occurredMs = dayStart + hour * 3_600_000 + Math.floor(random() * 3_600_000);
      const fan = fans.length === 0 || random() < 0.012
        ? null
        : fans[Math.floor(random() ** 2.4 * Math.min(fans.length, 160))] ?? null;
      const idSeed = hashString(`${key}:${index}`);
      const gross = draft.net > 0 ? Math.round(draft.net / 0.8) : draft.net;
      return {
        id: page.platform === "fansly"
          ? `8${String(idSeed).padStart(10, "0")}${String(index).padStart(7, "0")}`
          : `${2_400_000_000 + (idSeed % 99_999_999)}`,
        label: page.label,
        platform: page.platform,
        type: draft.type,
        rawType: page.platform === "fansly" ? FANSLY_RAW[draft.type] : ONLYFANS_RAW[draft.type],
        state: "posted" as LedgerState,
        netMills: draft.net,
        grossMills: gross,
        occurredMs,
        updatedMs: random() < 0.85 ? occurredMs + Math.floor(between(random, 30, 1_800)) * 1000 : null,
        fan,
      };
    })
    .sort((left, right) => left.occurredMs - right.occurredMs);
  dayCache.set(key, items);
  return items;
}

/** A page's operations on one day as of `now`: nothing after now, the last
 *  day and a half partly pending. OnlyFans goes on, thinner, from the ChatSpace feed. */
export function ledgerDay(page: DemoPage, day: string, now: Date): LedgerTx[] {
  const nowMs = now.getTime();
  return generateDay(page, day)
    .filter((tx) => tx.occurredMs <= nowMs)
    .map((tx) => {
      const ageHours = (nowMs - tx.occurredMs) / 3_600_000;
      const random = rng(`state:${tx.id}`)();
      const state: LedgerState = ageHours < 36 && random < 0.25 ? "pending" : random > 0.997 ? "unknown" : "posted";
      return state === tx.state ? tx : { ...tx, state };
    });
}

/** UTC days from `fromMs` (inclusive) to `toMs` (exclusive), oldest first. */
export function daysBetween(fromMs: number, toMs: number): string[] {
  const days: string[] = [];
  for (let at = Math.floor(fromMs / DAY_MS) * DAY_MS; at < toMs; at += DAY_MS) days.push(isoDay(new Date(at)));
  return days;
}

/** Every operation of a page inside `[fromMs, toMs)`. */
export function ledgerRange(page: DemoPage, fromMs: number, toMs: number, now: Date): LedgerTx[] {
  const out: LedgerTx[] = [];
  for (const day of daysBetween(fromMs, toMs)) {
    for (const tx of ledgerDay(page, day, now)) {
      if (tx.occurredMs >= fromMs && tx.occurredMs < toMs) out.push(tx);
    }
  }
  return out;
}

/** How far back the hub holds money: a year. */
export const HISTORY_DAYS = 365;

export function historyStartMs(now: Date): number {
  return Date.parse(`${isoDay(daysAgo(now, HISTORY_DAYS - 1))}T00:00:00Z`);
}

export function startOfDayMs(date: Date): number {
  return Date.parse(`${isoDay(date)}T00:00:00Z`);
}

// --- Windows, as the hub resolves a console period ---

export interface PlatformWindow {
  platform: DemoPage["platform"];
  fromMs: number | null;
  toMs: number | null;
  comparisonFromMs: number | null;
  comparisonToMs: number | null;
}

/**
 * A period's window on one platform. Trailing windows end at the end of the
 * current UTC day; OnlyFans' run one day longer (7d spans 8 days), as in the
 * hub (audit B2). "all" has no bounds and no comparison.
 */
export function platformWindow(
  platform: DemoPage["platform"],
  period: string,
  now: Date,
  custom?: { from: string; to: string },
): PlatformWindow {
  const tomorrow = startOfDayMs(now) + DAY_MS;
  let fromMs: number;
  let toMs = tomorrow;
  if (period === "custom" && custom) {
    // The end is exclusive, as `resolveCustomPeriodBounds`; one day when they are equal.
    fromMs = Date.parse(`${custom.from}T00:00:00Z`);
    toMs = Date.parse(`${custom.to}T00:00:00Z`) + (custom.from === custom.to ? DAY_MS : 0);
  } else if (period === "all") {
    return { platform, fromMs: null, toMs: null, comparisonFromMs: null, comparisonToMs: null };
  } else {
    const days = period === "today" ? 1 : period === "30d" ? 30 : period === "90d" ? 90 : 7;
    const extra = platform === "onlyfans" && period !== "today" ? 1 : 0;
    fromMs = tomorrow - (days + extra) * DAY_MS;
  }
  const span = toMs - fromMs;
  return { platform, fromMs, toMs, comparisonFromMs: fromMs - span, comparisonToMs: fromMs };
}

export function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

// --- Sums ---

export interface Totals {
  net: number;
  revenue: number;
  adjustment: number;
  unclassified: number;
  count: number;
  byType: Map<LedgerType, number>;
}

export function emptyTotals(): Totals {
  return { net: 0, revenue: 0, adjustment: 0, unclassified: 0, count: 0, byType: new Map() };
}

export function addTx(totals: Totals, tx: LedgerTx): void {
  totals.net += tx.netMills;
  totals.count += 1;
  const bucket = LEDGER_BUCKET[tx.type];
  if (bucket === "revenue") totals.revenue += tx.netMills;
  else if (bucket === "adjustment") totals.adjustment += tx.netMills;
  else totals.unclassified += tx.netMills;
  totals.byType.set(tx.type, (totals.byType.get(tx.type) ?? 0) + tx.netMills);
}

/** A page's totals over a window; null bounds mean the whole stored history. */
export function pageTotals(page: DemoPage, fromMs: number | null, toMs: number | null, now: Date): Totals {
  const totals = emptyTotals();
  const from = fromMs ?? historyStartMs(now);
  const to = toMs ?? now.getTime() + 1;
  for (const tx of ledgerRange(page, from, to, now)) addTx(totals, tx);
  return totals;
}

/** A change in percent, as the hub reports it; null without a base. */
export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

// --- Who sees what ---

/** The pages the demo's current person may see. */
export function visiblePages(request: DemoRequest): DemoPage[] {
  const user = demoUserByRole(request.role);
  // The revenue reads list the pages the hub syncs: a Telegram page has no money.
  return DEMO_DATA_PAGES.filter((page) => user.pages.includes(page.label));
}

/** A page by its label, or the route's 404. */
export function pageOr404(request: DemoRequest, label: string | undefined): DemoPage | DemoReply {
  const page = label ? demoPage(label) : undefined;
  if (!page || !visiblePages(request).some((item) => item.label === page.label)) {
    return demoError(404, "not_found", `Страница ${label ?? ""} не найдена`);
  }
  return page;
}

/** The money and insights routes answer the owner only. */
export function ownerOnly(request: DemoRequest): DemoReply | null {
  return request.role === "owner" ? null : demoError(403, "forbidden", "Доступно только владельцу");
}
