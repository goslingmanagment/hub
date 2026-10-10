import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALERT_DELIVERY_MAX_ATTEMPTS,
  createFanslyPage,
  createModel,
  getNotificationDeliveryOutboxByIncident,
  getNotificationIncidentByKey,
  getNotificationIncidentPaging,
  getTelegramSettings,
  insertDeliveryAttempt,
  leaseNotificationDeliveryOutbox,
  listNotificationIncidentCyclesSince,
  openNotificationIncidentWithRecoveryGuard,
  recoverAndResolveNotificationIncident,
  settleNotificationDeliveryOutboxAttempt,
  updateTelegramSettings,
  type NotificationIncidentKind,
} from "@agency_hub_core/db";

import {
  runNotificationDeliveryOutbox,
  type NotificationOutboxDelivery,
} from "../apps/runtime/src/services/notification-delivery-outbox.ts";
import { incidentKey } from "../apps/runtime/src/services/notification-incidents.ts";
import {
  NOTIFICATION_PAGING_SWEEP_LOCK_KEY,
  NOTIFICATION_PAGING_SWEEP_LOCK_NS,
  runNotificationPagingSweep,
  runNotificationPagingSweepExclusive,
} from "../apps/runtime/src/services/notification-paging-sweep.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Decision 381: the sweep that owns paging. Every case here is a production
// shape from 2026-09-15..21 — the proxy blip that healed in two minutes, the
// proxy that hiccuped all day, the deploy gap the watchdog mistook for a dead
// scheduler — and the one message each of them is now worth.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-09-21T10:00:00.000Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

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
  await getTelegramSettings(testDb.db);
});

function app() {
  return {
    db: testDb!.db,
    logger: { info() {}, warn() {}, error() {} } as never,
  };
}

async function makePage(label = "lilly-1") {
  const model = await createModel(testDb!.db, { slug: `${label}-model`, name: label });
  if (!model) {
    throw new Error("model fixture was not created");
  }
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label });
  if (!page) {
    throw new Error("page fixture was not created");
  }
  return page;
}

async function openLatch(input: {
  kind: NotificationIncidentKind;
  platformAccountId: number | null;
  stream?: "dm_messages" | "posts";
  subKey?: string;
  at: Date;
}) {
  const key = incidentKey({
    kind: input.kind,
    platformAccountId: input.platformAccountId,
    stream: input.stream ?? null,
    subKey: input.subKey ?? null,
  });
  await openNotificationIncidentWithRecoveryGuard(testDb!.db, {
    incidentKey: key,
    kind: input.kind,
    platformAccountId: input.platformAccountId,
    stream: input.stream ?? null,
    errorSummary: "fetch failed",
    occurredAt: input.at,
    now: input.at,
  });
  return key;
}

async function resolveLatch(key: string, at: Date) {
  await recoverAndResolveNotificationIncident(testDb!.db, {
    incidentKey: key,
    recoveredAt: at,
    processedAt: at,
  });
}

/** A delivery pass whose Telegram accepts everything: the page reached the
 * owner before its latch resolved. */
async function deliver(now: Date, sent: NotificationOutboxDelivery[] = []) {
  return runNotificationDeliveryOutbox(createTestAppContext(testDb!), {
    now,
    sender: async (delivery) => {
      sent.push(delivery);
      return { status: "sent" as const, chatId: "1", messageId: sent.length };
    },
  });
}

async function failDelivery(now: Date) {
  return runNotificationDeliveryOutbox(createTestAppContext(testDb!), {
    now,
    sender: async () => ({ status: "failed" as const, error: "Telegram API request timed out through the service proxy." }),
  });
}

interface SummaryRow {
  id: number;
  notification_incident_id: number;
  transition: string;
  transition_at: Date;
  state: string;
  attempt_count: number;
  max_attempts: number;
  message_text: string;
  reported: number[];
}

/** The missed-alerts summaries and the openings each one reports. */
async function summaries(): Promise<SummaryRow[]> {
  const { rows } = await testDb!.pool.query<SummaryRow>(`
    select s.id::int as id, s.notification_incident_id::int as notification_incident_id, s.transition,
           s.transition_at, s.state, s.attempt_count, s.max_attempts, s.message_text,
           coalesce(array_agg(r.id::int order by r.id) filter (where r.id is not null), '{}') as reported
      from notification_delivery_outbox s
      left join notification_delivery_outbox r on r.reported_in_outbox_id = s.id
     where s.message_text like '📵%'
     group by s.id
     order by s.id`);
  return rows;
}

const MISSED_HEADER = "📵 Not delivered in time — these alerts opened and resolved before Telegram accepted them:";

async function outboxFor(key: string) {
  const incident = await getNotificationIncidentByKey(testDb!.db, key);
  if (!incident) {
    throw new Error(`no incident for ${key}`);
  }
  const rows = await getNotificationDeliveryOutboxByIncident(testDb!.db, incident.id);
  return { incident, rows };
}

/** Waits until `count` sessions of this database are parked on a lock, or
 * until `done` says the awaited pass finished without parking. */
