// Stage 14: chargebacks via OFAPI — the daily reconcile writes
// canonical_type='chargeback' rows (source 'ofapi:rest', gross negated,
// OnlyMonster-shape) without ever touching the original settled spend row,
// and re-runs converge (0 new rows).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
  upsertTransaction,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { runOfapiChargebacksReconcile } from "../apps/runtime/src/services/ofapi-chargebacks-sync.ts";
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
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
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

function chargebacksClient(input: {
  itemsByAccount: Map<string, Record<string, unknown>[]>;
  calls: Array<{ accountId: string; offset: number; startDate: string | undefined }>;
}): OfapiClient {
  return {
    async listChargebacks(
      _context: unknown,
      accountId: string,
      params: { offset?: number; startDate?: string },
    ): Promise<OfapiListPage> {
      input.calls.push({
        accountId,
        offset: params.offset ?? 0,
        startDate: params.startDate,
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

    const calls: Array<{ accountId: string; offset: number; startDate: string | undefined }> = [];
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
    const calls: Array<{ accountId: string; offset: number; startDate: string | undefined }> = [];
    const pagedClient = {
      async listChargebacks(
        _context: unknown,
        accountId: string,
        params: { limit?: number; offset?: number; startDate?: string },
      ): Promise<OfapiListPage> {
        const offset = params.offset ?? 0;
        calls.push({ accountId, offset, startDate: params.startDate });
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
    const calls: Array<{ accountId: string; offset: number; startDate: string | undefined }> = [];
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
