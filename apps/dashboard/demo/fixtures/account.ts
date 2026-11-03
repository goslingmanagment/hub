import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { between, demoError, hashString, intBetween, iso, queryString, rng, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { demoUserByRole, type DemoUser } from "../world.ts";
import { addDays, chatterWorld, creditedMills, dayRange, DAY_MS, MINUTE_MS, type DemoChatterWorld, type DemoSale } from "./account-model.ts";
import { chatterStats } from "./account-stats.ts";

// Demo answers of this area's screens (see demo/core.ts): the cabinet at
// /account — «Статистика», «Отчёт смены», «Профиль» (devices, AI spend).
// One chatter's working life (account-model.ts) feeds all three.

type ShiftReport = KernelOperationResponse<"accountShiftReport">;
type MyUsage = KernelOperationResponse<"authMyUsage">;
type Devices = KernelOperationResponse<"authListDevices">;

/** Whole days from the query, within the route's bounds; null — a 400. */
function daysOf(request: DemoRequest, max: number, fallback: number): number | null {
  const raw = queryString(request, "days");
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
}

function worldOf(request: DemoRequest): DemoChatterWorld {
  return chatterWorld(demoUserByRole(request.role), request.now);
}

// --- «Отчёт смены» ---

function reportSale(sale: DemoSale, teammates: readonly DemoUser[]): ShiftReport["sharedWithMe"][number] {
  const shareWith = sale.myMark?.shareWith ?? null;
  return {
    saleRef: sale.ref,
    pageLabel: sale.pageLabel,
    platform: sale.platform,
    kind: sale.reportKind,
    fanRef: sale.fan.platformUserId,
    fanName: sale.fanName,
    netMills: sale.netMills,
    occurredAt: iso(new Date(sale.at)),
    ppvSender: sale.ppvSender,
    ppvWithoutAuthor: sale.ppvWithoutAuthor,
    writers: sale.writers,
    withoutAuthor: sale.withoutAuthor,
    confirmed: sale.confirmed,
    myMark: sale.myMark === null ? null : {
      mark: sale.myMark.mark,
      shareWithUserId: shareWith === null ? null : teammates.find((user) => user.username === shareWith)?.id ?? null,
      shareWith,
      amountMills: sale.myMark.amountMills,
      note: sale.myMark.note,
    },
    otherMarks: sale.otherMarks,
  };
}

function shiftReport(request: DemoRequest): ShiftReport | DemoReply {
  const days = daysOf(request, 14, 7);
  if (days === null) return demoError(400, "Bad Request", "querystring/days must be an integer from 1 to 14");
  const world = worldOf(request);
  const since = world.now - days * DAY_MS;
  // Shifts, and the visits that had a sale: a sale in a look-in stays markable.
  const shifts = world.shifts.filter((shift) => shift.start >= since && (!shift.visit || shift.sales.length > 0));
  return {
    shifts: shifts.map((shift) => ({
      visit: shift.visit,
      startedAt: iso(new Date(shift.start)),
      endedAt: iso(new Date(shift.end)),
      ongoing: shift.ongoing,
      pages: shift.pages,
      sales: shift.sales.map((sale) => reportSale(sale, world.teammates)),
      creditedMills: creditedMills(shift.confirmedAt === null ? shift.sales : shift.sales.filter((sale) => sale.confirmed)),
      unmarked: shift.sales.filter((sale) => sale.myMark === null).length,
      pending: shift.pending,
      confirmedAt: shift.confirmedAt === null ? null : iso(new Date(shift.confirmedAt)),
    })),
    sharedWithMe: world.sharedWithMe.filter((sale) => sale.at >= since).map((sale) => reportSale(sale, world.teammates)),
    teammates: world.teammates.map((user) => ({ userId: user.id, username: user.username })),
    serverNow: iso(request.now),
  };
}

// --- «Устройства» ---

interface DeviceSeed {
  label: string;
  version: string | null;
  createdDaysAgo: number;
  lastUsedMinutesAgo: number | null;
}

function devices(request: DemoRequest): Devices {
  const user = demoUserByRole(request.role);
  const now = request.now.getTime();
  const random = rng(`devices:${user.id}`);
  const list: DeviceSeed[] = user.role === "chatter"
    ? [
      // The work PC: the extension in use right now.
      { label: "Firefox · Windows · ChatGoose", version: "2.9.4", createdDaysAgo: 47, lastUsedMinutesAgo: 2 },
      // A laptop for nights at home.
      { label: "Firefox · macOS · ChatGoose", version: "2.9.2", createdDaysAgo: 23, lastUsedMinutesAgo: 3 * 24 * 60 + intBetween(random, 40, 300) },
      // The install before the PC was reinstalled: still signed in, unused for weeks.
      { label: "Firefox · Windows · ChatGoose", version: "2.7.2", createdDaysAgo: 51, lastUsedMinutesAgo: 19 * 24 * 60 + intBetween(random, 30, 600) },
    ]
    : [
      { label: "Firefox · macOS · ChatGoose", version: "2.9.4", createdDaysAgo: 34, lastUsedMinutesAgo: 95 },
      // Signed in yesterday and never opened since.
      { label: "Firefox · Windows · ChatGoose", version: null, createdDaysAgo: 1, lastUsedMinutesAgo: null },
    ];
  return list.map((item, index) => {
    const createdAt = now - item.createdDaysAgo * DAY_MS - intBetween(random, 0, 600) * MINUTE_MS;
    return {
      id: user.id * 100 + index + 1,
      label: item.label,
      keyPrefix: `cg_${(hashString(`device:${user.id}:${index}`) % 0xffffff).toString(16).padStart(6, "0")}`,
      lastClientVersion: item.version,
      createdAt: iso(new Date(createdAt)),
      expiresAt: iso(new Date(createdAt + 90 * DAY_MS)),
      lastUsedAt: item.lastUsedMinutesAgo === null ? null : iso(new Date(now - item.lastUsedMinutesAgo * MINUTE_MS)),
    };
  });
}

// --- «Мои AI-траты» ---

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The features a chatter's work calls: their share of the requests, a request's price in dollars, how often it is regenerated. */
const FEATURES = [
  { feature: "fast-reply", share: 0.42, unit: 0.0105, regenerate: 9.4 },
  { feature: "improve-draft", share: 0.15, unit: 0.0072, regenerate: 6.1 },
  { feature: "hi-greeting", share: 0.11, unit: 0.0064, regenerate: 12.8 },
  { feature: "fan-summary", share: 0.09, unit: 0.0215, regenerate: 2.3 },
  { feature: "ping", share: 0.08, unit: 0.0068, regenerate: 7.5 },
  { feature: "coach-chat", share: 0.06, unit: 0.0248, regenerate: 4.2 },
  { feature: "help-me", share: 0.04, unit: 0.0131, regenerate: 5.9 },
  { feature: "fan-notes-fill", share: 0.035, unit: 0.0186, regenerate: 1.4 },
  { feature: "chat-review", share: 0.015, unit: 0.0312, regenerate: 0 },
] as const;

const WEIGHT_TOTAL = FEATURES.reduce((total, item) => total + item.share * item.unit, 0);

function tokens(requests: number) {
  const cacheRead = requests * 5_340;
  const cacheWrite = requests * 610;
  return { input: requests * 880, output: requests * 172, cacheWrite, cacheRead, cacheTotal: cacheRead + cacheWrite };
}

function usage(request: DemoRequest): MyUsage | DemoReply {
  const fromQuery = queryString(request, "from");
  const toQuery = queryString(request, "to");
  if ((fromQuery === undefined) !== (toQuery === undefined)) {
    return demoError(400, "Bad Request", "`from` and `to` must be provided together");
  }
  if ((fromQuery !== undefined && !BUSINESS_DATE.test(fromQuery)) || (toQuery !== undefined && !BUSINESS_DATE.test(toQuery))) {
    return demoError(400, "Bad Request", "`from` and `to` must be dates YYYY-MM-DD");
  }
  if (fromQuery !== undefined && toQuery !== undefined && fromQuery > toQuery) {
    return demoError(400, "Bad Request", "`from` must be on or before `to`");
  }
  const world = worldOf(request);
  const to = toQuery ?? world.today;
  const from = fromQuery ?? addDays(to, -29);
  const days = dayRange(from, to).slice(-400);

  // About a request per two messages of a shift (Reply, Fix, Hi, the fan's card), a few on a day off; the owner only tries things.
  const daily = days.map((date) => {
    const random = rng(`usage:${world.user.id}:${date}`);
    const messages = world.shifts.filter((shift) => shift.date === date).reduce((total, shift) => total + shift.messages, 0);
    const requests = date > world.today ? 0
      : world.user.role === "chatter"
        ? (messages > 0 ? Math.round(messages * between(random, 0.48, 0.6)) : random() < 0.3 ? intBetween(random, 1, 6) : 0)
        : random() < 0.35 ? intBetween(random, 2, 14) : 0;
    return { date, requestCount: requests, costMicroUsd: Math.round(requests * WEIGHT_TOTAL * between(random, 0.85, 1.18) * 1_000_000) };
  });
  const totalRequests = daily.reduce((total, row) => total + row.requestCount, 0);
  const totalCost = daily.reduce((total, row) => total + row.costMicroUsd, 0);

  // The features split the same requests and the same money; the remainder of the rounding goes to the first.
  const rows = FEATURES.map((item) => ({
    item,
    requestCount: Math.round(totalRequests * item.share),
    costMicroUsd: Math.round((totalCost * item.share * item.unit) / WEIGHT_TOTAL),
  })).filter((row) => row.requestCount > 0);
  const lead = rows[0];
  if (lead) {
    lead.requestCount += totalRequests - rows.reduce((total, row) => total + row.requestCount, 0);
    lead.costMicroUsd += totalCost - rows.reduce((total, row) => total + row.costMicroUsd, 0);
  }
  const pct = (part: number) => (totalRequests > 0 ? Math.round((part / totalRequests) * 1000) / 10 : 0);
  const featureBreakdown = rows.map((row) => ({
    feature: row.item.feature,
    requestCount: row.requestCount,
    sharePct: pct(row.requestCount),
    tokenCounts: tokens(row.requestCount),
    costMicroUsd: Math.max(0, row.costMicroUsd),
    costApproximate: false,
    regenerateRatePct: row.item.regenerate,
  }));
  const failed = Math.round(totalRequests * 0.006);
  const cancelled = Math.round(totalRequests * 0.021);
  const regenerated = featureBreakdown.reduce((total, row) => total + row.requestCount * row.regenerateRatePct, 0);
  const top = featureBreakdown[0];
  return {
    range: { from, to, timeZone: "Europe/Moscow" },
    row: {
      username: world.user.username,
      totalGenerations: totalRequests,
      tokenCounts: tokens(totalRequests),
      cost: { microUsd: totalCost, approximate: false },
      gateway: {
        requestCount: totalRequests,
        completedCount: totalRequests - failed - cancelled,
        failedCount: failed,
        cancelledCount: cancelled,
        quotaDeniedCount: 0,
        openReservationCount: 0,
        providerBreakdown: totalRequests > 0 ? [{ provider: "anthropic", requestCount: totalRequests, costMicroUsd: totalCost }] : [],
      },
      topFeature: top ? { feature: top.feature, requestCount: top.requestCount, sharePct: top.sharePct } : null,
      featureBreakdown,
      regenerateRatePct: totalRequests > 0 ? Math.round((regenerated / totalRequests) * 10) / 10 : 0,
      warning: false,
    },
    daily,
  };
}

export const accountHandlers: DemoHandlers = {
  accountChatterStats: (request) => {
    const days = daysOf(request, 31, 7);
    if (days === null) return demoError(400, "Bad Request", "querystring/days must be an integer from 1 to 31");
    return chatterStats(worldOf(request), days);
  },
  accountShiftReport: shiftReport,
  authListDevices: devices,
  authMyUsage: usage,
};
