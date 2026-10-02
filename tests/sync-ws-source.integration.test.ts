import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { beginFanslyWsConnection, storeFanslySession, upsertDemand, type Database } from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import * as receiverSocket from "../apps/runtime/src/services/egress/fansly-receiver-socket.ts";
import { startFanslyWsWorker, type FanslyWsWorkerTiming } from "../apps/runtime/src/services/fansly-ws/worker.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import type { Metrics, SyncMetricLabels } from "../apps/runtime/src/sync/engine/ports.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  HARNESS_ENCRYPTION_KEY,
  HARNESS_KEY,
  harnessConfig,
  harnessRng,
  harnessRoutes,
  seedHarnessPage,
  until,
  type FakeArrival,
  type HarnessPage,
} from "./helpers/sync-engine.ts";
import { RecordingAlerts } from "./helpers/sync-engine-host.ts";
import { speakFansly, WS_NOOP_FRAME, wsHostOptions } from "./helpers/sync-ws.ts";

// The page's WebSocket in the `sync` process (step-3 design §3.3, J6, I18,
// I1–I3 for the Upgrade): the production host and socket source against a
// fake origin behind the page proxy. Pinned: every connection is one `ws.connect`
// admission and one Upgrade at the origin, paced with the page's REST reads;
// the socket lock (58213) is the source's for as long as it runs — the legacy
// receiver on the same database cannot connect — and a lost lock session ends
// the connection without a drain, after which the source takes the lock again
// and reconnects; the auth frame's refusal blocks the credentials generation
// (account.verify, alert 2, the list head while down), with no reconnect until
// the credentials change; the first connection after the legacy one starts its
// gap at the legacy close and raises the repair; a `ws.connect` or
// `account.verify` demand the database refused is written again (plan §9), so
// the socket comes back after a database blip.

const S = 300;

let testDb: StartedTestDatabase | null = null;
let server: FakeFanslyServer | null = null;
let proxy: CountingConnectProxy | null = null;
const hosts: SyncEngineHost[] = [];

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
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await server?.close();
  await proxy?.close();
  server = null;
  proxy = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

class LabeledMetrics implements Metrics {
  readonly events: Array<{ name: string; labels: SyncMetricLabels }> = [];
  increment(name: string, labels: SyncMetricLabels = {}): void {
    this.events.push({ name, labels });
  }
  count(name: string, labels: SyncMetricLabels = {}): number {
    return this.events.filter((event) => event.name === name
      && Object.entries(labels).every(([key, value]) => event.labels[key] === value)).length;
  }
}

interface Rig {
  server: FakeFanslyServer;
  proxy: CountingConnectProxy;
  page: HarnessPage;
  config: ReturnType<typeof harnessConfig>;
}

async function rig(): Promise<Rig> {
  server = await FakeFanslyServer.start();
  proxy = await CountingConnectProxy.start();
  for (const route of harnessRoutes(new FakeChats())) server.route(route);
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: proxy.url });
  return { server, proxy, page, config: harnessConfig(testDb!.connectionString, server.apiBaseUrl) };
}

