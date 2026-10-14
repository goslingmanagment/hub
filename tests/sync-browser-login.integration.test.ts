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
/** Hang guards, not speed checks (a loaded CI machine): one awaited event,
 *  and a test of several. */
const WAIT_MS = 30_000;
const LONG_TEST_MS = 120_000;

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
      // A result may be held across a whole login (a hang guard).
      transportTiming: { unavailableRetryMs: 100, resultWaitMs: WAIT_MS },
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

/** The engine's own requests admitted after `since` (the login's pause):
 *  none while the page is paused. What was admitted before may still go,
 *  however late a loaded machine lets it. */
async function engineAdmittedSince(pageId: number, since: Date): Promise<number> {
  return (await testDb!.pool.query<{ n: number }>("select count(*)::int as n from sync_attempts where page_id = $1 and origin = 'engine' and admitted_at > $2", [pageId, since])).rows[0]!.n;
}

async function attemptsOf(pageId: number): Promise<Array<{ origin: string; outcome: string; operation: string | null }>> {
  return (await testDb!.pool.query<{ origin: string; outcome: string; operation: string | null }>(
    "select origin, outcome, request->>'path' as operation from sync_attempts where page_id = $1 and origin <> 'engine' order by id", [pageId],
  )).rows;
}

/** The operator's own login request asks the engine; the answer it got. */
async function asked(r: Rig, input: Parameters<FakeOperator["siteAdmit"]>[0]): Promise<SiteAdmitResult> {
  const ask = r.operator.siteAdmit(input);
  await until(async () => r.operator.siteAnswers.some((answer) => answer.siteRequestId === ask.siteRequestId), WAIT_MS, `the engine's answer to ${input.path}`);
  return r.operator.siteAnswers.find((answer) => answer.siteRequestId === ask.siteRequestId)!;
}

