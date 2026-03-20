import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  dailyRevenue,
} from "@agency_hub_core/db";

import { buildDailyRevenueTelegramReport, TOP_PAGE_LIMIT } from "../apps/runtime/src/services/telegram-report.ts";
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

    expect(report.text).toContain("📈 Daily Revenue Report");
    expect(report.text).toContain("2026-03-19 UTC");
    expect(report.text).toContain("Alpha Model | Y $200.00");
    expect(report.text).toContain("alpha-fansly | Y $120.00");
    expect(report.text).toContain(`+${report.overflow?.pageCount} more pages`);
    expect(report.text).toContain("n/a");
    expect(report.text).not.toContain("$999.00");
  });
});
