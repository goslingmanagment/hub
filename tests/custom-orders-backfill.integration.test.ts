import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { customOrdersBackfillFileSchema, runCustomOrdersBackfill } from "../apps/runtime/src/services/custom-orders/backfill.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Customs facts (slice 5), the one-off backfill's money: the sales it names are checked as the agent's are — another
// fan's sale is not linked — and a second run links nothing twice. Every name and number here is invented.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
const fans: Record<string, number> = {};
const sales: Record<string, number> = {};
let orderId = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const payments = async () => (await q("select transaction_id::int as id from custom_order_payments where order_id = $1 order by transaction_id", [orderId])).rows;
const events = async () => Number((await q("select count(*)::int as n from object_events where object_type = 'custom_order' and object_id = $1", [String(orderId)])).rows[0].n);

describe("custom orders: the one-off backfill's sales", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    const model = await createModel(app.db, { slug: "mira", name: "Mira" });
    const pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "mira-1" }))!.id;
    for (const [key, ref] of [["a", "7500000101"], ["b", "7500000102"]] as const) {
      fans[key] = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', $1, $2) returning id", [ref, `fan_${key}`])).rows[0].id);
      await q("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [fans[key], pageId]);
    }
    for (const [key, fanKey] of [["own", "a"], ["foreign", "b"]] as const) {
      sales[key] = Number((await q(
        `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
           gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
         values ($1, $2, $3, 'tip', 'tip'::transaction_type, 'posted', 'ok', 50000, 50000, 40000, now() - interval '2 hours', 'fansly:rest', 'USD') returning id`,
        [pageId, fans[fanKey], `tx-${key}`],
      )).rows[0].id);
    }
    // An order recorded with neither page nor fan: the backfill names them.
    orderId = await recordCustomOrder(app, {
      pageId: null, fanId: null, buyer: "a fan by name", conversationRef: null, card: { task: "Ролик" }, deadlineOn: null,
      acceptedByUserId: null, origin: "agent", actor: { door: "system" }, createdAt: new Date(Date.now() - 3 * 3_600_000),
    });
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("links only the order's fan's sale, writes nothing without --apply, and a second run links nothing twice", async (context) => {
    if (!testDb) return context.skip();
    const file = customOrdersBackfillFileSchema.parse({
      version: 1,
      orders: {
        [`K-${orderId}`]: {
          pageLabel: "mira-1", fanRef: "7500000101", priceMills: 100_000,
          sales: [{ saleRef: String(sales.own) }, { saleRef: String(sales.foreign) }, { pageLabel: "mira-1", transactionRef: "tx-own" }],
        },
      },
    });
    const outcomes = async (apply: boolean) => (await runCustomOrdersBackfill(app, file, { apply }))[0]!.lines
      .map((line) => [line.what, line.outcome, line.reason]);

    // The dry run: what it would do, and the other fan's sale refused; nothing written.
    expect(await outcomes(false)).toEqual([
      ["fan", "would", null], ["price", "would", null], ["sale", "would", null], ["sale", "refused", "other_fan"], ["sale", "would", null],
    ]);
    expect(await payments()).toEqual([]);
    expect(await events()).toBe(1);

    // Applied: the fan, the price, the order's fan's sale once (named twice, by Hub's id and by the platform's); never the other fan's.
    expect(await outcomes(true)).toEqual([
      ["fan", "done", null], ["price", "done", null], ["sale", "done", null], ["sale", "refused", "other_fan"], ["sale", "already", null],
    ]);
    expect(await payments()).toEqual([{ id: sales.own }]);
    const written = await events();

    // Again: nothing new.
    expect(await outcomes(true)).toEqual([
      ["fan", "already", null], ["price", "already", null], ["sale", "already", null], ["sale", "refused", "other_fan"], ["sale", "already", null],
    ]);
    expect(await payments()).toEqual([{ id: sales.own }]);
    expect(await events()).toBe(written);
    const order = (await q("select state, fan_id::int as fan, price_mills::int as price from custom_orders where id = $1", [orderId])).rows[0];
    expect(order).toEqual({ state: "paid", fan: fans.a, price: 100_000 });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