describe("a page on Node, logged in before its switch (stage 4, step 2)", () => {
  it("links to its browser only for the login: paused, into the manual login and started; the login's requests and its interface's reads under the pause, no socket; closed: stopped, the automation back, unpaused, unlinked", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const host = await startHost(r);
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 2, WAIT_MS, "the page running on Node");
    // No login: no link.
    await sleep(500);
    expect(r.operator.links).toEqual([]);

    await login(r, "wanted");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "wanted", paused: true, pausedAll: true });
    await until(async () => r.operator.commands.some((command) => command.command.kind === "restartBrowser"), WAIT_MS, "the browser started");
    const kinds = r.operator.commands.map((command) => command.command.kind === "setMode" ? `setMode:${command.command.mode}` : command.command.kind);
    expect(kinds.slice(0, 2)).toEqual(["setMode:manual_login", "restartBrowser"]);
    // Every command is of the slot's owner generation.
    const owner = host.state(r.page.pageId);
    expect(owner.kind).toBe("running");
    expect(r.operator.commands.every((command) => BigInt(command.ownerGeneration) === (owner.kind === "running" ? owner.generation : -1n))).toBe(true);
    // Node stops: the page is paused — nothing of the engine's own admitted
    // from the login's pause on (a negative check: the wait only gives a
    // wrong engine the time to admit).
    const pausedAt = (await getSyncPageManualLogin(db(), r.page.pageId))!.changedAt!;
    await sleep(1_500);
    expect(await engineAdmittedSince(r.page.pageId, pausedAt)).toBe(0);

    // The login's own request passes the pause, as a login operation.
    const admitted = await asked(r, { method: "POST", path: "/api/v1/login", route: "auth.login", operation: "login", sessionFingerprint: null });
    expect(admitted).toMatchObject({ admit: true });
    r.operator.siteDone(admitted as SiteAdmitResult & { admit: true }, { status: 200, body: "not_platform_data" });
    await until(async () => r.operator.acks.includes((admitted as { attemptId: number }).attemptId), WAIT_MS, "the end acknowledged");
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
    await until(async () => (await testDb!.pool.query("select 1 from observations where account_id = $1 and source = 'browser_site' and producer = 'fansly-site:account.me'", [r.page.pageId])).rowCount === 1, WAIT_MS, `the account's answer (${answer.seq}) in observations`);
    const socket = r.operator.wsAdmit({ sessionFingerprint: null });
    await until(async () => r.operator.wsAnswers.some((answer) => answer.connectionId === socket.connectionId), WAIT_MS, "the socket's answer");
    expect(r.operator.wsAnswers.find((answer) => answer.connectionId === socket.connectionId)).toMatchObject({ admit: false, reason: "mode" });
    const journaled = await attemptsOf(r.page.pageId);
    expect(journaled.map((attempt) => `${attempt.origin} ${attempt.operation}`)).toEqual(["login /api/v1/login", "site /api/v1/versioning", "site /api/v1/account/me"]);

    // The owner closes the login: stopped first, then the automation, then off.
    const before = r.operator.commands.length;
    await login(r, "ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", WAIT_MS, "the login closed");
    const closing = r.operator.commands.slice(before).map((command) => command.command.kind === "setMode" ? `setMode:${command.command.mode}` : command.command.kind);
    expect(closing).toEqual(["stopPage", "setMode:automation"]);
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "off", paused: false, pausedAll: false, changedBy: "engine" });
    // Node sends again; the link is closed.
    const resumed = r.server.arrivals.length;
    await until(async () => r.server.arrivals.length > resumed, WAIT_MS, "Node sending again");
    await until(async () => r.operator.links.at(-1) === false, WAIT_MS, "the link closed");
  }, LONG_TEST_MS);

  it("a browser halted for the owner's decision (a changed exit IP) is not started by a login", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.state = { ...r.operator.state, stopReason: "exit_ip_changed" };
    await startHost(r);
    await login(r, "wanted");
    await until(async () => r.operator.commands.some((command) => command.command.kind === "setMode"), WAIT_MS, "the manual login");
    await sleep(1_500);
    expect(r.operator.commands.some((command) => command.command.kind === "restartBrowser")).toBe(false);
  }, LONG_TEST_MS);

  it("a page the owner had paused before stays paused after its login", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await testDb.pool.query("update sync_pages set paused_all = true where page_id = $1", [r.page.pageId]);
    await startHost(r);
    await login(r, "wanted");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "wanted", paused: false, pausedAll: true });
    await until(async () => r.operator.commands.some((command) => command.command.kind === "restartBrowser"), WAIT_MS, "the browser started");
    await login(r, "ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", WAIT_MS, "the login closed");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "off", pausedAll: true });
  }, LONG_TEST_MS);

  it("a page unpaused during its login is paused again; an operator out of reach while it closes: closed without it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await startHost(r);
    await login(r, "wanted");
    await until(async () => r.operator.commands.some((command) => command.command.kind === "setMode"), WAIT_MS, "the manual login");
    await testDb.pool.query("update sync_pages set paused_all = false where page_id = $1", [r.page.pageId]);
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.pausedAll === true, WAIT_MS, "paused again");
    // The operator goes; the owner closes the login.
    await r.operator.close();
    await login(r, "ending");
    await sleep(500);
    expect((await getSyncPageManualLogin(db(), r.page.pageId))?.value).toBe("ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", WAIT_MS, "closed without the operator");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ pausedAll: false });
  }, LONG_TEST_MS);
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
    await until(async () => r.operator.physical.length >= 1, WAIT_MS, "the page running on its browser");

    await login(r, "wanted");
    await until(async () => r.operator.state.mode === "manual_login", WAIT_MS, "the manual login");
    // A page that is up is not started again, and nothing of the engine's
    // own is admitted from the login's pause on (negative checks: the wait
    // only gives a wrong engine the time).
    const pausedAt = (await getSyncPageManualLogin(db(), r.page.pageId))!.changedAt!;
    await sleep(1_500);
    expect(r.operator.commands.some((command) => command.command.kind === "restartBrowser")).toBe(false);
    expect(await engineAdmittedSince(r.page.pageId, pausedAt)).toBe(0);
    const sends = r.operator.sends.length;
    const admitted = await asked(r, { method: "POST", path: "/api/v1/login/twofa", route: "auth.twofa", operation: "login", sessionFingerprint: null });
    expect(admitted).toMatchObject({ admit: true });
    r.operator.siteDone(admitted as SiteAdmitResult & { admit: true }, { status: 200, body: "not_platform_data" });

    const before = r.operator.commands.length;
    await login(r, "ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", WAIT_MS, "the login closed");
    expect(r.operator.commands.slice(before).map((command) => command.command.kind)).toEqual(["setMode"]);
    expect(r.operator.state.mode).toBe("automation");
    await until(async () => r.operator.sends.length > sends, WAIT_MS, "Hub's requests through the browser again");
  }, LONG_TEST_MS);
});

