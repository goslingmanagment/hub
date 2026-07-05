import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  reserveOfapiDayCredits,
  summarizeOfapiSpendProjectionComparison,
  setPageOfapiAccountId,
  storePlatformCredentials,
  upsertOfapiSpendProjectionEvent,
  upsertTransaction,
} from "@agency_hub_core/db";

import { applyOfapiSpendProjectionTransactions } from "../apps/runtime/src/services/ofapi-spend-transaction-ingest.ts";
import { runOfapiTransactionsBackfill } from "../apps/runtime/src/services/ofapi-transactions-backfill.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import type { OfapiClient, OfapiListPage } from "../apps/runtime/src/services/ofapi.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let journalId = 0;

async function seedPage(label = "lora-of") {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  // Stage 13: pages holding OFAPI projection events are OFAPI-mapped in
  // reality; the mapping assigns transactions_writer='ofapi', which the
  // single-writer gate requires before the ingest may touch the page.
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: `acct-${label}` });
  return page;
}

async function seedOfapiPage(label: string, ofapiAccountId: string) {
  const page = await seedPage(label);
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId });
  return page;
}

function fakeOfapiTransactionsClient(input: {
  rowsByAccount: Map<string, Record<string, unknown>[]>;
  calls?: Array<{ accountId: string; marker: string | null }>;
  onCall?: (accountId: string) => Promise<void> | void;
}): OfapiClient {
  return {
    async listTransactions(
      _context: unknown,
      accountId: string,
      params: { marker?: string | null },
    ): Promise<OfapiListPage> {
      input.calls?.push({ accountId, marker: params.marker ?? null });
      await input.onCall?.(accountId);
      return {
        items: input.rowsByAccount.get(accountId) ?? [],
        hasNextPage: false,
        nextMarker: null,
        nextPageUrl: null,
        meta: null,
      };
    },
  } as unknown as OfapiClient;
}

// Serves a fixed list of pages in order, one per listTransactions call, so a test
// can exercise the multi-page marker walk and assert exactly how many pages were
// fetched before the bounded walk stopped.
function pagedOfapiTransactionsClient(input: {
  pages: Array<{
    items: Record<string, unknown>[];
    nextMarker: string | null;
    meta?: OfapiListPage["meta"];
  }>;
  calls: Array<{ marker: string | null }>;
}): OfapiClient {
  return {
    async listTransactions(
      _context: unknown,
      _accountId: string,
      params: { marker?: string | null },
    ): Promise<OfapiListPage> {
      const index = input.calls.length;
      input.calls.push({ marker: params.marker ?? null });
      const page = input.pages[index] ?? { items: [], nextMarker: null };
      return {
        items: page.items,
        hasNextPage: page.nextMarker !== null,
        nextMarker: page.nextMarker,
        nextPageUrl: null,
        meta: page.meta ?? null,
      };
    },
  } as unknown as OfapiClient;
}

async function seedProjectedTransaction(input: {
  pageId: number;
  transactionId: string;
  fanPlatformUserId: string;
  category?: "message" | "tip" | "subscription" | "post" | "stream" | "other";
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
  eventStatus: "pending" | "settled" | "reversed";
  occurredAt: Date;
}) {
  journalId += 1;
  await upsertOfapiSpendProjectionEvent(appContext.db, {
    domainKey: `ofapi:acct_main:tx:${input.transactionId}`,
    projectionStatus: "projected",
    sourceEventType: "transactions.new",
    sourceIdempotencyKey: `idem-${input.transactionId}`,
    journalId,
    ofapiAccountId: "acct_main",
    pageId: input.pageId,
    fanPlatformUserId: input.fanPlatformUserId,
    transactionId: input.transactionId,
    occurredAt: input.occurredAt,
    category: input.category ?? "message",
    currency: "USD",
    grossAmountMills: input.grossAmountMills,
    creatorNetAmountMills: input.creatorNetAmountMills,
    eventStatus: input.eventStatus,
  });
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  journalId = 0;
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {
    ofapiSpendProjectionShadowEnabled: true,
    ofapiSpendTransactionIngestEnabled: true,
  });
});

afterAll(async () => {
  await testDb?.stop();
});

