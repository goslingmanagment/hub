// Regression tests for the decision #50 flag-flip gate (pre-deploy audit
// fix session 4): B11 (DM thread lost update), F7 (permanent floor park),
// F8 (webhook accrual double-count), F9 (non-atomic budgets), P-25 (sweep
// retires mid-sweep projections), P-26 (subscription projection lost update),
// P-33 (reconciliation lump trips the burn alert). All paths run with the
// gated flags ON.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  deactivatePageSubscriptionsByGeneration,
  findPageSubscription,
  getOfapiCreditState,
  insertOfapiCreditLedgerEntry,
  insertOfapiWebhookEvent,
  listNotificationIncidents,
  listPageDmConversationsByPlatformConversationIds,
  recordOfapiCreditSpend,
  recordOfapiCreditUsage,
  reserveOfapiDayCredits,
  setPageOfapiAccountId,
  settleOfapiDayCreditReservation,
  sumOfapiCreditsSpentSince,
  upsertFanPages,
  upsertFans,
  upsertPageDmConversation,
  upsertPageSubscription,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  runOfapiCreditBurnMonitor,
  runOfapiCreditReconciliation,
  runOfapiWebhookAccrual,
} from "../apps/runtime/src/services/ofapi-credits.ts";
import { projectOfapiDmEvent } from "../apps/runtime/src/services/ofapi-dm-projection.ts";
import { runOfapiSubscriptionProjectionForSettledRow } from "../apps/runtime/src/services/ofapi-subscription-projection.ts";
import { createOfapiRestGuard } from "../apps/runtime/src/services/sync/ofapi-dm-sync.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { hasSettled, waitForRowLockWait } from "./helpers/lock-waits.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const ACCOUNT_ID = "acct_01000000000000000000000000000000";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

async function seedMappedPage(label: string) {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: ACCOUNT_ID });
  return page;
}

async function seedFan(platformUserId: string, pageId: number) {
  const [fan] = await upsertFans(appContext.db, [{
    platform: "onlyfans" as const,
    platformUserId,
    username: `fan_${platformUserId}`,
  }]);
  if (!fan) {
    throw new Error("fan upsert returned no row");
  }
  await upsertFanPages(appContext.db, [{ fanId: fan.id, platformAccountId: pageId }]);
  return fan;
}

function dmConversationInput(pageId: number, fanId: string, head: {
  messageId: string;
  createdAt: Date;
} | null) {
  return {
    platformAccountId: pageId,
    fanId: null,
    platformConversationId: fanId,
    partnerPlatformUserId: fanId,
    partnerUsername: null,
    partnerDisplayName: null,
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: head?.messageId ?? null,
    lastUnreadMessageId: null,
    lastMessageAt: head?.createdAt ?? null,
    lastMessageSenderId: head ? fanId : null,
    lastMessageSenderRole: (head ? "fan" : "unknown") as "fan" | "unknown",
    lastMessagePreview: head ? `preview ${head.messageId}` : null,
    isVisible: true,
    lastSeenGeneration: null,
    metadata: { provider: "ofapi" },
  };
}

