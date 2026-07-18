// Stage 14: chargebacks via OFAPI — the daily reconcile writes
// canonical_type='chargeback' rows (source 'ofapi:rest', gross negated,
// OnlyMonster-shape) without ever touching the original settled spend row,
// and re-runs converge (0 new rows).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  listNotificationIncidents,
  listStalePendingOfapiTransactions,
  retireStalePendingTransactionsById,
  setPageOfapiAccountId,
  upsertTransaction,
} from "@agency_hub_core/db";
import {
  repairNegationAnomalies,
  upsertTransactionWithNegationGuards,
} from "../apps/runtime/src/services/money-negation-guards.ts";
import { runOfapiPendingReconcile } from "../apps/runtime/src/services/ofapi-pending-reconcile.ts";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  runOfapiChargebacksReconcile,
  startOfapiChargebacksWorker,
} from "../apps/runtime/src/services/ofapi-chargebacks-sync.ts";
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
    ofapiChargebacksReconcileEnabled: true,
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

// Vendored-spec response shape: data.list of { id, createdAt, paymentType,
// payment{ id, amount, net, fee, vatAmount, taxAmount, status, user{id} } }.
function chargebackItem(paymentId: string, fanId: string) {
  return {
    id: 7,
    createdAt: "2026-06-20T10:00:00+00:00",
    paymentType: "tips",
    payment: {
      id: paymentId,
      amount: 12.34,
      vatAmount: 1.5,
      taxAmount: 0,
      net: 9.87,
      fee: 2.47,
      createdAt: "2026-06-15T10:00:00+00:00",
      currency: "USD",
      status: "undo",
      user: { id: Number(fanId), name: "Fan", username: `u${fanId}` },
    },
  };
}

type ChargebacksCall = {
  accountId: string;
  offset: number;
  startDate: string | undefined;
  endDate: string | undefined;
};

function chargebacksClient(input: {
  itemsByAccount: Map<string, Record<string, unknown>[]>;
  calls: ChargebacksCall[];
}): OfapiClient {
  return {
    async listChargebacks(
      _context: unknown,
      accountId: string,
      params: { offset?: number; startDate?: string; endDate?: string },
    ): Promise<OfapiListPage> {
      input.calls.push({
        accountId,
        offset: params.offset ?? 0,
        startDate: params.startDate,
        endDate: params.endDate,
      });
      return {
        items: input.itemsByAccount.get(accountId) ?? [],
        hasNextPage: false,
        nextMarker: null,
        nextPageUrl: null,
        meta: null,
      };
    },
  } as unknown as OfapiClient;
}

