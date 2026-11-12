import {
  getRevenuePageTotalsForExactPeriod,
  getTelegramSettings,
  insertDeliveryAttempt,
  listRevenuePages,
} from "@agency_hub_core/db";
import { millsToRoundedDollars,
  addUtcDays,
  formatUsdFromMills,
  BUSINESS_TIME_ZONE,
  startOfBusinessDay,
  toBusinessDate,
  millsFromInteger,
} from "@agency_hub_core/shared";

import { formatMills, formatWeekdayDay, ruPlural, WORDS } from "@agency_hub_core/look";

import type { AppContext } from "../bootstrap.ts";
import { notificationLanguage, type NotificationLanguage } from "./notification-ru.ts";
import { sendTelegramMessage, sendTelegramPhoto, type TelegramSendResult } from "./telegram.ts";
import { renderDailyRevenueReportImage } from "./telegram-report-image.ts";
import { loadTeamBlockFacts, renderTeamBlock } from "./telegram-team-block.ts";

export const TOP_PAGE_LIMIT = 10;
export const TOP_MODEL_LIMIT = 10;
const REPORT_BUSINESS_TIME_ZONE = BUSINESS_TIME_ZONE;

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
  /** Chat Memory week 5: the team block's lines (Telegram HTML); empty — no block. */
  team: string[];
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

async function loadPageTotalsForBounds(
  app: Pick<AppContext, "db">,
  pageIds: number[],
  bounds: {
    from: Date;
    to: Date;
  },
) {
  const totals = new Map<number, bigint>();
  const rows = await getRevenuePageTotalsForExactPeriod(app.db, {
    pageIds,
    period: {
      from: bounds.from,
      to: bounds.to,
    },
  });

  for (const row of rows) {
    totals.set(row.pageId, millsFromInteger(row.netEarningsMills));
  }

  return totals;
}

function startOfReportBusinessDay(date: Date) {
  return startOfBusinessDay(date, REPORT_BUSINESS_TIME_ZONE);
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
  const dollars = millsToRoundedDollars(mills);
  const sign = dollars < 0 ? "-" : "";
  return `${sign}$${Math.abs(dollars).toLocaleString("en-US")}`;
}

const NBSP = "\u00a0";
const MINUS = "\u2212";

/**
 * The report's words in each language (`telegramRussian`): the same rows,
 * amounts, deltas and order. The Russian side reads the English figure and
 * says it the way Hub's screens do (a real minus, «5 %», «×22»), so the two can
 * never show different numbers.
 */
const REPORT_WORDS = {
  en: {
    title: (reportDate: string) => `Revenue · ${formatReportDate(reportDate)}`,
    money: (mills: bigint) => formatUsdFromMills(mills),
    compact: formatUsdCompact,
    delta: formatDeltaCompact,
    share: formatShare,
    days7: "7d",
    days30: "30d",
    days7Row: "7-day",
    days30Row: "30-day",
    noData: "No data",
    moreModels: (count: number) => `+${count} more models`,
    morePages: (count: number) => `+${count} more pages`,
    windows: "Windows: 00:00-00:00 MSK · excl. current day",
    windowsImage: "Windows: 00:00-00:00 MSK · excluding current day",
    captionJoin: " — ",
  },
  ru: {
    title: (reportDate: string) => `${WORDS.income} · ${formatWeekdayDay(reportDate)}`,
    money: (mills: bigint) => formatMills(mills),
    compact: (mills: bigint) => formatUsdCompact(mills).replace(/^-/, MINUS),
    delta: (metric: RevenueMetric) => {
      const english = formatDeltaCompact(metric);
      if (english === "new") return "с нуля";
      if (english === "—") return "";
      const times = /^(\d+)x$/.exec(english);
      if (times) return `×${times[1]}`;
      const percent = /^([+-]?)(\d+)%$/.exec(english);
      return percent ? `${percent[1] === "-" ? MINUS : percent[1]}${percent[2]}${NBSP}%` : english;
    },
    share: (partMills: bigint, totalMills: bigint) => formatShare(partMills, totalMills).replace(/%$/, `${NBSP}%`),
    days7: "7 дней",
    days30: "30 дней",
    days7Row: "7 дней",
    days30Row: "30 дней",
    noData: "Нет данных",
    moreModels: (count: number) => `Ещё ${count} ${ruPlural(count, "модель", "модели", "моделей")}`,
    morePages: (count: number) => `Ещё ${count} ${ruPlural(count, "страница", "страницы", "страниц")}`,
    windows: "Сутки по Москве, с 00:00 до 00:00, без текущего дня",
    windowsImage: "Сутки по Москве, с 00:00 до 00:00, без текущего дня",
    captionJoin: ": ",
  },
} satisfies Record<NotificationLanguage, unknown>;

export type ReportWords = (typeof REPORT_WORDS)[NotificationLanguage];

export function reportWords(language: NotificationLanguage = "en"): ReportWords {
  return REPORT_WORDS[language];
}