describe("OFAPI spend transaction ingest", () => {
  it("applies missing transactions.new shadow rows into core transaction truth", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    const occurredAt = new Date("2026-06-19T10:30:00.000Z");
    await seedProjectedTransaction({
      pageId: page.id,
      transactionId: "tx-settled",
      fanPlatformUserId: "1000003",
      grossAmountMills: 17_000n,
      creatorNetAmountMills: 13_600n,
      eventStatus: "settled",
      occurredAt,
    });

    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(1);
    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(0);

    const { rows } = await testDb.pool.query<{
      transaction_state: string;
      raw_status: string;
      canonical_type: string;
      gross_amount_mills: string;
      creator_net_amount_mills: string;
      sender_id: string;
      fan_platform_user_id: string;
      lifetime_net: string;
      revenue_count: number;
      revenue_net: string;
    }>(`
      select t.transaction_state,
             t.raw_status,
             t.canonical_type,
             t.gross_amount_mills::text,
             t.creator_net_amount_mills::text,
             t.sender_id,
             f.platform_user_id as fan_platform_user_id,
             coalesce(slp.creator_net_amount_mills, 0)::text as lifetime_net,
             coalesce(rd.transaction_count, 0)::int as revenue_count,
             coalesce(rd.creator_net_amount_mills, 0)::text as revenue_net
      from transactions t
      join fans f on f.id = t.fan_id
      left join fan_spend_lifetime slp
        on slp.platform_account_id = t.platform_account_id
       and slp.fan_id = t.fan_id
      left join revenue_daily rd
        on rd.platform_account_id = t.platform_account_id
       and rd.business_date = '2026-06-19'::date
       and rd.canonical_type = 'message_purchase'
       and rd.transaction_state = 'posted'
      where t.platform_account_id = $1
        and t.transaction_id = 'tx-settled'
    `, [page.id]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transaction_state: "posted",
      raw_status: "settled",
      canonical_type: "message_purchase",
      gross_amount_mills: "17000",
      creator_net_amount_mills: "13600",
      sender_id: "1000003",
      fan_platform_user_id: "1000003",
      lifetime_net: "13600",
      revenue_count: 1,
      revenue_net: "13600",
    });

    const comparison = await summarizeOfapiSpendProjectionComparison(appContext.db, {
      from: new Date("2026-06-19T00:00:00.000Z"),
      to: new Date("2026-06-20T00:00:00.000Z"),
      sampleLimit: 10,
    });
    expect(comparison).toEqual([{
      status: "matched",
      count: 1,
      grossAmountMills: 17_000n,
      creatorNetAmountMills: 13_600n,
      coreGrossAmountMills: 17_000n,
      coreCreatorNetAmountMills: 13_600n,
    }]);
  });

  it("applies pending truth and updates terminal state transitions", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage("vip-of");
    const occurredAt = new Date("2026-06-19T11:00:00.000Z");
    await seedProjectedTransaction({
      pageId: page.id,
      transactionId: "tx-transition",
      fanPlatformUserId: "1000004",
      grossAmountMills: 17_000n,
      creatorNetAmountMills: 13_600n,
      eventStatus: "pending",
      occurredAt,
    });

    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(1);
    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(0);

    let count = await testDb.pool.query<{ count: number }>(
      "select count(*)::int as count from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(count.rows).toEqual([{ count: 1 }]);
    let pending = await testDb.pool.query<{
      transaction_state: string;
      raw_status: string;
      gross_amount_mills: string;
      creator_net_amount_mills: string;
    }>(
      "select transaction_state, raw_status, gross_amount_mills::text, creator_net_amount_mills::text from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(pending.rows).toEqual([{
      transaction_state: "pending",
      raw_status: "pending",
      gross_amount_mills: "17000",
      creator_net_amount_mills: "13600",
    }]);

    await seedProjectedTransaction({
      pageId: page.id,
      transactionId: "tx-transition",
      fanPlatformUserId: "1000004",
      grossAmountMills: 17_000n,
      creatorNetAmountMills: 13_600n,
      eventStatus: "settled",
      occurredAt,
    });

    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(1);
    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(0);

    const { rows } = await testDb.pool.query<{
      transaction_state: string;
      raw_status: string;
      gross_amount_mills: string;
      creator_net_amount_mills: string;
      lifetime_net: string;
    }>(`
      select t.transaction_state,
             t.raw_status,
             t.gross_amount_mills::text,
             t.creator_net_amount_mills::text,
             coalesce(slp.creator_net_amount_mills, 0)::text as lifetime_net
      from transactions t
      left join fan_spend_lifetime slp
        on slp.platform_account_id = t.platform_account_id
       and slp.fan_id = t.fan_id
      where t.platform_account_id = $1
        and t.transaction_id = 'tx-transition'
    `, [page.id]);

    expect(rows).toEqual([{
      transaction_state: "posted",
      raw_status: "settled",
      gross_amount_mills: "17000",
      creator_net_amount_mills: "13600",
      lifetime_net: "13600",
    }]);
  });

  it("updates existing core transactions from terminal OFAPI projections", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage("existing-of");
    const occurredAt = new Date("2026-06-19T11:15:00.000Z");
    await seedProjectedTransaction({
      pageId: page.id,
      transactionId: "tx-existing",
      fanPlatformUserId: "1000004",
      grossAmountMills: 17_000n,
      creatorNetAmountMills: 13_600n,
      eventStatus: "settled",
      occurredAt,
    });
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "tx-existing",
      rawType: "message",
      canonicalType: "message_purchase",
      transactionState: "pending",
      rawStatus: "pending",
      grossAmountMills: 9_000n,
      sourceDestinationAmountMills: 9_000n,
      creatorNetAmountMills: 7_200n,
      senderId: "1000004",
      occurredAt,
    });

    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(1);
    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(0);

    const { rows } = await testDb.pool.query<{
      transaction_state: string;
      raw_status: string;
      gross_amount_mills: string;
      creator_net_amount_mills: string;
    }>(`
      select transaction_state,
             raw_status,
             gross_amount_mills::text,
             creator_net_amount_mills::text
      from transactions
      where platform_account_id = $1
        and transaction_id = 'tx-existing'
    `, [page.id]);
    expect(rows).toEqual([{
      transaction_state: "posted",
      raw_status: "settled",
      gross_amount_mills: "17000",
      creator_net_amount_mills: "13600",
    }]);

    const comparison = await summarizeOfapiSpendProjectionComparison(appContext.db, {
      from: new Date("2026-06-19T00:00:00.000Z"),
      to: new Date("2026-06-20T00:00:00.000Z"),
      sampleLimit: 10,
    });
    expect(comparison.map((row) => ({ status: row.status, count: row.count }))).toEqual([
      { status: "matched", count: 1 },
    ]);
  });

  it("applies reversed terminal rows as negative refund adjustments", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage("refund-of");
    const purchaseAt = new Date("2026-06-19T11:30:00.000Z");
    const refundAt = new Date("2026-06-19T12:00:00.000Z");
    await seedProjectedTransaction({
      pageId: page.id,
      transactionId: "tx-settled-for-refund",
      fanPlatformUserId: "1000006",
      grossAmountMills: 17_000n,
      creatorNetAmountMills: 13_600n,
      eventStatus: "settled",
      occurredAt: purchaseAt,
    });
    await seedProjectedTransaction({
      pageId: page.id,
      transactionId: "tx-refund",
      fanPlatformUserId: "1000006",
      grossAmountMills: 5_000n,
      creatorNetAmountMills: 4_000n,
      eventStatus: "reversed",
      occurredAt: refundAt,
    });

    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(2);
    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(0);

    const { rows } = await testDb.pool.query<{
      transaction_id: string;
      canonical_type: string;
      transaction_state: string;
      raw_status: string;
      gross_amount_mills: string;
      creator_net_amount_mills: string;
      lifetime_net: string;
      refund_revenue_net: string;
    }>(`
      select t.transaction_id,
             t.canonical_type,
             t.transaction_state,
             t.raw_status,
             t.gross_amount_mills::text,
             t.creator_net_amount_mills::text,
             coalesce(slp.creator_net_amount_mills, 0)::text as lifetime_net,
             coalesce(rd.creator_net_amount_mills, 0)::text as refund_revenue_net
      from transactions t
      left join fan_spend_lifetime slp
        on slp.platform_account_id = t.platform_account_id
       and slp.fan_id = t.fan_id
      left join revenue_daily rd
        on rd.platform_account_id = t.platform_account_id
       and rd.business_date = '2026-06-19'::date
       and rd.canonical_type = 'refund'
       and rd.transaction_state = 'posted'
      where t.platform_account_id = $1
      order by t.transaction_id
    `, [page.id]);

    expect(rows).toEqual([
      {
        transaction_id: "tx-refund",
        canonical_type: "refund",
        transaction_state: "posted",
        raw_status: "reversed",
        gross_amount_mills: "-5000",
        creator_net_amount_mills: "-4000",
        lifetime_net: "9600",
        refund_revenue_net: "-4000",
      },
      {
        transaction_id: "tx-settled-for-refund",
        canonical_type: "message_purchase",
        transaction_state: "posted",
        raw_status: "settled",
        gross_amount_mills: "17000",
        creator_net_amount_mills: "13600",
        lifetime_net: "9600",
        refund_revenue_net: "-4000",
      },
    ]);
  });

  it("keeps same-provider-id reversals separate from the original settled row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage("same-id-refund-of");
    const occurredAt = new Date("2026-06-19T13:00:00.000Z");
    await seedProjectedTransaction({
      pageId: page.id,
      transactionId: "tx-same-id",
      fanPlatformUserId: "1000007",
      grossAmountMills: 17_000n,
      creatorNetAmountMills: 13_600n,
      eventStatus: "settled",
      occurredAt,
    });
    await seedProjectedTransaction({
      pageId: page.id,
      transactionId: "tx-same-id:reversal",
      fanPlatformUserId: "1000007",
      grossAmountMills: 17_000n,
      creatorNetAmountMills: 13_600n,
      eventStatus: "reversed",
      occurredAt: new Date("2026-06-19T13:05:00.000Z"),
    });

    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(2);
    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(0);

    const { rows } = await testDb.pool.query<{
      transaction_id: string;
      canonical_type: string;
      raw_status: string;
      gross_amount_mills: string;
      creator_net_amount_mills: string;
      lifetime_net: string;
    }>(`
      select t.transaction_id,
             t.canonical_type,
             t.raw_status,
             t.gross_amount_mills::text,
             t.creator_net_amount_mills::text,
             coalesce(slp.creator_net_amount_mills, 0)::text as lifetime_net
      from transactions t
      left join fan_spend_lifetime slp
        on slp.platform_account_id = t.platform_account_id
       and slp.fan_id = t.fan_id
      where t.platform_account_id = $1
      order by t.transaction_id
    `, [page.id]);

    expect(rows).toEqual([
      {
        transaction_id: "tx-same-id",
        canonical_type: "message_purchase",
        raw_status: "settled",
        gross_amount_mills: "17000",
        creator_net_amount_mills: "13600",
        lifetime_net: "0",
      },
      {
        transaction_id: "tx-same-id:reversal",
        canonical_type: "refund",
        raw_status: "reversed",
        gross_amount_mills: "-17000",
        creator_net_amount_mills: "-13600",
        lifetime_net: "0",
      },
    ]);
  });

  it("stays disabled unless the apply flag is set", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage("disabled-of");
    await seedProjectedTransaction({
      pageId: page.id,
      transactionId: "tx-disabled",
      fanPlatformUserId: "1000005",
      grossAmountMills: 5_000n,
      creatorNetAmountMills: 4_000n,
      eventStatus: "pending",
      occurredAt: new Date("2026-06-19T12:00:00.000Z"),
    });

    const disabledContext = createTestAppContext(testDb, {
      ofapiSpendProjectionShadowEnabled: true,
      ofapiSpendTransactionIngestEnabled: false,
    });
    expect(await applyOfapiSpendProjectionTransactions(disabledContext)).toBe(0);

    const { rows } = await testDb.pool.query("select count(*)::int as count from transactions");
    expect(rows).toEqual([{ count: 0 }]);
  });
});

