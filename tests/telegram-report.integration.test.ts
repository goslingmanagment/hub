import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  dailyRevenue,
  getLatestScheduledReportDateOnOrBefore,
  getTelegramSettings,
  hasScheduledReportForDate,
  insertDeliveryAttempt,
  listDeliveryAttempts,
  updateTelegramSettings,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import {
  buildDailyRevenueTelegramReport,
  sendDailyRevenueTelegramReport,
  sendManualDailyRevenueTelegramReport,
  TOP_PAGE_LIMIT,
} from "../apps/runtime/src/services/telegram-report.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

async function insertRevenue(
  testDb: StartedTestDatabase,
  input: {
    pageId: number;
    businessDate: string;
    creatorNetAmountMills: bigint;
  },
) {
  await testDb.db.insert(dailyRevenue).values({
    platformAccountId: input.pageId,
    businessDate: input.businessDate,
    canonicalType: "tip",
    transactionState: "posted",
    transactionCount: 1,
    grossAmountMills: input.creatorNetAmountMills,
    creatorNetAmountMills: input.creatorNetAmountMills,
  });
}

async function seedTelegramDbCredentials(
  testDb: StartedTestDatabase,
  input?: {
    enabled?: boolean;
    dailyReportEnabled?: boolean;
    chatId?: string;
    botToken?: string;
  },
) {
  const app = createTestAppContext(testDb);
  await getTelegramSettings(testDb.db, {
    defaultReportHourUtc: app.config.telegramReportHourUtc,
  });

  await updateTelegramSettings(testDb.db, {
    enabled: input?.enabled,
    dailyReportEnabled: input?.dailyReportEnabled,
    encryptedBotToken: JSON.stringify(
      encryptJson(
        input?.botToken ?? "123:abc",
        app.config.encryptionKey,
        app.config.encryptionKeyVersion,
      ),
    ),
    chatId: input?.chatId ?? "6065935464",
  });
}

