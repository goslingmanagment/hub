import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@agency_hub_core/db";

import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { explainSyncWork, findSyncPageByLabel } from "../apps/runtime/src/sync/inspect.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  harnessConfig,
  harnessRng,
  harnessRoutes,
  seedHarnessPage,
  until,
  type FakeArrival,
  type HarnessPage,
} from "./helpers/sync-engine.ts";
import { productionWsHostOptions, speakFansly } from "./helpers/sync-ws.ts";

// The answer of a refused WebSocket Upgrade reaches the classifier whole
// (step 3b ruling 10): the production `ws.connect` resource, page transport,
// socket source and receiver lease binding against a fake origin behind the
// page proxy — only the socket's URL is the origin's. Pinned: a 429's
// `Retry-After` (delta-seconds or an HTTP-date) is journaled on the attempt
// and holds the Upgrade for the whole stated time, never the default ladder
// and never the socket's reconnect ladder; a 503 naming its `Retry-After` is
// the provider's pause, not a failed handshake; a 503 without one stays a
// failed handshake on the socket's ladder; nothing of the answer but its safe
// headers (a cookie) is kept anywhere.

const S = 300;
/** A value only the refused Upgrade's `set-cookie` carries. */
const COOKIE_SECRET = "upgrade-cookie-secret-5c1e";

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
  page: HarnessPage;
  config: ReturnType<typeof harnessConfig>;
}

async function rig(): Promise<Rig> {
  server = await FakeFanslyServer.start();
  proxy = await CountingConnectProxy.start();
  for (const route of harnessRoutes(new FakeChats())) server.route(route);
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: proxy.url });
  return { server, page, config: harnessConfig(testDb!.connectionString, server.apiBaseUrl) };
}

async function startHost(r: Rig, seed: number): Promise<SyncEngineHost> {
  const host = new SyncEngineHost(productionWsHostOptions({
    db: db(),
    pool: testDb!.pool,
    connectionString: testDb!.connectionString,
    config: r.config,
    rng: harnessRng(seed),
    wsOrigin: r.server.origin,
  }));
  hosts.push(host);
  await host.start();
  return host;
}

interface UpgradeAttempt {
  outcome: string;
  http_status: number | null;
  retry_after_ms: number | null;
  error_class: string | null;
  send_mark: string | null;
  sent_at: Date;
}

async function upgradeAttempts(pageId: number): Promise<UpgradeAttempt[]> {
  const result = await testDb!.pool.query<UpgradeAttempt>(
    `select outcome, http_status, retry_after_ms, error_class, send_mark, sent_at
       from sync_attempts where page_id = $1 and resource = 'ws.connect' and outcome is not null order by id`,
    [pageId],
  );
  return result.rows;
}

async function wsWork(pageId: number) {
  const result = await testDb!.pool.query<{ state: string; close_reason: string | null }>(
    "select state, close_reason from sync_work where page_id = $1 and resource = 'ws.connect' order by id",
    [pageId],
  );
  return result.rows;
}

function upgrades(r: Rig): FakeArrival[] {
  return r.server.arrivals.filter((arrival) => arrival.upgrade);
}

/** The first refused Upgrade, captured and its work open again. */
async function firstRefusal(r: Rig): Promise<UpgradeAttempt> {
  await until(async () => (await upgradeAttempts(r.page.pageId)).length === 1
    && (await wsWork(r.page.pageId)).some((work) => work.state === "open"), 30_000, "the refused Upgrade captured");
  return (await upgradeAttempts(r.page.pageId))[0]!;
}

/** How long after `sentAt` `sync why` says the page's Upgrade goes again. */
async function upgradeWaitMs(r: Rig, sentAt: Date): Promise<number> {
  const page = await findSyncPageByLabel(db(), r.page.pageLabel);
  const whys = await explainSyncWork(db(), r.config, page, { resource: "ws.connect" });
  const until = whys.find((why) => why.work.state === "open")?.waiting?.until ?? null;
  expect(until, "the open Upgrade waits until a known instant").not.toBeNull();
  return until!.getTime() - sentAt.getTime();
}

/** Rows of `table` whose text carries `needle`. */
async function rowsCarrying(table: string, needle: string): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>(
    `select count(*)::int as n from ${table} t where row_to_json(t)::text like '%' || $1 || '%'`,
    [needle],
  );
  return Number(result.rows[0]?.n ?? 0);
}

