import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  appendWorkboardContact,
  countOldMassContactsToday,
  createFanslyPage,
  createModel,
  fanSpendLifetime,
  fans,
  finishClassifierRun,
  getActiveClassifierRun,
  getClosingSettings,
  getLlmUsageDaily,
  insertClassifierRun,
  insertClassifierRunRunningIfIdle,
  listRecentClosingVerdicts,
  listSpenderDiagnosisRows,
  listWorkboardRecomputePageIds,
  listClassifierRuns,
  listWorkboardSpenderBands,
  listWorkboardV2,
  markReactivationAttemptedIfDead,
  pageDmMessages,
  pageDmThreads,
  pageFans,
  pageSubscriptions,
  retractLastWorkboardContact,
  supersedeClosingCacheForPage,
  upsertClosingSettings,
} from "@agency_hub_core/db";
import { dollarsToMills, SPENDER_AUTO_LIST_BUCKETS, toBusinessDate, UTC_TIME_ZONE } from "@agency_hub_core/shared";

import { recomputeWorkboardPage } from "../apps/runtime/src/services/workboard-v2/recompute.ts";
import { CLOSING_CLASSIFIER_FEATURE, runClosingClassificationForPage } from "../apps/runtime/src/services/workboard-v2/classify-closing.ts";
import type { ClosingClassifier } from "../apps/runtime/src/services/workboard-v2/closing-classifier.ts";
import { summarizeSpenderDiagnostics } from "../apps/runtime/src/services/workboard-v2/spender-diagnostics.ts";
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
      actedByUserId: null,
    });
  });

  it("excludes deleted fans from Workboard v2 and prunes stale derived rows", async () => {
    const now = new Date();
    const { page } = await seedPage();

    const activeFan = await insertFan("active-spender", "active");
    const [deletedRow] = await harness.db
      .insert(fans)
      .values({
        platform: "fansly",
        platformUserId: "deleted-spender",
        username: "deleted",
        displayName: "deleted",
        deletedDetectedAt: now,
        deletedLastDetectedAt: now,
      })
      .returning({ id: fans.id });
    const deletedFan = deletedRow!.id;

    await harness.db.insert(pageFans).values([
      { fanId: activeFan, platformAccountId: page.id, isFollower: true },
      { fanId: deletedFan, platformAccountId: page.id, isFollower: true },
    ]);
    await harness.db.insert(fanSpendLifetime).values([
      {
        platformAccountId: page.id,
        fanId: activeFan,
        creatorNetAmountMills: dollarsToMills(150),
        lastTransactionAt: new Date(now.getTime() - DAY),
      },
      {
        platformAccountId: page.id,
        fanId: deletedFan,
        creatorNetAmountMills: dollarsToMills(200),
        lastTransactionAt: new Date(now.getTime() - DAY),
      },
    ]);

    await harness.pool.query(
      `
      insert into workboard_state (
        platform_account_id, fan_id, tab,
        value_score, urgency_score, rank_score, secondary_status
      )
      values (
        $1, $2, 'spenders'::workboard_tab,
        10, 10, 10, 'due_now'::workboard_secondary_status
      )
      `,
      [page.id, deletedFan],
    );

    const result = await recomputeWorkboardPage(harness.db, { platformAccountId: page.id, now });
    expect(result.evaluated).toBe(1);

    const spenders = await listWorkboardV2(harness.db, {
      platformAccountId: page.id,
      tab: "spenders",
      limit: 50,
      offset: 0,
    });
    expect(spenders.total).toBe(1);
    expect(Number(spenders.rows[0]!.fan_id)).toBe(activeFan);

    const stale = await harness.pool.query<{ count: string }>(
      "select count(*) from workboard_state where platform_account_id = $1 and fan_id = $2",
      [page.id, deletedFan],
    );
    expect(Number(stale.rows[0]?.count ?? 0)).toBe(0);
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

  it("keeps freeloader episodes idempotent when no new meaningful conversation happened", async () => {
    const now = new Date("2026-05-29T12:00:00.000Z");
    const { page } = await seedPage();
    const fan = await insertFan("fan-free", "mira");
    await harness.db.insert(pageFans).values({
      fanId: fan,
      platformAccountId: page.id,
      isFollower: true,
      followerSince: new Date(now.getTime() - 20 * DAY),
    });
    const [thread] = await harness.db
      .insert(pageDmThreads)
      .values({
        platformAccountId: page.id,
        fanId: fan,
        platformConversationId: "conv-free",
        lastMessageAt: new Date(now.getTime() - 3 * DAY),
        lastMessageSenderRole: "fan",
        lastFanMessageAt: new Date(now.getTime() - 3 * DAY),
        lastModelMessageAt: new Date(now.getTime() - 3 * DAY - HOUR),
        lastMessagePreview: "still around?",
        storedMessageCount: 3,
        messageCoverageStatus: "complete",
        isVisible: true,
      })
      .returning({ id: pageDmThreads.id });
    await harness.db.insert(pageDmMessages).values([
      {
        conversationId: thread!.id,
        platformAccountId: page.id,
        platformMessageId: "free-1",
        senderRole: "fan",
        createdAt: new Date(now.getTime() - 3 * DAY - 2 * HOUR),
        content: "hey",
      },
      {
        conversationId: thread!.id,
        platformAccountId: page.id,
        platformMessageId: "free-2",
        senderRole: "model",
        createdAt: new Date(now.getTime() - 3 * DAY - HOUR),
        content: "hi babe",
      },
      {
        conversationId: thread!.id,
        platformAccountId: page.id,
        platformMessageId: "free-3",
        senderRole: "fan",
        createdAt: new Date(now.getTime() - 3 * DAY),
        content: "still around?",
      },
    ]);

    await recomputeWorkboardPage(harness.db, { platformAccountId: page.id, now });
    await recomputeWorkboardPage(harness.db, { platformAccountId: page.id, now: new Date(now.getTime() + DAY) });

    const result = await harness.pool.query<{ episodes: string[]; lifetime: number }>(
      `
      select freeloader_episodes as episodes, lifetime_free_episodes::int as lifetime
      from workboard_state
      where platform_account_id = $1 and fan_id = $2
    `,
      [page.id, fan],
    );
    expect(result.rows[0]?.episodes).toHaveLength(1);
    expect(result.rows[0]?.lifetime).toBe(1);
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
          verdicts: messages.map((m) => {
            // The classifier now sees the conversation context (last entry = the fan tail).
            const text = m.context.map((c) => c.text).join(" ");
            const needsReply = text.includes("free");
            return {
              id: m.id,
              needsReply,
              state: needsReply ? ("question" as const) : ("closing" as const),
              reason: needsReply ? "asked a question" : "just a warm goodbye",
            };
          }),
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

    // Parameterized secondary_status filter returns a correct subset (no raw interpolation).
    const onlyNeedReply = await listWorkboardV2(harness.db, {
      platformAccountId: page.id,
      tab: "fresh_mass",
      statuses: ["need_reply"],
      limit: 50,
      offset: 0,
    });
    expect(onlyNeedReply.rows.length).toBeGreaterThan(0);
    expect(onlyNeedReply.rows.every((r) => r.secondary_status === "need_reply")).toBe(true);
  });

  it("undo retracts the last contact instead of deleting it (Stage 2)", async () => {
    const { model, page } = await seedPage();
    const fan = await insertFan("undo-fan", "undo_fan");
    const businessDate = "2026-07-05";

    await appendWorkboardContact(harness.db, {
      modelId: model.id,
      platformAccountId: page.id,
      fanId: fan,
      businessDate,
      action: "handled",
      wasProductive: true,
      actedByUserId: null,
    });
    await appendWorkboardContact(harness.db, {
      modelId: model.id,
      platformAccountId: page.id,
      fanId: fan,
      businessDate,
      action: "handled",
      wasProductive: true,
      actedByUserId: null,
    });
    // Old-mass state row so the residual-cap read (countOldMassContactsToday)
    // counts this fan's touches.
    await harness.pool.query(
      `insert into workboard_state (platform_account_id, fan_id, tab)
       values ($1, $2, 'old_mass'::workboard_tab)`,
      [page.id, fan],
    );
    expect(await countOldMassContactsToday(harness.db, page.id, businessDate)).toBe(2);

    await retractLastWorkboardContact(harness.db, page.id, fan);

    // The row is retracted, not gone — and reads exclude it.
    const rows = await harness.pool.query<{ total: string; active: string }>(
      `select count(*)::text as total,
              count(*) filter (where retracted_at is null)::text as active
       from workboard_contact_log
       where platform_account_id = $1 and fan_id = $2`,
      [page.id, fan],
    );
    expect(rows.rows[0]).toEqual({ total: "2", active: "1" });
    expect(await countOldMassContactsToday(harness.db, page.id, businessDate)).toBe(1);

    // A second undo retracts the remaining contact; both rows stay retained.
    await retractLastWorkboardContact(harness.db, page.id, fan);
    const after = await harness.pool.query<{ total: string; active: string }>(
      `select count(*)::text as total,
              count(*) filter (where retracted_at is null)::text as active
       from workboard_contact_log
       where platform_account_id = $1 and fan_id = $2`,
      [page.id, fan],
    );
    expect(after.rows[0]).toEqual({ total: "2", active: "0" });
    expect(await countOldMassContactsToday(harness.db, page.id, businessDate)).toBe(0);
  });

  it("reclassify supersedes cached verdicts and lets a fresh run write new rows (Stage 2)", async () => {
    const now = new Date();
    const { page } = await seedPage();

    const fan = await insertFan("resup", "resup");
    await harness.db.insert(pageFans).values({ fanId: fan, platformAccountId: page.id, isFollower: true, followerSince: new Date(now.getTime() - 3 * DAY) });
    await harness.db.insert(pageDmThreads).values({
      platformAccountId: page.id,
      fanId: fan,
      platformConversationId: "conv-resup",
      lastMessageId: "msg-resup",
      lastMessageAt: new Date(now.getTime() - 48 * HOUR),
      lastMessageSenderRole: "fan",
      lastFanMessageAt: new Date(now.getTime() - 48 * HOUR),
      lastMessagePreview: "what do you think about my idea?",
      storedMessageCount: 3,
      messageCoverageStatus: "complete",
      isVisible: true,
    });

    function classifierSaying(needsReply: boolean): ClosingClassifier {
      return {
        model: "fake-haiku",
        async classifyBatch(messages) {
          return {
            verdicts: messages.map((m) => ({
              id: m.id,
              needsReply,
              state: needsReply ? ("question" as const) : ("closing" as const),
              reason: needsReply ? "second look: a real question" : "first pass: warm goodbye",
            })),
            inputTokens: 1,
            outputTokens: 1,
          };
        },
      };
    }

    const first = await runClosingClassificationForPage(harness.db, classifierSaying(false), {
      platformAccountId: page.id,
      now,
      capMin: 50,
      capMax: 400,
    });
    expect(first.classified).toBe(1);

    const superseded = await supersedeClosingCacheForPage(harness.db, page.id);
    expect(superseded).toBe(1);

    // The prior verdict is retained (superseded), not deleted…
    const afterSupersede = await harness.pool.query<{ total: string; active: string }>(
      `select count(*)::text as total,
              count(*) filter (where superseded_at is null)::text as active
       from wb_closing_cache
       where platform_account_id = $1`,
      [page.id],
    );
    expect(afterSupersede.rows[0]).toEqual({ total: "1", active: "0" });

    // …the message becomes a candidate again, and the fresh run inserts a new row.
    const second = await runClosingClassificationForPage(harness.db, classifierSaying(true), {
      platformAccountId: page.id,
      now,
      capMin: 50,
      capMax: 400,
    });
    expect(second.classified).toBe(1);

    const afterRerun = await harness.pool.query<{ total: string; active: string }>(
      `select count(*)::text as total,
              count(*) filter (where superseded_at is null)::text as active
       from wb_closing_cache
       where platform_account_id = $1`,
      [page.id],
    );
    expect(afterRerun.rows[0]).toEqual({ total: "2", active: "1" });

    // Reads return only the fresh verdict.
    const verdicts = await listRecentClosingVerdicts(harness.db, page.id, 10);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      platform_message_id: "msg-resup",
      needs_reply: true,
      state: "question",
    });
  });

  it("classifies fresh spender fan-last tails for spender diagnostics", async () => {
    const now = new Date();
    const { page } = await seedPage();

    async function seedVisibleFan(
      handle: string,
      input: { paid: boolean; lastRole: "fan" | "model"; messageId: string; preview: string },
    ) {
      const id = await insertFan(`fan-${handle}`, handle);
      await harness.db.insert(pageFans).values({
        fanId: id,
        platformAccountId: page.id,
        isFollower: true,
        followerSince: new Date(now.getTime() - 40 * DAY),
      });
      if (input.paid) {
        await harness.db.insert(fanSpendLifetime).values({
          platformAccountId: page.id,
          fanId: id,
          creatorNetAmountMills: dollarsToMills(100),
          lastTransactionAt: new Date(now.getTime() - 5 * DAY),
        });
      }
      await harness.db.insert(pageDmThreads).values({
        platformAccountId: page.id,
        fanId: id,
        platformConversationId: `conv-${handle}`,
        lastMessageId: input.messageId,
        lastMessageAt: new Date(now.getTime() - 2 * HOUR),
        lastMessageSenderRole: input.lastRole,
        lastFanMessageAt: new Date(now.getTime() - 2 * HOUR),
        lastModelMessageAt: input.lastRole === "model" ? new Date(now.getTime() - 2 * HOUR) : new Date(now.getTime() - 3 * HOUR),
        lastMessagePreview: input.preview,
        storedMessageCount: 2,
        messageCoverageStatus: "complete",
        isVisible: true,
      });
      return id;
    }

    await seedVisibleFan("spender-fresh", {
      paid: true,
      lastRole: "fan",
      messageId: "msg-spender-fresh",
      preview: "yes send it",
    });
    await seedVisibleFan("spender-model", {
      paid: true,
      lastRole: "model",
      messageId: "msg-spender-model",
      preview: "sent babe",
    });
    await seedVisibleFan("free-fresh", {
      paid: false,
      lastRole: "fan",
      messageId: "msg-free-fresh",
      preview: "yes send it",
    });

    await recomputeWorkboardPage(harness.db, { platformAccountId: page.id, now });

    const before = summarizeSpenderDiagnostics(await listSpenderDiagnosisRows(harness.db, page.id));
    expect(before).toMatchObject({ spenders: 2, diagnosed: 1, pending: 1, modelLast: 1, fanLast: 1 });

    const classified: string[] = [];
    const fakeClassifier: ClosingClassifier = {
      model: "fake-haiku",
      async classifyBatch(messages) {
        classified.push(...messages.map((m) => m.id));
        return {
          verdicts: messages.map((m) => ({
            id: m.id,
            needsReply: true,
            state: "buy_signal" as const,
            reason: "wants to buy",
          })),
          inputTokens: 5,
          outputTokens: 7,
        };
      },
    };

    const result = await runClosingClassificationForPage(harness.db, fakeClassifier, {
      platformAccountId: page.id,
      now,
      capMin: 50,
      capMax: 400,
    });

    expect(classified).toEqual(["msg-spender-fresh"]);
    expect(result.classified).toBe(1);

    const after = summarizeSpenderDiagnostics(await listSpenderDiagnosisRows(harness.db, page.id));
    expect(after).toMatchObject({ spenders: 2, diagnosed: 2, pending: 0, l2Classified: 1, modelLast: 1, fanLast: 1 });
    expect(after.states).toEqual([
      { state: "buy_signal", count: 1 },
      { state: "model_last", count: 1 },
    ]);
  });

  it("reserves LLM cap calls atomically and defers the rest once the cap is spent", async () => {
    const now = new Date("2026-05-29T12:00:00.000Z");
    const { page } = await seedPage();

    async function seedTail(handle: string, messageId: string, preview: string) {
      const id = await insertFan(handle, handle);
      await harness.db.insert(pageFans).values({
        fanId: id,
        platformAccountId: page.id,
        isFollower: true,
        followerSince: new Date(now.getTime() - 10 * DAY),
      });
      await harness.db.insert(pageDmThreads).values({
        platformAccountId: page.id,
        fanId: id,
        platformConversationId: `conv-cap-${handle}`,
        lastMessageId: messageId,
        lastMessageAt: new Date(now.getTime() - 48 * HOUR),
        lastMessageSenderRole: "fan",
        lastFanMessageAt: new Date(now.getTime() - 48 * HOUR),
        lastMessagePreview: preview,
        storedMessageCount: 1,
        messageCoverageStatus: "partial_window",
        isVisible: true,
      });
    }

    await seedTail("cap-a", "msg-cap-a", "are you around later?");
    await seedTail("cap-b", "msg-cap-b", "can you show me something new?");

    const classified: string[] = [];
    const fakeClassifier: ClosingClassifier = {
      model: "fake-haiku",
      async classifyBatch(messages) {
        classified.push(...messages.map((m) => m.id));
        return {
          verdicts: messages.map((m) => ({
            id: m.id,
            needsReply: true,
            state: "question" as const,
            reason: "asked a question",
          })),
          inputTokens: 7,
          outputTokens: 11,
        };
      },
    };

    const first = await runClosingClassificationForPage(harness.db, fakeClassifier, {
      platformAccountId: page.id,
      now,
      capMin: 0,
      capMax: 1,
      batchSize: 1,
    });
    expect(first).toMatchObject({ classified: 1, deferred: 1, calls: 1, inputTokens: 7, outputTokens: 11 });
    expect(classified).toHaveLength(1);
    expect(await getLlmUsageDaily(harness.db, page.id, toBusinessDate(now, UTC_TIME_ZONE), CLOSING_CLASSIFIER_FEATURE)).toEqual({
      calls: 1,
      inputTokens: 7,
      outputTokens: 11,
    });

    const second = await runClosingClassificationForPage(harness.db, fakeClassifier, {
      platformAccountId: page.id,
      now,
      capMin: 0,
      capMax: 1,
      batchSize: 1,
    });
    expect(second).toMatchObject({ classified: 0, deferred: 1, calls: 0, inputTokens: 0, outputTokens: 0 });
    expect(classified).toHaveLength(1);
  });

  it("persists per-page settings and appends to the classifier run log", async () => {
    const { page } = await seedPage();
    const pageIds = await listWorkboardRecomputePageIds(harness.db);
    expect(pageIds).toEqual([page.id]);
    expect(typeof pageIds[0]).toBe("number");

    // No override yet.
    expect(await getClosingSettings(harness.db, page.id)).toBeNull();

    await upsertClosingSettings(harness.db, {
      platformAccountId: page.id,
      enabled: false,
      dailyCapMax: 120,
      model: "claude-sonnet-4-5",
    });
    let settings = await getClosingSettings(harness.db, page.id);
    expect(settings).toMatchObject({ enabled: false, daily_cap_max: 120, model: "claude-sonnet-4-5" });

    // Upsert replaces (idempotent on the page PK).
    await upsertClosingSettings(harness.db, {
      platformAccountId: page.id,
      enabled: null,
      dailyCapMax: null,
      model: null,
    });
    settings = await getClosingSettings(harness.db, page.id);
    expect(settings).toMatchObject({ enabled: null, daily_cap_max: null, model: null });

    // Run log appends newest-first with the page label resolved.
    await insertClassifierRun(harness.db, {
      platformAccountId: page.id,
      trigger: "manual",
      model: "claude-haiku-4-5",
      classified: 7,
      calls: 1,
      inputTokens: 650,
      outputTokens: 300,
      deferred: 0,
      cleared: 0,
    });
    await insertClassifierRun(harness.db, {
      platformAccountId: page.id,
      trigger: "reclassify",
      model: "claude-haiku-4-5",
      classified: 14,
      calls: 1,
      inputTokens: 1300,
      outputTokens: 600,
      deferred: 2,
      cleared: 116,
    });

    const runs = await listClassifierRuns(harness.db, 10);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ trigger: "reclassify", page_label: "lora-main", cleared: 116, deferred: 2 });
    expect(runs[1]).toMatchObject({ trigger: "manual", classified: 7 });
  });

  it("tracks the async run lifecycle: running → active guard → finished", async () => {
    const { page } = await seedPage();

    expect(await getActiveClassifierRun(harness.db, page.id)).toBeNull();

    const first = await insertClassifierRunRunningIfIdle(harness.db, {
      platformAccountId: page.id,
      trigger: "reclassify",
      model: "claude-haiku-4-5",
    });
    const second = await insertClassifierRunRunningIfIdle(harness.db, {
      platformAccountId: page.id,
      trigger: "manual",
      model: "claude-haiku-4-5",
    });
    const runId = first.id;
    expect(first.alreadyRunning).toBe(false);
    expect(second).toEqual({ id: runId, alreadyRunning: true });
    // The run is now "active" — a second click would join it instead of starting a new one.
    expect(await getActiveClassifierRun(harness.db, page.id)).toMatchObject({ id: runId });
    expect((await listClassifierRuns(harness.db, 5))[0]).toMatchObject({ status: "running" });

    await finishClassifierRun(harness.db, runId, {
      status: "ok",
      classified: 12,
      calls: 1,
      inputTokens: 900,
      outputTokens: 400,
      deferred: 0,
      cleared: 30,
    });
    // No longer active; the row is finalized with its counts.
    expect(await getActiveClassifierRun(harness.db, page.id)).toBeNull();
    expect((await listClassifierRuns(harness.db, 5))[0]).toMatchObject({
      status: "ok",
      classified: 12,
      cleared: 30,
    });
  });

  it("buckets the spender roster into gross-spend bands (lists mode), incl. subscribers, excl. non-spenders", async () => {
    const now = new Date();
    const { page } = await seedPage();

    async function seedSpender(handle: string, grossDollars: number, opts: { subscriber?: boolean } = {}): Promise<number> {
      const id = await insertFan(`fan-${handle}`, handle);
      await harness.db.insert(pageFans).values({
        fanId: id,
        platformAccountId: page.id,
        isFollower: true,
        followerSince: new Date(now.getTime() - 60 * DAY),
        ...(opts.subscriber
          ? { isSubscriber: true, subscriptionExpiresAt: new Date(now.getTime() + 10 * DAY), autoRenew: true }
          : {}),
      });
      await harness.db.insert(fanSpendLifetime).values({
        platformAccountId: page.id,
        fanId: id,
        grossAmountMills: dollarsToMills(grossDollars),
        creatorNetAmountMills: dollarsToMills(grossDollars * 0.8),
        lastTransactionAt: new Date(now.getTime() - 5 * DAY),
      });
      return id;
    }

    const whale = await seedSpender("whale", 700); // 600-plus
    const mid = await seedSpender("mid", 200); // 150-350
    const subscriber = await seedSpender("sub", 80, { subscriber: true }); // 50-150 (still listed)
    const boundary = await seedSpender("boundary", 25); // upper-exclusive: $25 → 25-50, not 0-25
    const low = await seedSpender("low", 10); // 0-25

    // A follower who never paid — no lifetime spend row → excluded from the lists.
    const freeloader = await insertFan("fan-free", "free");
    await harness.db.insert(pageFans).values({
      fanId: freeloader,
      platformAccountId: page.id,
      isFollower: true,
      followerSince: new Date(now.getTime() - 60 * DAY),
    });

    const result = await recomputeWorkboardPage(harness.db, { platformAccountId: page.id, now });
    expect(result.evaluated).toBe(6);

    const { counts, rows } = await listWorkboardSpenderBands(harness.db, {
      platformAccountId: page.id,
      buckets: SPENDER_AUTO_LIST_BUCKETS,
      itemCap: 500,
    });

    const countByBand = new Map(counts.map((c) => [c.band, c.count]));
    expect(countByBand.get("0-25")).toBe(1);
    expect(countByBand.get("25-50")).toBe(1);
    expect(countByBand.get("50-150")).toBe(1);
    expect(countByBand.get("150-350")).toBe(1);
    expect(countByBand.get("350-600") ?? 0).toBe(0);
    expect(countByBand.get("600-plus")).toBe(1);

    const bandByFan = new Map(rows.map((r) => [Number(r.fan_id), r.band]));
    expect(bandByFan.get(whale)).toBe("600-plus");
    expect(bandByFan.get(mid)).toBe("150-350");
    expect(bandByFan.get(subscriber)).toBe("50-150");
    expect(bandByFan.get(boundary)).toBe("25-50");
    expect(bandByFan.get(low)).toBe("0-25");
    expect(bandByFan.has(freeloader)).toBe(false);

    // The subscriber sits on the Subscribers tab but is still listed — bands span all tabs.
    const subRow = rows.find((r) => Number(r.fan_id) === subscriber)!;
    expect(subRow.tab).toBe("subscribers");
    expect(Number(subRow.gross_mills)).toBe(Number(dollarsToMills(80)));
  });

  it("marks a dead old-mass reactivation attempt once and leaves it stable", async () => {
    const { page } = await seedPage();
    const fan = await insertFan("fan-dead", "nora");
    await harness.db.insert(pageFans).values({ fanId: fan, platformAccountId: page.id, isFollower: true });
    await harness.pool.query(
      `
      insert into workboard_state (
        platform_account_id, fan_id, tab, mass_substate,
        value_score, urgency_score, rank_score, secondary_status
      )
      values (
        $1, $2, 'old_mass'::workboard_tab, 'dead'::workboard_mass_substate,
        0, 25, 25, 'due_now'::workboard_secondary_status
      )
    `,
      [page.id, fan],
    );

    expect(await markReactivationAttemptedIfDead(harness.db, { platformAccountId: page.id, fanId: fan })).toBe(true);
    const afterFirst = await harness.pool.query<{ attempted_at: Date | null }>(
      `
      select reactivation_attempted_at as attempted_at
      from workboard_state
      where platform_account_id = $1 and fan_id = $2
    `,
      [page.id, fan],
    );
    expect(afterFirst.rows[0]?.attempted_at).toBeInstanceOf(Date);

    expect(await markReactivationAttemptedIfDead(harness.db, { platformAccountId: page.id, fanId: fan })).toBe(false);
    const afterSecond = await harness.pool.query<{ attempted_at: Date | null }>(
      `
      select reactivation_attempted_at as attempted_at
      from workboard_state
      where platform_account_id = $1 and fan_id = $2
    `,
      [page.id, fan],
    );
    expect(afterSecond.rows[0]?.attempted_at?.toISOString()).toBe(afterFirst.rows[0]?.attempted_at?.toISOString());
  });
});
