import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  fanDossiers,
  fans,
  pageDmMessages,
  pageDmThreads,
  pageFans,
  transactions,
  workboardV3FanState,
  workboardV3Touches,
} from "@agency_hub_core/db";
import { dollarsToMills } from "@agency_hub_core/shared";

import { recomputeWb3Page } from "../apps/runtime/src/services/workboard-v3/recompute.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

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

let fanSeq = 0;
async function insertFan(pageId: number, pageFanValues: Record<string, unknown> = {}) {
  fanSeq += 1;
  const [fanRow] = await harness.db
    .insert(fans)
    .values({ platform: "fansly", platformUserId: `fan-${fanSeq}`, username: `fan${fanSeq}` })
    .returning({ id: fans.id });
  await harness.db.insert(pageFans).values({
    fanId: fanRow!.id,
    platformAccountId: pageId,
    ...pageFanValues,
  });
  return fanRow!.id;
}

async function insertThread(pageId: number, fanId: number, values: Record<string, unknown> = {}) {
  fanSeq += 1;
  const [row] = await harness.db
    .insert(pageDmThreads)
    .values({
      platformAccountId: pageId,
      fanId,
      platformConversationId: `conv-${fanSeq}`,
      ...values,
    })
    .returning({ id: pageDmThreads.id });
  return row!.id;
}

let messageSeq = 0;
async function insertFanMessage(pageId: number, threadId: number, content: string, createdAt: Date) {
  messageSeq += 1;
  await harness.db.insert(pageDmMessages).values({
    conversationId: threadId,
    platformAccountId: pageId,
    platformMessageId: `m-${messageSeq}`,
    senderRole: "fan",
    createdAt,
    content,
  });
}

let txnSeq = 0;
async function insertPurchase(pageId: number, fanId: number, mills: number | bigint, occurredAt: Date) {
  txnSeq += 1;
  await harness.db.insert(transactions).values({
    platformAccountId: pageId,
    fanId,
    transactionId: `txn-${txnSeq}`,
    rawType: "tip",
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: "ok",
    grossAmountMills: BigInt(mills),
    sourceDestinationAmountMills: BigInt(mills),
    creatorNetAmountMills: BigInt(mills),
    occurredAt,
  });
}

async function insertTouch(
  pageId: number,
  fanId: number,
  type: "personal" | "manual" | "broadcast",
  confirmedAt: Date,
) {
  await harness.db.insert(workboardV3Touches).values({
    platformAccountId: pageId,
    fanId,
    type,
    openedAt: type === "personal" ? new Date(confirmedAt.getTime() - HOUR) : null,
    confirmedAt,
    createdAt: confirmedAt,
  });
}

async function stateOf(pageId: number, fanId: number) {
  const rows = await harness.db.select().from(workboardV3FanState);
  return rows.find((r) => r.platformAccountId === pageId && r.fanId === fanId);
}

