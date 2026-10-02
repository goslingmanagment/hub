import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  confirmSyncOwnersStopped,
  getSyncPage,
  listCombinedFanslySendsForPaceAudit,
  type Database,
} from "@agency_hub_core/db";

import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { getHistoryRequest, submitHistoryRequest } from "../apps/runtime/src/sync/requests/history.ts";
import { runSyncRollback } from "../apps/runtime/src/sync/switch/rollback.ts";
import { runSyncSwitch } from "../apps/runtime/src/sync/switch/switch.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  harnessConfig,
  harnessHostOptions,
  harnessRng,
  harnessRoutes,
  seedChatThread,
  until,
  type HarnessPage,
} from "./helpers/sync-engine.ts";
import {
  acceptedShadowReport,
  LEGACY_PATH,
  legacyRoute,
  LegacySender,
  seedSwitchPage,
  switchContext,
  switchRegistry,
  testCapability,
} from "./helpers/sync-switch.ts";

// `pnpm cli sync rollback` (design step 3 §3.5 item 7, S2 §11.2, J2/J4/J5):
// a live page goes back to the legacy engine, which continues from its own
// marks. Pinned at the origin and in both journals: the first legacy request
// ≥ 1.2 × S after the engine's last one, and — under an engine 429 hold — not
// before the hold's end + 1.2 × S; without the owner's release or a stop
// confirmation nothing moves (exit 3); an auth hold refuses (exit 5) unless
// the owner says so; a rollback killed after any step and run again ends in
// the same place; the legacy rows are byte-identical to before the switch;
// open history requests wait `paused`.

const S = 300;

let testDb: StartedTestDatabase | null = null;
let server: FakeFanslyServer | null = null;
let proxy: CountingConnectProxy | null = null;
const hosts: SyncEngineHost[] = [];
const senders: LegacySender[] = [];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (!testDb) return;
  await resetIntegrationDatabase(testDb.pool);
  await ensureHarnessSettingTable(testDb.pool, S);
});

