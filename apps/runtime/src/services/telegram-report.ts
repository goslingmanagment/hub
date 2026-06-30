import {
  getRevenuePageTotals,
  getTelegramSettings,
  insertDeliveryAttempt,
  listVisiblePages,
} from "@agency_hub_core/db";
import {
  addUtcDays,
  formatUsdFromMills,
  startOfBusinessDay,
  toBusinessDate,
  toMills,
  UTC_TIME_ZONE,
  type Platform,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { sendTelegramMessage, sendTelegramPhoto, type TelegramSendResult } from "./telegram.ts";
import { renderDailyRevenueReportImage } from "./telegram-report-image.ts";

export const TOP_PAGE_LIMIT = 10;
export const TOP_MODEL_LIMIT = 10;

type WindowKey = "yesterday" | "days7" | "days30";

interface RevenueMetric {
  currentMills: bigint;
  previousMills: bigint;
  deltaPct: number | null;
}

interface ReportRow {
  label: string;
  metrics: Record<WindowKey, RevenueMetric>;
}

interface RankedPageRow extends ReportRow {
  pageId: number;
  modelLabel: string;
}

export interface DailyRevenueTelegramReport {
  reportDate: string;
  generatedAt: string;
  agency: ReportRow;
  models: ReportRow[];
  modelOverflow: (ReportRow & { modelCount: number }) | null;
  pages: (ReportRow & { modelLabel: string })[];
  overflow: (ReportRow & { pageCount: number }) | null;
  text: string;
  parseMode: "HTML";
}

function sumMills(values: Iterable<bigint>) {
  let total = 0n;
  for (const value of values) {
    total += value;
  }
  return total;
}

function computeDeltaPct(currentMills: bigint, previousMills: bigint) {
  if (previousMills === 0n) {
    return null;
  }

  return (Number(currentMills - previousMills) / Number(previousMills < 0n ? -previousMills : previousMills)) * 100;
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const DELTA_MULTIPLIER_THRESHOLD = 10;

/**
 * Compact, alignment-safe delta for the monospace report. Tames the two noisy
 * cases the old `↑44.2%` formatter produced: explosive growth from a near-zero
 * base (shown as a multiplier like `22x`, or `new` when the base was 0) and rows
 * with no prior baseline. Uses ASCII `+`/`-`/`x` so it stays one column wide.
 */
export function formatDeltaCompact(metric: RevenueMetric): string {
  if (metric.previousMills === 0n) {
    return metric.currentMills > 0n ? "new" : "—";
  }
  const ratio = Number(metric.currentMills) / Number(metric.previousMills);
  if (ratio >= DELTA_MULTIPLIER_THRESHOLD) {
    return `${Math.round(ratio)}x`;
  }
  const rounded = Math.round(metric.deltaPct ?? 0);
  if (rounded === 0) {
    return "0%";
  }
  return `${rounded > 0 ? "+" : "-"}${Math.abs(rounded)}%`;
}

const REPORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const REPORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-29" -> "Mon 29 Jun" (UTC), so the date reads at a glance. */
export function formatReportDate(reportDate: string): string {
  const parsed = new Date(`${reportDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return reportDate;
  }
  return `${REPORT_WEEKDAYS[parsed.getUTCDay()]} ${parsed.getUTCDate()} ${REPORT_MONTHS[parsed.getUTCMonth()]}`;
}

export function formatShare(partMills: bigint, totalMills: bigint): string {
  if (totalMills === 0n) {
    return "0%";
  }

  const pct = Math.round(Number(partMills) / Number(totalMills) * 100);

  if (pct === 0 && partMills > 0n) {
    return "&lt;1%";
  }

  return `${pct}%`;
}

function groupPageIdsByPlatform(
  pages: Array<Awaited<ReturnType<typeof listVisiblePages>>[number]>,
) {
  const grouped = new Map<Platform, number[]>();

  for (const page of pages) {
    const current = grouped.get(page.platform) ?? [];
    current.push(page.id);
    grouped.set(page.platform, current);
  }

  return grouped;
}

async function loadPageTotalsForBounds(
  app: Pick<AppContext, "db">,
  groupedPageIds: Map<Platform, number[]>,
  bounds: {
    from: Date;
    to: Date;
  },
) {
  const totals = new Map<number, bigint>();
  const groups = Array.from(groupedPageIds.entries());
  const rows = await Promise.all(groups.map(([platform, pageIds]) => getRevenuePageTotals(app.db, {
    platform,
    pageIds,
    period: {
      from: bounds.from,
      to: bounds.to,
    },
  })));

  for (const group of rows) {
    for (const row of group) {
      totals.set(row.pageId, toMills(row.netEarningsMills));
    }
  }

  return totals;
}

function buildMetric(
  currentTotals: Map<number, bigint>,
  previousTotals: Map<number, bigint>,
  pageIds: number[],
) {
  const currentMills = sumMills(pageIds.map((pageId) => currentTotals.get(pageId) ?? 0n));
  const previousMills = sumMills(pageIds.map((pageId) => previousTotals.get(pageId) ?? 0n));

  return {
    currentMills,
    previousMills,
    deltaPct: computeDeltaPct(currentMills, previousMills),
  } satisfies RevenueMetric;
}

function createReportRow(
  label: string,
  pageIds: number[],
  totalsByWindow: Record<WindowKey, {
    current: Map<number, bigint>;
    previous: Map<number, bigint>;
  }>,
): ReportRow {
  return {
    label,
    metrics: {
      yesterday: buildMetric(totalsByWindow.yesterday.current, totalsByWindow.yesterday.previous, pageIds),
      days7: buildMetric(totalsByWindow.days7.current, totalsByWindow.days7.previous, pageIds),
      days30: buildMetric(totalsByWindow.days30.current, totalsByWindow.days30.previous, pageIds),
    },
  };
}

function modelDot(deltaPct: number | null): string {
  if (deltaPct === null || Math.abs(deltaPct) < 0.05) {
    return "⚪";
  }
  return deltaPct > 0 ? "🟢" : "🔴";
}

/** Whole-dollar amount (no cents) for the large trailing-window figures. */
export function formatUsdCompact(mills: bigint): string {
  const dollars = Math.round(Number(mills) / 1000);
  const sign = dollars < 0 ? "-" : "";
  return `${sign}$${Math.abs(dollars).toLocaleString("en-US")}`;
}

// Display priority for named (non-numbered) pages within a model. Numbered pages
// (…-1, …-2, …) always come first in numeric order; then pages whose label
// contains one of these tokens, in THIS order; then everything else alphabetically.
// Edit this list to change the order — e.g. put "free" before "vip" to flip them.
export const REPORT_PAGE_TIER_ORDER = ["vip", "free", "main"] as const;

function pageOrderKey(label: string): { group: number; rank: number } {
  const lower = label.toLowerCase();
  const trailingNumber = lower.match(/(\d+)\s*$/);
  if (trailingNumber) {
    return { group: 0, rank: Number(trailingNumber[1]) };
  }
  const tier = REPORT_PAGE_TIER_ORDER.findIndex((token) => lower.includes(token));
  return tier >= 0 ? { group: 1, rank: tier } : { group: 2, rank: 0 };
}

function comparePagesForDisplay(a: { label: string }, b: { label: string }): number {
  const ka = pageOrderKey(a.label);
  const kb = pageOrderKey(b.label);
  if (ka.group !== kb.group) return ka.group - kb.group;
  if (ka.group !== 2 && ka.rank !== kb.rank) return ka.rank - kb.rank;
  return a.label.localeCompare(b.label, "en", { numeric: true, sensitivity: "base" });
}

/**
 * Groups pages under their model and orders each model's pages by a fixed,
 * configurable rule (see comparePagesForDisplay / REPORT_PAGE_TIER_ORDER), NOT by
 * revenue — so a page keeps the same position every day instead of jumping around
 * as its daily revenue changes.
 */
export function groupPagesByModel<T extends { modelLabel: string; label: string }>(
  pages: readonly T[],
): Map<string, T[]> {
  const byModel = new Map<string, T[]>();
  for (const page of pages) {
    const existing = byModel.get(page.modelLabel) ?? [];
    existing.push(page);
    byModel.set(page.modelLabel, existing);
  }
  for (const list of byModel.values()) {
    list.sort(comparePagesForDisplay);
  }
  return byModel;
}

/**
 * Proportional (non-monospace) layout. Telegram renders <pre> as a "code block"
 * with copy-button chrome, which reads as a pasted snippet rather than a report,
 * so the body is plain text with bold names + colour dots instead of an aligned
 * table. Without a monospace block, columns can't be aligned, so each entity is
 * one self-contained line.
 */
export function renderDailyRevenueTelegramReport(report: Omit<DailyRevenueTelegramReport, "text" | "parseMode">) {
  const y = report.agency.metrics.yesterday;
  const lines: string[] = [];

  lines.push(`📊 <b>Revenue · ${escapeHtml(formatReportDate(report.reportDate))}</b>`);
  lines.push(`${modelDot(y.deltaPct)} <b>${formatUsdFromMills(y.currentMills)}</b> ${formatDeltaCompact(y)}`);
  lines.push(
    `<i>7d</i> ${formatUsdCompact(report.agency.metrics.days7.currentMills)} ${formatDeltaCompact(report.agency.metrics.days7)}`
      + `  ·  <i>30d</i> ${formatUsdCompact(report.agency.metrics.days30.currentMills)} ${formatDeltaCompact(report.agency.metrics.days30)}`,
  );

  const pagesByModel = groupPagesByModel(report.pages);

  if (report.models.length === 0) {
    lines.push("");
    lines.push("<i>No data</i>");
  } else {
    for (const model of report.models) {
      const share = formatShare(model.metrics.yesterday.currentMills, y.currentMills);
      lines.push("");
      lines.push(
        `${modelDot(model.metrics.yesterday.deltaPct)} <b>${escapeHtml(model.label)}</b> `
          + `${formatUsdFromMills(model.metrics.yesterday.currentMills)} ${formatDeltaCompact(model.metrics.yesterday)} · ${share}`,
      );

      for (const page of pagesByModel.get(model.label) ?? []) {
        // Fixed label order (see groupPagesByModel); zero-revenue pages show
        // inline as $0.00 in their usual position rather than collapsed.
        lines.push(
          `   ${escapeHtml(page.label)} ${formatUsdFromMills(page.metrics.yesterday.currentMills)} ${formatDeltaCompact(page.metrics.yesterday)}`,
        );
      }
    }

    if (report.modelOverflow) {
      lines.push("");
      lines.push(
        `<i>+${report.modelOverflow.modelCount} more models</i> ${formatUsdFromMills(report.modelOverflow.metrics.yesterday.currentMills)}`,
      );
    }
  }

  if (report.overflow) {
    lines.push(
      `<i>+${report.overflow.pageCount} more pages</i> ${formatUsdFromMills(report.overflow.metrics.yesterday.currentMills)}`,
    );
  }

  // Windows are UTC calendar windows that exclude today — intentionally
  // different from the dashboard's OnlyFans-specific windows (see the NOTE in
  // buildDailyRevenueTelegramReport). Labeling avoids misreading without
  // changing the math.
  lines.push("");
  lines.push("<i>Windows: UTC · excl. today</i>");

  return lines.join("\n");
}

function sortByYesterday(left: ReportRow, right: ReportRow) {
  const delta = Number(right.metrics.yesterday.currentMills - left.metrics.yesterday.currentMills);
  if (delta !== 0) {
    return delta;
  }

  return left.label.localeCompare(right.label);
}

export async function buildDailyRevenueTelegramReport(
  app: Pick<AppContext, "db">,
  now = new Date(),
): Promise<DailyRevenueTelegramReport> {
  const todayStart = startOfBusinessDay(now, UTC_TIME_ZONE);
  const yesterdayStart = addUtcDays(todayStart, -1);
  const pageRows = await listVisiblePages(app.db);
  const groupedPageIds = groupPageIdsByPlatform(pageRows);

  // NOTE: The daily Telegram report uses uniform UTC calendar windows that
  // exclude today (yesterday/7d/30d all end at todayStart). This intentionally
  // differs from the dashboard's OnlyFans-specific windows in
  // packages/shared/src/time.ts, which are one day wider and today-inclusive
  // (ONLYFANS_REVENUE_TRAILING_PERIOD_OFFSETS + a `to` of todayStart+1). This
  // 7d/30d divergence between report and dashboard is known and unresolved; do
  // not "fix" the math here without aligning both surfaces.
  const windows = {
    yesterday: {
      current: { from: yesterdayStart, to: todayStart },
      previous: { from: addUtcDays(yesterdayStart, -1), to: yesterdayStart },
    },
    days7: {
      current: { from: addUtcDays(todayStart, -7), to: todayStart },
      previous: { from: addUtcDays(todayStart, -14), to: addUtcDays(todayStart, -7) },
    },
    days30: {
      current: { from: addUtcDays(todayStart, -30), to: todayStart },
      previous: { from: addUtcDays(todayStart, -60), to: addUtcDays(todayStart, -30) },
    },
  } satisfies Record<WindowKey, {
    current: { from: Date; to: Date };
    previous: { from: Date; to: Date };
  }>;

  const totalsByWindow = Object.fromEntries(await Promise.all(
    Object.entries(windows).map(async ([key, bounds]) => [
      key,
      {
        current: await loadPageTotalsForBounds(app, groupedPageIds, bounds.current),
        previous: await loadPageTotalsForBounds(app, groupedPageIds, bounds.previous),
      },
    ]),
  )) as Record<WindowKey, {
    current: Map<number, bigint>;
    previous: Map<number, bigint>;
  }>;

  const agency = createReportRow("Agency", pageRows.map((page) => page.id), totalsByWindow);
  const modelPageIds = new Map<string, { name: string; pageIds: number[] }>();

  for (const page of pageRows) {
    const current = modelPageIds.get(page.modelSlug) ?? {
      name: page.modelName,
      pageIds: [],
    };
    current.pageIds.push(page.id);
    modelPageIds.set(page.modelSlug, current);
  }

  const modelSlugToLabel = new Map<string, string>();
  for (const [slug, model] of modelPageIds.entries()) {
    modelSlugToLabel.set(slug, model.name || slug);
  }

  const rankedModels = Array.from(modelPageIds.entries())
    .map(([modelSlug, model]) => ({
      pageIds: model.pageIds,
      ...createReportRow(model.name || modelSlug, model.pageIds, totalsByWindow),
    }))
    .sort(sortByYesterday);
  const models = rankedModels
    .slice(0, TOP_MODEL_LIMIT)
    .map(({ pageIds: _pageIds, ...row }) => row);
  const overflowModels = rankedModels.slice(TOP_MODEL_LIMIT);
  const overflowModelPageIds = overflowModels.flatMap((model) => model.pageIds);
  const modelOverflow = overflowModels.length > 0
    ? {
      ...createReportRow("overflow", overflowModelPageIds, totalsByWindow),
      modelCount: overflowModels.length,
    }
    : null;

  const rankedPages = pageRows
    .map((page) => ({
      pageId: page.id,
      modelLabel: modelSlugToLabel.get(page.modelSlug) ?? page.modelSlug,
      ...createReportRow(page.label, [page.id], totalsByWindow),
    } satisfies RankedPageRow))
    .sort(sortByYesterday);
  const topPages = rankedPages.slice(0, TOP_PAGE_LIMIT);
  const overflowPageIds = rankedPages
    .slice(TOP_PAGE_LIMIT)
    .map((page) => page.pageId);
  const overflow = overflowPageIds.length > 0
    ? {
      ...createReportRow("overflow", overflowPageIds, totalsByWindow),
      pageCount: overflowPageIds.length,
    }
    : null;

  const report = {
    reportDate: toBusinessDate(yesterdayStart, UTC_TIME_ZONE),
    generatedAt: now.toISOString(),
    agency,
    models,
    modelOverflow,
    pages: topPages,
    overflow,
  } satisfies Omit<DailyRevenueTelegramReport, "text" | "parseMode">;

  return {
    ...report,
    text: renderDailyRevenueTelegramReport(report),
    parseMode: "HTML" as const,
  };
}

/** Short text caption that rides with the image (shown in the push preview). */
function buildDailyRevenueReportCaption(report: DailyRevenueTelegramReport): string {
  const y = report.agency.metrics.yesterday;
  return `📊 <b>Revenue · ${escapeHtml(formatReportDate(report.reportDate))}</b> — `
    + `<b>${formatUsdFromMills(y.currentMills)}</b> ${formatDeltaCompact(y)}`;
}

/**
 * Sends the report as a rendered image with a short caption; falls back to the
 * plain-text message if image rendering fails (e.g. chromium unavailable), so a
 * report always goes out.
 */
async function deliverDailyRevenueReport(
  app: Pick<AppContext, "config" | "db" | "logger">,
  report: DailyRevenueTelegramReport,
): Promise<TelegramSendResult> {
  try {
    const image = await renderDailyRevenueReportImage(report);
    const photoDelivery = await sendTelegramPhoto(app, {
      photo: image,
      caption: buildDailyRevenueReportCaption(report),
      parseMode: "HTML",
    });
    if (photoDelivery.status !== "failed") {
      return photoDelivery;
    }
    app.logger.warn({ error: photoDelivery.error }, "Revenue report image send failed; falling back to text");
    return sendTelegramMessage(app, { text: report.text, parseMode: report.parseMode });
  } catch (error) {
    app.logger.warn({ err: error }, "Revenue report image render failed; falling back to text");
    return sendTelegramMessage(app, { text: report.text, parseMode: report.parseMode });
  }
}

export async function sendDailyRevenueTelegramReport(
  app: Pick<AppContext, "config" | "db" | "logger">,
  now = new Date(),
): Promise<{
  delivery: TelegramSendResult;
  report: DailyRevenueTelegramReport | null;
}> {
  const settings = await getTelegramSettings(app.db, {
    defaultReportHourUtc: app.config.telegramReportHourUtc,
  });
  if (!settings.enabled || !settings.dailyReportEnabled) {
    await insertDeliveryAttempt(app.db, {
      kind: "daily_report_scheduled",
      status: "skipped",
      error: "disabled",
    });
    return {
      delivery: {
        status: "skipped",
        reason: "disabled",
      },
      report: null,
    };
  }

  const report = await buildDailyRevenueTelegramReport(app, now);
  const delivery = await deliverDailyRevenueReport(app, report);

  await insertDeliveryAttempt(app.db, {
    kind: "daily_report_scheduled",
    status: delivery.status,
    reportDate: report.reportDate,
    messageId: delivery.status === "sent" ? delivery.messageId : null,
    error: delivery.status === "failed"
      ? delivery.error
      : delivery.status === "skipped"
        ? delivery.reason
        : null,
  });

  return {
    delivery,
    report,
  };
}

export async function sendManualDailyRevenueTelegramReport(
  app: Pick<AppContext, "config" | "db" | "logger">,
  now = new Date(),
): Promise<{
  delivery: TelegramSendResult;
  report: DailyRevenueTelegramReport | null;
}> {
  const report = await buildDailyRevenueTelegramReport(app, now);
  const delivery = await deliverDailyRevenueReport(app, report);

  await insertDeliveryAttempt(app.db, {
    kind: "daily_report_manual",
    status: delivery.status,
    reportDate: report.reportDate,
    messageId: delivery.status === "sent" ? delivery.messageId : null,
    error: delivery.status === "failed"
      ? delivery.error
      : delivery.status === "skipped"
        ? delivery.reason
        : null,
  });

  return {
    delivery,
    report,
  };
}