// Display priority for named (non-numbered) pages within a model. Numbered pages
// (…-1, …-2, …) always come first in numeric order; then pages whose label
// contains one of these tokens, in THIS order; then everything else alphabetically.
// Edit this list to change the order — e.g. put "free" before "vip" to flip them.
export const REPORT_PAGE_TIER_ORDER = ["vip", "free", "main"] as const;
const REPORT_PAGE_FREE_SUFFIX = "of";

function labelTokens(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function pageOrderKey(label: string): { group: number; rank: number } {
  const tokens = labelTokens(label);
  const trailingNumber = tokens.at(-1)?.match(/^\d+$/);
  if (trailingNumber) {
    return { group: 0, rank: Number(trailingNumber[0]) };
  }
  const explicitTier = REPORT_PAGE_TIER_ORDER.findIndex((tierName) => tokens.includes(tierName));
  if (explicitTier >= 0) {
    return { group: 1, rank: explicitTier };
  }
  // Bare "...-of" labels are the default/free OnlyFans page in the current catalog.
  const tier = tokens.at(-1) === REPORT_PAGE_FREE_SUFFIX
    ? REPORT_PAGE_TIER_ORDER.indexOf("free")
    : -1;
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
 * Display name for a page: drops the trailing "-of" platform suffix and renders
 * the bare OnlyFans page as "-free" — so "lora-vip-of" -> "lora-vip" and
 * "lora-of" -> "lora-free". Ordering still keys off the raw label (pageOrderKey).
 */
export function formatPageLabel(label: string): string {
  const suffix = `-${REPORT_PAGE_FREE_SUFFIX}`;
  if (!label.toLowerCase().endsWith(suffix)) {
    return label;
  }
  const stripped = label.slice(0, -suffix.length);
  return stripped.includes("-") ? stripped : `${stripped}-free`;
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
export function renderDailyRevenueTelegramReport(
  report: Omit<DailyRevenueTelegramReport, "text" | "parseMode">,
  language: NotificationLanguage = "en",
) {
  const w = reportWords(language);
  const y = report.agency.metrics.yesterday;
  const lines: string[] = [];
  // A delta the Russian side leaves unsaid (nothing on either day) leaves no trailing space.
  const after = (text: string) => (text === "" ? "" : ` ${text}`);

  lines.push(`📊 <b>${escapeHtml(w.title(report.reportDate))}</b>`);
  lines.push(`${modelDot(y.deltaPct)} <b>${w.money(y.currentMills)}</b>${after(w.delta(y))}`);
  lines.push(
    `<i>${w.days7}</i> ${w.compact(report.agency.metrics.days7.currentMills)}${after(w.delta(report.agency.metrics.days7))}`
      + `  ·  <i>${w.days30}</i> ${w.compact(report.agency.metrics.days30.currentMills)}${after(w.delta(report.agency.metrics.days30))}`,
  );

  const pagesByModel = groupPagesByModel(report.pages);

  if (report.models.length === 0) {
    lines.push("");
    lines.push(`<i>${w.noData}</i>`);
  } else {
    for (const model of report.models) {
      const share = w.share(model.metrics.yesterday.currentMills, y.currentMills);
      lines.push("");
      lines.push(
        `${modelDot(model.metrics.yesterday.deltaPct)} <b>${escapeHtml(model.label)}</b> `
          + `${w.money(model.metrics.yesterday.currentMills)}${after(w.delta(model.metrics.yesterday))} · ${share}`,
      );

      for (const page of pagesByModel.get(model.label) ?? []) {
        // Fixed label order (see groupPagesByModel); zero-revenue pages show
        // inline as $0.00 in their usual position rather than collapsed.
        lines.push(
          `   ${escapeHtml(formatPageLabel(page.label))} ${w.money(page.metrics.yesterday.currentMills)}${after(w.delta(page.metrics.yesterday))}`,
        );
      }
    }

    if (report.modelOverflow) {
      lines.push("");
      lines.push(
        `<i>${w.moreModels(report.modelOverflow.modelCount)}</i> ${w.money(report.modelOverflow.metrics.yesterday.currentMills)}`,
      );
    }
  }

  if (report.overflow) {
    lines.push(
      `<i>${w.morePages(report.overflow.pageCount)}</i> ${w.money(report.overflow.metrics.yesterday.currentMills)}`,
    );
  }

  if (report.team.length > 0) {
    lines.push("");
    lines.push(...report.team);
  }

  // Windows are Hub's business days: Moscow midnight to midnight, as on the dashboard.
  lines.push("");
  lines.push(`<i>${w.windows}</i>`);

  return lines.join("\n");
}

function sortByYesterday(left: ReportRow, right: ReportRow) {
  const delta = Number(right.metrics.yesterday.currentMills - left.metrics.yesterday.currentMills);
  if (delta !== 0) {
    return delta;
  }

  return left.label.localeCompare(right.label);
}

/**
 * `now` picks the report's business day for the revenue windows (the scheduler
 * passes a synthetic run time so a catch-up covers the right day). `factsAt` is
 * the wall clock the team block reads its facts at: who waits for a reply now,
 * not at the run time's 03:00 MSK.
 */
export async function buildDailyRevenueTelegramReport(
  app: Pick<AppContext, "db"> & Partial<Pick<AppContext, "logger" | "config">>,
  now = new Date(),
  factsAt = new Date(),
  language: NotificationLanguage = "en",
): Promise<DailyRevenueTelegramReport> {
  const currentBusinessDayStart = startOfReportBusinessDay(now);
  const previousBusinessDayStart = addUtcDays(currentBusinessDayStart, -1);
  // W7.2 (A33): the digest is a revenue aggregate — tombstoned pages keep
  // contributing their in-window revenue (they read 0 once long retired).
  const pageRows = await listRevenuePages(app.db);
  const pageIds = pageRows.map((page) => page.id);

  // The report's day is Hub's business day (Moscow midnight to midnight), the
  // day the dashboard and the revenue_daily rollup use; it reads the exact
  // transactions of each window.
  const windows = {
    yesterday: {
      current: { from: previousBusinessDayStart, to: currentBusinessDayStart },
      previous: { from: addUtcDays(previousBusinessDayStart, -1), to: previousBusinessDayStart },
    },
    days7: {
      current: { from: addUtcDays(currentBusinessDayStart, -7), to: currentBusinessDayStart },
      previous: { from: addUtcDays(currentBusinessDayStart, -14), to: addUtcDays(currentBusinessDayStart, -7) },
    },
    days30: {
      current: { from: addUtcDays(currentBusinessDayStart, -30), to: currentBusinessDayStart },
      previous: { from: addUtcDays(currentBusinessDayStart, -60), to: addUtcDays(currentBusinessDayStart, -30) },
    },
  } satisfies Record<WindowKey, {
    current: { from: Date; to: Date };
    previous: { from: Date; to: Date };
  }>;

  const totalsByWindow = Object.fromEntries(await Promise.all(
    Object.entries(windows).map(async ([key, bounds]) => [
      key,
      {
        current: await loadPageTotalsForBounds(app, pageIds, bounds.current),
        previous: await loadPageTotalsForBounds(app, pageIds, bounds.previous),
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

  // The team block never holds the revenue report back.
  let team: string[] = [];
  try {
    team = renderTeamBlock(await loadTeamBlockFacts(app, { from: previousBusinessDayStart, to: currentBusinessDayStart, now: factsAt }), factsAt);
  } catch (error) {
    app.logger?.warn({ err: error }, "Morning report team block failed; sending the report without it");
  }

  const report = {
    reportDate: toBusinessDate(previousBusinessDayStart, REPORT_BUSINESS_TIME_ZONE),
    generatedAt: now.toISOString(),
    agency,
    models,
    modelOverflow,
    pages: topPages,
    overflow,
    team,
  } satisfies Omit<DailyRevenueTelegramReport, "text" | "parseMode">;

  return {
    ...report,
    text: renderDailyRevenueTelegramReport(report, language),
    parseMode: "HTML" as const,
  };
}

/** Short text caption that rides with the image (shown in the push preview). */
export function buildDailyRevenueReportCaption(report: DailyRevenueTelegramReport, language: NotificationLanguage = "en"): string {
  const w = reportWords(language);
  const y = report.agency.metrics.yesterday;
  const delta = w.delta(y);
  const head = `📊 <b>${escapeHtml(w.title(report.reportDate))}</b>${w.captionJoin}`
    + `<b>${w.money(y.currentMills)}</b>${delta === "" ? "" : ` ${delta}`}`;
  // A caption holds at most 1024 characters; the team block rides along while it fits.
  const withTeam = report.team.length === 0 ? head : `${head}\n\n${report.team.join("\n")}`;
  return withTeam.length <= 1000 ? withTeam : head;
}

/**
 * Sends the report as a rendered image with a short caption; falls back to the
 * plain-text message if image rendering fails (e.g. chromium unavailable), so a
 * report always goes out.
 */
async function deliverDailyRevenueReport(
  app: Pick<AppContext, "config" | "db" | "logger">,
  report: DailyRevenueTelegramReport,
  language: NotificationLanguage,
): Promise<TelegramSendResult> {
  try {
    const image = await renderDailyRevenueReportImage(report, language);
    const photoDelivery = await sendTelegramPhoto(app, {
      photo: image,
      caption: buildDailyRevenueReportCaption(report, language),
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
  factsAt = new Date(),
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

  const language = await notificationLanguage(app);
  const report = await buildDailyRevenueTelegramReport(app, now, factsAt, language);
  const delivery = await deliverDailyRevenueReport(app, report, language);

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
  const language = await notificationLanguage(app);
  const report = await buildDailyRevenueTelegramReport(app, now, new Date(), language);
  const delivery = await deliverDailyRevenueReport(app, report, language);

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
