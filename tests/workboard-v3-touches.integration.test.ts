import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createWb3BroadcastGroup,
  fans,
  mapWb3BroadcastMessages,
  pageDmMessages,
  pageDmThreads,
  users,
  workboardSnoozes,
  workboardV3PlanItems,
  workboardV3Shifts,
  workboardV3Touches,
} from "@agency_hub_core/db";

import {
  completeWb3TouchManually,
  confirmWb3TouchesForPage,
  openWb3Touch,
  skipWb3PlanItem,
  snoozeWb3Fan,
} from "../apps/runtime/src/services/workboard-v3/touches.ts";
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

async function insertFanWithThread(pageId: number, suffix: string) {
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
  const [row] = await harness.db
    .insert(pageDmMessages)
    .values({
      conversationId: threadId,
      platformAccountId: pageId,
      platformMessageId: `msg-${messageSeq}`,
      senderRole: "model",
      createdAt,
      content,
    })
    .returning({ id: pageDmMessages.id });
  return row!.id;
}

describe("workboard v3 touches (integration)", () => {
  it("confirms an open touch with a model message inside the 6h window", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const { fanId, threadId } = await insertFanWithThread(page.id, "a");

    const openedAt = new Date(now.getTime() - 2 * HOUR);
    const { touchId } = await openWb3Touch(harness.db, {
      platformAccountId: page.id,
      fanId,
      now: openedAt,
    });

    const messageAt = new Date(now.getTime() - HOUR);
    const messagePk = await insertModelMessage(page.id, threadId, "hey love, missed you", messageAt);

    const result = await confirmWb3TouchesForPage(harness.db, { platformAccountId: page.id, now });
    expect(result.confirmed).toBe(1);

    const touch = (await harness.db.select().from(workboardV3Touches)).find((t) => t.id === touchId);
    expect(touch!.type).toBe("personal");
    expect(touch!.confirmedAt?.getTime()).toBe(messageAt.getTime());
    expect(touch!.modelMessagePk).toBe(messagePk);
  });

  it("ignores broadcast-flagged messages and messages outside the window", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const { fanId, threadId } = await insertFanWithThread(page.id, "b");

    const openedAt = new Date(now.getTime() - 10 * HOUR);
    await openWb3Touch(harness.db, { platformAccountId: page.id, fanId, now: openedAt });

    // Message before the touch — never confirms.
    await insertModelMessage(page.id, threadId, "earlier note", new Date(openedAt.getTime() - HOUR));
    // Message past the 6h window — never confirms.
    await insertModelMessage(page.id, threadId, "too late", new Date(openedAt.getTime() + 7 * HOUR));
    // Message inside the window but part of a broadcast — never confirms.
    const blastPk = await insertModelMessage(page.id, threadId, "promo blast", new Date(openedAt.getTime() + HOUR));
    const groupId = await createWb3BroadcastGroup(harness.db, {
      platformAccountId: page.id,
      contentHash: "hash-blast",
      firstSentAt: new Date(openedAt.getTime() + HOUR),
      lastSentAt: new Date(openedAt.getTime() + HOUR),
    });
    await mapWb3BroadcastMessages(harness.db, { groupId, messagePks: [blastPk] });

    const result = await confirmWb3TouchesForPage(harness.db, { platformAccountId: page.id, now });
    expect(result.confirmed).toBe(0);

    const touches = await harness.db.select().from(workboardV3Touches);
    expect(touches).toHaveLength(1);
    expect(touches[0]!.confirmedAt).toBeNull();
  });

  it("converts an open touch to manual on Готово and creates one when none is open", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const { fanId } = await insertFanWithThread(page.id, "c");

    await openWb3Touch(harness.db, { platformAccountId: page.id, fanId, now: new Date(now.getTime() - HOUR) });
    const converted = await completeWb3TouchManually(harness.db, { platformAccountId: page.id, fanId, now });

    let touches = await harness.db.select().from(workboardV3Touches);
    expect(touches).toHaveLength(1);
    expect(touches[0]!.id).toBe(converted.touchId);
    expect(touches[0]!.type).toBe("manual");
    expect(touches[0]!.confirmedAt?.getTime()).toBe(now.getTime());

    // No open touch left — Готово records a fresh manual touch.
    const fresh = await completeWb3TouchManually(harness.db, { platformAccountId: page.id, fanId, now });
    expect(fresh.touchId).not.toBe(converted.touchId);
    touches = await harness.db.select().from(workboardV3Touches);
    expect(touches).toHaveLength(2);

    // The confirm job has nothing personal left to confirm.
    const result = await confirmWb3TouchesForPage(harness.db, { platformAccountId: page.id, now });
    expect(result.confirmed).toBe(0);
  });

  it("auto-closes the shift's plan items when a touch confirms; skip and snooze close without touches", async () => {
    const now = new Date();
    const { page } = await seedPage();
    const { fanId, threadId } = await insertFanWithThread(page.id, "d");
    const { fanId: otherFanId } = await insertFanWithThread(page.id, "e");

    const [user] = await harness.db
      .insert(users)
      .values({ username: "chatter-ivan", passwordHash: "x", role: "chatter" })
      .returning({ id: users.id });
    const [shift] = await harness.db
      .insert(workboardV3Shifts)
      .values({ platformAccountId: page.id, chatterUserId: user!.id })
      .returning({ id: workboardV3Shifts.id });

    const [planItem] = await harness.db
      .insert(workboardV3PlanItems)
      .values({ shiftId: shift!.id, fanId, reason: "cadence_due", section: "scheduled" })
      .returning({ id: workboardV3PlanItems.id });
    const [skipItem] = await harness.db
      .insert(workboardV3PlanItems)
      .values({ shiftId: shift!.id, fanId: otherFanId, reason: "gray_touch", section: "scheduled" })
      .returning({ id: workboardV3PlanItems.id });
    const [snoozeItem] = await harness.db
      .insert(workboardV3PlanItems)
      .values({ shiftId: shift!.id, fanId: otherFanId, reason: "cadence_due", section: "scheduled" })
      .returning({ id: workboardV3PlanItems.id });

    // Open → in_progress.
    const openedAt = new Date(now.getTime() - 2 * HOUR);
    await openWb3Touch(harness.db, {
      platformAccountId: page.id,
      fanId,
      shiftId: shift!.id,
      chatterUserId: user!.id,
      planItemId: planItem!.id,
      now: openedAt,
    });
    let item = (await harness.db.select().from(workboardV3PlanItems)).find((i) => i.id === planItem!.id);
    expect(item!.status).toBe("in_progress");

    // Sync confirmation closes the item with the touch reference.
    await insertModelMessage(page.id, threadId, "personal reply", new Date(now.getTime() - HOUR));
    const result = await confirmWb3TouchesForPage(harness.db, { platformAccountId: page.id, now });
    expect(result.confirmed).toBe(1);
    expect(result.planItemsResolved).toBe(1);
    item = (await harness.db.select().from(workboardV3PlanItems)).find((i) => i.id === planItem!.id);
    expect(item!.status).toBe("done");
    expect(item!.resolvedByTouchId).not.toBeNull();

    // Skip closes with a reason and creates no touch.
    await skipWb3PlanItem(harness.db, { planItemId: skipItem!.id, reason: "bad_timing", now });
    const skipped = (await harness.db.select().from(workboardV3PlanItems)).find((i) => i.id === skipItem!.id);
    expect(skipped!.status).toBe("skipped");
    expect(skipped!.skipReason).toBe("bad_timing");

    // Snooze upserts workboard_snoozes with the new reason column.
    const until = new Date(now.getTime() + 3 * DAY);
    await snoozeWb3Fan(harness.db, {
      platformAccountId: page.id,
      fanId: otherFanId,
      snoozedUntil: until,
      reason: "asked to wait",
      planItemId: snoozeItem!.id,
      now,
    });
    const snoozed = (await harness.db.select().from(workboardV3PlanItems)).find((i) => i.id === snoozeItem!.id);
    expect(snoozed!.status).toBe("snoozed");
    const snoozes = await harness.db.select().from(workboardSnoozes);
    expect(snoozes).toHaveLength(1);
    expect(snoozes[0]!.reason).toBe("asked to wait");
    expect(snoozes[0]!.snoozedUntil.getTime()).toBe(until.getTime());

    const touches = await harness.db.select().from(workboardV3Touches);
    expect(touches).toHaveLength(1);
  });
});
