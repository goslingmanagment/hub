import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALERT_DELIVERY_MAX_ATTEMPTS,
  enqueueNotificationDeliveryOutbox,
  getNotificationDeliveryOutboxByIncident,
  getNotificationIncidentByKey,
  getTelegramSettings,
  leaseNotificationDeliveryOutbox,
  listDeliveryAttempts,
  listNotificationIncidentsWithPages,
  openNotificationIncident,
  recoverAndResolveNotificationIncident,
  releaseNotificationDeliveryBackoff,
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TIMEOUT = {
  status: "failed" as const,
  error: "Telegram API request timed out through the service proxy.",
};
const SENT = { status: "sent" as const, chatId: "1", messageId: 1 };

/** A `sync_failure` row as the paging sweep enqueues it (Д2 horizon). */
async function syncFailureRow(db: StartedTestDatabase["db"], name: string, at: Date, incident = name) {
  const { incident: row } = await openNotificationIncident(db, {
    incidentKey: `proxy_failed:global:${incident}`,
    kind: "proxy_failed",
    platformAccountId: null,
    now: at,
  });
  return enqueueNotificationDeliveryOutbox(db, {
    notificationIncidentId: row.id,
    transition: "opened",
    transitionAt: at,
    request: {
      channel: "telegram",
      messageText: `🚨 ${name}`,
      pagingPolicy: "sync_failure",
      maxAttempts: ALERT_DELIVERY_MAX_ATTEMPTS,
    },
    now: at,
  });
}

async function outboxRow(id: number) {
  const { rows } = await testDb!.pool.query<{
    state: string;
    attempt_count: number;
    available_at: Date;
    delivered_at: Date | null;
  }>("select state, attempt_count, available_at, delivered_at from notification_delivery_outbox where id = $1", [id]);
  return rows[0]!;
}

/** Puts a row in backoff as earlier failed passes would have. */
async function backOff(id: number, input: { attempts: number; until: Date }) {
  await testDb!.pool.query(
    "update notification_delivery_outbox set attempt_count = $2, available_at = $3, last_error = 'timed out' where id = $1",
    [id, input.attempts, input.until],
  );
}

