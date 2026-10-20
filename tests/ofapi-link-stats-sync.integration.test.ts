import { createServer, type Server } from "node:http";

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
  OFAPI_LINK_STATS_RECONCILE_QUEUE,
  OFAPI_LINK_STATS_RETRY_QUEUE,
  runOfapiLinkStatsReconcile,
  startOfapiLinkStatsWorker,
  type OfapiLinkStatsTargetedJob,
} from "../apps/runtime/src/services/ofapi-link-stats-sync.ts";
import {
  nextOfapiLinkStatsWindowAt,
  ofapiLinkStatsWindowAt,
} from "../apps/runtime/src/services/ofapi-link-stats-windows.ts";
import { createOfapiCreditSpendSink } from "../apps/runtime/src/services/ofapi-credits.ts";
import {
  createOfapiClient,
  type OfapiClient,
  type OfapiListPage,
} from "../apps/runtime/src/services/ofapi.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { listenOnLoopback } from "./helpers/network.ts";
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

/** Today's OFAPI day counters; 0 where nothing was ever written. */
async function dayCounters() {
  const result = await testDb!.pool.query<{ link_stats: number; backfill: number; global: number }>(
    `select coalesce(max(link_stats_spent_credits), 0)::int as link_stats,
            coalesce(max(backfill_spent_credits), 0)::int as backfill,
            coalesce(max(spent_credits), 0)::int as global
       from ofapi_credit_state where id = 1`,
  );
  return result.rows[0]!;
}

interface SentJob {
  queue: string;
  data: OfapiLinkStatsTargetedJob;
  options: { startAfter: number; singletonKey: string; retryLimit: number };
}

/** The slice of pg-boss the link-stats lane uses: `send` is recorded, `work`
 * keeps the handler of each queue. */
