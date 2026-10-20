import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { storeFanslySession, upsertDemand, type Database } from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
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
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await server?.close();
  await proxy?.close();
  server = null;
  proxy = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
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

async function startHost(r: Rig, options: { seed: number; alerts?: RecordingAlerts }): Promise<SyncEngineHost> {
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
      await upsertDemand(db(), { pageId, resource: HARNESS_KEY.urgent, subject: `u${n}`, kind: "trigger", class: "urgent" });
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

  it("an Upgrade opens only with the stored credentials its admission checked: changed ones send nothing", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    r.server.onWebSocket = (peer) => speakFansly(peer);
    // `ws.connect` is paused: the source holds the lock and waits for an admission.
    await testDb.pool.query("update sync_pages set paused_resources = array['ws.connect'] where page_id = $1", [pageId]);
    const host = await startHost(r, { seed: 12 });
    await until(async () => host.wsSource(pageId)?.state === "owning", 15_000, "the socket owner");
    const source = host.wsSource(pageId)!;
    const checks = { calls: 0 };
    const hooks = {
      check: () => {
        checks.calls += 1;
        return null;
      },
      grant: () => {
        throw new Error("the Upgrade is written in this process: its check, never a grant");
      },
    };

    // The stored credentials are not the ones the admission's check passed
    // (they changed in between): no connection row, no Upgrade, no check.
    const refused = await source.handshake(hooks, new AbortController().signal, { credentialsGeneration: "0".repeat(64) });
    expect(refused).toEqual({ kind: "aborted_before_send", refusal: "lease_inactive" });
    expect(checks.calls).toBe(0);
    expect(upgrades(r)).toEqual([]);
    expect(await connections(pageId)).toEqual([]);
    expect(source.state).toBe("owning");

    // The digest the admission checked opens it.
    const verified = (await testDb.pool.query<{ generation: string }>(
      "select credentials_generation as generation from sync_pages where page_id = $1", [pageId],
    )).rows[0]!.generation;
    const opened = await source.handshake(hooks, new AbortController().signal, { credentialsGeneration: verified });
    expect(opened).toMatchObject({ kind: "response", status: 101 });
    expect(checks.calls).toBe(1);
    expect(upgrades(r)).toHaveLength(1);
    expect((await connections(pageId)).map((row) => row.generation)).toEqual([verified]);
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
      .toEqual([expect.objectContaining({ pageId, detail: "ws_auth_refused" })]);
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
});