describe("a refused Upgrade's answer on the production socket path", () => {
  it("a 429 with Retry-After: 600 is journaled and holds the Upgrade the whole 600 s — not the default, not the socket's ladder; its cookie is kept nowhere", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.server.upgradeStatus = () => 429;
    r.server.upgradeHeaders = () => ({ "retry-after": "600", "set-cookie": `f-s-c=${COOKIE_SECRET}; Path=/` });
    await startHost(r, 91);

    const attempt = await firstRefusal(r);
    expect(attempt).toMatchObject({
      outcome: "response",
      http_status: 429,
      retry_after_ms: 600_000,
      error_class: "rate_limit",
      send_mark: "request_start",
    });
    // The stated 600 s, measured from the send (the capture comes a moment
    // later); the default 429 ladder would say 120 s.
    const waitMs = await upgradeWaitMs(r, attempt.sent_at);
    expect(waitMs).toBeGreaterThanOrEqual(600_000);
    expect(waitMs).toBeLessThan(630_000);
    // The socket's reconnect ladder (≈ 200 ms on this timing) asks again at
    // once; the Upgrade still waits.
    await sleep(2_000);
    expect(upgrades(r).map((arrival) => arrival.status)).toEqual([429]);
    for (const table of ["sync_attempts", "sync_work", "sync_pages", "fansly_ws_connections", "observations"]) {
      expect(await rowsCarrying(table, COOKIE_SECRET), table).toBe(0);
    }
  }, 60_000);

  it("a 429 whose Retry-After is an HTTP-date holds the Upgrade until that instant", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.server.upgradeStatus = () => 429;
    r.server.upgradeHeaders = () => ({ "retry-after": new Date(Date.now() + 900_000).toUTCString() });
    await startHost(r, 92);

    const attempt = await firstRefusal(r);
    expect(attempt).toMatchObject({ http_status: 429, error_class: "rate_limit" });
    // An HTTP-date is whole seconds: up to 1 s short of 900 s, less the trip.
    expect(attempt.retry_after_ms).toBeGreaterThan(880_000);
    expect(attempt.retry_after_ms).toBeLessThanOrEqual(900_000);
    const waitMs = await upgradeWaitMs(r, attempt.sent_at);
    expect(waitMs).toBeGreaterThan(880_000);
    expect(waitMs).toBeLessThan(930_000);
    expect(upgrades(r)).toHaveLength(1);
  }, 60_000);

  it("a 503 naming its Retry-After is the provider's pause for that time, not a failed handshake", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.server.upgradeStatus = () => 503;
    r.server.upgradeHeaders = () => ({ "retry-after": "120" });
    await startHost(r, 93);

    const attempt = await firstRefusal(r);
    expect(attempt).toMatchObject({ outcome: "response", http_status: 503, retry_after_ms: 120_000, error_class: "rate_limit" });
    expect(await wsWork(r.page.pageId)).toEqual([{ state: "open", close_reason: null }]);
    const waitMs = await upgradeWaitMs(r, attempt.sent_at);
    expect(waitMs).toBeGreaterThanOrEqual(120_000);
    expect(waitMs).toBeLessThan(150_000);
    await sleep(2_000);
    expect(upgrades(r).map((arrival) => arrival.status)).toEqual([503]);
  }, 60_000);

  it("a 503 without Retry-After failed the handshake only: the socket's ladder connects again at once", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const answers = [503];
    r.server.upgradeStatus = () => answers.shift() ?? 101;
    r.server.onWebSocket = (peer) => speakFansly(peer);
    await startHost(r, 94);

    await until(async () => (await upgradeAttempts(r.page.pageId)).length === 2
      && (await wsWork(r.page.pageId)).every((work) => work.state === "done"), 30_000, "the failed handshake and the next Upgrade");
    expect((await upgradeAttempts(r.page.pageId)).map((attempt) => [attempt.http_status, attempt.retry_after_ms, attempt.error_class]))
      .toEqual([[503, null, "subject_failure"], [101, null, null]]);
    expect((await wsWork(r.page.pageId)).map((work) => work.close_reason)).toEqual(["failed_handshake", "socket_opened"]);
    expect(upgrades(r).map((arrival) => arrival.status)).toEqual([503, 101]);
  }, 60_000);
});
