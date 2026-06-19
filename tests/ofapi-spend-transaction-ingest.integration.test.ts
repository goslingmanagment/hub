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
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
  eventStatus: "pending" | "settled";
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
    category: "message",
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

  it("does not overwrite existing mismatched core transactions", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage("vip-of");
    const occurredAt = new Date("2026-06-19T11:00:00.000Z");
    await seedProjectedTransaction({
      pageId: page.id,
      transactionId: "tx-existing",
      fanPlatformUserId: "1000004",
      grossAmountMills: 17_000n,
      creatorNetAmountMills: 13_600n,
      eventStatus: "pending",
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

    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(0);

    const { rows } = await testDb.pool.query<{ gross_amount_mills: string }>(`
      select gross_amount_mills::text
      from transactions
      where platform_account_id = $1
        and transaction_id = 'tx-existing'
    `, [page.id]);
    expect(rows).toEqual([{ gross_amount_mills: "9000" }]);

    const comparison = await summarizeOfapiSpendProjectionComparison(appContext.db, {
      from: new Date("2026-06-19T00:00:00.000Z"),
      to: new Date("2026-06-20T00:00:00.000Z"),
      sampleLimit: 10,
    });
    expect(comparison.map((row) => ({ status: row.status, count: row.count }))).toEqual([
      { status: "amount_mismatch", count: 1 },
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
