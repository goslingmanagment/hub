import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  confirmSyncOwnersStopped,
  findPageBrowserByPage,
  getSyncPageTransport,
  readSyncLivePathFacts,
  insertPageBrowser,
  LiveGateClosedError,
  lockOwnedPage,
  setPageBrowserSettings,
  setSyncPageTransport,
  settleAttemptWithoutCapture,
  storeFanslySession,
  type Database,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { updatePageCredentials } from "../apps/runtime/src/services/connections.ts";
import { readFanslyPageGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import {
  checkFanslyIdentityThroughEngine,
  FanslyCredentialsChangedError,
  saveVerifiedFanslyCredentials,
} from "../apps/runtime/src/services/sync-engine-account.ts";
import { buildSyncEngineCommandGroup } from "../apps/runtime/src/sync/cli.ts";
import { SyncCrashFault } from "../apps/runtime/src/sync/engine/commit.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import type { StallSubject, StallTracking } from "../apps/runtime/src/sync/engine/watchdog.ts";
import { openBrowserPage, type BrowserPage } from "../apps/runtime/src/sync/fansly/browser-page.ts";
import { readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { SyncOwnerLeverError } from "../apps/runtime/src/sync/inspect.ts";
import { changeSyncPageTransport, SYNC_PAGE_TRANSPORT_AUDIT_EVENT } from "../apps/runtime/src/sync/page-transport.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOperator, linkSettings, OPERATOR_TOKEN, SESSION_A } from "./helpers/page-browser-operator.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { makeTestActor, quietLogger, RecordingMetrics } from "./helpers/sync-engine-host.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  HARNESS_ENCRYPTION_KEY,
  HARNESS_OWN_REF,
  harnessConfig,
  harnessHostOptions,
  harnessIdentityRegistry,
  harnessRng,
  harnessRoutes,
  seedHarnessPage,
  until,
  type FakeRoute,
  type HarnessPage,
} from "./helpers/sync-engine.ts";

// The transport switch of a page (Project Browser plan §3.2 «Выбор транспорта
// страницы», «Переключение транспорта страницы и откат», §4.7, owner
// decision №12; stage 3 PR 14, row 14's checks) on a real host: the page's
// Node transport over a fake Fansly origin behind a CONNECT proxy, its
// browser a fake operator (the operator's own RPC server).
// - Both ways with a request in flight: the request finishes and is
//   committed by the owner that admitted it; no admission of the transport
//   the page left commits after the switch, and nothing is sent through it
//   once its slot ended; the new transport's first send is ≥ 1.2 × S after
//   the last send of the old one (S at least the owner's 2 s minimum).
// - A page that leaves its browser has its operator stop it; a page on Node
//   never links to its browser.
// - The rollback of a page connected through its browser, its Chrome down
//   and no Node session stored: prepare (a credentials hold that admits only
//   a candidate check), the identity check through Node by the session the
//   owner sends, its storing and trusting in one transaction (a CAS: a base
//   moved in between stores nothing), then the verify lifts the hold and the
//   page works on Node.

const S = 300;
/** The takeover floor's setting: S, at least the owner's minimum (I4). */
const FLOOR_S = 2_000;
const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
const RPC_TIMING = { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 };

let testDb: StartedTestDatabase | null = null;
const cleanups: Array<() => Promise<void> | void> = [];

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
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function session(token: string) {
  return { authorization: token, fanslyClientId: "client-id", fanslyClientCheck: "client-check", fanslySessionId: "session-id" };
}

interface Rig {
  server: FakeFanslyServer;
  proxy: CountingConnectProxy;
  operator: FakeOperator;
  page: HarnessPage;
  profileId: string;
  config: ReturnType<typeof harnessConfig>;
  /** The authorization of every `/account/me` at the origin, in order. */
  identityTokens: string[];
}

async function rig(options: { first?: FakeRoute[]; session?: string | null } = {}): Promise<Rig> {
  const server = await FakeFanslyServer.start();
  const proxy = await CountingConnectProxy.start();
  const operator = await FakeOperator.start({ accountId: HARNESS_OWN_REF, ...(options.session === undefined ? {} : { session: options.session }) });
  cleanups.push(async () => {
    await server.close();
    await proxy.close();
    await operator.close();
  });
  // Its state every 100 ms, as the real operator every 5 s.
  operator.startStatePushes(100);
  const identityTokens: string[] = [];
  server.route((request) => {
    if (request.url.pathname === "/api/v1/account/me") identityTokens.push(String(request.headers.authorization ?? ""));
    return null;
  });
  for (const route of options.first ?? []) server.route(route);
  for (const route of harnessRoutes(new FakeChats())) server.route(route);
  const label = `switch-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: proxy.url, label });
  const config = harnessConfig(testDb!.connectionString, server.apiBaseUrl);
  const profileId = randomUUID();
  await insertPageBrowser(db(), {
    profileId,
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config, { engineToken: OPERATOR_TOKEN, apiToken: "api-token", vncPassword: "vnc-password" }),
  });
  await setPageBrowserSettings(db(), { profileId, pinnedExitIp: "203.0.113.7", env: ENV });
  return { server, proxy, operator, page, profileId, config, identityTokens };
}

async function startHost(r: Rig, extra: { watchdog?: StallTracking } = {}): Promise<SyncEngineHost> {
  const host = new SyncEngineHost({
    ...harnessHostOptions({
      db: db(),
      pool: testDb!.pool,
      connectionString: testDb!.connectionString,
      config: r.config,
      rng: harnessRng(11),
      registry: harnessIdentityRegistry(),
    }),
    ...(extra.watchdog === undefined ? {} : { watchdog: extra.watchdog }),
    browserOverrides: {
      url: () => r.operator.url,
      // The harness proxy is a CONNECT one: the hello's SOCKS5 is the fake's.
      settings: async (pageId) => linkSettings({ pageId, expectedAccountId: HARNESS_OWN_REF }),
      rpcTiming: RPC_TIMING,
      transportTiming: { unavailableRetryMs: 100, resultWaitMs: 10_000 },
      leaveWaitMs: 5_000,
    },
  });
  cleanups.push(() => host.stop());
  await host.start();
  return host;
}

interface AttemptRow {
  id: number;
  generation: string;
  resource: string | null;
  origin: string;
  outcome: string;
  sendMark: string | null;
  admittedAt: Date;
  sentAt: Date | null;
}

async function attempts(pageId: number): Promise<AttemptRow[]> {
  return (await testDb!.pool.query<AttemptRow>(
    `select a.id::int, a.owner_generation::text as generation, w.resource, a.origin, a.outcome, a.send_mark as "sendMark",
            a.admitted_at as "admittedAt", a.sent_at as "sentAt"
       from sync_attempts a left join sync_work w on w.id = a.work_id
      where a.page_id = $1 order by a.id`,
    [pageId],
  )).rows;
}

async function audits(pageId: number): Promise<Array<Record<string, unknown>>> {
  return (await testDb!.pool.query<{ metadata: Record<string, unknown> }>(
    "select metadata from audit_events where platform_account_id = $1 and event_type = $2 order by id",
    [pageId, SYNC_PAGE_TRANSPORT_AUDIT_EVENT],
  )).rows.map((row) => row.metadata);
}

/** The page's credentials hold (`auth`/`identity_mismatch`), or null. */
async function credentialsHold(pageId: number): Promise<{ kind: string; detail: Record<string, unknown> } | null> {
  const row = (await testDb!.pool.query<{ kind: string; detail: Record<string, unknown> }>(
    "select kind, detail from sync_holds where page_id = $1 and scope = 'page' and kind <> 'network'", [pageId],
  )).rows[0];
  return row ?? null;
}

async function trusted(pageId: number): Promise<string | null> {
  return (await testDb!.pool.query<{ g: string | null }>("select credentials_generation as g from sync_pages where page_id = $1", [pageId])).rows[0]!.g;
}

async function nodeGeneration(page: HarnessPage): Promise<string> {
  return db().transaction(async (raw) => readFanslyPageGeneration(raw as unknown as Database, page.pageLabel), { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** The page's last confirmed leave of its browser and a pending one. */
async function leftBy(pageId: number): Promise<{ by: string | null; generation: string | null; pending: string | null }> {
  return (await testDb!.pool.query<{ by: string | null; generation: string | null; pending: string | null }>(
    `select browser_left_by as by, browser_left_generation::text as generation, browser_leave_generation::text as pending
       from sync_pages where page_id = $1`, [pageId],
  )).rows[0]!;
}

function sendsOf(rows: AttemptRow[], generation: bigint): AttemptRow[] {
  return rows.filter((row) => row.generation === generation.toString() && row.sentAt !== null);
}

/** The send marks of the sends whose answer was captured: a request still in
 *  flight has its instant (written at its start, best effort) and no mark
 *  yet. */
function marksOf(sends: AttemptRow[]): Array<string | null> {
  return [...new Set(sends.filter((row) => row.outcome !== "sent").map((row) => row.sendMark))];
}

describe("the switch, both ways, with a request in flight", () => {
  it("node → browser: the request in flight finishes on Node; nothing more goes through Node; the browser's first send is ≥ 1.2 × S later", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const host = await startHost(r);
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 2, 15_000, "the page running on Node");
    const nodeOwner = host.state(r.page.pageId);
    expect(nodeOwner.kind).toBe("running");
    const g1 = nodeOwner.kind === "running" ? nodeOwner.generation : 0n;
    // A Node page never links to its browser.
    expect(r.operator.links).toEqual([]);

    // A slow origin: the next request is in flight for 1.5 s.
    r.server.answerDelayMs = 1_500;
    const arrived = r.server.arrivals.length;
    await until(async () => r.server.arrivals.length > arrived, 10_000, "a request in flight");
    const inFlight = r.server.arrivals.at(-1)!;
    expect(inFlight.status).toBeNull();
    const changed = await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "browser", prepare: false, actor: "test" });
    const switchedWall = Date.now();
    expect(changed).toMatchObject({ from: "node", to: "browser", changed: true, prepared: null });
    const nodeAdmissionsAtSwitch = (await attempts(r.page.pageId)).filter((row) => row.generation === g1.toString()).length;

    // The browser: its identity check first (the trusted digest is Node's),
    // then the polls.
    const g2 = g1 + 1n;
    await until(async () => sendsOf(await attempts(r.page.pageId), g2).length >= 3, 30_000, "the page running on its browser");
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "running", generation: g2 });

    const physical = [...r.operator.physical];
    const rows = await attempts(r.page.pageId);
    // No admission of Node after the switch; the one in flight was answered and committed.
    expect(rows.filter((row) => row.generation === g1.toString())).toHaveLength(nodeAdmissionsAtSwitch);
    const lastNode = sendsOf(rows, g1).at(-1)!;
    expect(lastNode.outcome).toBe("response");
    expect(inFlight.status).toBe(200);
    // Nothing reached the origin through Node after the switch.
    expect(r.server.arrivals.filter((arrival) => arrival.wallMs > switchedWall)).toEqual([]);
    expect(r.server.arrivals.at(-1)!.seq).toBe(inFlight.seq);
    // The browser's sends are the new owner's, and the pause between the two
    // senders is the takeover floor's.
    const browserSends = sendsOf(rows, g2);
    expect(browserSends.length).toBeGreaterThanOrEqual(3);
    expect(marksOf(browserSends)).toEqual(["transport_reported"]);
    const browserAdmissions = new Set(rows.filter((row) => row.generation === g2.toString()).map((row) => row.id));
    expect(physical.every((request) => browserAdmissions.has(request.attemptId))).toBe(true);
    expect(physical.map((request) => request.attemptId)).toEqual(expect.arrayContaining(browserSends.map((row) => row.id)));
    expect(browserSends[0]!.resource).toBe("account.verify");
    expect(browserSends[0]!.sentAt!.getTime() - lastNode.sentAt!.getTime()).toBeGreaterThanOrEqual(1.2 * FLOOR_S);
    expect(r.operator.physical[0]!.generation).toBe(Number(g2));
    // The hand-over: the operator's quiesced for the new owner, recorded.
    await until(async () => (await findPageBrowserByPage(db(), r.page.pageId))!.handoverGeneration === g2, 5_000, "the hand-over");
    // A page coming to its browser does not stop it.
    expect(r.operator.commands).toEqual([]);
    expect(await audits(r.page.pageId)).toEqual([expect.objectContaining({ from: "node", to: "browser", changed: true, prepare: false })]);
  }, 90_000);

  it("browser → node: the request in flight finishes in the browser; the operator stops the page; Node's first send is ≥ 1.2 × S later", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    // The page runs on its browser, whose session the engine trusts.
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    const browserTrusted = await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A);
    await testDb.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1", [r.page.pageId, browserTrusted]);
    const host = await startHost(r);
    await until(async () => r.operator.physical.length >= 2, 20_000, "the page running on its browser");
    const g1 = (host.state(r.page.pageId) as { generation: bigint }).generation;
    expect(r.server.arrivals).toEqual([]);

    // The browser holds the next request 1.5 s after its grant: in flight.
    r.operator.sendDelayMs = 1_500;
    const sent = r.operator.physical.length;
    const granted = r.operator.checkResults.filter((result) => result.admit).length;
    await until(async () => r.operator.checkResults.filter((result) => result.admit).length > granted, 10_000, "a request granted");
    expect(r.operator.physical.length).toBe(sent);
    const inFlight = r.operator.checkResults.filter((result) => result.admit).at(-1)!.attemptId;
    await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" });
    const grantsAtSwitch = r.operator.checkResults.filter((result) => result.admit).length;
    const browserAdmissionsAtSwitch = (await attempts(r.page.pageId)).filter((row) => row.generation === g1.toString()).length;

    // The leave first (its own generation: the operator stops the page, what
    // it kept is taken), then Node: the verify of the stored session (the
    // trusted digest is the browser's), then the polls.
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 30_000, "the page running on Node");
    const leaveGeneration = g1 + 1n;
    const g2 = g1 + 2n;
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "running", generation: g2 });
    expect(await leftBy(r.page.pageId)).toEqual({ by: "operator", generation: leaveGeneration.toString(), pending: null });

    const rows = await attempts(r.page.pageId);
    // No admission and no grant of the browser after the switch; the one in
    // flight went and was committed with the instant the browser reported.
    expect(rows.filter((row) => row.generation === g1.toString())).toHaveLength(browserAdmissionsAtSwitch);
    expect(r.operator.checkResults.filter((result) => result.admit)).toHaveLength(grantsAtSwitch);
    const inFlightRow = rows.find((row) => row.id === inFlight)!;
    expect(inFlightRow).toMatchObject({ generation: g1.toString(), outcome: "response", sendMark: "transport_reported" });
    expect(r.operator.physical.map((request) => request.attemptId)).toContain(inFlight);
    // The operator was told to stop the page, by the leave, after the
    // request in flight.
    expect(r.operator.commands.map((command) => command.command.kind)).toEqual(["stopPage"]);
    expect(r.operator.commands[0]!.ownerGeneration).toBe(Number(leaveGeneration));
    expect(r.operator.state).toMatchObject({ stopReason: "owner_stop", exitOpen: false });
    const lastBrowser = sendsOf(rows, g1).at(-1)!;
    expect(lastBrowser.id).toBe(inFlight);
    const nodeSends = sendsOf(rows, g2);
    expect(nodeSends[0]!.resource).toBe("account.verify");
    expect(marksOf(nodeSends)).toEqual(["request_start"]);
    expect(nodeSends[0]!.sentAt!.getTime() - lastBrowser.sentAt!.getTime()).toBeGreaterThanOrEqual(1.2 * FLOOR_S);
    expect(await trusted(r.page.pageId)).toBe(await nodeGeneration(r.page));
  }, 90_000);

  it("an admission of the sender the page left commits nothing: the admission's lock checks the page's transport", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const lock = (transport?: "node" | "browser") => db().transaction(async (raw) => lockOwnedPage(raw as unknown as Database, {
      pageId: r.page.pageId, generation: 0n, lock: "no_key_update", live: true, ...(transport === undefined ? {} : { transport }),
    }));
    await expect(lock("node")).resolves.toMatchObject({ mode: "live" });
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    const refused = await lock("node").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LiveGateClosedError);
    expect((refused as LiveGateClosedError).reason).toBe("transport");
    await expect(lock("browser")).resolves.toMatchObject({ mode: "live" });
    // Without a transport (no slot's sender named): as before.
    await expect(lock()).resolves.toMatchObject({ mode: "live" });
  }, 30_000);
});

describe("a page on its browser, which is not ready", () => {
  it("is not taken: no owner generation is spent on it, nothing is linked or sent; ready again, it runs", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    await testDb.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
      [r.page.pageId, await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A)]);
    // The pin is gone: the hello has no settings to carry.
    await setPageBrowserSettings(db(), { profileId: r.profileId, pinnedExitIp: null });
    const owner = async () => (await testDb!.pool.query<{ generation: string; beat: Date | null }>(
      "select owner_generation::text as generation, owner_heartbeat_at as beat from sync_pages where page_id = $1", [r.page.pageId],
    )).rows[0]!;
    const before = await owner();
    const host = await startHost(r);
    await until(async () => host.state(r.page.pageId).kind === "waiting", 10_000, "the page waiting");
    // Longer than the host's retry (5 s): every try would have taken the page.
    await sleep(6_500);
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_not_ready" });
    // No owner beats (alert 1 after its bound), and nothing reached the operator or Fansly.
    expect(await owner()).toEqual(before);
    expect(r.operator.hellos).toEqual([]);
    expect(r.server.arrivals).toEqual([]);

    await setPageBrowserSettings(db(), { profileId: r.profileId, pinnedExitIp: "203.0.113.7" });
    await until(async () => r.operator.physical.length >= 1, 30_000, "the page running on its browser");
    expect(r.server.arrivals).toEqual([]);
  }, 90_000);
});

describe("leaving the browser is confirmed before Node takes the page (Astra PR 14, P1)", () => {
  async function onBrowser(r: Rig): Promise<void> {
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    await testDb!.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
      [r.page.pageId, await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A)]);
  }

  it("the operator out of reach: Node waits, visibly; the owner's word that the container is stopped lets it go, the buffer marked not drained", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const host = await startHost(r);
    await until(async () => r.operator.physical.length >= 1, 20_000, "the page running on its browser");
    // The link to the operator goes (its socket may live on in the browser).
    await r.operator.close();
    const switched = await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" });
    expect(switched.pendingLeave).not.toBeNull();
    await sleep(3_000);
    // Nothing through Node while the browser's stop is not confirmed.
    expect(r.server.arrivals).toEqual([]);
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect((await leftBy(r.page.pageId)).pending).toBe(switched.pendingLeave!.toString());
    // What the alert evaluator reads: the pending leave, since the switch
    // (alert 2 `browser_leave_unconfirmed` after its bound).
    const liveFacts = () => readSyncLivePathFacts(db(), { pageId: r.page.pageId, decodeWindowMs: 60_000, unconfirmedAfterMs: 60_000 });
    expect((await liveFacts()).browserLeaveSince).toBeInstanceOf(Date);

    // The owner says the container is stopped (scripts/deploy-page-browser.sh to-node).
    const asserted = await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, browserStopped: true, actor: "test" });
    expect(asserted).toMatchObject({ changed: false, pendingLeave: null, browserStopped: { leftGeneration: switched.pendingLeave, bufferUndrained: true } });
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 30_000, "the page running on Node");
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "owner", pending: null });
    expect((await findPageBrowserByPage(db(), r.page.pageId))!.bufferUndrainedSince).toBeInstanceOf(Date);
    const facts = await liveFacts();
    expect(facts.bufferUndrainedSince).toBeInstanceOf(Date);
    expect(facts.browserLeaveSince).toBeNull();
    expect(await audits(r.page.pageId)).toEqual([
      expect.objectContaining({ to: "node", browserStopped: false }),
      expect.objectContaining({ to: "node", browserStopped: true, leftGeneration: switched.pendingLeave!.toString() }),
    ]);
    // Nothing more to confirm: refused.
    await expect(changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, browserStopped: true, actor: "test" }))
      .rejects.toBeInstanceOf(SyncOwnerLeverError);
  }, 90_000);

  it("a state said right after the stop does not confirm the leave: what the operator commits after it is taken first", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    await startHost(r);
    await until(async () => r.operator.physical.length >= 1, 20_000, "the page running on its browser");
    // The stopping browser's last event reaches the operator's buffer after
    // the state that says the page stopped (its commit batch, stretched).
    let late: { seq: number } | null = null;
    r.operator.lateAfterStop = { afterMs: 600, run: () => void (late = r.operator.gap("operator_start", null)) };
    await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" });
    await until(async () => (await leftBy(r.page.pageId)).by === "operator", 30_000, "the leave confirmed");
    expect(late).not.toBeNull();
    expect(r.operator.buffer.acknowledged).toBe(late!.seq);
    expect(r.operator.buffer.kept).toEqual([]);
  }, 90_000);

  it("an operator out of reach for long: the leave keeps telling the watchdog it goes on — the process is not taken for stalled", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    // What the host tells the process's stall watchdog.
    const tracked: Array<{ subject: StallSubject; phases: string[] }> = [];
    const watchdog: StallTracking = {
      track(subject, phase) {
        const entry = { subject, phases: [phase] };
        tracked.push(entry);
        return { progress: (next) => void entry.phases.push(next), done: () => undefined };
      },
    };
    const host = await startHost(r, { watchdog });
    await until(async () => r.operator.physical.length >= 1, 20_000, "the page running on its browser");
    await r.operator.close();
    const switched = await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" });
    // The leave runs under the generation after the one the page left at.
    const leave = () => tracked.find((entry) => entry.subject.component === "actor" && entry.subject.generation === switched.pendingLeave! + 1n);
    await until(async () => leave() !== undefined, 20_000, "the leave running");
    const looks = leave()!.phases.length;
    await sleep(2_000);
    // Waiting for the operator is no stall: every look is told to the
    // watchdog (it stops the process after 120 s without one).
    expect(leave()!.phases.length - looks).toBeGreaterThanOrEqual(4);
    expect(leave()!.phases.at(-1)).toBe("gate");
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect(r.server.arrivals).toEqual([]);
  }, 90_000);

  /**
   * The engine on its browser dies after a request went, before its capture:
   * the operator keeps the outcome, the attempt is left unfinished. The
   * deploy confirms the dead owner, and the owner moves the page to Node
   * while no `sync` runs. Returns the attempt.
   */
  async function diedAfterBrowserSent(r: Rig): Promise<AttemptRow> {
    r.operator.deliverResults = false;
    let browser!: BrowserPage;
    const crashed = await makeTestActor({
      db: db(),
      pageId: r.page.pageId,
      registry: harnessIdentityRegistry(),
      settingMs: 60,
      ownRef: HARNESS_OWN_REF,
      faults: (at) => {
        if (at === "after_send") throw new SyncCrashFault(at);
      },
      build: async ({ generation, pacer }) => {
        browser = await openBrowserPage({
          db: db(), config: r.config, logger: quietLogger, metrics: new RecordingMetrics(), registry: harnessIdentityRegistry(),
          clock: { monoNow: () => performance.now(), wallNow: () => new Date(), sleep: (ms, signal) => sleep(ms, undefined, { signal: signal ?? undefined }) },
          pageId: r.page.pageId, generation, ownRef: HARNESS_OWN_REF, settingMs: 60,
          raiseTakeoverFloor: (at) => pacer.raiseTakeoverFloor(at), enqueue: async () => undefined,
          overrides: { url: () => r.operator.url, settings: async (pageId) => linkSettings({ pageId, expectedAccountId: HARNESS_OWN_REF }), rpcTiming: RPC_TIMING },
        });
        browser.start();
        return { transport: browser.transport, site: browser.site };
      },
    });
    await expect(crashed.actor.run({ stop: crashed.stop.signal, abort: crashed.abort.signal })).rejects.toBeInstanceOf(SyncCrashFault);
    await browser.stop();
    await browser.transport.close();
    const [old] = await attempts(r.page.pageId);
    expect(old).toMatchObject({ outcome: "admitted" });
    expect(r.operator.held.has(old!.id)).toBe(true);
    await confirmSyncOwnersStopped(db(), { runningHosts: ["sync-a", "sync-b"], ownHost: "cli", confirmedBy: "test", dryRun: false, pageIds: [r.page.pageId] });
    await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" });
    r.operator.deliverResults = true;
    return old!;
  }

  const attemptOf = async (r: Rig, id: number) => (await attempts(r.page.pageId)).find((row) => row.id === id)!;

  it("the engine died after the browser sent; the page goes to Node meanwhile: a host that starts again stops the browser and takes its kept outcome before Node sends (Astra PR 14, P1 ×2)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const old = await diedAfterBrowserSent(r);

    await startHost(r);
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 30_000, "the page running on Node");
    // The outcome the operator kept is the attempt's: captured, applied,
    // acknowledged — never closed unknown, never sent again.
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "response", sendMark: "transport_reported" });
    expect(r.operator.recovers.flat()).toContain(old.id);
    expect(r.operator.acks).toContain(old.id);
    expect(r.operator.physical.filter((request) => request.attemptId === old.id)).toHaveLength(1);
    // Stopped, taken and confirmed before Node sent anything.
    expect(r.operator.commands.map((command) => command.command.kind)).toEqual(["stopPage"]);
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "operator", pending: null });
    // On the database's clock: Node's first admission after the confirmation.
    const order = (await testDb.pool.query<{ ok: boolean }>(
      `select min(a.admitted_at) > sp.browser_left_at as ok
         from sync_pages sp join sync_attempts a on a.page_id = sp.page_id and a.owner_generation > sp.browser_left_generation
        where sp.page_id = $1 group by sp.browser_left_at`, [r.page.pageId],
    )).rows[0]!;
    expect(order.ok).toBe(true);
  }, 120_000);

  it("a buffer the operator cannot open is not a drained one: its 0 bytes confirm nothing, the leave waits with the kept outcome unread; once it opens, the outcome is the attempt's and Node takes the page (Astra PR 14 round 2, P1)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const old = await diedAfterBrowserSent(r);
    // The operator's buffer cannot be opened: it counts 0 bytes, answers a
    // recover with `unknown`, refuses the subscription — and its stopPage
    // replaces whatever stop reason said so.
    r.operator.setBufferUnavailable("locked");

    const host = await startHost(r);
    await until(async () => r.operator.commands.length >= 1, 20_000, "the browser stopped by the leave");
    await until(async () => r.operator.recovers.flat().includes(old.id), 20_000, "the operator asked about the attempt");
    await sleep(3_000);
    expect(r.operator.state).toMatchObject({ stopReason: "owner_stop", exitOpen: false });
    // Not confirmed: Node has not taken the page, the attempt is not closed
    // unknown, nothing is acknowledged.
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: null });
    expect((await leftBy(r.page.pageId)).pending).not.toBeNull();
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect(r.server.arrivals).toEqual([]);
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "admitted" });
    expect(r.operator.held.has(old.id)).toBe(true);

    // The buffer opens: what it kept goes to the engine, and is the attempt's.
    r.operator.setBufferUnavailable(null);
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 30_000, "the page running on Node");
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "response", sendMark: "transport_reported" });
    expect(r.operator.acks).toContain(old.id);
    expect(r.operator.held.size).toBe(0);
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "operator", pending: null });
  }, 120_000);

  it("a body that does not read for a while: the operator answers unknown and keeps the outcome; the leave asks again, at a bounded rate, and takes it as the attempt's once it reads (Astra PR 14 round 2, P1)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const old = await diedAfterBrowserSent(r);
    // A failing disk: the outcome's body cannot be read (EIO) — the recover
    // answers `unknown`, the outcome stays kept.
    r.operator.bodiesUnreadable = true;

    const host = await startHost(r);
    await until(async () => r.operator.recovers.flat().includes(old.id), 20_000, "the operator asked about the attempt");
    const firstAsked = Date.now();
    await sleep(5_000);
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "admitted" });
    expect(r.server.arrivals).toEqual([]);
    // Asked again, never in a tight loop: first after 2 s, then 4 s, …
    const asked = r.operator.recovers.filter((ids) => ids.includes(old.id)).length;
    expect(asked).toBeGreaterThanOrEqual(2);
    expect(asked).toBeLessThanOrEqual(2 + Math.ceil((Date.now() - firstAsked) / 2_000));

    // The disk reads again: the next ask resends it, and it is the attempt's.
    r.operator.bodiesUnreadable = false;
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 40_000, "the page running on Node");
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "response", sendMark: "transport_reported" });
    expect(r.operator.acks).toContain(old.id);
    expect(r.operator.held.size).toBe(0);
    expect(r.operator.physical.filter((request) => request.attemptId === old.id)).toHaveLength(1);
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "operator", pending: null });
  }, 120_000);

  it("an outcome of an attempt settled already, its body unreadable when the leave connected: with nothing unfinished to ask, the leave connects again, at a bounded rate, until the operator delivers it (Astra PR 14 round 2, P1)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const old = await diedAfterBrowserSent(r);
    // Its owner's recovery closed it `unknown`; the operator still keeps its
    // outcome, whose body cannot be read now.
    await db().transaction(async (tx) => settleAttemptWithoutCapture(tx as unknown as Database, { attemptId: old.id, outcome: "unknown", errorClass: "recovery:unknown" }));
    r.operator.bodiesUnreadable = true;

    const host = await startHost(r);
    await until(async () => r.operator.commands.length >= 1, 20_000, "the browser stopped by the leave");
    const hellos = r.operator.hellos.length;
    await sleep(5_000);
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect(r.server.arrivals).toEqual([]);
    // Connected again, never in a tight loop.
    const again = r.operator.hellos.length - hellos;
    expect(again).toBeGreaterThanOrEqual(1);
    expect(again).toBeLessThanOrEqual(3);

    r.operator.bodiesUnreadable = false;
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 60_000, "the page running on Node");
    // A late answer of a settled attempt: kept as a fact, acknowledged, never applied in its place.
    expect(r.operator.acks).toContain(old.id);
    expect(r.operator.held.size).toBe(0);
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "unknown" });
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "operator", pending: null });
  }, 120_000);

  it("a mixed buffer — a settled attempt's outcome kept with its body unread, beside an unfinished attempt the operator keeps nothing of: everything kept is redelivered on its own backoff, whatever recover names (Astra PR 14 round 3, P1)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const old = await diedAfterBrowserSent(r);
    // #2: an unfinished attempt of the page the operator keeps nothing of
    // (its recover answers `unknown`), so `recover` always names something.
    const second = (await testDb.pool.query<{ id: number }>(
      `insert into sync_attempts
       select (jsonb_populate_record(null::sync_attempts, to_jsonb(a) || jsonb_build_object('id', nextval(pg_get_serial_sequence('sync_attempts', 'id'))))).*
         from sync_attempts a where a.id = $1
       returning id::int`, [old.id],
    )).rows[0]!.id;
    // #1: settled already; the operator keeps its outcome, whose body cannot be read now.
    await db().transaction(async (tx) => settleAttemptWithoutCapture(tx as unknown as Database, { attemptId: old.id, outcome: "unknown", errorClass: "recovery:unknown" }));
    r.operator.bodiesUnreadable = true;

    const host = await startHost(r);
    await until(async () => r.operator.recovers.flat().includes(second), 20_000, "the operator asked about #2");
    const hellos = r.operator.hellos.length;
    const since = Date.now();
    await sleep(5_000);
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_leave_unconfirmed" });
    expect(r.server.arrivals).toEqual([]);
    // Asked again both ways, never in a tight loop (2 s, then 4 s, …).
    expect(r.operator.recovers.filter((ids) => ids.includes(second)).length).toBeGreaterThanOrEqual(2);
    const again = r.operator.hellos.length - hellos;
    expect(again).toBeGreaterThanOrEqual(1);
    expect(again).toBeLessThanOrEqual(1 + Math.ceil((Date.now() - since) / 2_000));
    expect(r.operator.held.has(old.id)).toBe(true);

    // The disk reads again: the next redelivery gives #1, taken as a late
    // fact; the leave is confirmed and Node sends. (Node's own work after
    // that is not this test's: #2 is a copy of #1's attempt, of its work.)
    r.operator.bodiesUnreadable = false;
    await until(async () => (await leftBy(r.page.pageId)).by === "operator" && r.server.arrivals.length >= 1, 60_000, "the leave confirmed, Node sending");
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "running" });
    expect(r.operator.acks).toContain(old.id);
    expect(r.operator.held.size).toBe(0);
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "unknown" });
    expect(await leftBy(r.page.pageId)).toMatchObject({ by: "operator", pending: null });
  }, 120_000);
});

describe("sync ownership confirm-stopped waits for the browser pages' hand-over (plan §4.7)", () => {
  it("prints nothing more while every page is on Node; for a browser page, waits until its operator's quiesced for the current owner", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const printed: string[] = [];
    const cli = () => buildSyncEngineCommandGroup({
      openContext: async () => ({ db: db(), rawConfig: r.config, close: async () => undefined }),
      print: (line) => printed.push(line),
    });
    const confirm = (waitMs: number) => cli().parseAsync(
      ["ownership", "confirm-stopped", "--running-hosts", "sync-a,sync-b", "--quiesced-wait-ms", String(waitMs)], { from: "user" },
    );
    // Node pages only: the output is as it always was.
    await confirm(5_000);
    expect(printed).toEqual(["page\tgeneration\towner_host\tconfirmed"]);

    printed.length = 0;
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    await testDb.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
      [r.page.pageId, await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A)]);
    let release!: () => void;
    r.operator.holdQuiesce = new Promise<void>((resolve) => (release = resolve));
    const host = await startHost(r);
    await until(async () => host.state(r.page.pageId).kind === "running", 10_000, "the browser page taken");
    const generation = (host.state(r.page.pageId) as { generation: bigint }).generation;
    // The operator has not answered the new owner yet: the wait runs out.
    const started = Date.now();
    await confirm(1_500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(printed.slice(1)).toEqual(["browser_page\towner_generation\tquiesced", `${r.page.pageLabel}\t${generation}\tfalse`]);
    expect(r.operator.sends).toEqual([]);

    printed.length = 0;
    setTimeout(release, 500);
    await confirm(10_000);
    expect(printed.slice(1)).toEqual(["browser_page\towner_generation\tquiesced", `${r.page.pageLabel}\t${generation}\ttrue`]);
  }, 60_000);
});

describe("the rollback of a page connected through its browser (owner decision №12)", () => {
  /** Another account's session: its `/account/me` is someone else. */
  const another: FakeRoute = (request) => (request.url.pathname === "/api/v1/account/me" && request.headers.authorization === "another-token"
    ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: true, response: { account: { id: "399999999999999999", username: "someone-else", displayName: null, createdAt: 0, followCount: 0, subscriberCount: 0 } } }) }
    : null);

  it("Chrome down, no Node session: prepare, the identity check through Node by the owner's session, stored and trusted in one transaction", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ first: [another], session: null });
    // Connected through its browser: no Node session; its browser's session
    // is the trusted one. Chrome is down: the operator has no session, its
    // exit is closed.
    await testDb.pool.query("delete from page_credentials where platform_account_id = $1", [r.page.pageId]);
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    await testDb.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
      [r.page.pageId, await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A)]);
    r.operator.state = { ...r.operator.state, step: "exit_closed", stopReason: "chrome_crashed", exitOpen: false, sessionFingerprint: null };
    const host = await startHost(r);
    await until(async () => r.operator.links.includes(true), 10_000, "the link to the operator");
    await sleep(1_000);
    expect(r.operator.sends).toEqual([]);

    // Without --prepare there is no way back: nothing to send with on Node.
    await expect(changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" }))
      .rejects.toBeInstanceOf(SyncOwnerLeverError);
    expect(await getSyncPageTransport(db(), r.page.pageId)).toBe("browser");

    // Prepare, through the owner's CLI (audited).
    const printed: string[] = [];
    const cli = buildSyncEngineCommandGroup({
      openContext: async () => ({ db: db(), rawConfig: r.config, close: async () => undefined }),
      print: (line) => printed.push(line),
    });
    await cli.parseAsync(["page", "transport", r.page.pageLabel, "node", "--prepare", "--note", "rollback drill"], { from: "user" });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ page: r.page.pageLabel, from: "browser", to: "node", changed: true, prepared: { hold: "auth", refusedDigest: null } });
    expect(await audits(r.page.pageId)).toEqual([expect.objectContaining({ from: "browser", to: "node", prepare: true, note: "rollback drill" })]);
    expect(await credentialsHold(r.page.pageId)).toMatchObject({ kind: "auth", detail: { reason: "transport_prepare", credentialsGeneration: null } });
    // The browser slot ends: its operator stops the page (exit closed first).
    await until(async () => r.operator.commands.some((command) => command.command.kind === "stopPage"), 10_000, "the operator told to stop");
    const g1 = BigInt(r.operator.commands[0]!.ownerGeneration);
    await until(async () => host.state(r.page.pageId).kind === "running"
      && (host.state(r.page.pageId) as { generation: bigint }).generation === g1 + 1n, 10_000, "the page on Node");
    // Under the hold, with no session: nothing goes at all.
    await sleep(1_500);
    expect(r.server.arrivals).toEqual([]);

    const app: AppContext = createTestAppContext(testDb, { fanslySendGuardSettingMs: S });
    const page = { id: r.page.pageId, label: r.page.pageLabel };
    const storedSessions = async () => Number((await testDb!.pool.query<{ n: number }>(
      "select count(*)::int as n from page_credentials where platform_account_id = $1", [page.id])).rows[0]!.n);

    // Another account's session: refused, nothing stored, nothing trusted.
    const before = await trusted(page.id);
    await expect(updatePageCredentials(app, page.label, { platform: "fansly", session: session("another-token") })).rejects.toThrow(/identity mismatch/i);
    expect(r.identityTokens).toEqual(["another-token"]);
    expect(await storedSessions()).toBe(0);
    expect(await trusted(page.id)).toBe(before);

    // The owner's session, checked; the base it stood on moves before the
    // save (another proxy): nothing is stored, nothing trusted — one CAS.
    const checked = await checkFanslyIdentityThroughEngine(app, page, { session: session("owner-token") });
    expect(r.identityTokens.at(-1)).toBe("owner-token");
    const other = await CountingConnectProxy.start();
    cleanups.push(() => other.close());
    await saveProxy({ config: app.config, db: db() }, page.id, { url: other.url });
    const store = async (tx: Database) => {
      await storeFanslySession(tx, page.id, JSON.stringify(encryptJson(session("owner-token"), HARNESS_ENCRYPTION_KEY, 1)), 1);
    };
    await expect(saveVerifiedFanslyCredentials(app, page, checked, store)).rejects.toBeInstanceOf(FanslyCredentialsChangedError);
    expect(await storedSessions()).toBe(0);
    expect(await trusted(page.id)).toBe(before);

    // The owner's credentials change, as the dashboard sends it: the check
    // through Node by that session, then stored and trusted together.
    await expect(updatePageCredentials(app, page.label, { platform: "fansly", session: session("owner-token") }))
      .resolves.toMatchObject({ updated: true, verified: true });
    expect(r.identityTokens.filter((token) => token === "owner-token").length).toBeGreaterThanOrEqual(2);
    expect(await storedSessions()).toBe(1);
    expect(await trusted(page.id)).toBe(await nodeGeneration(r.page));
    // The verify of what is stored lifts the hold; ordinary work on Node.
    await until(async () => (await credentialsHold(page.id)) === null && r.server.arrivalsAt("/api/v1/polls").length >= 1, 30_000, "the page working on Node");
    expect(r.identityTokens.at(-1)).toBe("owner-token");
    expect(r.operator.sends).toEqual([]);
  }, 120_000);
});
