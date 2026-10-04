import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { storeFanslySession, upsertDemand, type Database } from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import type { LivePageSocket } from "../apps/runtime/src/sync/engine/ports.ts";
import type { EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { RecordingAlerts } from "./helpers/sync-engine-host.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  HARNESS_ENCRYPTION_KEY,
  HarnessSocket,
  harnessConfig,
  harnessHostOptions,
  harnessIdentityRegistry,
  harnessRng,
  harnessRoutes,
  HARNESS_KEY,
  seedHarnessPage,
  stampVerifiedCredentials,
  until,
  type FakeArrival,
  type HarnessPage,
} from "./helpers/sync-engine.ts";

// `ws.connect` (design S3-04 item 4, §5.2): the page's WebSocket Upgrade as an
// admitted request of a live page, through the production host, page
// transport and resource; the page's socket owner (S3-03's `FanslyWsSource`)
// is the harness socket — a real Upgrade of the fake origin through the page
// proxy with the admission's check. Pinned: one Upgrade per admission, counted
// at the origin and never closer than S to any other request of the page; an
// open socket or no socket owner sends nothing; a 401/403 at the handshake
// holds the page `auth`, a 429 holds it `rate_limit` with alert 1 (never the
// reconnect ladder); any other failed handshake goes back to the socket's
// ladder without a page network streak, so the page's REST work goes on.
// (The ladder's due times themselves are the socket owner's, S3-03.)

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

