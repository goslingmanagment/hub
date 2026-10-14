import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getSyncPageManualLogin,
  insertPageBrowser,
  setPageBrowserSettings,
  setSyncPageManualLogin,
  setSyncPageTransport,
  type Database,
} from "@agency_hub_core/db";

import type { SiteAdmitResult } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import { changeSyncPagePause, SyncOwnerLeverError } from "../apps/runtime/src/sync/inspect.ts";
import { readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOperator, linkSettings, OPERATOR_TOKEN, SESSION_A } from "./helpers/page-browser-operator.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  HARNESS_OWN_REF,
  harnessConfig,
  harnessHostOptions,
  harnessIdentityRegistry,
  harnessRng,
  harnessRoutes,
  seedHarnessPage,
  until,
  type HarnessPage,
} from "./helpers/sync-engine.ts";

// The owner's login of a page's browser on the engine's side (Project
// Browser plan §4.8, §3.2; stage 3 PR 15; stage 4 step 2) on a real host,
// the browser a fake operator (the operator's own RPC server):
// - a page on Node is linked to its browser only while the owner's login is
//   open: the page on the owner's pause at once, its operator into the
//   manual login (setMode) and started; the login's own requests (origin
//   `login`) and the reads its interface makes (origin `site`, their answers
//   in `observations`) admitted under the pause through the same pacer and
//   journal, its socket refused; closed: the browser
//   stopped first, the automation back, then off — the pause the login put on
//   the page lifted, Node sending again, the link closed;
// - a page on its browser: the same over its own slot, no stop at the end,
//   Hub's requests through the browser only once the automation is back;
// - an operator out of reach: a closing login ends without it; a page
//   unpaused during its login is paused again;
// - the owner's own pause and the login (Astra's review of PR 15, item 5):
//   the owner's pause of the whole page during a login stays after it, and
//   the owner's resume of it is refused while the login is open.

const S = 300;
const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
const RPC_TIMING = { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 };
const LOGIN_TIMING = { everyMs: 100, commandWaitMs: 2_000, unreachableEndMs: 1_000, restartEveryMs: 500 };

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

interface Rig {
  server: FakeFanslyServer;
  proxy: CountingConnectProxy;
  operator: FakeOperator;
  page: HarnessPage;
  profileId: string;
  config: ReturnType<typeof harnessConfig>;
}

async function rig(): Promise<Rig> {
  const server = await FakeFanslyServer.start();
  const proxy = await CountingConnectProxy.start();
  const operator = await FakeOperator.start({ accountId: HARNESS_OWN_REF });
  cleanups.push(async () => {
    await server.close();
    await proxy.close();
    await operator.close();
  });
  operator.startStatePushes(100);
  // The browser stands, as a page's operator does until it is started.
  operator.state = { ...operator.state, step: "exit_closed", exitOpen: false };
  for (const route of harnessRoutes(new FakeChats())) server.route(route);
  const label = `login-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: proxy.url, label });
  const config = harnessConfig(testDb!.connectionString, server.apiBaseUrl);
  const profileId = randomUUID();
  await insertPageBrowser(db(), {
    profileId,
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config, { engineToken: OPERATOR_TOKEN, apiToken: "api-token-of-the-test", vncPassword: "vnc-password-of-the-test" }),
  });
  await setPageBrowserSettings(db(), { profileId, pinnedExitIp: "203.0.113.7", env: ENV });
  return { server, proxy, operator, page, profileId, config };
}

async function startHost(r: Rig): Promise<SyncEngineHost> {
  const host = new SyncEngineHost({
    ...harnessHostOptions({ db: db(), pool: testDb!.pool, connectionString: testDb!.connectionString, config: r.config, rng: harnessRng(15), registry: harnessIdentityRegistry() }),
    browserOverrides: {
      url: () => r.operator.url,
      settings: async (pageId) => linkSettings({ pageId, expectedAccountId: HARNESS_OWN_REF }),
      rpcTiming: RPC_TIMING,
      transportTiming: { unavailableRetryMs: 100, resultWaitMs: 10_000 },
      leaveWaitMs: 5_000,
      loginTiming: LOGIN_TIMING,
    },
  });
  cleanups.push(() => host.stop());
  await host.start();
  return host;
}

async function login(r: Rig, to: "wanted" | "ending"): Promise<void> {
  await db().transaction(async (raw) => setSyncPageManualLogin(raw as unknown as Database, { pageId: r.page.pageId, to, by: "owner:test" }));
}

async function attemptsOf(pageId: number): Promise<Array<{ origin: string; outcome: string; operation: string | null }>> {
  return (await testDb!.pool.query<{ origin: string; outcome: string; operation: string | null }>(
    "select origin, outcome, request->>'path' as operation from sync_attempts where page_id = $1 and origin <> 'engine' order by id", [pageId],
  )).rows;
}

/** The operator's own login request asks the engine; the answer it got. */
async function asked(r: Rig, input: Parameters<FakeOperator["siteAdmit"]>[0]): Promise<SiteAdmitResult> {
  const ask = r.operator.siteAdmit(input);
  await until(async () => r.operator.siteAnswers.some((answer) => answer.siteRequestId === ask.siteRequestId), 10_000, `the engine's answer to ${input.path}`);
  return r.operator.siteAnswers.find((answer) => answer.siteRequestId === ask.siteRequestId)!;
}