describe("OFAPI REST transactions backfill", () => {
  it("dedupes against webhook truth and rebuilds revenue plus lifetime spend", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("rest-dedupe-of", "acct_rest_dedupe");
    const occurredAt = new Date("2026-06-26T22:36:00.000Z");
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "rest-tx-1",
      rawType: "ofapi:message",
      canonicalType: "message_purchase",
      transactionState: "pending",
      rawStatus: "pending",
      grossAmountMills: 12_000n,
      sourceDestinationAmountMills: 12_000n,
      creatorNetAmountMills: 9_600n,
      senderId: "fan-rest-1",
      occurredAt,
    });

    appContext = {
      ...appContext,
      ofapi: fakeOfapiTransactionsClient({
        rowsByAccount: new Map([[
          "acct_rest_dedupe",
          [{
            id: "rest-tx-1",
            type: "message",
            status: "done",
            amount: "45.00",
            net: "36.00",
            createdAt: "2026-06-26T22:36:00+00:00",
            user: { id: "fan-rest-1" },
          }],
        ]]),
      }),
    };

    const result = await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
      mode: "write",
    });

    expect(result.pages[0]).toMatchObject({
      status: "written",
      rawRows: 1,
      normalizedRows: 1,
      writtenRows: 1,
    });

    const { rows } = await testDb.pool.query<{
      transaction_count: number;
      raw_type: string;
      transaction_state: string;
      raw_status: string;
      gross_amount_mills: string;
      creator_net_amount_mills: string;
      fan_platform_user_id: string;
      lifetime_net: string;
      revenue_count: number;
      revenue_net: string;
    }>(`
      select count(*) over ()::int as transaction_count,
             t.raw_type,
             t.transaction_state,
             t.raw_status,
             t.gross_amount_mills::text,
             t.creator_net_amount_mills::text,
             f.platform_user_id as fan_platform_user_id,
             coalesce(slp.creator_net_amount_mills, 0)::text as lifetime_net,
             coalesce(rd.transaction_count, 0)::int as revenue_count,
             coalesce(rd.creator_net_amount_mills, 0)::text as revenue_net
      from transactions t
      join fans f on f.id = t.fan_id
      left join fan_spend_lifetime slp
        on slp.platform_account_id = t.platform_account_id
       and slp.fan_id = t.fan_id
      left join revenue_daily rd
        on rd.platform_account_id = t.platform_account_id
       and rd.business_date = '2026-06-26'::date
       and rd.canonical_type = 'message_purchase'
       and rd.transaction_state = 'posted'
      where t.platform_account_id = $1
        and t.transaction_id = 'rest-tx-1'
    `, [page.id]);

    // Audit B2: the REST backfill writes the canonical `ofapi:<category>` rawType
    // — identical to the webhook ingest path — so re-running over a webhook row
    // converges in place instead of flipping it to a divergent `ofapi:rest:*`.
    expect(rows).toEqual([{
      transaction_count: 1,
      raw_type: "ofapi:message",
      transaction_state: "posted",
      raw_status: "settled",
      gross_amount_mills: "45000",
      creator_net_amount_mills: "36000",
      fan_platform_user_id: "fan-rest-1",
      lifetime_net: "36000",
      revenue_count: 1,
      revenue_net: "36000",
    }]);
  });

  it("does not let a stale REST pending row demote already-settled webhook truth", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("rest-no-demote-of", "acct_rest_no_demote");
    const occurredAt = new Date("2026-06-26T22:36:00.000Z");
    // Webhook ingest already promoted this transaction to settled/posted.
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "keep-settled",
      rawType: "ofapi:message",
      canonicalType: "message_purchase",
      transactionState: "posted",
      rawStatus: "settled",
      grossAmountMills: 45_000n,
      sourceDestinationAmountMills: 45_000n,
      creatorNetAmountMills: 36_000n,
      senderId: "fan-keep",
      occurredAt,
    });

    // REST backfill re-reads the same transaction as stale loading/pending.
    appContext = {
      ...appContext,
      ofapi: fakeOfapiTransactionsClient({
        rowsByAccount: new Map([[
          "acct_rest_no_demote",
          [{
            id: "keep-settled",
            type: "message",
            status: "loading",
            amount: "45.00",
            net: "36.00",
            createdAt: "2026-06-26T22:36:00+00:00",
            user: { id: "fan-keep" },
          }],
        ]]),
      }),
    };

    const result = await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
      mode: "write",
    });

    // The pending row is a no-op: it is normalized but not written, and terminal
    // truth is preserved.
    expect(result.pages[0]).toMatchObject({
      status: "written",
      normalizedRows: 1,
      writtenRows: 0,
    });

    const { rows } = await testDb.pool.query<{
      transaction_state: string;
      raw_status: string;
      gross_amount_mills: string;
      creator_net_amount_mills: string;
    }>(
      "select transaction_state, raw_status, gross_amount_mills::text, creator_net_amount_mills::text from transactions where platform_account_id = $1 and transaction_id = 'keep-settled'",
      [page.id],
    );
    expect(rows).toEqual([{
      transaction_state: "posted",
      raw_status: "settled",
      gross_amount_mills: "45000",
      creator_net_amount_mills: "36000",
    }]);
  });

  it("keeps the settled state when a batch carries both settled and pending rows for one id", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("rest-batch-settle-of", "acct_rest_batch_settle");
    appContext = {
      ...appContext,
      ofapi: fakeOfapiTransactionsClient({
        rowsByAccount: new Map([[
          "acct_rest_batch_settle",
          [
            // Settled row appears BEFORE the stale pending duplicate: without the
            // intra-batch guard, the later pending upsert would demote it.
            { id: "dup", type: "message", status: "done", amount: "45.00", net: "36.00", createdAt: "2026-06-10T00:00:00+00:00", user: { id: "fan-dup" } },
            { id: "dup", type: "message", status: "loading", amount: "45.00", net: "36.00", createdAt: "2026-06-10T00:00:00+00:00", user: { id: "fan-dup" } },
          ],
        ]]),
      }),
    };

    await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
      mode: "write",
    });

    const { rows } = await testDb.pool.query<{ transaction_state: string; raw_status: string }>(
      "select transaction_state, raw_status from transactions where platform_account_id = $1 and transaction_id = 'dup'",
      [page.id],
    );
    expect(rows).toEqual([{ transaction_state: "posted", raw_status: "settled" }]);
  });

  it("does not early-stop on the first page (unproven order) even when it crosses the window end", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("rest-firstpage-of", "acct_rest_firstpage");
    const calls: Array<{ marker: string | null }> = [];
    appContext = {
      ...appContext,
      ofapi: pagedOfapiTransactionsClient({
        calls,
        pages: [
          {
            // First page is descending and its first row is already after `to`.
            // With no prior page, ascending order is unproven, so the after_window
            // row must NOT trigger an early-stop.
            nextMarker: "m1",
            items: [
              { id: "a", type: "tip", status: "done", amount: "1.00", net: "1.00", createdAt: "2026-06-20T00:00:00+00:00", user: { id: "fan-a" } },
              { id: "b", type: "tip", status: "done", amount: "1.00", net: "1.00", createdAt: "2026-06-12T00:00:00+00:00", user: { id: "fan-b" } },
              { id: "c", type: "tip", status: "done", amount: "1.00", net: "1.00", createdAt: "2026-06-05T00:00:00+00:00", user: { id: "fan-c" } },
            ],
          },
          {
            nextMarker: null,
            items: [
              { id: "d", type: "tip", status: "done", amount: "1.00", net: "1.00", createdAt: "2026-06-08T00:00:00+00:00", user: { id: "fan-d" } },
              { id: "e", type: "tip", status: "done", amount: "1.00", net: "1.00", createdAt: "2026-06-03T00:00:00+00:00", user: { id: "fan-e" } },
            ],
          },
        ],
      }),
    };

    const result = await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-06-15T00:00:00.000Z"),
      mode: "dry-run",
    });

    // Both pages fetched; the second page's in-window rows (06-08, 06-03) that a
    // first-page early-stop would have dropped are captured alongside page 1's
    // in-window rows (06-12, 06-05). Only 06-20 is after_window.
    expect(calls).toHaveLength(2);
    expect(result.pages[0]).toMatchObject({
      apiPages: 2,
      normalizedRows: 4,
      paginationStopReason: "completed",
    });
    expect(result.pages[0]?.skippedReasons).toMatchObject({ after_window: 1 });
  });

  it("does not early-stop when the feed is not ascending, so no in-window row is lost", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("rest-misorder-of", "acct_rest_misorder");
    const calls: Array<{ marker: string | null }> = [];
    appContext = {
      ...appContext,
      ofapi: pagedOfapiTransactionsClient({
        calls,
        pages: [
          {
            nextMarker: "m1",
            items: [
              { id: "a", type: "tip", status: "done", amount: "1.00", net: "1.00", createdAt: "2026-06-05T00:00:00+00:00", user: { id: "fan-a" } },
              { id: "b", type: "tip", status: "done", amount: "1.00", net: "1.00", createdAt: "2026-06-10T00:00:00+00:00", user: { id: "fan-b" } },
            ],
          },
          {
            // Goes backwards (06-08 < prior max 06-10) AND crosses `to` (06-20).
            // A naive early-stop here would drop the later in-window row below.
            nextMarker: "m2",
            items: [
              { id: "c", type: "tip", status: "done", amount: "1.00", net: "1.00", createdAt: "2026-06-08T00:00:00+00:00", user: { id: "fan-c" } },
              { id: "d", type: "tip", status: "done", amount: "1.00", net: "1.00", createdAt: "2026-06-20T00:00:00+00:00", user: { id: "fan-d" } },
            ],
          },
          {
            nextMarker: null,
            items: [
              { id: "e", type: "tip", status: "done", amount: "1.00", net: "1.00", createdAt: "2026-06-12T00:00:00+00:00", user: { id: "fan-e" } },
            ],
          },
        ],
      }),
    };

    const result = await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-06-15T00:00:00.000Z"),
      mode: "dry-run",
    });

    // All three pages are read (no early-stop), so the in-window 06-12 row that a
    // naive early-stop would have skipped is captured: a=06-05, b=06-10, c=06-08,
    // e=06-12 (d=06-20 is after_window).
    expect(calls).toHaveLength(3);
    expect(result.pages[0]).toMatchObject({
      apiPages: 3,
      normalizedRows: 4,
      paginationStopReason: "completed",
    });
    expect(result.pages[0]?.skippedReasons).toMatchObject({ after_window: 1 });
  });

  it("blocks pages with direct credentials or active non-OFAPI truth rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const credentialed = await seedOfapiPage("rest-creds-of", "acct_rest_creds");
    await storePlatformCredentials(appContext.db, {
      platformAccountId: credentialed.id,
      encryptedSession: "encrypted",
      keyVersion: 1,
    });

    const direct = await seedOfapiPage("rest-direct-of", "acct_rest_direct");
    await upsertTransaction(appContext.db, {
      platformAccountId: direct.id,
      source: "onlymonster",
      transactionId: "direct-tx-1",
      rawType: "message",
      canonicalType: "message_purchase",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 10_000n,
      sourceDestinationAmountMills: 10_000n,
      creatorNetAmountMills: 8_000n,
      senderId: "direct-fan",
      occurredAt: new Date("2026-06-10T12:00:00.000Z"),
    });

    const calls: Array<{ accountId: string; marker: string | null }> = [];
    appContext = {
      ...appContext,
      ofapi: fakeOfapiTransactionsClient({
        rowsByAccount: new Map(),
        calls,
      }),
    };

    const result = await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [credentialed.label, direct.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
      mode: "write",
    });

    expect(calls).toEqual([]);
    expect(result.pages.map((page) => ({
      label: page.pageLabel,
      status: page.status,
      reason: page.reason,
    }))).toEqual([
      { label: "rest-creds-of", status: "blocked", reason: "has_page_credentials" },
      { label: "rest-direct-of", status: "blocked", reason: "active_non_ofapi_transactions" },
    ]);
  });

  it("keeps same-id REST reversals separate from settled spend", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("rest-reversal-of", "acct_rest_reversal");
    appContext = {
      ...appContext,
      ofapi: fakeOfapiTransactionsClient({
        rowsByAccount: new Map([[
          "acct_rest_reversal",
          [
            {
              id: "same-id",
              type: "message",
              status: "done",
              amount: "50.00",
              net: "40.00",
              createdAt: "2026-06-20T10:00:00+00:00",
              user: { id: "fan-rest-2" },
            },
            {
              id: "same-id",
              type: "message",
              status: "refunded",
              amount: "50.00",
              net: "40.00",
              createdAt: "2026-06-21T10:00:00+00:00",
              user: { id: "fan-rest-2" },
            },
          ],
        ]]),
      }),
    };

    await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
      mode: "write",
    });

    const { rows } = await testDb.pool.query<{
      transaction_id: string;
      canonical_type: string;
      creator_net_amount_mills: string;
      lifetime_net: string;
    }>(`
      select t.transaction_id,
             t.canonical_type,
             t.creator_net_amount_mills::text,
             coalesce(slp.creator_net_amount_mills, 0)::text as lifetime_net
      from transactions t
      left join fan_spend_lifetime slp
        on slp.platform_account_id = t.platform_account_id
       and slp.fan_id = t.fan_id
      where t.platform_account_id = $1
      order by t.transaction_id
    `, [page.id]);

    expect(rows).toEqual([
      {
        transaction_id: "same-id",
        canonical_type: "message_purchase",
        creator_net_amount_mills: "40000",
        lifetime_net: "0",
      },
      {
        transaction_id: "same-id:reversal",
        canonical_type: "refund",
        creator_net_amount_mills: "-40000",
        lifetime_net: "0",
      },
    ]);
  });

  it("stops paginating once the ascending feed crosses the upper bound", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("rest-paging-of", "acct_rest_paging");
    const calls: Array<{ marker: string | null }> = [];
    appContext = {
      ...appContext,
      ofapi: pagedOfapiTransactionsClient({
        calls,
        pages: [
          {
            nextMarker: "m1",
            items: [
              { id: "p0-a", type: "tip", status: "done", amount: "10.00", net: "8.00", createdAt: "2026-06-02T00:00:00+00:00", user: { id: "fan-1" } },
              { id: "p0-b", type: "tip", status: "done", amount: "10.00", net: "8.00", createdAt: "2026-06-05T00:00:00+00:00", user: { id: "fan-2" } },
            ],
          },
          {
            nextMarker: "m2",
            items: [
              { id: "p1-a", type: "tip", status: "done", amount: "10.00", net: "8.00", createdAt: "2026-06-10T00:00:00+00:00", user: { id: "fan-3" } },
              // First row at/after `to`: the ascending feed has crossed the window.
              { id: "p1-b", type: "tip", status: "done", amount: "10.00", net: "8.00", createdAt: "2026-06-20T00:00:00+00:00", user: { id: "fan-4" } },
            ],
          },
          {
            // Entirely past `to` — must never be requested (would cost credits).
            nextMarker: "m3",
            items: [
              { id: "p2-a", type: "tip", status: "done", amount: "99.00", net: "80.00", createdAt: "2026-06-25T00:00:00+00:00", user: { id: "fan-5" } },
            ],
          },
        ],
      }),
    };

    const result = await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-06-15T00:00:00.000Z"),
      mode: "dry-run",
    });

    // Page 0 and the boundary page 1 are fetched; the all-future page 2 is not.
    expect(calls).toEqual([{ marker: null }, { marker: "m1" }]);
    expect(result.pages[0]).toMatchObject({
      status: "dry_run",
      apiPages: 2,
      rawRows: 4,
      normalizedRows: 3,
      paginationStopReason: "reached_window_end",
    });
    expect(result.pages[0]?.skippedReasons).toMatchObject({ after_window: 1 });
  });

  it("caps the paginated walk and reports truncation when no upper bound stops it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("rest-cap-of", "acct_rest_cap");
    const calls: Array<{ marker: string | null }> = [];
    // An always-has-next feed with no `to`: only the page cap can stop it.
    appContext = {
      ...appContext,
      ofapi: pagedOfapiTransactionsClient({
        calls,
        pages: Array.from({ length: 10 }, (_unused, index) => ({
          nextMarker: `m${index + 1}`,
          items: [{
            id: `cap-${index}`,
            type: "tip",
            status: "done",
            amount: "1.00",
            net: "1.00",
            createdAt: "2026-06-05T00:00:00+00:00",
            user: { id: `fan-${index}` },
          }],
        })),
      }),
    };

    const result = await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: null,
      mode: "dry-run",
      maxApiPages: 3,
    });

    expect(calls).toHaveLength(3);
    expect(result.pages[0]).toMatchObject({
      apiPages: 3,
      paginationStopReason: "page_cap",
    });
  });

  it("blocks --write when spend transaction ingest is disabled and makes no API calls", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("rest-gated-of", "acct_rest_gated");
    const calls: Array<{ accountId: string; marker: string | null }> = [];
    const disabledContext = {
      ...createTestAppContext(testDb, {
        ofapiSpendProjectionShadowEnabled: true,
        ofapiSpendTransactionIngestEnabled: false,
      }),
      ofapi: fakeOfapiTransactionsClient({
        rowsByAccount: new Map([[
          "acct_rest_gated",
          [{ id: "gated-tx", type: "message", status: "done", amount: "20.00", net: "16.00", createdAt: "2026-06-10T00:00:00+00:00", user: { id: "fan-gated" } }],
        ]]),
        calls,
      }),
    };

    const result = await runOfapiTransactionsBackfill(disabledContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
      mode: "write",
    });

    expect(calls).toEqual([]);
    expect(result.pages.map((row) => ({ status: row.status, reason: row.reason }))).toEqual([
      { status: "blocked", reason: "ingest_disabled" },
    ]);

    const { rows } = await testDb.pool.query("select count(*)::int as count from transactions");
    expect(rows).toEqual([{ count: 0 }]);
  });

  it("blocks a page that becomes ineligible in-lock without aborting the batch", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const db = appContext.db;
    const blockedPage = await seedOfapiPage("rest-toctou-of", "acct_rest_toctou");
    const okPage = await seedOfapiPage("rest-ok-of", "acct_rest_ok");

    appContext = {
      ...appContext,
      ofapi: fakeOfapiTransactionsClient({
        rowsByAccount: new Map([
          ["acct_rest_toctou", [
            { id: "toctou-tx", type: "message", status: "done", amount: "30.00", net: "24.00", createdAt: "2026-06-10T00:00:00+00:00", user: { id: "fan-toctou" } },
          ]],
          ["acct_rest_ok", [
            { id: "ok-tx", type: "message", status: "done", amount: "40.00", net: "32.00", createdAt: "2026-06-12T00:00:00+00:00", user: { id: "fan-ok" } },
          ]],
        ]),
        // TOCTOU race: a non-OFAPI truth row lands for the first page AFTER its
        // pre-fetch eligibility check but before the in-lock re-check.
        onCall: async (accountId) => {
          if (accountId !== "acct_rest_toctou") {
            return;
          }
          await upsertTransaction(db, {
            platformAccountId: blockedPage.id,
            source: "onlymonster",
            transactionId: "manual-toctou",
            rawType: "manual",
            canonicalType: "message_purchase",
            transactionState: "posted",
            rawStatus: "done",
            grossAmountMills: 1_000n,
            sourceDestinationAmountMills: 1_000n,
            creatorNetAmountMills: 800n,
            senderId: "manual-fan",
            occurredAt: new Date("2026-06-11T00:00:00.000Z"),
          });
        },
      }),
    };

    const result = await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [blockedPage.label, okPage.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
      mode: "write",
    });

    expect(result.pages.map((row) => ({
      label: row.pageLabel,
      status: row.status,
      reason: row.reason,
      writtenRows: row.writtenRows,
      hasCredentials: row.hasCredentials,
      activeNonOfapiTransactions: row.activeNonOfapiTransactions,
    }))).toEqual([
      // Blocked page reports the FRESH in-lock count (1), not the stale pre-fetch 0.
      {
        label: "rest-toctou-of",
        status: "blocked",
        reason: "active_non_ofapi_transactions",
        writtenRows: 0,
        hasCredentials: false,
        activeNonOfapiTransactions: 1,
      },
      {
        label: "rest-ok-of",
        status: "written",
        reason: null,
        writtenRows: 1,
        hasCredentials: false,
        activeNonOfapiTransactions: 0,
      },
    ]);

    // The second page was still written even though the first page blocked.
    const { rows } = await testDb.pool.query<{ count: number }>(
      "select count(*)::int as count from transactions where platform_account_id = $1 and transaction_id = 'ok-tx'",
      [okPage.id],
    );
    expect(rows).toEqual([{ count: 1 }]);
  });
});

