import { readdirSync, readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertLinkStatRun,
  insertLinkStatRunWithSnapshots,
  listLinkStatRuns,
  listLinkStatSnapshots,
  listLinkStatWindowPairStates,
  listNotificationIncidents,
  setPageOfapiAccountId,
  type InsertLinkStatSnapshotInput,
  type LinkStatKind,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  runOfapiLinkStatsReconcile,
  startOfapiLinkStatsWorker,
} from "../apps/runtime/src/services/ofapi-link-stats-sync.ts";
import {
  nextOfapiLinkStatsWindowAt,
  ofapiLinkStatsWindowAt,
} from "../apps/runtime/src/services/ofapi-link-stats-windows.ts";
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

async function seedUnmappedPage(label: string) {
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
  return page;
}

async function seedOfapiPage(label: string, ofapiAccountId: string) {
  const page = await seedUnmappedPage(label);
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId });
  return page;
}

/** The page is now bound to another OFAPI account, as after a verified
 * rebind. Written directly: the reconcile reads pages.ofapi_account_id only,
 * and the initial-mapping writer refuses a replacement by design. */
async function rebindPage(pageId: number, ofapiAccountId: string) {
  await testDb!.pool.query(
    `update pages set ofapi_account_id = $2, ofapi_binding_generation = ofapi_binding_generation + 1
      where id = $1`,
    [pageId, ofapiAccountId],
  );
}

function snapshot(pageId: number, linkKind: LinkStatKind, platformLinkId: string): InsertLinkStatSnapshotInput {
  return {
    platformAccountId: pageId,
    linkKind,
    platformLinkId,
    name: null,
    url: null,
    linkCreatedAt: null,
    linkEndsAt: null,
    isFinished: null,
    clicksCount: 1,
    claimsCount: linkKind === "trial" ? 1 : null,
    subscribersCount: 0,
    spendersCount: null,
    revenueGrossMills: null,
    revenueIsLoading: null,
    revenueCalculatedAt: null,
  };
}

