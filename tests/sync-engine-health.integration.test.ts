import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { syncHealthResponseSchema } from "@agency_hub_core/contracts";
import { createModel, createOnlyFansPage, upsertDemand, type Database } from "@agency_hub_core/db";

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
 * `/health/sync` for Fansly pages (design step 3 §3.2 item 1, E14; step 4
 * S4-24), against a real database: a `handover`/`live` page is judged by the
 * engine — unhealthy on an owner silent for more than 90 s, an
 * `auth`/`identity_mismatch` hold, or a handover older than 10 minutes — and
 * reports an `engine` block. A Fansly page the engine does not own is read by
 * nothing: unhealthy with the one issue `engine:not_live`, whatever its legacy
 * rows say. The legacy stream checks judge the legacy executor's pages
 * (OnlyFans) only.
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

const pages = { live: 0, stale: 0, auth: 0, stuck: 0, fresh: 0, unowned: 0, onlyfans: 0 };

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
  pages.unowned = (await seedSyncPage(handles, { label: "ari-1", mode: "shadow" })).pageId;
  const model = await createModel(db(), { slug: "of-model", name: "OF model" });
  pages.onlyfans = (await createOnlyFansPage(db(), { modelId: model!.id, label: "lora-of" }))!.id;
});

describe("/health/sync on engine pages", () => {
  it("judges a Fansly page by the engine once it owns it, and as read by nothing until then; an OnlyFans page by "
    + "its legacy streams", async () => {
    // Baseline: no page is the engine's. Every Fansly page is one nothing
    // reads — no legacy check speaks for it (no light sync ever ran, no
    // follower read, no credentials: none of it is an issue of its own).
    const before = await health();
    for (const page of before.body.pages) expect(page).not.toHaveProperty("engine");
    for (const pageId of [pages.live, pages.stale, pages.auth, pages.stuck, pages.fresh, pages.unowned]) {
      expect(before.byId.get(pageId)).toMatchObject({
        platform: "fansly",
        status: "degraded",
        issues: ["engine:not_live"],
        lastErrorSummary: "engine:not_live",
        failedStreams: 0,
        stalledStreams: 0,
        pendingStreams: 0,
      });
    }
    // The legacy executor's page keeps its legacy checks, and has no follower read.
    expect(before.byId.get(pages.onlyfans)).toMatchObject({
      platform: "onlyfans",
      status: "degraded",
      followerAgeMinutes: null,
    });
    expect(before.byId.get(pages.onlyfans)!.issues).toEqual(["connection:unverified", "light_sync_missing"]);
    expect(before.body.thresholds).toEqual({ lightMaxAgeMinutes: app.config.healthSyncLightMaxAgeMinutes });

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
    // The page the engine does not own (shadow) and the OnlyFans page are
    // byte-identical to the baseline.
    expect(after.byId.get(pages.unowned)).toEqual(before.byId.get(pages.unowned));
    expect(after.byId.get(pages.onlyfans)).toEqual(before.byId.get(pages.onlyfans));

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

    expect(after.byId.get(pages.stale)).toMatchObject({ status: "degraded", issues: ["engine:owner_stale"] });
    expect(after.byId.get(pages.stale)!.engine!.ownerHeartbeatAgeSeconds).toBeGreaterThan(90);
    expect(after.byId.get(pages.auth)).toMatchObject({
      status: "degraded",
      issues: ["engine:auth_hold"],
      engine: { hold: { kind: "auth", until: "infinity" } },
    });
    expect(after.byId.get(pages.stuck)).toMatchObject({ status: "degraded", issues: ["engine:handover_stuck"] });
    expect(after.byId.get(pages.fresh)).toMatchObject({ status: "ok", issues: [], engine: { mode: "handover" } });
    // stale, auth, stuck; the page nothing reads; the unverified OnlyFans page.
    expect(after.body.overall.unhealthyPageCount).toBe(5);

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
      pageId: pages.live, shadow: false, resource: "dm-messages.head", subject: "g-1", kind: "trigger", class: "urgent",
      dueAt: new Date(Date.now() - 45_000),
    });
    // Due in the future: not counted.
    await upsertDemand(db(), {
      pageId: pages.live, shadow: false, resource: "dm-messages.head", subject: "g-2", kind: "trigger", class: "urgent",
      dueAt: new Date(Date.now() + 600_000),
    });
    // A shadow row is not the live journal's.
    await upsertDemand(db(), {
      pageId: pages.live, shadow: true, resource: "dm-messages.head", subject: "g-3", kind: "trigger", class: "urgent",
      dueAt: new Date(Date.now() - 600_000),
    });
    await upsertDemand(db(), { pageId: pages.live, shadow: false, resource: "transactions.rescan", kind: "poll", class: "planned" });
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
    const snapshot = await getSyncStatusSnapshot(app, { pageIds: [pages.auth, pages.unowned, pages.onlyfans] });
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
    // The page the engine does not own: no block of any engine.
    const unowned = snapshot.pages.find((page) => page.pageId === pages.unowned)!;
    for (const block of Object.values(unowned.blocks)) {
      expect(block).toMatchObject({ state: "not_available", statusReason: { code: "fansly_sync_engine_off" }, substreams: [] });
      expect(block).not.toHaveProperty("engineMode");
    }
    expect(unowned.syncUx).toMatchObject({ state: "off", headline: "Not syncing" });
    // The OnlyFans page: legacy blocks, none of the engine's.
    const onlyfans = snapshot.pages.find((page) => page.pageId === pages.onlyfans)!;
    for (const block of Object.values(onlyfans.blocks)) {
      expect(block.state).not.toBe("engine");
      expect(block).not.toHaveProperty("engineMode");
    }
    expect(onlyfans.blocks.connection.substreams.map((substream) => substream.stream)).toEqual(["light"]);
    expect(onlyfans.blocks.messages_history).toMatchObject({ state: "not_available", statusReason: null });
  });
});