describe("workboard v3 recompute FSM (integration)", () => {
  it("moves a gray fan to spender instantly on a settled purchase", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const fanId = await insertFan(page.id, {
      isFollower: true,
      followerSince: new Date(now.getTime() - 100 * DAY),
    });

    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });
    expect((await stateOf(page.id, fanId))!.segment).toBe("gray");

    await insertPurchase(page.id, fanId, dollarsToMills(45), new Date(now.getTime() - HOUR));
    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });
    expect((await stateOf(page.id, fanId))!.segment).toBe("spender");
  });

  it("moves an expired subscriber to spender (paid by definition)", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const fanId = await insertFan(page.id, {
      isSubscriber: true,
      totalCreatorNetMills: dollarsToMills(120),
      subscriptionExpiresAt: new Date(now.getTime() + 5 * DAY),
    });

    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });
    expect((await stateOf(page.id, fanId))!.segment).toBe("subscriber");

    await harness.pool.query(
      "update page_fans set is_subscriber = false, subscription_expires_at = $1 where fan_id = $2",
      [new Date(now.getTime() - DAY), fanId],
    );
    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });
    expect((await stateOf(page.id, fanId))!.segment).toBe("spender");
  });

  it("kills a fan after 5 personal touches with zero replies — broadcasts do not count", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const fanId = await insertFan(page.id, {
      isFollower: true,
      followerSince: new Date(now.getTime() - 60 * DAY),
    });

    // 4 personal + a pile of broadcasts → still alive (gray).
    for (let i = 0; i < 4; i += 1) {
      await insertTouch(page.id, fanId, i % 2 === 0 ? "personal" : "manual", new Date(now.getTime() - (40 - i * 5) * DAY));
    }
    for (let i = 0; i < 6; i += 1) {
      await insertTouch(page.id, fanId, "broadcast", new Date(now.getTime() - (30 - i) * DAY));
    }
    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });
    let state = await stateOf(page.id, fanId);
    expect(state!.segment).toBe("gray");
    expect(state!.deadAttempts).toBe(4);

    // The 5th personal attempt flips dead and starts the 75d sleep.
    const fifthAt = new Date(now.getTime() - 10 * DAY);
    await insertTouch(page.id, fanId, "personal", fifthAt);
    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });
    state = await stateOf(page.id, fanId);
    expect(state!.segment).toBe("dead");
    expect(state!.deadAttempts).toBe(5);
    expect(state!.deadSleepUntil?.getTime()).toBe(fifthAt.getTime() + 75 * DAY);

    // Any fan message resurrects.
    const threadId = await insertThread(page.id, fanId, {
      lastFanMessageAt: new Date(now.getTime() - HOUR),
    });
    await insertFanMessage(page.id, threadId, "wait, what do you offer?", new Date(now.getTime() - HOUR));
    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });
    state = await stateOf(page.id, fanId);
    expect(state!.segment).toBe("mass_active");
    expect(state!.deadAttempts).toBe(0);
    expect(state!.deadSleepUntil).toBeNull();
  });

  it("demotes mass_active to gray after 60d of silence, keeping has_ever_replied", async () => {
    const now = new Date();
    const { page } = await seedPage();

    // Fan A: meaningful reply 70 days ago → gray, has_ever_replied survives.
    const fanA = await insertFan(page.id, {
      isFollower: true,
      followerSince: new Date(now.getTime() - 200 * DAY),
    });
    const threadA = await insertThread(page.id, fanA, {
      lastFanMessageAt: new Date(now.getTime() - 70 * DAY),
    });
    await insertFanMessage(page.id, threadA, "i love your fitness sets", new Date(now.getTime() - 70 * DAY));

    // Fan B: meaningful reply 10 days ago → mass_active.
    const fanB = await insertFan(page.id, {
      isFollower: true,
      followerSince: new Date(now.getTime() - 200 * DAY),
    });
    const threadB = await insertThread(page.id, fanB, {
      lastFanMessageAt: new Date(now.getTime() - 10 * DAY),
    });
    await insertFanMessage(page.id, threadB, "when is the next stream?", new Date(now.getTime() - 10 * DAY));

    // Fan C: only a closing "ok" 10 days ago → never promoted, stays gray.
    const fanC = await insertFan(page.id, {
      isFollower: true,
      followerSince: new Date(now.getTime() - 200 * DAY),
    });
    const threadC = await insertThread(page.id, fanC, {
      lastFanMessageAt: new Date(now.getTime() - 10 * DAY),
    });
    await insertFanMessage(page.id, threadC, "ok", new Date(now.getTime() - 10 * DAY));

    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });

    const stateA = await stateOf(page.id, fanA);
    expect(stateA!.segment).toBe("gray");
    expect(stateA!.hasEverReplied).toBe(true);

    expect((await stateOf(page.id, fanB))!.segment).toBe("mass_active");

    const stateC = await stateOf(page.id, fanC);
    expect(stateC!.segment).toBe("gray");
    expect(stateC!.hasEverReplied).toBe(false);
  });

  it("doubles the cadence for a sour dossier ending", async () => {
    const now = new Date();
    const { page } = await seedPage();
    // Core spender ($30 LTV, last purchase 90d ago) → 14d cadence, sour → 28d.
    const fanId = await insertFan(page.id, {
      totalCreatorNetMills: dollarsToMills(30),
    });
    await insertPurchase(page.id, fanId, dollarsToMills(30), new Date(now.getTime() - 90 * DAY));
    const touchedAt = new Date(now.getTime() - 1 * DAY);
    await insertTouch(page.id, fanId, "manual", touchedAt);
    await harness.db.insert(fanDossiers).values({
      platformAccountId: page.id,
      fanId,
      dossier: {
        gist: "asked about customs",
        interests: [],
        hooks: [],
        ending: "sour",
        ending_note: "felt pushed",
        language: "en",
      },
      source: "history",
    });

    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });
    const state = await stateOf(page.id, fanId);
    expect(state!.segment).toBe("spender");
    expect(state!.cadenceDueAt?.getTime()).toBe(touchedAt.getTime() + 28 * DAY);
  });

  it("flags a freeloader on 10 dialog days within the sliding 90d window", async () => {
    const now = new Date();
    const { page } = await seedPage();

    // Fan A: 10 dialog days (2 meaningful msgs each) inside 90d → freeloader.
    const fanA = await insertFan(page.id, {
      isFollower: true,
      followerSince: new Date(now.getTime() - 300 * DAY),
    });
    const threadA = await insertThread(page.id, fanA, {
      lastFanMessageAt: new Date(now.getTime() - DAY),
    });
    for (let day = 0; day < 10; day += 1) {
      const base = now.getTime() - (day * 8 + 1) * DAY;
      await insertFanMessage(page.id, threadA, `tell me about set ${day}`, new Date(base));
      await insertFanMessage(page.id, threadA, `and what about customs ${day}`, new Date(base + HOUR));
    }

    // Fan B: same pattern but 2 of the 10 days slid out of the 90d window.
    const fanB = await insertFan(page.id, {
      isFollower: true,
      followerSince: new Date(now.getTime() - 300 * DAY),
    });
    const threadB = await insertThread(page.id, fanB, {
      lastFanMessageAt: new Date(now.getTime() - DAY),
    });
    for (let day = 0; day < 8; day += 1) {
      const base = now.getTime() - (day * 8 + 1) * DAY;
      await insertFanMessage(page.id, threadB, `question ${day}`, new Date(base));
      await insertFanMessage(page.id, threadB, `another question ${day}`, new Date(base + HOUR));
    }
    for (let day = 0; day < 2; day += 1) {
      const base = now.getTime() - (95 + day * 3) * DAY;
      await insertFanMessage(page.id, threadB, `old question ${day}`, new Date(base));
      await insertFanMessage(page.id, threadB, `old follow-up ${day}`, new Date(base + HOUR));
    }

    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });

    const stateA = await stateOf(page.id, fanA);
    expect(stateA!.segment).toBe("mass_active");
    expect(stateA!.freeloader).toBe(true);

    const stateB = await stateOf(page.id, fanB);
    expect(stateB!.segment).toBe("mass_active");
    expect(stateB!.freeloader).toBe(false);
  });

  it("stamps touch outcomes and derives response_rate_90d", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const fanId = await insertFan(page.id, {
      totalCreatorNetMills: dollarsToMills(60),
    });
    const threadId = await insertThread(page.id, fanId, {
      lastFanMessageAt: new Date(now.getTime() - 3 * DAY),
    });

    // Touch 1 (5d ago): fan replied 1d later, bought 2d later → replied + purchase.
    const touch1At = new Date(now.getTime() - 5 * DAY);
    await insertTouch(page.id, fanId, "personal", touch1At);
    await insertFanMessage(page.id, threadId, "you got me, sending a tip", new Date(touch1At.getTime() + DAY));
    await insertPurchase(page.id, fanId, dollarsToMills(20), new Date(touch1At.getTime() + 2 * DAY));

    // Touch 2 (4d ago, after the reply): no reply within 72h → silent.
    const touch2At = new Date(now.getTime() - 4 * DAY + 2 * HOUR);
    await insertTouch(page.id, fanId, "manual", touch2At);

    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });

    const touches = await harness.db.select().from(workboardV3Touches);
    const t1 = touches.find((t) => t.confirmedAt?.getTime() === touch1At.getTime());
    expect(t1!.outcomeComputedAt).not.toBeNull();
    expect(t1!.outcomeRepliedAt?.getTime()).toBe(touch1At.getTime() + DAY);
    expect(t1!.outcomePurchaseAt?.getTime()).toBe(touch1At.getTime() + 2 * DAY);
    const t2 = touches.find((t) => t.confirmedAt?.getTime() === touch2At.getTime());
    expect(t2!.outcomeComputedAt).not.toBeNull();
    expect(t2!.outcomeRepliedAt).toBeNull();

    const state = await stateOf(page.id, fanId);
    expect(state!.responseRate90d).toBe(0.5);
  });

  it("schedules the fresh 0/+1/+3 warm-up and lets a broadcast close day 0", async () => {
    const now = new Date();
    const { page } = await seedPage();

    // Followed 2h ago, untouched → day-0 welcome due at follow time.
    const followedAt = new Date(now.getTime() - 2 * HOUR);
    const fanA = await insertFan(page.id, { isFollower: true, followerSince: followedAt });

    // Followed 2h ago, welcome broadcast went out 1h ago → next due at +1d.
    const fanB = await insertFan(page.id, { isFollower: true, followerSince: followedAt });
    await insertTouch(page.id, fanB, "broadcast", new Date(now.getTime() - HOUR));

    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });

    const stateA = await stateOf(page.id, fanA);
    expect(stateA!.segment).toBe("fresh");
    expect(stateA!.cadenceDueAt?.getTime()).toBe(followedAt.getTime());

    const stateB = await stateOf(page.id, fanB);
    expect(stateB!.segment).toBe("fresh");
    expect(stateB!.cadenceDueAt?.getTime()).toBe(followedAt.getTime() + DAY);
  });
});
