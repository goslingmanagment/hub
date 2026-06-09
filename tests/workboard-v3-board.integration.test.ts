import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  dialogReads,
  fans,
  pageDmThreads,
  pageFans,
  pageSubscriptions,
  transactions,
  workboardSnoozes,
  workboardV3Touches,
} from "@agency_hub_core/db";
import { dollarsToMills } from "@agency_hub_core/shared";

import { getWb3Board, getWb3FanDiagnostics } from "../apps/runtime/src/services/workboard-v3/board.ts";
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

let seq = 0;
async function insertFan(pageId: number, pageFanValues: Record<string, unknown> = {}) {
  seq += 1;
  const [fanRow] = await harness.db
    .insert(fans)
    .values({
      platform: "fansly",
      platformUserId: `fan-${seq}`,
      username: `fan${seq}`,
      displayName: `Fan ${seq}`,
    })
    .returning({ id: fans.id });
  await harness.db.insert(pageFans).values({
    fanId: fanRow!.id,
    platformAccountId: pageId,
    ...pageFanValues,
  });
  return fanRow!.id;
}

async function insertThread(pageId: number, fanId: number, values: Record<string, unknown> = {}) {
  seq += 1;
  const [row] = await harness.db
    .insert(pageDmThreads)
    .values({
      platformAccountId: pageId,
      fanId,
      platformConversationId: `conv-${seq}`,
      ...values,
    })
    .returning({ id: pageDmThreads.id });
  return row!.id;
}

async function insertPurchase(pageId: number, fanId: number, mills: bigint, occurredAt: Date) {
  seq += 1;
  await harness.db.insert(transactions).values({
    platformAccountId: pageId,
    fanId,
    transactionId: `txn-${seq}`,
    rawType: "tip",
    canonicalType: "message_purchase",
    transactionState: "posted",
    rawStatus: "ok",
    grossAmountMills: mills,
    sourceDestinationAmountMills: mills,
    creatorNetAmountMills: mills,
    occurredAt,
  });
}

function findRow(board: Awaited<ReturnType<typeof getWb3Board>>, fanId: number) {
  for (const tab of board.tabs) {
    for (const blockKey of ["live", "proactive"] as const) {
      for (const section of tab.blocks[blockKey]) {
        const row = section.rows.find((r) => r.fanId === fanId);
        if (row) {
          return { tab: tab.key, section: section.section, row };
        }
      }
    }
  }
  return null;
}