async function waitForLockWaiters(count: number, done: () => boolean = () => false) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (done()) {
      return;
    }
    const waiting = await testDb!.pool.query<{ count: number }>(
      `select count(*)::int as count from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((waiting.rows[0]?.count ?? 0) >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} lock waiter(s)`);
}

describe("notification paging sweep (Decision 381)", () => {
  it("a proxy blip that heals inside the hold pages nothing and is kept as a quiet episode", async () => {
    const page = await makePage();
    const key = await openLatch({ kind: "proxy_failed", platformAccountId: page.id, stream: "dm_messages", at: T0 });

    expect(await runNotificationPagingSweep(app(), { now: at(MINUTE) })).toMatchObject({
      examined: 1,
      episodesRecorded: 1,
      paged: 0,
    });
    await resolveLatch(key, at(2 * MINUTE));
    expect(await runNotificationPagingSweep(app(), { now: at(3 * MINUTE) })).toMatchObject({ paged: 0, resolved: 0 });

    const { rows } = await outboxFor(key);
    expect(rows).toEqual([]);
    const cycles = await listNotificationIncidentCyclesSince(testDb!.db, { since: at(-HOUR) });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ paged: false, openedAt: T0, resolvedAt: at(2 * MINUTE), pageLabel: "lilly-1" });
  });

  it("an episode that opened and closed between two sweeps is still counted", async () => {
    const page = await makePage();
    const key = await openLatch({ kind: "proxy_failed", platformAccountId: page.id, at: T0 });
    await resolveLatch(key, at(30_000));

    await runNotificationPagingSweep(app(), { now: at(MINUTE) });
    const cycles = await listNotificationIncidentCyclesSince(testDb!.db, { since: at(-HOUR) });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.resolvedAt).toEqual(at(30_000));
  });

  it("the ~5 minute deploy gap the watchdog used to page twice a day pages nothing", async () => {
    const key = await openLatch({ kind: "scheduler_silent", platformAccountId: null, at: T0 });
    await runNotificationPagingSweep(app(), { now: at(MINUTE) });
    await resolveLatch(key, at(5 * MINUTE + 30_000));
    await runNotificationPagingSweep(app(), { now: at(6 * MINUTE) });
    await runNotificationPagingSweep(app(), { now: at(HOUR) });
    expect((await outboxFor(key)).rows).toEqual([]);
  });

  it("five deploy gaps inside six hours are five quiet episodes, not a flapping page", async () => {
    // Each deploy restarts the scheduler; the default flap rule (5 in 6 h)
    // paged "flapping" on the fifth deploy of a busy afternoon.
    let key = "";
    for (let deploy = 0; deploy < 5; deploy += 1) {
      const start = deploy * HOUR;
      key = await openLatch({ kind: "scheduler_silent", platformAccountId: null, at: at(start) });
      await runNotificationPagingSweep(app(), { now: at(start + MINUTE) });
      await resolveLatch(key, at(start + 5 * MINUTE + 30_000));
      await runNotificationPagingSweep(app(), { now: at(start + 6 * MINUTE) });
    }
    await runNotificationPagingSweep(app(), { now: at(5 * HOUR) });
    expect((await outboxFor(key)).rows).toEqual([]);
    const cycles = await listNotificationIncidentCyclesSince(testDb!.db, { since: at(-HOUR) });
    expect(cycles.map((cycle) => cycle.paged)).toEqual([false, false, false, false, false]);
  });

  it("the exclusive sweep skips a pass while another process holds the sweep lock", async () => {
    const key = await openLatch({ kind: "scheduler_silent", platformAccountId: null, at: T0 });
    const exclusiveApp = { ...app(), pool: testDb!.pool };
    const holder = await testDb!.pool.connect();
    try {
      await holder.query("select pg_advisory_lock($1, $2)", [
        NOTIFICATION_PAGING_SWEEP_LOCK_NS,
        NOTIFICATION_PAGING_SWEEP_LOCK_KEY,
      ]);
      expect(await runNotificationPagingSweepExclusive(exclusiveApp, { now: at(11 * MINUTE) })).toBeNull();
      expect((await outboxFor(key)).rows).toEqual([]);
    } finally {
      await holder.query("select pg_advisory_unlock_all()");
      holder.release();
    }

    expect(await runNotificationPagingSweepExclusive(exclusiveApp, { now: at(11 * MINUTE) }))
      .toMatchObject({ paged: 1 });
    expect((await outboxFor(key)).rows.map((row) => row.transition)).toEqual(["opened"]);
    // The lock is a session lock on a dedicated client: it is released, not leaked.
    const held = await testDb!.pool.query(
      `select count(*)::int as count from pg_locks
       where locktype = 'advisory' and classid = $1 and objid = $2
         and database = (select oid from pg_database where datname = current_database())`,
      [NOTIFICATION_PAGING_SWEEP_LOCK_NS, NOTIFICATION_PAGING_SWEEP_LOCK_KEY],
    );
    expect(held.rows[0]?.count).toBe(0);
  });

  it("two sweeps racing over a flapping latch page it once: the second skips while the first holds the lock", async () => {
    // A flapping page is keyed by its decision instant, so two unserialised
    // sweeps a few seconds apart would enqueue two different pages.
    const page = await makePage("lora-2");
    let key = "";
    for (let episode = 0; episode < 4; episode += 1) {
      const start = episode * 30 * MINUTE;
      key = await openLatch({ kind: "proxy_failed", platformAccountId: page.id, stream: "posts", at: at(start) });
      await runNotificationPagingSweep(app(), { now: at(start + 30_000) });
      await resolveLatch(key, at(start + MINUTE));
      await runNotificationPagingSweep(app(), { now: at(start + 2 * MINUTE) });
    }
    await openLatch({ kind: "proxy_failed", platformAccountId: page.id, stream: "posts", at: at(2 * HOUR) });
    const exclusiveApp = { ...app(), pool: testDb!.pool };

    // Park the first sweep mid-pass: it holds the sweep lock and waits on the
    // paging table, which a third session keeps locked.
    const blocker = await testDb!.pool.connect();
    let committed = false;
    try {
      await blocker.query("begin");
      await blocker.query("lock table notification_incident_paging in access exclusive mode");
      const first = runNotificationPagingSweepExclusive(exclusiveApp, { now: at(2 * HOUR + 30_000) });
      await waitForLockWaiters(1);
      let secondSettled = false;
      const second = runNotificationPagingSweepExclusive(exclusiveApp, { now: at(2 * HOUR + 40_000) })
        .finally(() => {
          secondSettled = true;
        });
      // Without the lock the second pass would park on the table beside the first.
      await waitForLockWaiters(2, () => secondSettled);
      await blocker.query("commit");
      committed = true;

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(secondResult).toBeNull();
      expect(firstResult).toMatchObject({ paged: 1 });
    } finally {
      if (!committed) {
        await blocker.query("rollback").catch(() => undefined);
      }
      blocker.release();
    }
    const { rows } = await outboxFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageText).toContain("Flapping: 5 episodes in the last 6 h");
  });

  it("a failure that outlasts the hold pages once and its recovery waits for the quiet hold", async () => {
    const page = await makePage("lora-2");
    const key = await openLatch({ kind: "proxy_failed", platformAccountId: page.id, stream: "posts", at: T0 });

    await runNotificationPagingSweep(app(), { now: at(14 * MINUTE) });
    expect((await outboxFor(key)).rows).toEqual([]);

    expect(await runNotificationPagingSweep(app(), { now: at(16 * MINUTE) })).toMatchObject({ paged: 1 });
    let { incident, rows } = await outboxFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ transition: "opened", transitionAt: T0, pagingPolicy: "sync_failure", state: "pending" });
    expect(rows[0]?.messageText).toContain("🚨 Proxy failed");
    expect(rows[0]?.messageText).toContain("Page: lora-2 (fansly)");
    expect(rows[0]?.messageText).toContain("Stream: posts");
    expect(rows[0]?.messageText).toContain("Open for 16 min");
    expect(await getNotificationIncidentPaging(testDb!.db, incident.id)).toMatchObject({
      pagedMode: "sustained",
      pagedOpenedAt: T0,
      pagedResolvedAt: null,
    });

    // Idempotent: the same standing page is not enqueued twice.
    await runNotificationPagingSweep(app(), { now: at(17 * MINUTE) });
    expect((await outboxFor(key)).rows).toHaveLength(1);
    await deliver(at(17 * MINUTE));

    await resolveLatch(key, at(20 * MINUTE));
    expect(await runNotificationPagingSweep(app(), { now: at(21 * MINUTE) })).toMatchObject({ resolved: 0 });
    expect((await outboxFor(key)).rows).toHaveLength(1);

    expect(await runNotificationPagingSweep(app(), { now: at(51 * MINUTE) })).toMatchObject({ resolved: 1 });
    ({ incident, rows } = await outboxFor(key));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ transition: "resolved", transitionAt: at(20 * MINUTE) });
    expect(rows[1]?.messageText).toContain("✅ Resolved");
    expect(rows[1]?.messageText).toContain("Proxy failed: lora-2 (fansly)");
    expect(rows[1]?.messageText).toContain("Quiet for 31 min · was open 20 min");
    expect((await getNotificationIncidentPaging(testDb!.db, incident.id))?.pagedResolvedAt).toEqual(at(51 * MINUTE));

    const cycles = await listNotificationIncidentCyclesSince(testDb!.db, { since: at(-HOUR) });
    expect(cycles.map((cycle) => cycle.paged)).toEqual([true]);
  });

  it("a reopen inside the recovery hold is the same incident and produces no message", async () => {
    const page = await makePage();
    const key = await openLatch({ kind: "proxy_failed", platformAccountId: page.id, at: T0 });
    await runNotificationPagingSweep(app(), { now: at(16 * MINUTE) });
    await deliver(at(16 * MINUTE));
    await resolveLatch(key, at(20 * MINUTE));
    await runNotificationPagingSweep(app(), { now: at(21 * MINUTE) });

    await openLatch({ kind: "proxy_failed", platformAccountId: page.id, at: at(25 * MINUTE) });
    await runNotificationPagingSweep(app(), { now: at(26 * MINUTE) });
    expect((await outboxFor(key)).rows).toHaveLength(1);

    await resolveLatch(key, at(30 * MINUTE));
    await runNotificationPagingSweep(app(), { now: at(45 * MINUTE) });
    expect((await outboxFor(key)).rows).toHaveLength(1);

    await runNotificationPagingSweep(app(), { now: at(61 * MINUTE) });
    const { rows } = await outboxFor(key);
    expect(rows.map((row) => row.transition)).toEqual(["opened", "resolved"]);
    expect(rows[1]?.messageText).toContain("was open 30 min");
    // Both episodes are covered by the one page.
    const cycles = await listNotificationIncidentCyclesSince(testDb!.db, { since: at(-HOUR) });
    expect(cycles.map((cycle) => cycle.paged)).toEqual([true, true]);
  });

  it("five short episodes inside six hours page once as flapping", async () => {
    const page = await makePage("lora-2");
    let key = "";
    for (let episode = 0; episode < 5; episode += 1) {
      const start = episode * 30 * MINUTE;
      key = await openLatch({ kind: "proxy_failed", platformAccountId: page.id, stream: "posts", at: at(start) });
      await runNotificationPagingSweep(app(), { now: at(start + 30_000) });
      await resolveLatch(key, at(start + MINUTE));
      await runNotificationPagingSweep(app(), { now: at(start + 2 * MINUTE) });
      if (episode < 4) {
        expect((await outboxFor(key)).rows).toEqual([]);
      }
    }
    const { rows } = await outboxFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ transition: "opened" });
    expect(rows[0]?.messageText).toContain("🚨 Proxy failed");
    expect(rows[0]?.messageText).toContain("Flapping: 5 episodes in the last 6 h, each healing before the 15 min hold");
    await deliver(at(2 * HOUR + 3 * MINUTE));

    // A sixth episode inside the storm is silent; quiet for the hold announces the end.
    await openLatch({ kind: "proxy_failed", platformAccountId: page.id, at: at(2 * HOUR + 40 * MINUTE) });
    await runNotificationPagingSweep(app(), { now: at(2 * HOUR + 41 * MINUTE) });
    await resolveLatch(key, at(2 * HOUR + 42 * MINUTE));
    await runNotificationPagingSweep(app(), { now: at(2 * HOUR + 50 * MINUTE) });
    expect((await outboxFor(key)).rows).toHaveLength(1);
    await runNotificationPagingSweep(app(), { now: at(3 * HOUR + 13 * MINUTE) });
    const after = (await outboxFor(key)).rows;
    expect(after).toHaveLength(2);
    expect(after[1]?.messageText).toContain("flapped for 2 h 42 min");
  });

  it("an immediate kind pages on the first sweep and announces recovery after its short hold", async () => {
    const page = await makePage();
    const key = await openLatch({ kind: "auth_blocked", platformAccountId: page.id, at: T0 });
    expect(await runNotificationPagingSweep(app(), { now: at(20_000) })).toMatchObject({ paged: 1 });
    const { rows } = await outboxFor(key);
    expect(rows[0]?.messageText).toBe("🚨 Auth failed\nPage: lilly-1 (fansly)\nError: fetch failed");
    await deliver(at(30_000));

    await resolveLatch(key, at(MINUTE));
    await runNotificationPagingSweep(app(), { now: at(2 * MINUTE) });
    expect((await outboxFor(key)).rows).toHaveLength(1);
    await runNotificationPagingSweep(app(), { now: at(7 * MINUTE) });
    expect((await outboxFor(key)).rows.map((row) => row.transition)).toEqual(["opened", "resolved"]);
  });

  it("a global latch pages with its subKey-specific title and no page line", async () => {
    const key = await openLatch({
      kind: "db_disk_usage",
      platformAccountId: null,
      subKey: "runway_critical",
      at: T0,
    });
    await runNotificationPagingSweep(app(), { now: at(MINUTE) });
    const { rows } = await outboxFor(key);
    expect(rows[0]?.messageText).toBe("🚨 Server disk usage high\nError: fetch failed");

    // The warning latch, by contrast, holds for hours.
    const warning = await openLatch({
      kind: "db_disk_usage",
      platformAccountId: null,
      subKey: "runway_warning",
      at: T0,
    });
    await runNotificationPagingSweep(app(), { now: at(5 * HOUR) });
    expect((await outboxFor(warning)).rows).toEqual([]);
    await runNotificationPagingSweep(app(), { now: at(6 * HOUR + MINUTE) });
    expect((await outboxFor(warning)).rows).toHaveLength(1);
  });

  it("alerts off: the page is recorded as suppressed and not resent when alerts come back", async () => {
    await updateTelegramSettings(testDb!.db, { syncFailureAlertsEnabled: false });
    const page = await makePage();
    const key = await openLatch({ kind: "auth_blocked", platformAccountId: page.id, at: T0 });
    await runNotificationPagingSweep(app(), { now: at(MINUTE) });
    let { rows } = await outboxFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "suppressed", suppressionReason: "sync_failure_alerts_disabled" });

    await updateTelegramSettings(testDb!.db, { syncFailureAlertsEnabled: true });
    await runNotificationPagingSweep(app(), { now: at(2 * MINUTE) });
    ({ rows } = await outboxFor(key));
    expect(rows).toHaveLength(1);

    // …and a page that never reached Telegram gets no orphan "Resolved".
    await resolveLatch(key, at(3 * MINUTE));
    expect(await runNotificationPagingSweep(app(), { now: at(9 * MINUTE) })).toMatchObject({
      resolved: 0,
      silentlyResolved: 1,
    });
    const { incident, rows: after } = await outboxFor(key);
    expect(after.map((row) => row.transition)).toEqual(["opened"]);
    expect((await getNotificationIncidentPaging(testDb!.db, incident.id))?.pagedResolvedAt).toEqual(at(9 * MINUTE));
  });

  it("a manual resolve from the dashboard settles the page without a second recovery notice", async () => {
    const page = await makePage();
    const key = await openLatch({ kind: "auth_blocked", platformAccountId: page.id, at: T0 });
    await runNotificationPagingSweep(app(), { now: at(MINUTE) });
    const { incident } = await outboxFor(key);

    await resolveLatch(key, at(2 * MINUTE));
    await insertDeliveryAttempt(testDb!.db, {
      kind: "incident_manually_resolved",
      status: "sent",
      notificationIncidentId: incident.id,
    });
    expect(await runNotificationPagingSweep(app(), { now: at(3 * MINUTE) })).toMatchObject({
      resolved: 0,
      silentlyResolved: 1,
      missedReported: 0,
    });
    const { rows } = await outboxFor(key);
    expect(rows.map((row) => row.transition)).toEqual(["opened"]);
    expect((await getNotificationIncidentPaging(testDb!.db, incident.id))?.pagedResolvedAt).toEqual(at(3 * MINUTE));

    // Д2: a manual resolve retires a pending opening without a summary — the
    // dashboard's own line already told the owner, a late "🚨" must not.
    expect(rows[0]).toMatchObject({
      state: "exhausted",
      exhaustedAt: at(3 * MINUTE),
      lastError: "Not delivered: manually resolved from the dashboard",
      reportedInOutboxId: null,
    });
    expect(await summaries()).toEqual([]);
    const sent: NotificationOutboxDelivery[] = [];
    await deliver(at(4 * MINUTE), sent);
    expect(sent).toEqual([]);
  });

  it("leaves the AI critical kinds to their own atomic outbox", async () => {
    const key = await openLatch({ kind: "ai_provider_billing", platformAccountId: null, at: T0 });
    expect(await runNotificationPagingSweep(app(), { now: at(MINUTE) })).toMatchObject({ examined: 0 });
    const { incident, rows } = await outboxFor(key);
    expect(rows).toEqual([]);
    expect(await getNotificationIncidentPaging(testDb!.db, incident.id)).toBeNull();
  });

  // Д2: an alert outlives a Telegram outage.
  describe("delivery horizon and missed alerts (Д2)", () => {
    it("every sync_failure transition is enqueued with the 48 h horizon", async () => {
      const page = await makePage();
      const seen = await openLatch({ kind: "auth_blocked", platformAccountId: page.id, at: T0 });
      const missed = await openLatch({ kind: "proxy_missing", platformAccountId: page.id, at: T0 });
      await runNotificationPagingSweep(app(), { now: at(MINUTE) });
      // Only the first page reaches Telegram before both latches close.
      const seenRows = (await outboxFor(seen)).rows;
      await testDb!.pool.query(
        "update notification_delivery_outbox set state = 'delivered', attempt_count = 1, delivered_at = $2 where id = $1",
        [seenRows[0]!.id, at(MINUTE)],
      );
      await resolveLatch(seen, at(2 * MINUTE));
      await resolveLatch(missed, at(2 * MINUTE));
      expect(await runNotificationPagingSweep(app(), { now: at(8 * MINUTE) })).toMatchObject({
        resolved: 1,
        missedReported: 1,
      });

      const { rows: all } = await testDb!.pool.query<{ transition: string; max_attempts: number; message_text: string }>(
        "select transition, max_attempts, message_text from notification_delivery_outbox order by id",
      );
      expect(all.map((row) => [row.transition, row.max_attempts, Array.from(row.message_text)[0]])).toEqual([
        ["opened", ALERT_DELIVERY_MAX_ATTEMPTS, "🚨"],
        ["opened", ALERT_DELIVERY_MAX_ATTEMPTS, "🚨"],
        ["resolved", ALERT_DELIVERY_MAX_ATTEMPTS, "✅"],
        ["resolved", ALERT_DELIVERY_MAX_ATTEMPTS, "📵"],
      ]);
      expect(ALERT_DELIVERY_MAX_ATTEMPTS).toBe(400);
    });

    it("a page that resolves while its opening is still pending is reported in the missed-alerts summary, not followed by a late pair", async () => {
      const page = await makePage("lilly-2");
      const key = await openLatch({ kind: "auth_blocked", platformAccountId: page.id, at: T0 });
      await runNotificationPagingSweep(app(), { now: at(20_000) });
      // Telegram is down: the opening waits in its backoff.
      await failDelivery(at(30_000));
      await resolveLatch(key, at(10 * MINUTE));
      expect(await runNotificationPagingSweep(app(), { now: at(16 * MINUTE) })).toMatchObject({
        resolved: 0,
        silentlyResolved: 0,
        missedReported: 1,
        deferred: 0,
      });

      const { incident, rows } = await outboxFor(key);
      const [summary] = await summaries();
      expect(rows.map((row) => [row.transition, row.state])).toEqual([["opened", "exhausted"], ["resolved", "pending"]]);
      expect(rows[0]).toMatchObject({
        attemptCount: 1,
        exhaustedAt: at(16 * MINUTE),
        lastError: "Not delivered: the page resolved before Telegram accepted it",
        reportedInOutboxId: summary!.id,
      });
      expect(summary).toMatchObject({
        notification_incident_id: incident.id,
        transition: "resolved",
        transition_at: at(10 * MINUTE),
        state: "pending",
        max_attempts: ALERT_DELIVERY_MAX_ATTEMPTS,
        reported: [rows[0]!.id],
      });
      expect(summary!.message_text).toBe(
        `${MISSED_HEADER}\n• Auth failed — lilly-2 (fansly) · 09-21 10:00 → 10:10 UTC (10 min)`,
      );
      expect(rows[1]?.idempotencyKey).toBe(`notification:${incident.id}:resolved:${at(10 * MINUTE).toISOString()}:telegram`);
      expect((await getNotificationIncidentPaging(testDb!.db, incident.id))?.pagedResolvedAt).toEqual(at(16 * MINUTE));

      // Telegram is back: the summary goes, the stale "🚨" and an orphan "✅" never do.
      const sent: NotificationOutboxDelivery[] = [];
      await deliver(at(17 * MINUTE), sent);
      expect(sent.map((delivery) => delivery.text)).toEqual([summary!.message_text]);
      await runNotificationPagingSweep(app(), { now: at(30 * MINUTE) });
      expect((await outboxFor(key)).rows).toHaveLength(2);
    });

    it("an opening already exhausted when the page resolves is reported too", async () => {
      // An older image's 5-attempt cap, or a page past its horizon.
      const page = await makePage();
      const key = await openLatch({ kind: "auth_blocked", platformAccountId: page.id, at: T0 });
      await runNotificationPagingSweep(app(), { now: at(20_000) });
      const opening = (await outboxFor(key)).rows[0]!;
      await testDb!.pool.query(
        `update notification_delivery_outbox set state = 'exhausted', attempt_count = 5, max_attempts = 5,
           exhausted_at = $2, last_error = 'Telegram API request timed out through the service proxy.' where id = $1`,
        [opening.id, at(16 * MINUTE)],
      );
      await resolveLatch(key, at(20 * MINUTE));
      expect(await runNotificationPagingSweep(app(), { now: at(26 * MINUTE) })).toMatchObject({
        silentlyResolved: 0,
        missedReported: 1,
      });
      const [summary] = await summaries();
      expect(summary).toMatchObject({ state: "pending", reported: [opening.id] });
      // The counter's own exhaustion stays on record.
      expect((await outboxFor(key)).rows[0]).toMatchObject({
        state: "exhausted",
        exhaustedAt: at(16 * MINUTE),
        lastError: "Telegram API request timed out through the service proxy.",
        reportedInOutboxId: summary!.id,
      });
    });

    it("missed episodes of different incidents accumulate in one pending summary", async () => {
      const first = await makePage("lilly-1");
      const second = await makePage("lora-2");
      const a = await openLatch({ kind: "auth_blocked", platformAccountId: first.id, at: T0 });
      const b = await openLatch({ kind: "proxy_missing", platformAccountId: second.id, at: at(MINUTE) });
      await runNotificationPagingSweep(app(), { now: at(2 * MINUTE) });
      await failDelivery(at(2 * MINUTE));
      await resolveLatch(a, at(5 * MINUTE));
      await runNotificationPagingSweep(app(), { now: at(11 * MINUTE) });
      await failDelivery(at(11 * MINUTE));
      await resolveLatch(b, at(20 * MINUTE));
      expect(await runNotificationPagingSweep(app(), { now: at(26 * MINUTE) })).toMatchObject({ missedReported: 1 });

      const all = await summaries();
      expect(all).toHaveLength(1);
      const { incident: carrier, rows: aRows } = await outboxFor(a);
      const { rows: bRows } = await outboxFor(b);
      expect(all[0]).toMatchObject({
        notification_incident_id: carrier.id,
        transition_at: at(5 * MINUTE),
        state: "pending",
        reported: [aRows[0]!.id, bRows[0]!.id],
      });
      expect(all[0]!.message_text.split("\n")).toEqual([
        MISSED_HEADER,
        "• Auth failed — lilly-1 (fansly) · 09-21 10:00 → 10:05 UTC (5 min)",
        "• Fansly proxy missing — sync refused (fail-closed) — lora-2 (fansly) · 09-21 10:01 → 10:20 UTC (19 min)",
      ]);
      // The appended episode gets a full horizon on top of what the summary used.
      expect(all[0]!.max_attempts).toBe(all[0]!.attempt_count + ALERT_DELIVERY_MAX_ATTEMPTS);
      expect(bRows.map((row) => row.transition)).toEqual(["opened"]);
    });

    it("a summary in flight is not edited: the next missed episode starts a new summary and its opening is retired at once", async () => {
      const first = await makePage("lilly-1");
      const second = await makePage("lora-2");
      const a = await openLatch({ kind: "auth_blocked", platformAccountId: first.id, at: T0 });
      await runNotificationPagingSweep(app(), { now: at(20_000) });
      await failDelivery(at(30_000));
      await resolveLatch(a, at(5 * MINUTE));
      await runNotificationPagingSweep(app(), { now: at(11 * MINUTE) });
      const b = await openLatch({ kind: "proxy_missing", platformAccountId: second.id, at: at(6 * MINUTE) });
      await runNotificationPagingSweep(app(), { now: at(11 * MINUTE + 10_000) });
      await resolveLatch(b, at(12 * MINUTE));
      const [summaryA] = await summaries();
      const bOpening = (await outboxFor(b)).rows[0]!;

      // Telegram is back. The pass sends summary A first; while it is on the
      // wire, the sweep settles page B — whose opening is still pending.
      const sent: NotificationOutboxDelivery[] = [];
      let sweepDuringSend: Awaited<ReturnType<typeof runNotificationPagingSweep>> | null = null;
      const pass = await runNotificationDeliveryOutbox(createTestAppContext(testDb!), {
        now: at(18 * MINUTE),
        sender: async (delivery) => {
          if (sent.length === 0) {
            const leased = await testDb!.pool.query<{ state: string }>(
              "select state from notification_delivery_outbox where id = $1",
              [summaryA!.id],
            );
            expect(leased.rows[0]?.state).toBe("leased");
            sweepDuringSend = await runNotificationPagingSweep(app(), { now: at(18 * MINUTE) });
          }
          sent.push(delivery);
          return { status: "sent" as const, chatId: "1", messageId: sent.length };
        },
      });

      // Not deferred: the opening was retired in the same transaction as the
      // new summary A2, so the pass that went on after A never saw it.
      expect(sweepDuringSend).toMatchObject({ missedReported: 1, deferred: 0 });
      const after = await summaries();
      expect(after).toHaveLength(2);
      const summaryA2 = after[1]!;
      expect(after[0]).toMatchObject({ id: summaryA!.id, state: "delivered", message_text: summaryA!.message_text });
      expect(summaryA2).toMatchObject({ state: "delivered", reported: [bOpening.id] });
      expect(summaryA2.message_text).toBe(
        `${MISSED_HEADER}\n• Fansly proxy missing — sync refused (fail-closed) — lora-2 (fansly) · 09-21 10:06 → 10:12 UTC (6 min)`,
      );
      expect(pass).toMatchObject({ delivered: 2, stoppedOnFailure: false });
      expect(sent.map((delivery) => delivery.idempotencyKey)).not.toContain(bOpening.idempotencyKey);
      expect(sent.map((delivery) => delivery.text)).toEqual([summaryA!.message_text, summaryA2.message_text]);

      // No "✅ B" later either.
      await runNotificationPagingSweep(app(), { now: at(40 * MINUTE) });
      expect((await outboxFor(b)).rows.map((row) => [row.transition, row.state])).toEqual([
        ["opened", "exhausted"],
        ["resolved", "delivered"],
      ]);
    });

    it("a summary on its last attempt takes a fresh episode with a full horizon", async () => {
      const first = await makePage("lilly-1");
      const second = await makePage("lora-2");
      const a = await openLatch({ kind: "auth_blocked", platformAccountId: first.id, at: T0 });
      await runNotificationPagingSweep(app(), { now: at(20_000) });
      await failDelivery(at(30_000));
      await resolveLatch(a, at(5 * MINUTE));
      await runNotificationPagingSweep(app(), { now: at(11 * MINUTE) });
      const [summary] = await summaries();
      // The outage has lasted: the summary has used 399 of its 400 attempts.
      await testDb!.pool.query(
        "update notification_delivery_outbox set attempt_count = 399, available_at = $2 where id = $1",
        [summary!.id, at(60 * MINUTE)],
      );
      const b = await openLatch({ kind: "proxy_missing", platformAccountId: second.id, at: at(20 * MINUTE) });
      await runNotificationPagingSweep(app(), { now: at(20 * MINUTE + 10_000) });
      await failDelivery(at(20 * MINUTE + 20_000));
      await resolveLatch(b, at(30 * MINUTE));
      expect(await runNotificationPagingSweep(app(), { now: at(36 * MINUTE) })).toMatchObject({ missedReported: 1 });
      const [extended] = await summaries();
      expect(extended).toMatchObject({ id: summary!.id, attempt_count: 399, max_attempts: 799 });

      // The next failure does not exhaust it…
      await testDb!.pool.query("update notification_delivery_outbox set available_at = $2 where id = $1", [
        summary!.id,
        at(60 * MINUTE),
      ]);
      expect(await failDelivery(at(60 * MINUTE))).toMatchObject({ leased: 1, retrying: 1, exhausted: 0 });
      expect((await summaries())[0]).toMatchObject({ state: "pending", attempt_count: 400 });

      // …and once Telegram is back it carries both episodes.
      const sent: NotificationOutboxDelivery[] = [];
      await deliver(at(2 * HOUR), sent);
      expect(sent.map((delivery) => delivery.text.split("\n"))).toEqual([[
        MISSED_HEADER,
        "• Auth failed — lilly-1 (fansly) · 09-21 10:00 → 10:05 UTC (5 min)",
        "• Fansly proxy missing — sync refused (fail-closed) — lora-2 (fansly) · 09-21 10:20 → 10:30 UTC (10 min)",
      ]]);
      expect((await summaries())[0]).toMatchObject({ state: "delivered" });
    });

    it("a summary that would pass 3 500 characters starts a new one", async () => {
      const first = await makePage("lilly-1");
      const second = await makePage("lora-2");
      const a = await openLatch({ kind: "auth_blocked", platformAccountId: first.id, at: T0 });
      await runNotificationPagingSweep(app(), { now: at(20_000) });
      await failDelivery(at(30_000));
      await resolveLatch(a, at(5 * MINUTE));
      await runNotificationPagingSweep(app(), { now: at(11 * MINUTE) });
      const [full] = await summaries();
      // A long outage has filled it close to the limit.
      const filled = `${full!.message_text}\n${"• earlier episode\n".repeat(200)}`.slice(0, 3_450);
      await testDb!.pool.query("update notification_delivery_outbox set message_text = $2 where id = $1", [full!.id, filled]);

      const b = await openLatch({ kind: "proxy_missing", platformAccountId: second.id, at: at(20 * MINUTE) });
      await runNotificationPagingSweep(app(), { now: at(20 * MINUTE + 10_000) });
      await resolveLatch(b, at(30 * MINUTE));
      await runNotificationPagingSweep(app(), { now: at(36 * MINUTE) });

      const all = await summaries();
      const bOpening = (await outboxFor(b)).rows[0]!;
      expect(all).toHaveLength(2);
      expect(all[0]).toMatchObject({ id: full!.id, message_text: filled });
      expect(all[1]).toMatchObject({ state: "pending", reported: [bOpening.id], transition_at: at(30 * MINUTE) });
      expect(all[1]!.message_text).toBe(
        `${MISSED_HEADER}\n• Fansly proxy missing — sync refused (fail-closed) — lora-2 (fansly) · 09-21 10:20 → 10:30 UTC (10 min)`,
      );
    });

    it("a page whose opening is in flight is settled only after the send settles", async () => {
      const page = await makePage();
      const key = await openLatch({ kind: "auth_blocked", platformAccountId: page.id, at: T0 });
      await runNotificationPagingSweep(app(), { now: at(20_000) });
      const lease = await leaseNotificationDeliveryOutbox(testDb!.db, { now: at(30_000) });
      expect(lease?.state).toBe("leased");
      await resolveLatch(key, at(MINUTE));

      // The send has not answered yet: nothing is decided, nothing written.
      expect(await runNotificationPagingSweep(app(), { now: at(7 * MINUTE) })).toMatchObject({
        deferred: 1,
        resolved: 0,
        missedReported: 0,
        silentlyResolved: 0,
      });
      const { incident, rows } = await outboxFor(key);
      expect(rows.map((row) => row.state)).toEqual(["leased"]);
      expect((await getNotificationIncidentPaging(testDb!.db, incident.id))?.pagedResolvedAt).toBeNull();
      expect(await summaries()).toEqual([]);

      // It went through: the recovery is the ordinary "✅".
      await settleNotificationDeliveryOutboxAttempt(testDb!.db, {
        outboxId: lease!.id,
        leaseToken: lease!.leaseToken!,
        delivery: { status: "sent", messageId: 9 },
        now: at(7 * MINUTE + 10_000),
      });
      expect(await runNotificationPagingSweep(app(), { now: at(8 * MINUTE) })).toMatchObject({ resolved: 1, deferred: 0 });
      const after = (await outboxFor(key)).rows;
      expect(after.map((row) => [row.transition, row.state])).toEqual([["opened", "delivered"], ["resolved", "pending"]]);
      expect(after[1]?.messageText).toContain("✅ Resolved");
    });
  });
});