// Stage 14 (DP 2): backfills run only under the day-budget reservation
// machinery — scope 'backfill', reserve-before-request, settle to _meta actuals.
describe("OFAPI backfill day-budget guard", () => {
  const inWindowRow = (id: string) => ({
    id,
    type: "tip",
    status: "done",
    amount: "1.00",
    net: "1.00",
    createdAt: "2026-06-05T00:00:00+00:00",
    user: { id: `fan-${id}` },
  });

  it("makes zero OFAPI calls when the day budget is already exhausted", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = createTestAppContext(testDb, {
      ofapiSpendProjectionShadowEnabled: true,
      ofapiSpendTransactionIngestEnabled: true,
      ofapiCreditLedgerEnabled: true,
      ofapiBackfillDailyCreditBudget: 2,
    });
    const page = await seedOfapiPage("rest-budget-of", "acct_rest_budget");
    // Fill the backfill day counter to the cap before the run.
    expect(await reserveOfapiDayCredits(appContext.db, {
      scope: "backfill",
      estimate: 2,
      budget: 2,
    })).toBe(true);

    const calls: Array<{ marker: string | null }> = [];
    appContext = {
      ...appContext,
      ofapi: pagedOfapiTransactionsClient({
        calls,
        pages: [{ items: [inWindowRow("a")], nextMarker: null }],
      }),
    };

    const result = await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      mode: "dry-run",
    });

    expect(calls).toHaveLength(0);
    expect(result.pages[0]).toMatchObject({
      apiPages: 0,
      rawRows: 0,
      paginationStopReason: "budget_exhausted",
      budgetBlock: "ofapi_daily_credit_budget",
    });
  });

  it("stops the walk mid-pagination on budget exhaustion and keeps fetched rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = createTestAppContext(testDb, {
      ofapiSpendProjectionShadowEnabled: true,
      ofapiSpendTransactionIngestEnabled: true,
      ofapiCreditLedgerEnabled: true,
      ofapiBackfillDailyCreditBudget: 2,
    });
    const page = await seedOfapiPage("rest-budget2-of", "acct_rest_budget2");

    const calls: Array<{ marker: string | null }> = [];
    appContext = {
      ...appContext,
      ofapi: pagedOfapiTransactionsClient({
        calls,
        pages: [
          { items: [inWindowRow("a")], nextMarker: "m1" },
          { items: [inWindowRow("b")], nextMarker: "m2" },
          { items: [inWindowRow("c")], nextMarker: null },
        ],
      }),
    };

    const result = await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      mode: "dry-run",
    });

    // Budget 2 admits exactly two reserve-fetch rounds; the third reservation
    // refuses. The two fetched pages' rows survive in the report.
    expect(calls).toHaveLength(2);
    expect(result.pages[0]).toMatchObject({
      apiPages: 2,
      normalizedRows: 2,
      paginationStopReason: "budget_exhausted",
      budgetBlock: "ofapi_daily_credit_budget",
    });
  });

  it("settles the backfill day counter to the _meta-reported actuals", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = createTestAppContext(testDb, {
      ofapiSpendProjectionShadowEnabled: true,
      ofapiSpendTransactionIngestEnabled: true,
      ofapiCreditLedgerEnabled: true,
      ofapiBackfillDailyCreditBudget: 50,
    });
    const page = await seedOfapiPage("rest-budget3-of", "acct_rest_budget3");

    const calls: Array<{ marker: string | null }> = [];
    appContext = {
      ...appContext,
      ofapi: pagedOfapiTransactionsClient({
        calls,
        pages: [{
          items: [inWindowRow("a")],
          nextMarker: null,
          meta: { creditsUsed: 3, creditBalance: 997, isCached: false, rateRemainingMinute: null },
        }],
      }),
    };

    await runOfapiTransactionsBackfill(appContext, {
      pageLabels: [page.label],
      from: new Date("2026-06-01T00:00:00.000Z"),
      mode: "dry-run",
    });

    // Reserve 1 (estimate) then settle +2 (actual 3 − estimate 1): the scope's
    // dedicated counter ends at the server-reported actuals.
    const { rows } = await testDb.pool.query<{ backfill_spent_credits: number }>(
      "select backfill_spent_credits from ofapi_credit_state where id = 1",
    );
    expect(rows).toEqual([{ backfill_spent_credits: 3 }]);
  });
});
