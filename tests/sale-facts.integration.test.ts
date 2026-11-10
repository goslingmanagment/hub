import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createModel, createOnlyFansPage, listSaleFacts, upsertTransaction } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The facts of a sale (`listSaleFacts`): who sent the PPV a fan bought. The
// agency ledger's split rules read them through `agentTeamSales`, and «Разбор
// смены» shows them.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
const users: Record<string, number> = {};

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const HOUR = 3_600_000;

describe("the facts of a sale", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    for (const username of ["nikita", "vanya"]) {
      await createUserAccount(app, { username, role: "chatter" }, { source: "cli" });
      users[username] = await fixtureUserId(app, username);
    }
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("pairs two OnlyFans purchases of one price with their own PPVs and authors", async (context) => {
    if (!testDb) return context.skip();
    // Unlocks at T (Ваня's PPV) and T+1:00 (Никита's), both $10; purchases at T+0:20 and T+0:25. Each nearest-in-time
    // pick would give both purchases Ваня's message; one to one, the second is Никита's.
    const model = await createModel(app.db, { slug: "of-pair", name: "OF pair" });
    const page = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "of-pair" }))!.id;
    const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('onlyfans', '600001', 'twin') returning id")).rows[0].id);
    const thread = Number((await q(
      `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, stored_message_count,
         message_coverage_status, last_message_at, oldest_stored_message_id, newest_stored_message_id)
       values ($1, $2, '600001', '600001', 2, 'complete', now() - interval '1 hour', '7100000001', '7100000002') returning id`, [page, fanId])).rows[0].id);
    const unlockAt = Date.now() - HOUR;
    for (const [ref, author, offset] of [["7100000001", "vanya", 0], ["7100000002", "nikita", 60_000]] as const) {
      await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, price_mills)
               values ($1, 'onlyfans', '600001', $2, 'model', true, $3, 'ppv', 10000)`, [page, ref, new Date(unlockAt - 2 * HOUR)]);
      await q(`insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id, sender_platform_user_id, sender_role, created_at,
                 content, purchased_at)
               values ($1, $2, $3, '1', 'model', $4, 'ppv', $5)`, [thread, page, ref, new Date(unlockAt - 2 * HOUR), new Date(unlockAt + offset)]);
      await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at)
               values ('onlyfans', $1, $2, '600001', $3, 'chatspace-extension', true, true, $4)`, [page, ref, users[author], new Date(unlockAt - 2 * HOUR)]);
    }
    const ids: number[] = [];
    for (const [id, offset] of [["of-pair-1", 20_000], ["of-pair-2", 25_000]] as const) {
      await upsertTransaction(app.db, {
        platformAccountId: page, source: "ofapi:webhook", fanId, transactionId: id, rawType: "message",
        canonicalType: "message_purchase", transactionState: "posted", rawStatus: "ok", grossAmountMills: 10_000n,
        sourceDestinationAmountMills: 10_000n, creatorNetAmountMills: 8_000n, occurredAt: new Date(unlockAt + offset),
      });
      ids.push(Number((await q("select id from transactions where transaction_id = $1", [id])).rows[0].id));
    }
    const facts = await listSaleFacts(app.db, { transactionIds: ids });
    expect(ids.map((id) => facts.find((fact) => fact.transactionId === id)?.ppvSender?.username)).toEqual(["vanya", "nikita"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
