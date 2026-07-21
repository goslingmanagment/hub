import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  listLinkStatRuns,
  listLinkStatSnapshots,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { runOfapiLinkStatsReconcile } from "../apps/runtime/src/services/ofapi-link-stats-sync.ts";
import type { OfapiClient, OfapiListPage } from "../apps/runtime/src/services/ofapi.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {
    ofapiLinkStatsReconcileEnabled: true,
    ofapiCreditLedgerEnabled: true,
  });
});

async function seedOfapiPage(label: string, ofapiAccountId: string) {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  if (!model) {
    throw new Error("model seed failed");
  }
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  if (!page) {
    throw new Error("page seed failed");
  }
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId });
  return page;
}

function trackingItem(): Record<string, unknown> {
  return {
    id: 2117449,
    campaignCode: 7,
    campaignName: "waptap",
    campaignUrl: "https://onlyfans.com/loravie/c7",
    subscribersCount: 19,
    clicksCount: 82,
    createdAt: "2025-09-15T10:17:11+00:00",
    endDate: null,
    tags: [],
    revenue: {
      total: 0,
      revenuePerSubscriber: 0,
      revenuePerClick: 0,
      spendersCount: 0,
      calculatedAt: "2026-07-21T00:18:23.000000Z",
      isLoading: false,
    },
  };
}

function trialItem(): Record<string, unknown> {
  return {
    id: 11365057,
    trialLinkName: "blog 18.06.26",
    url: "https://onlyfans.com/loravievip/trial/xxxxxxxx",
    subscribeDays: 360,
    subscribeCounts: 0,
    claimCounts: 323,
    clicksCounts: 611,
    expiredAt: null,
    createdAt: "2026-06-17T00:00:00+00:00",
    isFinished: false,
    revenue: {
      total: 144.8,
      revenuePerSubscriber: 0.4482972136222911,
      spendersCount: 7,
      calculatedAt: "2026-07-21T21:05:40.000000Z",
      isLoading: false,
    },
  };
}

function linksClient(input: {
  trackingByAccount: Map<string, Record<string, unknown>[]>;
  trialByAccount: Map<string, Record<string, unknown>[]>;
  failTrialFor?: string;
}): OfapiClient {
  const empty: Record<string, unknown>[] = [];
  const page = (items: Record<string, unknown>[]): OfapiListPage => ({
    items,
    hasNextPage: false,
    nextMarker: null,
    nextPageUrl: null,
    meta: null,
  });
  return {
    async listTrackingLinks(_context: unknown, accountId: string): Promise<OfapiListPage> {
      return page(input.trackingByAccount.get(accountId) ?? empty);
    },
    async listTrialLinks(_context: unknown, accountId: string): Promise<OfapiListPage> {
      if (input.failTrialFor === accountId) {
        throw new Error("trial endpoint down");
      }
      return page(input.trialByAccount.get(accountId) ?? empty);
    },
  } as unknown as OfapiClient;
}

