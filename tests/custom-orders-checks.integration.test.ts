import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { customOrdersBoardResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, findMatterByKey, upsertTransaction } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { runCustomOrderChecks } from "../apps/runtime/src/services/custom-orders/checks.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Заказ кастома, the check «похоже на кастом без заказа» (final review, round 2): its matter closed itself a week
// after the sale though nothing had happened — the sale only left the window the pass looks for new sales in. Only
// an order or «не кастом» closes it, and the board takes both on such a sale whatever its day. A matter that rule
// had closed that way before it was mended (cause gone, the sale still waiting) opens again. Every name and number
// is made up.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Long ago: past the week the pass and the board look for new sales in, and past the board's month of payments. */
const SOLD_AT = new Date(Date.now() - 70 * DAY);
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let cookie = "";
let pageId = 0;
let fanId = 0;

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
const post = (url: string, payload?: Record<string, unknown>) => server!.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });

describe("custom checks: a sale that looks like a custom with no order", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-secret" }, { source: "cli" });
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "lora-1" }))!.id;
    fanId = Number((await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username) values ('fansly', '7500000001', 'fan_tipper') returning id",
    )).rows[0]!.id);
    await testDb.pool.query("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [fanId, pageId]);
    server = await buildApiServer(app);
    await server.ready();
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "boss", password: "boss-secret" } });
    expect(login.statusCode, login.body).toBe(200);
    const header = login.headers["set-cookie"];
    cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("keeps its matter open until the sale has an order or is «не кастом», and says how it closed", async (context) => {
    if (!testDb || !server) return context.skip();
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

    // Ten weeks later the board still lists them, where the matter's link leads…
    const board = customOrdersBoardResponseSchema.parse((await server.inject({ method: "GET", url: "/api/v1/custom-orders", headers: { cookie } })).json());
    expect(board.lookalikes.map((sale) => Number(sale.transactionRef)).sort()).toEqual([...all].sort());
    // …and takes «Не кастом» and «Записать» on them; a refund takes the sale itself away.
    const dismissed = await post(`/api/v1/custom-orders/sales/${notCustom}/dismiss`);
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    const written = await post("/api/v1/custom-orders", { transactionRef: String(recorded), card: { task: "Ролик по чаевым" } });
    expect(written.statusCode, written.body).toBe(200);
    await testDb.pool.query("update transactions set is_active = false where id = $1", [refunded]);

    // Each closes its own matter in its own words; the one nothing happened to waits on.
    await runCustomOrderChecks(app, new Date());
    expect(await matterOf(waits)).toEqual({ state: "open", closedHow: null });
    expect(await matterOf(notCustom)).toEqual({ state: "closed", closedHow: "withdrawn" });
    expect(await matterOf(recorded)).toEqual({ state: "closed", closedHow: "resolved" });
    expect(await matterOf(refunded)).toEqual({ state: "closed", closedHow: "cause_gone" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("opens again a matter closed as «cause gone» whose sale still waits, and no other", async (context) => {
    if (!testDb || !server) return context.skip();
    const lost = await customTip("tip-lost");
    const refunded = await customTip("tip-lost-refunded");
    const recorded = await customTip("tip-lost-recorded");
    const notCustom = await customTip("tip-lost-not-custom");
    const all = [lost, refunded, recorded, notCustom];
    await runCustomOrderChecks(app, new Date(SOLD_AT.getTime() + 30 * HOUR));
    for (const sale of all) expect(await matterOf(sale), `sale ${sale}`).toEqual({ state: "open", closedHow: null });

    // One is «не кастом», one has an order, one was refunded; nothing happened to the first.
    const dismissed = await post(`/api/v1/custom-orders/sales/${notCustom}/dismiss`);
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    const written = await post("/api/v1/custom-orders", { transactionRef: String(recorded), card: { task: "Ролик по чаевым" } });
    expect(written.statusCode, written.body).toBe(200);
    await testDb.pool.query("update transactions set is_active = false where id = $1", [refunded]);
    // The rule as it was: a week after the sale it had closed each of these matters as «cause gone», whatever had
    // become of the sale.
    await testDb.pool.query(
      "update matters set state = 'closed', closed_how = 'cause_gone', closed_at = $2::timestamptz where reason_key = any($1::text[])",
      [all.map((sale) => `custom.unrecorded:${sale}`), new Date(SOLD_AT.getTime() + 8 * DAY).toISOString()],
    );
    for (const sale of all) expect(await matterOf(sale), `sale ${sale}`).toEqual({ state: "closed", closedHow: "cause_gone" });

    // The pass looks at the sales of such matters again: the one that still waits is a matter again, the rest stay closed.
    await runCustomOrderChecks(app, new Date());
    expect(await matterOf(lost)).toEqual({ state: "open", closedHow: null });
    for (const sale of [refunded, recorded, notCustom]) expect(await matterOf(sale), `sale ${sale}`).toEqual({ state: "closed", closedHow: "cause_gone" });
    // And the board lists it again, where the matter's link leads.
    const board = customOrdersBoardResponseSchema.parse((await server.inject({ method: "GET", url: "/api/v1/custom-orders", headers: { cookie } })).json());
    expect(board.lookalikes.map((sale) => Number(sale.transactionRef))).toContain(lost);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
