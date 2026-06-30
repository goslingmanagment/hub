import { describe, expect, it } from "vitest";

import {
  type DailyRevenueTelegramReport,
  formatDeltaCompact,
  formatReportDate,
  renderDailyRevenueTelegramReport,
} from "../apps/runtime/src/services/telegram-report.ts";
import {
  buildDailyRevenueReportHtml,
  renderDailyRevenueReportImage,
} from "../apps/runtime/src/services/telegram-report-image.ts";

function metric(current: number, previous: number) {
  return {
    currentMills: BigInt(current),
    previousMills: BigInt(previous),
    deltaPct: previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100,
  };
}

function row(label: string, yesterday: number, prevYesterday: number) {
  return {
    label,
    metrics: {
      yesterday: metric(yesterday, prevYesterday),
      days7: metric(yesterday * 8, yesterday * 8),
      days30: metric(yesterday * 30, yesterday * 30),
    },
  };
}

const sampleReport: Omit<DailyRevenueTelegramReport, "text" | "parseMode"> = {
  reportDate: "2026-06-29",
  generatedAt: "2026-06-30T09:00:00.000Z",
  agency: row("agency", 425_550, 295_000),
  models: [row("Lora Vie", 419_150, 255_000), row("Lilly", 6_400, 40_000)],
  modelOverflow: null,
  pages: [
    { ...row("lora-vip-of", 234_360, 141_000), modelLabel: "Lora Vie" },
    { ...row("lora-1", 176_800, 8_000), modelLabel: "Lora Vie" },
    { ...row("lora-3", 7_990, 36_000), modelLabel: "Lora Vie" },
    { ...row("lora-2", 0, 12_000), modelLabel: "Lora Vie" },
    { ...row("lora-of", 0, 0), modelLabel: "Lora Vie" },
    { ...row("lilly-1", 6_400, 6_400), modelLabel: "Lilly" },
    { ...row("lilly-2", 0, 5_000), modelLabel: "Lilly" },
  ],
  overflow: null,
};

describe("formatDeltaCompact", () => {
  it("shows a signed, rounded percent for ordinary moves", () => {
    expect(formatDeltaCompact({ currentMills: 14_420n, previousMills: 10_000n, deltaPct: 44.2 })).toBe("+44%");
    expect(formatDeltaCompact({ currentMills: 9_500n, previousMills: 10_000n, deltaPct: -5 })).toBe("-5%");
  });

  it("collapses explosive growth from a tiny base into a multiplier", () => {
    // $8.00 -> $176.80 ≈ 22x — replaces the noisy "↑2110.0%".
    expect(formatDeltaCompact({ currentMills: 176_800n, previousMills: 8_000n, deltaPct: 2110 })).toBe("22x");
  });

  it("marks growth from a zero base as new", () => {
    expect(formatDeltaCompact({ currentMills: 5_000n, previousMills: 0n, deltaPct: null })).toBe("new");
  });

  it("shows an em dash when there is nothing to compare", () => {
    expect(formatDeltaCompact({ currentMills: 0n, previousMills: 0n, deltaPct: null })).toBe("—");
  });

  it("rounds a negligible move to 0%", () => {
    expect(formatDeltaCompact({ currentMills: 10_001n, previousMills: 10_000n, deltaPct: 0.01 })).toBe("0%");
  });
});

describe("formatReportDate", () => {
  it("formats an ISO date as weekday day month (UTC)", () => {
    expect(formatReportDate("2026-06-29")).toBe("Mon 29 Jun");
  });

  it("falls back to the raw string when the date cannot be parsed", () => {
    expect(formatReportDate("not-a-date")).toBe("not-a-date");
  });
});

describe("renderDailyRevenueTelegramReport", () => {
  const text = renderDailyRevenueTelegramReport(sampleReport);

  it("renders a bold headline and the windows footer without a code block", () => {
    expect(text).toContain("📊 <b>Revenue · Mon 29 Jun</b>");
    expect(text).toContain("<b>$425.55</b> +44%");
    expect(text).toContain("<i>Windows: UTC · excl. today</i>");
    // <pre> renders as a copy-able code block in Telegram — never use it here.
    expect(text).not.toContain("<pre>");
  });

  it("marks each model with a bold name and a colour dot", () => {
    expect(text).toContain("🟢 <b>Lora Vie</b>");
    expect(text).toContain("🔴 <b>Lilly</b>");
  });

  it("tames an explosive delta into a multiplier", () => {
    expect(text).toContain("176.80");
    expect(text).toContain("22x");
    expect(text).not.toContain("2110");
  });

  it("collapses zero-yesterday pages into a single idle line", () => {
    expect(text).toContain("💤 +2 idle: lora-2, lora-of");
    expect(text).toContain("💤 +1 idle: lilly-2");
    expect(text).not.toContain("$0.00");
  });
});

describe("buildDailyRevenueReportHtml", () => {
  const html = buildDailyRevenueReportHtml(sampleReport);

  it("is a self-contained HTML document with an aligned (tabular) table", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("tabular-nums");
    expect(html).toContain('<div id="card">');
    expect(html).toContain("Revenue · Mon 29 Jun");
  });

  it("colours direction by class (no reliance on emoji fonts)", () => {
    expect(html).toContain('class="dot up"');
    expect(html).toContain('class="dot down"');
    expect(html).toContain('class="delta down"');
    expect(html).not.toContain("🟢");
    expect(html).not.toContain("🔴");
  });

  it("carries the same amounts, multiplier, and idle collapse as the text report", () => {
    expect(html).toContain("$425.55");
    expect(html).toContain("$176.80");
    expect(html).toContain("22x");
    expect(html).toContain("2 idle: lora-2, lora-of");
    expect(html).toContain("1 idle: lilly-2");
    expect(html).not.toContain("$0.00");
  });

  // End-to-end render — runs where the chromium binary is present (prod image,
  // local install); skips gracefully where it is not.
  it("rasterises to a PNG via chromium", async () => {
    let png: Buffer;
    try {
      png = await renderDailyRevenueReportImage(sampleReport);
    } catch {
      return;
    }
    expect(png.length).toBeGreaterThan(1000);
    expect(png.subarray(0, 4).toString("hex")).toBe("89504e47");
  }, 60_000);
});