describe("telegram revenue report integration", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);
  });

  it("builds a combined cross-platform report with top-page truncation and UTC windows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;

    const alphaModel = await createModel(activeTestDb.db, {
      slug: "alpha",
      name: "Alpha Model",
    });
    const betaModel = await createModel(activeTestDb.db, {
      slug: "beta",
      name: "Beta Model",
    });
    const gammaModel = await createModel(activeTestDb.db, {
      slug: "gamma",
      name: "Gamma Model",
    });

    const alphaFansly = await createFanslyPage(activeTestDb.db, {
      modelId: alphaModel.id,
      label: "alpha-fansly",
    });
    const alphaOnlyFans = await createOnlyFansPage(activeTestDb.db, {
      modelId: alphaModel.id,
      label: "alpha-onlyfans",
    });
    const betaMain = await createFanslyPage(activeTestDb.db, {
      modelId: betaModel.id,
      label: "beta-main",
    });

    const gammaPages = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        createFanslyPage(activeTestDb.db, {
          modelId: gammaModel.id,
          label: `gamma-${index + 1}`,
        })),
    );

    const [gamma1, gamma2, gamma3, gamma4, gamma5, gamma6, gamma7, gamma8, gamma9] = gammaPages;

    const yesterdayRevenues = new Map<number, bigint>([
      [alphaFansly.id, 120_000n],
      [alphaOnlyFans.id, 80_000n],
      [betaMain.id, 70_000n],
      [gamma1.id, 60_000n],
      [gamma2.id, 50_000n],
      [gamma3.id, 40_000n],
      [gamma4.id, 30_000n],
      [gamma5.id, 20_000n],
      [gamma6.id, 10_000n],
      [gamma7.id, 9_000n],
      [gamma8.id, 8_000n],
      [gamma9.id, 7_000n],
    ]);

    for (const [pageId, amount] of yesterdayRevenues.entries()) {
      await insertRevenue(testDb, {
        pageId,
        businessDate: "2026-03-19",
        creatorNetAmountMills: amount,
      });
    }

    await Promise.all([
      insertRevenue(testDb, {
        pageId: alphaFansly.id,
        businessDate: "2026-03-18",
        creatorNetAmountMills: 30_000n,
      }),
      insertRevenue(testDb, {
        pageId: alphaOnlyFans.id,
        businessDate: "2026-03-17",
        creatorNetAmountMills: 20_000n,
      }),
      insertRevenue(testDb, {
        pageId: betaMain.id,
        businessDate: "2026-03-14",
        creatorNetAmountMills: 10_000n,
      }),
      insertRevenue(testDb, {
        pageId: alphaFansly.id,
        businessDate: "2026-03-12",
        creatorNetAmountMills: 60_000n,
      }),
      insertRevenue(testDb, {
        pageId: alphaOnlyFans.id,
        businessDate: "2026-03-10",
        creatorNetAmountMills: 40_000n,
      }),
      insertRevenue(testDb, {
        pageId: alphaFansly.id,
        businessDate: "2026-02-25",
        creatorNetAmountMills: 15_000n,
      }),
      insertRevenue(testDb, {
        pageId: alphaOnlyFans.id,
        businessDate: "2026-02-28",
        creatorNetAmountMills: 5_000n,
      }),
      insertRevenue(testDb, {
        pageId: alphaFansly.id,
        businessDate: "2026-02-10",
        creatorNetAmountMills: 30_000n,
      }),
      insertRevenue(testDb, {
        pageId: alphaOnlyFans.id,
        businessDate: "2026-02-05",
        creatorNetAmountMills: 10_000n,
      }),
      insertRevenue(testDb, {
        pageId: alphaFansly.id,
        businessDate: "2026-03-20",
        creatorNetAmountMills: 999_000n,
      }),
    ]);

    const app = createTestAppContext(activeTestDb);
    const report = await buildDailyRevenueTelegramReport(app, new Date("2026-03-20T15:00:00.000Z"));

    expect(report.reportDate).toBe("2026-03-19");
    expect(report.agency.metrics.yesterday.currentMills).toBe(504_000n);
    expect(report.agency.metrics.days7.currentMills).toBe(564_000n);
    expect(report.agency.metrics.days30.currentMills).toBe(684_000n);

    const alphaRow = report.models.find((row) => row.label === "Alpha Model");
    expect(alphaRow).toBeDefined();
    expect(alphaRow?.metrics.yesterday.currentMills).toBe(200_000n);
    expect(alphaRow?.metrics.days7.currentMills).toBe(250_000n);
    expect(alphaRow?.metrics.days7.previousMills).toBe(100_000n);
    expect(alphaRow?.metrics.days30.currentMills).toBe(370_000n);
    expect(alphaRow?.metrics.days30.previousMills).toBe(40_000n);

    expect(report.pages).toHaveLength(TOP_PAGE_LIMIT);
    expect(report.pages[0]?.label).toBe("alpha-fansly");
    expect(report.pages[0]?.metrics.yesterday.currentMills).toBe(120_000n);
    expect(report.pages[0]?.metrics.days7.currentMills).toBe(150_000n);
    expect(report.pages[0]?.metrics.days7.previousMills).toBe(60_000n);

    expect(report.overflow).toEqual(expect.objectContaining({
      pageCount: 2,
    }));
    expect(report.overflow?.metrics.yesterday.currentMills).toBe(15_000n);

    expect(report.pages[0]?.modelLabel).toBe("Alpha Model");

    expect(report.parseMode).toBe("HTML");
    expect(report.text).toContain("Revenue ·");
    // Date rendered with weekday, e.g. "… 19 Mar" (weekday-independent substring).
    expect(report.text).toContain("19 Mar");
    // Proportional layout — never a <pre> code block (renders with copy chrome).
    expect(report.text).not.toContain("<pre>");
    // Model is a bold line; pages follow as plain indented lines.
    expect(report.text).toContain("<b>Alpha Model</b>");
    expect(report.text).toContain("$200.00");
    expect(report.text).toContain("alpha-fansly");
    expect(report.text).toContain("$120.00");
    expect(report.text).toContain(`+${report.overflow?.pageCount} more`);
    expect(report.text).toContain("Windows: UTC");
    expect(report.text).not.toContain("$999.00");
  });

  it("treats only sent scheduled deliveries as completed for a report date", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await insertDeliveryAttempt(testDb.db, {
      kind: "daily_report_scheduled",
      status: "failed",
      reportDate: "2026-03-19",
      error: "timeout",
    });
    expect(await hasScheduledReportForDate(testDb.db, "2026-03-19")).toBe(false);

    await insertDeliveryAttempt(testDb.db, {
      kind: "daily_report_manual",
      status: "sent",
      reportDate: "2026-03-19",
      messageId: 1,
    });
    expect(await hasScheduledReportForDate(testDb.db, "2026-03-19")).toBe(false);

    await insertDeliveryAttempt(testDb.db, {
      kind: "daily_report_scheduled",
      status: "sent",
      reportDate: "2026-03-19",
      messageId: 2,
    });
    expect(await hasScheduledReportForDate(testDb.db, "2026-03-19")).toBe(true);
  });

  it("returns the latest successful scheduled report date on or before a bound", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await insertDeliveryAttempt(testDb.db, {
      kind: "daily_report_scheduled",
      status: "sent",
      reportDate: "2026-03-18",
      messageId: 1,
    });
    await insertDeliveryAttempt(testDb.db, {
      kind: "daily_report_scheduled",
      status: "failed",
      reportDate: "2026-03-19",
      error: "timeout",
    });
    await insertDeliveryAttempt(testDb.db, {
      kind: "daily_report_manual",
      status: "sent",
      reportDate: "2026-03-20",
      messageId: 2,
    });
    await insertDeliveryAttempt(testDb.db, {
      kind: "daily_report_scheduled",
      status: "sent",
      reportDate: "2026-03-21",
      messageId: 3,
    });

    expect(await getLatestScheduledReportDateOnOrBefore(testDb.db, "2026-03-17")).toBe(null);
    expect(await getLatestScheduledReportDateOnOrBefore(testDb.db, "2026-03-20")).toBe("2026-03-18");
    expect(await getLatestScheduledReportDateOnOrBefore(testDb.db, "2026-03-21")).toBe("2026-03-21");
  });

  it("sends the scheduled report with DB-only credentials and records the delivery attempt", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          message_id: 77,
        },
      }),
    } as never);

    await seedTelegramDbCredentials(testDb);

    const app = createTestAppContext(testDb);
    const result = await sendDailyRevenueTelegramReport(app, new Date("2026-03-20T15:00:00.000Z"));

    expect(result.delivery).toEqual({
      status: "sent",
      chatId: "6065935464",
      messageId: 77,
    });
    expect(result.report?.reportDate).toBe("2026-03-19");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const attempts = await listDeliveryAttempts(testDb.db, {
      kind: ["daily_report_scheduled"],
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual(expect.objectContaining({
      kind: "daily_report_scheduled",
      status: "sent",
      reportDate: "2026-03-19",
      messageId: 77,
      error: null,
    }));
  });

  it("skips scheduled reports when disabled but still allows manual sends with DB-only credentials", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          message_id: 88,
        },
      }),
    } as never);

    await seedTelegramDbCredentials(testDb, {
      enabled: false,
      dailyReportEnabled: false,
    });

    const app = createTestAppContext(testDb);
    const scheduled = await sendDailyRevenueTelegramReport(app, new Date("2026-03-20T15:00:00.000Z"));

    expect(scheduled).toEqual({
      delivery: {
        status: "skipped",
        reason: "disabled",
      },
      report: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const manual = await sendManualDailyRevenueTelegramReport(app, new Date("2026-03-20T15:00:00.000Z"));
    expect(manual.delivery).toEqual({
      status: "sent",
      chatId: "6065935464",
      messageId: 88,
    });
    expect(manual.report?.reportDate).toBe("2026-03-19");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const attempts = await listDeliveryAttempts(testDb.db, {
      kind: ["daily_report_scheduled", "daily_report_manual"],
    });
    expect(attempts).toHaveLength(2);
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "daily_report_scheduled",
        status: "skipped",
        reportDate: null,
        messageId: null,
        error: "disabled",
      }),
      expect.objectContaining({
        kind: "daily_report_manual",
        status: "sent",
        reportDate: "2026-03-19",
        messageId: 88,
        error: null,
      }),
    ]));
  });
});
