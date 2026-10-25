import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { runFanFactsSweep, type FanFactsClientFactory } from "../apps/runtime/src/services/fan-facts/lane.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// The facts lane (Chat Memory week 2, week-2.md §3): a quiet conversation where
// the fan wrote gets one run; its window is never sent again; a new fan message
// brings the next run with the current memory; the daily cap stops the lane
// before a call; a call with no answer stays outcome_unknown and is not retried.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let fanId = 0;
let seq = 9_400_000_000;
const GROUP = "8400000001";
const requests: Array<Record<string, unknown>> = [];
let answer: () => unknown = () => ({ add: [], close: [] });
let fail: Error | null = null;

const fakeClients: FanFactsClientFactory = () => ({
  async create(request) {
    requests.push(request);
    if (fail) throw fail;
    return {
      id: `msg_${requests.length}`,
      stop_reason: "end_turn",
      content: [{ type: "thinking" }, { type: "text", text: JSON.stringify(answer()) }],
      usage: { input_tokens: 1200, output_tokens: 80 },
    };
  },
  servedAccountId: () => null,
  async release() {},
});

async function message(fromFan: boolean, text: string, minutesAgo: number) {
  seq += 1;
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, message_type)
     values ($1, 'fansly', $2, $3, $4, $5, now() - interval '1 minute' * $6, $7, 1)`,
    [pageId, GROUP, String(seq), fromFan ? "fan" : "model", !fromFan, minutesAgo, text],
  );
  return String(seq);
}

const sweep = () => runFanFactsSweep(app, { clientFactory: fakeClients });
const query = <Row extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  testDb!.pool.query<Row>(text, values).then((result) => result.rows);

describe("the facts lane", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    const model = await createModel(app.db, { slug: "ari", name: "Ari" });
    pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "ari-1" }))!.id;
    await saveProxy(app, pageId, { url: "http://127.0.0.1:9" });
    fanId = Number((await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username, first_seen_at) values ('fansly', '7100000001', 'dave', now()) returning id",
    )).rows[0]!.id);
    await testDb.pool.query(
      "insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id) values ($1, $2, $3)",
      [pageId, GROUP, fanId],
    );
    Object.assign(app.config, { fanFactsEnabled: true, fanFactsPages: "ari-1", fanFactsDailyMicroUsdLimit: 2_000_000 });
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("runs once per quiet conversation, never resends a window, and stops at the cap", async (context) => {
    if (!testDb) return context.skip();
    await message(true, "hey im Dave", 40);
    const named = await message(true, "i drive trucks for a living", 39);
    await message(false, "omg a trucker", 38);
    // Still in a conversation: the last message is 5 minutes old.
    const recent = await message(true, "u there?", 5);
    expect((await sweep()).runs).toBe(0);
    await testDb.pool.query("update message_archive set occurred_at = now() - interval '20 minutes' where message_ref = $1", [recent]);

    answer = () => ({ add: [{ kind: "about", text: "Работает дальнобойщиком", message: 2 }, { kind: "about", text: "Без сообщения", message: 40 }], close: [] });
    expect(await sweep()).toMatchObject({ runs: 1, added: 1, closed: 0 });
    expect(await query("select text, message_ref, source, state from fan_facts")).toEqual([
      { text: "Работает дальнобойщиком", message_ref: named, source: "ai", state: "active" },
    ]);
    expect(await query("select state, messages_read, facts_added from fan_fact_runs")).toEqual([{ state: "done", messages_read: 4, facts_added: 1 }]);
    expect(await query("select feature::text, user_id, gateway_outcome from ai_usage_events")).toEqual([
      { feature: "fan-facts", user_id: null, gateway_outcome: "completed" },
    ]);
    // The same window is never sent again.
    expect((await sweep()).runs).toBe(0);

    // The fan wrote again: the next run reads the new message with the current memory and may close an AI fact.
    await message(true, "quit trucking, im a cook now", 18);
    const factId = Number((await query<{ id: string }>("select id from fan_facts"))[0]!.id);
    answer = () => ({ add: [{ kind: "about", text: "Работает поваром", message: 5 }], close: [{ id: factId, why: "сменил работу" }] });
    expect(await sweep()).toMatchObject({ runs: 1, added: 1, closed: 1 });
    expect(JSON.stringify(requests.at(-1))).toContain(`id ${factId} · about · Работает дальнобойщиком`);
    expect(await query("select text, state from fan_facts order by id")).toEqual([
      { text: "Работает дальнобойщиком", state: "closed" },
      { text: "Работает поваром", state: "active" },
    ]);

    // The cap stops the lane before a call.
    await message(true, "also i have a dog", 17);
    app.config.fanFactsDailyMicroUsdLimit = 0;
    const calls = requests.length;
    expect(await sweep()).toMatchObject({ runs: 0, capReached: true });
    expect(requests.length).toBe(calls);

    // A call with no answer stays outcome_unknown, and its window is not sent again.
    app.config.fanFactsDailyMicroUsdLimit = 2_000_000;
    fail = new Error("socket hang up");
    expect((await sweep()).runs).toBe(1);
    fail = null;
    expect((await query<{ state: string }>("select state from fan_fact_runs order by id desc limit 1"))[0]!.state).toBe("outcome_unknown");
    expect((await sweep()).runs).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
