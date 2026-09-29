import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  getNotificationDeliveryOutboxByIncident,
  getNotificationIncidentByKey,
  getNotificationIncidentPaging,
  getTelegramSettings,
  insertDeliveryAttempt,
  listNotificationIncidentCyclesSince,
  openNotificationIncidentWithRecoveryGuard,
  recoverAndResolveNotificationIncident,
  updateTelegramSettings,
  type NotificationIncidentKind,
} from "@agency_hub_core/db";

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
    });
    expect((await outboxFor(key)).rows.map((row) => row.transition)).toEqual(["opened"]);
    expect((await getNotificationIncidentPaging(testDb!.db, incident.id))?.pagedResolvedAt).toEqual(at(3 * MINUTE));
  });

  it("leaves the AI critical kinds to their own atomic outbox", async () => {
    const key = await openLatch({ kind: "ai_provider_billing", platformAccountId: null, at: T0 });
    expect(await runNotificationPagingSweep(app(), { now: at(MINUTE) })).toMatchObject({ examined: 0 });
    const { incident, rows } = await outboxFor(key);
    expect(rows).toEqual([]);
    expect(await getNotificationIncidentPaging(testDb!.db, incident.id)).toBeNull();
  });
});
