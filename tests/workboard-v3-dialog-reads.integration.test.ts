import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  dialogReads,
  fans,
  pageDmMessages,
  pageDmThreads,
  workboardV3FanState,
  type Wb3DialogVerdict,
} from "@agency_hub_core/db";

import type { DialogReader, DialogReadInput } from "../apps/runtime/src/services/workboard-v3/dialog-reader.ts";
import { runWb3DialogReadsForPage } from "../apps/runtime/src/services/workboard-v3/dialog-reads.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

const MINUTE = 60_000;

let harness: StartedTestDatabase;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

afterEach(async () => {
  await resetIntegrationDatabase(harness.pool);
});

async function seedPage() {
  const model = await createModel(harness.db, { slug: "lora", name: "Lora" });
  const page = await createFanslyPage(harness.db, { modelId: model.id, label: "lora-main" });
  return { model, page };
}

let seq = 0;
async function insertThreadWithMessages(
  pageId: number,
  messages: Array<{ role: "fan" | "model"; text: string }>,
  now: Date,
) {
  seq += 1;
  const [fanRow] = await harness.db
    .insert(fans)
    .values({ platform: "fansly", platformUserId: `fan-${seq}`, username: `fan${seq}` })
    .returning({ id: fans.id });
  const lastRole = messages[messages.length - 1]!.role;
  const [threadRow] = await harness.db
    .insert(pageDmThreads)
    .values({
      platformAccountId: pageId,
      fanId: fanRow!.id,
      platformConversationId: `conv-${seq}`,
      lastMessageSenderRole: lastRole,
      lastFanMessageAt: now,
    })
    .returning({ id: pageDmThreads.id });
  for (let i = 0; i < messages.length; i += 1) {
    seq += 1;
    await harness.db.insert(pageDmMessages).values({
      conversationId: threadRow!.id,
      platformAccountId: pageId,
      platformMessageId: `msg-${seq}`,
      senderRole: messages[i]!.role,
      createdAt: new Date(now.getTime() - (messages.length - i) * MINUTE),
      content: messages[i]!.text,
    });
  }
  return { fanId: fanRow!.id, threadId: threadRow!.id };
}

function fakeReader(
  verdictFor: (dialog: DialogReadInput) => Wb3DialogVerdict,
  counters: { calls: number },
): DialogReader {
  return {
    model: "fake-haiku",
    async readBatch(dialogs) {
      counters.calls += 1;
      return {
        results: dialogs.map((d) => ({ id: d.id, verdict: verdictFor(d), parsed: true })),
        inputTokens: 100,
        outputTokens: 50,
      };
    },
  };
}

