import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquirePageSyncLease, createFanslyPage, createModel, ensurePageSyncStates, findPageById,
  getCheckpoint, getPageSyncState, requestPageSync, runWithPageSyncExecutionContext, scheduleDuePageSync,
  startSyncRun, upsertCheckpoint, upsertCheckpointProgress,
} from "@agency_hub_core/db";
import { FanslyAdapter } from "@agency_hub_core/fansly";
import { incidentKey } from "../apps/runtime/src/services/notification-incidents.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { fanslyTransactionsChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { executeNextSyncPageChunk } from "../apps/runtime/src/services/sync/executor.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { SyncRunTelemetry } from "../apps/runtime/src/services/sync/observability.ts";
import type { StreamChunkResult } from "../apps/runtime/src/services/sync/executor-types.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const require = createRequire(new URL("../packages/fansly/src/adapter.ts", import.meta.url));
type MockTransport = {
  disableNetConnect(): void;
  get(origin: string): {
    intercept(options: { path: RegExp | ((path: string) => boolean); method: string }): {
      reply(status: number, body: (options: { path: string }) => string): { persist(): unknown };
    };
  };
  close(): Promise<void>;
};
const { MockAgent } = require("undici") as { MockAgent: new () => MockTransport };

const DAY_MS = 24 * 60 * 60 * 1000;

function transaction(overrides: Record<string, unknown>) {
  return {
    walletId: "wallet-1",
    transactionId: "tx-1",
    accountId: "account-1",
    correlationId: null,
    correlationAccountId: null,
    type: 20001,
    destination: 0,
    amount: 7_500,
    destinationTax: 2000,
    destinationAmount: 7_500,
    newBalance: null,
    newBalance64: 50_000,
    createdAt: Date.now() - DAY_MS,
    updatedAt: null,
    status: 2,
    senderId: null,
    receiverId: null,
    ...overrides,
  };
}

