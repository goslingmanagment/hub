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
import { sendTelegramMessage, type TelegramSendResult } from "./telegram.ts";

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

function formatShare(partMills: bigint, totalMills: bigint): string {
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

function directionEmoji(deltaPct: number | null): string {
  if (deltaPct === null || Math.abs(deltaPct) < 0.05) {
    return "";
  }

  return deltaPct > 0 ? "🟢 " : "🔴 ";
}

const IDLE_NOTE_NAME_LIMIT = 4;

/** "  +2 idle: lora-2, lora-of" — collapses zero-yesterday pages into one line. */
function formatIdleNote(labels: string[]): string {
  const shown = labels.slice(0, IDLE_NOTE_NAME_LIMIT).join(", ");
  const overflow = labels.length > IDLE_NOTE_NAME_LIMIT
    ? `, +${labels.length - IDLE_NOTE_NAME_LIMIT}`
    : "";
  return `+${labels.length} idle: ${shown}${overflow}`;
}

interface ReportTableRow {
  indent: number;
  label: string;
  amount: string;
  delta: string;
  trailing?: string;
}

type ReportTableElement =
  | { kind: "row"; row: ReportTableRow }
  | { kind: "note"; text: string }
  | { kind: "blank" };

/**
 * Renders rows into a fixed-column monospace table (for a Telegram <pre> block):
 * the amount and delta columns share one width across the whole report, so every
 * dollar figure lines up in a single vertical rule. Widths are computed on the
 * raw (pre-escape) label length so HTML-escaping never shifts the columns.
 */
function renderReportTable(elements: ReportTableElement[]): string {
  const labelCells = new Map<ReportTableRow, string>();
  let labelWidth = 0;
  let amountWidth = 0;
  let deltaWidth = 0;
  for (const element of elements) {
    if (element.kind !== "row") continue;
    const labelCell = " ".repeat(element.row.indent) + element.row.label;
    labelCells.set(element.row, labelCell);
    labelWidth = Math.max(labelWidth, labelCell.length);
    amountWidth = Math.max(amountWidth, element.row.amount.length);
    deltaWidth = Math.max(deltaWidth, element.row.delta.length);
  }

  return elements
    .map((element) => {
      if (element.kind === "blank") return "";
      if (element.kind === "note") return element.text;
      const row = element.row;
      const labelCell = escapeHtml((labelCells.get(row) ?? "").padEnd(labelWidth));
      const amountCell = row.amount.padStart(amountWidth);
      const deltaCell = row.delta.padStart(deltaWidth);
      const trailing = row.trailing ? `  ${row.trailing}` : "";
      return `${labelCell}  ${amountCell}  ${deltaCell}${trailing}`;
    })
    .join("\n");
}

export function renderDailyRevenueTelegramReport(report: Omit<DailyRevenueTelegramReport, "text" | "parseMode">) {
  const agencyYesterday = report.agency.metrics.yesterday;

  // Headline (outside the <pre> so it can be bold + carry a colour indicator).
  const head = [
    `📊 <b>Revenue · ${escapeHtml(formatReportDate(report.reportDate))}</b>`,
    `${directionEmoji(agencyYesterday.deltaPct)}<b>${formatUsdFromMills(agencyYesterday.currentMills)}</b> ${formatDeltaCompact(agencyYesterday)}`,
  ];

  const elements: ReportTableElement[] = [
    { kind: "row", row: { indent: 0, label: "7-day", amount: formatUsdFromMills(report.agency.metrics.days7.currentMills), delta: formatDeltaCompact(report.agency.metrics.days7) } },
    { kind: "row", row: { indent: 0, label: "30-day", amount: formatUsdFromMills(report.agency.metrics.days30.currentMills), delta: formatDeltaCompact(report.agency.metrics.days30) } },
  ];

  const pagesByModel = new Map<string, typeof report.pages>();
  for (const page of report.pages) {
    const existing = pagesByModel.get(page.modelLabel) ?? [];
    existing.push(page);
    pagesByModel.set(page.modelLabel, existing);
  }

  if (report.models.length === 0) {
    elements.push({ kind: "blank" }, { kind: "note", text: "No data" });
  } else {
    for (const model of report.models) {
      const share = formatShare(model.metrics.yesterday.currentMills, agencyYesterday.currentMills);
      elements.push({ kind: "blank" });
      elements.push({ kind: "row", row: { indent: 0, label: model.label, amount: formatUsdFromMills(model.metrics.yesterday.currentMills), delta: formatDeltaCompact(model.metrics.yesterday), trailing: share } });

      const modelPages = pagesByModel.get(model.label) ?? [];
      const idle: string[] = [];
      for (const page of modelPages) {
        // Collapse pages with no revenue yesterday into a single "idle" line
        // instead of a $0.00 row per dead page.
        if (page.metrics.yesterday.currentMills === 0n) {
          idle.push(page.label);
          continue;
        }
        elements.push({ kind: "row", row: { indent: 2, label: page.label, amount: formatUsdFromMills(page.metrics.yesterday.currentMills), delta: formatDeltaCompact(page.metrics.yesterday) } });
      }
      if (idle.length > 0) {
        elements.push({ kind: "note", text: `  ${escapeHtml(formatIdleNote(idle))}` });
      }
    }

    if (report.modelOverflow) {
      elements.push({ kind: "blank" });
      elements.push({ kind: "row", row: { indent: 0, label: `+${report.modelOverflow.modelCount} more models`, amount: formatUsdFromMills(report.modelOverflow.metrics.yesterday.currentMills), delta: formatDeltaCompact(report.modelOverflow.metrics.yesterday) } });
    }
  }

  if (report.overflow) {
    elements.push({ kind: "row", row: { indent: 0, label: `+${report.overflow.pageCount} more`, amount: formatUsdFromMills(report.overflow.metrics.yesterday.currentMills), delta: formatDeltaCompact(report.overflow.metrics.yesterday) } });
  }

  // Windows are UTC calendar windows that exclude today — they intentionally
  // differ from the dashboard's OnlyFans-specific windows (see the NOTE in
  // buildDailyRevenueTelegramReport). Labeling avoids misreading without
  // changing the math.
  return [
    head.join("\n"),
    `<pre>${renderReportTable(elements)}</pre>`,
    "<i>Windows: UTC · excl. today</i>",
  ].join("\n");
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
  const delivery = await sendTelegramMessage(app, {
    text: report.text,
    parseMode: report.parseMode,
  });

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
  const delivery = await sendTelegramMessage(app, {
    text: report.text,
    parseMode: report.parseMode,
  });

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
