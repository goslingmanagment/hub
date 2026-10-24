import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, listPageAuthorshipDays } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// How many of a page's personal outgoing messages have an author (Chat Memory
// week 1, plan §1): a Fansly mass message and one text sent to five chats
// within an hour are not personal; an author joins by the message id; «in a
// shift» is a minute some chatter had the page open.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let userId = 0;
const T0 = new Date(Date.UTC(2026, 9, 26, 15, 0));
const at = (minute: number) => new Date(T0.getTime() + minute * 60_000);

async function sent(ref: string, conversation: string, minute: number, text: string, messageType = 1) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, message_type)
     values ($1, 'fansly', $2, $3, 'model', true, $4, $5, $6)`,
    [pageId, conversation, ref, at(minute), text, messageType],
  );
}

describe("listPageAuthorshipDays", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "nikita", role: "chatter" }, { source: "cli" });
    userId = await fixtureUserId(app, "nikita");
    const model = await createModel(app.db, { slug: "ari", name: "Ari" });
    pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "ari-1" }))!.id;
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("counts personal messages only, with their authors and the ones sent in a shift", async (context) => {
    if (!testDb) return context.skip();
    // Two personal messages: one with an author, sent while the page was open; one from a phone, outside a shift.
    await sent("9100000001", "8100000001", 1, "hi babe");
    await sent("9100000002", "8100000002", 40, "you there?");
    // A Fansly mass message and one text to five chats within the hour: neither is personal.
    await sent("9100000003", "8100000003", 2, "new set is out", 2);
    for (let chat = 0; chat < 5; chat += 1) await sent(`910000001${chat}`, `810000001${chat}`, 10 + chat, "surprise in your dms");
    await testDb.pool.query(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, conversation_ref, user_id, source, priced, with_media, observed_at)
       values ('fansly', $1, '9100000001', '7100000001', '8100000001', $2, 'fansly-extension', false, false, $3)`,
      [pageId, userId, at(1)],
    );
    await testDb.pool.query(
      "insert into chatter_activity_minutes (user_id, page_id, minute, input) values ($1, $2, $3, true)",
      [userId, pageId, at(1)],
    );

    const rows = await listPageAuthorshipDays(app.db, { from: at(0), to: at(120), pages: [pageId], burstMinFans: 5 });
    expect(rows).toEqual([{
      pageId, pageLabel: "ari-1", platform: "fansly", day: "2026-10-26",
      personal: 2, authored: 1, inShift: 1, inShiftAuthored: 1,
    }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