describe("ofapi flag-flip hardening (audit session 4)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    appContext = createTestAppContext(testDb, {
      ofapiCreditLedgerEnabled: true,
      ofapiDmProjectionEnabled: true,
      ofapiDmSyncEnabled: true,
      ofapiAudienceSyncEnabled: true,
    });
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  describe("F9 — atomic day-budget reservation", () => {
    it("grants exactly the budget under concurrent reservations", async () => {
      const outcomes = await Promise.all(Array.from({ length: 10 }, () =>
        reserveOfapiDayCredits(appContext.db, { scope: "global", estimate: 1, budget: 5 })));

      expect(outcomes.filter(Boolean)).toHaveLength(5);
      const credit = await getOfapiCreditState(appContext.db);
      expect(credit.spentToday).toBe(5);
      expect(credit.audienceSpentToday).toBe(0);
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("keeps the audience counter independent and settles reservations to actuals", async () => {
      const globalReceipt = await reserveOfapiDayCredits(
        appContext.db,
        { scope: "global", estimate: 1, budget: 5 },
      );
      const audienceReceipt = await reserveOfapiDayCredits(
        appContext.db,
        { scope: "audience", estimate: 1, budget: 3 },
      );
      expect(globalReceipt).not.toBeNull();
      expect(audienceReceipt).not.toBeNull();
      expect(await reserveOfapiDayCredits(
        appContext.db,
        { scope: "audience", estimate: 1, budget: 3 },
      )).not.toBeNull();
      if (!globalReceipt || !audienceReceipt) throw new Error("reservation receipt missing");

      let credit = await getOfapiCreditState(appContext.db);
      expect(credit.spentToday).toBe(1);
      expect(credit.audienceSpentToday).toBe(2);

      // A response that actually cost 3 credits settles +2 over its 1-credit
      // estimate; a released reservation can never push the counter negative.
      await settleOfapiDayCreditReservation(appContext.db, {
        scope: "audience",
        receipt: audienceReceipt,
        creditsDelta: 2,
      });
      await settleOfapiDayCreditReservation(appContext.db, {
        scope: "global",
        receipt: globalReceipt,
        creditsDelta: -10,
        balance: 750,
      });

      credit = await getOfapiCreditState(appContext.db);
      expect(credit.audienceSpentToday).toBe(4);
      expect(credit.spentToday).toBe(0);
      expect(credit.lastBalance).toBe(750);
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("reserves a dedicated lane and the shared physical cap atomically", async () => {
      const outcomes = await Promise.all(Array.from({ length: 10 }, () =>
        reserveOfapiDayCredits(appContext.db, {
          scope: "audience",
          estimate: 1,
          budget: 10,
          globalBudget: 5,
        })));

      expect(outcomes.filter(Boolean)).toHaveLength(5);
      const credit = await getOfapiCreditState(appContext.db);
      expect(credit.spentToday).toBe(5);
      expect(credit.audienceSpentToday).toBe(5);
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("keeps dedicated lane caps available after shared mirror spend exceeds 500", async () => {
      await recordOfapiCreditSpend(appContext.db, {
        operation: "ofapi_chats",
        credits: 600,
        balanceAfter: 19_400,
      });

      const audienceGuards = Array.from({ length: 3 }, () =>
        createOfapiRestGuard(appContext, {
          dailyCreditBudget: 2,
          budgetScope: "audience",
        }));
      const backfillGuards = Array.from({ length: 3 }, () =>
        createOfapiRestGuard(appContext, {
          dailyCreditBudget: 2,
          budgetScope: "backfill",
        }));

      const audienceOutcomes = await Promise.all(
        audienceGuards.map((guard) => guard.resolveBlock()),
      );
      const backfillOutcomes = await Promise.all(
        backfillGuards.map((guard) => guard.resolveBlock()),
      );

      expect(audienceOutcomes.filter((outcome) => outcome === null)).toHaveLength(2);
      expect(backfillOutcomes.filter((outcome) => outcome === null)).toHaveLength(2);
      expect(audienceOutcomes.filter((outcome) => outcome === "ofapi_daily_credit_budget"))
        .toHaveLength(1);
      expect(backfillOutcomes.filter((outcome) => outcome === "ofapi_daily_credit_budget"))
        .toHaveLength(1);

      const credit = await getOfapiCreditState(appContext.db);
      expect(credit.spentToday).toBe(604);
      expect(credit.audienceSpentToday).toBe(2);
      const { rows } = await testDb!.pool.query<{ backfill_spent_credits: number }>(
        "select backfill_spent_credits from ofapi_credit_state where id = 1",
      );
      expect(rows[0]?.backfill_spent_credits).toBe(2);
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("admits only one dedicated reservation at the 7000-credit physical ceiling", async () => {
      appContext = createTestAppContext(testDb!, {
        ofapiCreditLedgerEnabled: true,
        ofapiDmDailyCreditBudget: 10_000,
        ofapiMirrorGlobalDailyCreditBudget: 7_000,
      });
      await recordOfapiCreditSpend(appContext.db, {
        operation: "ofapi_chats",
        credits: 6_999,
        balanceAfter: 13_001,
      });

      const guards = Array.from({ length: 10 }, (_, index) =>
        createOfapiRestGuard(appContext, {
          dailyCreditBudget: 10,
          budgetScope: index % 2 === 0 ? "audience" : "backfill",
        }));
      const outcomes = await Promise.all(guards.map((guard) => guard.resolveBlock()));

      expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === "ofapi_daily_credit_budget"))
        .toHaveLength(9);
      const credit = await getOfapiCreditState(appContext.db);
      expect(credit.spentToday).toBe(7_000);
      const { rows } = await testDb!.pool.query<{
        audience_spent_credits: number;
        backfill_spent_credits: number;
      }>(
        `select audience_spent_credits, backfill_spent_credits
         from ofapi_credit_state
         where id = 1`,
      );
      expect(
        (rows[0]?.audience_spent_credits ?? 0) +
          (rows[0]?.backfill_spent_credits ?? 0),
      ).toBe(1);
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("settles a dedicated reservation without double-counting the ledger sink", async () => {
      const guard = createOfapiRestGuard(appContext, {
        dailyCreditBudget: 10,
        budgetScope: "audience",
      });
      expect(await guard.resolveBlock()).toBeNull();

      let credit = await getOfapiCreditState(appContext.db);
      expect(credit.spentToday).toBe(1);
      expect(credit.audienceSpentToday).toBe(1);

      await recordOfapiCreditSpend(appContext.db, {
        operation: "ofapi_fans_active",
        credits: 3,
        balanceAfter: 747,
        budgetScope: "audience",
      });
      await guard.recordResponse({
        items: [],
        hasNextPage: false,
        creditSpendAccounted: true,
        meta: {
          creditsUsed: 3,
          creditBalance: 747,
          isCached: false,
          rateRemainingMinute: null,
        },
      });

      credit = await getOfapiCreditState(appContext.db);
      expect(credit.spentToday).toBe(3);
      expect(credit.audienceSpentToday).toBe(3);
      expect(credit.lastBalance).toBe(747);
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("never rewinds a UTC-day counter and settles against the reservation receipt", async () => {
      const oldReceipt = await reserveOfapiDayCredits(appContext.db, {
        scope: "global",
        estimate: 1,
        budget: 10,
        now: new Date("2099-01-01T23:59:00.000Z"),
      });
      const newReceipt = await reserveOfapiDayCredits(appContext.db, {
        scope: "global",
        estimate: 1,
        budget: 10,
        now: new Date("2099-01-02T00:01:00.000Z"),
      });
      expect(oldReceipt).not.toBeNull();
      expect(newReceipt).not.toBeNull();
      if (!oldReceipt) throw new Error("old reservation receipt missing");

      await settleOfapiDayCreditReservation(appContext.db, {
        scope: "global",
        receipt: oldReceipt,
        creditsDelta: 2,
        now: new Date("2099-01-02T00:02:00.000Z"),
      });
      await recordOfapiCreditUsage(appContext.db, {
        creditsUsed: 5,
        now: new Date("2099-01-01T23:59:30.000Z"),
      });
      expect(await reserveOfapiDayCredits(appContext.db, {
        scope: "global",
        estimate: 1,
        budget: 10,
        now: new Date("2099-01-01T23:59:45.000Z"),
      })).toBeNull();

      const state = await testDb!.pool.query<{ spend_day: string; spent_credits: number }>(`
        select to_char(spend_day, 'YYYY-MM-DD') as spend_day, spent_credits
        from ofapi_credit_state where id = 1
      `);
      expect(state.rows[0]).toEqual({ spend_day: "2099-01-02", spent_credits: 1 });
    }, INTEGRATION_TEST_TIMEOUT_MS);
  });

  describe("F7 — credit-floor park recovery", () => {
    it("lets a stale sub-floor balance probe through and re-parks on fresh data", async () => {
      // Floor 500, balance 100 observed two hours ago: stale, so the guard
      // must let one probe request through instead of parking forever.
      await recordOfapiCreditUsage(appContext.db, { creditsUsed: 0, balance: 100 });
      await testDb!.pool.query(
        "update ofapi_credit_state set last_balance_at = now() - interval '2 hours'",
      );

      const guard = createOfapiRestGuard(appContext);
      expect(await guard.resolveBlock()).toBeNull();

      // The probe's response refreshed the observation and the balance is
      // still below the floor: the next check parks again.
      await recordOfapiCreditSpend(appContext.db, {
        operation: "ofapi_chats",
        credits: 1,
        balanceAfter: 100,
      });
      await guard.recordResponse({
        items: [],
        hasNextPage: false,
        creditSpendAccounted: true,
        meta: {
          creditsUsed: 1,
          creditBalance: 100,
          isCached: false,
          rateRemainingMinute: null,
        },
      });
      expect(await guard.resolveBlock()).toBe("ofapi_credit_floor");
    }, INTEGRATION_TEST_TIMEOUT_MS);
  });

  describe("F8 — webhook burn vs reconciliation", () => {
    it("counts webhook burn once across reconciliation and the daily accrual", async () => {
      const dayStart = new Date(Date.now() - 26 * 60 * 60 * 1000);
      const yesterday = (hours: number) => new Date(dayStart.getTime() + hours * 60 * 60 * 1000);

      // Observation A, then 300 webhook deliveries (3 credits of burn), then
      // observation B showing the balance net of REST spend AND webhook burn.
      await recordOfapiCreditSpend(appContext.db, {
        operation: "ofapi_chats",
        credits: 10,
        balanceAfter: 1000,
        occurredAt: yesterday(0),
      });
      await testDb!.pool.query(
        `insert into ofapi_webhook_events (idempotency_key, event_type, ofapi_account_id, payload, received_at)
         select 'evt_f8_' || g, 'messages.received', $1, '{}'::jsonb, $2::timestamptz
         from generate_series(1, 300) g`,
        [ACCOUNT_ID, yesterday(1).toISOString()],
      );
      await recordOfapiCreditSpend(appContext.db, {
        operation: "ofapi_chats",
        credits: 5,
        balanceAfter: 992,
        occurredAt: yesterday(2),
      });

      // The intra-day drop is fully explained by REST spend plus the journal
      // estimate — no external row (pre-fix: a duplicate 3-credit external).
      const plan = await runOfapiCreditReconciliation(appContext);
      expect(plan?.adjustments).toEqual([]);

      // The daily accrual still posts the canonical ceil(events/100) row.
      expect(await runOfapiWebhookAccrual(appContext)).toBe(1);

      // A reconcile window spanning the accrual row must not emit a phantom
      // compensating refill (pre-fix: the accrual counted as known spend the
      // balance never reflected in that window).
      await recordOfapiCreditSpend(appContext.db, {
        operation: "ofapi_chats",
        credits: 2,
        balanceAfter: 990,
        occurredAt: new Date(),
      });
      const secondPlan = await runOfapiCreditReconciliation(appContext);
      expect(secondPlan?.adjustments).toEqual([]);

      const { rows } = await testDb!.pool.query<{ source: string }>(
        "select source from ofapi_credit_ledger where source in ('external', 'refill')",
      );
      expect(rows).toEqual([]);

      // Non-refill spend counts the webhook component exactly once:
      // 10 + 5 + 2 REST credits plus the 3-credit accrual (stamped at the
      // accrued day's UTC midnight, so the window reaches well past it).
      expect(await sumOfapiCreditsSpentSince(appContext.db, {
        since: new Date(dayStart.getTime() - 72 * 60 * 60 * 1000),
      })).toBe(20);
    }, INTEGRATION_TEST_TIMEOUT_MS);
  });

  describe("P-33 — burn monitor pro-rates reconciliation lumps", () => {
    it("does not alert on a multi-day external residual stamped at one observation", async () => {
      const now = new Date();
      await insertOfapiCreditLedgerEntry(appContext.db, {
        occurredAt: new Date(now.getTime() - 5 * 60 * 1000),
        source: "external",
        credits: 2400,
        estimated: true,
        details: {
          fromOccurredAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      // 2400 credits over ~24h is ~92 in the trailing hour — under the
      // 300/h threshold (pre-fix: the whole lump landed in the hour).
      await runOfapiCreditBurnMonitor(appContext);
      expect(await listNotificationIncidents(appContext.db, { status: "open" })).toEqual([]);

      // A row without a window start (legacy / manual) still counts in full,
      // and genuine trailing-hour burn still alerts.
      await insertOfapiCreditLedgerEntry(appContext.db, {
        occurredAt: new Date(now.getTime() - 4 * 60 * 1000),
        source: "external",
        credits: 400,
        estimated: true,
      });
      await runOfapiCreditBurnMonitor(appContext);
      const incidents = await listNotificationIncidents(appContext.db, { status: "open" });
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({ kind: "ofapi_burn_rate" });
    }, INTEGRATION_TEST_TIMEOUT_MS);
  });

  describe("B11 — DM thread heads only ever advance", () => {
    it("refuses to regress the head block in the conflict update", async () => {
      const page = await seedMappedPage("b11-guard");
      const t1 = new Date("2026-06-13T10:00:00Z");
      const t2 = new Date("2026-06-13T11:00:00Z");

      await upsertPageDmConversation(appContext.db, dmConversationInput(page.id, "501", {
        messageId: "9002",
        createdAt: t2,
      }));

      // A stale REST snapshot tries to move the head back to an older message
      // while updating unread state — the head stays, the rest applies.
      const row = await upsertPageDmConversation(appContext.db, {
        ...dmConversationInput(page.id, "501", { messageId: "9001", createdAt: t1 }),
        unreadCount: 4,
        headForwardOnly: true,
      });

      expect(row.lastMessageId).toBe("9002");
      expect(row.lastMessageAt?.toISOString()).toBe(t2.toISOString());
      expect(row.lastMessagePreview).toBe("preview 9002");
      expect(row.unreadCount).toBe(4);

      // A genuinely newer head still advances through the guard.
      const advanced = await upsertPageDmConversation(appContext.db, {
        ...dmConversationInput(page.id, "501", {
          messageId: "9003",
          createdAt: new Date("2026-06-13T12:00:00Z"),
        }),
        headForwardOnly: true,
      });
      expect(advanced.lastMessageId).toBe("9003");
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("serializes the webhook projection behind a locked REST read-then-upsert", async () => {
      const page = await seedMappedPage("b11-race");
      await seedFan("601", page.id);
      const t1 = new Date("2026-06-13T10:00:00Z");
      const t2 = new Date("2026-06-13T11:00:00Z");
      await upsertPageDmConversation(appContext.db, dmConversationInput(page.id, "601", {
        messageId: "7001",
        createdAt: t1,
      }));

      let releaseRest = () => {};
      const restGate = new Promise<void>((resolve) => {
        releaseRest = resolve;
      });
      let restLocked = () => {};
      const restLockAcquired = new Promise<void>((resolve) => {
        restLocked = resolve;
      });

      // Simulates the REST reconcile: lock the row, hold the transaction open
      // (a slow chats walk), then write the full-row snapshot it read.
      const restTransaction = appContext.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        const [snapshot] = await listPageDmConversationsByPlatformConversationIds(db, {
          platformAccountId: page.id,
          platformConversationIds: ["601"],
          forUpdate: true,
        });
        expect(snapshot?.lastMessageId).toBe("7001");
        restLocked();
        await restGate;
        await upsertPageDmConversation(db, {
          ...dmConversationInput(page.id, "601", { messageId: "7001", createdAt: t1 }),
          unreadCount: 2,
          headForwardOnly: true,
        });
      });

      // Once the REST transaction holds its row lock, start the projection of
      // a NEWER webhook message — it must block, not interleave.
      await Promise.race([restLockAcquired, restTransaction]);
      const projection = projectOfapiDmEvent(appContext, {
        id: 1,
        eventType: "messages.received",
        ofapiAccountId: ACCOUNT_ID,
        payload: {
          event: "messages.received",
          account_id: ACCOUNT_ID,
          payload: {
            id: 7002,
            text: "newer webhook message",
            createdAt: t2.toISOString(),
            fromUser: { id: 601, username: "fan_601", name: "Fan 601" },
            isTip: false,
            price: 0,
          },
        },
        projectionStatus: "pending",
        receivedAt: t2,
      });

      // Observed, not assumed: the projection is parked on a lock while the
      // REST transaction is still open, and it has not finished. No text
      // filter: the locking select lists every page_dm_threads column, so
      // since 0231 its table name sits past track_activity_query_size; the
      // REST transaction, idle on its gate, is the only other backend here,
      // so any lock waiter in this database is the projection.
      await waitForRowLockWait(testDb!.pool, [], { blocked: projection });
      expect(await hasSettled(projection)).toBe(false);

      releaseRest();
      await restTransaction;
      await expect(projection).resolves.toEqual({ status: "projected" });

      // The projection re-read fresh state after the REST commit: the newer
      // head wins and the REST unread correction is preserved underneath it.
      const [conversation] = await listPageDmConversationsByPlatformConversationIds(appContext.db, {
        platformAccountId: page.id,
        platformConversationIds: ["601"],
      });
      expect(conversation?.lastMessageId).toBe("7002");
      expect(conversation?.lastMessageAt?.toISOString()).toBe(t2.toISOString());
    }, INTEGRATION_TEST_TIMEOUT_MS);
  });

  describe("P-25 — sweep expiry spares mid-sweep projections", () => {
    it("retires only rows the sweep had a chance to observe", async () => {
      const page = await seedMappedPage("p25");
      const sweepStartedAt = new Date(Date.now() - 60 * 60 * 1000);

      const subscriptionInput = (fanId: number, platformSubscriptionId: string, generation: number | null) => ({
        platformSubscriptionId,
        platformAccountId: page.id,
        fanId,
        rawStatus: 0,
        canonicalStatus: "active",
        priceMills: 0n,
        renewPriceMills: 0n,
        lastSeenGeneration: generation,
      });

      const staleFan = await seedFan("701", page.id);
      const freshFan = await seedFan("702", page.id);
      const sweptFan = await seedFan("703", page.id);
      // Projected before the sweep started and absent from it: retire.
      await upsertPageSubscription(appContext.db, subscriptionInput(staleFan.id, "701", null));
      await testDb!.pool.query(
        "update page_subscriptions set last_seen_at = now() - interval '2 hours' where platform_subscription_id = '701'",
      );
      // Projected mid-sweep (generation null but touched after the start): spare.
      await upsertPageSubscription(appContext.db, subscriptionInput(freshFan.id, "702", null));
      // Stamped by the current sweep: keep.
      await upsertPageSubscription(appContext.db, subscriptionInput(sweptFan.id, "703", 5));

      await deactivatePageSubscriptionsByGeneration(appContext.db, {
        platformAccountId: page.id,
        generation: 5,
        lastSeenBefore: sweepStartedAt,
      });

      const { rows } = await testDb!.pool.query<{ platform_subscription_id: string; is_current: boolean }>(
        "select platform_subscription_id, is_current from page_subscriptions order by platform_subscription_id",
      );
      expect(rows).toEqual([
        { platform_subscription_id: "701", is_current: false },
        { platform_subscription_id: "702", is_current: true },
        { platform_subscription_id: "703", is_current: true },
      ]);
    }, INTEGRATION_TEST_TIMEOUT_MS);
  });

  describe("P-26 — subscription projection serializes behind the sweep", () => {
    it("carries the sweep's fresher dates forward instead of clobbering them", async () => {
      const page = await seedMappedPage("p26");
      const fan = await seedFan("801", page.id);
      const renewDate = new Date("2026-07-01T00:00:00Z");
      const occurredAt = new Date("2026-06-13T09:00:00Z");

      // The projection created the subscription earlier — no dates yet.
      await upsertPageSubscription(appContext.db, {
        platformSubscriptionId: "801",
        platformAccountId: page.id,
        fanId: fan.id,
        rawStatus: 0,
        canonicalStatus: "active",
        priceMills: 4990n,
        renewPriceMills: 4990n,
        sourceCreatedAt: occurredAt,
        sourceUpdatedAt: occurredAt,
        lastSeenGeneration: null,
      });

      const journalRow = await insertOfapiWebhookEvent(appContext.db, {
        idempotencyKey: "evt_p26_renewal",
        eventType: "subscriptions.renewed",
        ofapiAccountId: ACCOUNT_ID,
        payload: {
          event: "subscriptions.renewed",
          account_id: ACCOUNT_ID,
          payload: {
            createdAt: "2026-06-13T10:00:00Z",
            user: { id: 801, username: "fan_801", name: "Fan 801", subscribePrice: 4.99 },
          },
        },
        projectionStatus: "pending",
      });
      expect(journalRow).not.toBeNull();

      let releaseSweep = () => {};
      const sweepGate = new Promise<void>((resolve) => {
        releaseSweep = resolve;
      });
      let sweepLocked = () => {};
      const sweepLockAcquired = new Promise<void>((resolve) => {
        sweepLocked = resolve;
      });

      // Simulates the audience sweep: lock the row, hold the transaction open,
      // then write the authoritative dates and generation stamp.
      const sweepTransaction = appContext.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        await findPageSubscription(db, {
          platformAccountId: page.id,
          platformSubscriptionId: "801",
          forUpdate: true,
        });
        sweepLocked();
        await sweepGate;
        await upsertPageSubscription(db, {
          platformSubscriptionId: "801",
          platformAccountId: page.id,
          fanId: fan.id,
          rawStatus: 0,
          canonicalStatus: "active",
          priceMills: 4990n,
          renewPriceMills: 4990n,
          autoRenew: true,
          renewDate,
          endsAt: renewDate,
          sourceCreatedAt: occurredAt,
          sourceUpdatedAt: occurredAt,
          lastSeenGeneration: 7,
        });
      });

      await Promise.race([sweepLockAcquired, sweepTransaction]);
      const projection = runOfapiSubscriptionProjectionForSettledRow(appContext, {
        id: journalRow!.id,
        eventType: "subscriptions.renewed",
        ofapiAccountId: ACCOUNT_ID,
        payload: {
          event: "subscriptions.renewed",
          account_id: ACCOUNT_ID,
          payload: {
            createdAt: "2026-06-13T10:00:00Z",
            user: { id: 801, username: "fan_801", name: "Fan 801", subscribePrice: 4.99 },
          },
        },
        projectionStatus: "pending",
        receivedAt: new Date("2026-06-13T10:00:01Z"),
      });

      await waitForRowLockWait(testDb!.pool, ["%page_subscriptions%"], { blocked: projection });
      expect(await hasSettled(projection)).toBe(false);

      releaseSweep();
      await sweepTransaction;
      await projection;

      // The projection re-read the row after the sweep's commit: the sweep's
      // dates and generation stamp survive (pre-fix: clobbered back to null).
      const subscription = await findPageSubscription(appContext.db, {
        platformAccountId: page.id,
        platformSubscriptionId: "801",
      });
      expect(subscription?.renewDate?.toISOString()).toBe(renewDate.toISOString());
      expect(subscription?.endsAt?.toISOString()).toBe(renewDate.toISOString());
      expect(subscription?.lastSeenGeneration).toBe(7);
      expect(subscription?.autoRenew).toBe(true);
      expect(subscription?.isCurrent).toBe(true);
    }, INTEGRATION_TEST_TIMEOUT_MS);
  });
});
