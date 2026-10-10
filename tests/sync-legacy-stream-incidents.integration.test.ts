import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  getSyncPage,
  openNotificationIncident,
  type Database,
} from "@agency_hub_core/db";
import { createLogger } from "@agency_hub_core/shared";

import {
  INCIDENT_RESOLUTION_REASONS,
  incidentKey,
  notifySyncChunkFailureIncident,
  notifySyncEngineIncident,
  resolveLegacyStreamIncidentsOfEnginePage,
} from "../apps/runtime/src/services/notification-incidents.ts";
import { runNotificationDeliveryOutbox } from "../apps/runtime/src/services/notification-delivery-outbox.ts";
import { runNotificationPagingSweep } from "../apps/runtime/src/services/notification-paging-sweep.ts";
import { SyncEngineHost, type SyncHostOptions } from "../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  quietLogger,
  ScriptedLiveTransport,
  seedSyncPage,
  setModeDirect,
  testConfig,
  testRegistry,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The transition of a Fansly page to the Fansly Sync Engine closes the page's
// legacy stream incidents (`stream_failed_threshold:<page>:<stream>`), which
// only the legacy executor's chunk recovery resolved and which nothing
// resolves once the engine runs the page (production incident 41, lilly-2
// `dm_conversations`, open since the day before its switch): every live
// takeover of the host resolves them through the ordinary resolve, once,
// with reason `engine_owned` in the resolve message.
// The engine's own latches, the page-wide ones the page verify resolves,
// other pages and OnlyFans stay as they are; the legacy executor cannot open
// them again while the engine owns the page.

const MINUTE = 60_000;

let testDb: StartedTestDatabase | null = null;
const hosts: SyncEngineHost[] = [];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function handles() {
  return { db: db(), pool: testDb!.pool };
}

function app() {
  return { db: db(), config: testConfig(testDb!.connectionString), logger: createLogger("silent") };
}

function hostOptions(): SyncHostOptions {
  return {
    db: db(),
    connectionString: testDb!.connectionString,
    config: testConfig(testDb!.connectionString),
    rawConfig: testConfig(testDb!.connectionString),
    logger: quietLogger,
    registry: testRegistry([]),
    pause: { readSettingMs: async () => 50 },
    pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
    routeTimeScale: 0,
    modeLoopIntervalMs: 200,
    liveTransportFactory: async () => new ScriptedLiveTransport(),
    liveSocket: () => null,
  };
}

async function startHost(): Promise<SyncEngineHost> {
  const host = new SyncEngineHost(hostOptions());
  hosts.push(host);
  await host.start();
  return host;
}

/** The legacy executor's own producer: a stream's third failure in a row. */
async function legacyStreamFailure(input: {
  pageId: number;
  label: string;
  platform?: "fansly" | "onlyfans";
  stream: "dm_conversations" | "posts" | "transactions";
  at: Date;
}) {
  await notifySyncChunkFailureIncident(app(), {
    platformAccountId: input.pageId,
    pageLabel: input.label,
    platform: input.platform ?? "fansly",
    stream: input.stream,
    runId: 0,
    hasProxy: false,
    previousConsecutiveFailures: 2,
    errorCode: "http_500",
    errorSummary: "Fansly request failed (500): error getting group messages",
    occurredAt: input.at,
  });
}

interface LatchRow {
  status: string;
  resolved_at: Date | null;
  last_seen_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
}

async function latch(key: string): Promise<LatchRow | null> {
  const result = await testDb!.pool.query<LatchRow>(
    "select status, resolved_at, last_seen_at, updated_at, metadata from notification_incidents where incident_key = $1",
    [key],
  );
  return result.rows[0] ?? null;
}

async function tombstone(key: string): Promise<{ recovered_at: Date; updated_at: Date } | null> {
  const result = await testDb!.pool.query<{ recovered_at: Date; updated_at: Date }>(
    "select recovered_at, updated_at from notification_incident_recoveries where incident_key = $1",
    [key],
  );
  return result.rows[0] ?? null;
}

const streamKey = (pageId: number, stream: "dm_conversations" | "posts" | "transactions") =>
  incidentKey({ kind: "stream_failed_threshold", platformAccountId: pageId, stream });