describe("workboard v3 read-only board (integration)", () => {
  it("routes reasons into the right tabs, blocks and sections", async () => {
    const now = new Date();
    const { page } = await seedPage();

    // Renew-off subscriber expiring in 3 days, $310 LTV → Subs ⚠ (red).
    const renewOff = await insertFan(page.id, {
      isSubscriber: true,
      autoRenew: false,
      subscriptionExpiresAt: new Date(now.getTime() + 3 * DAY),
      totalCreatorNetMills: dollarsToMills(310),
    });
    await harness.db.insert(pageSubscriptions).values({
      platformSubscriptionId: "sub-renewoff",
      platformAccountId: page.id,
      fanId: renewOff,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: dollarsToMills(20),
      renewPriceMills: dollarsToMills(20),
      autoRenew: false,
      isCurrent: true,
      endsAt: new Date(now.getTime() + 3 * DAY),
      subscriptionTierName: "VIP",
    });

    // Spender who bought PPV 5h ago, untouched since → ◆ in Spenders live block.
    const buyer = await insertFan(page.id, { totalCreatorNetMills: dollarsToMills(880) });
    await insertPurchase(page.id, buyer, dollarsToMills(45), new Date(now.getTime() - 5 * HOUR));

    // Spender waiting for a reply 26h, no verdict → ● fail-open.
    const waiting = await insertFan(page.id, { totalCreatorNetMills: dollarsToMills(1240) });
    await insertThread(page.id, waiting, {
      lastMessageSenderRole: "fan",
      lastFanMessageAt: new Date(now.getTime() - 26 * HOUR),
      lastMessageAt: new Date(now.getTime() - 26 * HOUR),
      lastMessagePreview: "when are you online?",
      storedMessageCount: 3,
      messageCoverageStatus: "partial_window",
    });
    await insertPurchase(page.id, waiting, dollarsToMills(100), new Date(now.getTime() - 30 * DAY));

    // Mass-active fan with an answered buy-signal tail → ⚠ buy_signal in Mass.
    const signal = await insertFan(page.id, {
      isFollower: true,
      followerSince: new Date(now.getTime() - 100 * DAY),
    });
    const signalThread = await insertThread(page.id, signal, {
      lastMessageSenderRole: "model",
      lastFanMessageAt: new Date(now.getTime() - 10 * HOUR),
      lastMessageAt: new Date(now.getTime() - 9 * HOUR),
      storedMessageCount: 5,
      messageCoverageStatus: "complete",
    });
    await harness.db.insert(dialogReads).values({
      platformAccountId: page.id,
      fanId: signal,
      conversationId: signalThread,
      lastFanMessagePk: null,
      verdict: {
        needs_reply: false,
        intent: "buy_signal",
        temperature: "hot",
        readiness: "considering",
        gist: "спрашивает цену кастома",
      },
      model: "claude-haiku-4-5",
      createdAt: new Date(now.getTime() - 9 * HOUR),
    });
    // Promote to mass_active: a meaningful fan message exists in the 90d scan.
    await harness.pool.query(
      `insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id, sender_role, created_at, content)
       values ($1, $2, 'sig-1', 'fan', $3, 'how much for a custom video?')`,
      [signalThread, page.id, new Date(now.getTime() - 10 * HOUR)],
    );

    // Gray fan → rotation batch in Mass ○.
    const gray = await insertFan(page.id, {
      isFollower: true,
      followerSince: new Date(now.getTime() - 200 * DAY),
    });

    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });
    const board = await getWb3Board(harness.db, {
      platformAccountId: page.id,
      pageLabel: "lora-main",
      now,
    });

    const renewRow = findRow(board, renewOff);
    expect(renewRow).toMatchObject({ tab: "subs", section: "risk" });
    expect(renewRow!.row.reason.id).toBe("renew_off_expiring");
    expect(renewRow!.row.reason.phrase).toContain("renew OFF");
    expect(renewRow!.row.reason.phrase).toContain("3д");
    expect(renewRow!.row.chips.some((c) => c.label === "VIP" || c.label === "Кит")).toBe(true);

    const buyerRow = findRow(board, buyer);
    expect(buyerRow).toMatchObject({ tab: "spenders", section: "purchase" });
    expect(buyerRow!.row.reason.phrase).toContain("купил PPV");
    expect(buyerRow!.row.reason.phrase).toContain("$45");

    const waitingRow = findRow(board, waiting);
    expect(waitingRow).toMatchObject({ tab: "spenders", section: "needs_reply" });
    expect(waitingRow!.row.reason.phrase).toBe("ждёт ответа 26ч");
    expect(waitingRow!.row.confidence).toBe("partial");
    expect(waitingRow!.row.gist).toBe("when are you online?");
    expect(waitingRow!.row.gistSource).toBe("preview");

    const signalRow = findRow(board, signal);
    expect(signalRow).toMatchObject({ tab: "mass", section: "risk" });
    expect(signalRow!.row.reason.id).toBe("buy_signal");
    expect(signalRow!.row.gist).toBe("спрашивает цену кастома");
    expect(signalRow!.row.gistSource).toBe("dialog_read");

    const grayRow = findRow(board, gray);
    expect(grayRow).toMatchObject({ tab: "mass", section: "scheduled" });
    expect(grayRow!.row.reason.id).toBe("gray_touch");

    expect(board.needsReplyTotal).toBe(1);
    expect(board.capacity).toBe(55);
    expect(board.dataAsOf).toBeNull();
  });

  it("caps the plan at page capacity and shows the overflow as visible debt", async () => {
    const now = new Date();
    const { page } = await seedPage();

    // 60 core spenders, all due (touched 15d ago, 14d cadence) → 55 planned, 5 debt.
    for (let i = 0; i < 60; i += 1) {
      const fanId = await insertFan(page.id, { totalCreatorNetMills: dollarsToMills(20 + i) });
      await insertPurchase(page.id, fanId, dollarsToMills(20), new Date(now.getTime() - 90 * DAY));
      await harness.db.insert(workboardV3Touches).values({
        platformAccountId: page.id,
        fanId,
        type: "manual",
        confirmedAt: new Date(now.getTime() - 15 * DAY),
        createdAt: new Date(now.getTime() - 15 * DAY),
      });
    }

    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });
    const board = await getWb3Board(harness.db, {
      platformAccountId: page.id,
      pageLabel: "lora-main",
      now,
    });

    const spenders = board.tabs.find((t) => t.key === "spenders")!;
    expect(spenders.planned).toBe(55);
    expect(spenders.debt).toBe(5);

    // Debt favors the whales: the cheapest spenders are the ones deferred.
    const scheduledRows = spenders.blocks.proactive.find((b) => b.section === "scheduled")!.rows;
    const minIncludedLtv = Math.min(...scheduledRows.map((r) => r.ltvMills));
    expect(minIncludedLtv).toBeGreaterThanOrEqual(Number(dollarsToMills(25)));
  });

  it("suppresses snoozed fans from the board and explains it in fan diagnostics", async () => {
    const now = new Date();
    const { page } = await seedPage();

    const fanId = await insertFan(page.id, { totalCreatorNetMills: dollarsToMills(50) });
    await insertPurchase(page.id, fanId, dollarsToMills(50), new Date(now.getTime() - 60 * DAY));
    await harness.db.insert(workboardV3Touches).values({
      platformAccountId: page.id,
      fanId,
      type: "manual",
      confirmedAt: new Date(now.getTime() - 20 * DAY),
      createdAt: new Date(now.getTime() - 20 * DAY),
    });
    await harness.db.insert(workboardSnoozes).values({
      platformAccountId: page.id,
      fanId,
      snoozedUntil: new Date(now.getTime() + 3 * DAY),
      reason: "попросил подождать",
    });

    await recomputeWb3Page(harness.db, { platformAccountId: page.id, now });
    const board = await getWb3Board(harness.db, {
      platformAccountId: page.id,
      pageLabel: "lora-main",
      now,
    });

    expect(findRow(board, fanId)).toBeNull();
    expect(board.service.counts.snoozed).toBe(1);
    expect(board.service.rows.some((r) => r.fanId === fanId && r.kind === "snoozed")).toBe(true);

    const diagnostics = await getWb3FanDiagnostics(harness.db, {
      platformAccountId: page.id,
      fanId,
      now,
    });
    expect(diagnostics).not.toBeNull();
    expect(diagnostics!.segment).toBe("spender");
    expect(diagnostics!.snoozeReason).toBe("попросил подождать");
    expect(diagnostics!.reasons.length).toBeGreaterThan(0);
    expect(diagnostics!.reasons.every((r) => r.suppressedBy === "snooze")).toBe(true);
    expect(diagnostics!.touches).toHaveLength(1);
    expect(diagnostics!.touches[0]!.type).toBe("manual");

    // Unknown fan → null (the route turns this into a 404).
    expect(
      await getWb3FanDiagnostics(harness.db, { platformAccountId: page.id, fanId: 999_999, now }),
    ).toBeNull();
  });
});