/** Rows of the series per (page, kind), oldest first. */
async function seriesOf(pageId: number, linkKind: LinkStatKind) {
  const runs = await listLinkStatRuns(appContext.db, { platformAccountId: pageId, linkKind });
  return runs.reverse();
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
      reason: null,
      attempt: 1,
      ofapiAccountId: "acct_links",
    });
    expect(trialRun).toMatchObject({
      platformAccountId: page.id,
      status: "complete",
      rawItems: 1,
      writtenRows: 1,
      reason: null,
      attempt: 1,
      ofapiAccountId: "acct_links",
    });
    // Both rows of one pass name the same scheduled window: the latest one
    // that had opened when the pass read the cache.
    expect(trackingRun?.windowAt).toBeInstanceOf(Date);
    expect(trackingRun?.windowAt?.getTime()).toBe(trialRun?.windowAt?.getTime());
    expect(trackingRun!.windowAt!.getTime()).toBeLessThanOrEqual(trackingRun!.pulledAt.getTime());
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

    // Stage-7 journaling is load-bearing: one raw-payload row per fetched API
    // page, record-shaped (the sync-pull canonicalizer gates on isRecord).
    const journal = await testDb!.pool.query(
      `select endpoint, payload_kind, response_payload
       from sync_raw_payloads where page_id = $1 order by endpoint`,
      [page.id],
    );
    expect(journal.rows).toHaveLength(2);
    expect(journal.rows.map((row) => row.endpoint)).toEqual([
      "link_stats_tracking",
      "link_stats_trial",
    ]);
    expect(journal.rows.every((row) =>
      row.payload_kind === "mapping_critical" &&
      typeof row.response_payload === "object" &&
      !Array.isArray(row.response_payload) &&
      Array.isArray(row.response_payload.items) &&
      typeof row.response_payload.hasNextPage === "boolean",
    )).toBe(true);
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

    // The failure is a row of the series too: `failed`, the error as the
    // reason, no snapshots.
    const trialRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "trial",
    });
    expect(trialRuns).toHaveLength(1);
    expect(trialRuns[0]).toMatchObject({
      status: "failed",
      reason: "trial endpoint down",
      apiPages: 0,
      rawItems: 0,
      writtenRows: 0,
      attempt: 1,
      ofapiAccountId: "acct_fail",
    });
    expect(await listLinkStatSnapshots(appContext.db, { runId: trialRuns[0]!.id })).toEqual([]);

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
        linkKind: "tracking", status: "partial", reason: "items_skipped", rawItems: 2, writtenRows: 1,
      }),
      expect.objectContaining({
        linkKind: "trial", status: "partial", reason: "items_skipped", rawItems: 2, writtenRows: 1,
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
    expect(trackingRun).toMatchObject({
      status: "partial", reason: "multi_page", apiPages: 2, writtenRows: 2,
    });
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
    expect(trialRuns[0]).toMatchObject({ status: "complete", writtenRows: 1, reason: null });
    expect(await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    })).toEqual([
      expect.objectContaining({ status: "failed", reason: "tracking endpoint down", writtenRows: 0 }),
    ]);
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
    expect(trackingRuns[0]).toMatchObject({
      status: "partial", reason: "all_items_skipped", rawItems: 3, writtenRows: 0,
    });
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

  it("budget exhaustion truncates quietly: run rows land, but money blocks never page (ofapi_low_credit owns that)", async (context) => {
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
    expect(runs.map((run) => run.reason)).toEqual([
      "ofapi_daily_credit_budget",
      "ofapi_daily_credit_budget",
    ]);
    // ...and NO incident: a money-guard block is a symptom of the account's
    // credit state, which ofapi_low_credit already pages — this lane logs a
    // warn (chargebacks precedent). Non-monetary truncation still pages (see
    // the pagination-contradiction policy).
    expect(await listNotificationIncidents(appContext.db)).toEqual([]);
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
      // Trial has NEVER shown a non-empty inventory — its emptiness stays
      // unverifiable ('partial'), never an absence proof.
      expect.objectContaining({
        linkKind: "trial",
        status: "partial",
        reason: "empty_unverified",
      }),
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
      expect.objectContaining({ linkKind: "trial", status: "partial" }),
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
      expect.objectContaining({ linkKind: "trial", status: "partial" }),
    ]);
    const trackingRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    });
    expect(trackingRuns.map((run) => run.status)).toEqual(["partial", "partial"]);
  });

  it("makes no request for an auth-dead page (Stage-26 pause) and says so in the series", async (context) => {
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
    expect(result.pages).toEqual([
      expect.objectContaining({ pageLabel: page.label, status: "skipped", reason: "page_auth_dead" }),
    ]);
    expect(listStoredTrackingLinks).not.toHaveBeenCalled();
    expect(listStoredTrialLinks).not.toHaveBeenCalled();
    const runs = await listLinkStatRuns(appContext.db, { platformAccountId: page.id });
    expect(runs.map((run) => run.linkKind).sort()).toEqual(["tracking", "trial"]);
    expect(runs.every((run) =>
      run.status === "skipped" && run.reason === "page_auth_dead" &&
      run.ofapiAccountId === "acct_authdead" && run.attempt === 1 && run.windowAt !== null,
    )).toBe(true);
    // The dead session has its own ofapi_auth incident; the series pass opens
    // none of its own for a page it was never going to read.
    expect(await listNotificationIncidents(appContext.db)).toEqual([]);
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

  it("never-nonempty pages cannot mint absence proofs; the full wipe lifecycle converges", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-cold-of", "acct_cold");
    const inventory = {
      trackingByAccount: new Map([["acct_cold", [] as Record<string, unknown>[]]]),
      trialByAccount: new Map([["acct_cold", [trialItem()]]]),
    };
    appContext = { ...appContext, ofapi: linksClient(inventory) };

    // Cold cache: empty walks on a page that never showed links stay
    // 'partial' (empty_unverified) FOREVER — no absence proof from nothing.
    await runOfapiLinkStatsReconcile(appContext);
    const second = await runOfapiLinkStatsReconcile(appContext);
    expect(second.pages[0]?.kinds[0]).toMatchObject({
      linkKind: "tracking",
      status: "partial",
      reason: "empty_unverified",
    });

    // Inventory appears: a genuine complete run.
    inventory.trackingByAccount.set("acct_cold", [trackingItem()]);
    await runOfapiLinkStatsReconcile(appContext);
    // Then a wipe: the first empty walk is suspicious (vanished)...
    inventory.trackingByAccount.set("acct_cold", []);
    const wipe = await runOfapiLinkStatsReconcile(appContext);
    expect(wipe.pages[0]?.kinds[0]).toMatchObject({
      linkKind: "tracking",
      status: "partial",
      reason: "inventory_vanished",
    });
    // ...and the second empty walk proves it (two-step convergence).
    const confirmed = await runOfapiLinkStatsReconcile(appContext);
    expect(confirmed.pages[0]?.kinds[0]).toMatchObject({
      linkKind: "tracking",
      status: "written",
    });
    const trackingRuns = await listLinkStatRuns(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
    });
    expect(trackingRuns.map((run) => run.status)).toEqual([
      "complete", "partial", "complete", "partial", "partial",
    ]);
  });

  it("a failing snapshot insert rolls the run row back — no orphaned absence evidence", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-atomic-of", "acct_atomic");
    const row = (platformLinkId: string): InsertLinkStatSnapshotInput => ({
      platformAccountId: page.id,
      linkKind: "tracking",
      platformLinkId,
      name: null,
      url: null,
      linkCreatedAt: null,
      linkEndsAt: null,
      isFinished: null,
      clicksCount: 1,
      claimsCount: null,
      subscribersCount: 0,
      spendersCount: null,
      revenueGrossMills: null,
      revenueIsLoading: null,
      revenueCalculatedAt: null,
    });

    // Duplicate platform_link_id violates the (run_id, platform_link_id)
    // unique inside the transaction — the run row must not survive either.
    await expect(insertLinkStatRunWithSnapshots(
      appContext.db,
      {
        platformAccountId: page.id,
        linkKind: "tracking",
        status: "complete",
        pulledAt: new Date(),
        apiPages: 1,
        rawItems: 2,
        writtenRows: 2,
      },
      [row("77"), row("77")],
    )).rejects.toThrow();
    expect(await listLinkStatRuns(appContext.db, { platformAccountId: page.id })).toEqual([]);
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

describe("OFAPI link-stats series: every attempt is a row", () => {
  it("leaves exactly one row per page and kind whatever happened to the page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const healthy = await seedOfapiPage("row-healthy-of", "acct_row_healthy");
    const failing = await seedOfapiPage("row-failing-of", "acct_row_failing");
    const authDead = await seedOfapiPage("row-authdead-of", "acct_row_authdead");
    const unmapped = await seedUnmappedPage("row-unmapped-of");
    const truncating = await seedOfapiPage("row-truncating-of", "acct_row_truncating");
    await testDb.pool.query(
      `update pages set ofapi_auth_status = 'authentication_failed' where id = $1`,
      [authDead.id],
    );
    const page = (items: Record<string, unknown>[], hasNextPage = false): OfapiListPage => ({
      items, hasNextPage, nextMarker: null, nextPageUrl: null, meta: null,
    });
    const calls: string[] = [];
    appContext = {
      ...appContext,
      ofapi: {
        async listStoredTrackingLinks(_context: unknown, accountId: string) {
          calls.push(`tracking:${accountId}`);
          // An empty page that still claims continuation: the walk is stopped.
          return accountId === "acct_row_truncating" ? page([], true) : page([trackingItem()]);
        },
        async listStoredTrialLinks(_context: unknown, accountId: string) {
          calls.push(`trial:${accountId}`);
          if (accountId === "acct_row_failing") {
            throw new Error("trial endpoint down");
          }
          return page([trialItem()]);
        },
      } as unknown as OfapiClient,
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(Object.fromEntries(result.pages.map((entry) => [entry.pageLabel, entry.status]))).toEqual({
      [healthy.label]: "written",
      [failing.label]: "failed",
      [authDead.label]: "skipped",
      [unmapped.label]: "skipped",
      [truncating.label]: "partial",
    });
    // No request for the pages the pass could not read.
    expect(calls.some((call) => call.endsWith("acct_row_authdead"))).toBe(false);

    const rows = await testDb.pool.query<{
      platform_account_id: string; link_kind: string; status: string; reason: string | null;
      attempt: number; ofapi_account_id: string | null; window_at: Date | null; written_rows: number;
    }>(
      `select platform_account_id::text, link_kind, status, reason, attempt, ofapi_account_id, window_at, written_rows
         from page_link_stat_runs order by platform_account_id, link_kind`,
    );
    expect(rows.rows.map((row) => [Number(row.platform_account_id), row.link_kind, row.status, row.reason, row.ofapi_account_id])).toEqual([
      [healthy.id, "tracking", "complete", null, "acct_row_healthy"],
      [healthy.id, "trial", "complete", null, "acct_row_healthy"],
      [failing.id, "tracking", "complete", null, "acct_row_failing"],
      [failing.id, "trial", "failed", "trial endpoint down", "acct_row_failing"],
      [authDead.id, "tracking", "skipped", "page_auth_dead", "acct_row_authdead"],
      [authDead.id, "trial", "skipped", "page_auth_dead", "acct_row_authdead"],
      [unmapped.id, "tracking", "skipped", "page_unmapped", null],
      [unmapped.id, "trial", "skipped", "page_unmapped", null],
      [truncating.id, "tracking", "truncated", "pagination_contradiction", "acct_row_truncating"],
      [truncating.id, "trial", "complete", null, "acct_row_truncating"],
    ]);
    // One pass, one window, first attempt everywhere.
    expect(new Set(rows.rows.map((row) => row.window_at?.toISOString())).size).toBe(1);
    expect(rows.rows[0]!.window_at).toBeInstanceOf(Date);
    expect(rows.rows.every((row) => row.attempt === 1)).toBe(true);
    // Only finished walks carry snapshots.
    const snapshots = await testDb.pool.query<{ status: string; n: string }>(
      `select r.status, count(s.id)::text as n
         from page_link_stat_runs r left join page_link_stat_snapshots s on s.run_id = r.id
        group by r.status order by r.status`,
    );
    expect(Object.fromEntries(snapshots.rows.map((row) => [row.status, Number(row.n)]))).toEqual({
      complete: 4, failed: 0, skipped: 0, truncated: 0,
    });
  });

  it("a page the pass cannot read does not hold the fleet incident open", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await seedOfapiPage("latch-healthy-of", "acct_latch");
    const unmapped = await seedUnmappedPage("latch-unmapped-of");
    const clientInput = {
      trackingByAccount: new Map([["acct_latch", [trackingItem()]]]),
      trialByAccount: new Map([["acct_latch", [trialItem()]]]),
      failTrialFor: "acct_latch" as string | undefined,
    };
    appContext = { ...appContext, ofapi: linksClient(clientInput) };

    await runOfapiLinkStatsReconcile(appContext);
    expect((await listNotificationIncidents(appContext.db)).map((incident) => incident.status)).toEqual(["open"]);

    // The mapped page recovers; the unmapped one is still skipped. Before
    // every attempt became a row it was not part of the pass at all, so it
    // must not keep the latch open now.
    clientInput.failTrialFor = undefined;
    const recovered = await runOfapiLinkStatsReconcile(appContext);
    expect(recovered.pages.find((entry) => entry.pageLabel === unmapped.label)).toMatchObject({
      status: "skipped", reason: "page_unmapped",
    });
    expect((await listNotificationIncidents(appContext.db)).map((incident) => incident.status)).toEqual(["resolved"]);
  });

  it("skips a page remapped under the pass and names the account it has now", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const first = await seedOfapiPage("remap-first-of", "acct_remap_first");
    const second = await seedOfapiPage("remap-second-of", "acct_remap_old");
    expect(first.id).toBeLessThan(second.id);
    const page = (items: Record<string, unknown>[]): OfapiListPage => ({
      items, hasNextPage: false, nextMarker: null, nextPageUrl: null, meta: null,
    });
    const listStoredTrialLinks = vi.fn(async () => page([trialItem()]));
    appContext = {
      ...appContext,
      ofapi: {
        async listStoredTrackingLinks(_context: unknown, accountId: string) {
          // The fleet was listed already; the second page is rebound while
          // the first one walks.
          if (accountId === "acct_remap_first") {
            await rebindPage(second.id, "acct_remap_new");
          }
          return page([trackingItem()]);
        },
        listStoredTrialLinks,
      } as unknown as OfapiClient,
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages.find((entry) => entry.pageLabel === second.label)).toMatchObject({
      status: "skipped", reason: "ofapi_mapping_changed",
    });
    expect(listStoredTrialLinks).toHaveBeenCalledTimes(1);
    for (const kind of ["tracking", "trial"] as const) {
      expect(await seriesOf(second.id, kind)).toEqual([
        expect.objectContaining({
          status: "skipped", reason: "ofapi_mapping_changed", ofapiAccountId: "acct_remap_new", attempt: 1,
        }),
      ]);
    }
  });

  it("writes skipped rows when no OFAPI client is configured", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("noclient-of", "acct_noclient");
    appContext = { ...appContext, ofapi: {} as unknown as OfapiClient };

    await runOfapiLinkStatsReconcile(appContext);
    for (const kind of ["tracking", "trial"] as const) {
      expect(await seriesOf(page.id, kind)).toEqual([
        expect.objectContaining({
          status: "skipped", reason: "ofapi_client_not_configured", ofapiAccountId: "acct_noclient",
        }),
      ]);
    }
  });

  it("a pass that throws outside a walk leaves a failed row for every kind it had not recorded", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("pagefail-of", "acct_pagefail");
    appContext = {
      ...appContext,
      ofapi: {
        get listStoredTrackingLinks(): never {
          throw new Error("client exploded");
        },
      } as unknown as OfapiClient,
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages).toEqual([
      expect.objectContaining({ pageLabel: page.label, status: "failed", reason: "client exploded" }),
    ]);
    for (const kind of ["tracking", "trial"] as const) {
      expect(await seriesOf(page.id, kind)).toEqual([
        expect.objectContaining({
          status: "failed", reason: "client exploded", ofapiAccountId: "acct_pagefail", attempt: 1,
        }),
      ]);
    }
  });

  it("a failed walk keeps how far it got", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("progress-of", "acct_progress");
    const listStoredTrackingLinks = vi.fn(async (
      _context: unknown,
      _accountId: string,
      params: { offset?: number },
    ): Promise<OfapiListPage> => {
      if ((params.offset ?? 0) > 0) {
        throw new Error("second page timed out");
      }
      return {
        items: [trackingItem()], hasNextPage: true, nextMarker: null, nextPageUrl: null, meta: null,
      };
    });
    const listStoredTrialLinks = vi.fn(async (): Promise<OfapiListPage> => ({
      items: [trialItem()], hasNextPage: false, nextMarker: null, nextPageUrl: null, meta: null,
    }));
    appContext = {
      ...appContext,
      ofapi: { listStoredTrackingLinks, listStoredTrialLinks } as unknown as OfapiClient,
    };

    await runOfapiLinkStatsReconcile(appContext);
    const [failed] = await seriesOf(page.id, "tracking");
    expect(failed).toMatchObject({
      status: "failed", reason: "second page timed out", apiPages: 1, rawItems: 1, writtenRows: 0,
    });
    expect(await listLinkStatSnapshots(appContext.db, { runId: failed!.id })).toEqual([]);
  });

  it("a failed row keeps the error without its secrets or a query's bound values", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("sanitized-of", "acct_sanitized");
    const queryError = Object.assign(
      new Error("Failed query: insert into page_link_stat_snapshots values ($1)\nparams: fan-secret-payload"),
      { code: "23505" },
    );
    appContext = {
      ...appContext,
      ofapi: {
        async listStoredTrackingLinks() {
          throw new Error("GET https://user:hunter2@proxy.example:8080/x failed with Bearer abcdef0123456789");
        },
        async listStoredTrialLinks() {
          throw queryError;
        },
      } as unknown as OfapiClient,
    };

    await runOfapiLinkStatsReconcile(appContext);
    const [tracking] = await seriesOf(page.id, "tracking");
    const [trial] = await seriesOf(page.id, "trial");
    expect(tracking).toMatchObject({ status: "failed" });
    expect(tracking!.reason).not.toContain("hunter2");
    expect(tracking!.reason).not.toContain("abcdef0123456789");
    expect(tracking!.reason).toContain("proxy.example");
    expect(trial).toMatchObject({ status: "failed", reason: "database query failed (23505)" });
  });

  it("numbers the attempts of a window and starts again in the next one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("attempts-of", "acct_attempts");
    const clientInput = {
      trackingByAccount: new Map([["acct_attempts", [trackingItem()]]]),
      trialByAccount: new Map([["acct_attempts", [trialItem()]]]),
      failTrialFor: "acct_attempts" as string | undefined,
    };
    appContext = { ...appContext, ofapi: linksClient(clientInput) };
    const windowAt = ofapiLinkStatsWindowAt(new Date("2026-10-08T12:00:00Z"));
    const nextWindowAt = nextOfapiLinkStatsWindowAt(windowAt);
    const minutes = (base: Date, count: number) => new Date(base.getTime() + count * 60_000);

    await runOfapiLinkStatsReconcile(appContext, { now: minutes(windowAt, 1) });
    clientInput.failTrialFor = undefined;
    await runOfapiLinkStatsReconcile(appContext, { now: minutes(windowAt, 16) });
    await runOfapiLinkStatsReconcile(appContext, { now: minutes(nextWindowAt, 1) });

    expect((await seriesOf(page.id, "trial")).map((run) => [
      run.windowAt?.toISOString(), run.attempt, run.status,
    ])).toEqual([
      [windowAt.toISOString(), 1, "failed"],
      [windowAt.toISOString(), 2, "complete"],
      [nextWindowAt.toISOString(), 1, "complete"],
    ]);
    expect((await seriesOf(page.id, "tracking")).map((run) => [
      run.windowAt?.toISOString(), run.attempt, run.pulledAt.toISOString(),
    ])).toEqual([
      [windowAt.toISOString(), 1, minutes(windowAt, 1).toISOString()],
      [windowAt.toISOString(), 2, minutes(windowAt, 16).toISOString()],
      [nextWindowAt.toISOString(), 1, minutes(nextWindowAt, 1).toISOString()],
    ]);
  });
});

