import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientFanCardResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, upsertTransaction } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Customs in the fan's record (Chat Memory week 4, week-4.md §1): a custom
// written before Hub had the fan's Fansly thread still finds its delivery once
// the thread syncs, a cancelled custom gives its tip back, and a fan of another
// page is out of reach through this page, like his card.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const VERSION = "chat-extension/0.9.0";
const FAN_REF = "7300000001";
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let token = "";
let pageId = 0;
let fanId = 0;

const headers = () => ({ authorization: `Bearer ${token}`, "x-client-version": VERSION });
const card = async () => {
  const response = await server!.inject({ method: "GET", url: `/api/v1/client/pages/ari-1/fans/${FAN_REF}/card`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200);
  return clientFanCardResponseSchema.parse(response.json());
};
const post = (path: string, payload: object, fanRef = FAN_REF) =>
  server!.inject({ method: "POST", url: `/api/v1/client/pages/ari-1/fans/${fanRef}/customs${path}`, headers: headers(), payload });

async function tip(name: string, mills: bigint, daysAgo: number) {
  await upsertTransaction(app.db, {
    platformAccountId: pageId, source: "fansly:rest", fanId, transactionId: name, rawType: "7001",
    canonicalType: "tip", transactionState: "posted", rawStatus: "ok", grossAmountMills: mills,
    sourceDestinationAmountMills: mills, creatorNetAmountMills: mills * 4n / 5n, occurredAt: new Date(Date.now() - daysAgo * 86_400_000),
  });
}

describe("customs of a fan", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "vanya", role: "chatter" }, { source: "cli" });
    const vanya = await fixtureUserId(app, "vanya");
    await setUserPassword(app, { userId: vanya, password: "vanya-secret" }, { source: "cli" });
    const ari = await createModel(app.db, { slug: "ari", name: "Ari" });
    pageId = (await createFanslyPage(app.db, { modelId: ari!.id, label: "ari-1" }))!.id;
    await assignPageToUser(app, { userId: vanya, pageLabel: "ari-1" }, { source: "cli" });
    // A fan of the page whose chat Hub has not synced yet.
    fanId = Number((await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username) values ('fansly', $1, 'quietfan') returning id", [FAN_REF],
    )).rows[0]!.id);
    await testDb.pool.query("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [fanId, pageId]);
    await tip("custom-tip-a", 60_000n, 2);
    await tip("custom-tip-b", 30_000n, 1);

    server = await buildApiServer(app);
    await server.ready();
    const signIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": VERSION },
      payload: { username: "vanya", password: "vanya-secret", label: "Firefox", mode: "active", client: "chat-extension" },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    token = signIn.json<{ token: string }>().token;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("delivers a custom written before the fan's thread synced, and gives a cancelled custom's tip back", async (context) => {
    if (!testDb || !server) return context.skip();
    const offered = (await card()).customPayments;
    const tipA = offered.find((payment) => payment.amountMills === 60_000)!.paymentRef;
    const tipB = offered.find((payment) => payment.amountMills === 30_000)!.paymentRef;

    // Written while Hub has no thread of the fan: nothing to deliver by yet.
    const created = await post("", { description: "фото в красном", paymentRef: tipA });
    expect(created.statusCode, created.body).toBe(200);
    const custom = created.json().card.customs[0];
    expect(custom.deliveryCandidates).toEqual([]);

    // The thread and the video sent in it sync later: the custom finds them.
    await testDb.pool.query(
      `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, last_message_at, is_visible)
       values ($1, $2, '8300000001', $3, now(), true)`,
      [pageId, fanId, FAN_REF],
    );
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, media_metadata)
       values ($1, 'fansly', '8300000001', '9300000001', 'model', true, now() - interval '1 hour', 'for you', '[{"type":"image"}]'::jsonb)`,
      [pageId],
    );
    expect((await card()).customs[0]!.deliveryCandidates.map((message) => message.messageRef)).toEqual(["9300000001"]);
    const delivered = await post(`/${custom.id}`, { action: "delivered", messageRef: "9300000001" });
    expect(delivered.json()).toMatchObject({ changed: true });

    // A custom paid by tip B, cancelled: tip B is offered again and another custom takes it.
    const second = await post("", { description: "голосовое", paymentRef: tipB });
    expect(second.json().card.customPayments).toEqual([]);
    const secondId = second.json().card.customs.find((one: { description: string }) => one.description === "голосовое").id;
    expect((await post(`/${secondId}`, { action: "cancel" })).json()).toMatchObject({ changed: true });
    expect((await card()).customPayments.map((payment) => payment.paymentRef)).toEqual([tipB]);
    expect((await post("", { description: "голосовое, заново", paymentRef: tipB })).statusCode).toBe(200);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps a fan of another page out of reach: no custom written or changed through this page", async (context) => {
    if (!testDb || !server) return context.skip();
    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    const loraId = (await createFanslyPage(app.db, { modelId: lora!.id, label: "lora-1" }))!.id;
    const stranger = Number((await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username) values ('fansly', '7300000009', 'elsewhere') returning id",
    )).rows[0]!.id);
    await testDb.pool.query("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [stranger, loraId]);
    const custom = Number((await testDb.pool.query<{ id: string }>(
      `insert into fan_customs (page_id, fan_id, description, state, created_by_user_id)
       select $1, $2, 'видео', 'ordered', id from users where username = 'vanya' returning id`,
      [loraId, stranger],
    )).rows[0]!.id);

    expect((await post("", { description: "фото" }, "7300000009")).statusCode).toBe(404);
    expect((await post(`/${custom}`, { action: "cancel" }, "7300000009")).statusCode).toBe(404);
    expect((await testDb.pool.query("select state from fan_customs where id = $1", [custom])).rows[0].state).toBe("ordered");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
