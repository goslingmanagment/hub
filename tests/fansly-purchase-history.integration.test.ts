// Stage 16 media-scoped purchase-history regression coverage. Fansly requires
// accountMediaId/accountMediaBundleId; accountIds is only an optional buyer
// filter. Captured DM pages are the durable discovery source.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  findPageById,
  finishSyncRun,
  getCheckpoint,
  insertRawPayload,
  startSyncRun,
  upsertCheckpointProgress,
  upsertTransaction,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { FanslyPurchaseHistoryContractError } from "../apps/runtime/src/services/sync/errors.ts";
import { executePurchaseHistoryChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { fanslyLaneTelemetryStub as fakeTelemetry } from "./helpers/fansly-lane-harness.ts";
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
  appContext = createTestAppContext(testDb, { fanslyPurchaseHistorySyncEnabled: true });
});

async function seedPage() {
  const model = await createModel(appContext.db, { slug: "ph-model", name: "PH" });
  if (!model) {
    throw new Error("failed to create test model");
  }
  const page = await createFanslyPage(appContext.db, { modelId: model.id, label: "ph-fansly" });
  if (!page) {
    throw new Error("failed to create test page");
  }
  await ensurePageSyncStates(appContext.db, { pageId: page.id });
  return page;
}

async function captureDmPage(pageId: number, responsePayload: unknown) {
  await insertRawPayload(appContext.db, {
    platformAccountId: pageId,
    endpoint: "dm_messages",
    requestParams: { groupId: "group-1" },
    responsePayload,
    mapperVersion: "test",
    payloadKind: "dm_messages",
    retainUntil: new Date("2126-01-01T00:00:00Z"),
  });
}

async function capturePurchaseHistoryTarget(
  pageId: number,
  input: {
    requestParams: Record<string, unknown>;
    responsePayload: unknown;
    statusCode?: number;
    errorMessage?: string;
  },
) {
  await insertRawPayload(appContext.db, {
    platformAccountId: pageId,
    endpoint: "purchase_history",
    requestParams: input.requestParams,
    responsePayload: input.responsePayload,
    mapperVersion: "test",
    payloadKind: "mapping_critical",
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    retainUntil: new Date("2126-01-01T00:00:00Z"),
  });
}

// Fansly's answer for a media the account no longer holds (production ari-1,
// 2026-09-02 and again 2026-09-15, byte-identical).
const FANSLY_MEDIA_422_BODY =
  '{"success":false,"error":{"code":99,"details":"error getting account media"}}';

type OrderHistoryAnswer = { items: unknown[]; raw: unknown } | Error;

/** An adapter stub that reports each attempt to the lane's observer the way
 *  the real adapter does, so `callsToday` and the chunk budget move. */