afterEach(async () => {
  await Promise.all(senders.splice(0).map((sender) => sender.stop()));
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await server?.close();
  await proxy?.close();
  server = null;
  proxy = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function handles() {
  return { db: db(), pool: testDb!.pool };
}

interface Rig {
  server: FakeFanslyServer;
  chats: FakeChats;
  page: HarnessPage;
  config: ReturnType<typeof harnessConfig>;
  lines: string[];
  recoveries: string[];
  host: SyncEngineHost;
}

async function startHost(config: ReturnType<typeof harnessConfig>, seed: number): Promise<SyncEngineHost> {
  const host = new SyncEngineHost(harnessHostOptions({
    db: db(),
    pool: testDb!.pool,
    connectionString: testDb!.connectionString,
    config,
    rng: harnessRng(seed),
    registry: switchRegistry(),
  }));
  hosts.push(host);
  await host.start();
  return host;
}

function ctx(r: Pick<Rig, "config" | "lines" | "recoveries">, overrides: Parameters<typeof switchContext>[1] = {}) {
  return switchContext({ db: db(), config: r.config, lines: r.lines, recoveries: r.recoveries }, overrides);
}

/** A page switched live by the switch itself, its engine sending. */
async function livePage(label: string, seed: number, beforeSwitch?: (page: HarnessPage) => Promise<void>): Promise<Rig> {
  server = await FakeFanslyServer.start();
  proxy = await CountingConnectProxy.start();
  const chats = new FakeChats();
  server.route(legacyRoute());
  for (const route of harnessRoutes(chats)) server.route(route);
  const page = await seedSwitchPage(handles(), { label, proxyUrl: proxy.url });
  await beforeSwitch?.(page);
  const config = harnessConfig(testDb!.connectionString, server.apiBaseUrl);
  const host = await startHost(config, seed);
  await until(async () => host.state(page.pageId).kind === "running", 15_000, "the shadow owner");
  const r: Rig = { server, chats, page, config, lines: [], recoveries: [], host };
  const outcome = await runSyncSwitch(switchContext({ db: db(), config, report: acceptedShadowReport([label]), lines: r.lines }), {
    pageLabel: label, shadowReportPath: "/tmp/r.json", dryRun: false, registry: switchRegistry(), capabilityFor: testCapability("switch"),
  });
  expect(outcome.exitCode).toBe(0);
  await until(async () => server!.arrivalsAt("/api/v1/polls").length >= 2, 20_000, "engine reads");
  return r;
}

function rollback(r: Pick<Rig, "config" | "lines" | "recoveries" | "page">, options: { withAuthHold?: boolean; overrides?: Parameters<typeof switchContext>[1] } = {}) {
  return runSyncRollback(ctx(r, options.overrides ?? {}), {
    pageLabel: r.page.pageLabel,
    withAuthHold: options.withAuthHold === true,
    capabilityFor: testCapability("rollback"),
  });
}

async function steps(pageId: number): Promise<string[]> {
  const result = await testDb!.pool.query<{ step: string }>(
    "select metadata ->> 'step' as step from audit_events where event_type = 'admin.sync_rollback' and platform_account_id = $1 order by id",
    [pageId],
  );
  return result.rows.map((row) => row.step);
}

async function guardOf(pageId: number) {
  return (await testDb!.pool.query<{ owner_engine: string; last_completed_at: Date; next_u: number; engine_switched_at: Date }>(
    "select owner_engine, last_completed_at, next_u::float8 as next_u, engine_switched_at from fansly_page_send_guards where page_id = $1",
    [pageId],
  )).rows[0]!;
}

/** The legacy engine's own rows of the page (J5: never written by step 3). */
async function legacySnapshot(pageId: number): Promise<string> {
  const tables = ["page_sync_cursors", "page_sync_states", "page_sync_provider_holds"];
  const parts: unknown[] = [];
  for (const table of tables) {
    parts.push((await testDb!.pool.query(`select * from ${table} where page_id = $1 order by 1, 2`, [pageId])).rows);
  }
  return JSON.stringify(parts, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

describe("sync rollback", () => {
  it("gives a live page back gracefully: the first legacy request ≥ 1.2 × S after the engine's last, legacy rows untouched, history requests paused", async (context) => {
    if (!testDb) return context.skip();
    let before = "";
    const r = await livePage("rollback-a", 21, async (page) => {
      await testDb!.pool.query(
        `insert into page_sync_cursors (page_id, stream, cursor_text, cursor_timestamp, state)
         values ($1, 'followers', '42', now() - interval '1 day', '{"walk": 1}'::jsonb),
                ($1, 'transactions', null, now() - interval '2 hours', '{}'::jsonb)`,
        [page.pageId],
      );
      before = await legacySnapshot(page.pageId);
    });
    const { page } = r;
    const chat = r.chats.add({ count: 60, ageMs: 7_200_000 });
    const threadGroup = chat.groupId;
    await seedChatThread(handles(), page.pageId, chat, { stored: chat.messages.slice(40) });
    // Requests open: a history request whose work rides the requests class.
    await testDb.pool.query("update sync_pages set requests_enabled_at = clock_timestamp() - interval '1 second' where page_id = $1", [page.pageId]);
    const filed = await submitHistoryRequest({ db: db(), rawConfig: r.config }, {
      pageId: page.pageId, requester: { kind: "owner_cli", userId: null },
      fans: [{ kind: "conversation", conversationRef: threadGroup }], depth: { kind: "all" },
      reason: "before the rollback", idempotencyKey: randomUUID(),
    });
    const lastEngineBefore = Math.max(...r.server.arrivals.map((arrival) => arrival.mono));
    const rolledAt = new Date();

    const outcome = await rollback(r);
    expect(outcome).toEqual({ exitCode: 0, step: "done", page: page.pageLabel });
    expect(await steps(page.pageId)).toEqual(["start", "1_handover", "2_released", "3_guard_handed", "4_work_closed", "5_off", "done"]);
    expect(r.recoveries).toEqual([page.pageLabel]);
    const row = (await getSyncPage(db(), page.pageId))!;
    expect(row).toMatchObject({ mode: "off", legacyImportedAt: null, requestsEnabledAt: null, pausedRequests: true, pauseNote: "rolled_back" });
    const guard = await guardOf(page.pageId);
    expect(guard.owner_engine).toBe("legacy");
    expect(guard.next_u).toBeCloseTo(0.2);

    // Live work cancelled, the history work kept; the request waits `paused`.
    const work = await testDb.pool.query<{ resource: string; state: string; close_reason: string | null }>(
      "select resource, state, close_reason from sync_work where page_id = $1 and not shadow and closed_at is null", [page.pageId],
    );
    expect(work.rows.map((entry) => entry.resource)).toEqual(["dm-messages.history"]);
    expect((await testDb.pool.query(
      "select count(*)::int as n from sync_work where page_id = $1 and not shadow and close_reason = 'rolled_back'", [page.pageId],
    )).rows[0].n).toBeGreaterThan(0);
    const view = await getHistoryRequest({ db: db(), rawConfig: r.config }, filed.request.ref);
    expect(view.request.waitingReason).toBe("paused");

    // The legacy engine continues: ≥ 1.2 × S after the engine's last request.
    await until(async () => r.host.state(page.pageId).kind === "idle", 10_000, "the host lets the page go");
    const lastEngine = Math.max(lastEngineBefore, ...r.server.arrivals.filter((arrival) => !arrival.path.startsWith(LEGACY_PATH)).map((arrival) => arrival.mono));
    const legacy = new LegacySender({ db: db(), config: r.config }, page.pageId, `${r.server.origin}${LEGACY_PATH}`, () => S).start();
    senders.push(legacy);
    await until(async () => legacy.sent >= 2, 15_000, "legacy sends");
    const firstLegacy = r.server.arrivalsAt(LEGACY_PATH)[0]!;
    expect(firstLegacy.mono - lastEngine).toBeGreaterThanOrEqual(1.2 * S);
    const combined = await listCombinedFanslySendsForPaceAudit(db(), { pageId: page.pageId, since: new Date(rolledAt.getTime() - 60_000) });
    expect(combined.filter((send) => send.violation)).toEqual([]);
    // J5: the legacy engine's own rows are what they were before the switch.
    expect(await legacySnapshot(page.pageId)).toBe(before);
  }, 180_000);

  it("waits for the dead owner's stop confirmation (exit 3), then proceeds", async (context) => {
    if (!testDb) return context.skip();
    const r = await livePage("rollback-b", 22);
    const { page } = r;
    // The process dies: its lock session ends and no release is ever written.
    await r.host.stop();
    hosts.splice(hosts.indexOf(r.host), 1);
    await testDb.pool.query(
      `update sync_pages set owner_released_at = null, owner_release_generation = null, owner_host = 'dead-sync-container',
              mode = 'handover', mode_changed_at = clock_timestamp(), mode_changed_by = 'test'
        where page_id = $1`,
      [page.pageId],
    );
    const waited = await rollback(r, { overrides: { timing: { ...ctx(r).timing, releaseTimeoutMs: 500 } } });
    expect(waited).toMatchObject({ exitCode: 3, step: "waiting_stop" });
    expect((await guardOf(page.pageId)).owner_engine).toBe("fansly_sync_engine");
    expect((await getSyncPage(db(), page.pageId))!.mode).toBe("handover");
    expect(r.lines.some((line) => line.includes("sync ownership confirm-stopped"))).toBe(true);

    const confirmed = await confirmSyncOwnersStopped(db(), {
      runningHosts: ["another-sync-container"], ownHost: hostname(), confirmedBy: "test", dryRun: false, pageIds: [page.pageId],
    });
    expect(confirmed.map((entry) => entry.pageId)).toEqual([page.pageId]);
    expect(await rollback(r)).toMatchObject({ exitCode: 0, step: "done" });
    expect((await guardOf(page.pageId)).owner_engine).toBe("legacy");
    expect(await steps(page.pageId)).toEqual(["start", "waiting_stop", "2_released", "3_guard_handed", "4_work_closed", "5_off", "done"]);
  }, 120_000);

  it("carries an engine 429 hold into the legacy guard: the first legacy capture ≥ the hold's end + 1.2 × S", async (context) => {
    if (!testDb) return context.skip();
    const r = await livePage("rollback-c", 23);
    const { page } = r;
    const held = await testDb.pool.query<{ until: Date }>(
      `update sync_pages set hold_kind = 'rate_limit', hold_until = clock_timestamp() + interval '3 seconds',
              hold_since = clock_timestamp(), hold_step = 1, hold_detail = '{"status": 429}'::jsonb
        where page_id = $1 returning hold_until as until`,
      [page.pageId],
    );
    const holdUntil = held.rows[0]!.until;
    expect(await rollback(r)).toMatchObject({ exitCode: 0, step: "done" });
    expect((await guardOf(page.pageId)).last_completed_at.getTime()).toBeGreaterThanOrEqual(holdUntil.getTime());

    const legacy = new LegacySender({ db: db(), config: r.config }, page.pageId, `${r.server.origin}${LEGACY_PATH}`, () => S).start();
    senders.push(legacy);
    await until(async () => legacy.sent >= 1, 20_000, "the first legacy send after the hold");
    const first = await testDb.pool.query<{ captured_at: Date }>(
      "select captured_at from fansly_send_log where page_id = $1 order by captured_at limit 1", [page.pageId],
    );
    expect(first.rows[0]!.captured_at.getTime() - holdUntil.getTime()).toBeGreaterThanOrEqual(1.2 * S);
  }, 120_000);

  it("refuses under an auth hold (exit 5, nothing sent) and proceeds with --with-auth-hold", async (context) => {
    if (!testDb) return context.skip();
    const r = await livePage("rollback-d", 24);
    const { page } = r;
    await testDb.pool.query(
      `update sync_pages set hold_kind = 'auth', hold_until = 'infinity', hold_since = clock_timestamp(),
              hold_detail = jsonb_build_object('status', 401, 'credentialsGeneration', credentials_generation)
        where page_id = $1`,
      [page.pageId],
    );
    const refused = await rollback(r);
    expect(refused).toMatchObject({ exitCode: 5, step: "auth_hold" });
    expect((await guardOf(page.pageId)).owner_engine).toBe("fansly_sync_engine");
    expect((await getSyncPage(db(), page.pageId))!.mode).toBe("handover");
    const arrivals = r.server.arrivals.length;
    expect(await rollback(r, { withAuthHold: true })).toMatchObject({ exitCode: 0, step: "done" });
    expect((await guardOf(page.pageId)).owner_engine).toBe("legacy");
    expect(r.server.arrivals.length).toBe(arrivals);
  }, 120_000);

  it("a rollback killed after each step and run again ends in the same place", async (context) => {
    if (!testDb) return context.skip();
    const r = await livePage("rollback-e", 25);
    const { page } = r;
    for (const killAt of ["1 ", "2 ", "3 ", "4 "]) {
      let killed = false;
      await rollback(r, {
        overrides: {
          print: (line) => {
            r.lines.push(line);
            if (!killed && line.startsWith(killAt)) {
              killed = true;
              throw new Error(`killed after ${killAt.trim()}`);
            }
          },
        },
      }).catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.startsWith("killed")) throw error;
      });
      expect(killed).toBe(true);
    }
    // Killed after the mode change, before the legacy request: the rerun finishes it.
    await expect(rollback(r, {
      overrides: { requestLegacyRecovery: async () => { throw new Error("killed before the legacy request"); } },
    })).rejects.toThrow("killed before the legacy request");
    expect((await getSyncPage(db(), page.pageId))!.mode).toBe("off");
    expect(r.recoveries).toEqual([]);
    expect(await rollback(r)).toMatchObject({ exitCode: 0, step: "done" });
    expect(r.recoveries).toEqual([page.pageLabel]);
    expect((await getSyncPage(db(), page.pageId))!.mode).toBe("off");
    expect((await guardOf(page.pageId)).owner_engine).toBe("legacy");
    // A finished rollback has nothing left to do.
    expect(await rollback(r)).toMatchObject({ exitCode: 0, step: "nothing" });
  }, 120_000);
});