describe("OFAPI link-stats series: the empty-cache guard is per OFAPI account", () => {
  it("an empty read under a new account never becomes complete; the first non-empty one is binding_changed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("rebind-of", "acct_before");
    const inventory = {
      trackingByAccount: new Map<string, Record<string, unknown>[]>([["acct_before", [trackingItem()]]]),
      trialByAccount: new Map<string, Record<string, unknown>[]>([["acct_before", [trialItem()]]]),
    };
    appContext = { ...appContext, ofapi: linksClient(inventory) };
    await runOfapiLinkStatsReconcile(appContext);

    // The page is rebound; the new account's cache is cold. Judged per page,
    // the second empty read saw an empty baseline and became `complete` — to
    // a reader, every link deleted. Per account it never does.
    await rebindPage(page.id, "acct_after");
    for (let pass = 0; pass < 3; pass += 1) {
      const cold = await runOfapiLinkStatsReconcile(appContext);
      expect(cold.pages[0]?.kinds).toEqual([
        expect.objectContaining({ linkKind: "tracking", status: "partial", reason: "empty_unverified" }),
        expect.objectContaining({ linkKind: "trial", status: "partial", reason: "empty_unverified" }),
      ]);
    }
    expect((await seriesOf(page.id, "tracking")).map((run) => [run.status, run.reason, run.ofapiAccountId])).toEqual([
      ["complete", null, "acct_before"],
      ["partial", "empty_unverified", "acct_after"],
      ["partial", "empty_unverified", "acct_after"],
      ["partial", "empty_unverified", "acct_after"],
    ]);

    // The cache warms up: the first non-empty read under the new account is
    // not an absence proof and says the account changed...
    inventory.trackingByAccount.set("acct_after", [trackingItem()]);
    inventory.trialByAccount.set("acct_after", [trialItem()]);
    const warm = await runOfapiLinkStatsReconcile(appContext);
    expect(warm.pages[0]).toMatchObject({ status: "partial", reason: "binding_changed" });
    const [changed] = (await seriesOf(page.id, "tracking")).slice(-1);
    expect(changed).toMatchObject({
      status: "partial", reason: "binding_changed", ofapiAccountId: "acct_after", rawItems: 1, writtenRows: 1,
    });
    expect(await listLinkStatSnapshots(appContext.db, { runId: changed!.id })).toHaveLength(1);

    // ...and from the next read the account has its own baseline.
    const settled = await runOfapiLinkStatsReconcile(appContext);
    expect(settled.pages[0]).toMatchObject({ status: "written" });

    // A wipe under the new account converges exactly as before: suspicious
    // first, proven by the second empty read.
    inventory.trackingByAccount.set("acct_after", []);
    await runOfapiLinkStatsReconcile(appContext);
    await runOfapiLinkStatsReconcile(appContext);
    expect((await seriesOf(page.id, "tracking")).slice(-3).map((run) => [run.status, run.reason])).toEqual([
      ["complete", null],
      ["partial", "inventory_vanished"],
      ["complete", null],
    ]);
  });

  it("a page's first inventory is not a binding change, even after cold reads", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("first-inventory-of", "acct_first");
    const inventory = {
      trackingByAccount: new Map<string, Record<string, unknown>[]>([["acct_first", []]]),
      trialByAccount: new Map<string, Record<string, unknown>[]>([["acct_first", [trialItem()]]]),
    };
    appContext = { ...appContext, ofapi: linksClient(inventory) };
    await runOfapiLinkStatsReconcile(appContext);
    inventory.trackingByAccount.set("acct_first", [trackingItem()]);
    await runOfapiLinkStatsReconcile(appContext);

    expect((await seriesOf(page.id, "tracking")).map((run) => [run.status, run.reason])).toEqual([
      ["partial", "empty_unverified"],
      ["complete", null],
    ]);
  });

  it("rows whose account is unknown never vouch for an account", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // What an image older than migration 0252 writes: a finished non-empty
    // walk with no account on it.
    const page = await seedOfapiPage("legacy-rows-of", "acct_legacy");
    await insertLinkStatRunWithSnapshots(appContext.db, {
      platformAccountId: page.id,
      linkKind: "tracking",
      status: "complete",
      pulledAt: new Date("2026-10-01T04:45:00Z"),
      apiPages: 1,
      rawItems: 1,
      writtenRows: 1,
    }, [snapshot(page.id, "tracking", "2117449")]);
    const inventory = {
      trackingByAccount: new Map<string, Record<string, unknown>[]>([["acct_legacy", []]]),
      trialByAccount: new Map<string, Record<string, unknown>[]>([["acct_legacy", [trialItem()]]]),
    };
    appContext = { ...appContext, ofapi: linksClient(inventory) };

    // Empty under the account: nothing was ever seen UNDER IT, so no proof.
    await runOfapiLinkStatsReconcile(appContext);
    await runOfapiLinkStatsReconcile(appContext);
    // Non-empty under the account for the first time, links known before
    // under an unknown account: treated as a binding change.
    inventory.trackingByAccount.set("acct_legacy", [trackingItem()]);
    await runOfapiLinkStatsReconcile(appContext);

    expect((await seriesOf(page.id, "tracking")).slice(1).map((run) => [run.status, run.reason])).toEqual([
      ["partial", "empty_unverified"],
      ["partial", "empty_unverified"],
      ["partial", "binding_changed"],
    ]);
  });
});