async function startHost(r: Rig, options: { seed: number; metrics?: Metrics; alerts?: RecordingAlerts }): Promise<SyncEngineHost> {
  let host: SyncEngineHost | null = null;
  const created = new SyncEngineHost({
    ...wsHostOptions({
      db: db(),
      pool: testDb!.pool,
      connectionString: testDb!.connectionString,
      config: r.config,
      rng: harnessRng(options.seed),
      wsOrigin: r.server.origin,
      sourceOf: () => host?.wsSource(r.page.pageId) ?? null,
    }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    ...(options.alerts === undefined ? {} : { alerts: options.alerts }),
  });
  host = created;
  hosts.push(created);
  await created.start();
  return created;
}

interface ConnectionRow {
  id: string;
  generation: string;
  started_at: Date;
  verified_at: Date | null;
  closed_at: Date | null;
  stop_reason: string | null;
  gap_since: Date | null;
}

async function connections(pageId: number): Promise<ConnectionRow[]> {
  const result = await testDb!.pool.query<ConnectionRow>(
    `select id::text, generation, started_at, verified_at, closed_at, stop_reason, gap_since
       from fansly_ws_connections where page_id = $1 order by started_at, id`,
    [pageId],
  );
  return result.rows;
}

/** The session holding the page's socket lock (58213), or null. */
async function lockHolder(pageId: number): Promise<number | null> {
  const result = await testDb!.pool.query<{ pid: number }>(
    `select pid from pg_locks
      where locktype = 'advisory' and classid = 58213 and objid = $1 and objsubid = 2 and granted
        and database = (select oid from pg_database where datname = current_database())`,
    [pageId],
  );
  return result.rows[0]?.pid ?? null;
}

async function scalar(text: string, values: unknown[] = []): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>(text, values);
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * A database blip under the source's demand writes: the live writes of
 * `resource` whose attempt number (1-based) is in `refused` fail. A sequence
 * counts the attempts — the refused transaction does not roll it back.
 */
async function refuseDemandWrites(resource: string, refused: readonly number[]): Promise<{
  attempts(): Promise<number>;
  restore(): Promise<void>;
}> {
  const pool = testDb!.pool;
  await pool.query(`create sequence test_demand_attempts;
    create function test_refuse_demand() returns trigger language plpgsql as $$
    begin
      if new.resource = '${resource}' and not new.shadow then
        if nextval('test_demand_attempts') = any('{${refused.join(",")}}'::bigint[]) then
          raise exception 'injected demand write failure';
        end if;
      end if;
      return new;
    end $$;
    create trigger test_refuse_demand before insert on sync_work
      for each row execute function test_refuse_demand()`);
  return {
    attempts: () => scalar("select (case when is_called then last_value else 0 end)::int as n from test_demand_attempts"),
    async restore() {
      await pool.query(`drop trigger test_refuse_demand on sync_work; drop function test_refuse_demand();
        drop sequence test_demand_attempts`);
    },
  };
}

function upgrades(r: Rig): FakeArrival[] {
  return r.server.arrivals.filter((arrival) => arrival.upgrade);
}

function gaps(arrivals: readonly FakeArrival[]): number[] {
  return arrivals.slice(1).map((arrival, index) => arrival.mono - arrivals[index]!.mono);
}

describe("the page's socket in the sync process", () => {
  it("one ws.connect admission is one Upgrade at the origin, paced with the page's REST reads; the stop drains and frees the lock", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    // Every socket delivers one frame, then the origin closes it: the source
    // asks for the next connection (one frame makes the connection stable,
    // so the ladder restarts at its first step).
    r.server.onWebSocket = (peer) => speakFansly(peer, {
      onSession: (session) => {
        session.send(WS_NOOP_FRAME);
        setTimeout(() => session.close(), 500);
      },
    });
    for (let n = 1; n <= 8; n += 1) {
      await upsertDemand(db(), { pageId, shadow: false, resource: HARNESS_KEY.urgent, subject: `u${n}`, kind: "trigger", class: "urgent" });
    }
    const host = await startHost(r, { seed: 7 });
    await until(async () => upgrades(r).length >= 4 && (await scalar(
      "select count(*)::int as n from sync_work where page_id = $1 and resource = $2 and state <> 'done'",
      [pageId, HARNESS_KEY.urgent],
    )) === 0, 60_000, "four connections and every REST read");
    await until(async () => (await connections(pageId)).filter((row) => row.verified_at !== null).length >= 4,
      30_000, "four verified connections");
    await host.stop();

    const arrivals = r.server.arrivals;
    expect(gaps(arrivals).filter((gap) => gap < S)).toEqual([]);
    const sent = await testDb.pool.query<{ resource: string; http_status: number | null; send_mark: string; setting_ms: number; gap_prev_ms: number | null; pause_ms: number }>(
      `select resource, http_status, send_mark, setting_ms, gap_prev_ms, pause_ms
         from sync_attempts where page_id = $1 and not shadow and sent_at is not null order by sent_at, id`,
      [pageId],
    );
    // One arrival per sent attempt; every Upgrade is a ws.connect attempt that
    // passed the pacer's check at `onRequestStart`.
    expect(arrivals).toHaveLength(sent.rows.length);
    const connects = sent.rows.filter((row) => row.resource === "ws.connect");
    expect(connects).toHaveLength(upgrades(r).length);
    expect(connects.map((row) => row.http_status)).toEqual(connects.map(() => 101));
    expect(sent.rows.filter((row) => row.send_mark !== "request_start")).toEqual([]);
    for (const row of sent.rows) {
      expect(row.pause_ms).toBeGreaterThanOrEqual(row.setting_ms);
      if (row.gap_prev_ms !== null) expect(row.gap_prev_ms).toBeGreaterThanOrEqual(row.pause_ms);
    }
    expect(r.server.arrivalsAt("/api/v1/trackinglinks")).toHaveLength(8);
    // One connection row per Upgrade, each closed; the stop drained the last.
    const rows = await connections(pageId);
    expect(rows).toHaveLength(upgrades(r).length);
    expect(rows.every((row) => row.closed_at !== null)).toBe(true);
    expect(rows.at(-1)!.stop_reason).toBe("disabled");
    for (const [index, row] of rows.entries()) {
      if (index > 0) expect(row.gap_since).toEqual(rows[index - 1]!.closed_at);
    }
    // Every frame was captured, acked and routed in `sync`.
    expect(await scalar("select count(*)::int as n from fansly_ws_decode_receipts where page_id = $1", [pageId]))
      .toBeGreaterThanOrEqual(rows.filter((row) => row.verified_at !== null).length - 1);
    expect(await scalar("select count(*)::int as n from fansly_ws_decode_receipts where page_id = $1 and live_state = 'pending'", [pageId]))
      .toBe(0);
    expect(await lockHolder(pageId)).toBeNull();
  }, 120_000);

  it("a lost socket lock session ends the connection without a drain; the source takes the lock again and reconnects", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    r.server.onWebSocket = (peer) => speakFansly(peer);
    const metrics = new LabeledMetrics();
    await startHost(r, { seed: 11, metrics });
    await until(async () => (await connections(pageId))[0]?.verified_at != null, 30_000, "the first connection verified");
    const holder = await lockHolder(pageId);
    expect(holder).not.toBeNull();

    await testDb.pool.query("select pg_terminate_backend($1)", [holder]);
    await until(async () => {
      const rows = await connections(pageId);
      return rows.length === 2 && rows[1]!.verified_at !== null;
    }, 30_000, "a second connection verified");

    const [first, second] = await connections(pageId);
    // The dead session could not close its row: the next owner did, at its
    // last proof of liveness, and the new connection's gap starts there.
    expect(first!.stop_reason).toBe("abandoned");
    expect(second!.gap_since).toEqual(first!.closed_at);
    expect(second!.closed_at).toBeNull();
    const now = await lockHolder(pageId);
    expect(now).not.toBeNull();
    expect(now).not.toBe(holder);
    // The receiver stopped as `ownership_lost` (no drain), then the lock was taken again.
    expect(metrics.count("sync_ws_connections_ended", { pageId, reason: "ownership_lost" })).toBe(1);
    expect(metrics.count("sync_ws_ownership_lost", { pageId })).toBe(1);
    expect(upgrades(r)).toHaveLength(2);
    expect(await scalar(
      "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'ws.connect' and sent_at is not null", [pageId],
    )).toBe(2);
  }, 90_000);

  it("the legacy receiver on the same database cannot take the page's socket while sync owns it (58213)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId, pageLabel } = r.page;
    r.server.onWebSocket = (peer) => speakFansly(peer);
    await startHost(r, { seed: 13 });
    await until(async () => (await connections(pageId))[0]?.verified_at != null, 30_000, "the engine's connection verified");
    const holder = await lockHolder(pageId);

    const app = createTestAppContext(testDb, { databaseUrl: testDb.connectionString, encryptionKey: HARNESS_ENCRYPTION_KEY });
    app.config.fanslyWsCaptureEnabled = true;
    app.config.fanslyWsCapturePageAllowlist = pageLabel;
    const open = vi.spyOn(receiverSocket, "openFanslyReceiverSocket");
    const timing: FanslyWsWorkerTiming = {
      configPollMs: 300, configStaleMs: 2_000, pagePauseMs: 300, backoffBaseMs: 150,
      authTimeoutMs: 1_000, checkMs: 500, guardStaleMs: 1_500, pingMs: 2_000, pongTimeoutMs: 3_000,
      drainMs: 2_000, applyDrainMs: 1_500,
    };
    const worker = startFanslyWsWorker(app, { timing });
    try {
      // Several of the legacy page loop's lock attempts.
      await sleep(2_500);
    } finally {
      await worker.stop();
    }
    expect(open).not.toHaveBeenCalled();
    expect(await scalar("select count(*)::int as n from fansly_send_log where page_id = $1 and source = 'ws_connect'", [pageId])).toBe(0);
    const rows = await connections(pageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closed_at).toBeNull();
    expect(await lockHolder(pageId)).toBe(holder);
  }, 60_000);

  it("an auth refusal blocks the credentials generation: account.verify, alert 2, the list head while down, no reconnect until the credentials change", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    let refuse = true;
    r.server.onWebSocket = (peer) => speakFansly(peer, { refuseAuth: refuse });
    const alerts = new RecordingAlerts();
    const host = await startHost(r, { seed: 17, alerts });
    await until(async () => (await connections(pageId))[0]?.stop_reason === "auth_refused", 30_000, "the refusal");
    await until(async () => host.wsSource(pageId)?.state === "blocked_generation", 10_000, "the source blocked");
    // The verify demand and the alert follow the block (their own writes).
    await until(async () => (await scalar(
      "select count(*)::int as n from sync_work where page_id = $1 and not shadow and resource = 'account.verify'", [pageId],
    )) === 1 && alerts.opened.length > 0, 10_000, "the verify demand and the alert");
    const verify = await testDb.pool.query<{ reasons: string[]; state: string }>(
      "select demand->'reasons' as reasons, state from sync_work where page_id = $1 and not shadow and resource = 'account.verify'",
      [pageId],
    );
    expect(verify.rows).toEqual([{ reasons: ["ws_auth_refused"], state: "open" }]);
    expect(alerts.opened.filter((alert) => alert.subKey === "live_degraded"))
      .toEqual([expect.objectContaining({ pageId, detail: "ws_auth_refused", shadow: false })]);
    // Down past the (scaled) two minutes: the list head polls in its place, raised once.
    await until(async () => (await scalar(
      "select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-conversations.ws-down'", [pageId],
    )) === 1, 10_000, "the ws-down work");
    await sleep(1_500);
    expect(upgrades(r)).toHaveLength(1);
    expect(await scalar(
      "select demand_revision::int as n from sync_work where page_id = $1 and resource = 'dm-conversations.ws-down'", [pageId],
    )).toBe(1);

    // New credentials: a new generation, a new connection.
    refuse = false;
    const session = { authorization: "token-2", fanslyClientId: "client-id", fanslyClientCheck: "client-check", fanslySessionId: "session-2" };
    await storeFanslySession(db(), pageId, JSON.stringify(encryptJson(session, HARNESS_ENCRYPTION_KEY, 1)), 1);
    await until(async () => (await connections(pageId))[1]?.verified_at != null && host.wsSource(pageId)?.downSince === null,
      30_000, "the new generation's connection up");
    const rows = await connections(pageId);
    expect(rows[1]!.generation).not.toBe(rows[0]!.generation);
    expect(upgrades(r)).toHaveLength(2);
    expect(host.wsSource(pageId)?.state).toBe("open");
    expect(host.wsSource(pageId)?.downSince).toBeNull();
  }, 90_000);

  it("a ws.connect demand the database refused is written again while the source holds the lock: the socket comes back at start and after an end", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    // The first socket ends once verified; the second stays.
    let sockets = 0;
    r.server.onWebSocket = (peer) => {
      sockets += 1;
      const ends = sockets === 1;
      speakFansly(peer, {
        onSession: (session) => {
          if (ends) setTimeout(() => session.close(), 500);
        },
      });
    };
    // Writes 1–2 (the start's) and 4 (the reconnect's) are refused.
    const refused = await refuseDemandWrites("ws.connect", [1, 2, 4]);
    try {
      const host = await startHost(r, { seed: 23 });
      await until(async () => (await connections(pageId)).filter((row) => row.verified_at !== null).length === 2
        && host.wsSource(pageId)?.state === "open", 30_000, "the second connection verified");
      // Written once landed: no write after the third and the fifth.
      expect(await refused.attempts()).toBe(5);
    } finally {
      await refused.restore();
    }
    const rows = await connections(pageId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.closed_at).not.toBeNull();
    expect(rows[1]!.closed_at).toBeNull();
    // Each written demand was one admission and one Upgrade.
    expect(upgrades(r)).toHaveLength(2);
    expect(await scalar(
      "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'ws.connect' and sent_at is not null", [pageId],
    )).toBe(2);
    const work = await testDb.pool.query<{ reasons: string[]; state: string }>(
      "select demand->'reasons' as reasons, state from sync_work where page_id = $1 and resource = 'ws.connect' order by id", [pageId],
    );
    expect(work.rows).toEqual([{ reasons: ["ws_start"], state: "done" }, { reasons: ["ws_reconnect"], state: "done" }]);
  }, 60_000);

  it("an account.verify the database refused is written again while the credentials generation stays refused", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    r.server.onWebSocket = (peer) => speakFansly(peer, { refuseAuth: true });
    const refused = await refuseDemandWrites("account.verify", [1]);
    try {
      const host = await startHost(r, { seed: 29 });
      await until(async () => host.wsSource(pageId)?.state === "blocked_generation", 30_000, "the source blocked");
      await until(async () => (await scalar(
        "select count(*)::int as n from sync_work where page_id = $1 and not shadow and resource = 'account.verify'", [pageId],
      )) === 1, 10_000, "the verify demand written on a retry");
      await sleep(1_500);
      expect(await refused.attempts()).toBe(2);
    } finally {
      await refused.restore();
    }
    expect(upgrades(r)).toHaveLength(1);
  }, 60_000);

  it("the first connection after the legacy one: its gap starts at the legacy close, and a verified socket raises the repair", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    // The legacy receiver's last connection, closed five minutes ago.
    const legacyId = randomUUID();
    await beginFanslyWsConnection(db(), { id: legacyId, pageId, generation: "f".repeat(64) });
    await testDb.pool.query(
      `update fansly_ws_connections
          set started_at = clock_timestamp() - interval '2 hours', verified_at = clock_timestamp() - interval '2 hours',
              last_guard_at = clock_timestamp() - interval '6 minutes', closed_at = clock_timestamp() - interval '5 minutes',
              stop_reason = 'disabled'
        where id = $1::uuid`,
      [legacyId],
    );
    r.server.onWebSocket = (peer) => speakFansly(peer);
    await startHost(r, { seed: 19 });
    await until(async () => (await connections(pageId))[1]?.verified_at != null, 30_000, "the engine's connection verified");
    await until(async () => (await scalar(
      "select count(*)::int as n from sync_work where page_id = $1 and not shadow and resource = 'repair.ws-gap'", [pageId],
    )) === 1, 10_000, "the repair demand");

    const [legacy, engine] = await connections(pageId);
    expect(legacy!.id).toBe(legacyId);
    expect(engine!.gap_since).toEqual(legacy!.closed_at);
    const repair = await testDb.pool.query<{ reasons: string[]; params: unknown }>(
      "select demand->'reasons' as reasons, params from sync_work where page_id = $1 and resource = 'repair.ws-gap'", [pageId],
    );
    // Demand only (G17): the repair derives its window from the unreconciled
    // connections the engine opened — the legacy close minus 60 s.
    expect(repair.rows).toEqual([{ reasons: ["ws_gap"], params: {} }]);
    const window = await testDb.pool.query<{ since: Date }>(
      `select min(c.gap_since) - interval '60 seconds' as since from fansly_ws_connections c
        where c.page_id = $1 and c.verified_at is not null and c.state_reconciled_at is null and c.id <> $2::uuid`,
      [pageId, legacyId],
    );
    expect(window.rows[0]!.since.getTime()).toBe(legacy!.closed_at!.getTime() - 60_000);
  }, 60_000);
});