describe("OFAPI chargebacks reconcile", () => {
  it("writes negated chargeback rows without demoting the original settled spend", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("cb-of", "acct_cb");
    // The original settled payment the chargeback reverses — must survive.
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:webhook",
      transactionId: "pay-1",
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "settled",
      grossAmountMills: 12_340n,
      sourceDestinationAmountMills: 12_340n,
      creatorNetAmountMills: 9_870n,
      senderId: "555001",
      occurredAt: new Date("2026-06-15T10:00:00.000Z"),
    });

    const calls: ChargebacksCall[] = [];
    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls,
        itemsByAccount: new Map([["acct_cb", [chargebackItem("pay-1", "555001")]]]),
      }),
    };

    const first = await runOfapiChargebacksReconcile(appContext);
    expect(first.pages).toHaveLength(1);
    expect(first.pages[0]).toMatchObject({ status: "written", writtenRows: 1 });
    // First run on a page with no chargeback rows walks the FULL history.
    expect(calls[0]?.startDate).toBeUndefined();
    expect(calls[0]?.endDate).toBeUndefined();

    const { rows } = await testDb.pool.query<{
      transaction_id: string;
      canonical_type: string;
      transaction_state: string;
      source: string;
      gross_amount_mills: string;
      creator_net_amount_mills: string;
      platform_fee_mills: string | null;
      vat_amount_mills: string | null;
    }>(`
      select transaction_id, canonical_type::text, transaction_state::text, source,
             gross_amount_mills::text, creator_net_amount_mills::text,
             platform_fee_mills::text, vat_amount_mills::text
      from transactions where platform_account_id = $1
      order by transaction_id
    `, [page.id]);

    expect(rows).toEqual([
      {
        // The original settled row is untouched — the chargeback never shares
        // its transaction_id (payment.id carries a :chargeback suffix).
        transaction_id: "pay-1",
        canonical_type: "tip",
        transaction_state: "posted",
        source: "ofapi:webhook",
        gross_amount_mills: "12340",
        creator_net_amount_mills: "9870",
        platform_fee_mills: null,
        vat_amount_mills: null,
      },
      {
        transaction_id: "pay-1:chargeback",
        canonical_type: "chargeback",
        transaction_state: "posted",
        source: "ofapi:rest",
        gross_amount_mills: "-12340",
        creator_net_amount_mills: "-9870",
        platform_fee_mills: "-2470",
        vat_amount_mills: "-1500",
      },
    ]);

    // Re-run: converges, adds nothing, and now uses the trailing window.
    const second = await runOfapiChargebacksReconcile(appContext);
    expect(second.pages[0]).toMatchObject({ status: "written", writtenRows: 1 });
    expect(calls[1]?.startDate).toBeDefined();
    expect(calls[1]?.endDate).toBeDefined();
    expect(new Date(calls[1]!.endDate!.replace(" ", "T") + "Z").getTime())
      .toBeGreaterThan(new Date(calls[1]!.startDate!.replace(" ", "T") + "Z").getTime());
    const { rows: countRows } = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(countRows).toEqual([{ n: "2" }]);
  });

  it("discards a truncated first full-history walk so the 90-day window never locks in early", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("cb-trunc-of", "acct_trunc");
    // 101 chargebacks = one full API page (100) + a tail page. The walk needs
    // two requests to complete.
    const items = Array.from({ length: 101 }, (_, i) =>
      chargebackItem(`pay-t${i}`, String(600_000 + i)));
    const calls: ChargebacksCall[] = [];
    const pagedClient = {
      async listChargebacks(
        _context: unknown,
        accountId: string,
        params: { limit?: number; offset?: number; startDate?: string; endDate?: string },
      ): Promise<OfapiListPage> {
        const offset = params.offset ?? 0;
        calls.push({
          accountId,
          offset,
          startDate: params.startDate,
          endDate: params.endDate,
        });
        const slice = items.slice(offset, offset + (params.limit ?? 100));
        return {
          items: slice,
          hasNextPage: offset + slice.length < items.length,
          nextMarker: null,
          nextPageUrl: null,
          meta: null,
        };
      },
    } as unknown as OfapiClient;

    // Day budget of 1 credit: the guard admits the first request, then blocks
    // before the second — truncating the initial full-history walk.
    appContext = {
      ...createTestAppContext(testDb, {
        ofapiChargebacksReconcileEnabled: true,
        ofapiCreditLedgerEnabled: true,
        ofapiBackfillDailyCreditBudget: 1,
      }),
      ofapi: pagedClient,
    };
    const truncated = await runOfapiChargebacksReconcile(appContext);
    expect(truncated.pages[0]).toMatchObject({
      status: "blocked",
      reason: "ofapi_daily_credit_budget",
      apiPages: 1,
      rawRows: 100,
      writtenRows: 0,
    });
    // Nothing landed — otherwise pageHasChargebackRows would flip this page
    // into the trailing window with 1 of 101 rows forever missing history.
    const { rows: afterTruncation } = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(afterTruncation).toEqual([{ n: "0" }]);

    // Next run with budget available: STILL a full-history walk, completes,
    // writes everything.
    appContext = {
      ...createTestAppContext(testDb, {
        ofapiChargebacksReconcileEnabled: true,
        ofapiCreditLedgerEnabled: true,
        ofapiBackfillDailyCreditBudget: 200,
      }),
      ofapi: pagedClient,
    };
    const completed = await runOfapiChargebacksReconcile(appContext);
    expect(calls[1]?.startDate).toBeUndefined();
    expect(calls[2]?.offset).toBe(100);
    expect(completed.pages[0]).toMatchObject({ status: "written", writtenRows: 101 });
    const { rows: afterCompletion } = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(afterCompletion).toEqual([{ n: "101" }]);
  });

  it("isolates a failed page, keeps the worker failed, and resolves one global incident after a clean run", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const failedPage = await seedOfapiPage("a-cb-fail", "acct_cb_fail");
    const healthyPage = await seedOfapiPage("b-cb-healthy", "acct_cb_healthy");
    let vendorFailure = true;
    const calls: ChargebacksCall[] = [];
    appContext = {
      ...appContext,
      ofapi: {
        async listChargebacks(
          _context: unknown,
          accountId: string,
          params: { offset?: number; startDate?: string; endDate?: string },
        ): Promise<OfapiListPage> {
          calls.push({
            accountId,
            offset: params.offset ?? 0,
            startDate: params.startDate,
            endDate: params.endDate,
          });
          if (accountId === "acct_cb_fail" && vendorFailure) {
            throw new Error("scripted OFAPI validation failure");
          }
          return {
            items: accountId === "acct_cb_healthy"
              ? [chargebackItem("pay-healthy", "555010")]
              : [],
            hasNextPage: false,
            nextMarker: null,
            nextPageUrl: null,
            meta: null,
          };
        },
      } as unknown as OfapiClient,
    };

    const first = await runOfapiChargebacksReconcile(appContext);
    expect(first.pages).toEqual([
      expect.objectContaining({
        pageLabel: failedPage.label,
        status: "failed",
        reason: "scripted OFAPI validation failure",
      }),
      expect.objectContaining({
        pageLabel: healthyPage.label,
        status: "written",
        writtenRows: 1,
      }),
    ]);
    const { rows: healthyRows } = await testDb.pool.query<{ n: number }>(
      "select count(*)::int as n from transactions where platform_account_id = $1 and transaction_id = 'pay-healthy:chargeback'",
      [healthyPage.id],
    );
    expect(healthyRows).toEqual([{ n: 1 }]);

    let incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      incidentKey: "ofapi_chargebacks_reconcile_failed:global",
      kind: "ofapi_chargebacks_reconcile_failed",
      platformAccountId: null,
      status: "open",
    });

    // A second failing pass refreshes the same global latch. The worker still
    // marks its pg-boss job failed, but only after the healthy page ran.
    let workerHandler: (() => Promise<void>) | null = null;
    await startOfapiChargebacksWorker(appContext, {
      async work(_queue, _options, handler) {
        workerHandler = handler;
        return null;
      },
    });
    expect(workerHandler).not.toBeNull();
    await expect(workerHandler!()).rejects.toThrow(
      "OFAPI chargebacks reconcile failed for 1 page(s)",
    );
    incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.status).toBe("open");
    expect(calls.filter((call) => call.accountId === "acct_cb_healthy")).toHaveLength(2);

    vendorFailure = false;
    const recovered = await runOfapiChargebacksReconcile(appContext);
    expect(recovered.pages.map((page) => page.status)).toEqual(["written", "written"]);
    incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "ofapi_chargebacks_reconcile_failed",
      status: "resolved",
    });
  });

  // ——— W7.3 (A21+B4, decision #132): negation guards ———

  function settledOriginal(pageId: number, transactionId: string) {
    return upsertTransactionWithNegationGuards(appContext.db, {
      platformAccountId: pageId,
      source: "ofapi:webhook",
      transactionId,
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "settled",
      grossAmountMills: 12_340n,
      sourceDestinationAmountMills: 12_340n,
      creatorNetAmountMills: 9_870n,
      senderId: "555001",
      occurredAt: new Date("2026-06-15T10:00:00.000Z"),
    });
  }

  function reversalRow(pageId: number, baseId: string) {
    return upsertTransactionWithNegationGuards(appContext.db, {
      platformAccountId: pageId,
      source: "ofapi:webhook",
      transactionId: `${baseId}:reversal`,
      rawType: "ofapi:tip",
      canonicalType: "refund",
      transactionState: "posted",
      rawStatus: "refunded",
      grossAmountMills: -12_340n,
      sourceDestinationAmountMills: -12_340n,
      creatorNetAmountMills: -9_870n,
      senderId: "555001",
      occurredAt: new Date("2026-06-20T10:00:00.000Z"),
    });
  }

  async function rowState(pageId: number, transactionId: string) {
    const { rows } = await testDb!.pool.query<{
      is_active: boolean;
      inactive_reason: string | null;
    }>(
      "select is_active, inactive_reason::text from transactions where platform_account_id = $1 and transaction_id = $2",
      [pageId, transactionId],
    );
    return rows[0] ?? null;
  }

  async function activeNetMills(pageId: number) {
    const { rows } = await testDb!.pool.query<{ net: string }>(
      "select coalesce(sum(creator_net_amount_mills), 0)::text as net from transactions where platform_account_id = $1 and is_active",
      [pageId],
    );
    return rows[0]!.net;
  }

  it("guard 1 (B4): a chargeback with an active reversal twin writes INACTIVE — never double-negate", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-twin", "acct_twin");
    await settledOriginal(page.id, "pay-1");
    const reversal = await reversalRow(page.id, "pay-1");
    expect(reversal.suppressedAs).toBeNull();

    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls: [],
        itemsByAccount: new Map([["acct_twin", [chargebackItem("pay-1", "555001")]]]),
      }),
    };
    await runOfapiChargebacksReconcile(appContext);

    expect(await rowState(page.id, "pay-1:reversal")).toEqual({
      is_active: true,
      inactive_reason: null,
    });
    expect(await rowState(page.id, "pay-1:chargeback")).toEqual({
      is_active: false,
      inactive_reason: "superseded_duplicate_negation",
    });
    // Net over ACTIVE rows = settled + one negation = 0.
    expect(await activeNetMills(page.id)).toBe("0");
  });

  it("guard 1 symmetric: a reversal landing after an active chargeback is the suppressed twin", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-sym", "acct_sym");
    await settledOriginal(page.id, "pay-2");
    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls: [],
        itemsByAccount: new Map([["acct_sym", [chargebackItem("pay-2", "555001")]]]),
      }),
    };
    await runOfapiChargebacksReconcile(appContext);

    const reversal = await reversalRow(page.id, "pay-2");
    expect(reversal.suppressedAs).toBe("superseded_duplicate_negation");
    expect(await rowState(page.id, "pay-2:reversal")).toEqual({
      is_active: false,
      inactive_reason: "superseded_duplicate_negation",
    });
    expect(await activeNetMills(page.id)).toBe("0");
  });

  it("guard 2 (A21): a negative with no settled original writes INACTIVE; a late original reactivates it (net 0)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-orphan", "acct_orphan");
    // Chargeback for a payment we never saw settle.
    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls: [],
        itemsByAccount: new Map([["acct_orphan", [chargebackItem("pay-3", "555001")]]]),
      }),
    };
    await runOfapiChargebacksReconcile(appContext);
    expect(await rowState(page.id, "pay-3:chargeback")).toEqual({
      is_active: false,
      inactive_reason: "reversal_without_settled_original",
    });
    expect(await activeNetMills(page.id)).toBe("0");

    // The original settles late → the fixup reactivates the negation.
    const original = await settledOriginal(page.id, "pay-3");
    expect(original.reactivatedFrom).not.toBeNull();
    expect(await rowState(page.id, "pay-3:chargeback")).toEqual({
      is_active: true,
      inactive_reason: null,
    });
    expect(await activeNetMills(page.id)).toBe("0");
  });

  it("guard 0: a redelivery re-upsert NEVER resurrects a suppressed negation (sticky)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-sticky", "acct_sticky");
    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls: [],
        itemsByAccount: new Map([["acct_sticky", [chargebackItem("pay-4", "555001")]]]),
      }),
    };
    await runOfapiChargebacksReconcile(appContext);
    expect((await rowState(page.id, "pay-4:chargeback"))!.is_active).toBe(false);

    // Redelivery through the PLAIN upsert (the pre-guard writer shape) —
    // the conflict-set itself must preserve the suppression.
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:rest",
      transactionId: "pay-4:chargeback",
      rawType: "ofapi:chargeback",
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: "undo",
      grossAmountMills: -12_340n,
      sourceDestinationAmountMills: -12_340n,
      creatorNetAmountMills: -9_870n,
      senderId: "555001",
      occurredAt: new Date("2026-06-20T10:00:00.000Z"),
    });
    expect(await rowState(page.id, "pay-4:chargeback")).toEqual({
      is_active: false,
      inactive_reason: "reversal_without_settled_original",
    });
  });

  it("repair CLI: deactivates census anomalies (orphans + duplicate twins, reversal canonical) and rebuilds", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-repair", "acct_repair");
    // Pre-guard world: seed an ACTIVE orphan reversal and an ACTIVE
    // double-negative pair via the plain upsert.
    const plain = (transactionId: string, net: bigint, canonicalType: "tip" | "refund" | "chargeback", state: "posted" | "pending" = "posted") =>
      upsertTransaction(appContext.db, {
        platformAccountId: page.id,
        source: "ofapi:webhook",
        transactionId,
        rawType: "ofapi:tip",
        canonicalType,
        transactionState: state,
        rawStatus: "x",
        grossAmountMills: net,
        sourceDestinationAmountMills: net,
        creatorNetAmountMills: net,
        senderId: "555001",
        occurredAt: new Date("2026-06-18T10:00:00.000Z"),
      });
    await plain("orphan-1:reversal", -5_000n, "refund");
    await plain("dup-1", 8_000n, "tip");
    await plain("dup-1:reversal", -8_000n, "refund");
    await plain("dup-1:chargeback", -8_000n, "chargeback");

    const dry = await repairNegationAnomalies(appContext, { dryRun: true });
    expect(dry).toMatchObject({ pairs: 1, deactivated: 0, dryRun: true });
    expect((await rowState(page.id, "orphan-1:reversal"))!.is_active).toBe(true);

    const real = await repairNegationAnomalies(appContext, { dryRun: false });
    expect(real.pairs).toBe(1);
    expect(real.deactivated).toBeGreaterThanOrEqual(2);
    // Canonical-twin pin: the :reversal stays, the :chargeback deactivates.
    expect((await rowState(page.id, "dup-1:reversal"))!.is_active).toBe(true);
    expect(await rowState(page.id, "dup-1:chargeback")).toEqual({
      is_active: false,
      inactive_reason: "superseded_duplicate_negation",
    });
    expect(await rowState(page.id, "orphan-1:reversal")).toEqual({
      is_active: false,
      inactive_reason: "reversal_without_settled_original",
    });
    // dup pair nets 0 over active rows; orphan no longer subtracts.
    expect(await activeNetMills(page.id)).toBe("0");
  });

  // ——— W7.4 (A47): pending settle-or-expire ———

  it("stale-pending listing + targeted retire: only still-pending rows expire", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-pending", "acct_pending");
    const pendingAt = new Date(Date.now() - 10 * 86_400_000);
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:webhook",
      transactionId: "pend-1",
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "pending",
      rawStatus: "pending",
      grossAmountMills: 4_000n,
      sourceDestinationAmountMills: 4_000n,
      creatorNetAmountMills: 3_200n,
      senderId: "555001",
      occurredAt: pendingAt,
    });
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:webhook",
      transactionId: "pend-2",
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "pending",
      rawStatus: "pending",
      grossAmountMills: 1_000n,
      sourceDestinationAmountMills: 1_000n,
      creatorNetAmountMills: 800n,
      senderId: "555001",
      occurredAt: new Date(), // fresh — not stale
    });

    const stale = await listStalePendingOfapiTransactions(appContext.db, {
      olderThan: new Date(Date.now() - 7 * 86_400_000),
    });
    const staleIds = stale.filter((row) => row.platformAccountId === page.id);
    expect(staleIds.map((row) => row.transactionId)).toEqual(["pend-1"]);

    // Simulate the rescan settling pend-1 BEFORE the retire pass: the
    // targeted retire re-checks state and must not touch it.
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:rest",
      transactionId: "pend-1",
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 4_000n,
      sourceDestinationAmountMills: 4_000n,
      creatorNetAmountMills: 3_200n,
      senderId: "555001",
      occurredAt: pendingAt,
    });
    const retired = await retireStalePendingTransactionsById(appContext.db, {
      platformAccountId: page.id,
      ids: staleIds.map((row) => row.id),
    });
    expect(retired).toBe(0);
    expect((await rowState(page.id, "pend-1"))!.is_active).toBe(true);

    // And a row the rescan did NOT settle retires.
    const { rows } = await testDb.pool.query<{ id: number }>(
      "update transactions set transaction_state = 'pending' where platform_account_id = $1 and transaction_id = 'pend-1' returning id",
      [page.id],
    );
    const retired2 = await retireStalePendingTransactionsById(appContext.db, {
      platformAccountId: page.id,
      ids: [rows[0]!.id],
    });
    expect(retired2).toBe(1);
    expect(await rowState(page.id, "pend-1")).toEqual({
      is_active: false,
      inactive_reason: "missing_from_sync_window",
    });
  });

  it("pending reconcile is a no-op with truth ingest disabled", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = createTestAppContext(testDb, {
      ofapiSpendTransactionIngestEnabled: false,
    });
    const result = await runOfapiPendingReconcile(appContext);
    expect(result).toMatchObject({ skipped: "disabled", stalePendings: 0, expired: 0 });
  });

  it("does nothing with the flag off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = createTestAppContext(testDb, {
      ofapiChargebacksReconcileEnabled: false,
      ofapiCreditLedgerEnabled: true,
    });
    await seedOfapiPage("cb-off-of", "acct_cb_off");
    const calls: ChargebacksCall[] = [];
    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls,
        itemsByAccount: new Map([["acct_cb_off", [chargebackItem("pay-9", "555009")]]]),
      }),
    };

    const result = await runOfapiChargebacksReconcile(appContext);
    expect(result.pages).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
