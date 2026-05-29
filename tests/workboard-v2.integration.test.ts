import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  appendWorkboardContact,
  createFanslyPage,
  createModel,
  fanSpendLifetime,
  fans,
  listWorkboardV2,
  pageDmMessages,
  pageDmThreads,
  pageFans,
  pageSubscriptions,
} from "@agency_hub_core/db";
import { dollarsToMills, toBusinessDate, UTC_TIME_ZONE } from "@agency_hub_core/shared";

import { recomputeWorkboardPage } from "../apps/runtime/src/services/workboard-v2/recompute.ts";
import { runClosingClassificationForPage } from "../apps/runtime/src/services/workboard-v2/classify-closing.ts";
import type { ClosingClassifier } from "../apps/runtime/src/services/workboard-v2/closing-classifier.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

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

async function insertFan(platformUserId: string, username: string): Promise<number> {
  const [row] = await harness.db
    .insert(fans)
    .values({ platform: "fansly", platformUserId, username, displayName: username })
    .returning({ id: fans.id });
  return row!.id;
}

describe("workboard v2 recompute + read (integration)", () => {
  it("routes a renew-off expiring subscriber and a fresh 'hi' fan to separate tabs", async () => {
    const now = new Date();
    const { model, page } = await seedPage();

    // Fan A — renew-off subscriber expiring in 2 days, $1,240 LTV.
    const fanA = await insertFan("fan-a", "amber");
    await harness.db.insert(pageFans).values({
      fanId: fanA,
      platformAccountId: page.id,
      isSubscriber: true,
      subscriptionExpiresAt: new Date(now.getTime() + 2 * DAY),
      autoRenew: false,
      subscriberSince: new Date(now.getTime() - 90 * DAY),
      totalCreatorNetMills: dollarsToMills(1240),
    });
    await harness.db.insert(fanSpendLifetime).values({
      platformAccountId: page.id,
      fanId: fanA,
      creatorNetAmountMills: dollarsToMills(1240),
      lastTransactionAt: new Date(now.getTime() - 10 * DAY),
    });
    await harness.db.insert(pageSubscriptions).values({
      platformSubscriptionId: "sub-a",
      platformAccountId: page.id,
      fanId: fanA,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: dollarsToMills(20),
      renewPriceMills: dollarsToMills(20),
      autoRenew: false,
      isCurrent: true,
      endsAt: new Date(now.getTime() + 2 * DAY),
    });

    // Fan B — fresh follower (2 days), sent "hi" 12h ago, never paid.
    const fanB = await insertFan("fan-b", "kris");
    await harness.db.insert(pageFans).values({
      fanId: fanB,
      platformAccountId: page.id,
      isFollower: true,
      followerSince: new Date(now.getTime() - 2 * DAY),
    });
    await harness.db.insert(pageDmThreads).values({
      platformAccountId: page.id,
      fanId: fanB,
      platformConversationId: "conv-b",
      lastMessageAt: new Date(now.getTime() - 12 * HOUR),
      lastMessageSenderRole: "fan",
      lastFanMessageAt: new Date(now.getTime() - 12 * HOUR),
      lastMessagePreview: "hi",
      storedMessageCount: 1,
      messageCoverageStatus: "partial_window",
      isVisible: true,
    });

    const result = await recomputeWorkboardPage(harness.db, { platformAccountId: page.id, now });
    expect(result.evaluated).toBe(2);

    const subs = await listWorkboardV2(harness.db, {
      platformAccountId: page.id,
      tab: "subscribers",
      limit: 50,
      offset: 0,
    });
    expect(subs.total).toBe(1);
    const subRow = subs.rows[0]!;
    expect(Number(subRow.fan_id)).toBe(fanA);
    expect(Number(subRow.urgency_score)).toBeGreaterThanOrEqual(85);
    expect(subRow.reason_chips).toContain("renew_off");

    const fresh = await listWorkboardV2(harness.db, {
      platformAccountId: page.id,
      tab: "fresh_mass",
      limit: 50,
      offset: 0,
    });
    expect(fresh.total).toBe(1);
    const freshRow = fresh.rows[0]!;
    expect(Number(freshRow.fan_id)).toBe(fanB);
    expect(freshRow.needs_reply).toBe(true);
    expect(Number(freshRow.urgency_score)).toBeLessThanOrEqual(80);

    // Touch log writes cleanly (the load-bearing signal).
    await appendWorkboardContact(harness.db, {
      modelId: model.id,
      platformAccountId: page.id,
      fanId: fanB,
      businessDate: toBusinessDate(now, UTC_TIME_ZONE),
      action: "handled",
      wasProductive: true,
    });
  });

  it("computes a positive conversation-quality score from real messages (Stage 1 cq aggregation)", async () => {
    const now = new Date();
    const { page } = await seedPage();

    // A $150 spender with a balanced, fan-initiated, fast 1:1 exchange.
    const fan = await insertFan("fan-c", "vera");
    await harness.db.insert(pageFans).values({
      fanId: fan,
      platformAccountId: page.id,
      isFollower: true,
      followerSince: new Date(now.getTime() - 60 * DAY),
    });
    await harness.db.insert(fanSpendLifetime).values({
      platformAccountId: page.id,
      fanId: fan,
      creatorNetAmountMills: dollarsToMills(150),
      lastTransactionAt: new Date(now.getTime() - 20 * DAY),
    });
    const [thread] = await harness.db
      .insert(pageDmThreads)
      .values({
        platformAccountId: page.id,
        fanId: fan,
        platformConversationId: "conv-c",
        lastMessageAt: new Date(now.getTime() - 5 * 60_000),
        lastMessageSenderRole: "model",
        lastFanMessageAt: new Date(now.getTime() - 10 * 60_000),
        lastModelMessageAt: new Date(now.getTime() - 5 * 60_000),
        storedMessageCount: 6,
        messageCoverageStatus: "complete",
        isVisible: true,
      })
      .returning({ id: pageDmThreads.id });
    const conversationId = thread!.id;
    const seq: Array<{ role: "fan" | "model"; minsAgo: number }> = [
      { role: "fan", minsAgo: 50 },
      { role: "model", minsAgo: 45 },
      { role: "fan", minsAgo: 30 },
      { role: "model", minsAgo: 25 },
      { role: "fan", minsAgo: 10 },
      { role: "model", minsAgo: 5 },
    ];
    await harness.db.insert(pageDmMessages).values(
      seq.map((m, i) => ({
        conversationId,
        platformAccountId: page.id,
        platformMessageId: `m-${i}`,
        senderRole: m.role,
        createdAt: new Date(now.getTime() - m.minsAgo * 60_000),
        content: m.role === "fan" ? "tell me more about tonight" : "of course babe",
      })),
    );

    await recomputeWorkboardPage(harness.db, { platformAccountId: page.id, now });

    const spenders = await listWorkboardV2(harness.db, { platformAccountId: page.id, tab: "spenders", limit: 50, offset: 0 });
    expect(spenders.total).toBe(1);
    const row = spenders.rows[0]!;
    expect(Number(row.fan_id)).toBe(fan);
    expect(row.q_score).not.toBeNull();
    expect(Number(row.q_score)).toBeGreaterThan(0.5); // balanced + fan-first + fast = warm
  });

  it("L2 classifier cleans the >24h tail: L1 closings are skipped, verdicts gate needs_reply", async () => {
    const now = new Date();
    const { page } = await seedPage();

    async function seedTail(handle: string, messageId: string, preview: string) {
      const id = await insertFan(handle, handle);
      await harness.db.insert(pageFans).values({ fanId: id, platformAccountId: page.id, isFollower: true, followerSince: new Date(now.getTime() - 3 * DAY) });
      await harness.db.insert(pageDmThreads).values({
        platformAccountId: page.id,
        fanId: id,
        platformConversationId: `conv-${handle}`,
        lastMessageId: messageId,
        lastMessageAt: new Date(now.getTime() - 48 * HOUR),
        lastMessageSenderRole: "fan",
        lastFanMessageAt: new Date(now.getTime() - 48 * HOUR),
        lastMessagePreview: preview,
        storedMessageCount: 3,
        messageCoverageStatus: "complete",
        isVisible: true,
      });
      return id;
    }

    const fanQuestion = await seedTail("ask", "msg-q", "when are you free tonight?");
    const fanWarmClose = await seedTail("warm", "msg-w", "you're amazing 🥰");
    const fanThanks = await seedTail("thx", "msg-t", "thanks"); // L1 closing → must NOT be classified

    const classified: string[] = [];
    const fakeClassifier: ClosingClassifier = {
      model: "fake-haiku",
      async classifyBatch(messages) {
        for (const m of messages) classified.push(m.id);
        return {
          verdicts: messages.map((m) => ({ id: m.id, needsReply: m.content.includes("free") })),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };

    const result = await runClosingClassificationForPage(harness.db, fakeClassifier, {
      platformAccountId: page.id,
      now,
      capMin: 50,
      capMax: 400,
    });

    // L1 "thanks" filtered out before any API call; the two L1-undecided tails classified.
    expect(classified.sort()).toEqual(["msg-q", "msg-w"]);
    expect(result.classified).toBe(2);

    await recomputeWorkboardPage(harness.db, { platformAccountId: page.id, now });
    const fresh = await listWorkboardV2(harness.db, { platformAccountId: page.id, tab: "fresh_mass", limit: 50, offset: 0 });
    const byId = new Map(fresh.rows.map((r) => [Number(r.fan_id), r]));

    expect(byId.get(fanQuestion)?.needs_reply).toBe(true); // classifier said needs reply
    expect(byId.get(fanWarmClose)?.needs_reply).toBe(false); // classifier said closing
    expect(byId.get(fanThanks)?.needs_reply).toBe(false); // L1 closing
  });
});