describe("workboard v3 dialog reads (integration)", () => {
  it("runs in L1-only mode without a reader: closings cut for free, the rest deferred", async () => {
    const now = new Date();
    const { page } = await seedPage();

    await insertThreadWithMessages(page.id, [
      { role: "model", text: "enjoy the set 💕" },
      { role: "fan", text: "ok thanks" },
    ], now);
    const question = await insertThreadWithMessages(page.id, [
      { role: "fan", text: "how much for a custom video?" },
    ], now);

    const result = await runWb3DialogReadsForPage(harness.db, null, { platformAccountId: page.id, now });

    expect(result.candidates).toBe(2);
    expect(result.l1Cut).toBe(1);
    expect(result.deferred).toBe(1);
    expect(result.calls).toBe(0);

    const rows = await harness.db.select().from(dialogReads);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe("l1");
    expect(rows[0]!.verdict.needs_reply).toBe(false);
    expect(rows[0]!.verdict.intent).toBe("closing");
    // The question thread stays unread — fail-open to ● happens on the board.
    expect(rows.some((r) => r.conversationId === question.threadId)).toBe(false);
  });

  it("does not L1-cut a burst whose last message is closing but contains a real question", async () => {
    const now = new Date();
    const { page } = await seedPage();
    await insertThreadWithMessages(page.id, [
      { role: "fan", text: "how much for a custom?" },
      { role: "fan", text: "ok" },
    ], now);

    const counters = { calls: 0 };
    const reader = fakeReader(
      () => ({ needs_reply: true, intent: "buy_signal", temperature: "hot", readiness: "considering", gist: "спрашивает цену кастома" }),
      counters,
    );
    const result = await runWb3DialogReadsForPage(harness.db, reader, { platformAccountId: page.id, now });

    expect(result.l1Cut).toBe(0);
    expect(result.read).toBe(1);
    expect(counters.calls).toBe(1);

    const rows = await harness.db.select().from(dialogReads);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict.intent).toBe("buy_signal");
    expect(rows[0]!.verdict.gist).toBe("спрашивает цену кастома");
    expect(rows[0]!.model).toBe("fake-haiku");
  });

  it("caches by (conversation, last fan message): the second run makes no API calls", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const { threadId } = await insertThreadWithMessages(page.id, [
      { role: "fan", text: "are you online?" },
    ], now);

    const counters = { calls: 0 };
    const reader = fakeReader(
      () => ({ needs_reply: true, intent: "question", temperature: "warm", readiness: "none", gist: "спрашивает, в сети ли" }),
      counters,
    );

    const first = await runWb3DialogReadsForPage(harness.db, reader, { platformAccountId: page.id, now });
    expect(first.read).toBe(1);
    expect(counters.calls).toBe(1);

    const second = await runWb3DialogReadsForPage(harness.db, reader, { platformAccountId: page.id, now });
    expect(second.candidates).toBe(0);
    expect(second.read).toBe(0);
    expect(counters.calls).toBe(1);

    // A NEW fan message re-opens the thread for exactly one more read.
    seq += 1;
    await harness.db.insert(pageDmMessages).values({
      conversationId: threadId,
      platformAccountId: page.id,
      platformMessageId: `msg-${seq}`,
      senderRole: "fan",
      createdAt: new Date(now.getTime() + MINUTE),
      content: "and do you do customs?",
    });
    const third = await runWb3DialogReadsForPage(harness.db, reader, { platformAccountId: page.id, now });
    expect(third.read).toBe(1);
    expect(counters.calls).toBe(2);
    expect(await harness.db.select().from(dialogReads)).toHaveLength(2);
  });

  it("fails open at cap overflow: no calls, no invented intents, all deferred", async () => {
    const now = new Date();
    const { page } = await seedPage();
    for (let i = 0; i < 3; i += 1) {
      await insertThreadWithMessages(page.id, [{ role: "fan", text: `question number ${i}?` }], now);
    }

    const counters = { calls: 0 };
    const reader = fakeReader(
      () => ({ needs_reply: true, intent: "question", temperature: "warm", readiness: "none", gist: "вопрос" }),
      counters,
    );
    const result = await runWb3DialogReadsForPage(harness.db, reader, {
      platformAccountId: page.id,
      now,
      capMin: 0,
      capMax: 0,
    });

    expect(counters.calls).toBe(0);
    expect(result.read).toBe(0);
    expect(result.deferred).toBe(3);
    expect(await harness.db.select().from(dialogReads)).toHaveLength(0);
  });

  it("defers the remainder when the API fails mid-run, never writing partial verdicts", async () => {
    const now = new Date();
    const { page } = await seedPage();
    for (let i = 0; i < 4; i += 1) {
      await insertThreadWithMessages(page.id, [{ role: "fan", text: `tell me more ${i}` }], now);
    }

    const failingReader: DialogReader = {
      model: "fake-haiku",
      async readBatch() {
        throw new Error("api down");
      },
    };
    const result = await runWb3DialogReadsForPage(harness.db, failingReader, {
      platformAccountId: page.id,
      now,
    });

    expect(result.read).toBe(0);
    expect(result.deferred).toBe(4);
    expect(await harness.db.select().from(dialogReads)).toHaveLength(0);
  });

  it("auto-flags do-not-touch on a stop_request verdict", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const { fanId } = await insertThreadWithMessages(page.id, [
      { role: "fan", text: "stop texting me, I am not interested" },
    ], now);

    const counters = { calls: 0 };
    const reader = fakeReader(
      () => ({ needs_reply: false, intent: "stop_request", temperature: "cold", readiness: "none", gist: "просит не писать" }),
      counters,
    );
    const result = await runWb3DialogReadsForPage(harness.db, reader, { platformAccountId: page.id, now });
    expect(result.stopRequests).toBe(1);

    const states = await harness.db.select().from(workboardV3FanState);
    const state = states.find((s) => s.fanId === fanId);
    expect(state!.doNotTouch).toBe(true);
    expect(state!.doNotTouchReason).toContain("stop_request");
  });
});