describe("after a login: the account checked anew (Astra's review of PR 15, item 6)", () => {
  it("a page on its browser, its session's fingerprint unchanged by the login: nothing ordinary goes before a fresh account check, and a proof sent before the end counts for nothing", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.state = { ...r.operator.state, step: "ready", exitOpen: true };
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    const trusted = await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A);
    await testDb.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1", [r.page.pageId, trusted]);
    await startHost(r);
    await until(async () => r.operator.physical.length >= 1, WAIT_MS, "the page running on its browser");

    await login(r, "wanted");
    await until(async () => r.operator.state.mode === "manual_login", WAIT_MS, "the manual login");
    // The session is the same one throughout (SESSION_A): the digest the
    // engine trusted before the login is the one it would compute after it.
    await login(r, "ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", WAIT_MS, "the login closed");
    const ended = (await getSyncPageManualLogin(db(), r.page.pageId))!.changedAt!;
    // A proof sent before the end, applied late, writes nothing.
    await expect(testDb.pool.query("select identity_checked_at >= $2::timestamptz as fenced from sync_pages where page_id = $1", [r.page.pageId, ended])).resolves.toMatchObject({ rows: [{ fenced: true }] });

    // The first request of the engine after the end is the account's check;
    // the ordinary ones come only once its proof is recorded.
    await until(async () => (await testDb!.pool.query("select 1 from sync_attempts where page_id = $1 and origin = 'engine' and admitted_at > $2 and resource <> 'account.verify'", [r.page.pageId, ended])).rowCount! > 0, WAIT_MS, "ordinary work again");
    const after = (await testDb.pool.query<{ resource: string; admitted_at: Date; completed_at: Date | null }>(
      "select resource, admitted_at, completed_at from sync_attempts where page_id = $1 and origin = 'engine' and admitted_at > $2 order by id", [r.page.pageId, ended],
    )).rows;
    expect(after[0]).toMatchObject({ resource: "account.verify" });
    const firstOrdinary = after.find((attempt) => attempt.resource !== "account.verify")!;
    expect(after[0]!.completed_at).not.toBeNull();
    expect(firstOrdinary.admitted_at.getTime()).toBeGreaterThanOrEqual(after[0]!.completed_at!.getTime());
    // Trusted again: the same digest, by the check sent after the login.
    expect((await testDb.pool.query("select credentials_generation from sync_pages where page_id = $1", [r.page.pageId])).rows[0]).toEqual({ credentials_generation: trusted });
  }, LONG_TEST_MS);
});

