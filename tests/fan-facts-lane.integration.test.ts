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
/** Runs inside the call, as the provider answers (the review's erasure race). */
let during: (() => Promise<void>) | null = null;

const fakeClients: FanFactsClientFactory = () => ({
  async create(request) {
    requests.push(request);
    await during?.();
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

async function message(fromFan: boolean, text: string, minutesAgo: number, conversationRef = GROUP) {
  seq += 1;
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, message_type)
     values ($1, 'fansly', $2, $3, $4, $5, now() - interval '1 minute' * $6, $7, 1)`,
    [pageId, conversationRef, String(seq), fromFan ? "fan" : "model", !fromFan, minutesAgo, text],
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

  it("retries a refused call later, re-reads a kept promise, and writes nothing of a call whose fan was erased", async (context) => {
    if (!testDb) return context.skip();
    // Review 2026-10-25: a provider's refusal burnt the window; a promise kept by the model stayed open until
    // the fan wrote again; a fan erased during the call left the call's record behind.
    const chat = "8400000002";
    const fan2 = Number((await query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username, first_seen_at) values ('fansly', '7100000002', 'eve', now()) returning id",
    ))[0]!.id);
    await query("insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id) values ($1, $2, $3)", [pageId, chat, fan2]);

    await message(true, "send me the shower vid friday?", 40, chat);
    // The provider refused the window's call (an HTTP answer: nothing ran, nothing billed).
    await query(
      `insert into fan_fact_runs (page_id, conversation_ref, fan_id, model, prompt_version, through_message_at, messages_read,
         reserved_micro_usd, started_at, state, error_code, cost_micro_usd, finished_at)
       values ($1, $2, $3, 'anthropic:claude-sonnet-5-5', 3, now(), 1, 1000, now(), 'failed', 'http_529', 0, now())`,
      [pageId, chat, fan2],
    );
    expect((await sweep()).runs).toBe(0);
    await query("update fan_fact_runs set started_at = now() - interval '31 minutes' where conversation_ref = $1", [chat]);
    answer = () => ({ add: [{ kind: "promise", text: "Обещали видео в душе к пятнице", message: 1 }], close: [] });
    expect(await sweep()).toMatchObject({ runs: 1, added: 1 });

    // The model kept it; the fan is silent — the conversation is read again for the open promise.
    await message(false, "here it is babe", 20, chat);
    const promiseId = Number((await query<{ id: string }>("select id from fan_facts where conversation_ref = $1", [chat]))[0]!.id);
    answer = () => ({ add: [], close: [{ id: promiseId, why: "видео отправлено" }] });
    expect(await sweep()).toMatchObject({ runs: 1, closed: 1 });

    // Erased during the call: the run went with the fan, and nothing of the call is written.
    await message(true, "im Eve btw", 18, chat);
    answer = () => ({ add: [{ kind: "about", text: "Зовут Eve", message: 3 }], close: [] });
    const records = async () => Number((await query<{ n: string }>("select count(*) as n from ai_generation_content where conversation_ref = $1", [chat]))[0]!.n);
    const before = await records();
    during = async () => { await query("delete from fan_fact_runs where conversation_ref = $1", [chat]); };
    expect((await sweep()).runs).toBe(1);
    during = null;
    expect(await query("select text from fan_facts where conversation_ref = $1 and state = 'active'", [chat])).toEqual([]);
    expect(await records()).toBe(before);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  /** A fan of the page with his own chat (the final review's cases). */
  const newFan = async (ref: string, chat: string) => {
    const id = Number((await query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username, first_seen_at) values ('fansly', $1, $2, now()) returning id", [ref, `fan${ref}`],
    ))[0]!.id);
    await query("insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id) values ($1, $2, $3)", [pageId, chat, id]);
    return id;
  };

  it("a refused window waits out its pause and is then read as new lines, whatever the fan wrote since", async (context) => {
    if (!testDb) return context.skip();
    // Final review 2026-10-25 of #854: a run that slipped in before the refused one's retry took its window as context.
    // Refused 10 minutes ago for the window up to the first message; the fan wrote again since.
    const refusedChat = "8400000003";
    const refusedFan = await newFan("7100000003", refusedChat);
    await message(true, "my birthday is may 3", 60, refusedChat);
    await query(
      `insert into fan_fact_runs (page_id, conversation_ref, fan_id, model, prompt_version, through_message_at, messages_read,
         reserved_micro_usd, started_at, state, error_code, cost_micro_usd, finished_at)
       values ($1, $2, $3, 'anthropic:claude-sonnet-5-5', 3, now() - interval '60 minutes', 1, 1000, now() - interval '10 minutes', 'failed', 'http_529', 0, now())`,
      [pageId, refusedChat, refusedFan],
    );
    await message(true, "u there", 20, refusedChat);
    const refusedRuns = async () => Number((await query<{ n: string }>(
      "select count(*) as n from fan_fact_runs where conversation_ref = $1", [refusedChat]))[0]!.n);
    // Within the pause after a refusal the conversation waits, whatever the fan wrote since.
    await sweep();
    expect(await refusedRuns()).toBe(1);
    await query("update fan_fact_runs set started_at = now() - interval '31 minutes' where conversation_ref = $1", [refusedChat]);
    // The retry reads the refused window as new lines: its fact is taken.
    answer = () => ({ add: [{ kind: "about", text: "День рождения 3 мая", message: 1 }], close: [] });
    await sweep();
    expect(await query("select text from fan_facts where conversation_ref = $1 and state = 'active'", [refusedChat])).toEqual([{ text: "День рождения 3 мая" }]);

  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("re-reads an open promise the model kept after the fan was silent more than 48 h", async (context) => {
    if (!testDb) return context.skip();
    // Final review 2026-10-25 of #854: the promise stayed open until the fan wrote again.
    // A promise from three days ago, the fan silent since; the model keeps it now.
    const silentChat = "8400000004";
    const silentFan = await newFan("7100000004", silentChat);
    const asked = await message(true, "send me the gym pics", 3 * 24 * 60, silentChat);
    await query(
      `insert into fan_fact_runs (page_id, conversation_ref, fan_id, model, prompt_version, through_message_at, messages_read,
         reserved_micro_usd, started_at, state, cost_micro_usd, finished_at)
       values ($1, $2, $3, 'anthropic:claude-sonnet-5-5', 3, now() - interval '3 days', 1, 1000, now() - interval '3 days', 'done', 500, now() - interval '3 days')`,
      [pageId, silentChat, silentFan],
    );
    const promiseId = Number((await query<{ id: string }>(
      `insert into fan_facts (fan_id, page_id, platform, conversation_ref, kind, text, message_ref, message_at, source)
       values ($1, $2, 'fansly', $3, 'promise', 'Обещали фото из зала', $4, now() - interval '3 days', 'ai') returning id`,
      [silentFan, pageId, silentChat, asked],
    ))[0]!.id);
    await message(false, "here they are", 20, silentChat);
    answer = () => ({ add: [], close: [{ id: promiseId, why: "фото отправлены" }] });
    await sweep();
    expect(await query("select state from fan_facts where id = $1", [promiseId])).toEqual([{ state: "closed" }]);

  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("an erasure that deletes the call records before the fan leaves no record of a call finishing in between", async (context) => {
    if (!testDb) return context.skip();
    // Final review 2026-10-25 of #854: the call's record survived when it committed between the two deletes.
    // An erasure holds its fence, deletes the fan's call records, then the fan — a call finishing in between.
    const erasedChat = "8400000005";
    const erasedFan = await newFan("7100000005", erasedChat);
    await message(true, "im Zoe", 20, erasedChat);
    answer = () => ({ add: [{ kind: "about", text: "Зовут Zoe", message: 1 }], close: [] });
    const erasure = await testDb.pool.connect();
    try {
      during = async () => {
        await erasure.query("begin");
        await erasure.query("select pg_advisory_xact_lock(815402, $1)", [pageId]);
        await erasure.query("delete from ai_generation_content where conversation_ref = $1", [erasedChat]);
      };
      const running = sweep();
      // Until the lane either wrote its record or waits for the fence.
      for (let i = 0; i < 100; i += 1) {
        const [state] = await query<{ waiting: string; written: string }>(
          `select (select count(*) from pg_locks where database = (select oid from pg_database where datname = current_database()) and locktype = 'advisory' and not granted) as waiting,
                  (select count(*) from ai_generation_content where conversation_ref = $1) as written`, [erasedChat]);
        if (Number(state!.waiting) > 0 || Number(state!.written) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await erasure.query("delete from fans where id = $1", [erasedFan]);
      await erasure.query("commit");
      await running;
    } finally {
      during = null;
      erasure.release();
    }
    expect(await query("select count(*)::int as n from ai_generation_content where conversation_ref = $1", [erasedChat])).toEqual([{ n: 0 }]);
    expect(await query("select count(*)::int as n from fan_facts where conversation_ref = $1", [erasedChat])).toEqual([{ n: 0 }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