async function startHost(r: Rig, options: {
  seed: number;
  alerts?: RecordingAlerts;
  socket?: () => LivePageSocket | null;
  registry?: EngineRegistry;
}) {
  const host = new SyncEngineHost(harnessHostOptions({
    db: db(),
    pool: testDb!.pool,
    connectionString: testDb!.connectionString,
    config: r.config,
    rng: harnessRng(options.seed),
    ...(options.alerts === undefined ? {} : { alerts: options.alerts }),
    ...(options.socket === undefined ? {} : { liveSocket: options.socket }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  }));
  hosts.push(host);
  await host.start();
  return host;
}

async function demand(pageId: number, resource: string, subject: string) {
  await upsertDemand(db(), { pageId, shadow: false, resource, subject, kind: "trigger", class: "urgent", demand: { reasons: ["test"] } });
}

async function rows<T>(text: string, values: unknown[]): Promise<T[]> {
  return (await testDb!.pool.query(text, values)).rows as T[];
}

async function scalar(text: string, values: unknown[] = []): Promise<number> {
  return Number((await rows<{ n: number }>(text, values))[0]?.n ?? 0);
}

const wsWork = (pageId: number) => rows<{ subject: string; state: string; close_reason: string | null; waiting_reason: string | null }>(
  "select subject, state, close_reason, waiting_reason from sync_work where page_id = $1 and resource = 'ws.connect' order by subject",
  [pageId],
);

function gaps(arrivals: readonly FakeArrival[]): number[] {
  return arrivals.slice(1).map((arrival, index) => arrival.mono - arrivals[index]!.mono);
}

describe("ws.connect on a live page", () => {
  it("sends one Upgrade per admission, counted at the origin and ≥ S from every other request of the page; the 101 closes the work", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    for (const subject of ["a", "b", "c"]) await demand(pageId, HARNESS_KEY.ws, subject);
    for (let n = 1; n <= 4; n += 1) await demand(pageId, HARNESS_KEY.urgent, `u${n}`);
    await startHost(r, { seed: 81 });
    await until(async () => (await wsWork(pageId)).every((work) => work.state === "done")
      && r.server.arrivalsAt("/api/v1/trackinglinks").length === 4, 60_000, "every Upgrade and REST read");

    const upgrades = r.server.arrivals.filter((arrival) => arrival.upgrade);
    expect(upgrades.map((arrival) => [arrival.path, arrival.status])).toEqual([["/ws", 101], ["/ws", 101], ["/ws", 101]]);
    expect(gaps(r.server.arrivals).filter((gap) => gap < S)).toEqual([]);
    expect((await wsWork(pageId)).map((work) => work.close_reason)).toEqual(["socket_opened", "socket_opened", "socket_opened"]);
    const attempts = await rows<{ request: unknown; http_status: number; apply_state: string; observation_id: string | null; send_mark: string }>(
      "select request, http_status, apply_state, observation_id, send_mark from sync_attempts where page_id = $1 and resource = 'ws.connect' order by id",
      [pageId],
    );
    // The Upgrade names the verified digest of the stored credentials it was
    // admitted under (not a secret).
    const verified = (await rows<{ generation: string }>(
      "select credentials_generation as generation from sync_pages where page_id = $1", [pageId],
    ))[0]!.generation;
    expect(attempts).toEqual(Array.from({ length: 3 }, () => ({
      request: { spec: "ws.upgrade", host: "ws", params: {}, credentialsGeneration: verified },
      http_status: 101,
      apply_state: "applied",
      observation_id: null,
      send_mark: "request_start",
    })));
  }, 90_000);

  it("sends nothing for an open socket (satisfied) or without a socket owner in the process (waits)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    const open = new HarnessSocket({ db: db(), config: r.config }, pageId);
    open.state = "open";
    await demand(pageId, HARNESS_KEY.ws, "");
    await startHost(r, { seed: 82, socket: () => open });
    await until(async () => (await wsWork(pageId))[0]?.state === "done", 30_000, "the satisfied Upgrade work");
    expect((await wsWork(pageId))[0]?.close_reason).toBe("socket_open");
    await Promise.all(hosts.splice(0).map((host) => host.stop()));

    await demand(pageId, HARNESS_KEY.ws, "");
    await startHost(r, { seed: 83, socket: () => null });
    await until(async () => (await wsWork(pageId)).some((work) => work.state === "open" && work.waiting_reason === "dependency"), 30_000, "the waiting Upgrade work");
    expect(r.server.arrivals.filter((arrival) => arrival.upgrade)).toEqual([]);
  }, 90_000);

  it("an Upgrade goes out only with the verified credentials: changed stored ones raise the verify, and the Upgrade follows it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    const verified = (await rows<{ generation: string }>(
      "select credentials_generation as generation from sync_pages where page_id = $1", [pageId],
    ))[0]!.generation;
    // The stored session changed out of band since the engine verified it.
    const rotated = { authorization: "rotated-token", fanslyClientId: "client-id", fanslyClientCheck: "client-check", fanslySessionId: "session-id" };
    await storeFanslySession(db(), pageId, JSON.stringify(encryptJson(rotated, HARNESS_ENCRYPTION_KEY, 1)), 1);
    await demand(pageId, HARNESS_KEY.ws, "");
    await startHost(r, { seed: 87, registry: harnessIdentityRegistry() });
    await until(async () => (await wsWork(pageId))[0]?.state === "done", 30_000, "the Upgrade after the verify");

    // The verify of the rotated session first, the Upgrade only after it.
    expect(r.server.arrivals.map((arrival) => [arrival.path.split("?")[0], arrival.upgrade])).toEqual([
      ["/api/v1/account/me", false],
      ["/ws", true],
    ]);
    const verify = await rows<{ reasons: string[] }>(
      "select demand -> 'reasons' as reasons from sync_work where page_id = $1 and resource = 'account.verify'", [pageId],
    );
    expect(verify[0]!.reasons).toContain("credentials_changed");
    // The verify proved the rotated session: its digest is the trusted one now.
    const now = (await rows<{ generation: string }>(
      "select credentials_generation as generation from sync_pages where page_id = $1", [pageId],
    ))[0]!.generation;
    expect(now).not.toBe(verified);
    expect(now).toBe(await stampVerifiedCredentials({ db: db(), pool: testDb.pool }, r.page));
    // The Upgrade's attempt names the digest it was admitted under.
    const upgrade = await rows<{ generation: string }>(
      "select request ->> 'credentialsGeneration' as generation from sync_attempts where page_id = $1 and resource = 'ws.connect'", [pageId],
    );
    expect(upgrade).toEqual([{ generation: now }]);
  }, 60_000);

  it("a 401 at the handshake holds the page auth: nothing else goes out", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    const alerts = new RecordingAlerts();
    r.server.upgradeStatus = () => 401;
    await demand(pageId, HARNESS_KEY.ws, "");
    await startHost(r, { seed: 84, alerts });
    await until(async () => (await scalar("select count(*)::int as n from sync_pages where page_id = $1 and hold_kind = 'auth'", [pageId])) === 1,
      30_000, "the auth hold");
    expect(await wsWork(pageId)).toEqual([{ subject: "", state: "open", close_reason: null, waiting_reason: "page_hold" }]);
    expect(alerts.opened.map((alert) => [alert.subKey, alert.detail])).toContainEqual(["page_stopped", "auth"]);
    const sent = r.server.arrivals.length;
    await demand(pageId, HARNESS_KEY.urgent, "held");
    await new Promise((resolve) => setTimeout(resolve, 4 * S));
    expect(r.server.arrivals).toHaveLength(sent);
  }, 60_000);

  it("a 429 at the handshake holds the Upgrade's route with its incident — the work waits for the route, not the reconnect ladder; REST goes on", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    const alerts = new RecordingAlerts();
    r.server.upgradeStatus = () => 429;
    await demand(pageId, HARNESS_KEY.ws, "");
    await startHost(r, { seed: 85, alerts });
    await until(async () => (await scalar(
      "select count(*)::int as n from sync_pages where page_id = $1 and resource_holds #> '{route:state,routes,ws.upgrade,holdUntil}' is not null",
      [pageId])) === 1, 30_000, "the Upgrade route's hold");
    expect(await scalar("select count(*)::int as n from sync_pages where page_id = $1 and hold_kind is not null", [pageId])).toBe(0);
    expect(await wsWork(pageId)).toEqual([{ subject: "", state: "open", close_reason: null, waiting_reason: null }]);
    expect(alerts.opened.filter((alert) => alert.subKey === "route_limited").map((alert) => [alert.route, alert.detail]))
      .toEqual([["ws.upgrade", "rate_limit"]]);
    expect(alerts.opened.filter((alert) => alert.subKey === "page_stopped")).toEqual([]);
    // The page's REST reads go on while the Upgrade waits.
    await demand(pageId, HARNESS_KEY.urgent, "beside");
    await until(async () => r.server.arrivals.some((arrival) => !arrival.upgrade), 20_000, "a REST read beside the held Upgrade");
    expect(r.server.arrivals.filter((arrival) => arrival.upgrade).map((arrival) => arrival.status)).toEqual([429]);
  }, 60_000);

  it("a failed handshake (another status, a dropped connection) goes back to the socket's ladder: no page network hold, REST goes on", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    const answers = [400, 0, 0];
    r.server.upgradeStatus = () => answers.shift() ?? 101;
    for (const subject of ["a", "b", "c"]) await demand(pageId, HARNESS_KEY.ws, subject);
    await startHost(r, { seed: 86 });
    await until(async () => (await wsWork(pageId)).every((work) => work.state === "done"), 60_000, "three failed handshakes");
    expect((await wsWork(pageId)).map((work) => work.close_reason)).toEqual(["failed_handshake", "failed_handshake", "failed_handshake"]);
    const attempts = await rows<{ outcome: string; http_status: number | null; error_class: string | null }>(
      "select outcome, http_status, error_class from sync_attempts where page_id = $1 and resource = 'ws.connect' order by id", [pageId]);
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(["response", "transport_error", "transport_error"]);
    expect(attempts[0]).toMatchObject({ http_status: 400, error_class: "subject_failure" });
    expect(await rows("select hold_kind, network_failure_streak from sync_pages where page_id = $1", [pageId]))
      .toEqual([{ hold_kind: null, network_failure_streak: 0 }]);
    for (let n = 1; n <= 3; n += 1) await demand(pageId, HARNESS_KEY.urgent, `after-${n}`);
    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 3, 30_000, "the REST reads after the failures");
  }, 90_000);
});