async function delivered(id: number, at: Date) {
  await testDb!.pool.query(
    "update notification_delivery_outbox set state = 'delivered', attempt_count = 1, delivered_at = $2 where id = $1",
    [id, at],
  );
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

  it("holds a resolution behind an opening alert that is still retrying", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await enableCriticalPaging(testDb.db);
    const app = createTestAppContext(testDb);
    const openedAt = new Date("2026-07-24T12:00:00.000Z");
    const incidentKey = "ai_provider_billing:global";
    const opened = await openNotificationIncident(testDb.db, {
      incidentKey,
      kind: "ai_provider_billing",
      platformAccountId: null,
      now: openedAt,
      outbox: criticalOutbox("🚨 opened"),
    });

    // One transient Telegram failure pushes the opening row into backoff.
    const failing = vi.fn(async () => ({
      status: "failed" as const,
      error: "Telegram unavailable",
    }));
    await runNotificationDeliveryOutbox(app, {
      now: openedAt,
      maxRows: 5,
      retryDelayMs: 60_000,
      sender: failing,
    });
    expect(failing).toHaveBeenCalledTimes(1);

    // A success one second later resolves the incident and enqueues its
    // resolution, which is immediately due while the opening row is not.
    const recoveredAt = new Date(openedAt.getTime() + 1_000);
    await recoverAndResolveNotificationIncident(testDb.db, {
      incidentKey,
      recoveredAt,
      processedAt: recoveredAt,
      outbox: criticalOutbox("✅ resolved"),
    });

    const blocked = vi.fn(async (_delivery: { text: string }) => ({
      status: "sent" as const,
      chatId: "1",
      messageId: 1,
    }));
    const blockedSweep = await runNotificationDeliveryOutbox(app, {
      now: recoveredAt,
      maxRows: 5,
      sender: blocked,
    });

    // Without the FIFO fence this sweep would page "✅ resolved" for an alert
    // the operator never received, then deliver the stale "🚨 opened" later.
    expect(blockedSweep.leased).toBe(0);
    expect(blocked).not.toHaveBeenCalled();

    // Once the opening alert lands, the resolution is released — in order.
    const sent = vi.fn(async (_delivery: { text: string }) => ({
      status: "sent" as const,
      chatId: "1",
      messageId: 2,
    }));
    const drained = await runNotificationDeliveryOutbox(app, {
      now: new Date(openedAt.getTime() + 61_000),
      maxRows: 5,
      sender: sent,
    });

    expect(drained.delivered).toBe(2);
    expect(sent.mock.calls.map(([delivery]) => delivery.text)).toEqual([
      "🚨 opened",
      "✅ resolved",
    ]);
    const rows = await getNotificationDeliveryOutboxByIncident(testDb.db, opened.incident.id);
    expect(rows.map((row) => row.state)).toEqual(["delivered", "delivered"]);
  });

  it("releases a resolution once the opening alert is terminally exhausted", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await enableCriticalPaging(testDb.db);
    const app = createTestAppContext(testDb);
    const openedAt = new Date("2026-07-24T12:00:00.000Z");
    const incidentKey = "ai_provider_billing:global";
    await openNotificationIncident(testDb.db, {
      incidentKey,
      kind: "ai_provider_billing",
      platformAccountId: null,
      now: openedAt,
      outbox: criticalOutbox("🚨 opened", 1),
    });

    const failing = vi.fn(async () => ({
      status: "failed" as const,
      error: "Telegram unavailable",
    }));
    await runNotificationDeliveryOutbox(app, { now: openedAt, maxRows: 5, sender: failing });

    const recoveredAt = new Date(openedAt.getTime() + 1_000);
    await recoverAndResolveNotificationIncident(testDb.db, {
      incidentKey,
      recoveredAt,
      processedAt: recoveredAt,
      outbox: criticalOutbox("✅ resolved"),
    });

    const sent = vi.fn(async (_delivery: { text: string }) => ({
      status: "sent" as const,
      chatId: "1",
      messageId: 3,
    }));
    const sweep = await runNotificationDeliveryOutbox(app, {
      now: recoveredAt,
      maxRows: 5,
      sender: sent,
    });

    // Terminal states never block: the orphan resolution DOES page on its own.
    // Recorded behavior, deliberately left to a separate owner decision.
    expect(sweep.delivered).toBe(1);
    expect(sent.mock.calls.map(([delivery]) => delivery.text)).toEqual(["✅ resolved"]);
  });

  it("takes a fresh lease clock per row instead of one batch timestamp", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await enableCriticalPaging(testDb.db);
    const app = createTestAppContext(testDb);
    const startedAt = new Date("2026-07-24T12:00:00.000Z");
    for (const suffix of ["alpha", "beta"]) {
      await openNotificationIncident(testDb.db, {
        incidentKey: `ai_provider_failed:global:${suffix}`,
        kind: "ai_provider_failed",
        platformAccountId: null,
        now: startedAt,
        outbox: criticalOutbox(`🚨 ${suffix}`),
      });
    }

    // A sender that "takes" two minutes per row; the clock advances with it.
    let elapsedMs = 0;
    const leaseExpiries: Array<Date | null> = [];
    const slow = vi.fn(async (delivery: { text: string }) => {
      const { rows } = await testDb!.pool.query<{ lease_expires_at: Date | null }>(
        `select lease_expires_at from notification_delivery_outbox
         where message_text = $1`,
        [delivery.text],
      );
      leaseExpiries.push(rows[0]?.lease_expires_at ?? null);
      elapsedMs += 120_000;
      return { status: "sent" as const, chatId: "1", messageId: 1 };
    });

    await runNotificationDeliveryOutbox(app, {
      clock: () => new Date(startedAt.getTime() + elapsedMs),
      maxRows: 5,
      sender: slow,
    });

    expect(leaseExpiries).toHaveLength(2);
    const [first, second] = leaseExpiries;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // One batch timestamp would have given both rows the SAME expiry, and the
    // second row's lease would already be 120s stale when it was granted.
    expect(second!.getTime() - first!.getTime()).toBe(120_000);
  });

  // Д2: a pass used to go on through every due row while Telegram was down —
  // ~40 s a failed send, older rows burning their attempts and newer ones
  // never reached. The first send that does not go through ends the pass.
  it("stops the pass at the first failed send and leaves the other due rows untouched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await getTelegramSettings(testDb.db);
    const app = createTestAppContext(testDb);
    const at = new Date("2026-10-05T15:30:00.000Z");
    const rows = [
      await syncFailureRow(testDb.db, "socket", at),
      await syncFailureRow(testDb.db, "stopped", new Date(at.getTime() + 1_000)),
      await syncFailureRow(testDb.db, "freshness", new Date(at.getTime() + 2_000)),
    ];
    const sender = vi.fn(async () => TIMEOUT);

    const pass = await runNotificationDeliveryOutbox(app, { now: new Date(at.getTime() + 3_000), sender });

    expect(sender).toHaveBeenCalledTimes(1);
    expect(pass).toMatchObject({ leased: 1, retrying: 1, delivered: 0, stoppedOnFailure: true });
    expect(await outboxRow(rows[0]!.id)).toMatchObject({ state: "pending", attempt_count: 1 });
    for (const row of rows.slice(1)) {
      expect(await outboxRow(row.id)).toMatchObject({ state: "pending", attempt_count: 0 });
    }
    expect(await listDeliveryAttempts(testDb.db)).toHaveLength(1);
  });

  it("a skipped send also stops the pass", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await getTelegramSettings(testDb.db);
    const app = createTestAppContext(testDb);
    const at = new Date("2026-10-05T15:30:00.000Z");
    await syncFailureRow(testDb.db, "socket", at);
    await syncFailureRow(testDb.db, "stopped", new Date(at.getTime() + 1_000));
    const sender = vi.fn(async () => ({ status: "skipped" as const, reason: "unconfigured" as const }));

    const pass = await runNotificationDeliveryOutbox(app, { now: new Date(at.getTime() + 2_000), sender });

    expect(sender).toHaveBeenCalledTimes(1);
    expect(pass).toMatchObject({ leased: 1, retrying: 1, stoppedOnFailure: true });
    expect((await listDeliveryAttempts(testDb.db)).map((attempt) => attempt.status)).toEqual(["skipped"]);
  });

  it("a delivery that ends 15 minutes of silence makes every backed-off sync_failure row due at once", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await enableCriticalPaging(testDb.db);
    const app = createTestAppContext(testDb);
    const t0 = new Date("2026-10-05T16:06:16.000Z");
    // The last row Telegram accepted went out 20 minutes ago.
    const last = await syncFailureRow(testDb.db, "before the outage", new Date(t0.getTime() - 25 * MINUTE));
    await delivered(last.id, new Date(t0.getTime() - 20 * MINUTE));
    // Two alerts failed during the outage and wait out a 15-minute backoff;
    // so does an AI critical alert, which keeps its own pace.
    const socket = await syncFailureRow(testDb.db, "socket", new Date(t0.getTime() - 30 * MINUTE));
    const stopped = await syncFailureRow(testDb.db, "stopped", new Date(t0.getTime() - 28 * MINUTE));
    await backOff(socket.id, { attempts: 6, until: new Date(t0.getTime() + 12 * MINUTE) });
    await backOff(stopped.id, { attempts: 5, until: new Date(t0.getTime() + 9 * MINUTE) });
    const ai = await openNotificationIncident(testDb.db, {
      incidentKey: "ai_provider_failed:global:anthropic",
      kind: "ai_provider_failed",
      platformAccountId: null,
      now: new Date(t0.getTime() - 3 * MINUTE),
      outbox: criticalOutbox("🚨 ai"),
    });
    const aiRow = (await getNotificationDeliveryOutboxByIncident(testDb.db, ai.incident.id))[0]!;
    const aiUntil = new Date(t0.getTime() + 4 * MINUTE);
    await backOff(aiRow.id, { attempts: 2, until: aiUntil });
    // Telegram is back; the one row due is a fresh page.
    await syncFailureRow(testDb.db, "fresh", t0);

    const sender = vi.fn(async (_delivery: { text: string }) => SENT);
    const pass = await runNotificationDeliveryOutbox(app, { now: t0, sender });

    expect(sender.mock.calls.map(([delivery]) => delivery.text)).toEqual(["🚨 fresh", "🚨 socket", "🚨 stopped"]);
    expect(pass).toMatchObject({ delivered: 3, released: 2, stoppedOnFailure: false });
    expect(await outboxRow(aiRow.id)).toMatchObject({ state: "pending", attempt_count: 2, available_at: aiUntil });
  });

  it("a delivery within 15 minutes of the previous one releases nothing, and ai_critical rows are never released", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await enableCriticalPaging(testDb.db);
    const app = createTestAppContext(testDb);
    const t0 = new Date("2026-10-05T16:06:16.000Z");
    const last = await syncFailureRow(testDb.db, "a minute ago", new Date(t0.getTime() - 6 * MINUTE));
    await delivered(last.id, new Date(t0.getTime() - 5 * MINUTE));
    // Failed AFTER the channel was back: it waits its ordinary backoff.
    const flaky = await syncFailureRow(testDb.db, "flaky", new Date(t0.getTime() - 30 * MINUTE));
    const flakyUntil = new Date(t0.getTime() + 30 * MINUTE);
    await backOff(flaky.id, { attempts: 6, until: flakyUntil });
    const ai = await openNotificationIncident(testDb.db, {
      incidentKey: "ai_provider_failed:global:anthropic",
      kind: "ai_provider_failed",
      platformAccountId: null,
      now: new Date(t0.getTime() - 3 * MINUTE),
      outbox: criticalOutbox("🚨 ai"),
    });
    const aiRow = (await getNotificationDeliveryOutboxByIncident(testDb.db, ai.incident.id))[0]!;
    const aiUntil = new Date(t0.getTime() + 30 * MINUTE);
    await backOff(aiRow.id, { attempts: 3, until: aiUntil });
    await syncFailureRow(testDb.db, "fresh", t0);

    const sender = vi.fn(async (_delivery: { text: string }) => SENT);
    expect(await runNotificationDeliveryOutbox(app, { now: t0, sender })).toMatchObject({ delivered: 1, released: 0 });
    expect(sender.mock.calls.map(([delivery]) => delivery.text)).toEqual(["🚨 fresh"]);
    expect(await outboxRow(flaky.id)).toMatchObject({ state: "pending", available_at: flakyUntil });

    // Twenty minutes later a delivery does end a silence: the alert is
    // released, the AI critical row is not.
    const t20 = new Date(t0.getTime() + 20 * MINUTE);
    await syncFailureRow(testDb.db, "later", t20);
    expect(await runNotificationDeliveryOutbox(app, { now: t20, sender })).toMatchObject({ delivered: 2, released: 1 });
    expect(sender.mock.calls.map(([delivery]) => delivery.text)).toEqual(["🚨 fresh", "🚨 later", "🚨 flaky"]);
    expect(await outboxRow(aiRow.id)).toMatchObject({ state: "pending", attempt_count: 3, available_at: aiUntil });
  });

  // The astra scenario: a release after ANY success burned the alert's 200
  // attempts in ≈3 h and an AI row's 5 in ≈4 min. Released only after 15 min
  // without a delivery, a row that always fails gets ≤ 4 attempts an hour
  // while the rest goes through, ≤ 8 while outages alternate with successes.
  it("an alternating channel does not burn the horizon", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await enableCriticalPaging(testDb.db);
    const app = createTestAppContext(testDb);
    const start = new Date("2026-10-05T00:00:00.000Z");
    // The channel was working a minute before the scenario starts.
    const warm = await syncFailureRow(testDb.db, "warm", new Date(start.getTime() - 2 * MINUTE), "other");
    await delivered(warm.id, new Date(start.getTime() - MINUTE));
    const x = await syncFailureRow(testDb.db, "x", start);
    const ai = await openNotificationIncident(testDb.db, {
      incidentKey: "ai_provider_failed:global:anthropic",
      kind: "ai_provider_failed",
      platformAccountId: null,
      now: start,
      outbox: criticalOutbox("🚨 ai"),
    });
    const aiRow = (await getNotificationDeliveryOutboxByIncident(testDb.db, ai.incident.id))[0]!;

    let tick = start;
    const attempts = { x: [] as number[], ai: [] as number[] };
    const sender = async (delivery: { text: string }) => {
      if (delivery.text === "🚨 x") {
        attempts.x.push(tick.getTime() - start.getTime());
        return TIMEOUT;
      }
      if (delivery.text === "🚨 ai") {
        attempts.ai.push(tick.getTime() - start.getTime());
        return TIMEOUT;
      }
      return SENT;
    };

    // Phase 1, 6 h: every minute a new row of another incident goes through.
    for (let minute = 0; minute < 360; minute += 1) {
      tick = new Date(start.getTime() + minute * MINUTE);
      await syncFailureRow(testDb.db, `ok ${minute}`, tick, "other");
      await runNotificationDeliveryOutbox(app, { now: tick, sender });
    }
    // Phase 2, 6 h: 20-minute outages, each closed by one row that goes through.
    for (let minute = 360; minute < 720; minute += 1) {
      tick = new Date(start.getTime() + minute * MINUTE);
      if ((minute - 360) % 20 === 19) {
        await syncFailureRow(testDb.db, `back ${minute}`, tick, "other");
      }
      await runNotificationDeliveryOutbox(app, { now: tick, sender });
    }

    const perHour = (from: number, to: number) => {
      const counts: number[] = [];
      for (let hour = from; hour < to; hour += 1) {
        counts.push(attempts.x.slice(4).filter((at) => at >= hour * HOUR && at < (hour + 1) * HOUR).length);
      }
      return counts;
    };
    expect(attempts.x.slice(0, 4)).toEqual([0, 1, 3, 7].map((minutes) => minutes * MINUTE));
    expect(Math.max(...perHour(0, 6))).toBeLessThanOrEqual(4);
    expect(Math.max(...perHour(6, 12))).toBeLessThanOrEqual(8);
    expect(perHour(6, 12).some((count) => count > 4)).toBe(true);
    const xRow = await outboxRow(x.id);
    expect(xRow.state).toBe("pending");
    expect(xRow.attempt_count).toBe(attempts.x.length);
    expect(xRow.attempt_count).toBeLessThan(ALERT_DELIVERY_MAX_ATTEMPTS / 4);

    // The AI critical row keeps its own pace: 1, 2, 4, 8 minutes apart at
    // least, exhausted no earlier than 15 min after its first attempt.
    expect(attempts.ai).toHaveLength(5);
    const gaps = attempts.ai.slice(1).map((at, index) => at - attempts.ai[index]!);
    gaps.forEach((gap, index) => expect(gap).toBeGreaterThanOrEqual(2 ** index * MINUTE));
    expect(attempts.ai[4]! - attempts.ai[0]!).toBeGreaterThanOrEqual(15 * MINUTE);
    expect(await outboxRow(aiRow.id)).toMatchObject({ state: "exhausted", attempt_count: 5 });
  }, 120_000);

  it("the backoff release skips a row another transaction holds", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await getTelegramSettings(testDb.db);
    const t0 = new Date("2026-10-05T16:06:16.000Z");
    const held = await syncFailureRow(testDb.db, "held", new Date(t0.getTime() - 30 * MINUTE));
    const free = await syncFailureRow(testDb.db, "free", new Date(t0.getTime() - 29 * MINUTE));
    const until = new Date(t0.getTime() + 10 * MINUTE);
    await backOff(held.id, { attempts: 6, until });
    await backOff(free.id, { attempts: 6, until });
    const fresh = await syncFailureRow(testDb.db, "fresh", t0);
    await delivered(fresh.id, t0);

    // The paging sweep holds the row while it settles the page.
    const holder = await testDb.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from notification_delivery_outbox where id = $1 for update", [held.id]);
      expect(await releaseNotificationDeliveryBackoff(testDb.db, { now: t0, deliveredOutboxId: fresh.id })).toBe(1);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    expect(await outboxRow(held.id)).toMatchObject({ state: "pending", available_at: until });
    expect(await outboxRow(free.id)).toMatchObject({ state: "pending", available_at: t0 });
  });
});