describe("after a login: one clock across the protocol (Astra's review of PR 15, round 5)", () => {
  // An identity check sent before the login, its answer held until the login
  // ended, then reported with the result's instant on another clock than the
  // gate's `sent` — Chrome's own timing fixed at 777 s, an hour ahead, an
  // hour behind. The engine takes the gate's `sent`: the check was sent
  // before the login's end, its proof counts for nothing, and the account is
  // checked anew before anything ordinary goes.
  it.for([
    { chrome: "fixed at 777 s", shift: () => 777_126.5 },
    { chrome: "an hour ahead", shift: (gate: number) => gate + 3_600_000 },
    { chrome: "an hour behind", shift: (gate: number) => gate - 3_600_000 },
  ])("an identity answer from before the login, its result's instant $chrome: no trust from it; the account checked anew first", { timeout: LONG_TEST_MS }, async ({ shift }, context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.state = { ...r.operator.state, step: "ready", exitOpen: true };
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    // Not trusted: the engine's first request is the account's check.
    await testDb.pool.query("update sync_pages set credentials_generation = null where page_id = $1", [r.page.pageId]);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding: number | null = null;
    r.operator.beforeResult = async (send) => {
      if (holding !== null || !new URL(send.url).pathname.endsWith("/account/me")) return;
      holding = send.attemptId;
      await held;
    };
    r.operator.resultSentMono = shift;
    await startHost(r);
    await until(async () => holding !== null, WAIT_MS, "the account's check sent, its answer held");
    const stale = holding!;

    // The owner's login, opened and closed while the answer is held.
    await login(r, "wanted");
    await until(async () => r.operator.state.mode === "manual_login", WAIT_MS, "the manual login");
    await login(r, "ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", WAIT_MS, "the login closed");
    const ended = (await getSyncPageManualLogin(db(), r.page.pageId))!.changedAt!;
    release();

    // The held check: journaled as sent when the gate said — before the end.
    await until(async () => (await testDb!.pool.query("select 1 from sync_attempts where id = $1 and outcome <> 'admitted'", [stale])).rowCount === 1, WAIT_MS, "the held check's end journaled");
    const journaled = (await testDb.pool.query<{ sent_at: Date }>("select sent_at from sync_attempts where id = $1", [stale])).rows[0]!;
    expect(journaled.sent_at.getTime()).toBeLessThan(ended.getTime());
    // Its proof fenced: the next request of the engine is the account's
    // check again, and nothing ordinary goes before that one's answer.
    await until(async () => (await testDb!.pool.query("select 1 from sync_attempts where page_id = $1 and origin = 'engine' and id > $2 and resource <> 'account.verify'", [r.page.pageId, stale])).rowCount! > 0, WAIT_MS, "ordinary work again");
    const after = (await testDb.pool.query<{ resource: string; admitted_at: Date; completed_at: Date | null }>(
      "select resource, admitted_at, completed_at from sync_attempts where page_id = $1 and origin = 'engine' and id > $2 order by id", [r.page.pageId, stale],
    )).rows;
    expect(after[0]).toMatchObject({ resource: "account.verify" });
    const firstOrdinary = after.find((attempt) => attempt.resource !== "account.verify")!;
    expect(firstOrdinary.admitted_at.getTime()).toBeGreaterThanOrEqual(after[0]!.completed_at!.getTime());
    // Trusted by the check sent after the login: its send after the end.
    const proof = (await testDb.pool.query<{ identity_checked_at: Date; credentials_generation: string | null }>("select identity_checked_at, credentials_generation from sync_pages where page_id = $1", [r.page.pageId])).rows[0]!;
    expect(proof.credentials_generation).toBe(await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A));
    expect(proof.identity_checked_at.getTime()).toBeGreaterThan(ended.getTime());
  });
});

