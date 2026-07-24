import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getNotificationDeliveryOutboxByIncident,
  getNotificationIncidentByKey,
  getTelegramSettings,
  leaseNotificationDeliveryOutbox,
  listDeliveryAttempts,
  listNotificationIncidentsWithPages,
  openNotificationIncident,
  updateTelegramSettings,
} from "@agency_hub_core/db";

import { runNotificationDeliveryOutbox } from "../apps/runtime/src/services/notification-delivery-outbox.ts";
import { openCriticalNotificationIncident } from "../apps/runtime/src/services/notification-incidents.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

async function enableCriticalPaging(db: StartedTestDatabase["db"]) {
  await getTelegramSettings(db);
  await updateTelegramSettings(db, {
    enabled: true,
    aiCriticalAlertsEnabled: true,
  });
}

function criticalOutbox(messageText: string, maxAttempts = 5) {
  return {
    channel: "telegram" as const,
    messageText,
    pagingPolicy: "ai_critical" as const,
    maxAttempts,
  };
}

describe("durable notification delivery outbox", () => {
  it("rolls back the incident transition when its outbox insert fails", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const incidentKey = "ai_provider_failed:global:atomicity-fixture";
    await expect(openNotificationIncident(testDb.db, {
      incidentKey,
      kind: "ai_provider_failed",
      platformAccountId: null,
      outbox: {
        channel: "telegram",
        messageText: "fixture",
        // Deliberately violate the database check after the incident insert;
        // the test proves both writes share one transaction.
        pagingPolicy: "invalid-fixture" as never,
      },
    })).rejects.toThrow();

    expect(await getNotificationIncidentByKey(testDb.db, incidentKey)).toBeNull();
    const outboxCount = await testDb.pool.query<{ count: number }>(
      "select count(*)::int as count from notification_delivery_outbox",
    );
    expect(outboxCount.rows[0]?.count).toBe(0);
  });

  it("persists the incident and a dashboard-visible suppression while paging defaults off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const transitionAt = new Date("2026-07-24T10:00:00.000Z");
    const incidentKey = "ai_provider_billing:global:anthropic";
    const app = createTestAppContext(testDb);
    const opened = await openCriticalNotificationIncident(app, {
      kind: "ai_provider_billing",
      platformAccountId: null,
      pageLabel: null,
      platform: null,
      subKey: "anthropic",
      errorCode: "provider_billing",
      errorSummary: "Provider billing is unavailable",
      occurredAt: transitionAt,
    });

    expect(opened).toBe(true);
    const incident = await getNotificationIncidentByKey(testDb.db, incidentKey);
    expect(incident).not.toBeNull();
    const outbox = await getNotificationDeliveryOutboxByIncident(testDb.db, incident!.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      pagingPolicy: "ai_critical",
      state: "suppressed",
      attemptCount: 0,
      suppressionReason: "ai_critical_alerts_disabled",
    });

    const incidents = await listNotificationIncidentsWithPages(testDb.db);
    expect(incidents.items).toEqual([
      expect.objectContaining({
        id: incident!.id,
        kind: "ai_provider_billing",
        status: "open",
        outboxState: "suppressed",
        outboxAttemptCount: 0,
        outboxSuppressionReason: "ai_critical_alerts_disabled",
      }),
    ]);
    expect(await listDeliveryAttempts(testDb.db)).toEqual([]);
  });

  it("dedupes a transition and recovers a lease crash before send exactly once", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await enableCriticalPaging(testDb.db);
    const transitionAt = new Date("2026-07-24T11:00:00.000Z");
    const incidentKey = "ai_provider_failed:global:anthropic";
    const opened = await openNotificationIncident(testDb.db, {
      incidentKey,
      kind: "ai_provider_failed",
      platformAccountId: null,
      errorCode: "provider_failed",
      errorSummary: "Provider generation failed",
      now: transitionAt,
      outbox: criticalOutbox("AI provider generation failed"),
    });
    const duplicate = await openNotificationIncident(testDb.db, {
      incidentKey,
      kind: "ai_provider_failed",
      platformAccountId: null,
      errorCode: "provider_failed",
      errorSummary: "Provider generation failed",
      now: transitionAt,
      outbox: criticalOutbox("AI provider generation failed"),
    });
    expect(duplicate.transition).toBe("existing");

    const rows = await getNotificationDeliveryOutboxByIncident(testDb.db, opened.incident.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("pending");

    // Simulate process death after the durable row was leased, before the
    // sender was called or an attempt was journaled.
    const abandonedLease = await leaseNotificationDeliveryOutbox(testDb.db, {
      now: transitionAt,
      leaseMs: 1_000,
    });
    expect(abandonedLease?.id).toBe(rows[0]?.id);
    expect(await listDeliveryAttempts(testDb.db)).toEqual([]);

    const sender = vi.fn(async () => ({
      status: "sent" as const,
      chatId: "123",
      messageId: 77,
    }));
    const app = createTestAppContext(testDb);
    const recovered = await runNotificationDeliveryOutbox(app, {
      now: new Date(transitionAt.getTime() + 1_001),
      maxRows: 1,
      sender,
    });

    expect(recovered).toMatchObject({
      leased: 1,
      delivered: 1,
      retrying: 0,
      exhausted: 0,
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith({
      text: "AI provider generation failed",
      idempotencyKey: rows[0]?.idempotencyKey,
    });

    const delivered = await getNotificationDeliveryOutboxByIncident(testDb.db, opened.incident.id);
    expect(delivered[0]).toMatchObject({
      state: "delivered",
      attemptCount: 1,
      lastError: null,
    });
    expect(await listDeliveryAttempts(testDb.db)).toEqual([
      expect.objectContaining({
        kind: "incident_opened",
        status: "sent",
        notificationIncidentId: opened.incident.id,
        messageId: 77,
      }),
    ]);

    await runNotificationDeliveryOutbox(app, {
      now: new Date(transitionAt.getTime() + 2_000),
      maxRows: 1,
      sender,
    });
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("records every failed attempt and enters explicit exhaustion", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await enableCriticalPaging(testDb.db);
    const transitionAt = new Date("2026-07-24T12:00:00.000Z");
    const opened = await openNotificationIncident(testDb.db, {
      incidentKey: "ai_provider_failed:global:openrouter",
      kind: "ai_provider_failed",
      platformAccountId: null,
      errorCode: "provider_failed",
      errorSummary: "Provider generation failed",
      now: transitionAt,
      outbox: criticalOutbox("AI provider generation failed", 2),
    });
    const app = createTestAppContext(testDb);
    const sender = vi.fn(async () => ({
      status: "failed" as const,
      error: "Telegram unavailable",
    }));

    await runNotificationDeliveryOutbox(app, {
      now: transitionAt,
      maxRows: 1,
      retryDelayMs: 1_000,
      sender,
    });
    await runNotificationDeliveryOutbox(app, {
      now: new Date(transitionAt.getTime() + 1_000),
      maxRows: 1,
      retryDelayMs: 1_000,
      sender,
    });

    const outbox = await getNotificationDeliveryOutboxByIncident(testDb.db, opened.incident.id);
    expect(outbox[0]).toMatchObject({
      state: "exhausted",
      attemptCount: 2,
      lastError: "Telegram unavailable",
    });
    const attempts = await listDeliveryAttempts(testDb.db);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.status === "failed")).toBe(true);
  });
});
