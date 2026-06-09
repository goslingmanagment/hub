import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  dmBroadcastGroups,
  dmBroadcastMessages,
  fans,
  getWb3BroadcastWatermark,
  pageDmMessages,
  pageDmThreads,
  workboardV3Touches,
} from "@agency_hub_core/db";

import { detectBroadcastsForPage } from "../apps/runtime/src/services/workboard-v3/broadcast-detector.ts";
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

async function insertFanWithThread(pageId: number, suffix: string): Promise<{ fanId: number; threadId: number }> {
  const [fanRow] = await harness.db
    .insert(fans)
    .values({ platform: "fansly", platformUserId: `fan-${suffix}`, username: `fan${suffix}` })
    .returning({ id: fans.id });
  const [threadRow] = await harness.db
    .insert(pageDmThreads)
    .values({
      platformAccountId: pageId,
      fanId: fanRow!.id,
      platformConversationId: `conv-${suffix}`,
    })
    .returning({ id: pageDmThreads.id });
  return { fanId: fanRow!.id, threadId: threadRow!.id };
}

let messageSeq = 0;
async function insertModelMessage(pageId: number, threadId: number, content: string, createdAt: Date) {
  messageSeq += 1;
  await harness.db.insert(pageDmMessages).values({
    conversationId: threadId,
    platformAccountId: pageId,
    platformMessageId: `msg-${messageSeq}`,
    senderRole: "model",
    createdAt,
    content,
  });
}

describe("workboard v3 broadcast detector (integration)", () => {
  it("groups 12 identical texts sent to 12 threads within an hour", async () => {
    const now = new Date();
    const { page } = await seedPage();

    for (let i = 0; i < 12; i += 1) {
      const { threadId } = await insertFanWithThread(page.id, `a${i}`);
      // Same text modulo case/whitespace — normalization must unify it.
      const text = i % 2 === 0 ? "New PPV just dropped 🔥" : "  new ppv just dropped 🔥 ";
      await insertModelMessage(page.id, threadId, text, new Date(now.getTime() - 50 * MINUTE + i * 4 * MINUTE));
    }

    const result = await detectBroadcastsForPage(harness.db, { platformAccountId: page.id, now });

    expect(result.groupsCreated).toBe(1);
    expect(result.messagesMapped).toBe(12);
    expect(result.touchesCreated).toBe(12);

    const groups = await harness.db.select().from(dmBroadcastGroups);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.messageCount).toBe(12);

    const touches = await harness.db.select().from(workboardV3Touches);
    expect(touches).toHaveLength(12);
    expect(touches.every((t) => t.type === "broadcast")).toBe(true);
    expect(touches.every((t) => t.confirmedAt != null && t.modelMessagePk != null)).toBe(true);

    expect(await getWb3BroadcastWatermark(harness.db, page.id)).not.toBeNull();
  });

  it("does not group 5 identical texts (below the 10-recipient threshold)", async () => {
    const now = new Date();
    const { page } = await seedPage();

    for (let i = 0; i < 5; i += 1) {
      const { threadId } = await insertFanWithThread(page.id, `b${i}`);
      await insertModelMessage(page.id, threadId, "hey babe", new Date(now.getTime() - 30 * MINUTE + i * MINUTE));
    }

    const result = await detectBroadcastsForPage(harness.db, { platformAccountId: page.id, now });

    expect(result.groupsCreated).toBe(0);
    expect(result.messagesMapped).toBe(0);
    expect(result.touchesCreated).toBe(0);
    expect(await harness.db.select().from(dmBroadcastGroups)).toHaveLength(0);
    expect(await harness.db.select().from(workboardV3Touches)).toHaveLength(0);
  });

  it("groups a short manual 'hey' pasted into 30 threads (honestly a broadcast)", async () => {
    const now = new Date();
    const { page } = await seedPage();

    for (let i = 0; i < 30; i += 1) {
      const { threadId } = await insertFanWithThread(page.id, `c${i}`);
      await insertModelMessage(page.id, threadId, "hey", new Date(now.getTime() - 45 * MINUTE + i * MINUTE));
    }

    const result = await detectBroadcastsForPage(harness.db, { platformAccountId: page.id, now });

    expect(result.groupsCreated).toBe(1);
    expect(result.messagesMapped).toBe(30);
    expect(result.touchesCreated).toBe(30);
  });

  it("does not group identical texts spread far beyond the 60-minute window", async () => {
    const now = new Date();
    const { page } = await seedPage();

    // 12 copies spaced 25 minutes apart — every anchored window holds ≤3 threads.
    for (let i = 0; i < 12; i += 1) {
      const { threadId } = await insertFanWithThread(page.id, `d${i}`);
      await insertModelMessage(page.id, threadId, "good morning", new Date(now.getTime() - (12 - i) * 25 * MINUTE));
    }

    const result = await detectBroadcastsForPage(harness.db, { platformAccountId: page.id, now });

    expect(result.groupsCreated).toBe(0);
    expect(result.messagesMapped).toBe(0);
  });

  it("is idempotent across runs and extends groups when a blast straddles two syncs", async () => {
    const now = new Date();
    const { page } = await seedPage();

    const threads: number[] = [];
    for (let i = 0; i < 18; i += 1) {
      const { threadId } = await insertFanWithThread(page.id, `e${i}`);
      threads.push(threadId);
    }

    // First sync delivers 12 copies…
    for (let i = 0; i < 12; i += 1) {
      await insertModelMessage(page.id, threads[i]!, "promo tonight", new Date(now.getTime() - 40 * MINUTE + i * MINUTE));
    }
    const first = await detectBroadcastsForPage(harness.db, { platformAccountId: page.id, now });
    expect(first.groupsCreated).toBe(1);
    expect(first.messagesMapped).toBe(12);

    // …second sync delivers 6 more copies of the same blast a few minutes later.
    for (let i = 12; i < 18; i += 1) {
      await insertModelMessage(page.id, threads[i]!, "promo tonight", new Date(now.getTime() - 28 * MINUTE + (i - 12) * MINUTE));
    }
    const second = await detectBroadcastsForPage(harness.db, { platformAccountId: page.id, now });
    expect(second.groupsCreated).toBe(0);
    expect(second.groupsExtended).toBeGreaterThanOrEqual(1);
    expect(second.messagesMapped).toBe(6);

    const groups = await harness.db.select().from(dmBroadcastGroups);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.messageCount).toBe(18);
    expect(await harness.db.select().from(dmBroadcastMessages)).toHaveLength(18);

    // Third run with nothing new — fully idempotent.
    const third = await detectBroadcastsForPage(harness.db, { platformAccountId: page.id, now });
    expect(third.scanned).toBe(0);
    expect(third.messagesMapped).toBe(0);
    expect(third.touchesCreated).toBe(0);
  });
});