function fakeBoss() {
  const sent: SentJob[] = [];
  const handlers = new Map<string, (jobs: Array<{ data: unknown }>) => Promise<void>>();
  return {
    sent,
    handlers,
    async send(queue: string, data: OfapiLinkStatsTargetedJob, options: SentJob["options"]) {
      sent.push({ queue, data, options });
      return "job-id";
    },
    async work(
      queue: string,
      _options: { batchSize: number },
      handler: (jobs: Array<{ data: unknown }>) => Promise<void>,
    ) {
      handlers.set(queue, handler);
      return null;
    },
  };
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
      chargebacks: 0,
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
    tags: ["reddit"],
    revenue: {
      total: 144.8,
      revenuePerSubscriber: 0.4482972136222911,
      spendersCount: 7,
      calculatedAt: "2026-07-21T21:05:40.000000Z",
      isLoading: false,
      chargebacks: 12.5,
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
      revenueNetMills: 0n,
      revenueGrossMills: 0n,
      revenueChargebacksMills: 0n,
      revenueIsLoading: false,
      // A tracking link grants no free period; an empty list is "no tags".
      trialDays: null,
      tags: [],
    });
    expect(trialSnapshot).toMatchObject({
      runId: trialRun.id,
      platformAccountId: page.id,
      platformLinkId: "11365057",
      clicksCount: 611,
      subscribersCount: 0,
      claimsCount: 323,
      spendersCount: 7,
      // revenue.total is already the creator's net: stored as is, under its
      // true name and, with the same value, under the deprecated one.
      revenueNetMills: 144800n,
      revenueGrossMills: 144800n,
      // Already excluded from the total by the vendor — kept, not subtracted.
      revenueChargebacksMills: 12500n,
      trialDays: 360,
      tags: ["reddit"],
    });
    expect(trialSnapshot?.revenueCalculatedAt).toBeInstanceOf(Date);

    // The stored reads are free and the lane reserves nothing for them: two
    // requests that the vendor did not charge leave every day counter alone.
    expect(await dayCounters()).toEqual({ link_stats: 0, backfill: 0, global: 0 });

    // Stage-7 journaling is load-bearing: one raw-payload row per fetched API
    // page, record-shaped (the sync-pull canonicalizer gates on isRecord).
    const journal = await testDb!.pool.query(
      `select endpoint, payload_kind, mapper_version, response_payload
       from sync_raw_payloads where page_id = $1 order by endpoint`,
      [page.id],
    );
    expect(journal.rows).toHaveLength(2);
    expect(journal.rows.map((row) => row.mapper_version)).toEqual(["link-stats-v2", "link-stats-v2"]);
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
      revenueNetMills: snapshot?.revenueNetMills,
      revenueGrossMills: snapshot?.revenueGrossMills,
    }))).toEqual([
      {
        platformAccountId: page.id,
        linkKind: "tracking",
        platformLinkId: "2117449",
        clicksCount: 82,
        subscribersCount: 19,
        claimsCount: null,
        revenueNetMills: 0n,
        revenueGrossMills: 0n,
      },
      {
        platformAccountId: page.id,
        linkKind: "tracking",
        platformLinkId: "2117449",
        clicksCount: 82,
        subscribersCount: 19,
        claimsCount: null,
        revenueNetMills: 0n,
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
    const boss = fakeBoss();
    await startOfapiLinkStatsWorker(appContext, boss);
    expect([...boss.handlers.keys()]).toEqual([
      OFAPI_LINK_STATS_RECONCILE_QUEUE,
      OFAPI_LINK_STATS_RETRY_QUEUE,
    ]);
    await expect(boss.handlers.get(OFAPI_LINK_STATS_RECONCILE_QUEUE)!([])).rejects.toThrow(
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
        chargebacks: 0,
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
      revenueNetMills: null,
      revenueGrossMills: null,
      // The placeholder chargebacks of a block still computing are unknown too.
      revenueChargebacksMills: null,
      revenueIsLoading: true,
    });
    // Missing revenue block entirely: unknown, not zero.
    expect(absentSnapshot).toMatchObject({
      platformLinkId: "222",
      spendersCount: null,
      revenueNetMills: null,
      revenueGrossMills: null,
      revenueChargebacksMills: null,
      revenueIsLoading: null,
      // Not money: the trial length does not depend on the revenue block.
      trialDays: 360,
    });
  });

  it("keeps chargebacks, the trial length and tags; one the vendor did not send or sent malformed stays null and drops no link", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-fields-of", "acct_fields");
    const full = {
      ...trialItem(),
      id: 301,
      subscribeDays: 7,
      tags: ["Instagram", "Twitter"],
      revenue: { ...(trialItem().revenue as Record<string, unknown>), total: 26.8, chargebacks: 6.4 },
    };
    const bare: Record<string, unknown> = { ...trialItem(), id: 302 };
    delete bare.subscribeDays;
    delete bare.tags;
    const bareRevenue = { ...(trialItem().revenue as Record<string, unknown>) };
    delete bareRevenue.chargebacks;
    bare.revenue = bareRevenue;
    const malformed = {
      ...trialItem(),
      id: 303,
      subscribeDays: "30",
      tags: ["ok", 5],
      revenue: { ...(trialItem().revenue as Record<string, unknown>), chargebacks: "n/a" },
    };
    // A tracking link has no free period, whatever the item says; tags that
    // are not a list are unknown, not "none".
    const tracking = { ...trackingItem(), subscribeDays: 30, tags: "Instagram" };
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([["acct_fields", [tracking]]]),
        trialByAccount: new Map([["acct_fields", [full, bare, malformed]]]),
      }),
    };

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages[0]).toMatchObject({ status: "written" });

    const runs = await listLinkStatRuns(appContext.db, { platformAccountId: page.id });
    const trackingRun = runs.find((run) => run.linkKind === "tracking")!;
    const trialRun = runs.find((run) => run.linkKind === "trial")!;
    // Descriptive fields never demote the walk or drop a link.
    expect(trialRun).toMatchObject({ status: "complete", rawItems: 3, writtenRows: 3, reason: null });
    expect(trackingRun).toMatchObject({ status: "complete", writtenRows: 1 });

    const pick = (snapshot: Awaited<ReturnType<typeof listLinkStatSnapshots>>[number] | undefined) => ({
      platformLinkId: snapshot?.platformLinkId,
      revenueNetMills: snapshot?.revenueNetMills,
      revenueGrossMills: snapshot?.revenueGrossMills,
      revenueChargebacksMills: snapshot?.revenueChargebacksMills,
      trialDays: snapshot?.trialDays,
      tags: snapshot?.tags,
    });
    expect((await listLinkStatSnapshots(appContext.db, { runId: trialRun.id })).map(pick)).toEqual([
      {
        platformLinkId: "301",
        revenueNetMills: 26800n,
        revenueGrossMills: 26800n,
        revenueChargebacksMills: 6400n,
        trialDays: 7,
        tags: ["Instagram", "Twitter"],
      },
      {
        platformLinkId: "302",
        revenueNetMills: 144800n,
        revenueGrossMills: 144800n,
        revenueChargebacksMills: null,
        trialDays: null,
        tags: null,
      },
      {
        platformLinkId: "303",
        revenueNetMills: 144800n,
        revenueGrossMills: 144800n,
        revenueChargebacksMills: null,
        trialDays: null,
        tags: null,
      },
    ]);
    expect((await listLinkStatSnapshots(appContext.db, { runId: trackingRun.id })).map(pick)).toEqual([
      {
        platformLinkId: "2117449",
        revenueNetMills: 0n,
        revenueGrossMills: 0n,
        revenueChargebacksMills: 0n,
        trialDays: null,
        tags: null,
      },
    ]);
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
    // 20 bind params per row × 3277 rows would exceed the 65535 protocol cap
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
      revenueNetMills: null,
      revenueChargebacksMills: null,
      revenueIsLoading: null,
      revenueCalculatedAt: null,
      trialDays: null,
      tags: null,
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

  it("the lane's quota stops it once the vendor has really charged that much, and that is an incident", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("links-budget-of", "acct_budget");
    const listStoredTrackingLinks = vi.fn();
    const listStoredTrialLinks = vi.fn();
    appContext = {
      ...appContext,
      ofapi: { listStoredTrackingLinks, listStoredTrialLinks } as unknown as OfapiClient,
    };
    // The DEDICATED link_stats day counter already holds the 50-credit
    // default. Nothing is reserved on it any more, so it got there by real
    // charges: stored reads stopped being free.
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
    // ...and the incident opens: no other signal says that the premise the
    // lane runs on (stored reads cost nothing) no longer holds.
    const incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "ofapi_link_stats_reconcile_failed",
      status: "open",
    });
    expect(incidents[0]!.errorSummary).toBe(
      "fleet fully truncated (1 page(s)): no snapshots written — the vendor charged the lane's "
        + "whole daily quota for stored reads (they are meant to be free)",
    );
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
      revenueNetMills: null,
      revenueChargebacksMills: null,
      revenueIsLoading: null,
      revenueCalculatedAt: null,
      trialDays: null,
      tags: null,
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