describe("legacy stream incidents at the transition to the Fansly Sync Engine", () => {
  it("a live takeover closes them once (engine_owned, the resolve message says why); engine latches, page-wide latches, a legacy page and OnlyFans untouched; the legacy executor cannot reopen them", async (context) => {
    if (!testDb) return context.skip();
    const openedAt = new Date(Date.now() - 60 * MINUTE);

    // The page the engine runs: two legacy stream latches the legacy engine
    // opened before the switch, the auth latch the page verify resolves, and
    // an alert of the engine itself.
    const engine = await seedSyncPage(handles(), { label: "lilly-2", guard: "fansly_sync_engine" });
    await legacyStreamFailure({ pageId: engine.pageId, label: engine.label, stream: "dm_conversations", at: openedAt });
    await legacyStreamFailure({ pageId: engine.pageId, label: engine.label, stream: "posts", at: openedAt });
    // The page-wide auth latch a legacy chunk opened before the page was
    // switched (nothing opens one since step 4, S4-19: the legacy executor
    // serves no Fansly page).
    await openNotificationIncident(db(), {
      incidentKey: incidentKey({ kind: "auth_blocked", platformAccountId: engine.pageId }),
      kind: "auth_blocked",
      platformAccountId: engine.pageId,
      errorSummary: "401",
      metadata: { pageLabel: engine.label, platform: "fansly" },
      now: openedAt,
    });
    // Another Fansly page the legacy engine still runs, and an OnlyFans page.
    const legacy = await seedSyncPage(handles(), { label: "lora-9" });
    await legacyStreamFailure({ pageId: legacy.pageId, label: legacy.label, stream: "dm_conversations", at: openedAt });
    const model = await createModel(db(), { slug: "of-model", name: "of" });
    const onlyFans = (await createOnlyFansPage(db(), { modelId: model!.id, label: "of-1" }))!;
    await legacyStreamFailure({ pageId: onlyFans.id, label: "of-1", platform: "onlyfans", stream: "posts", at: openedAt });
    // The sweep pages the stream latches (open for an hour, hold 10 min), and
    // the pages reach the owner — a page that never did would close into the
    // missed-alerts summary instead of its own resolve message (Д2).
    await runNotificationPagingSweep(app(), { now: new Date() });
    await runNotificationDeliveryOutbox(app(), {
      sender: async () => ({ status: "sent" as const, chatId: "1", messageId: 1 }),
    });

    // The page is switched live (the switch's end state: mode, guard, import);
    // the engine raises one of its own alerts.
    await setModeDirect(testDb.pool, engine.pageId, "live");
    await notifySyncEngineIncident(app(), {
      subKey: "page_stopped", pageId: engine.pageId, pageLabel: engine.label, detail: "network",
      errorSummary: "3 network failures in a row", occurredAt: new Date(),
    });
    const engineKey = incidentKey({ kind: "fansly_sync_engine", platformAccountId: engine.pageId, subKey: "page_stopped" });
    const authKey = incidentKey({ kind: "auth_blocked", platformAccountId: engine.pageId });
    for (const key of [streamKey(engine.pageId, "dm_conversations"), streamKey(engine.pageId, "posts"), engineKey, authKey]) {
      expect((await latch(key))?.status).toBe("open");
    }

    // First takeover.
    const first = await startHost();
    await waitFor(() => (first.state(engine.pageId).kind === "running" ? true : null), 15_000, "the first live owner");
    const closedAt = await waitFor(async () => {
      const row = await latch(streamKey(engine.pageId, "posts"));
      return row?.status === "resolved" ? row.resolved_at : null;
    }, 10_000, "the legacy latches closed");
    const closed = new Map<string, LatchRow>();
    for (const stream of ["dm_conversations", "posts"] as const) {
      const key = streamKey(engine.pageId, stream);
      const row = (await latch(key))!;
      expect(row.status).toBe("resolved");
      expect(row.metadata).toMatchObject({ resolution: "engine_owned", stream, platform: "fansly", pageLabel: "lilly-2" });
      expect((await tombstone(key))!.recovered_at.getTime()).toBe(row.resolved_at!.getTime());
      closed.set(key, row);
    }
    expect(closedAt).not.toBeNull();
    // Untouched: the engine's own alert, the page-wide auth latch, the legacy page, OnlyFans.
    expect((await latch(engineKey))?.status).toBe("open");
    expect((await latch(authKey))?.status).toBe("open");
    expect((await latch(streamKey(legacy.pageId, "dm_conversations")))?.status).toBe("open");
    expect((await latch(streamKey(onlyFans.id, "posts")))?.status).toBe("open");
    expect(await tombstone(streamKey(legacy.pageId, "dm_conversations"))).toBeNull();
    expect(await tombstone(streamKey(onlyFans.id, "posts"))).toBeNull();

    // A second takeover (a restart of `sync`) finds nothing open and writes nothing.
    const tombstonesBefore = new Map(await Promise.all([...closed.keys()].map(async (key) => [key, (await tombstone(key))!] as const)));
    await first.stop();
    const second = await startHost();
    await waitFor(() => (second.state(engine.pageId).kind === "running" ? true : null), 15_000, "the second live owner");
    expect((await getSyncPage(db(), engine.pageId))!.owner.generation).toBe(2n);
    expect(await resolveLegacyStreamIncidentsOfEnginePage(app(), { pageId: engine.pageId, pageLabel: engine.label })).toEqual([]);
    for (const [key, before] of closed) {
      const after = (await latch(key))!;
      expect(after.status).toBe("resolved");
      expect(after.resolved_at!.getTime()).toBe(before.resolved_at!.getTime());
      expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
      expect((await tombstone(key))!.updated_at.getTime()).toBe(tombstonesBefore.get(key)!.updated_at.getTime());
    }

    // The legacy executor cannot open them again while the engine owns the
    // page — not the closed ones, not a new stream; the legacy page and
    // OnlyFans still open theirs.
    const later = new Date();
    await legacyStreamFailure({ pageId: engine.pageId, label: engine.label, stream: "dm_conversations", at: later });
    await legacyStreamFailure({ pageId: engine.pageId, label: engine.label, stream: "transactions", at: later });
    expect((await latch(streamKey(engine.pageId, "dm_conversations")))?.status).toBe("resolved");
    expect(await latch(streamKey(engine.pageId, "transactions"))).toBeNull();
    await legacyStreamFailure({ pageId: legacy.pageId, label: legacy.label, stream: "transactions", at: later });
    await legacyStreamFailure({ pageId: onlyFans.id, label: "of-1", platform: "onlyfans", stream: "transactions", at: later });
    expect((await latch(streamKey(legacy.pageId, "transactions")))?.status).toBe("open");
    expect((await latch(streamKey(onlyFans.id, "transactions")))?.status).toBe("open");

    // The owner is told as for any resolve: after the 30 min recovery hold the
    // paged latch's resolve message says it closed, and why.
    await runNotificationPagingSweep(app(), { now: new Date(closedAt!.getTime() + 31 * MINUTE) });
    const outbox = await testDb.pool.query<{ transition: string; message_text: string }>(
      `select o.transition, o.message_text from notification_delivery_outbox o
         join notification_incidents n on n.id = o.notification_incident_id
        where n.incident_key = $1 order by o.id`,
      [streamKey(engine.pageId, "dm_conversations")],
    );
    expect(outbox.rows.map((row) => row.transition)).toEqual(["opened", "resolved"]);
    const resolved = outbox.rows[1]!.message_text;
    expect(resolved).toMatch(/^✅ Resolved\nStream dm_conversations closed: lilly-2 \(fansly\)\n/);
    expect(resolved).toContain(`Reason: ${INCIDENT_RESOLUTION_REASONS.engine_owned}`);
    expect(resolved).not.toContain("recovered");
  }, 90_000);

  it("only a live page's are closed, once: a page in handover keeps them, a second pass changes nothing", async (context) => {
    if (!testDb) return context.skip();
    const openedAt = new Date(Date.now() - 60 * MINUTE);
    const page = await seedSyncPage(handles(), { label: "lilly-3", guard: "fansly_sync_engine" });
    await legacyStreamFailure({ pageId: page.pageId, label: page.label, stream: "dm_conversations", at: openedAt });
    const handover = await seedSyncPage(handles(), { label: "lilly-4", guard: "fansly_sync_engine" });
    await legacyStreamFailure({ pageId: handover.pageId, label: handover.label, stream: "dm_conversations", at: openedAt });

    // A page in handover is not the engine's to run: not closed.
    await setModeDirect(testDb.pool, handover.pageId, "handover");
    expect(await resolveLegacyStreamIncidentsOfEnginePage(app(), { pageId: handover.pageId, pageLabel: handover.label })).toEqual([]);
    expect((await latch(streamKey(handover.pageId, "dm_conversations")))?.status).toBe("open");

    // A live page with no host running yet: the resolver closes its latch.
    await setModeDirect(testDb.pool, page.pageId, "live");
    expect(await resolveLegacyStreamIncidentsOfEnginePage(app(), { pageId: page.pageId, pageLabel: page.label }))
      .toEqual(["dm_conversations"]);
    const row = (await latch(streamKey(page.pageId, "dm_conversations")))!;
    expect(row.status).toBe("resolved");
    expect(row.metadata).toMatchObject({ resolution: "engine_owned" });

    // Run again (every live takeover of the host does): nothing left to close.
    expect(await resolveLegacyStreamIncidentsOfEnginePage(app(), { pageId: page.pageId, pageLabel: page.label })).toEqual([]);
    expect((await latch(streamKey(page.pageId, "dm_conversations")))!.updated_at.getTime()).toBe(row.updated_at.getTime());
  }, 60_000);
});
