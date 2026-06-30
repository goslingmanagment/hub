import { formatUsdFromMills } from "@agency_hub_core/shared";

import {
  type DailyRevenueTelegramReport,
  formatDeltaCompact,
  formatReportDate,
  formatShare,
  formatUsdCompact,
} from "./telegram-report.ts";

type ReportData = Omit<DailyRevenueTelegramReport, "text" | "parseMode">;
type Metric = ReportData["agency"]["metrics"]["yesterday"];

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "up" / "down" / "flat" — same rule the colour dot and delta colour use. */
function metricDirection(metric: Metric): "up" | "down" | "flat" {
  if (metric.previousMills === 0n) {
    return metric.currentMills > 0n ? "up" : "flat";
  }
  if (metric.deltaPct === null || Math.abs(metric.deltaPct) < 0.05) {
    return "flat";
  }
  return metric.deltaPct > 0 ? "up" : "down";
}

function deltaCell(metric: Metric): string {
  return `<td class="delta ${metricDirection(metric)}">${escapeHtml(formatDeltaCompact(metric))}</td>`;
}

/**
 * Builds the standalone HTML document screenshotted into the report image. Uses a
 * real table with tabular figures so every amount lines up in a column — the one
 * thing a Telegram text message cannot do without looking like a code block.
 */
export function buildDailyRevenueReportHtml(report: ReportData): string {
  const y = report.agency.metrics.yesterday;
  const rows: string[] = [];

  rows.push(
    `<tr class="win"><td>7-day</td><td class="num">${formatUsdCompact(report.agency.metrics.days7.currentMills)}</td>${deltaCell(report.agency.metrics.days7)}<td></td></tr>`,
    `<tr class="win"><td>30-day</td><td class="num">${formatUsdCompact(report.agency.metrics.days30.currentMills)}</td>${deltaCell(report.agency.metrics.days30)}<td></td></tr>`,
  );

  const pagesByModel = new Map<string, typeof report.pages>();
  for (const page of report.pages) {
    const existing = pagesByModel.get(page.modelLabel) ?? [];
    existing.push(page);
    pagesByModel.set(page.modelLabel, existing);
  }

  if (report.models.length === 0) {
    rows.push(`<tr class="spacer"><td colspan="4"></td></tr><tr class="empty"><td colspan="4">No data</td></tr>`);
  } else {
    for (const model of report.models) {
      const dir = metricDirection(model.metrics.yesterday);
      rows.push(`<tr class="spacer"><td colspan="4"></td></tr>`);
      rows.push(
        `<tr class="model"><td><span class="dot ${dir}"></span>${escapeHtml(model.label)}</td>`
          + `<td class="num">${formatUsdFromMills(model.metrics.yesterday.currentMills)}</td>`
          + `${deltaCell(model.metrics.yesterday)}`
          + `<td class="share">${formatShare(model.metrics.yesterday.currentMills, y.currentMills)}</td></tr>`,
      );

      for (const page of pagesByModel.get(model.label) ?? []) {
        // Zero-revenue pages sink to the bottom of each model and show as $0.00.
        rows.push(
          `<tr class="page"><td>${escapeHtml(page.label)}</td>`
            + `<td class="num">${formatUsdFromMills(page.metrics.yesterday.currentMills)}</td>`
            + `${deltaCell(page.metrics.yesterday)}<td></td></tr>`,
        );
      }
    }

    if (report.modelOverflow) {
      rows.push(
        `<tr class="more"><td>+${report.modelOverflow.modelCount} more models</td>`
          + `<td class="num">${formatUsdFromMills(report.modelOverflow.metrics.yesterday.currentMills)}</td><td></td><td></td></tr>`,
      );
    }
  }

  if (report.overflow) {
    rows.push(
      `<tr class="more"><td>+${report.overflow.pageCount} more pages</td>`
        + `<td class="num">${formatUsdFromMills(report.overflow.metrics.yesterday.currentMills)}</td><td></td><td></td></tr>`,
    );
  }

  const heroDir = metricDirection(y);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent;font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Liberation Sans",sans-serif}
#card{width:520px;background:#ffffff;color:#15161a;border:1px solid #e7e8ec;border-radius:18px;padding:22px 24px}
.head{font-size:13px;color:#8a8d94;font-weight:500;letter-spacing:.02em}
.hero{display:flex;align-items:baseline;gap:10px;margin-top:4px}
.hero .amt{font-size:32px;font-weight:700;letter-spacing:-.01em}
.pill{font-size:14px;font-weight:600;padding:3px 9px;border-radius:8px}
.pill.up{color:#127a3e;background:#e7f6ed}.pill.down{color:#c0392b;background:#fbeceb}.pill.flat{color:#6b7077;background:#f0f1f3}
table{width:100%;border-collapse:collapse;margin-top:16px;font-size:15px;font-variant-numeric:tabular-nums}
td{padding:3px 0;vertical-align:baseline}
.num{text-align:right;white-space:nowrap;padding-left:14px}
.delta{text-align:right;white-space:nowrap;width:64px;font-weight:500}
.delta.up{color:#127a3e}.delta.down{color:#c0392b}.delta.flat{color:#9a9da3}
.share{text-align:right;white-space:nowrap;width:48px;color:#9a9da3;font-size:13px}
.win td{color:#6b7077;font-size:14px}
.model td{font-weight:700;border-top:1px solid #eef0f3;padding-top:10px}
.model .num{font-weight:700}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px;vertical-align:1px}
.dot.up{background:#22a35a}.dot.down{background:#e0483f}.dot.flat{background:#b7bac0}
.page td{color:#52555c}.page td:first-child{padding-left:17px}
.empty td{color:#a3a6ac;font-size:13px;padding-top:6px}
.more td{color:#8a8d94;font-style:italic;font-size:14px;padding-top:8px}
.spacer td{height:6px;padding:0}
.foot{margin-top:16px;font-size:12px;color:#a3a6ac;font-style:italic}
</style></head><body><div id="card">
<div class="head">Revenue · ${escapeHtml(formatReportDate(report.reportDate))}</div>
<div class="hero"><span class="amt">${formatUsdFromMills(y.currentMills)}</span><span class="pill ${heroDir}">${escapeHtml(formatDeltaCompact(y))}</span></div>
<table>${rows.join("")}</table>
<div class="foot">Windows: UTC · excluding today</div>
</div></body></html>`;
}

async function loadPlaywrightChromium() {
  const packageName = "playwright";
  const playwright = await import(packageName) as {
    chromium: {
      launch(options: Record<string, unknown>): Promise<PlaywrightBrowser>;
    };
  };
  return playwright.chromium;
}

interface PlaywrightBrowser {
  newContext(options: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
}
interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
}
interface PlaywrightPage {
  setContent(html: string, options?: Record<string, unknown>): Promise<void>;
  locator(selector: string): { screenshot(options: Record<string, unknown>): Promise<Buffer> };
}

/**
 * Renders the report to a PNG via headless chromium (already provisioned in the
 * image for the public-profile resolver). Launch-per-render is fine for a
 * once-daily + manual report; the caller falls back to a text message on failure.
 */
export async function renderDailyRevenueReportImage(report: ReportData): Promise<Buffer> {
  const chromium = await loadPlaywrightChromium();
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 560, height: 800 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.setContent(buildDailyRevenueReportHtml(report), { waitUntil: "load" });
    return await page.locator("#card").screenshot({ type: "png" });
  } finally {
    await browser.close();
  }
}