function orderHistoryAdapter(
  requested: string[],
  answer: (contentId: string, params: Record<string, unknown>) => OrderHistoryAnswer,
) {
  return {
    async getMediaOrderHistoryPage(
      context: { requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null },
      params: Record<string, unknown>,
    ) {
      const contentId = String(params.accountMediaId ?? params.accountMediaBundleId);
      requested.push(contentId);
      await context.requestObserver?.onRequestEvent({
        requestId: `${contentId}-${requested.length}`,
        state: "started",
        operation: "media_orderhistory",
        endpointTemplate: "/media/orderhistory",
        method: "GET",
        attemptNumber: 1,
      });
      const result = answer(contentId, params);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  } as never;
}

const rejected422 = () =>
  new FanslyApiError("Fansly request failed (422)", 422, 99, FANSLY_MEDIA_422_BODY);
const emptyPage = () => ({ items: [], raw: { accountMediaOrderHistory: [] } });

/** A target this page walked to completion and the provider served. */
async function captureServedTarget(pageId: number, contentId: string) {
  await capturePurchaseHistoryTarget(pageId, {
    requestParams: { accountMediaId: contentId, before: null, limit: 100 },
    responsePayload: { accountMediaOrderHistory: [] },
  });
}

/** A target the provider rejected with the ari-1 shape. */
async function captureRejectedTarget(pageId: number, contentId: string) {
  await capturePurchaseHistoryTarget(pageId, {
    requestParams: { accountMediaId: contentId, before: null, limit: 100 },
    responsePayload: { error: { status: 422, code: 99, details: "error getting account media", body: FANSLY_MEDIA_422_BODY } },
    statusCode: 422,
    errorMessage: "Fansly request failed (422)",
  });
}

async function probeCaptureCount() {
  const probes = await testDb!.pool.query<{ n: string }>(
    "select count(*)::text as n from sync_raw_payloads where endpoint = 'purchase_history_contract_probe'",
  );
  return Number(probes.rows[0]!.n);
}

/** What the executor records on the run it blocked for a storm — the only
 *  evidence, beside the verdict, that an owner unblock can follow. */
async function recordStormBlock(runId: number) {
  await finishSyncRun(appContext.db, runId, {
    status: "failed",
    stats: {
      chunkStatus: "failed",
      error: {
        type: "FanslyPurchaseHistoryContractError",
        summary: "purchase_history_rejection_storm",
        endpoint: "purchase_history",
        code: "purchase_history_rejection_storm",
        truncated: false,
        originalMessageLength: 0,
        responseSnippet: null,
      },
    },
    errorSummary: "purchase_history_rejection_storm",
  });
}

/** A bundle target the provider rejected with the ari-1 shape. */
async function captureRejectedBundle(pageId: number, contentId: string) {
  await capturePurchaseHistoryTarget(pageId, {
    requestParams: { accountMediaBundleId: contentId, before: null, limit: 100 },
    responsePayload: { error: { status: 422, code: 99, details: "error getting account media", body: FANSLY_MEDIA_422_BODY } },
    statusCode: 422,
    errorMessage: "Fansly request failed (422)",
  });
}

async function stormVerdictCount() {
  const verdicts = await testDb!.pool.query<{ n: string }>(
    "select count(*)::text as n from sync_raw_payloads where endpoint = 'purchase_history_contract_storm'",
  );
  return Number(verdicts.rows[0]!.n);
}

/** A witness page the proof journaled earlier, rejected with the ari-1 shape. */
async function captureRejectedProbe(pageId: number, contentId: string) {
  await insertRawPayload(appContext.db, {
    platformAccountId: pageId,
    endpoint: "purchase_history_contract_probe",
    requestParams: { accountMediaId: contentId, before: null, limit: 100 },
    responsePayload: { error: { status: 422, code: 99, details: "error getting account media", body: FANSLY_MEDIA_422_BODY } },
    mapperVersion: "test",
    payloadKind: "mapping_critical",
    statusCode: 422,
    errorMessage: "Fansly request failed (422)",
    retainUntil: new Date("2126-01-01T00:00:00Z"),
  });
}

/** A DM page whose only PPV content is the given single media, in that order. */
function singlePpvDmPayload(contentIds: readonly string[]) {
  return {
    messages: [{
      id: "message-1",
      attachments: contentIds.map((contentId) => ({ contentType: 1, contentId })),
    }],
    accountMedia: contentIds.map((id) => ({
      id,
      permissions: { permissionFlags: [{ flags: 1 }] },
    })),
    accountMediaBundles: [],
    accountMediaOrders: [],
  };
}

function ppvDmPayload() {
  return {
    messages: [{
      id: "message-1",
      attachments: [
        { contentType: 1, contentId: "media-1" },
        { contentType: 2, contentId: "bundle-1" },
        { contentType: 1, contentId: "free-media" },
      ],
    }],
    accountMedia: [
      { id: "media-1", permissions: { permissionFlags: [{ flags: 1 }] } },
      { id: "free-media", permissions: { permissionFlags: [] } },
    ],
    accountMediaBundles: [
      { id: "bundle-1", permissions: { permissionFlags: [{ flags: 1 }] } },
    ],
    accountMediaOrders: [{
      accountId: "buyer-1",
      accountMediaId: "ordered-media",
      createdAt: 1_780_000_000,
    }],
  };
}

async function buildChunkInput(
  page: { id: number },
  telemetry: ReturnType<typeof fakeTelemetry>,
  maxRequests = 10,
) {
  const run = await startSyncRun(appContext.db, {
    platformAccountId: page.id,
    stream: "purchase_history",
    trigger: "manual",
  });
  if (!run) {
    throw new Error("failed to create test sync run");
  }
  const stored = await findPageById(appContext.db, page.id);
  if (!stored) {
    throw new Error(`page ${page.id} missing`);
  }
  return {
    pageContext: {
      page: stored.page,
      platform: "fansly" as const,
      session: null,
      proxy: null,
      egressKey: "direct",
    } as never,
    streamState: { stream: "purchase_history" } as never,
    syncRunId: run.id,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(maxRequests, 60_000),
  };
}

describe("Stage 16 media-scoped purchase-history walk", () => {
  it("discovers uncaptured media targets from message-purchase transactions", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const baseTransaction = {
      platformAccountId: page.id,
      source: "fansly:rest" as const,
      transactionState: "posted" as const,
      rawStatus: "1",
      grossAmountMills: 10_000n,
      sourceDestinationAmountMills: 10_000n,
      creatorNetAmountMills: 8_000n,
      occurredAt: new Date("2026-07-30T12:00:00.000Z"),
    };
    await upsertTransaction(appContext.db, {
      ...baseTransaction,
      transactionId: "tx-media",
      correlationId: "media-from-tx",
      rawType: "2110",
      canonicalType: "message_purchase",
    });
    await upsertTransaction(appContext.db, {
      ...baseTransaction,
      transactionId: "tx-bundle",
      correlationId: "bundle-from-tx",
      rawType: "2116",
      canonicalType: "message_purchase",
    });
    await upsertTransaction(appContext.db, {
      ...baseTransaction,
      transactionId: "tx-tip",
      correlationId: "not-media",
      rawType: "7001",
      canonicalType: "tip",
    });

    const requested: Array<Record<string, unknown>> = [];
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage(_requestContext: unknown, params: Record<string, unknown>) {
          requested.push(params);
          return { items: [], raw: { accountMediaOrderHistory: [] } };
        },
      } as never,
    };

    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );

    expect(requested).toEqual([
      { accountMediaId: "media-from-tx", before: null, limit: 100 },
      { accountMediaBundleId: "bundle-from-tx", before: null, limit: 100 },
    ]);
    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        transactionRowsScanned: 2,
        transactionTargetsDiscovered: 2,
        targetsFetched: 2,
        walkCompleted: true,
      },
    });
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      version: 5,
      transactionCursorId: expect.any(Number),
      pendingTargets: [],
    });

    requested.length = 0;
    const second = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(second.satisfied).toBe(true);
    expect(requested).toEqual([]);
  });

  it("fails before egress when a transaction conflicts with a captured target kind", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await capturePurchaseHistoryTarget(page.id, {
      requestParams: { accountMediaId: "ambiguous-content" },
      responsePayload: { accountMediaOrderHistory: [] },
    });
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      transactionId: "tx-conflicting-bundle",
      source: "fansly:rest",
      transactionState: "posted",
      rawStatus: "1",
      rawType: "2116",
      canonicalType: "message_purchase",
      correlationId: "ambiguous-content",
      grossAmountMills: 10_000n,
      sourceDestinationAmountMills: 10_000n,
      creatorNetAmountMills: 8_000n,
      occurredAt: new Date("2026-07-30T12:00:00.000Z"),
    });
    const request = vi.fn();
    appContext = {
      ...appContext,
      adapter: {
        getMediaOrderHistoryPage: request,
      } as never,
    };

    await expect(executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    )).rejects.toMatchObject({
      code: "purchase_history_target_kind_conflict",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("fails before egress when raw-DM discovery conflicts with a captured target kind", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await capturePurchaseHistoryTarget(page.id, {
      requestParams: { accountMediaId: "raw-ambiguous-content" },
      responsePayload: { accountMediaOrderHistory: [] },
    });
    await captureDmPage(page.id, {
      messages: [{
        id: "message-conflict",
        attachments: [{ contentType: 2, contentId: "raw-ambiguous-content" }],
      }],
      accountMediaBundles: [{
        id: "raw-ambiguous-content",
        permissions: { permissionFlags: [{ flags: 1 }] },
      }],
    });
    const request = vi.fn();
    appContext = {
      ...appContext,
      adapter: {
        getMediaOrderHistoryPage: request,
      } as never,
    };

    await expect(executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    )).rejects.toMatchObject({
      code: "purchase_history_target_kind_conflict",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("discovers PPV media from captured DMs and never sends accountIds", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, ppvDmPayload());

    const requested: Array<Record<string, unknown>> = [];
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage(_requestContext: unknown, params: Record<string, unknown>) {
          requested.push(params);
          return { items: [], raw: { accountMediaOrderHistory: [] } };
        },
      } as never,
    };

    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );

    expect(requested).toEqual([
      { accountMediaBundleId: "bundle-1", before: null, limit: 100 },
      { accountMediaId: "media-1", before: null, limit: 100 },
      { accountMediaId: "ordered-media", before: null, limit: 100 },
    ]);
    expect(requested.every((params) => !("accountIds" in params))).toBe(true);
    expect(result).toMatchObject({
      satisfied: true,
      stats: { targetsFetched: 3, orderRowsCaptured: 0, walkCompleted: true },
    });

    const captures = await testDb.pool.query<{ request_params: Record<string, unknown> }>(
      "select request_params from sync_raw_payloads where endpoint = 'purchase_history' order by id",
    );
    expect(captures.rows.map((row) => row.request_params)).toEqual(requested);

    // The raw-row high-water and target captures make the steady-state pass
    // local and idempotent: no second vendor call for the same media.
    requested.length = 0;
    const second = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );
    expect(second.satisfied).toBe(true);
    expect(requested).toEqual([]);
  });

  it("captures and skips one deleted media target instead of wedging", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, ppvDmPayload());
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage(_context: unknown, params: Record<string, unknown>) {
          if (params.accountMediaBundleId === "bundle-1") {
            throw new FanslyApiError("media gone", 404);
          }
          return { items: [], raw: { accountMediaOrderHistory: [] } };
        },
      } as never,
    };

    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );

    expect(result).toMatchObject({
      satisfied: true,
      stats: { targetsFetched: 2, targetsSkipped: 1, walkCompleted: true },
    });
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "purchase_history_media_rejected",
    }));
    const rejected = await testDb.pool.query<{ status_code: number; error_message: string }>(
      "select status_code, error_message from sync_raw_payloads where endpoint = 'purchase_history' and status_code = 404",
    );
    expect(rejected.rows).toEqual([{ status_code: 404, error_message: "media gone" }]);
  });

  it("captures a 422 'error getting account media' verbatim and walks past it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Production ari-1, 2026-09-02: one media the account no longer holds
    // answered 422/code 99 and parked the whole stream for two weeks.
    const page = await seedPage();
    await captureDmPage(page.id, ppvDmPayload());
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (contentId) =>
        contentId === "media-1" ? rejected422() : emptyPage()),
    };

    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );

    expect(result).toMatchObject({
      satisfied: true,
      stats: { targetsFetched: 2, targetsSkipped: 1, walkCompleted: true },
    });
    expect(requested).toEqual(["bundle-1", "media-1", "ordered-media"]);
    expect(telemetry.anomalies).toContainEqual(expect.objectContaining({
      code: "purchase_history_media_rejected",
      details: expect.objectContaining({
        contentId: "media-1",
        retry: false,
        status: 422,
        fanslyCode: 99,
        fanslyDetails: "error getting account media",
        outcome: "terminal_rejected",
        rejectionStreak: 1,
      }),
    }));
    // Capture-first: the provider's answer, verbatim, on the target's own row.
    const rejected = await testDb.pool.query<{ status_code: number; payload: unknown }>(
      `select status_code, response_payload as payload
         from sync_raw_payloads
        where endpoint = 'purchase_history' and status_code = 422`,
    );
    expect(rejected.rows).toEqual([{
      status_code: 422,
      payload: {
        error: {
          status: 422,
          code: 99,
          details: "error getting account media",
          body: FANSLY_MEDIA_422_BODY,
        },
      },
    }]);
    // One rejection is no streak, and the served page after it ends it anyway.
    expect(await probeCaptureCount()).toBe(0);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({ pendingTargets: [] });
    expect(checkpoint?.state).not.toHaveProperty("rejectionStreak");

    // Consumed like a deleted media: never asked for again.
    requested.length = 0;
    const second = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(second.satisfied).toBe(true);
    expect(requested).toEqual([]);
  });

  it("proves a single-media rejection streak against a served witness and keeps walking", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // A target this page walked to completion earlier, and the provider
    // actually served — the witness.
    await captureServedTarget(page.id, "witness-1");
    await captureDmPage(page.id, singlePpvDmPayload(["media-a", "media-b", "media-c", "media-d"]));
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (contentId) =>
        ["media-a", "media-b", "media-c"].includes(contentId) ? rejected422() : emptyPage()),
    };

    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );

    // Three rejections on the provider's word, then — before a fourth target
    // is spent — page one of the witness; served, so the walk continues.
    expect(requested).toEqual(["media-a", "media-b", "media-c", "witness-1", "media-d"]);
    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        targetsFetched: 1,
        targetsSkipped: 3,
        walkCompleted: true,
        probeRequests: 1,
        probesServed: 1,
        retriesQueued: 0,
      },
    });
    expect(telemetry.anomalies).toContainEqual(expect.objectContaining({
      code: "purchase_history_rejection_streak_proven",
      details: expect.objectContaining({
        mediaKind: "single",
        witnessContentId: "witness-1",
        rejectionStreak: 3,
        statuses: [422],
        repaired: false,
        retriesQueued: 0,
      }),
    }));
    // The proof is captured, but never as a page of the witness's chain.
    expect(await probeCaptureCount()).toBe(1);
    const witnessPages = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n from sync_raw_payloads
        where endpoint = 'purchase_history' and request_params ->> 'accountMediaId' = 'witness-1'`,
    );
    expect(witnessPages.rows).toEqual([{ n: "1" }]);
    // And the served witness ends the streak durably: the next run derives
    // zero from the captures and asks for no proof.
    requested.length = 0;
    await captureDmPage(page.id, singlePpvDmPayload(["media-e"]));
    const second = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(requested).toEqual(["media-e"]);
    expect(second).toMatchObject({ stats: { probeRequests: 0, rejectionStreaks: { single: 0, bundle: 0 } } });
  });

  it("keeps request namespaces apart: single rejections never trigger a bundle proof", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // Transaction discovery preserves row order, so singles and bundles
    // interleave exactly as sales happened.
    const baseTransaction = {
      platformAccountId: page.id,
      source: "fansly:rest" as const,
      transactionState: "posted" as const,
      rawStatus: "1",
      grossAmountMills: 10_000n,
      sourceDestinationAmountMills: 10_000n,
      creatorNetAmountMills: 8_000n,
      canonicalType: "message_purchase" as const,
    };
    const sales: Array<[string, string]> = [
      ["media-a", "2110"],
      ["media-b", "2110"],
      ["media-c", "2110"],
      ["bundle-x", "2116"],
      ["media-d", "2110"],
    ];
    for (const [index, [contentId, rawType]] of sales.entries()) {
      await upsertTransaction(appContext.db, {
        ...baseTransaction,
        transactionId: `tx-${contentId}`,
        correlationId: contentId,
        rawType,
        occurredAt: new Date(Date.UTC(2026, 6, 30, 12, index)),
      });
    }
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (contentId) =>
        contentId.startsWith("media-") ? rejected422() : emptyPage()),
    };

    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );

    // The bundle namespace has no streak: bundle-x is requested on the
    // provider's word, and its served page proves nothing about singles. The
    // single namespace has a streak of three and no served single witness —
    // no evidence is no storm: the walk defers to the next UTC day instead of
    // blocking, and media-d is not spent.
    expect(requested).toEqual(["media-a", "media-b", "media-c", "bundle-x"]);
    expect(result).toMatchObject({
      satisfied: false,
      continuationRetryAt: expect.any(Date),
      stats: {
        deferred: "contract_unproven",
        probeRequests: 0,
        rejectionStreaks: { single: 3, bundle: 0 },
      },
    });
    expect(telemetry.anomalies).toContainEqual(expect.objectContaining({
      code: "purchase_history_contract_unproven",
      details: expect.objectContaining({ mediaKind: "single", reason: "no_witness", rejectionStreak: 3 }),
    }));
    expect(telemetry.anomalies).not.toContainEqual(expect.objectContaining({
      code: "purchase_history_rejection_streak_proven",
    }));
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      pendingTargets: [{ kind: "single", contentId: "media-d", before: null }],
    });
  });

  it("spends one target a UTC day as evidence when the page has no witness at all", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    for (const contentId of ["media-a", "media-b", "media-c"]) {
      await captureRejectedTarget(page.id, contentId);
    }
    // Yesterday's cursor: the streak was reached, the day's allowance spent.
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 5,
        transactionCursorId: 0,
        rawPayloadCursorId: 0,
        pendingTargets: [{ kind: "single", contentId: "media-d", before: null }],
        utcDay: "2020-01-01",
        callsToday: 3,
      },
    });
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, () => emptyPage()),
    };

    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );

    // A new UTC day: the first call may be a target, on no evidence — and a
    // served one ends the streak.
    expect(requested).toEqual(["media-d"]);
    expect(result).toMatchObject({
      satisfied: true,
      stats: { walkCompleted: true, targetsFetched: 1, rejectionStreaks: { single: 0, bundle: 0 } },
    });
    expect(telemetry.anomalies).toContainEqual(expect.objectContaining({
      code: "purchase_history_contract_unproven",
      message: expect.stringContaining("spending one target as evidence"),
      details: expect.objectContaining({ reason: "no_witness", rejectionStreak: 3 }),
    }));
  });

  it("does not count a witness the creator deleted as a storm vote", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureServedTarget(page.id, "witness-1");
    await captureServedTarget(page.id, "witness-2");
    await captureDmPage(page.id, singlePpvDmPayload(["media-a", "media-b", "media-c", "media-d"]));
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (contentId) =>
        contentId.startsWith("witness-")
          ? new FanslyApiError("media gone", 404)
          : contentId === "media-d"
            ? emptyPage()
            : rejected422()),
    };

    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );

    // 404 against a 422 streak: the provider tells entities apart, which is
    // evidence the contract works — no vote, next witness; with none left, the
    // walk defers rather than blocks.
    expect(requested).toEqual(["media-a", "media-b", "media-c", "witness-2", "witness-1"]);
    expect(result).toMatchObject({
      satisfied: false,
      stats: { deferred: "contract_unproven", probeRequests: 2, probesRejected: 2 },
    });
    expect(telemetry.anomalies).toContainEqual(expect.objectContaining({
      code: "purchase_history_contract_unproven",
      details: expect.objectContaining({ reason: "witnesses_discriminated" }),
    }));
    expect(await probeCaptureCount()).toBe(2);

    // Same day, next run: both witnesses were probed since the newest
    // rejection, so nothing is asked again — and no target is spent.
    requested.length = 0;
    const sameDay = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(requested).toEqual([]);
    expect(sameDay).toMatchObject({ stats: { deferred: "contract_unproven", probeRequests: 0 } });

    // Next UTC day: the first call of the day may be a target, on no evidence.
    const stored = await getCheckpoint(appContext.db, page.id, "purchase_history");
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: { ...stored!.state, utcDay: "2020-01-01" },
    });
    requested.length = 0;
    const nextDay = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(requested).toEqual(["media-d"]);
    expect(nextDay).toMatchObject({
      satisfied: true,
      stats: { walkCompleted: true, rejectionStreaks: { single: 0, bundle: 0 } },
    });
  });

  it("resumes a proof the chunk budget cut short instead of restarting it or spending a target", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    for (const witness of ["witness-1", "witness-2", "witness-3", "witness-4", "witness-5"]) {
      await captureServedTarget(page.id, witness);
    }
    await captureDmPage(page.id, singlePpvDmPayload(["media-a", "media-b", "media-c", "media-d", "media-e"]));
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, () => rejected422()),
    };

    // Production's chunk budget is five requests: three rejections leave room
    // for two witnesses, both voting.
    const first = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), 5),
    );
    expect(requested).toEqual(["media-a", "media-b", "media-c", "witness-5", "witness-4"]);
    expect(first).toMatchObject({
      satisfied: false,
      stats: { probeRequests: 2, probesRejected: 2, rejectionStreaks: { single: 3, bundle: 0 } },
    });
    expect(first).not.toHaveProperty("continuationRetryAt");

    // The next run picks the proof up where it stopped: the remaining three
    // witnesses, no target spent, and with every witness voted — a storm.
    requested.length = 0;
    const stormRun = await buildChunkInput(page, fakeTelemetry(), 5);
    await expect(
      executePurchaseHistoryChunk(appContext, stormRun),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    await recordStormBlock(stormRun.syncRunId);
    expect(requested).toEqual(["witness-3", "witness-2", "witness-1"]);
    expect(await probeCaptureCount()).toBe(5);

    // The unblock buys one target (media-d); its rejection restarts the proof
    // attempt for media-e, which again spans two runs — the witnesses are
    // asked again because the provider's state may have changed.
    requested.length = 0;
    const third = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), 5),
    );
    expect(requested).toEqual(["media-d", "witness-5", "witness-4", "witness-3", "witness-2"]);
    expect(third).toMatchObject({ satisfied: false, stats: { probeRequests: 4 } });
    requested.length = 0;
    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry(), 5)),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    expect(requested).toEqual(["witness-1"]);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      pendingTargets: [{ kind: "single", contentId: "media-e", before: null }],
    });
  });

  it("retries a member at the cursor it was rejected at, never from page one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureServedTarget(page.id, "witness-1");
    // media-t: page one served with one order, so the walk continues at its
    // orderId — and that continuation is what the provider will refuse.
    await capturePurchaseHistoryTarget(page.id, {
      requestParams: { accountMediaId: "media-t", before: null, limit: 100 },
      responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
    });
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 5,
        transactionCursorId: 0,
        rawPayloadCursorId: 0,
        pendingTargets: [
          { kind: "single", contentId: "media-a", before: null },
          { kind: "single", contentId: "media-b", before: null },
          { kind: "single", contentId: "media-t", before: "order-1" },
          { kind: "single", contentId: "media-d", before: null },
        ],
        utcDay: "2026-08-19",
        callsToday: 0,
      },
    });
    const requests: Array<Record<string, unknown>> = [];
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (_contentId, params) => {
        requests.push(params);
        return rejected422();
      }),
    };
    const stormRun = await buildChunkInput(page, fakeTelemetry());
    await expect(
      executePurchaseHistoryChunk(appContext, stormRun),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    await recordStormBlock(stormRun.syncRunId);
    // The continuation in progress walks first, then the fresh targets.
    expect(requested).toEqual(["media-t", "media-a", "media-b", "witness-1"]);

    // Repaired: the evidence target serves, and the three members are retried
    // — media-t at "order-1", where it was refused, not at page one, which the
    // chain already holds.
    requested.length = 0;
    requests.length = 0;
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (_contentId, params) => {
        requests.push(params);
        return emptyPage();
      }),
    };
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(requested).toEqual(["media-d", "media-t", "media-a", "media-b"]);
    expect(requests[1]).toEqual({ accountMediaId: "media-t", before: "order-1", limit: 100 });
    expect(result).toMatchObject({ satisfied: true, stats: { walkCompleted: true, retriesQueued: 3 } });
    // Nothing forked: media-t is one complete chain of two served pages.
    requested.length = 0;
    const third = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(third.satisfied).toBe(true);
    expect(requested).toEqual([]);
  });

  it("lets the other namespace walk while one waits for tomorrow", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 5,
        transactionCursorId: 0,
        rawPayloadCursorId: 0,
        pendingTargets: [
          { kind: "single", contentId: "media-a", before: null },
          { kind: "single", contentId: "media-b", before: null },
          { kind: "single", contentId: "media-c", before: null },
          { kind: "single", contentId: "media-d", before: null },
          { kind: "bundle", contentId: "bundle-x", before: null },
        ],
        utcDay: "2026-08-19",
        callsToday: 0,
      },
    });
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (contentId) =>
        contentId.startsWith("media-") ? rejected422() : emptyPage()),
    };

    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );

    // The single namespace is gated for the day (no witness); the bundle
    // behind it is brought forward and served instead of waiting N days.
    expect(requested).toEqual(["media-a", "media-b", "media-c", "bundle-x"]);
    expect(result).toMatchObject({
      satisfied: false,
      stats: { deferred: "contract_unproven", rejectionStreaks: { single: 3, bundle: 0 } },
    });
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      pendingTargets: [{ kind: "single", contentId: "media-d", before: null }],
    });
  });

  it("blocks a rejection storm when the witnesses reject with the streak's own status, and an unblock buys one target", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureServedTarget(page.id, "witness-1");
    await captureServedTarget(page.id, "witness-2");
    await captureDmPage(page.id, singlePpvDmPayload(["media-a", "media-b", "media-c", "media-d", "media-e"]));
    const requested: string[] = [];
    appContext = {
      ...appContext,
      // The request shape is broken: every target, witnesses included.
      adapter: orderHistoryAdapter(requested, () => rejected422()),
    };

    const firstRun = await buildChunkInput(page, fakeTelemetry());
    await expect(
      executePurchaseHistoryChunk(appContext, firstRun),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    await recordStormBlock(firstRun.syncRunId);

    // Most recently captured witness first; media-d is never asked for.
    expect(requested).toEqual(["media-a", "media-b", "media-c", "witness-2", "witness-1"]);
    expect(await probeCaptureCount()).toBe(2);
    // The lane's own record that it raised the storm — which, beside the
    // executor's record of the block, the next run reads as "the owner
    // lifted this".
    expect(await stormVerdictCount()).toBe(1);
    let checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      pendingTargets: [
        { kind: "single", contentId: "media-d", before: null },
        { kind: "single", contentId: "media-e", before: null },
      ],
    });

    // The owner unblocks the stream (page_sync_states only — the captures are
    // the streak). That buys exactly one target's worth of fresh evidence:
    // media-d, rejected, sends the walk straight back to the proof.
    requested.length = 0;
    const telemetry = fakeTelemetry();
    const secondRun = await buildChunkInput(page, telemetry);
    await expect(
      executePurchaseHistoryChunk(appContext, secondRun),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    await recordStormBlock(secondRun.syncRunId);
    expect(requested).toEqual(["media-d", "witness-2", "witness-1"]);
    expect(telemetry.anomalies).toContainEqual(expect.objectContaining({
      code: "purchase_history_storm_evidence",
      details: expect.objectContaining({ mediaKind: "single", rejectionStreak: 3 }),
    }));
    checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      pendingTargets: [{ kind: "single", contentId: "media-e", before: null }],
    });

    // Every unblock buys one target — media-e — and with nothing left behind
    // it the walk simply completes; the streak stays in the captures.
    requested.length = 0;
    const third = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(requested).toEqual(["media-e"]);
    expect(third).toMatchObject({
      satisfied: true,
      stats: { walkCompleted: true, rejectionStreaks: { single: 5, bundle: 0 } },
    });

    // The evidence is durably spent (media-e's rejection sits after the last
    // failed witnesses): the next discovered target gets no free pass — the
    // proof runs first and blocks again on the witnesses alone.
    requested.length = 0;
    await captureDmPage(page.id, singlePpvDmPayload(["media-f"]));
    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    expect(requested).toEqual(["witness-2", "witness-1"]);
    checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      pendingTargets: [{ kind: "single", contentId: "media-f", before: null }],
    });
  });

  it("retries the storm's members once when the contract turns out repaired", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureServedTarget(page.id, "witness-1");
    await captureDmPage(page.id, singlePpvDmPayload(["media-a", "media-b", "media-c", "media-d", "media-e"]));
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, () => rejected422()),
    };
    const stormRun = await buildChunkInput(page, fakeTelemetry());
    await expect(
      executePurchaseHistoryChunk(appContext, stormRun),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    await recordStormBlock(stormRun.syncRunId);
    expect(requested).toEqual(["media-a", "media-b", "media-c", "witness-1"]);

    // Repaired (Fansly, or a code fix); the owner unblocks.
    requested.length = 0;
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, () => emptyPage()),
    };
    const telemetry = fakeTelemetry();
    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, telemetry),
    );

    // The fresh-evidence target is served: the rejections happened while the
    // contract was broken, so the three members are retried once, ahead of the
    // rest of the queue — and served, their histories are recovered.
    expect(requested).toEqual(["media-d", "media-a", "media-b", "media-c", "media-e"]);
    expect(result).toMatchObject({
      satisfied: true,
      stats: { walkCompleted: true, targetsFetched: 5, targetsSkipped: 0, retriesQueued: 3, probeRequests: 0 },
    });
    expect(telemetry.anomalies).toContainEqual(expect.objectContaining({
      code: "purchase_history_rejection_retry_queued",
      details: expect.objectContaining({ contentIds: ["media-a", "media-b", "media-c"] }),
    }));
    const pages = await testDb.pool.query<{ content_id: string; status_code: number | null }>(
      `select request_params ->> 'accountMediaId' as content_id, status_code
         from sync_raw_payloads
        where endpoint = 'purchase_history' and request_params ->> 'accountMediaId' = 'media-a'
        order by id`,
    );
    expect(pages.rows).toEqual([
      { content_id: "media-a", status_code: 422 },
      { content_id: "media-a", status_code: null },
    ]);
    // Settled: nothing is retried twice, and the served answer superseded the
    // rejection in the chain.
    requested.length = 0;
    const third = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(third.satisfied).toBe(true);
    expect(requested).toEqual([]);
  });

  it("counts a malformed witness body as a storm vote", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureServedTarget(page.id, "witness-1");
    await captureDmPage(page.id, singlePpvDmPayload(["media-a", "media-b", "media-c", "media-d"]));
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (contentId) =>
        contentId === "witness-1" ? { items: [], raw: { unexpected: [] } } : rejected422()),
    };

    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toMatchObject({
      code: "purchase_history_rejection_storm",
      message: expect.stringContaining("malformed body: contract_rejected"),
    });
    expect(requested).toEqual(["media-a", "media-b", "media-c", "witness-1"]);
    expect(await probeCaptureCount()).toBe(1);
  });

  it("declares a storm the dying run never declared, spending nothing, before any evidence is granted", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Every witness voted, but the run died before journaling the verdict
    // (or throwing): no block, no owner unblock — so no free target either.
    const page = await seedPage();
    await captureServedTarget(page.id, "witness-1");
    for (const contentId of ["media-a", "media-b", "media-c"]) {
      await captureRejectedTarget(page.id, contentId);
    }
    await captureRejectedProbe(page.id, "witness-1");
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 5,
        transactionCursorId: 0,
        rawPayloadCursorId: 0,
        pendingTargets: [
          { kind: "single", contentId: "media-d", before: null },
          { kind: "single", contentId: "media-e", before: null },
        ],
        utcDay: "2026-08-19",
        callsToday: 4,
      },
    });
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, () => rejected422()),
    };

    const declaring = await buildChunkInput(page, fakeTelemetry());
    await expect(
      executePurchaseHistoryChunk(appContext, declaring),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    expect(requested).toEqual([]);
    expect(await stormVerdictCount()).toBe(1);

    // A verdict the executor never acted on (this run "died" before the
    // block landed — nothing recorded on its run) is no unblock either: the
    // next run re-declares, spending nothing.
    requested.length = 0;
    const undeclared = await buildChunkInput(page, fakeTelemetry());
    await expect(
      executePurchaseHistoryChunk(appContext, undeclared),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    expect(requested).toEqual([]);
    expect(await stormVerdictCount()).toBe(2);
    await recordStormBlock(undeclared.syncRunId);

    // Now there was a block, and this run is the owner's unblock: one target
    // (media-d), whose rejection restarts the proof for media-e — the witness
    // is asked again, votes again, and a third verdict is journaled.
    requested.length = 0;
    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    expect(requested).toEqual(["media-d", "witness-1"]);
    expect(await stormVerdictCount()).toBe(3);
  });

  it("does not let a target served earlier in the run witness for itself once its continuation is rejected", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 5,
        transactionCursorId: 0,
        rawPayloadCursorId: 0,
        pendingTargets: [
          { kind: "single", contentId: "media-t", before: null },
          { kind: "single", contentId: "media-a", before: null },
          { kind: "single", contentId: "media-b", before: null },
          { kind: "single", contentId: "media-d", before: null },
        ],
        utcDay: "2026-08-19",
        callsToday: 0,
      },
    });
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (contentId, params) =>
        contentId === "media-t" && params.before === null
          ? { items: [], raw: { accountMediaOrderHistory: [{ orderId: "order-1" }] } }
          : rejected422()),
    };

    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );

    // media-t served page one and was refused at order-1: its newest answer
    // is a rejection, so it is a MEMBER, not a witness — no witness at all,
    // no storm, the day rule instead.
    expect(requested).toEqual(["media-t", "media-t", "media-a", "media-b"]);
    expect(result).toMatchObject({
      satisfied: false,
      stats: { deferred: "contract_unproven", probeRequests: 0, rejectionStreaks: { single: 3, bundle: 0 } },
    });
    expect(await stormVerdictCount()).toBe(0);
  });

  it("drops the retry mark once the retried cursor is served, so its pagination is ordinary", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureServedTarget(page.id, "witness-1");
    await captureDmPage(page.id, singlePpvDmPayload(["media-a", "media-b", "media-c", "media-d"]));
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, () => rejected422()),
    };
    const stormRun = await buildChunkInput(page, fakeTelemetry());
    await expect(
      executePurchaseHistoryChunk(appContext, stormRun),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    await recordStormBlock(stormRun.syncRunId);

    // Repaired; media-a's retry serves a page WITH rows, so it continues at
    // order-1 — and the run's budget ends right there.
    requested.length = 0;
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (contentId, params) =>
        contentId === "media-a" && params.before === null
          ? { items: [], raw: { accountMediaOrderHistory: [{ orderId: "order-1" }] } }
          : emptyPage()),
    };
    const cut = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), 2),
    );
    expect(requested).toEqual(["media-d", "media-a"]);
    expect(cut.satisfied).toBe(false);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      pendingTargets: [
        { kind: "single", contentId: "media-a", before: "order-1" },
        { kind: "single", contentId: "media-b", before: null, retry: true },
        { kind: "single", contentId: "media-c", before: null, retry: true },
      ],
    });
    expect((checkpoint?.state as { pendingTargets: Array<Record<string, unknown>> }).pendingTargets[0])
      .not.toHaveProperty("retry");

    requested.length = 0;
    const rest = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(requested).toEqual(["media-a", "media-b", "media-c"]);
    expect(rest).toMatchObject({ satisfied: true, stats: { walkCompleted: true } });
  });

  it("keeps chunking healthy work while one namespace waits for tomorrow", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 5,
        transactionCursorId: 0,
        rawPayloadCursorId: 0,
        pendingTargets: [
          { kind: "single", contentId: "media-a", before: null },
          { kind: "single", contentId: "media-b", before: null },
          { kind: "single", contentId: "media-c", before: null },
          { kind: "single", contentId: "media-d", before: null },
          { kind: "bundle", contentId: "bundle-1", before: null },
          { kind: "bundle", contentId: "bundle-2", before: null },
          { kind: "bundle", contentId: "bundle-3", before: null },
        ],
        utcDay: "2026-08-19",
        callsToday: 0,
      },
    });
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (contentId) =>
        contentId.startsWith("media-") ? rejected422() : emptyPage()),
    };

    // Production's five-request chunk: the gated singles hand over to the
    // bundles, and with a bundle still pending the lane asks to come back at
    // the ordinary cadence, not tomorrow.
    const first = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), 5),
    );
    expect(requested).toEqual(["media-a", "media-b", "media-c", "bundle-1", "bundle-2"]);
    expect(first).toMatchObject({ satisfied: false, stats: { deferred: "contract_unproven" } });
    expect(first).not.toHaveProperty("continuationRetryAt");

    // Only the gated single left: now the lane sleeps until the next UTC day.
    requested.length = 0;
    const second = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), 5),
    );
    expect(requested).toEqual(["bundle-3"]);
    expect(second).toMatchObject({ satisfied: false, continuationRetryAt: expect.any(Date) });
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      pendingTargets: [{ kind: "single", contentId: "media-d", before: null }],
    });
  });

  it("sleeps until tomorrow, never spins, when every pending namespace is gated for the day", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Three rejected singles AND three rejected bundles, no witness of either
    // kind, today's allowance spent, one target of each kind pending. Round
    // 4 ended such a run "immediately runnable" with nothing it could do.
    const page = await seedPage();
    for (const contentId of ["media-a", "media-b", "media-c"]) {
      await captureRejectedTarget(page.id, contentId);
    }
    for (const contentId of ["bundle-x", "bundle-y", "bundle-z"]) {
      await captureRejectedBundle(page.id, contentId);
    }
    const today = new Date().toISOString().slice(0, 10);
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 5,
        transactionCursorId: 0,
        rawPayloadCursorId: 0,
        pendingTargets: [
          { kind: "single", contentId: "media-d", before: null },
          { kind: "bundle", contentId: "bundle-w", before: null },
        ],
        utcDay: today,
        callsToday: 6,
      },
    });
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, () => emptyPage()),
    };

    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry(), 5),
    );

    expect(requested).toEqual([]);
    expect(result).toMatchObject({
      satisfied: false,
      yieldReason: null,
      continuationRetryAt: expect.any(Date),
      stats: { deferred: "contract_unproven", rejectionStreaks: { single: 3, bundle: 3 } },
    });
  });

  it("lets no older block vouch for a newer verdict", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureServedTarget(page.id, "witness-1");
    await captureDmPage(page.id, singlePpvDmPayload(["media-a", "media-b", "media-c", "media-d", "media-e", "media-f"]));
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, () => rejected422()),
    };
    // Storm 1, blocked by the executor, lifted by the owner.
    const first = await buildChunkInput(page, fakeTelemetry());
    await expect(executePurchaseHistoryChunk(appContext, first))
      .rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    await recordStormBlock(first.syncRunId);

    // Storm 2 — declared, but the executor never recorded a block on this
    // run (it died in between). Storm 1's block is real, and older.
    requested.length = 0;
    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    expect(requested).toEqual(["media-d", "witness-1"]);

    // Storm 1 does not vouch for verdict 2: no evidence target — re-declare,
    // spending nothing.
    requested.length = 0;
    const third = await buildChunkInput(page, fakeTelemetry());
    await expect(executePurchaseHistoryChunk(appContext, third))
      .rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    expect(requested).toEqual([]);
    expect(await stormVerdictCount()).toBe(3);

    // The block on the run that declared verdict 3 does.
    await recordStormBlock(third.syncRunId);
    requested.length = 0;
    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    expect(requested).toEqual(["media-e", "witness-1"]);
  });

  it("keeps an unblock's evidence across a run that made no request", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureServedTarget(page.id, "witness-1");
    await captureDmPage(page.id, singlePpvDmPayload(["media-a", "media-b", "media-c", "media-d", "media-e"]));
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, () => rejected422()),
    };
    const stormRun = await buildChunkInput(page, fakeTelemetry());
    await expect(executePurchaseHistoryChunk(appContext, stormRun))
      .rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    await recordStormBlock(stormRun.syncRunId);

    // The owner unblocks, but the day's attempt cap is already spent: the
    // next run yields to tomorrow without a request.
    const stored = await getCheckpoint(appContext.db, page.id, "purchase_history");
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: { ...stored!.state, utcDay: new Date().toISOString().slice(0, 10), callsToday: 100 },
    });
    requested.length = 0;
    const cappedRun = await buildChunkInput(page, fakeTelemetry());
    const capped = await executePurchaseHistoryChunk(appContext, cappedRun);
    expect(requested).toEqual([]);
    expect(capped).toMatchObject({ satisfied: false, continuationRetryAt: expect.any(Date) });
    // ...and the executor finishes that run, as it always does — a `partial`
    // between the block and the evidence, which must not erase the unblock.
    await finishSyncRun(appContext.db, cappedRun.syncRunId, { status: "partial", stats: capped.stats ?? {} });

    // Tomorrow: the unblock's one target is still owed — the verdict's own
    // run was blocked, whatever ran in between.
    const capped2 = await getCheckpoint(appContext.db, page.id, "purchase_history");
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: { ...capped2!.state, utcDay: "2020-01-01" },
    });
    requested.length = 0;
    const telemetry = fakeTelemetry();
    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, telemetry)),
    ).rejects.toMatchObject({ code: "purchase_history_rejection_storm" });
    expect(requested).toEqual(["media-d", "witness-1"]);
    expect(telemetry.anomalies).toContainEqual(expect.objectContaining({ code: "purchase_history_storm_evidence" }));
  });

  it("recovers a repaired storm's retries ahead of fresh work after a crash", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The history a crash leaves behind: a,b,c rejected, the witness voted,
    // the storm declared and blocked, then the evidence target d SERVED — its
    // capture committed, the checkpoint not, so d is still "pending" there
    // beside the fresh target e.
    const page = await seedPage();
    await captureServedTarget(page.id, "witness-1");
    for (const contentId of ["media-a", "media-b", "media-c"]) {
      await captureRejectedTarget(page.id, contentId);
    }
    await captureRejectedProbe(page.id, "witness-1");
    const stormRun = await startSyncRun(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      trigger: "manual",
    });
    await insertRawPayload(appContext.db, {
      platformAccountId: page.id,
      syncRunId: stormRun!.id,
      endpoint: "purchase_history_contract_storm",
      requestParams: { mediaKind: "single" },
      responsePayload: { verdict: "storm", mediaKind: "single" },
      mapperVersion: "test",
      payloadKind: "mapping_critical",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    await recordStormBlock(stormRun!.id);
    await captureServedTarget(page.id, "media-d");
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 5,
        transactionCursorId: 0,
        rawPayloadCursorId: 0,
        pendingTargets: [
          { kind: "single", contentId: "media-d", before: null },
          { kind: "single", contentId: "media-e", before: null },
        ],
        utcDay: "2026-08-19",
        callsToday: 0,
      },
    });
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, () => emptyPage()),
    };

    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );

    // The storm's members first, the fresh target last — the order a run
    // without the crash produces.
    expect(requested).toEqual(["media-a", "media-b", "media-c", "media-e"]);
    expect(result).toMatchObject({ satisfied: true, stats: { walkCompleted: true } });
  });

  it("never lets a retry at a cursor overtake a continuation in progress after a crash", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // After a repair, the checkpoint still holds A's page-one retry (its
    // served page committed, the checkpoint did not) and B's retry at the
    // cursor it was refused at. A's chain resumes at order-1 — that is the
    // walk in progress, and it goes first; B's cursor is a re-asked
    // rejection, not a continuation.
    const page = await seedPage();
    await capturePurchaseHistoryTarget(page.id, {
      requestParams: { accountMediaId: "media-a", before: null, limit: 100 },
      responsePayload: { error: { status: 422, code: 99 } },
      statusCode: 422,
      errorMessage: "Fansly request failed (422)",
    });
    await capturePurchaseHistoryTarget(page.id, {
      requestParams: { accountMediaId: "media-a", before: null, limit: 100 },
      responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
    });
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 5,
        transactionCursorId: 0,
        rawPayloadCursorId: 0,
        pendingTargets: [
          { kind: "single", contentId: "media-a", before: null, retry: true },
          { kind: "single", contentId: "media-b", before: "order-b1", retry: true },
          { kind: "single", contentId: "media-e", before: null },
        ],
        utcDay: "2026-08-19",
        callsToday: 0,
      },
    });
    const requests: Array<Record<string, unknown>> = [];
    const requested: string[] = [];
    appContext = {
      ...appContext,
      adapter: orderHistoryAdapter(requested, (_contentId, params) => {
        requests.push(params);
        return emptyPage();
      }),
    };

    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );

    expect(requested).toEqual(["media-a", "media-b", "media-e"]);
    expect(requests[0]).toEqual({ accountMediaId: "media-a", before: "order-1", limit: 100 });
    expect(requests[1]).toEqual({ accountMediaId: "media-b", before: "order-b1", limit: 100 });
    expect(result).toMatchObject({ satisfied: true, stats: { walkCompleted: true } });
  });

  it("prefers bundle evidence and repairs a stale alternate-kind checkpoint locally", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, {
      messages: [{
        id: "message-bundle",
        attachments: [{ contentType: 2, contentId: "shared-content-id" }],
      }],
      accountMedia: [],
      accountMediaBundles: [{
        id: "shared-content-id",
        permissions: { permissionFlags: [{ flags: 1 }] },
      }],
      // Live Fansly payloads sometimes use accountMediaId even though the
      // attachment and metadata identify this exact id as a bundle.
      accountMediaOrders: [{ accountMediaId: "shared-content-id" }],
    });

    const requested: Array<Record<string, unknown>> = [];
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage(_context: unknown, params: Record<string, unknown>) {
          requested.push(params);
          return { items: [], raw: { accountMediaOrderHistory: [] } };
        },
      } as never,
    };

    const first = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(first.satisfied).toBe(true);
    expect(requested).toEqual([{
      accountMediaBundleId: "shared-content-id",
      before: null,
      limit: 100,
    }]);

    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 2,
        rawPayloadCursorId: Number(checkpoint?.state.rawPayloadCursorId ?? 0),
        pendingTargets: [{ kind: "single", contentId: "shared-content-id" }],
      },
    });

    const second = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(second.satisfied).toBe(true);
    expect(requested).toHaveLength(1);
  });

  it("reconciles a crash after valid raw capture locally without another request", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, {
      messages: [{ attachments: [{ contentType: 1, contentId: "media-1" }] }],
      accountMedia: [{
        id: "media-1",
        permissions: { permissionFlags: [{ flags: 1 }] },
      }],
    });
    const dmCapture = await testDb.pool.query<{ id: string }>(
      "select id::text from sync_raw_payloads where endpoint = 'dm_messages'",
    );
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 2,
        rawPayloadCursorId: Number(dmCapture.rows[0]!.id),
        pendingTargets: [{ kind: "single", contentId: "media-1" }],
      },
    });
    // This is the exact crash window: two response facts committed, while the
    // pending checkpoint still points at page one.
    await capturePurchaseHistoryTarget(page.id, {
      requestParams: { accountMediaId: "media-1", before: null, limit: 100 },
      responsePayload: { accountMediaOrderHistory: [{ orderId: "order-1" }] },
    });
    await capturePurchaseHistoryTarget(page.id, {
      requestParams: { accountMediaId: "media-1", before: "order-1", limit: 100 },
      responsePayload: { accountMediaOrderHistory: [] },
    });
    const adapterSpy = vi.fn(async (
      _context: unknown,
      _params: Record<string, unknown>,
    ) => ({
      items: [],
      raw: { accountMediaOrderHistory: [] },
    }));
    appContext = {
      ...appContext,
      adapter: { getMediaOrderHistoryPage: adapterSpy } as never,
    };

    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );

    expect(result).toMatchObject({
      satisfied: true,
      stats: { targetsFetched: 0, walkCompleted: true },
    });
    expect(adapterSpy).not.toHaveBeenCalled();
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({ pendingTargets: [] });
    expect(checkpoint?.state.completedAt).toEqual(expect.any(String));
  });

  it("resumes from the captured last orderId when the page checkpoint is stale", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, {
      messages: [{ attachments: [{ contentType: 1, contentId: "media-resume" }] }],
      accountMedia: [{
        id: "media-resume",
        permissions: { permissionFlags: [{ flags: 1 }] },
      }],
    });
    const dmCapture = await testDb.pool.query<{ id: string }>(
      "select id::text from sync_raw_payloads where endpoint = 'dm_messages'",
    );
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 3,
        transactionCursorId: 0,
        rawPayloadCursorId: Number(dmCapture.rows[0]!.id),
        pendingTargets: [
          { kind: "single", contentId: "media-resume" },
          // A legacy inference may have queued the same global content id in
          // the alternate namespace after the real target. Reconciliation
          // must discard it regardless of pending-target order.
          { kind: "bundle", contentId: "media-resume" },
        ],
      },
    });
    await capturePurchaseHistoryTarget(page.id, {
      requestParams: { accountMediaId: "media-resume", before: null, limit: 100 },
      responsePayload: { accountMediaOrderHistory: [{ orderId: "order-resume" }] },
    });
    const adapterSpy = vi.fn(async (
      _context: unknown,
      _params: Record<string, unknown>,
    ) => ({
      items: [],
      raw: { accountMediaOrderHistory: [] },
    }));
    appContext = {
      ...appContext,
      adapter: { getMediaOrderHistoryPage: adapterSpy } as never,
    };

    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );

    expect(result).toMatchObject({ satisfied: true, stats: { targetsFetched: 1 } });
    expect(adapterSpy).toHaveBeenCalledTimes(1);
    expect(adapterSpy.mock.calls[0]?.[1]).toEqual({
      accountMediaId: "media-resume",
      before: "order-resume",
      limit: 100,
    });
  });

  it("makes zero adapter calls with the feature flag off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = createTestAppContext(testDb, { fanslyPurchaseHistorySyncEnabled: false });
    const page = await seedPage();
    await captureDmPage(page.id, ppvDmPayload());
    const adapterSpy = vi.fn(async () => ({ items: [], raw: {} }));
    appContext = {
      ...appContext,
      adapter: { getMediaOrderHistoryPage: adapterSpy } as never,
    };

    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );
    expect(result).toMatchObject({ satisfied: true, stats: { skipped: "flag_off" } });
    expect(adapterSpy).not.toHaveBeenCalled();
  });

  it.each([99, 12])("treats Fansly HTTP 400 code %s as systemic contract drift", async (code, context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, ppvDmPayload());
    appContext = {
      ...appContext,
      adapter: {
        async getMediaOrderHistoryPage() {
          throw new FanslyApiError("invalid params", 400, code);
        },
      } as never,
    };

    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toThrow("invalid params");
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      version: 5,
      pendingTargets: [
        { kind: "bundle", contentId: "bundle-1", before: null },
        { kind: "single", contentId: "media-1", before: null },
        { kind: "single", contentId: "ordered-media", before: null },
      ],
    });
  });

  it("captures but blocks an unknown success shape without refetching it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, {
      messages: [{ attachments: [{ contentType: 1, contentId: "media-1" }] }],
      accountMedia: [{
        id: "media-1",
        permissions: { permissionFlags: [{ flags: 1 }] },
      }],
    });
    const adapterSpy = vi.fn(async () => ({ items: [], raw: { unexpected: [] } }));
    appContext = {
      ...appContext,
      adapter: { getMediaOrderHistoryPage: adapterSpy } as never,
    };

    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toBeInstanceOf(FanslyPurchaseHistoryContractError);
    const captures = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from sync_raw_payloads where endpoint = 'purchase_history'",
    );
    expect(captures.rows).toEqual([{ n: "1" }]);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      pendingTargets: [{ kind: "single", contentId: "media-1" }],
    });

    // Even an old checkpoint that already dropped the pending target cannot
    // grandfather the rejected raw capture into completeness.
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 2,
        rawPayloadCursorId: Number(checkpoint?.state.rawPayloadCursorId ?? 0),
        pendingTargets: [],
      },
    });
    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toBeInstanceOf(FanslyPurchaseHistoryContractError);
    expect(adapterSpy).toHaveBeenCalledTimes(1);
  });

  it("paginates a 100-row page and a short page until the provider returns empty", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, {
      messages: [{ attachments: [{ contentType: 1, contentId: "media-100" }] }],
      accountMedia: [{
        id: "media-100",
        permissions: { permissionFlags: [{ flags: 1 }] },
      }],
    });
    const adapterSpy = vi.fn(async (_context: unknown, params: { before?: string | null }) => {
      if (params.before === null) {
        return {
          items: [],
          raw: {
            accountMediaOrderHistory: Array.from(
              { length: 100 },
              (_, index) => ({ orderId: `order-${index + 1}` }),
            ),
          },
        };
      }
      if (params.before === "order-100") {
        return {
          items: [],
          raw: { accountMediaOrderHistory: [{ orderId: "order-101" }] },
        };
      }
      return { items: [], raw: { accountMediaOrderHistory: [] } };
    });
    appContext = {
      ...appContext,
      adapter: { getMediaOrderHistoryPage: adapterSpy } as never,
    };

    const result = await executePurchaseHistoryChunk(
      appContext,
      await buildChunkInput(page, fakeTelemetry()),
    );

    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        targetsFetched: 1,
        pagesFetched: 3,
        orderRowsCaptured: 101,
        walkCompleted: true,
      },
    });
    expect(adapterSpy.mock.calls.map(([, params]) => params)).toEqual([
      { accountMediaId: "media-100", before: null, limit: 100 },
      { accountMediaId: "media-100", before: "order-100", limit: 100 },
      { accountMediaId: "media-100", before: "order-101", limit: 100 },
    ]);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      version: 5,
      pendingTargets: [],
    });
  });

  it("captures a repeated cursor once and blocks later runs locally", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, {
      messages: [{ attachments: [{ contentType: 1, contentId: "media-loop" }] }],
      accountMedia: [{
        id: "media-loop",
        permissions: { permissionFlags: [{ flags: 1 }] },
      }],
    });
    const adapterSpy = vi.fn(async (_context: unknown, params: { before?: string | null }) => ({
      items: [],
      raw: {
        accountMediaOrderHistory: [{ orderId: params.before ?? "order-loop" }],
      },
    }));
    appContext = {
      ...appContext,
      adapter: { getMediaOrderHistoryPage: adapterSpy } as never,
    };

    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toMatchObject({ code: "purchase_history_cursor_repeated" });
    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toMatchObject({ code: "purchase_history_cursor_repeated" });

    expect(adapterSpy).toHaveBeenCalledTimes(2);
    const captures = await testDb.pool.query<{ before: string | null }>(
      `select request_params ->> 'before' as before
       from sync_raw_payloads
       where endpoint = 'purchase_history'
       order by id`,
    );
    expect(captures.rows).toEqual([{ before: null }, { before: "order-loop" }]);
  });

  it("reconciles valid and terminal captures but keeps a mixed blocked target", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await captureDmPage(page.id, ppvDmPayload());
    const dmCapture = await testDb.pool.query<{ id: string }>(
      "select id::text from sync_raw_payloads where endpoint = 'dm_messages'",
    );
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "purchase_history",
      state: {
        version: 2,
        rawPayloadCursorId: Number(dmCapture.rows[0]!.id),
        pendingTargets: [
          { kind: "bundle", contentId: "bundle-1" },
          { kind: "single", contentId: "media-1" },
          { kind: "single", contentId: "ordered-media" },
        ],
      },
    });
    await capturePurchaseHistoryTarget(page.id, {
      requestParams: { accountMediaBundleId: "bundle-1", limit: 100 },
      responsePayload: { error: { status: 404 } },
      statusCode: 404,
      errorMessage: "gone",
    });
    await capturePurchaseHistoryTarget(page.id, {
      requestParams: { accountMediaId: "media-1", limit: 100 },
      responsePayload: { aggregationData: { accountMediaOrders: [] } },
    });
    await capturePurchaseHistoryTarget(page.id, {
      requestParams: { accountMediaId: "ordered-media", limit: 100 },
      responsePayload: { unexpected: [] },
    });
    const adapterSpy = vi.fn(async () => ({
      items: [],
      raw: { accountMediaOrderHistory: [] },
    }));
    appContext = {
      ...appContext,
      adapter: { getMediaOrderHistoryPage: adapterSpy } as never,
    };

    await expect(
      executePurchaseHistoryChunk(appContext, await buildChunkInput(page, fakeTelemetry())),
    ).rejects.toMatchObject({ code: "purchase_history_contract_rejected" });

    expect(adapterSpy).not.toHaveBeenCalled();
    const checkpoint = await getCheckpoint(appContext.db, page.id, "purchase_history");
    expect(checkpoint?.state).toMatchObject({
      pendingTargets: [{ kind: "single", contentId: "ordered-media" }],
    });
  });
});