describe("OFAPI link-stats series: free reads stand outside the money guards", () => {
  const page = (items: Record<string, unknown>[], creditsUsed: number | null = null): OfapiListPage => ({
    items,
    hasNextPage: false,
    nextMarker: null,
    nextPageUrl: null,
    meta: creditsUsed === null
      ? null
      : { creditsUsed, creditBalance: null, isCached: null, rateRemainingMinute: null },
  });

  it("reads with the shared day cap exhausted and with the balance under the credit floor", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, {
      ofapiLinkStatsReconcileEnabled: true,
      ofapiCreditLedgerEnabled: true,
      ofapiMirrorGlobalDailyCreditBudget: 10,
      ofapiCreditFloor: 500,
    });
    const seeded = await seedOfapiPage("free-caps-of", "acct_free_caps");
    appContext = {
      ...appContext,
      ofapi: linksClient({
        trackingByAccount: new Map([["acct_free_caps", [trackingItem()]]]),
        trialByAccount: new Map([["acct_free_caps", [trialItem()]]]),
      }),
    };
    // The whole account's day cap is spent — by the paid lanes — and the
    // balance, observed a moment ago, is far under the floor.
    await testDb.pool.query(
      `insert into ofapi_credit_state (id, spend_day, spent_credits, last_balance, last_balance_at)
       values (1, (now() at time zone 'utc')::date, 10, 37, now())
       on conflict (id) do update
         set spend_day = excluded.spend_day,
             spent_credits = excluded.spent_credits,
             last_balance = excluded.last_balance,
             last_balance_at = excluded.last_balance_at`,
    );

    const result = await runOfapiLinkStatsReconcile(appContext);
    expect(result.pages).toEqual([expect.objectContaining({ pageLabel: seeded.label, status: "written" })]);
    expect((await listLinkStatRuns(appContext.db, { platformAccountId: seeded.id }))
      .map((run) => run.status)).toEqual(["complete", "complete"]);
    // Nothing was reserved on either counter.
    expect(await dayCounters()).toEqual({ link_stats: 0, backfill: 0, global: 10 });
  });

  it("a whole day of failing attempts does not spend the lane's own quota", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // A quota far below the day's attempts: four windows, each with the
    // scheduled pass and three retries, both kinds failing every time.
    appContext = createTestAppContext(testDb, {
      ofapiLinkStatsReconcileEnabled: true,
      ofapiCreditLedgerEnabled: true,
      ofapiLinkStatsDailyCreditBudget: 5,
    });
    const seeded = await seedOfapiPage("free-failures-of", "acct_free_failures");
    const clientInput = {
      trackingByAccount: new Map([["acct_free_failures", [trackingItem()]]]),
      trialByAccount: new Map([["acct_free_failures", [trialItem()]]]),
      failTrackingFor: "acct_free_failures" as string | undefined,
      failTrialFor: "acct_free_failures" as string | undefined,
    };
    appContext = { ...appContext, ofapi: linksClient(clientInput) };

    let windowAt = ofapiLinkStatsWindowAt(new Date("2026-10-08T00:00:00Z"));
    for (let window = 0; window < 4; window += 1) {
      windowAt = nextOfapiLinkStatsWindowAt(windowAt);
      await runOfapiLinkStatsReconcile(appContext, { now: new Date(windowAt.getTime() + 30_000) });
      for (const [index, minutes] of [15, 60, 180].entries()) {
        await runOfapiLinkStatsReconcile(appContext, {
          now: new Date(windowAt.getTime() + minutes * 60_000 + 30_000),
          target: { trigger: "retry", windowAt, retry: index + 1 },
        });
      }
    }
    const failedRows = await listLinkStatRuns(appContext.db, { platformAccountId: seeded.id });
    expect(failedRows).toHaveLength(4 * 4 * 2);
    expect(failedRows.every((run) => run.status === "failed")).toBe(true);
    expect(await dayCounters()).toEqual({ link_stats: 0, backfill: 0, global: 0 });

    // The endpoints come back: the very next pass reads — the 32 failures
    // left nothing on the lane's counter to block it.
    clientInput.failTrackingFor = undefined;
    clientInput.failTrialFor = undefined;
    const healthy = await runOfapiLinkStatsReconcile(appContext, {
      now: new Date(nextOfapiLinkStatsWindowAt(windowAt).getTime() + 30_000),
    });
    expect(healthy.pages).toEqual([expect.objectContaining({ pageLabel: seeded.label, status: "written" })]);
  });

  it("through the real client and credit sink, an answer that states no charge costs nothing; a stated charge is booked and stops the lane", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, {
      ofapiLinkStatsReconcileEnabled: true,
      ofapiCreditLedgerEnabled: true,
      ofapiLinkStatsDailyCreditBudget: 2,
    });
    const seeded = await seedOfapiPage("free-real-client-of", "acct_free_real");
    // What the vendor answers, per request: a list without any `_meta`, a
    // body that is not JSON, or a list whose `_meta` states a charge.
    let mode: "unstated" | "not_json" | "charged" = "unstated";
    let requests = 0;
    const server: Server = createServer((request, response) => {
      requests += 1;
      const tracking = (request.url ?? "").includes("/stored/tracking-links");
      response.writeHead(200, { "content-type": "application/json" });
      if (mode === "not_json") {
        response.end("<html>upstream hiccup</html>");
        return;
      }
      response.end(JSON.stringify({
        data: { list: [tracking ? trackingItem() : trialItem()], hasMore: false },
        ...(mode === "charged" ? { _meta: { _credits: { used: 1, balance: 900 } } } : {}),
      }));
    });
    const address = await listenOnLoopback(server, "OFAPI stored link lists");
    if (!address) {
      server.close();
      context.skip();
      return;
    }
    try {
      appContext = {
        ...appContext,
        ofapi: createOfapiClient({
          baseUrl: `http://${address.host}:${address.port}`,
          apiKey: "test-key",
          restDelayMs: 0,
          onCreditSpend: createOfapiCreditSpendSink(appContext),
        }),
      };
      const ledger = async () => (await testDb!.pool.query<{ operation: string; credits: number; estimated: boolean }>(
        `select operation, credits, estimated from ofapi_credit_ledger order by id`,
      )).rows;

      // Five passes of unstated answers and one of non-JSON bodies, against
      // a quota of 2: at the ordinary 1-credit estimate the lane would have
      // stopped after the first pass.
      for (let pass = 0; pass < 5; pass += 1) {
        const result = await runOfapiLinkStatsReconcile(appContext);
        expect(result.pages[0]).toMatchObject({ pageLabel: seeded.label, status: "written" });
      }
      mode = "not_json";
      const garbled = await runOfapiLinkStatsReconcile(appContext);
      expect(garbled.pages[0]).toMatchObject({ status: "failed" });
      expect(requests).toBe(12);
      expect(await dayCounters()).toEqual({ link_stats: 0, backfill: 0, global: 0 });
      const booked = await ledger();
      expect(booked).toHaveLength(12);
      // Booked, at zero: an estimate of a free read, not a charge.
      expect(booked.every((row) => row.credits === 0 && row.estimated)).toBe(true);
      expect(new Set(booked.map((row) => row.operation))).toEqual(
        new Set(["ofapi_stored_tracking_links", "ofapi_stored_trial_links"]),
      );

      // The vendor starts charging and says so: 1 + 1 credits reach the
      // quota of 2, and the next pass stops before its first request.
      mode = "charged";
      const charged = await runOfapiLinkStatsReconcile(appContext);
      expect(charged.pages[0]).toMatchObject({ status: "written" });
      expect(await dayCounters()).toEqual({ link_stats: 2, backfill: 0, global: 2 });
      expect((await ledger()).slice(-2)).toEqual([
        { operation: "ofapi_stored_tracking_links", credits: 1, estimated: false },
        { operation: "ofapi_stored_trial_links", credits: 1, estimated: false },
      ]);
      const stopped = await runOfapiLinkStatsReconcile(appContext);
      expect(stopped.pages[0]).toMatchObject({ status: "truncated", reason: "ofapi_daily_credit_budget" });
      expect(requests).toBe(14);
    } finally {
      server.close();
    }
  });

  it("a charge the vendor reports is counted, and the lane stops at its quota", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, {
      ofapiLinkStatsReconcileEnabled: true,
      ofapiCreditLedgerEnabled: true,
      ofapiLinkStatsDailyCreditBudget: 5,
    });
    const seeded = await seedOfapiPage("free-charged-of", "acct_free_charged");
    const listStoredTrackingLinks = vi.fn(async () => page([trackingItem()], 3));
    const listStoredTrialLinks = vi.fn(async () => page([trialItem()], 3));
    appContext = {
      ...appContext,
      ofapi: { listStoredTrackingLinks, listStoredTrialLinks } as unknown as OfapiClient,
    };

    // 3 credits per read, quota 5: the first read passes (0 spent), so does
    // the second (3 spent) — a request is never refused on an estimate.
    const first = await runOfapiLinkStatsReconcile(appContext);
    expect(first.pages[0]).toMatchObject({ status: "written" });
    expect(await dayCounters()).toEqual({ link_stats: 6, backfill: 0, global: 6 });

    // 6 charged: stored reads are not free any more, and the lane stops.
    const second = await runOfapiLinkStatsReconcile(appContext);
    expect(second.pages[0]).toMatchObject({ status: "truncated", reason: "ofapi_daily_credit_budget" });
    expect(listStoredTrackingLinks).toHaveBeenCalledTimes(1);
    expect(listStoredTrialLinks).toHaveBeenCalledTimes(1);
    expect((await listLinkStatRuns(appContext.db, { platformAccountId: seeded.id }))
      .map((run) => [run.status, run.reason])).toEqual([
      ["truncated", "ofapi_daily_credit_budget"],
      ["truncated", "ofapi_daily_credit_budget"],
      ["complete", null],
      ["complete", null],
    ]);
    expect(await dayCounters()).toEqual({ link_stats: 6, backfill: 0, global: 6 });
  });
});