describe("OFAPI link-stats series: a window's usable result", () => {
  const WINDOW = new Date("2026-10-08T04:45:00Z");
  const EARLIER = new Date("2026-10-07T16:45:00Z");

  async function attempt(
    pageId: number,
    linkKind: LinkStatKind,
    status: "complete" | "partial" | "truncated" | "failed" | "skipped",
    shape: { rawItems?: number; links?: string[]; reason?: string | null; windowAt?: Date } = {},
  ) {
    const links = shape.links ?? [];
    const windowAt = shape.windowAt ?? WINDOW;
    const run = {
      platformAccountId: pageId,
      linkKind,
      status,
      pulledAt: new Date(windowAt.getTime() + 20_000),
      apiPages: status === "skipped" ? 0 : 1,
      rawItems: shape.rawItems ?? links.length,
      writtenRows: links.length,
      reason: shape.reason ?? null,
      windowAt,
      ofapiAccountId: "acct_usable",
    };
    if (status === "complete" || status === "partial") {
      await insertLinkStatRunWithSnapshots(
        appContext.db, run, links.map((link) => snapshot(pageId, linkKind, link)),
      );
    } else {
      await insertLinkStatRun(appContext.db, run);
    }
  }

  it("one kind keeps failing while the other works: the failing one has no usable result, however many rows it has", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("usable-mixed-of", "acct_usable");
    // The same window, three passes: tracking lands every time, trial fails,
    // is skipped and is truncated.
    await attempt(page.id, "tracking", "complete", { links: ["1"] });
    await attempt(page.id, "trial", "failed", { reason: "trial endpoint down" });
    await attempt(page.id, "tracking", "complete", { links: ["1"] });
    await attempt(page.id, "trial", "skipped", { reason: "window_missed" });
    await attempt(page.id, "tracking", "complete", { links: ["1"] });
    await attempt(page.id, "trial", "truncated", { reason: "pagination_contradiction" });

    expect(await listLinkStatWindowPairStates(appContext.db, { windowAt: WINDOW })).toEqual([
      {
        platformAccountId: page.id, linkKind: "tracking", attempts: 3, hasUsableResult: true,
        lastStatus: "complete", lastReason: null,
      },
      {
        platformAccountId: page.id, linkKind: "trial", attempts: 3, hasUsableResult: false,
        lastStatus: "truncated", lastReason: "pagination_contradiction",
      },
    ]);
    // Another window knows nothing of these rows.
    expect(await listLinkStatWindowPairStates(appContext.db, { windowAt: EARLIER })).toEqual([]);
  });

  it("an empty partial is a result only for a pair that has never shown a link", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const never = await seedOfapiPage("usable-never-of", "acct_usable_never");
    const had = await seedOfapiPage("usable-had-of", "acct_usable_had");
    // `never` × trial has no links at all — its steady state is an unverified
    // empty read. `had` × trial showed a link in an earlier window, so an
    // empty read now is a cold cache or an unconfirmed wipe: no result yet.
    await attempt(had.id, "trial", "complete", { links: ["7"], windowAt: EARLIER });
    await attempt(never.id, "trial", "partial", { reason: "empty_unverified" });
    await attempt(had.id, "trial", "partial", { reason: "inventory_vanished" });

    const usable = async () => Object.fromEntries(
      (await listLinkStatWindowPairStates(appContext.db, { windowAt: WINDOW }))
        .map((state) => [`${state.platformAccountId}:${state.linkKind}`, state.hasUsableResult]),
    );
    expect(await usable()).toEqual({
      [`${never.id}:trial`]: true,
      [`${had.id}:trial`]: false,
    });

    // The confirming empty read is a `complete`: the emptiness is the result.
    await attempt(had.id, "trial", "complete");
    expect(await usable()).toEqual({
      [`${never.id}:trial`]: true,
      [`${had.id}:trial`]: true,
    });
  });

  it("after a rebind a cold cache's empty reads are no result, while a kind that never had a link stays a result across the rebind", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // tracking has links under the first account; trial never had one under
    // any account (lora-of's trial links on production).
    const page = await seedOfapiPage("usable-rebind-of", "acct_usable_before");
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([["acct_usable_before", [trackingItem()]]]),
        trialByAccount: new Map([["acct_usable_before", []]]),
      }),
    };
    const first = ofapiLinkStatsWindowAt(new Date("2026-10-08T12:00:00Z"));
    const second = nextOfapiLinkStatsWindowAt(first);
    const third = nextOfapiLinkStatsWindowAt(second);
    const usableIn = async (windowAt: Date) => Object.fromEntries(
      (await listLinkStatWindowPairStates(appContext.db, { windowAt }))
        .map((state) => [state.linkKind, [state.hasUsableResult, state.lastReason]]),
    );

    await runOfapiLinkStatsReconcile(appContext, { now: new Date(first.getTime() + 60_000) });
    expect(await usableIn(first)).toEqual({
      tracking: [true, null],
      trial: [true, "empty_unverified"],
    });

    // Rebound; the new account's stored cache is cold for both kinds.
    await rebindPage(page.id, "acct_usable_after");
    for (const windowAt of [second, third]) {
      await runOfapiLinkStatsReconcile(appContext, { now: new Date(windowAt.getTime() + 60_000) });
      expect(await usableIn(windowAt)).toEqual({
        // Had links under the old account: an empty read under the new one
        // is no result — it is retried and, if it persists, signalled.
        tracking: [false, "empty_unverified"],
        // Never had one under any account: nothing to lose, still a result.
        trial: [true, "empty_unverified"],
      });
    }
    expect((await seriesOf(page.id, "tracking")).map((run) => [run.status, run.ofapiAccountId])).toEqual([
      ["complete", "acct_usable_before"],
      ["partial", "acct_usable_after"],
      ["partial", "acct_usable_after"],
    ]);
  });

  it("a partial that wrote nothing is not a result; one that wrote snapshots is", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("usable-collapse-of", "acct_usable_collapse");
    await attempt(page.id, "tracking", "partial", { rawItems: 3, reason: "all_items_skipped" });
    await attempt(page.id, "trial", "partial", { rawItems: 3, links: ["1", "2"], reason: "items_skipped" });

    expect((await listLinkStatWindowPairStates(appContext.db, { windowAt: WINDOW }))
      .map((state) => [state.linkKind, state.hasUsableResult])).toEqual([
      ["tracking", false],
      ["trial", true],
    ]);
  });
});

