import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  summarizeOfapiSpendProjectionComparison,
  upsertOfapiSpendProjectionEvent,
  upsertTransaction,
} from "@agency_hub_core/db";

import { applyOfapiSpendProjectionTransactions } from "../apps/runtime/src/services/ofapi-spend-transaction-ingest.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
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
  return createOnlyFansPage(appContext.db, { modelId: model.id, label });
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

  it("keeps pending out of truth and updates terminal state transitions", async (context) => {
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

    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(0);

    let count = await testDb.pool.query<{ count: number }>(
      "select count(*)::int as count from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(count.rows).toEqual([{ count: 0 }]);

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