describe("a page on Node, logged in before its switch (stage 4, step 2)", () => {
  it("links to its browser only for the login: paused, into the manual login and started; the login's requests and its interface's reads under the pause, no socket; closed: stopped, the automation back, unpaused, unlinked", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const host = await startHost(r);
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 2, 15_000, "the page running on Node");
    // No login: no link.
    await sleep(500);
    expect(r.operator.links).toEqual([]);

    await login(r, "wanted");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "wanted", paused: true, pausedAll: true });
    await until(async () => r.operator.commands.some((command) => command.command.kind === "restartBrowser"), 10_000, "the browser started");
    const kinds = r.operator.commands.map((command) => command.command.kind === "setMode" ? `setMode:${command.command.mode}` : command.command.kind);
    expect(kinds.slice(0, 2)).toEqual(["setMode:manual_login", "restartBrowser"]);
    // Every command is of the slot's owner generation.
    const owner = host.state(r.page.pageId);
    expect(owner.kind).toBe("running");
    expect(r.operator.commands.every((command) => BigInt(command.ownerGeneration) === (owner.kind === "running" ? owner.generation : -1n))).toBe(true);
    // Node stops: the page is paused.
    await sleep(800);
    const nodeArrivals = r.server.arrivals.length;
    await sleep(1_500);
    expect(r.server.arrivals.length).toBe(nodeArrivals);

    // The login's own request passes the pause, as a login operation.
    const admitted = await asked(r, { method: "POST", path: "/api/v1/login", route: "auth.login", operation: "login", sessionFingerprint: null });
    expect(admitted).toMatchObject({ admit: true });
    r.operator.siteDone(admitted as SiteAdmitResult & { admit: true }, { status: 200, body: "not_platform_data" });
    await until(async () => r.operator.acks.includes((admitted as { attemptId: number }).attemptId), 10_000, "the end acknowledged");
    // The reads its interface makes pass too (plan §4.8; PR 15), the login
    // screens' and the account's, and their answers go to `observations` as
    // any site answer; the socket is Node's: refused.
    const screenRead = await asked(r, { path: "/api/v1/versioning", route: "site.other" });
    expect(screenRead).toMatchObject({ admit: true });
    r.operator.siteDone(screenRead as SiteAdmitResult & { admit: true }, { status: 200 });
    const accountRead = await asked(r, { path: "/api/v1/account/me", route: "account.me", sessionFingerprint: null });
    expect(accountRead).toMatchObject({ admit: true });
    r.operator.siteDone(accountRead as SiteAdmitResult & { admit: true }, { status: 200 });
    const answer = r.operator.siteResponse({ route: "account.me", path: "/api/v1/account/me", body: JSON.stringify({ success: true, response: { account: { id: "300000000000000001" } } }) });
    await until(async () => (await testDb!.pool.query("select 1 from observations where account_id = $1 and source = 'browser_site' and producer = 'fansly-site:account.me'", [r.page.pageId])).rowCount === 1, 10_000, `the account's answer (${answer.seq}) in observations`);
    const socket = r.operator.wsAdmit({ sessionFingerprint: null });
    await until(async () => r.operator.wsAnswers.some((answer) => answer.connectionId === socket.connectionId), 5_000, "the socket's answer");
    expect(r.operator.wsAnswers.find((answer) => answer.connectionId === socket.connectionId)).toMatchObject({ admit: false, reason: "mode" });
    const journaled = await attemptsOf(r.page.pageId);
    expect(journaled.map((attempt) => `${attempt.origin} ${attempt.operation}`)).toEqual(["login /api/v1/login", "site /api/v1/versioning", "site /api/v1/account/me"]);

    // The owner closes the login: stopped first, then the automation, then off.
    const before = r.operator.commands.length;
    await login(r, "ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", 10_000, "the login closed");
    const closing = r.operator.commands.slice(before).map((command) => command.command.kind === "setMode" ? `setMode:${command.command.mode}` : command.command.kind);
    expect(closing).toEqual(["stopPage", "setMode:automation"]);
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "off", paused: false, pausedAll: false, changedBy: "engine" });
    // Node sends again; the link is closed.
    const resumed = r.server.arrivals.length;
    await until(async () => r.server.arrivals.length > resumed, 15_000, "Node sending again");
    await until(async () => r.operator.links.at(-1) === false, 10_000, "the link closed");
  }, 60_000);

  it("a browser halted for the owner's decision (a changed exit IP) is not started by a login", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.state = { ...r.operator.state, stopReason: "exit_ip_changed" };
    await startHost(r);
    await login(r, "wanted");
    await until(async () => r.operator.commands.some((command) => command.command.kind === "setMode"), 10_000, "the manual login");
    await sleep(1_500);
    expect(r.operator.commands.some((command) => command.command.kind === "restartBrowser")).toBe(false);
  }, 30_000);

  it("a page the owner had paused before stays paused after its login", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await testDb.pool.query("update sync_pages set paused_all = true where page_id = $1", [r.page.pageId]);
    await startHost(r);
    await login(r, "wanted");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "wanted", paused: false, pausedAll: true });
    await until(async () => r.operator.commands.some((command) => command.command.kind === "restartBrowser"), 10_000, "the browser started");
    await login(r, "ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", 10_000, "the login closed");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "off", pausedAll: true });
  }, 30_000);

  it("a page unpaused during its login is paused again; an operator out of reach while it closes: closed without it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await startHost(r);
    await login(r, "wanted");
    await until(async () => r.operator.commands.some((command) => command.command.kind === "setMode"), 10_000, "the manual login");
    await testDb.pool.query("update sync_pages set paused_all = false where page_id = $1", [r.page.pageId]);
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.pausedAll === true, 5_000, "paused again");
    // The operator goes; the owner closes the login.
    await r.operator.close();
    await login(r, "ending");
    await sleep(500);
    expect((await getSyncPageManualLogin(db(), r.page.pageId))?.value).toBe("ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", 10_000, "closed without the operator");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ pausedAll: false });
  }, 30_000);
});

