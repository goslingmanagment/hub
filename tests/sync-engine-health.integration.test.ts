import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { syncHealthResponseSchema } from "@agency_hub_core/contracts";
import { upsertDemand, type Database } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { getPublicSyncHealth } from "../apps/runtime/src/services/health.ts";
import { notifySyncEngineIncident } from "../apps/runtime/src/services/notification-incidents.ts";
import { getSyncStatusSnapshot } from "../apps/runtime/src/services/sync-status.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage, setModeDirect } from "./helpers/sync-engine-host.ts";

/**
 * `/health/sync` for pages the Fansly Sync Engine owns (design step 3 §3.2
 * item 1, E14), against a real database: a `handover`/`live` page is judged
 * by the engine — unhealthy on an owner silent for more than 90 s, an
 * `auth`/`identity_mismatch` hold, or a handover older than 10 minutes — and
 * reports an `engine` block; its frozen legacy streams are not judged. Every
 * other page reads exactly as before.
 */

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
const quietLogger = { warn() {}, info() {}, error() {}, debug() {} };

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function beat(pageId: number, secondsAgo: number): Promise<void> {
  await testDb!.pool.query(
    `update sync_pages
        set owner_generation = owner_generation + 1,
            owner_host = 'sync-test',
            owner_acquired_at = clock_timestamp() - interval '1 hour',
            owner_heartbeat_at = clock_timestamp() - $2::double precision * interval '1 second'
      where page_id = $1`,
    [pageId, secondsAgo],
  );
}

async function modeChangedMinutesAgo(pageId: number, minutes: number): Promise<void> {
  await testDb!.pool.query(
    "update sync_pages set mode_changed_at = clock_timestamp() - $2::double precision * interval '1 minute' where page_id = $1",
    [pageId, minutes],
  );
}

type HealthPage = ReturnType<typeof syncHealthResponseSchema.parse>["pages"][number];

async function health(pageIds?: number[]) {
  const result = await getPublicSyncHealth(app, pageIds === undefined ? {} : { pageIds });
  const body = syncHealthResponseSchema.parse(result.body);
  const byId = new Map<number, HealthPage>(body.pages.map((page) => [page.pageId, page]));
  return { statusCode: result.statusCode, body, byId };
}

const pages = { live: 0, stale: 0, auth: 0, stuck: 0, fresh: 0, legacy: 0 };

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  const handles = { db: db(), pool: testDb.pool };
  pages.live = (await seedSyncPage(handles, { label: "lilly-1" })).pageId;
  pages.stale = (await seedSyncPage(handles, { label: "lilly-2" })).pageId;
  pages.auth = (await seedSyncPage(handles, { label: "lora-1" })).pageId;
  pages.stuck = (await seedSyncPage(handles, { label: "lora-2" })).pageId;
  pages.fresh = (await seedSyncPage(handles, { label: "lora-3" })).pageId;
  pages.legacy = (await seedSyncPage(handles, { label: "ari-1", mode: "shadow" })).pageId;
});

