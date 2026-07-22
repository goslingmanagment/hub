import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertLinkStatRunWithSnapshots,
  listLinkStatRuns,
  listLinkStatSnapshots,
  listNotificationIncidents,
  setPageOfapiAccountId,
  type InsertLinkStatSnapshotInput,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  runOfapiLinkStatsReconcile,
  startOfapiLinkStatsWorker,
} from "../apps/runtime/src/services/ofapi-link-stats-sync.ts";
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
  failTrialFor?: string | undefined;
  failTrackingFor?: string | undefined;
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
    async listStoredTrackingLinks(_context: unknown, accountId: string): Promise<OfapiListPage> {
      if (input.failTrackingFor === accountId) {
        throw new Error("tracking endpoint down");
      }
      return page(input.trackingByAccount.get(accountId) ?? empty);
    },
    async listStoredTrialLinks(_context: unknown, accountId: string): Promise<OfapiListPage> {
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
      // A computed vendor zero stays a REAL zero (isLoading=false) — nullable
      // money is only for unknown values.
      spendersCount: 0,
      revenueGrossMills: 0n,
      revenueIsLoading: false,
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

    // Lane attribution: the fake client never acknowledges spend, so the two
    // 1-credit reservations stay charged — and they must sit on the DEDICATED
    // link_stats counter, with the chargebacks backfill lane untouched.
    const counters = await testDb!.pool.query(
      `select link_stats_spent_credits, backfill_spent_credits from ofapi_credit_state where id = 1`,
    );
    expect(counters.rows[0]).toMatchObject({
      link_stats_spent_credits: 2,
      backfill_spent_credits: 0,
    });
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
    const clientInput = {
      trackingByAccount: new Map([["acct_fail", [trackingItem()]]]),
      trialByAccount: new Map([["acct_fail", [trialItem()]]]),
      failTrialFor: "acct_fail" as string | undefined,
    };
    appContext = { ...appContext, ofapi: linksClient(clientInput) };

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

    // The failed fleet pass opens ONE durable global incident.
    let incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      incidentKey: "ofapi_link_stats_reconcile_failed:global",
      kind: "ofapi_link_stats_reconcile_failed",
      platformAccountId: null,
      status: "open",
    });

    // The pg-boss worker surfaces the failure as a terminal job error.
    let workerHandler: (() => Promise<void>) | null = null;
    await startOfapiLinkStatsWorker(appContext, {
      async work(_queue, _options, handler) {
        workerHandler = handler;
        return null;
      },
    });
    expect(workerHandler).not.toBeNull();
    await expect(workerHandler!()).rejects.toThrow(
      "OFAPI link-stats reconcile failed for 1 page(s)",
    );
    incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.status).toBe("open");

    // A pass that runs NOTHING (client without the stored methods => every
    // page 'skipped') proves nothing and must NOT close the latch.
    const savedClient = appContext.ofapi;
    appContext = { ...appContext, ofapi: {} as unknown as OfapiClient };
    const skippedPass = await runOfapiLinkStatsReconcile(appContext);
    expect(skippedPass.pages[0]).toMatchObject({ status: "skipped" });
    incidents = await listNotificationIncidents(appContext.db);
    expect(incidents[0]!.status).toBe("open");
    appContext = { ...appContext, ofapi: savedClient };

    // A fully written recovery pass resolves the incident.
    clientInput.failTrialFor = undefined;
    const recovered = await runOfapiLinkStatsReconcile(appContext);
    expect(recovered.pages.map((result_) => result_.status)).toEqual(["written"]);
    incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "ofapi_link_stats_reconcile_failed",
      status: "resolved",
    });
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
    // Normalization drops demote the kind (and the page) to 'partial' — a
    // walk that lost items must be visible, not a quiet 'written'.
    expect(result.pages[0]).toMatchObject({ status: "partial" });
    expect(result.pages[0]?.kinds).toEqual([
      expect.objectContaining({
        linkKind: "tracking",
        status: "partial",
        rawItems: 2,
        writtenRows: 1,
        skippedReasons: { missing_link_id: 1 },
      }),
      expect.objectContaining({
        linkKind: "trial",
        status: "partial",
        rawItems: 2,
        writtenRows: 1,
        skippedReasons: { invalid_clicks_count: 1 },
      }),
    ]);

    // A walk with normalization drops is 'partial', never 'complete': the
    // skipped link still exists at the vendor and must not read as deleted.
    const runs = await listLinkStatRuns(appContext.db, { platformAccountId: page.id });
    expect(runs).toHaveLength(2);
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        linkKind: "tracking", status: "partial", rawItems: 2, writtenRows: 1,
      }),
      expect.objectContaining({
        linkKind: "trial", status: "partial", rawItems: 2, writtenRows: 1,
      }),
    ]));
  });

  it("stores unknown revenue as NULL, never a fake zero", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-loading-of", "acct_loading");
    const loadingTracking = {
      ...trackingItem(),
      id: 111,
      revenue: {
        total: 0,
        spendersCount: 0,
        calculatedAt: null,
        isLoading: true,
      },
    };
    const noRevenueTrial = { ...trialItem(), id: 222, revenue: undefined };
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([["acct_loading", [loadingTracking]]]),
        trialByAccount: new Map([["acct_loading", [noRevenueTrial]]]),
      }),
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages[0]).toMatchObject({ status: "written" });

    const runs = await listLinkStatRuns(appContext.db, { platformAccountId: page.id });
    const trackingRun = runs.find((run) => run.linkKind === "tracking");
    const trialRun = runs.find((run) => run.linkKind === "trial");
    const [loadingSnapshot] = await listLinkStatSnapshots(appContext.db, {
      runId: trackingRun!.id,
    });
    const [absentSnapshot] = await listLinkStatSnapshots(appContext.db, {
      runId: trialRun!.id,
    });
    // isLoading=true: the vendor has not finished computing — the zeros in
    // the payload are placeholders, not earnings.
    expect(loadingSnapshot).toMatchObject({
      platformLinkId: "111",
      spendersCount: null,
      revenueGrossMills: null,
      revenueIsLoading: true,
    });
    // Missing revenue block entirely: unknown, not zero.
    expect(absentSnapshot).toMatchObject({
      platformLinkId: "222",
      spendersCount: null,
      revenueGrossMills: null,
      revenueIsLoading: null,
    });
  });

  it("keeps walking past a short page while hasNextPage is true", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-paged-of", "acct_paged");
    const first = { ...trackingItem(), id: 1001 };
    const second = { ...trackingItem(), id: 1002 };
    const listStoredTrackingLinks = vi.fn(async (
      _context: unknown,
      _accountId: string,
      params: { offset?: number },
    ): Promise<OfapiListPage> => (
      (params.offset ?? 0) === 0
        ? { items: [first], hasNextPage: true, nextMarker: null, nextPageUrl: null, meta: null }
        : { items: [second], hasNextPage: false, nextMarker: null, nextPageUrl: null, meta: null }
    ));
    const listStoredTrialLinks = vi.fn(async (): Promise<OfapiListPage> => ({
      items: [trialItem()], hasNextPage: false, nextMarker: null, nextPageUrl: null, meta: null,
    }));
    appContext = {
      ...appContext,
      ofapi: { listStoredTrackingLinks, listStoredTrialLinks } as unknown as OfapiClient,
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages[0]).toMatchObject({ status: "written" });
    // Terminality is the vendor's hasNextPage, not the page size: the short
    // first page (1 item < limit) must NOT end the walk.
    expect(listStoredTrackingLinks).toHaveBeenCalledTimes(2);

    const [trackingRun] = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    });
    // A multi-page offset walk is never absence-proving (the live list can
    // shift between pages), so the run is 'partial' even though every fetched
    // row landed.
    expect(trackingRun).toMatchObject({ status: "partial", apiPages: 2, writtenRows: 2 });
    const snapshots = await listLinkStatSnapshots(appContext.db, { runId: trackingRun!.id });
    expect(snapshots.map((snapshot) => snapshot.platformLinkId).sort()).toEqual([
      "1001",
      "1002",
    ]);
  });

  it("keeps the trial walk when the tracking endpoint fails (both-direction isolation)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-failtrk-of", "acct_failtrk");
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([["acct_failtrk", [trackingItem()]]]),
        trialByAccount: new Map([["acct_failtrk", [trialItem()]]]),
        failTrackingFor: "acct_failtrk",
      }),
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages[0]).toMatchObject({
      status: "failed",
      reason: "tracking endpoint down",
    });
    expect(result.pages[0]?.kinds).toEqual([
      expect.objectContaining({ linkKind: "tracking", status: "failed" }),
      expect.objectContaining({ linkKind: "trial", status: "written", writtenRows: 1 }),
    ]);

    // The healthy second endpoint still landed its run + snapshot.
    const trialRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "trial",
    });
    expect(trialRuns).toHaveLength(1);
    expect(trialRuns[0]).toMatchObject({ status: "complete", writtenRows: 1 });
    expect(await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    })).toEqual([]);
  });

  it("treats a total mapping collapse as failure, not a quiet 'written'", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-collapse-of", "acct_collapse");
    // Vendor renamed the counter field: every item fails normalization. Three
    // items clear the absolute evidence threshold (MAPPING_COLLAPSE_MIN_ITEMS).
    const renamed = (id: number) => ({
      ...trackingItem(), id, clicksCount: undefined, clicks: 82,
    });
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([["acct_collapse", [renamed(1), renamed(2), renamed(3)]]]),
        trialByAccount: new Map([["acct_collapse", [trialItem()]]]),
      }),
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages[0]).toMatchObject({ status: "failed", reason: "all_items_skipped" });
    expect(result.pages[0]?.kinds).toEqual([
      expect.objectContaining({
        linkKind: "tracking",
        status: "failed",
        rawItems: 3,
        writtenRows: 0,
      }),
      expect.objectContaining({ linkKind: "trial", status: "written" }),
    ]);

    // Durable evidence survives (run row 'partial', zero snapshots), and the
    // fleet incident opens so the outage is operator-visible.
    const trackingRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    });
    expect(trackingRuns[0]).toMatchObject({ status: "partial", rawItems: 3, writtenRows: 0 });
    const incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "ofapi_link_stats_reconcile_failed",
      status: "open",
    });
  });

  it("splits a >4095-row snapshot insert into chunks inside one transaction", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-bulk-of", "acct_bulk");
    // 16 bind params per row × 4096 rows would exceed the 65535 protocol cap
    // in a single VALUES insert — the repository must chunk.
    const rows: InsertLinkStatSnapshotInput[] = Array.from({ length: 4200 }, (_, index) => ({
      platformAccountId: page.id,
      linkKind: "tracking",
      platformLinkId: String(index + 1),
      name: null,
      url: null,
      linkCreatedAt: null,
      linkEndsAt: null,
      isFinished: null,
      clicksCount: index,
      claimsCount: null,
      subscribersCount: 0,
      spendersCount: null,
      revenueGrossMills: null,
      revenueIsLoading: null,
      revenueCalculatedAt: null,
    }));

    const { runId, writtenRows } = await insertLinkStatRunWithSnapshots(
      appContext.db,
      {
        platformAccountId: page.id,
        linkKind: "tracking",
        status: "partial",
        pulledAt: new Date(),
        apiPages: 42,
        rawItems: 4200,
        writtenRows: 4200,
      },
      rows,
    );
    expect(writtenRows).toBe(4200);
    expect(await listLinkStatSnapshots(appContext.db, { runId })).toHaveLength(4200);
  });

  it("single bad item on a one-link page stays partial, not a fleet incident", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-onebad-of", "acct_onebad");
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([[
          "acct_onebad",
          [{ ...trackingItem(), clicksCount: undefined, clicks: 82 }],
        ]]),
        trialByAccount: new Map([["acct_onebad", [trialItem()]]]),
      }),
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages[0]).toMatchObject({ status: "partial" });
    expect(result.pages[0]?.kinds).toEqual([
      expect.objectContaining({ linkKind: "tracking", status: "partial", writtenRows: 0 }),
      expect.objectContaining({ linkKind: "trial", status: "written" }),
    ]);
    expect(await listNotificationIncidents(appContext.db)).toEqual([]);
    void page;
  });

  it("budget exhaustion truncates loudly enough: run rows land, fleet-wide truncation opens an incident", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-budget-of", "acct_budget");
    appContext = createTestAppContext(testDb, {
      ofapiLinkStatsReconcileEnabled: true,
      ofapiCreditLedgerEnabled: true,
    });
    const listStoredTrackingLinks = vi.fn();
    const listStoredTrialLinks = vi.fn();
    appContext = {
      ...appContext,
      ofapi: { listStoredTrackingLinks, listStoredTrialLinks } as unknown as OfapiClient,
    };
    // Deterministic exhaustion: the DEDICATED link_stats day counter is
    // pre-seeded at the 50-credit default before the run (not an artifact of
    // unreleased reservations — the real client releases them).
    await testDb.pool.query(
      `insert into ofapi_credit_state (id, link_stats_spend_day, link_stats_spent_credits)
       values (1, (now() at time zone 'utc')::date, 50)
       on conflict (id) do update
         set link_stats_spend_day = excluded.link_stats_spend_day,
             link_stats_spent_credits = excluded.link_stats_spent_credits`,
    );

    const result = await runOfapiLinkStatsReconcile(appContext);
    // Both kinds block before their first request: truncated run rows with
    // zero snapshots and zero client calls...
    expect(listStoredTrackingLinks).not.toHaveBeenCalled();
    expect(listStoredTrialLinks).not.toHaveBeenCalled();
    expect(result.pages[0]).toMatchObject({ status: "truncated" });
    const runs = await listLinkStatRuns(appContext.db, { platformAccountId: page.id });
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "truncated" && run.writtenRows === 0)).toBe(true);
    // ...and the fully-truncated fleet pass opens the incident — silent empty
    // passes are impossible.
    const incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "ofapi_link_stats_reconcile_failed",
      status: "open",
    });
  });

  it("marks a contradictory pagination walk truncated, never complete", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-contra-of", "acct_contra");
    const listStoredTrackingLinks = vi.fn(async (): Promise<OfapiListPage> => ({
      // Empty page that still claims continuation: vendor contradiction.
      items: [], hasNextPage: true, nextMarker: null, nextPageUrl: null, meta: null,
    }));
    const listStoredTrialLinks = vi.fn(async (): Promise<OfapiListPage> => ({
      items: [trialItem()], hasNextPage: false, nextMarker: null, nextPageUrl: null, meta: null,
    }));
    appContext = {
      ...appContext,
      ofapi: { listStoredTrackingLinks, listStoredTrialLinks } as unknown as OfapiClient,
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages[0]?.kinds).toEqual([
      expect.objectContaining({
        linkKind: "tracking",
        status: "truncated",
        reason: "pagination_contradiction",
      }),
      expect.objectContaining({ linkKind: "trial", status: "written" }),
    ]);
    const trackingRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    });
    expect(trackingRuns[0]).toMatchObject({ status: "truncated", writtenRows: 0 });
  });

  it("withholds the absence proof when a non-empty inventory vanishes in one step", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-vanish-of", "acct_vanish");
    const inventory = {
      trackingByAccount: new Map([["acct_vanish", [trackingItem()]]]),
      trialByAccount: new Map([["acct_vanish", [] as Record<string, unknown>[]]]),
    };
    appContext = { ...appContext, ofapi: linksClient(inventory) };
    await runOfapiLinkStatsReconcile(appContext);

    // The whole tracking inventory disappears at once — exactly what a
    // malformed-but-200 response looks like after client normalization.
    inventory.trackingByAccount.set("acct_vanish", []);
    const second = await runOfapiLinkStatsReconcile(appContext);
    expect(second.pages[0]?.kinds).toEqual([
      expect.objectContaining({
        linkKind: "tracking",
        status: "partial",
        reason: "inventory_vanished",
      }),
      // Trial was empty from the start (no non-empty baseline) — a genuinely
      // empty inventory stays 'written' with a 'complete' run.
      expect.objectContaining({ linkKind: "trial", status: "written" }),
    ]);
    let trackingRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    });
    expect(trackingRuns.map((run) => run.status)).toEqual(["partial", "complete"]);

    // Third empty walk: the baseline is now the empty 'partial' run, so the
    // emptiness is confirmed and the guard converges to a genuine 'complete'.
    const third = await runOfapiLinkStatsReconcile(appContext);
    expect(third.pages[0]?.kinds).toEqual([
      expect.objectContaining({ linkKind: "tracking", status: "written" }),
      expect.objectContaining({ linkKind: "trial", status: "written" }),
    ]);
    trackingRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    });
    expect(trackingRuns.map((run) => run.status)).toEqual(["complete", "partial", "complete"]);
  });

  it("flags a wipe even when the non-empty baseline was only 'partial'", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-vanish2-of", "acct_vanish2");
    // First walk lands one row but drops one item => 'partial' with data.
    const inventory = {
      trackingByAccount: new Map([[
        "acct_vanish2",
        [trackingItem(), { ...trackingItem(), id: undefined }],
      ]]),
      trialByAccount: new Map([["acct_vanish2", [] as Record<string, unknown>[]]]),
    };
    appContext = { ...appContext, ofapi: linksClient(inventory) };
    await runOfapiLinkStatsReconcile(appContext);

    inventory.trackingByAccount.set("acct_vanish2", []);
    const second = await runOfapiLinkStatsReconcile(appContext);
    // A partial-but-non-empty baseline still makes a sudden wipe suspicious.
    expect(second.pages[0]?.kinds).toEqual([
      expect.objectContaining({
        linkKind: "tracking",
        status: "partial",
        reason: "inventory_vanished",
      }),
      expect.objectContaining({ linkKind: "trial", status: "written" }),
    ]);
    const trackingRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    });
    expect(trackingRuns.map((run) => run.status)).toEqual(["partial", "partial"]);
  });

  it("skips auth-dead pages entirely (Stage-26 pause)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-authdead-of", "acct_authdead");
    await testDb.pool.query(
      `update pages set ofapi_auth_status = 'authentication_failed' where id = $1`,
      [page.id],
    );
    const listStoredTrackingLinks = vi.fn();
    const listStoredTrialLinks = vi.fn();
    appContext = {
      ...appContext,
      ofapi: { listStoredTrackingLinks, listStoredTrialLinks } as unknown as OfapiClient,
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages).toEqual([]);
    expect(listStoredTrackingLinks).not.toHaveBeenCalled();
    expect(listStoredTrialLinks).not.toHaveBeenCalled();
    expect(await listLinkStatRuns(appContext.db, { platformAccountId: page.id })).toEqual([]);
  });

  it("a mapping-collapse baseline still counts as non-empty for the vanished guard", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-collapse2-of", "acct_collapse2");
    const renamed = (id: number) => ({
      ...trackingItem(), id, clicksCount: undefined, clicks: 82,
    });
    const inventory = {
      trackingByAccount: new Map([["acct_collapse2", [renamed(1), renamed(2), renamed(3)]]]),
      trialByAccount: new Map([["acct_collapse2", [trialItem()]]]),
    };
    appContext = { ...appContext, ofapi: linksClient(inventory) };
    // Collapse run: rawItems=3, writtenRows=0 — links exist, we failed to map.
    await runOfapiLinkStatsReconcile(appContext);

    // The vendor then "shows" zero items (same rename normalizing to empty):
    // the baseline SAW links, so this must be vanished-partial, not complete.
    inventory.trackingByAccount.set("acct_collapse2", []);
    const second = await runOfapiLinkStatsReconcile(appContext);
    expect(second.pages[0]?.kinds).toEqual([
      expect.objectContaining({
        linkKind: "tracking",
        status: "partial",
        reason: "inventory_vanished",
      }),
      expect.objectContaining({ linkKind: "trial", status: "written" }),
    ]);
    const trackingRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    });
    expect(trackingRuns.map((run) => run.status)).toEqual(["partial", "partial"]);
  });

  it("cold stored cache: the first-ever empty walk is partial, the second proves emptiness", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-cold-of", "acct_cold");
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([["acct_cold", []]]),
        trialByAccount: new Map([["acct_cold", [trialItem()]]]),
      }),
    };

    const first = await runOfapiLinkStatsReconcile(appContext);
    expect(first.pages[0]?.kinds).toEqual([
      expect.objectContaining({
        linkKind: "tracking",
        status: "partial",
        reason: "empty_unverified",
      }),
      expect.objectContaining({ linkKind: "trial", status: "written" }),
    ]);

    const second = await runOfapiLinkStatsReconcile(appContext);
    expect(second.pages[0]?.kinds[0]).toMatchObject({
      linkKind: "tracking",
      status: "written",
    });
    const trackingRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    });
    expect(trackingRuns.map((run) => run.status)).toEqual(["complete", "partial"]);
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
    const listStoredTrackingLinks = vi.fn(async (): Promise<OfapiListPage> => ({
      items: [],
      hasNextPage: false,
      nextMarker: null,
      nextPageUrl: null,
      meta: null,
    }));
    const listStoredTrialLinks = vi.fn(async (): Promise<OfapiListPage> => ({
      items: [],
      hasNextPage: false,
      nextMarker: null,
      nextPageUrl: null,
      meta: null,
    }));
    appContext = {
      ...appContext,
      ofapi: { listStoredTrackingLinks, listStoredTrialLinks } as unknown as OfapiClient,
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages).toEqual([]);
    expect(listStoredTrackingLinks).not.toHaveBeenCalled();
    expect(listStoredTrialLinks).not.toHaveBeenCalled();
    expect(await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
    })).toEqual([]);
  });
});
