import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientHandoffResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The shift handoff (Chat Memory week 3, week-3.md §4): whom the team wrote to
// in the last hours and who is still in a conversation, who waits, and the
// open promises — read together for the next chatter.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const VERSION = "chat-extension/0.9.0";
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let token = "";

describe("the shift handoff", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    for (const username of ["vanya", "nikita"]) await createUserAccount(app, { username, role: "chatter" }, { source: "cli" });
    const vanya = await fixtureUserId(app, "vanya");
    const nikita = await fixtureUserId(app, "nikita");
    await setUserPassword(app, { userId: vanya, password: "vanya-secret" }, { source: "cli" });
    const model = await createModel(app.db, { slug: "ari", name: "Ari" });
    const pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "ari-1" }))!.id;
    await assignPageToUser(app, { userId: vanya, pageLabel: "ari-1" }, { source: "cli" });
    const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
    const fan = async (ref: string) => Number((await q("insert into fans (platform, platform_user_id, username, first_seen_at) values ('fansly', $1, $2, now()) returning id", [ref, `fan${ref}`])).rows[0].id);
    const dave = await fan("7200000001");
    const bob = await fan("7200000002");
    await q("insert into page_fans (fan_id, platform_account_id, page_alias) values ($1, $2, '💵Dave/UK/52'), ($3, $2, null)", [dave, pageId, bob]);
    // Nikita wrote to Dave 5 minutes ago (still in a conversation) and 3 hours ago.
    for (const [ref, minutes] of [["9700000001", 180], ["9700000002", 5]] as const) {
      await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, conversation_ref, user_id, source, priced, with_media, observed_at)
               values ('fansly', $1, $2, '7200000001', '8700000001', $3, 'fansly-extension', false, false, now() - interval '1 minute' * $4)`, [pageId, ref, nikita, minutes]);
    }
    // Bob wrote an hour ago and nobody answered.
    await q(`insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, last_message_at, last_fan_message_at, is_visible)
             values ($1, $2, '8700000002', '7200000002', now() - interval '1 hour', now() - interval '1 hour', true)`, [pageId, bob]);
    await q(`insert into fan_facts (fan_id, page_id, platform, conversation_ref, kind, text, message_ref, message_at, source)
             values ($1, $2, 'fansly', '8700000001', 'promise', 'Обещали видео в душе к пятнице, $40', '9700000001', now() - interval '3 hours', 'ai')`, [dave, pageId]);

    server = await buildApiServer(app);
    await server.ready();
    const signIn = await server.inject({
      method: "POST", url: "/api/v1/auth/device-tokens/password", headers: { "x-client-version": VERSION },
      payload: { username: "vanya", password: "vanya-secret", label: "Firefox", mode: "active", client: "chat-extension" },
    });
    token = signIn.json<{ token: string }>().token;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("reads who was written to, who is still talking, who waits and what was promised", async (context) => {
    if (!testDb || !server) return context.skip();
    const response = await server.inject({ method: "GET", url: "/api/v1/client/pages/ari-1/handoff", headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION } });
    expect(response.statusCode, response.body).toBe(200);
    const handoff = clientHandoffResponseSchema.parse(response.json());
    expect(handoff.recent).toEqual([expect.objectContaining({
      fanRef: "7200000001", conversationRef: "8700000001", alias: "💵Dave/UK/52", messages: 2, chatters: ["nikita"], inConversation: ["nikita"],
    })]);
    expect(handoff.waiting.total).toBe(1);
    expect(handoff.waiting.head.map((fan) => [fan.fanRef, fan.conversationRef])).toEqual([["7200000002", "8700000002"]]);
    expect(handoff.promises.map((promise) => promise.text)).toEqual(["Обещали видео в душе к пятнице, $40"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