describe("OFAPI link-stats reconcile", () => {
  it("writes runs and snapshots with mills conversion", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-of", "acct_links");
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([["acct_links", [trackingItem()]]]),
        trialByAccount: new Map([["acct_links", [trialItem()]]]),
      }),
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages).toEqual([
      expect.objectContaining({ pageLabel: page.label, status: "written" }),
    ]);

    const runs = await listLinkStatRuns(appContext.db, { platformAccountId: page.id });
    expect(runs).toHaveLength(2);
    const trackingRun = runs.find((run) => run.linkKind === "tracking");
    const trialRun = runs.find((run) => run.linkKind === "trial");
    expect(trackingRun).toMatchObject({
      platformAccountId: page.id,
      status: "complete",
      rawItems: 1,
      writtenRows: 1,
    });
    expect(trialRun).toMatchObject({
      platformAccountId: page.id,
      status: "complete",
      rawItems: 1,
      writtenRows: 1,
    });
    if (!trackingRun || !trialRun) {
      throw new Error("expected tracking and trial runs");
    }

    const [trackingSnapshot] = await listLinkStatSnapshots(appContext.db, {
      runId: trackingRun.id,
    });
    const [trialSnapshot] = await listLinkStatSnapshots(appContext.db, {
      runId: trialRun.id,
    });
    expect(trackingSnapshot).toMatchObject({
      runId: trackingRun.id,
      platformAccountId: page.id,
      platformLinkId: "2117449",
      clicksCount: 82,
      subscribersCount: 19,
      claimsCount: null,
    });
    expect(trialSnapshot).toMatchObject({
      runId: trialRun.id,
      platformAccountId: page.id,
      platformLinkId: "11365057",
      clicksCount: 611,
      subscribersCount: 0,
      claimsCount: 323,
      spendersCount: 7,
      revenueGrossMills: 144800n,
    });
    expect(trialSnapshot?.revenueCalculatedAt).toBeInstanceOf(Date);
  });

  it("second run appends, never overwrites", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-append-of", "acct_append");
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([["acct_append", [trackingItem()]]]),
        trialByAccount: new Map([["acct_append", [trialItem()]]]),
      }),
    };

    await runOfapiLinkStatsReconcile(appContext);
    await runOfapiLinkStatsReconcile(appContext);

    const runs = await listLinkStatRuns(appContext.db, { platformAccountId: page.id });
    expect(runs).toHaveLength(4);
    const trackingRuns = runs.filter((run) => run.linkKind === "tracking");
    expect(trackingRuns).toHaveLength(2);
    expect(new Set(trackingRuns.map((run) => run.id)).size).toBe(2);

    const snapshots = await Promise.all(trackingRuns.map(async (run) => {
      const [snapshot] = await listLinkStatSnapshots(appContext.db, { runId: run.id });
      return snapshot;
    }));
    expect(snapshots.every((snapshot) => snapshot?.platformLinkId === "2117449")).toBe(true);
    expect(new Set(snapshots.map((snapshot) => snapshot?.runId)).size).toBe(2);
    expect(snapshots.map((snapshot) => ({
      platformAccountId: snapshot?.platformAccountId,
      linkKind: snapshot?.linkKind,
      platformLinkId: snapshot?.platformLinkId,
      clicksCount: snapshot?.clicksCount,
      subscribersCount: snapshot?.subscribersCount,
      claimsCount: snapshot?.claimsCount,
      revenueGrossMills: snapshot?.revenueGrossMills,
    }))).toEqual([
      {
        platformAccountId: page.id,
        linkKind: "tracking",
        platformLinkId: "2117449",
        clicksCount: 82,
        subscribersCount: 19,
        claimsCount: null,
        revenueGrossMills: 0n,
      },
      {
        platformAccountId: page.id,
        linkKind: "tracking",
        platformLinkId: "2117449",
        clicksCount: 82,
        subscribersCount: 19,
        claimsCount: null,
        revenueGrossMills: 0n,
      },
    ]);
  });

  it("keeps a completed kind when the other endpoint fails", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-fail-of", "acct_fail");
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([["acct_fail", [trackingItem()]]]),
        trialByAccount: new Map([["acct_fail", [trialItem()]]]),
        failTrialFor: "acct_fail",
      }),
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages).toEqual([
      expect.objectContaining({
        pageLabel: page.label,
        status: "failed",
        reason: "trial endpoint down",
      }),
    ]);

    const trackingRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    });
    expect(trackingRuns).toHaveLength(1);
    expect(trackingRuns[0]).toMatchObject({ status: "complete", writtenRows: 1 });
    expect(await listLinkStatSnapshots(appContext.db, {
      runId: trackingRuns[0]!.id,
    })).toHaveLength(1);

    const trialRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "trial",
    });
    expect(trialRuns).toEqual([]);
  });

  it("skips invalid items with reasons", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-invalid-of", "acct_invalid");
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([[
          "acct_invalid",
          [trackingItem(), { ...trackingItem(), id: undefined }],
        ]]),
        trialByAccount: new Map([[
          "acct_invalid",
          [trialItem(), { ...trialItem(), clicksCounts: -5 }],
        ]]),
      }),
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages[0]).toMatchObject({ status: "written" });
    expect(result.pages[0]?.kinds).toEqual([
      expect.objectContaining({
        linkKind: "tracking",
        rawItems: 2,
        writtenRows: 1,
        skippedReasons: { missing_link_id: 1 },
      }),
      expect.objectContaining({
        linkKind: "trial",
        rawItems: 2,
        writtenRows: 1,
        skippedReasons: { invalid_clicks_count: 1 },
      }),
    ]);

    const runs = await listLinkStatRuns(appContext.db, { platformAccountId: page.id });
    expect(runs).toHaveLength(2);
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ linkKind: "tracking", rawItems: 2, writtenRows: 1 }),
      expect.objectContaining({ linkKind: "trial", rawItems: 2, writtenRows: 1 }),
    ]));
  });

  it("does no work while the flag is off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, {
      ofapiLinkStatsReconcileEnabled: false,
      ofapiCreditLedgerEnabled: true,
    });
    const page = await seedOfapiPage("links-off-of", "acct_off");
    const listTrackingLinks = vi.fn(async (): Promise<OfapiListPage> => ({
      items: [],
      hasNextPage: false,
      nextMarker: null,
      nextPageUrl: null,
      meta: null,
    }));
    const listTrialLinks = vi.fn(async (): Promise<OfapiListPage> => ({
      items: [],
      hasNextPage: false,
      nextMarker: null,
      nextPageUrl: null,
      meta: null,
    }));
    appContext = {
      ...appContext,
      ofapi: { listTrackingLinks, listTrialLinks } as unknown as OfapiClient,
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages).toEqual([]);
    expect(listTrackingLinks).not.toHaveBeenCalled();
    expect(listTrialLinks).not.toHaveBeenCalled();
    expect(await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
    })).toEqual([]);
  });
});
