import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, listEmptyHours, upsertTransaction } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Empty hours (Chat Memory week 6, week-6.md §В): an hour is empty when fans
// wrote and no chatter minute fell in it; counting starts at the page's first
// minute in the extension; a mass message answers nobody; a fan who waited
// over an hour brings their 30-day net.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let ari = 0;
let lora = 0;
const MIN = 60_000;
const HOUR = 60 * MIN;
const now = new Date();
const h0 = new Date(Math.floor(now.getTime() / HOUR) * HOUR - 3 * HOUR);
const at = (minutesAfterH0: number) => new Date(h0.getTime() + minutesAfterH0 * MIN);

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

async function message(pageId: number, conv: string, ref: string, minutesAfterH0: number, input: { fromFan: boolean; type?: number }) {
  await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
             media_metadata, message_type)
           values ($1, 'fansly', $2, $3, $4, $5, $6, 'hi', '[]'::jsonb, $7)`,
    [pageId, conv, ref, input.fromFan ? "fan" : "model", !input.fromFan, at(minutesAfterH0), input.type ?? 1]);
}

describe("empty hours of a page", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "vanya", role: "chatter" }, { source: "cli" });
    const vanya = await fixtureUserId(app, "vanya");
    const model = await createModel(app.db, { slug: "ari", name: "Ari" });
    ari = (await createFanslyPage(app.db, { modelId: model!.id, label: "ari-1" }))!.id;
    lora = (await createFanslyPage(app.db, { modelId: model!.id, label: "lora-1" }))!.id;
    const fanB = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', '7000000002', 'bob') returning id")).rows[0].id);
    await q("insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id) values ($1, $2, '8800000002')", [ari, fanB]);

    // Ваня worked ten minutes into the first hour; the next hour nobody did.
    await q("insert into chatter_activity_minutes (user_id, page_id, minute) values ($1, $2, $3)", [vanya, ari, at(10)]);
    // Before the page's first minute in the extension: not counted.
    await message(ari, "8800000003", "9000000001", -60, { fromFan: true });
    // The worked hour: not empty.
    await message(ari, "8800000001", "9000000002", 20, { fromFan: true });
    // The empty hour: A is answered in 25 minutes; B gets a mass message, then a personal reply 70 minutes later.
    await message(ari, "8800000001", "9000000003", 65, { fromFan: true });
    await message(ari, "8800000001", "9000000004", 90, { fromFan: false });
    await message(ari, "8800000002", "9000000005", 70, { fromFan: true });
    await message(ari, "8800000002", "9000000006", 75, { fromFan: false, type: 2 });
    await message(ari, "8800000002", "9000000007", 140, { fromFan: false });
    await upsertTransaction(app.db, {
      platformAccountId: ari, source: "fansly:rest", fanId: fanB, transactionId: "coverage-tip", rawType: "7001",
      canonicalType: "tip", transactionState: "posted", rawStatus: "ok", grossAmountMills: 25_000n,
      sourceDestinationAmountMills: 25_000n, creatorNetAmountMills: 20_000n, occurredAt: at(0),
    });
    // A page nobody has worked on in the extension.
    await message(lora, "8800000009", "9000000009", 65, { fromFan: true });
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("counts empty hours from the first shift, who wrote in them and who waited", async (context) => {
    if (!testDb) return context.skip();
    const rows = await listEmptyHours(app.db, { from: new Date(h0.getTime() - 2 * HOUR), to: now, pages: "all" });
    const emptyByHour = Array.from({ length: 24 }, () => 0);
    emptyByHour[(new Date(h0.getTime() + HOUR).getUTCHours() + 3) % 24] = 1;
    expect(rows).toEqual([
      {
        pageId: ari, pageLabel: "ari-1", platform: "fansly", shiftsSince: at(10),
        hoursWithFans: 2, emptyHours: 1, emptyByHour, fans: 2, payers: 1, waitedOverHour: 1, waitedNetMills: 20_000,
      },
      {
        pageId: lora, pageLabel: "lora-1", platform: "fansly", shiftsSince: null,
        hoursWithFans: 0, emptyHours: 0, emptyByHour: Array.from({ length: 24 }, () => 0), fans: 0, payers: 0, waitedOverHour: 0, waitedNetMills: 0,
      },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