describe("a page on its browser", () => {
  it("follows the login over its own slot: no Hub request while it is open, the login's requests under the pause; closed: the automation back, no stop, unpaused", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.state = { ...r.operator.state, step: "ready", exitOpen: true };
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    await testDb.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
      [r.page.pageId, await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A)]);
    await startHost(r);
    await until(async () => r.operator.physical.length >= 1, 20_000, "the page running on its browser");

    await login(r, "wanted");
    await until(async () => r.operator.state.mode === "manual_login", 10_000, "the manual login");
    // A page that is up is not started again.
    await sleep(800);
    expect(r.operator.commands.some((command) => command.command.kind === "restartBrowser")).toBe(false);
    const sends = r.operator.sends.length;
    await sleep(1_500);
    expect(r.operator.sends.length).toBe(sends);
    const admitted = await asked(r, { method: "POST", path: "/api/v1/login/twofa", route: "auth.twofa", operation: "login", sessionFingerprint: null });
    expect(admitted).toMatchObject({ admit: true });
    r.operator.siteDone(admitted as SiteAdmitResult & { admit: true }, { status: 200, body: "not_platform_data" });

    const before = r.operator.commands.length;
    await login(r, "ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", 10_000, "the login closed");
    expect(r.operator.commands.slice(before).map((command) => command.command.kind)).toEqual(["setMode"]);
    expect(r.operator.state.mode).toBe("automation");
    await until(async () => r.operator.sends.length > sends, 15_000, "Hub's requests through the browser again");
  }, 60_000);
});