describe("/health/sync on engine pages", () => {
  it("judges a page by the engine once it owns it; every other page reads as before", async () => {
    // Baseline: no page is the engine's.
    const before = await health();
    for (const page of before.body.pages) expect(page).not.toHaveProperty("engine");

    await setModeDirect(testDb!.pool, pages.live, "live");
    await beat(pages.live, 3);
    await setModeDirect(testDb!.pool, pages.stale, "live");
    await beat(pages.stale, 120);
    await setModeDirect(testDb!.pool, pages.auth, "live");
    await beat(pages.auth, 1);
    await testDb!.pool.query(
      `update sync_pages set hold_kind = 'auth', hold_until = 'infinity', hold_since = clock_timestamp(),
              hold_detail = '{"status":401,"credentialsGeneration":null}'::jsonb where page_id = $1`,
      [pages.auth],
    );
    await setModeDirect(testDb!.pool, pages.stuck, "handover");
    await beat(pages.stuck, 2);
    await modeChangedMinutesAgo(pages.stuck, 11);
    await setModeDirect(testDb!.pool, pages.fresh, "handover");
    await beat(pages.fresh, 2);
    await modeChangedMinutesAgo(pages.fresh, 1);

    const after = await health();
    expect(after.statusCode).toBe(503);
    // The legacy (shadow) page is byte-identical to the baseline.
    expect(after.byId.get(pages.legacy)).toEqual(before.byId.get(pages.legacy));

    const live = after.byId.get(pages.live)!;
    expect(live).toMatchObject({
      status: "ok",
      issues: [],
      failedStreams: 0,
      stalledStreams: 0,
      pendingStreams: 0,
      lastErrorSummary: null,
    });
    expect(live.engine).toEqual({
      mode: "live",
      ownerHeartbeatAgeSeconds: expect.any(Number),
      hold: null,
      urgentOldestAgeSeconds: null,
      wsConnected: false,
      wsDownSeconds: null,
      quarantined: 0,
      openAlerts: [],
    });
    expect(live.engine!.ownerHeartbeatAgeSeconds).toBeLessThanOrEqual(30);
    // The frozen legacy streams no longer fail the page (no light sync ever ran).
    expect(before.byId.get(pages.live)!.issues).toContain("light_sync_missing");

    expect(after.byId.get(pages.stale)).toMatchObject({ status: "degraded", issues: ["engine:owner_stale"] });
    expect(after.byId.get(pages.stale)!.engine!.ownerHeartbeatAgeSeconds).toBeGreaterThan(90);
    expect(after.byId.get(pages.auth)).toMatchObject({
      status: "degraded",
      issues: ["engine:auth_hold"],
      engine: { hold: { kind: "auth", until: "infinity" } },
    });
    expect(after.byId.get(pages.stuck)).toMatchObject({ status: "degraded", issues: ["engine:handover_stuck"] });
    expect(after.byId.get(pages.fresh)).toMatchObject({ status: "ok", issues: [], engine: { mode: "handover" } });
    expect(after.body.overall.unhealthyPageCount).toBe(
      before.byId.get(pages.legacy)!.status === "degraded" ? 4 : 3,
    );

    // Only healthy engine pages in scope: 200, and their blocks count as no
    // failed, stalled or pending stream.
    const scoped = await health([pages.live, pages.fresh]);
    expect(scoped.statusCode).toBe(200);
    expect(scoped.body.overall).toMatchObject({ unhealthyPageCount: 0, failedStreams: 0, stalledStreams: 0, pendingStreams: 0 });
  });

  it("reports the socket, the oldest due urgent work, quarantine and the open alert latches", async () => {
    await setModeDirect(testDb!.pool, pages.live, "live");
    await beat(pages.live, 1);
    await upsertDemand(db(), {
      pageId: pages.live, resource: "dm-messages.head", subject: "g-1", kind: "trigger", class: "urgent",
      dueAt: new Date(Date.now() - 45_000),
    });
    // Due in the future: not counted.
    await upsertDemand(db(), {
      pageId: pages.live, resource: "dm-messages.head", subject: "g-2", kind: "trigger", class: "urgent",
      dueAt: new Date(Date.now() + 600_000),
    });
    // A row shadow mode left behind is not the page's work.
    await testDb!.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, due_at)
       values ($1, true, 'dm-messages.head', 'g-3', 'trigger', 'urgent', clock_timestamp() - interval '10 minutes')`,
      [pages.live],
    );
    await upsertDemand(db(), { pageId: pages.live, resource: "transactions.rescan", kind: "poll", class: "planned" });
    await testDb!.pool.query(
      "update sync_work set state = 'quarantined', waiting_reason = 'quarantined' where page_id = $1 and resource = 'transactions.rescan'",
      [pages.live],
    );
    await testDb!.pool.query(
      `insert into fansly_ws_connections (id, page_id, generation, started_at, last_guard_at, verified_at, gap_since)
       values (gen_random_uuid(), $1, repeat('a', 64), clock_timestamp() - interval '5 minutes', clock_timestamp(),
               clock_timestamp() - interval '5 minutes', clock_timestamp() - interval '6 minutes')`,
      [pages.live],
    );
    await notifySyncEngineIncident({ db: db(), logger: quietLogger }, {
      subKey: "live_degraded",
      pageId: pages.live,
      pageLabel: "lilly-1",
      detail: "quarantined",
      errorSummary: "quarantined",
      occurredAt: new Date(),
    });

    const { byId } = await health([pages.live]);
    const engine = byId.get(pages.live)!.engine!;
    expect(engine).toMatchObject({ wsConnected: true, wsDownSeconds: 0, quarantined: 1, openAlerts: ["live_degraded"] });
    expect(engine.urgentOldestAgeSeconds).toBeGreaterThanOrEqual(40);
    expect(engine.urgentOldestAgeSeconds).toBeLessThan(600);
    // Quarantine alone does not make the page unhealthy (alert 2 pages it).
    expect(byId.get(pages.live)!.status).toBe("ok");

    // The socket closed two minutes ago: down for about that long.
    await testDb!.pool.query(
      "update fansly_ws_connections set closed_at = clock_timestamp() - interval '2 minutes', stop_reason = 'test' where page_id = $1",
      [pages.live],
    );
    const down = (await health([pages.live])).byId.get(pages.live)!.engine!;
    expect(down.wsConnected).toBe(false);
    expect(down.wsDownSeconds).toBeGreaterThanOrEqual(110);
  });

  it("an identity hold degrades the page; an expired rate-limit hold does not", async () => {
    await setModeDirect(testDb!.pool, pages.live, "live");
    await beat(pages.live, 1);
    await testDb!.pool.query(
      `update sync_pages set hold_kind = 'identity_mismatch', hold_until = 'infinity', hold_since = clock_timestamp(),
              hold_detail = '{}'::jsonb where page_id = $1`,
      [pages.live],
    );
    expect((await health([pages.live])).byId.get(pages.live)).toMatchObject({
      status: "degraded",
      issues: ["engine:identity_mismatch_hold"],
    });
    await testDb!.pool.query(
      `update sync_pages set hold_kind = 'rate_limit', hold_until = clock_timestamp() - interval '1 second'
        where page_id = $1`,
      [pages.live],
    );
    expect((await health([pages.live])).byId.get(pages.live)).toMatchObject({ status: "ok", engine: { hold: null } });
  });

  it("the status snapshot behind it reads every block of an engine page as the engine's", async () => {
    await setModeDirect(testDb!.pool, pages.auth, "live");
    await beat(pages.auth, 1);
    await testDb!.pool.query(
      `update sync_pages set hold_kind = 'auth', hold_until = 'infinity', hold_since = clock_timestamp(),
              hold_detail = '{}'::jsonb where page_id = $1`,
      [pages.auth],
    );
    const snapshot = await getSyncStatusSnapshot(app, { pageIds: [pages.auth, pages.legacy] });
    const engine = snapshot.pages.find((page) => page.pageId === pages.auth)!;
    for (const block of Object.values(engine.blocks)) {
      expect(block).toMatchObject({ state: "engine", engineMode: "live" });
    }
    expect(engine.blocks.connection).toMatchObject({
      connectionStatus: "error",
      needsAttention: true,
      statusReason: { code: "credentials_invalid" },
    });
    expect(engine.syncUx).toMatchObject({ state: "attention", requiresAction: true });
    const legacy = snapshot.pages.find((page) => page.pageId === pages.legacy)!;
    for (const block of Object.values(legacy.blocks)) {
      expect(block.state).not.toBe("engine");
      expect(block).not.toHaveProperty("engineMode");
    }
  });
});
