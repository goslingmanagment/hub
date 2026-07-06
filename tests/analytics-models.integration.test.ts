import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  rebuildRevenueRollups,
  upsertFans,
  upsertTransaction,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;

// Kernel Stage 28 Task 3: the metrics models are INDEPENDENT recomputations
// from the ledger — the reconciliation against the report-serving rollups is
// the exit gate Stage 33's serving swap rides on. Tolerance: exact.

async function runModel(name: string) {
  const sql = await readFile(join(__dirname, "..", "analytics", "models", `${name}.sql`), "utf8");
  await testDb!.pool.query(`drop table if exists analytics_${name}`);
  await testDb!.pool.query(sql);
}

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
});

describe("analytics models (Stage 28)", () => {
  it("net_revenue_daily reconciles EXACTLY with the revenue_daily rollups", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, { slug: "lana", name: "Lana" });
    const page = await createOnlyFansPage(testDb.db, { modelId: model.id, label: "lana-of" });
    const [fan] = await upsertFans(testDb.db, [{
      platform: "onlyfans",
      platformUserId: "f-1",
      username: "fan1",
    }]);

    const seed = [
      { id: "t-1", type: "tip", gross: 10_000n, net: 8_000n, at: "2026-03-05T10:00:00.000Z" },
      { id: "t-2", type: "subscription", gross: 5_000n, net: 4_000n, at: "2026-03-05T12:00:00.000Z" },
      { id: "t-3", type: "tip", gross: 2_000n, net: 1_600n, at: "2026-03-06T09:00:00.000Z" },
      // A chargeback: negative amounts, still reportable.
      { id: "t-4", type: "chargeback", gross: -2_000n, net: -1_600n, at: "2026-03-07T09:00:00.000Z" },
    ] as const;
    for (const txn of seed) {
      await upsertTransaction(testDb.db, {
        platformAccountId: page.id,
        source: "ofapi:webhook",
        fanId: fan!.id,
        transactionId: txn.id,
        correlationAccountId: "f-1",
        rawType: txn.type,
        canonicalType: txn.type,
        transactionState: "posted",
        rawStatus: "ok",
        grossAmountMills: txn.gross,
        sourceDestinationAmountMills: txn.gross,
        creatorNetAmountMills: txn.net,
        occurredAt: new Date(txn.at),
      });
    }
    await rebuildRevenueRollups(testDb.db, page.id);

    await runModel("net_revenue_daily");

    const { rows: reconciliation } = await testDb.pool.query(`
      with rollup as (
        select business_date, sum(creator_net_amount_mills)::bigint as net,
               sum(transaction_count)::int as txns
        from revenue_daily group by 1
      ), model as (
        select business_date, sum(net_amount_mills)::bigint as net,
               sum(transaction_count)::int as txns
        from analytics_net_revenue_daily group by 1
      )
      select coalesce(r.business_date, m.business_date) as business_date,
             r.net as rollup_net, m.net as model_net,
             r.txns as rollup_txns, m.txns as model_txns
      from rollup r full outer join model m using (business_date)
      order by 1
    `);
    expect(reconciliation.length).toBeGreaterThan(0);
    for (const row of reconciliation) {
      expect(row.model_net, String(row.business_date)).toBe(row.rollup_net);
      expect(row.model_txns, String(row.business_date)).toBe(row.rollup_txns);
    }

    const { rows: modelRows } = await testDb.pool.query(
      `select model_slug, page_label, sum(net_amount_mills)::bigint as net
       from analytics_net_revenue_daily group by 1, 2`,
    );
    expect(modelRows[0]).toMatchObject({ model_slug: "lana", page_label: "lana-of" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fan_ltv nets reversals against lifetime value", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, { slug: "lana", name: "Lana" });
    const page = await createOnlyFansPage(testDb.db, { modelId: model.id, label: "lana-of" });
    const [fan] = await upsertFans(testDb.db, [{
      platform: "onlyfans",
      platformUserId: "f-2",
      username: "whale",
    }]);
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "ofapi:webhook",
      fanId: fan!.id,
      transactionId: "ltv-1",
      correlationAccountId: "f-2",
      rawType: "tip",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "ok",
      grossAmountMills: 50_000n,
      sourceDestinationAmountMills: 50_000n,
      creatorNetAmountMills: 40_000n,
      occurredAt: new Date("2026-04-01T10:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "ofapi:webhook",
      fanId: fan!.id,
      transactionId: "ltv-2",
      correlationAccountId: "f-2",
      rawType: "chargeback",
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: "ok",
      grossAmountMills: -10_000n,
      sourceDestinationAmountMills: -10_000n,
      creatorNetAmountMills: -8_000n,
      occurredAt: new Date("2026-04-02T10:00:00.000Z"),
    });

    await runModel("fan_ltv");

    const { rows } = await testDb.pool.query(
      `select platform_user_id, transaction_count, ltv_net_mills::bigint as ltv
       from analytics_fan_ltv`,
    );
    expect(rows).toEqual([{ platform_user_id: "f-2", transaction_count: 2, ltv: 32000n }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("response_sla measures fan-message → own-reply latency per day", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, { slug: "lana", name: "Lana" });
    const page = await createOnlyFansPage(testDb.db, { modelId: model.id, label: "lana-of" });
    const rows = [
      { ref: "m-1", mine: false, at: "2026-05-01T10:00:00.000Z" },
      { ref: "m-2", mine: true, at: "2026-05-01T10:10:00.000Z" }, // 10-min reply
      { ref: "m-3", mine: false, at: "2026-05-01T11:00:00.000Z" }, // never answered
    ];
    for (const row of rows) {
      await testDb.pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref,
                                      fan_native_id, sender_role, is_sent_by_me, occurred_at,
                                      text_plain, tip_amount_mills, is_tip, backfill_source)
         values ($1, 'onlyfans', 'conv-sla', $2, 'f-3', $3, $4, $5, 'x', 0, false, 'hot_table')`,
        [page.id, row.ref, row.mine ? "model" : "fan", row.mine, row.at],
      );
    }

    await runModel("response_sla");

    const { rows: sla } = await testDb.pool.query(
      `select fan_messages, replied, round(median_response_minutes::numeric, 1)::float as median
       from analytics_response_sla where account_id = $1`,
      [page.id],
    );
    expect(sla).toEqual([{ fan_messages: 2, replied: 1, median: 10 }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