describe("Fansly transactions lane item contract", () => {
  let db: Awaited<ReturnType<typeof startTestDatabase>>;
  let adapter: FanslyAdapter;
  let transport: MockTransport;
  let baseUrl: string;
  let transactionRequests: string[];
  let accountLookups: string[];
  let serveTransactions: (path: string) => unknown;

  beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => {
    await resetIntegrationDatabase(db.pool);
    baseUrl = `https://fansly-${randomUUID()}.audit.invalid`;
    transport = new MockAgent();
    transport.disableNetConnect();
    transactionRequests = [];
    accountLookups = [];
    serveTransactions = () => ({ total: 0, data: [] });
    const origin = transport.get(baseUrl);
    origin.intercept({ path: (path) => path.includes("/earnings/transactions"), method: "GET" })
      .reply(200, ({ path }) => {
        transactionRequests.push(path);
        return JSON.stringify({ success: true, response: serveTransactions(path) });
      })
      .persist();
    origin.intercept({ path: (path) => path.startsWith("/account?"), method: "GET" })
      .reply(200, ({ path }) => {
        accountLookups.push(path);
        return JSON.stringify({ success: true, response: [] });
      })
      .persist();
    adapter = new FanslyAdapter({ baseUrl, globalDelayMs: 0 });
    // Only the physical transport is mocked: the real adapter parser, the
    // transactions handler, the journal and the ledger run against Postgres.
    vi.spyOn(adapter as unknown as { getDispatcher(): MockTransport }, "getDispatcher")
      .mockReturnValue(transport);
  });
  afterEach(async () => {
    try { await adapter?.close(); } finally { await transport?.close(); vi.restoreAllMocks(); }
  });

  async function openTransactionsLane(pageId: number) {
    await ensurePageSyncStates(db.db, { pageId });
    await db.pool.query(`update page_sync_states set status = case when stream = 'transactions'
      then 'pending'::page_sync_status else 'paused'::page_sync_status end,
      succeeded_at = case when stream = 'transactions' then null else now() end where page_id = $1`, [pageId]);
  }

  async function setUpPage(mode: "incremental" | "backfill") {
    const model = await createModel(db.db, { slug: `tx-contract-${mode}`, name: "Transactions contract" });
    if (!model) throw new Error("Missing test model");
    const page = await createFanslyPage(db.db, { modelId: model.id, label: `tx-contract-${mode}` });
    if (!page) throw new Error("Missing test page");
    await openTransactionsLane(page.id);
    return page;
  }

  async function seedResumableProgress(pageId: number, mode: "incremental" | "backfill") {
    const now = Date.now();
    if (mode === "incremental") {
      const cursor = new Date(now - 2 * DAY_MS);
      await upsertCheckpoint(db.db, {
        platformAccountId: pageId, stream: "transactions", cursorTimestamp: cursor, state: {},
      });
      await upsertCheckpointProgress(db.db, {
        platformAccountId: pageId,
        stream: "transactions",
        cursorTimestamp: cursor,
        state: {
          mode: "incremental", completed: false, provider: "fansly", phase: "transactions",
          cursorTimestamp: cursor.toISOString(),
          snapshotEnd: new Date(now - 60_000).toISOString(),
          after: new Date(now - 9 * DAY_MS).toISOString(),
          lookbackStart: new Date(now - 9 * DAY_MS).toISOString(),
          oldestPendingAt: null,
          rescanCapStart: new Date(now - 30 * DAY_MS).toISOString(),
          providerReportedTotal: 250,
          newestSeenAt: cursor.toISOString(),
          oldestSeenAt: new Date(now - 3 * DAY_MS).toISOString(),
          dirtyFrom: null,
          processedTransactions: 100,
          transactionPages: 1,
          offset: 100,
          olderThanBoundaryItems: 0,
          olderThanBoundaryPages: 0,
          consecutiveAllOlderPages: 0,
          firstPageOlderThanBoundaryItems: 0,
          earlyStoppedBeyondBoundary: false,
          lastPageTransactionIds: ["tx-previous-page"],
        },
      });
      return;
    }
    await upsertCheckpointProgress(db.db, {
      platformAccountId: pageId,
      stream: "transactions",
      cursorTimestamp: null,
      state: {
        mode: "backfill", completed: false, provider: "fansly", phase: "transactions",
        snapshotEnd: new Date(now - 60_000).toISOString(),
        providerReportedTotal: 250,
        newestSeenAt: new Date(now - DAY_MS).toISOString(),
        dirtyFrom: null,
        processedTransactions: 100,
        processedChargebacks: 0,
        transactionPages: 1,
        chargebackPages: 0,
        offset: 100,
        lastPageTransactionIds: ["tx-previous-page"],
      },
    });
  }

  type TransactionsLease = NonNullable<Awaited<ReturnType<typeof acquirePageSyncLease>>>;

  async function runChunk(
    page: { id: number; label: string },
    options: { commissionRate?: number; lease?: TransactionsLease } = {},
  ) {
    const app = createTestAppContext(db, { adapter, fanslyDefaultDelayMs: 0 });
    const lease = options.lease ?? await acquirePageSyncLease(db.db, {
      pageId: page.id, workerId: "contract-test", leaseToken: `owned-${randomUUID()}`, leaseTtlMs: 120_000,
    });
    if (!lease || lease.stream !== "transactions" || lease.leasedSeq === null || !lease.leaseToken) {
      throw new Error("Missing test lease");
    }
    const stored = await findPageById(db.db, page.id);
    const run = await startSyncRun(db.db, { platformAccountId: page.id, stream: "transactions", trigger: "manual" });
    if (!stored || !run) throw new Error("Missing test run");
    const telemetry = new SyncRunTelemetry(app, { runId: run.id, platformAccountId: page.id,
      pageLabel: page.label, provider: "fansly", stream: "transactions", trigger: "manual", egressKey: lease.egressKey });
    const input = {
      pageContext: { platform: "fansly" as const,
        page: { ...stored.page, platformAccountId: "account-1", commissionRate: options.commissionRate ?? 0.25 },
        session: { authorization: "synthetic-token" }, proxy: { url: "socks5://proxy.example:1080" },
        egressKey: lease.egressKey },
      streamState: lease, syncRunId: run.id, telemetry, budget: new SyncChunkBudget(10),
    };
    const result = runWithPageSyncExecutionContext<StreamChunkResult>({ pageId: page.id, stream: "transactions",
      requestSeq: lease.leasedSeq, leaseToken: lease.leaseToken }, () => fanslyTransactionsChunk(app, input));
    return { run, telemetry, lease, result };
  }

  async function runEvents(runId: number) {
    return (await db.pool.query(
      `select event_type, severity, details from sync_run_events
       where sync_run_id = $1 and event_type in ('anomaly', 'note') order by id`,
      [runId],
    )).rows as Array<{ event_type: string; severity: string; details: Record<string, unknown> }>;
  }

  it.each(["incremental", "backfill"] as const)(
    "%s: a page with one bad item fails the run after the journal write, writes nothing and keeps progress",
    async (mode) => {
      const page = await setUpPage(mode);
      await seedResumableProgress(page.id, mode);
      const before = await getCheckpoint(db.db, page.id, "transactions");
      const raw = {
        total: 250,
        data: [
          transaction({ transactionId: "tx-good", correlationAccountId: "fan-good" }),
          transaction({ transactionId: "tx-fractional", correlationAccountId: "fan-bad", amount: 7_500.5 }),
        ],
      };
      serveTransactions = () => raw;

      const { run, lease, result } = await runChunk(page);
      await expect(result).rejects.toThrow("Fansly transaction page item failed the item contract");
      // Typed, so the executor retries it a bounded number of times, then parks the lane.
      await expect(result).rejects.toMatchObject({
        name: "FanslyTransactionsItemContractError",
        code: "transaction_item_contract_rejected",
        field: "amount",
      });

      // One request, at the saved offset, journaled verbatim before the rejection.
      expect(transactionRequests).toHaveLength(1);
      expect(new URLSearchParams(transactionRequests[0]!.split("?")[1]).get("offset")).toBe("100");
      const journal = (await db.pool.query(
        "select request_params, response_payload from sync_raw_payloads where sync_run_id = $1", [run.id],
      )).rows;
      expect(journal).toHaveLength(1);
      expect(journal[0].request_params).toMatchObject({ offset: 100, limit: 100 });
      expect(journal[0].response_payload).toEqual(raw);
      const observations = (await db.pool.query(
        "select payload from observations where account_id = $1", [page.id],
      )).rows;
      expect(observations).toEqual([{ payload: raw }]);

      // Nothing parsed from the page reached the ledger or hydration.
      expect(accountLookups).toEqual([]);
      expect((await db.pool.query(
        "select count(*)::int as count from transactions where platform_account_id = $1", [page.id],
      )).rows[0].count).toBe(0);
      const attempts = (await db.pool.query(
        "select operation, response_shape from sync_http_attempts where sync_run_id = $1", [run.id],
      )).rows;
      expect(attempts).toEqual([{
        operation: "earnings_transactions",
        response_shape: {
          total: 250,
          returnedItems: null,
          done: null,
          contractAccepted: false,
          itemViolation: { index: 1, transactionId: "tx-fractional", field: "amount" },
        },
      }]);

      // Progress is not invalidated: the retry resumes at the saved offset.
      expect(await getCheckpoint(db.db, page.id, "transactions")).toEqual(before);

      const anomalies = (await runEvents(run.id)).filter((event) => event.event_type === "anomaly");
      expect(anomalies).toEqual([expect.objectContaining({
        severity: "error",
        details: expect.objectContaining({
          code: "transaction_item_contract_rejected",
          offset: 100,
          itemViolation: { index: 1, transactionId: "tx-fractional", field: "amount" },
        }),
      })]);

      // Once the provider serves clean rows, the retry resumes at offset 100.
      transactionRequests = [];
      serveTransactions = (path) => {
        const offset = Number(new URLSearchParams(path.split("?")[1]).get("offset"));
        const count = offset === 100 ? 100 : 50;
        return {
          total: 250,
          data: Array.from({ length: count }, (_, index) =>
            transaction({ transactionId: `tx-retry-${offset + index}` })),
        };
      };
      const retry = await runChunk(page, { lease });
      await expect(retry.result).resolves.toMatchObject({ satisfied: true });
      expect(transactionRequests.map((path) => new URLSearchParams(path.split("?")[1]).get("offset")))
        .toEqual(["100", "200"]);
      expect((await db.pool.query(
        "select count(*)::int as count from transactions where platform_account_id = $1", [page.id],
      )).rows[0].count).toBe(150);
    },
  );

  it.each(["incremental", "backfill"] as const)(
    "%s: a null destinationTax falls back to the page commission with an info note",
    async (mode) => {
      const page = await setUpPage(mode);
      if (mode === "incremental") {
        await upsertCheckpoint(db.db, {
          platformAccountId: page.id, stream: "transactions",
          cursorTimestamp: new Date(Date.now() - 2 * DAY_MS), state: {},
        });
      }
      serveTransactions = () => ({
        total: 2,
        data: [
          transaction({ transactionId: "tx-null-tax", destinationTax: null }),
          transaction({ transactionId: "tx-with-tax", destinationTax: 2000 }),
        ],
      });

      const { run, telemetry, result } = await runChunk(page, { commissionRate: 0.25 });
      await expect(result).resolves.toMatchObject({ satisfied: true });

      const rows = (await db.pool.query(
        `select transaction_id, gross_amount_mills::text as gross, creator_net_amount_mills::text as net,
           raw_destination_tax
         from transactions where platform_account_id = $1 order by transaction_id`, [page.id],
      )).rows;
      expect(rows).toEqual([
        // Config commission 25%: 7500 net grosses up to 10000.
        { transaction_id: "tx-null-tax", gross: "10000", net: "7500", raw_destination_tax: null },
        // Provider tax 2000 bps: 7500 net grosses up to 9375.
        { transaction_id: "tx-with-tax", gross: "9375", net: "7500", raw_destination_tax: 2000 },
      ]);

      const events = await runEvents(run.id);
      expect(events.filter((event) => event.event_type === "anomaly")).toEqual([]);
      const fallbackNotes = events.filter((event) => event.details.code === "transaction_commission_fallback");
      expect(fallbackNotes).toEqual([expect.objectContaining({
        event_type: "note",
        severity: "info",
        details: expect.objectContaining({
          transactionIds: ["tx-null-tax"],
          fallbackCommissionRate: 0.25,
        }),
      })]);
      expect(telemetry.buildStats("success").health).toBe("healthy");
    },
  );

  // Through the real executor: lease, handler, failure classification, and
  // each due retry made runnable by the planner. Only the transport is mocked.
  async function setUpExecutorPage(mode: "incremental" | "backfill") {
    const app = createTestAppContext(db, { adapter, fanslyDefaultDelayMs: 0 });
    const { page } = await seedFanslyPage(app.db, app.config.encryptionKey, 1, `tx-contract-executor-${mode}`);
    if (!page) throw new Error("Missing test page");
    await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
    await openTransactionsLane(page.id);
    await seedResumableProgress(page.id, mode);
    return {
      app,
      page,
      execute: () => executeNextSyncPageChunk(app, page.id),
      stream: () => getPageSyncState(app.db, page.id, "transactions"),
      // The ladder's wait, waited out; the planner then makes the retry due.
      makeRetryDue: async () => {
        await db.pool.query(`update page_sync_states set retry_at = now() - interval '1 second'
          where page_id = $1 and stream = 'transactions' and status = 'retrying'`, [page.id]);
        await scheduleDuePageSync(app.db, { pageId: page.id });
      },
    };
  }

  const requestedOffsets = () =>
    transactionRequests.map((path) => new URLSearchParams(path.split("?")[1]).get("offset"));

  async function ledgerRows(pageId: number) {
    return (await db.pool.query(
      "select count(*)::int as count from transactions where platform_account_id = $1", [pageId],
    )).rows[0].count as number;
  }

  it.each(["incremental", "backfill"] as const)(
    "%s: the third rejection in a row parks the lane as provider_bad_data, and it reads no more",
    async (mode) => {
      const f = await setUpExecutorPage(mode);
      const before = await getCheckpoint(db.db, f.page.id, "transactions");
      const raw = { total: 250, data: [transaction({ transactionId: "tx-fractional", amount: 7_500.5 })] };
      serveTransactions = () => raw;

      // Rejections 1 and 2 retry on the ordinary ladder.
      for (const failures of [1, 2]) {
        await expect(f.execute()).resolves.toMatchObject({ kind: "failed", stream: "transactions" });
        expect(await f.stream()).toMatchObject({
          status: "retrying",
          retryKind: "transaction_item_contract_rejected",
          blockerKind: null,
          consecutiveFailures: failures,
          lastErrorCode: "transaction_item_contract_rejected",
        });
        await f.makeRetryDue();
        // Once due, retry_kind is gone: last_error_code carries the streak.
        expect(await f.stream()).toMatchObject({ status: "pending", retryKind: null });
      }

      // Rejection 3 parks the lane.
      await expect(f.execute()).resolves.toMatchObject({ kind: "failed", stream: "transactions" });
      expect(await f.stream()).toMatchObject({
        status: "blocked",
        blockerKind: "provider_bad_data",
        blockerCode: "transaction_item_contract_rejected",
        retryKind: null,
        retryAt: null,
        consecutiveFailures: 3,
        lastErrorCode: "transaction_item_contract_rejected",
      });
      const key = incidentKey({ kind: "stream_failed_threshold", platformAccountId: f.page.id, stream: "transactions" });
      expect((await db.pool.query(
        "select status from notification_incidents where incident_key = $1", [key],
      )).rows).toEqual([{ status: "open" }]);

      // Each attempt read the saved offset once and journaled the page verbatim;
      // nothing reached the ledger or hydration, and progress stands.
      expect(requestedOffsets()).toEqual(["100", "100", "100"]);
      expect((await db.pool.query(
        `select response_payload from sync_raw_payloads
         where page_id = $1 and endpoint = 'earnings_transactions' order by id`, [f.page.id],
      )).rows).toEqual([raw, raw, raw].map((payload) => ({ response_payload: payload })));
      expect(accountLookups).toEqual([]);
      expect(await ledgerRows(f.page.id)).toBe(0);
      expect(await getCheckpoint(db.db, f.page.id, "transactions")).toEqual(before);

      // Neither the schedule nor an operator's Sync now reads the page again.
      await requestPageSync(f.app.db, { pageId: f.page.id, streams: ["transactions"], source: "manual" });
      await scheduleDuePageSync(f.app.db, { pageId: f.page.id });
      await expect(f.execute()).resolves.toMatchObject({ kind: "idle" });
      expect(transactionRequests).toHaveLength(3);
      expect(await f.stream()).toMatchObject({ status: "blocked", blockerKind: "provider_bad_data" });
      expect(await getCheckpoint(db.db, f.page.id, "transactions")).toEqual(before);
    },
  );

  it("incremental: two rejections, then a clean page, recover the lane with no block", async () => {
    const f = await setUpExecutorPage("incremental");
    const raw = { total: 250, data: [transaction({ transactionId: "tx-fractional", amount: 7_500.5 })] };
    serveTransactions = () => raw;
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.execute()).resolves.toMatchObject({ kind: "failed", stream: "transactions" });
      await f.makeRetryDue();
    }
    expect(await f.stream()).toMatchObject({
      status: "pending", consecutiveFailures: 2, lastErrorCode: "transaction_item_contract_rejected",
    });

    serveTransactions = (path) => {
      const offset = Number(new URLSearchParams(path.split("?")[1]).get("offset"));
      const count = offset === 100 ? 100 : 50;
      return {
        total: 250,
        data: Array.from({ length: count }, (_, index) =>
          transaction({ transactionId: `tx-retry-${offset + index}` })),
      };
    };
    await expect(f.execute()).resolves.toMatchObject({ kind: "success", stream: "transactions" });

    expect(await f.stream()).toMatchObject({
      blockerKind: null, retryKind: null, consecutiveFailures: 0, lastErrorCode: null,
    });
    expect(requestedOffsets()).toEqual(["100", "100", "100", "200"]);
    expect((await db.pool.query(
      `select count(*)::int as count from sync_raw_payloads
       where page_id = $1 and endpoint = 'earnings_transactions'`, [f.page.id],
    )).rows[0].count).toBe(4);
    expect(await ledgerRows(f.page.id)).toBe(150);
  });
});