describe("the owner's pause and the login (Astra's review of PR 15, item 5)", () => {
  const lever = (r: Rig, action: "pause" | "resume", what: { all?: boolean; requests?: boolean }) =>
    changeSyncPagePause(db(), createFanslyRegistry(), { pageLabel: r.page.pageLabel, action, ...what });

  it("a pause of the whole page the owner asks for during a login is the owner's: it stays when the login ends", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await startHost(r);
    // An unpaused page: the login puts it on its pause.
    await login(r, "wanted");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "wanted", paused: true, pausedAll: true });
    await until(async () => r.operator.commands.some((command) => command.command.kind === "restartBrowser"), 10_000, "the browser started");
    // The owner pauses the page meanwhile: the pause is the owner's now.
    expect(await lever(r, "pause", { all: true })).toMatchObject({ pausedAll: true });
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "wanted", paused: false, pausedAll: true });
    // The login ends (the engine, after the automation is back): the
    // owner's pause stands.
    await login(r, "ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", 10_000, "the login closed");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "off", paused: false, pausedAll: true });
  }, 30_000);

  it("a resume of the whole page is refused while a login is open, nothing changed; the other levers work; after it, the resume does", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await login(r, "wanted");
    for (const state of ["wanted", "ending"] as const) {
      if (state === "ending") await login(r, "ending");
      const refused = lever(r, "resume", { all: true });
      await expect(refused, state).rejects.toBeInstanceOf(SyncOwnerLeverError);
      await expect(refused, state).rejects.toThrow(/login of its browser is open/);
      expect(await getSyncPageManualLogin(db(), r.page.pageId), state).toMatchObject({ value: state, paused: true, pausedAll: true });
      // Its history requests are another lever: taken.
      expect(await lever(r, "pause", { requests: true }), state).toMatchObject({ pausedAll: true, pausedRequests: true });
      // Nothing of a refused call goes in, not even its part beside the whole page.
      await expect(lever(r, "resume", { all: true, requests: true }), state).rejects.toBeInstanceOf(SyncOwnerLeverError);
      expect((await testDb.pool.query("select paused_requests from sync_pages where page_id = $1", [r.page.pageId])).rows[0], state).toEqual({ paused_requests: true });
      expect(await lever(r, "resume", { requests: true }), state).toMatchObject({ pausedAll: true, pausedRequests: false });
    }
    // The login over (no engine here: as it ends it), the owner resumes.
    await testDb.pool.query("update sync_pages set manual_login = 'off', manual_login_paused = false where page_id = $1", [r.page.pageId]);
    expect(await lever(r, "resume", { all: true })).toMatchObject({ pausedAll: false });
  }, 30_000);
});