describe("after a login: an unknown send proves nothing (Astra's review of PR 15, round 6)", () => {
  // The first `sent` lost with its link; the engine connects again; the
  // login opens and closes; then the check's answer from before the login
  // comes with its result's instant on another clock (an operator of the
  // previous image: Chrome's own, an hour ahead — or the gate's). Without
  // a received `sent` the send is unknown: for the pacer, the completion;
  // for the proof's fence, the admission — before the login's end.
  it.for([
    { result: "an hour ahead (Chrome's own clock)", shift: (gate: number) => gate + 3_600_000 },
    { result: "the gate's", shift: (gate: number) => gate },
  ])("a pre-login answer with no `sent` received, its result's instant $result: not trusted from it; the account checked anew first", { timeout: LONG_TEST_MS }, async ({ shift }, context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.state = { ...r.operator.state, step: "ready", exitOpen: true };
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    await testDb.pool.query("update sync_pages set credentials_generation = null where page_id = $1", [r.page.pageId]);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding: number | null = null;
    r.operator.beforeResult = async (send) => {
      if (holding !== null || !new URL(send.url).pathname.endsWith("/account/me")) return;
      holding = send.attemptId;
      await held;
    };
    r.operator.dropSent = 1;
    r.operator.resultSentMono = shift;
    await startHost(r);
    await until(async () => holding !== null, WAIT_MS, "the account's check sent, its `sent` lost, its answer held");
    const stale = holding!;
    // The link goes and comes back: the engine connects again.
    const hellos = r.operator.hellos.length;
    r.operator.server.protocolError("a test drops the link");
    await until(async () => r.operator.hellos.length > hellos, WAIT_MS, "the engine connected again");

    await login(r, "wanted");
    await until(async () => r.operator.state.mode === "manual_login", WAIT_MS, "the manual login");
    await login(r, "ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", WAIT_MS, "the login closed");
    const ended = (await getSyncPageManualLogin(db(), r.page.pageId))!.changedAt!;
    release();

    // The held check: its send unknown (no `sent`), journaled as such.
    await until(async () => (await testDb!.pool.query("select 1 from sync_attempts where id = $1 and outcome <> 'admitted'", [stale])).rowCount === 1, WAIT_MS, "the held check's end journaled");
    const journaled = (await testDb.pool.query<{ send_mark: string | null; admitted_at: Date }>("select send_mark, admitted_at from sync_attempts where id = $1", [stale])).rows[0]!;
    expect(journaled.send_mark).toBe("completion_fallback");
    expect(journaled.admitted_at.getTime()).toBeLessThan(ended.getTime());
    // Its proof fenced: the account's check again first, nothing ordinary
    // before that one's answer, trusted by a check sent after the end.
    await until(async () => (await testDb!.pool.query("select 1 from sync_attempts where page_id = $1 and origin = 'engine' and id > $2 and resource <> 'account.verify'", [r.page.pageId, stale])).rowCount! > 0, WAIT_MS, "ordinary work again");
    const after = (await testDb.pool.query<{ resource: string; admitted_at: Date; completed_at: Date | null }>(
      "select resource, admitted_at, completed_at from sync_attempts where page_id = $1 and origin = 'engine' and id > $2 order by id", [r.page.pageId, stale],
    )).rows;
    expect(after[0]).toMatchObject({ resource: "account.verify" });
    const firstOrdinary = after.find((attempt) => attempt.resource !== "account.verify")!;
    expect(firstOrdinary.admitted_at.getTime()).toBeGreaterThanOrEqual(after[0]!.completed_at!.getTime());
    const proof = (await testDb.pool.query<{ identity_checked_at: Date; credentials_generation: string | null }>("select identity_checked_at, credentials_generation from sync_pages where page_id = $1", [r.page.pageId])).rows[0]!;
    expect(proof.credentials_generation).toBe(await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A));
    expect(proof.identity_checked_at.getTime()).toBeGreaterThan(ended.getTime());
  });
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
    await until(async () => r.operator.commands.some((command) => command.command.kind === "restartBrowser"), WAIT_MS, "the browser started");
    // The owner pauses the page meanwhile: the pause is the owner's now.
    expect(await lever(r, "pause", { all: true })).toMatchObject({ pausedAll: true });
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "wanted", paused: false, pausedAll: true });
    // The login ends (the engine, after the automation is back): the
    // owner's pause stands.
    await login(r, "ending");
    await until(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", WAIT_MS, "the login closed");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ value: "off", paused: false, pausedAll: true });
  }, LONG_TEST_MS);

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
  }, LONG_TEST_MS);
});
