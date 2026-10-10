import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  getTelegramSettings,
  openNotificationIncidentWithRecoveryGuard,
  recoverAndResolveNotificationIncident,
} from "@agency_hub_core/db";

import {
  runNotificationDeliveryOutbox,
  type NotificationOutboxDelivery,
} from "../apps/runtime/src/services/notification-delivery-outbox.ts";
import { incidentKey } from "../apps/runtime/src/services/notification-incidents.ts";
import { runNotificationPagingSweep } from "../apps/runtime/src/services/notification-paging-sweep.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Д2: the afternoon of 2026-10-05. Telegram stopped answering at 15:27 and
// came back at 16:05:21; the Fansly Sync Engine opened and closed its alerts
// all the while (the latch transitions below are production's own, from
// notification_incident_cycles). The old outbox burned five attempts per row
// in about fifteen minutes, so the socket-down alerts that were still open at
// 16:05 never arrived, and the pages that healed during the outage closed in
// silence. Now every open alert arrives once Telegram is back, and the pages
// that opened and resolved unseen arrive as one summary.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const day = "2026-10-05";
const utc = (time: string) => new Date(`${day}T${time}.000Z`);
const OUTAGE_START = utc("15:27:00");
const OUTAGE_END = utc("16:05:21");
const TIMEOUT_ERROR = "Telegram API request timed out through the service proxy.";

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

async function makePage(label: string) {
  const model = await createModel(testDb!.db, { slug: `${label}-model`, name: label });
  const page = model ? await createFanslyPage(testDb!.db, { modelId: model.id, label }) : null;
  if (!page) {
    throw new Error(`page fixture ${label} was not created`);
  }
  return page;
}

interface OutboxRow {
  id: number;
  incident_key: string;
  transition: string;
  transition_at: Date;
  idempotency_key: string;
  message_text: string;
  state: string;
  attempt_count: number;
  max_attempts: number;
  delivered_at: Date | null;
  last_error: string | null;
}

async function outboxRows(): Promise<OutboxRow[]> {
  const { rows } = await testDb!.pool.query<OutboxRow>(`
    select o.id::int as id, n.incident_key, o.transition, o.transition_at, o.idempotency_key,
           o.message_text, o.state, o.attempt_count, o.max_attempts, o.delivered_at, o.last_error
      from notification_delivery_outbox o
      join notification_incidents n on n.id = o.notification_incident_id
     order by o.id`);
  return rows;
}

