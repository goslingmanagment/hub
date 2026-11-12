import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, dismissCustomSale, findMatterByKey, upsertTransaction } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { runCustomOrderChecks } from "../apps/runtime/src/services/custom-orders/checks.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Заказ кастома, the check «похоже на кастом без заказа» (final review, round 2): its matter closed itself a week
// after the sale though nothing had happened — the sale only left the window the pass looks for new sales in. Only
// an order or «не кастом» closes it. Every name and number is made up.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SOLD_AT = new Date("2026-11-01T12:00:00Z");
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let fanId = 0;
let ownerId = 0;

/** A tip of the fan with a note that speaks of a custom; answers the sale's id. */
async function customTip(name: string): Promise<number> {
  await upsertTransaction(app.db, {
    platformAccountId: pageId, source: "fansly:rest", fanId, transactionId: name, correlationId: `tip-${name}`, rawType: "7001",
    canonicalType: "tip", transactionState: "posted", rawStatus: "ok", grossAmountMills: 50_000n,
    sourceDestinationAmountMills: 50_000n, creatorNetAmountMills: 40_000n, occurredAt: SOLD_AT,
  });
  await testDb!.pool.query(
    `insert into transaction_tip_contexts (account_id, platform, platform_tip_id, captured_conversation_ref, tip_message_text,
       tip_message_captured_at, tip_amount_mills, occurred_at, sender_platform_user_id, captured_at, provenance)
     values ($1, 'fansly', $2, 'conv-7500000001', 'for my custom video', $3, 50000, $3, '7500000001', $3, 'fansly_dm_tip_sidecar')`,
    [pageId, `tip-${name}`, SOLD_AT.toISOString()],
  );
  return Number((await testDb!.pool.query<{ id: string }>("select id from transactions where transaction_id = $1", [name])).rows[0]!.id);
}

const matterOf = async (sale: number) => {
  const matter = await findMatterByKey(app.db, `custom.unrecorded:${sale}`);
  return matter === null ? null : { state: matter.state, closedHow: matter.closedHow };
};

describe("custom checks: a sale that looks like a custom with no order", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-secret" }, { source: "cli" });
    ownerId = await fixtureUserId(app, "boss");
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "lora-1" }))!.id;
    fanId = Number((await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username) values ('fansly', '7500000001', 'fan_tipper') returning id",
    )).rows[0]!.id);
    await testDb.pool.query("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [fanId, pageId]);
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("keeps its matter open until the sale has an order or is «не кастом», and says how it closed", async (context) => {
    if (!testDb) return context.skip();
    const waits = await customTip("tip-waits");
    const notCustom = await customTip("tip-not-custom");
    const recorded = await customTip("tip-recorded");
    const refunded = await customTip("tip-refunded");
    const all = [waits, notCustom, recorded, refunded];

    // A day after the sale and no order: one matter per sale, for whoever leads customs.
    await runCustomOrderChecks(app, new Date(SOLD_AT.getTime() + 30 * HOUR));
    for (const sale of all) expect(await matterOf(sale), `sale ${sale}`).toEqual({ state: "open", closedHow: null });

    // Nine days later nothing has happened: the sales are past the week the pass looks for new ones in, and wait still.
    await runCustomOrderChecks(app, new Date(SOLD_AT.getTime() + 9 * DAY));
    for (const sale of all) expect(await matterOf(sale), `sale ${sale} after nine days`).toEqual({ state: "open", closedHow: null });

    // «Не кастом», an order that the sale pays, a refund: each closes its own matter in its own words.
    await dismissCustomSale(app.db, { transactionId: notCustom, userId: ownerId });
    await recordCustomOrder(app, {
      pageId, fanId, buyer: null, conversationRef: null, card: { task: "Ролик по чаевым" }, deadlineOn: null, acceptedByUserId: ownerId,
      origin: "workboard", paymentTransactionId: recorded, actor: { door: "workboard", userId: ownerId }, now: new Date(SOLD_AT.getTime() + 9 * DAY + HOUR),
    });
    await testDb.pool.query("update transactions set is_active = false where id = $1", [refunded]);
    await runCustomOrderChecks(app, new Date(SOLD_AT.getTime() + 10 * DAY));
    expect(await matterOf(waits)).toEqual({ state: "open", closedHow: null });
    expect(await matterOf(notCustom)).toEqual({ state: "closed", closedHow: "withdrawn" });
    expect(await matterOf(recorded)).toEqual({ state: "closed", closedHow: "resolved" });
    expect(await matterOf(refunded)).toEqual({ state: "closed", closedHow: "cause_gone" });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