describe("the migration that makes every attempt a row (page_link_stat_runs_attempts)", () => {
  // Found by its name, not its number: the number is the next free one at merge.
  const found = readdirSync("packages/db/migrations")
    .filter((file) => file.endsWith("_page_link_stat_runs_attempts.sql"));
  const migrationSql = found.length === 1
    ? readFileSync(`packages/db/migrations/${found[0]}`, "utf8")
    : "";

  async function rerunMigration() {
    const client = await testDb!.pool.connect();
    try {
      await client.query("begin");
      await client.query(migrationSql);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async function legacyRun(pageId: number, pulledAt: string) {
    // The previous image's insert, column for column.
    const inserted = await testDb!.pool.query<{ id: string }>(
      `insert into page_link_stat_runs
         (platform_account_id, link_kind, status, pulled_at, api_pages, raw_items, written_rows)
       values ($1, 'tracking', 'complete', $2, 1, 1, 1)
       returning id::text as id`,
      [pageId, pulledAt],
    );
    return Number(inserted.rows[0]!.id);
  }

  async function binding(pageId: number, accountId: string, validFrom: string | null, validTo: string | null) {
    await testDb!.pool.query(
      `insert into ofapi_account_bindings (account_id, page_id, generation, valid_from, valid_to, evidence)
       values ($1, $2, 1, $3, $4, '{"source":"test"}'::jsonb)
       on conflict (account_id) do update set valid_from = excluded.valid_from, valid_to = excluded.valid_to`,
      [accountId, pageId, validFrom, validTo],
    );
  }

  it("names the account on existing rows from the custody history, and only where it is unambiguous", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    expect(found).toHaveLength(1);

    // Production's shape: two closed intervals, then the current account
    // whose start is unknown (the 0150 seed), plus an attached historical
    // account with no boundaries at all.
    const seeded = await seedUnmappedPage("backfill-seeded-of");
    await testDb.pool.query(`update pages set ofapi_account_id = 'acct_now' where id = $1`, [seeded.id]);
    await binding(seeded.id, "acct_first", "2026-07-05T01:55:00Z", "2026-07-21T20:22:00Z");
    await binding(seeded.id, "acct_second", "2026-07-21T22:20:00Z", "2026-09-03T20:22:00Z");
    await binding(seeded.id, "acct_now", null, null);
    await binding(seeded.id, "acct_historical", null, null);
    // A page whose current binding has a known start.
    const dated = await seedUnmappedPage("backfill-dated-of");
    await testDb.pool.query(`update pages set ofapi_account_id = 'acct_dated' where id = $1`, [dated.id]);
    await binding(dated.id, "acct_dated", "2026-08-01T00:00:00Z", null);
    // A page whose history overlaps itself: no single answer.
    const overlapping = await seedUnmappedPage("backfill-overlap-of");
    await binding(overlapping.id, "acct_overlap_a", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
    await binding(overlapping.id, "acct_overlap_b", "2026-08-15T00:00:00Z", "2026-09-15T00:00:00Z");

    const rows = {
      beforeAnyBinding: await legacyRun(seeded.id, "2026-07-01T04:45:00Z"),
      underFirst: await legacyRun(seeded.id, "2026-07-10T04:45:00Z"),
      betweenAccounts: await legacyRun(seeded.id, "2026-07-21T21:00:00Z"),
      underSecond: await legacyRun(seeded.id, "2026-09-03T16:45:00Z"),
      afterLastClosed: await legacyRun(seeded.id, "2026-09-05T16:45:00Z"),
      latest: await legacyRun(seeded.id, "2026-10-08T16:45:00Z"),
      datedBefore: await legacyRun(dated.id, "2026-07-31T16:45:00Z"),
      datedAfter: await legacyRun(dated.id, "2026-08-01T04:45:00Z"),
      overlapOne: await legacyRun(overlapping.id, "2026-08-10T04:45:00Z"),
      overlapBoth: await legacyRun(overlapping.id, "2026-08-20T04:45:00Z"),
    };

    await rerunMigration();

    const accounts = await testDb.pool.query<{ id: string; ofapi_account_id: string | null; attempt: number }>(
      `select id::text, ofapi_account_id, attempt from page_link_stat_runs`,
    );
    const accountOf = new Map(accounts.rows.map((row) => [Number(row.id), row.ofapi_account_id]));
    expect(Object.fromEntries(Object.entries(rows).map(([name, id]) => [name, accountOf.get(id)]))).toEqual({
      beforeAnyBinding: null,
      underFirst: "acct_first",
      betweenAccounts: null,
      underSecond: "acct_second",
      afterLastClosed: "acct_now",
      latest: "acct_now",
      datedBefore: null,
      datedAfter: "acct_dated",
      overlapOne: "acct_overlap_a",
      overlapBoth: null,
    });
    // The previous image's rows take the column default.
    expect(accounts.rows.every((row) => row.attempt === 1)).toBe(true);

    // A second run changes nothing: it only fills rows that are still null.
    await testDb.pool.query(`update pages set ofapi_account_id = 'acct_later' where id = $1`, [seeded.id]);
    await rerunMigration();
    const again = await testDb.pool.query<{ ofapi_account_id: string | null }>(
      `select ofapi_account_id from page_link_stat_runs where id = $1`,
      [rows.latest],
    );
    expect(again.rows[0]!.ofapi_account_id).toBe("acct_now");
  });

  it("admits the two new statuses and still refuses an unknown one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedUnmappedPage("statuses-of");
    const insert = (status: string) => testDb!.pool.query(
      `insert into page_link_stat_runs (platform_account_id, link_kind, status, pulled_at)
       values ($1, 'trial', $2, now())`,
      [page.id, status],
    );
    for (const status of ["complete", "partial", "truncated", "failed", "skipped"]) {
      await insert(status);
    }
    await expect(insert("window_missed")).rejects.toThrow(/page_link_stat_runs_status_check/);
  });
});