describe("Telegram outage of 2026-10-05 (Д2)", () => {
  it("replays the 2026-10-05 afternoon outage: open alerts arrive once Telegram is back, the healed ones in one summary", async () => {
    const app = createTestAppContext(testDb!);
    const pages = {
      2: await makePage("page-2"),
      3: await makePage("page-3"),
      4: await makePage("page-4"),
      10: await makePage("page-10"),
    };
    const key = (page: keyof typeof pages, subKey: string) =>
      incidentKey({ kind: "fansly_sync_engine", platformAccountId: pages[page].id, subKey });
    const latches = {
      111: { key: key(10, "live_degraded"), page: 10, episodes: [["15:27:24", "16:18:54"]] },
      112: { key: key(2, "live_degraded"), page: 2, episodes: [["15:27:24", "16:08:24"]] },
      115: { key: key(4, "live_degraded"), page: 4, episodes: [["15:28:24", "16:22:24"]] },
      118: { key: key(3, "page_stopped"), page: 3, episodes: [["15:32:54", "16:12:54"]] },
      121: { key: key(2, "page_stopped"), page: 2, episodes: [["15:33:54", "16:08:24"]] },
      116: {
        key: key(10, "freshness"),
        page: 10,
        episodes: [["15:32:54", "15:42:54"], ["15:48:24", "15:58:24"], ["16:03:54", "16:13:54"]],
      },
      102: {
        key: key(4, "freshness"),
        page: 4,
        episodes: [["15:26:24", "15:36:24"], ["15:41:54", "15:51:54"], ["15:57:24", "16:07:24"]],
      },
    } as const;
    const events = Object.values(latches)
      .flatMap((latch) => latch.episodes.flatMap(([openedAt, resolvedAt]) => [
        { at: utc(openedAt), key: latch.key, page: latch.page, action: "open" as const },
        { at: utc(resolvedAt), key: latch.key, page: latch.page, action: "resolve" as const },
      ]))
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    let tick = utc("15:26:16");
    const calls: Array<{ at: Date; idempotencyKey: string; text: string; status: "sent" | "failed" }> = [];
    const sender = async (delivery: NotificationOutboxDelivery) => {
      const failing = tick >= OUTAGE_START && tick < OUTAGE_END;
      calls.push({ at: tick, ...delivery, status: failing ? "failed" : "sent" });
      return failing
        ? { status: "failed" as const, error: TIMEOUT_ERROR }
        : { status: "sent" as const, chatId: "1", messageId: calls.length };
    };

    const callsPerTick = new Map<number, number>();
    let next = 0;
    for (; tick <= utc("16:40:16"); tick = new Date(tick.getTime() + MINUTE)) {
      for (; next < events.length && events[next]!.at <= tick; next += 1) {
        const event = events[next]!;
        if (event.action === "open") {
          await openNotificationIncidentWithRecoveryGuard(testDb!.db, {
            incidentKey: event.key,
            kind: "fansly_sync_engine",
            platformAccountId: pages[event.page].id,
            errorSummary: "socket down",
            occurredAt: event.at,
            now: event.at,
          });
        } else {
          await recoverAndResolveNotificationIncident(testDb!.db, {
            incidentKey: event.key,
            recoveredAt: event.at,
            processedAt: event.at,
          });
        }
      }
      const before = calls.length;
      await runNotificationPagingSweep(app, { now: tick });
      const now = tick;
      await runNotificationDeliveryOutbox(app, { clock: () => now, sender });
      callsPerTick.set(tick.getTime(), calls.length - before);
    }

    // During the outage a pass makes one call and stops: the old loop went on
    // through every due row at ~40 s a failed send.
    for (const [at, count] of callsPerTick) {
      if (at < OUTAGE_END.getTime()) {
        expect(count, new Date(at).toISOString()).toBeLessThanOrEqual(1);
      }
    }

    const rows = await outboxRows();
    const byKey = (incident: keyof typeof latches) => rows.filter((row) => row.incident_key === latches[incident].key);
    const openings = (incident: keyof typeof latches) => byKey(incident).filter((row) => row.transition !== "resolved");
    const sentKeys = new Set(calls.filter((call) => call.status === "sent").map((call) => call.idempotencyKey));

    // The first send after the outage: the latest the backoff ceiling allows
    // is 15 min after Telegram is back; the replay lands it on the first pass.
    const firstSent = calls.find((call) => call.status === "sent")!;
    expect(firstSent.at.getTime()).toBeLessThanOrEqual(OUTAGE_END.getTime() + 15 * MINUTE);
    expect(firstSent.at).toEqual(utc("16:06:16"));

    // Every alert still open when Telegram came back is delivered in that
    // pass or the next one: the five socket-down / stopped-page openings and
    // the two pages that reopened after their first episode was missed.
    const stillOpen = [
      ...[111, 112, 115, 118, 121].map((incident) => openings(incident as keyof typeof latches)[0]!),
      openings(116).find((row) => row.transition_at.getTime() === utc("15:48:24").getTime())!,
      openings(102).find((row) => row.transition_at.getTime() === utc("15:57:24").getTime())!,
    ];
    for (const row of stillOpen) {
      expect(row, row.incident_key).toMatchObject({ state: "delivered", max_attempts: 400 });
      expect(row.delivered_at!.getTime()).toBeLessThanOrEqual(firstSent.at.getTime() + MINUTE);
      expect(sentKeys.has(row.idempotency_key)).toBe(true);
    }

    // The two pages that opened and resolved unseen: one summary, carried by
    // the first of them (116, decided 15:48:16), and 102's episode (decided
    // 15:57:16) appended to it. Their own "🚨" was tried while Telegram was
    // down and never once after the decision: no late page.
    const missed = [
      { row: openings(116)[0]!, decidedAt: utc("15:48:16") },
      { row: openings(102)[0]!, decidedAt: utc("15:57:16") },
    ].map(({ row, decidedAt }) => {
      expect(row.state).toBe("exhausted");
      expect(row.last_error).toBe("Not delivered: the page resolved before Telegram accepted it");
      const tried = calls.filter((call) => call.idempotencyKey === row.idempotency_key);
      expect(tried.every((call) => call.status === "failed" && call.at < decidedAt)).toBe(true);
      return row;
    });
    const summary = byKey(116).find((row) => row.transition === "resolved" && row.message_text.startsWith("📵"))!;
    expect(summary).toMatchObject({
      state: "delivered",
      transition_at: utc("15:42:54"),
      max_attempts: expect.any(Number),
    });
    expect(summary.message_text).toBe([
      "📵 Not delivered in time — these alerts opened and resolved before Telegram accepted them:",
      "• Fansly Sync Engine freshness broken (messages, money or urgent work late) — page-10 (fansly) · 10-05 15:32 → 15:42 UTC (10 min)",
      "• Fansly Sync Engine freshness broken (messages, money or urgent work late) — page-4 (fansly) · 10-05 15:26 → 15:51 UTC (25 min)",
    ].join("\n"));
    expect(byKey(102).filter((row) => row.message_text.startsWith("📵"))).toEqual([]);
    const reported = await testDb!.pool.query<{ id: number; reported_in_outbox_id: number | null }>(
      `select id::int as id, reported_in_outbox_id::int as reported_in_outbox_id
         from notification_delivery_outbox where reported_in_outbox_id is not null order by id`,
    );
    expect(reported.rows).toEqual(missed
      .map((row) => ({ id: row.id, reported_in_outbox_id: summary.id }))
      .sort((a, b) => a.id - b.id));

    // The summary goes before 116's next page: first "it was an episode",
    // then "🚨 again".
    const order = calls.filter((call) => call.status === "sent").map((call) => call.idempotencyKey);
    const reopened116 = openings(116)[1]!;
    expect(order.indexOf(summary.idempotency_key)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(summary.idempotency_key)).toBeLessThan(order.indexOf(reopened116.idempotency_key));

    // Then the ordinary "✅" after each quiet hold, one per page that was seen.
    for (const incident of [111, 112, 115, 118, 121, 116, 102] as const) {
      const resolved = byKey(incident)
        .filter((row) => row.transition === "resolved" && row.message_text.startsWith("✅ Resolved"));
      expect(resolved, String(incident)).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ state: "delivered", max_attempts: 400 });
    }

    // Nothing was given up on: no exhausted row outside a summary.
    expect(rows.filter((row) => row.state === "exhausted").map((row) => row.id).sort())
      .toEqual(missed.map((row) => row.id).sort());
    expect(rows.filter((row) => row.state === "pending" || row.state === "leased")).toEqual([]);
  }, 120_000);
});
