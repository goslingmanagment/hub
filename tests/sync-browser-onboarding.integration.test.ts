import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bindIdentityAttempt,
  findOnboardingProfile,
  registerPageBrowserProfile,
  requestOnboardingIdentity,
  setOnboardingProxy,
  setPageBrowserOnboarding,
  setPageBrowserSettings,
  takeOnboardingLink,
  type Database,
  type FanslySendHolderIdentity,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import type { SiteAdmitResult } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { Pacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import { BrowserOnboardingTask, type BrowserOnboardingOverrides } from "../apps/runtime/src/sync/fansly/browser-onboarding.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { bindProvenProfile } from "./helpers/page-browser-onboarding.ts";
import { FakeOperator, linkSettings, OPERATOR_TOKEN, SESSION_A, SESSION_B } from "./helpers/page-browser-operator.ts";
import { harnessConfig, until } from "./helpers/sync-engine.ts";

// A new page's onboarding through its browser on the engine's side (Project
// Browser plan §3.2 «Подключение новой страницы через браузер», steps 2–3;
// stage 3 PR 16): the onboarding task of a `sync` process and the link it
// takes to a profile no page has, against a fake operator (the operator's own
// RPC server) — the owner's login followed by the profile key, the site's
// requests admitted one at a time under the owner's pause and journaled
// without a page, the account read through the browser with its answer in
// `observations`, the profile's fence, the onboarding given up.

const S = 300;
const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
const RPC_TIMING = { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 };
const TIMING = { everyMs: 100, driveEveryMs: 50, commandWaitMs: 2_000, unreachableEndMs: 1_000, restartEveryMs: 500, lockRetryMs: 200, identityWaitMs: 2_000, resultWaitMs: 5_000, confirmWaitMs: 1_500 };
const ACCOUNT = "300000000000000777";
const HOLDER: FanslySendHolderIdentity = { host: "sync-test", pid: process.pid, pidStart: "1", pidNs: "ns", bootId: "boot", instance: randomUUID(), role: "sync" };

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
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

interface Rig {
  operator: FakeOperator;
  profileId: string;
  config: ReturnType<typeof harnessConfig>;
}

/** A profile as add-profile registers it, its proxy given and its exit IP
 *  pinned as the owner does in the dashboard. Its fake operator confirms an
 *  account read's session as the real one does for a profile no page has
 *  (its state at `ready` with the account, before the read's result) —
 *  unless `confirmReads` is false. */
async function rig(options: { onboarding?: "login" | "open"; confirmReads?: boolean } = {}): Promise<Rig> {
  const operator = await FakeOperator.start({ accountId: ACCOUNT, session: null });
  cleanups.push(() => operator.close());
  operator.startStatePushes(100);
  // The browser stands, as a new profile's operator does until it is started.
  operator.state = { ...operator.state, step: "exit_closed", exitOpen: false, accountId: null };
  const config = harnessConfig(testDb!.connectionString);
  const profileId = randomUUID();
  await registerPageBrowserProfile(db(), {
    profileId,
    container: `page-browser-new-${profileId.slice(0, 6)}`,
    ...sealPageBrowserSecrets(config, { engineToken: OPERATOR_TOKEN, apiToken: "api-token-of-the-onboarding-test", vncPassword: "vnc-password-of-the-onboarding-test" }),
    socksEndpoint: "127.0.0.1:1080",
    env: ENV,
  });
  await setOnboardingProxy(db(), {
    profileId,
    url: "socks5://127.0.0.1:1080",
    encryptedAuth: JSON.stringify(encryptJson({ username: "pb-user", password: "pb-pass" }, config.encryptionKey, config.encryptionKeyVersion)),
    keyVersion: config.encryptionKeyVersion,
  });
  await setPageBrowserSettings(db(), { profileId, pinnedExitIp: "203.0.113.7" });
  if (options.onboarding !== undefined) await moveOnboarding(profileId, options.onboarding);
  const r = { operator, profileId, config };
  if (options.confirmReads !== false) confirmingReads(r);
  return r;
}

/** The operator's confirmation of an account read (PR 15's mechanism, page
 *  0's): before the read's result goes, its state says the session it went
 *  under is confirmed, with the account it named. */
function confirmingReads(r: Rig): void {
  intercept(r, (message) => {
    if (message.type !== "result") return message;
    const send = r.operator.sends.find((sent) => sent.attemptId === message.attemptId);
    const outcome = message.outcome as { kind?: string };
    if (send?.route === "account.me" && outcome.kind === "response") {
      r.operator.pushState({ step: "ready", accountId: ACCOUNT, sessionFingerprint: String(message.sessionFingerprint) });
    }
    return message;
  });
}

async function moveOnboarding(profileId: string, to: "login" | "open" | "closing"): Promise<void> {
  await db().transaction(async (tx) => {
    const result = await setPageBrowserOnboarding(tx as unknown as Database, { profileId, to, by: "owner:1" });
    expect(["changed", "unchanged"]).toContain(result.kind);
  });
}

function startTask(r: Rig, holder: FanslySendHolderIdentity = HOLDER, more: Partial<BrowserOnboardingOverrides> = {}): BrowserOnboardingTask {
  const task = new BrowserOnboardingTask({
    db: db(),
    connectionString: testDb!.connectionString,
    config: r.config,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
    pause: { readSettingMs: async () => S },
    holder,
    overrides: {
      url: () => r.operator.url,
      settings: async () => linkSettings({ pageId: 0, expectedAccountId: "" }),
      rpcTiming: RPC_TIMING,
      timing: TIMING,
      pacerFactory: (deps) => new Pacer({ ...deps, minSettingMs: S }),
      ...more,
    },
  });
  cleanups.push(() => task.stop());
  task.start();
  return task;
}

/** The fake operator in the manual login, logged in by the person. */
async function untilLoginMode(r: Rig): Promise<void> {
  await until(async () => r.operator.commands.some((command) => command.command.kind === "setMode" && "mode" in command.command && command.command.mode === "manual_login"), 10_000, "the manual login");
}

/** The admissions of the site the engine answered, admitted ones. */
function granted(r: Rig): Array<SiteAdmitResult & { admit: true }> {
  return r.operator.siteAnswers.filter((answer): answer is SiteAdmitResult & { admit: true } => answer.admit);
}

/** What the fake operator says to the engine, intercepted: each message
 *  (and body frame) passed on as it is, changed, dropped (null) or held until
 *  `release` (its order kept). */
function intercept(r: Rig, take: (message: Record<string, unknown>) => Record<string, unknown> | null | "hold") {
  const server = r.operator.server as unknown as { send: (message: unknown) => boolean; sendBinary: (frame: Buffer) => boolean };
  const send = server.send.bind(server);
  const sendBinary = server.sendBinary.bind(server);
  const held: Array<() => void> = [];
  let holdingFrames = false;
  server.sendBinary = (frame) => {
    if (holdingFrames) {
      held.push(() => sendBinary(frame));
      return true;
    }
    return sendBinary(frame);
  };
  server.send = (message) => {
    const taken = take(message as Record<string, unknown>);
    if (taken === "hold") {
      held.push(() => send(message));
      return true;
    }
    return taken === null ? true : send(taken);
  };
  return {
    /** Body frames are held from now on too (they go before their result). */
    holdFrames: () => void (holdingFrames = true),
    release: () => {
      holdingFrames = false;
      for (const go of held.splice(0)) go();
    },
  };
}

/** The login opened through the form and closed again, then one identity
 *  request: its id. */
async function loginThenAsk(r: Rig): Promise<string> {
  await untilLoginMode(r);
  await moveOnboarding(r.profileId, "open");
  await until(async () => r.operator.state.mode === "automation", 10_000, "the automation back");
  const requested = await requestOnboardingIdentity(db(), { profileId: r.profileId, source: "onboarding" });
  if (requested.kind !== "requested") throw new Error("not requested");
  return requested.requestId;
}

async function answerOf(r: Rig, requestId: string) {
  await until(async () => (await findOnboardingProfile(db(), r.profileId))!.identityResult?.requestId === requestId, 10_000, "the identity answered");
  return (await findOnboardingProfile(db(), r.profileId))!.identityResult!;
}

async function journal(profileId: string) {
  return (await testDb!.pool.query<{ page_id: string | null; source: string; operation: string; browser_attempt_id: string; setting_ms: number; sent_at: Date | null; completed_at: Date | null; outcome: string | null; http_status: number | null }>(
    "select page_id, source, operation, browser_attempt_id, setting_ms, sent_at, completed_at, outcome, http_status from fansly_send_log where browser_profile_id = $1 order by id",
    [profileId],
  )).rows;
}

describe("a new page's onboarding through its browser, the engine's side (plan §3.2; PR 16)", () => {
  it("follows the owner's login by the profile key: page 0 and no expected account in its hello, the manual login, the browser started", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    startTask(r);
    await until(async () => r.operator.hellos.length >= 1, 10_000, "the hello");
    expect(r.operator.hellos[0]).toMatchObject({ pageId: 0, expectedAccountId: "", ownerGeneration: 1 });
    await untilLoginMode(r);
    await until(async () => r.operator.commands.some((command) => command.command.kind === "restartBrowser"), 10_000, "the start");
    expect((await findOnboardingProfile(db(), r.profileId))!.linkGeneration).toBe(1n);
    // The operator's word recorded on the profile's row.
    await until(async () => (await findOnboardingProfile(db(), r.profileId))!.step === "site_loaded", 5_000, "the state recorded");
  });

  it("admits the login's requests one at a time under the owner's pause, journaled without a page; refuses the rest of the site and its socket", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    startTask(r);
    await untilLoginMode(r);
    await until(async () => r.operator.state.mode === "manual_login" && r.operator.state.exitOpen, 10_000, "up in the manual login");
    // The login screen's read, then the login and the code, asked at once.
    const reads = r.operator.siteAdmit({ path: "/api/v1/versioning", route: "site.other" });
    const login = r.operator.siteAdmit({ method: "POST", path: "/api/v1/login", route: "auth.login", operation: "login" });
    const write = r.operator.siteAdmit({ method: "POST", path: "/api/v1/message", route: "site.other" });
    const socket = r.operator.wsAdmit();
    await until(async () => r.operator.siteAnswers.some((answer) => answer.siteRequestId === write.siteRequestId), 5_000, "the write refused");
    expect(r.operator.siteAnswers.find((answer) => answer.siteRequestId === write.siteRequestId)).toMatchObject({ admit: false, reason: "mode" });
    await until(async () => r.operator.wsAnswers.length === 1, 5_000, "the socket refused");
    expect(r.operator.wsAnswers[0]).toMatchObject({ connectionId: socket.connectionId, admit: false });
    // One in flight: the second waits for the first's end.
    await until(async () => granted(r).length === 1, 5_000, "the first admission");
    await sleep(3 * S);
    expect(granted(r)).toHaveLength(1);
    const first = granted(r)[0]!;
    expect(first.siteRequestId).toBe(reads.siteRequestId);
    const firstSent = Date.now();
    r.operator.siteDone(first, { status: 200 });
    await until(async () => granted(r).length === 2, 5_000, "the second admission");
    const second = granted(r)[1]!;
    expect(second.siteRequestId).toBe(login.siteRequestId);
    // The pause: S × (1 + u) at least after the first one's send.
    expect(Date.now() - firstSent).toBeGreaterThanOrEqual(S - 20);
    r.operator.siteDone(second, { status: 200 });
    await until(async () => (await journal(r.profileId)).filter((row) => row.completed_at !== null).length === 2, 5_000, "both journaled");
    const rows = await journal(r.profileId);
    expect(rows.map((row) => [row.page_id, row.source, row.operation, row.outcome, row.http_status])).toEqual([
      [null, "onboarding", "site:site.other", "response", 200],
      [null, "onboarding", "login:auth.login", "response", 200],
    ]);
    expect(rows.every((row) => row.setting_ms === S && row.sent_at !== null)).toBe(true);
    expect(rows.map((row) => Number(row.browser_attempt_id))).toEqual([first.attemptId, second.attemptId]);
    // Both ends acknowledged once committed.
    await until(async () => r.operator.acks.includes(first.attemptId) && r.operator.acks.includes(second.attemptId), 5_000, "the ends acknowledged");
    // No login operation outside the manual login.
    expect(r.operator.siteAnswers.filter((answer) => answer.admit).length).toBe(2);
  });

  it("reads the account through the browser once the login is closed: one GET /account/me, journaled without a page, its answer in observations with the profile's identity", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    r.operator.setSession(SESSION_A);
    startTask(r);
    await untilLoginMode(r);
    await moveOnboarding(r.profileId, "open");
    await until(async () => r.operator.state.mode === "automation", 10_000, "the automation back");
    const requested = await requestOnboardingIdentity(db(), { profileId: r.profileId, source: "credentials_verify" });
    expect(requested.kind).toBe("requested");
    const requestId = requested.kind === "requested" ? requested.requestId : "";
    await until(async () => (await findOnboardingProfile(db(), r.profileId))!.identityResult?.requestId === requestId, 10_000, "the identity answered");
    const profile = (await findOnboardingProfile(db(), r.profileId))!;
    expect(profile.identityResult).toMatchObject({ requestId, ok: true, accountId: ACCOUNT, username: "harness", sessionFingerprint: SESSION_A });
    // One Hub request, of account.me, under the live session.
    expect(r.operator.sends).toHaveLength(1);
    expect(r.operator.sends[0]).toMatchObject({ route: "account.me", method: "GET", kind: "api", sessionFingerprint: SESSION_A, ownerGeneration: 1 });
    expect(new URL(r.operator.sends[0]!.url).pathname).toMatch(/\/account\/me$/);
    expect(r.operator.physical).toHaveLength(1);
    // Journaled without a page, under the request's source.
    const rows = await journal(r.profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ page_id: null, source: "credentials_verify", operation: "account_me", outcome: "response", http_status: 200 });
    // Its answer in observations: no page, the account as its native ref.
    const observation = (await testDb.pool.query<{ id: string; source: string; producer: string; kind: string; account_id: string | null; native_account_ref: string | null; payload: { account?: { id?: string } } }>(
      "select id::text, source, producer, kind, account_id, native_account_ref, payload from observations where producer = 'fansly-onboarding:account.me'",
    )).rows;
    expect(observation).toHaveLength(1);
    expect(observation[0]).toMatchObject({ source: "pull", account_id: null, native_account_ref: ACCOUNT });
    expect(observation[0]!.payload.account?.id).toBe(ACCOUNT);
    expect(profile.identityResult?.ok === true && profile.identityResult.observationId).toBe(Number(observation[0]!.id));
    // The operator's copy acknowledged after the commit.
    await until(async () => r.operator.acks.includes(r.operator.sends[0]!.attemptId), 5_000, "the result acknowledged");
  });

  it("answers an identity request the browser cannot serve with why, and none while the login is open", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    startTask(r);
    await untilLoginMode(r);
    // The login open: the API's request is refused before it is written.
    expect(await requestOnboardingIdentity(db(), { profileId: r.profileId, source: "onboarding" })).toMatchObject({ kind: "refused", why: "not_open", state: "login" });
    await moveOnboarding(r.profileId, "open");
    await until(async () => r.operator.state.mode === "automation", 10_000, "the automation back");
    // No live session: the browser was never logged in.
    const requested = await requestOnboardingIdentity(db(), { profileId: r.profileId, source: "onboarding" });
    const requestId = requested.kind === "requested" ? requested.requestId : "";
    await until(async () => (await findOnboardingProfile(db(), r.profileId))!.identityResult?.requestId === requestId, 10_000, "answered");
    expect((await findOnboardingProfile(db(), r.profileId))!.identityResult).toMatchObject({ ok: false, error: "the browser knows no live session: log it in first" });
    expect(r.operator.sends).toHaveLength(0);
  });

  it("starts a browser that stopped on another exit IP again only once the owner pinned the IP again", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    // The browser's own check named another IP: it stands for the owner's decision.
    r.operator.state = { ...r.operator.state, step: "exit_closed", exitOpen: false, stopReason: "exit_ip_changed" };
    startTask(r);
    await untilLoginMode(r);
    await sleep(1_500);
    // Never started again by itself, whatever the restart's cadence.
    expect(r.operator.commands.filter((command) => command.command.kind === "restartBrowser")).toHaveLength(0);
    // The owner pins (again): the browser starts and checks it.
    await setPageBrowserSettings(db(), { profileId: r.profileId, pinnedExitIp: "203.0.113.8" });
    await until(async () => r.operator.commands.some((command) => command.command.kind === "restartBrowser"), 5_000, "the start after the pin");
    expect(r.operator.commands.filter((command) => command.command.kind === "restartBrowser")).toHaveLength(1);
  });

  it("gives the onboarding up: the browser stopped, the automation back, then off — the profile stays, unbound", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    startTask(r);
    await untilLoginMode(r);
    await until(async () => r.operator.state.mode === "manual_login" && r.operator.state.exitOpen, 10_000, "up in the manual login");
    await moveOnboarding(r.profileId, "closing");
    await until(async () => (await findOnboardingProfile(db(), r.profileId))!.onboarding === "off", 10_000, "given up");
    const kinds = r.operator.commands.map((command) => command.command.kind === "setMode" ? `setMode:${command.command.mode}` : command.command.kind);
    expect(kinds.indexOf("stopPage")).toBeGreaterThan(kinds.indexOf("setMode:manual_login"));
    expect(kinds.lastIndexOf("setMode:automation")).toBeGreaterThan(kinds.indexOf("stopPage"));
    expect(r.operator.state).toMatchObject({ step: "exit_closed", stopReason: "owner_stop", mode: "automation" });
    const profile = (await findOnboardingProfile(db(), r.profileId))!;
    expect(profile).toMatchObject({ pageId: null, onboarding: "off", onboardingChangedBy: "engine" });
  });

  it("is fenced by the profile's link generation: once bound (or taken again) the link writes nothing and closes", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    const task = startTask(r);
    await untilLoginMode(r);
    expect(task.links.has(r.profileId)).toBe(true);
    // Another take (an earlier process's link loses the profile).
    expect(await takeOnboardingLink(db(), r.profileId)).toBe(2n);
    await until(async () => !task.links.has(r.profileId) || task.links.get(r.profileId)!.generation === 3n, 10_000, "the stale link closed");
    // Bound: the link closes, and no command goes for the binding.
    const page = await testDb.pool.query<{ id: string }>("insert into models (slug, name) values ('m-onb', 'M') returning id");
    const created = await testDb.pool.query<{ id: string }>("insert into pages (model_id, platform, label) values ($1, 'fansly', 'onb-bound') returning id", [page.rows[0]!.id]);
    const pageId = Number(created.rows[0]!.id);
    await moveOnboarding(r.profileId, "open");
    const commandsBefore = r.operator.commands.length;
    expect(await bindProvenProfile(db(), { profileId: r.profileId, pageId })).toBe(true);
    await until(async () => !task.links.has(r.profileId), 10_000, "the link closed once bound");
    const bound = (await findOnboardingProfile(db(), r.profileId))!;
    expect(bound).toMatchObject({ pageId, onboarding: "off", proxy: null });
    await sleep(300);
    // At most the automation's own setMode that was under way when bound.
    expect(r.operator.commands.slice(commandsBefore).filter((command) => command.command.kind !== "setMode")).toEqual([]);
  });

  it("journals the site's answers by the profile, with the buffer's position the page's intake goes on from", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    r.operator.setSession(SESSION_A);
    r.operator.siteResponse({ route: "site.other", path: "/api/v1/versioning", body: '{"success":true,"response":{"version":"1"}}' });
    r.operator.siteResponse({ route: "auth.login", path: "/api/v1/login", method: "POST", body: '{"success":true,"response":{"token":"secret-of-the-login"}}' });
    startTask(r);
    await until(async () => (await testDb!.pool.query("select 1 from page_browsers where profile_id = $1 and events_acked_seq = 2", [r.profileId])).rows.length === 1, 10_000, "the position");
    const rows = (await testDb.pool.query<{ source: string; kind: string; account_id: string | null; payload: unknown }>(
      "select source, kind, account_id, payload from observations where source = 'browser_site' order by id",
    )).rows;
    // The login's answer is never written (its secrets); the read is.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "browser_site", account_id: null });
    expect(JSON.stringify(rows)).not.toContain("secret-of-the-login");
    await until(async () => r.operator.eventAcks.some((ack) => ack.uptoSeq === 2), 5_000, "acknowledged");
  });
});

describe("the account read through the browser proves it only when fresh (Astra's review of PR 16, item 1)", () => {
  it("names no account when the operator never said when the read left: no `sent`, the result's own instant or none", async (context) => {
    if (!testDb) return context.skip();
    // No `sent` and no instant in the result (an operator that cannot tell).
    const r = await rig({ onboarding: "login" });
    r.operator.setSession(SESSION_A);
    r.operator.reportSend = false;
    startTask(r);
    const first = await answerOf(r, await loginThenAsk(r));
    expect(first).toMatchObject({ ok: false, error: expect.stringContaining("did not say when the account's read left it") });
    expect(r.operator.physical).toHaveLength(1);
    // Its answer is journaled all the same (capture before parse), and the
    // send counted at its completion.
    expect((await journal(r.profileId)).at(-1)).toMatchObject({ operation: "account_me", outcome: "response" });
    // The `sent` lost on the way, the result carrying the instant: unknown too.
    r.operator.reportSend = true;
    intercept(r, (message) => (message.type === "sent" ? null : message));
    const requested = await requestOnboardingIdentity(db(), { profileId: r.profileId, source: "credentials_verify" });
    const second = await answerOf(r, requested.kind === "requested" ? requested.requestId : "");
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining("did not say when the account's read left it") });
    expect(r.operator.physical).toHaveLength(2);
  });

  it("names no account when its `sent` puts it before the automation came back for the login (an operator on another clock)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    r.operator.setSession(SESSION_A);
    // Its `sent` an hour behind the gate's own instant.
    intercept(r, (message) => (message.type === "sent" ? { ...message, sentMono: Number(message.sentMono) - 3_600_000 } : message));
    startTask(r);
    const answer = await answerOf(r, await loginThenAsk(r));
    expect(answer).toMatchObject({ ok: false, error: expect.stringContaining("read before the browser's login closed") });
  });

  it("names nothing when its answer comes after the owner opened the login again: the read was of before — its request is void", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    r.operator.setSession(SESSION_A);
    // The read's answer held on its way to the engine (its `sent` goes).
    let holding = true;
    const held = intercept(r, (message) => (holding && message.type === "result" ? "hold" : message));
    held.holdFrames();
    startTask(r);
    await loginThenAsk(r);
    await until(async () => r.operator.physical.length === 1, 10_000, "the read sent");
    // The owner opens the login again; a person logs the browser into
    // another account; the login closed again.
    await moveOnboarding(r.profileId, "login");
    await until(async () => r.operator.state.mode === "manual_login", 10_000, "the manual login again");
    r.operator.setSession(SESSION_B);
    await moveOnboarding(r.profileId, "open");
    await until(async () => r.operator.state.mode === "automation", 10_000, "the automation back again");
    holding = false;
    held.release();
    await until(async () => r.operator.acks.includes(r.operator.sends[0]!.attemptId), 10_000, "the held answer taken");
    const profile = (await findOnboardingProfile(db(), r.profileId))!;
    // Not the account of before the new login: the request is void.
    expect(profile.identityRequest).toBeNull();
    expect(profile.identityResult).toBeNull();
    expect(profile.onboardingGeneration).toBeGreaterThanOrEqual(3n);
  });

  it("names no account the operator did not confirm: a read under the session of before the login, the site showing another one after it (Astra's review of PR 16, round 2)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login", confirmReads: false });
    r.operator.setSession(SESSION_A);
    // The read goes under A's headers; the site then shows session B — the
    // operator confirms nothing of A's read.
    startTask(r);
    const requestId = await loginThenAsk(r);
    await until(async () => r.operator.physical.length === 1, 10_000, "the read sent");
    r.operator.setSession(SESSION_B);
    const answer = await answerOf(r, requestId);
    expect(answer).toMatchObject({ ok: false, error: expect.stringContaining("did not confirm the session") });
    // Its answer is journaled all the same (capture before parse).
    expect((await testDb.pool.query("select 1 from observations where producer = 'fansly-onboarding:account.me'")).rows).toHaveLength(1);
  });

  it("waits for the operator's confirmation of a read that went before the site showed that same session", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login", confirmReads: false });
    r.operator.setSession(SESSION_A);
    startTask(r);
    const requestId = await loginThenAsk(r);
    await until(async () => r.operator.acks.length >= 1 || r.operator.held.size >= 1, 10_000, "the read answered");
    await sleep(300);
    // The new document shows A: the operator confirms the read.
    r.operator.pushState({ step: "ready", accountId: ACCOUNT, sessionFingerprint: SESSION_A });
    expect(await answerOf(r, requestId)).toMatchObject({ ok: true, accountId: ACCOUNT, sessionFingerprint: SESSION_A });
  });

  it("opened without a login (a profile logged in before): asks the operator for the automation all the same, and reads the account after its answer", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.setSession(SESSION_A);
    await moveOnboarding(r.profileId, "open");
    startTask(r);
    const requested = await requestOnboardingIdentity(db(), { profileId: r.profileId, source: "credentials_verify" });
    const answer = await answerOf(r, requested.kind === "requested" ? requested.requestId : "");
    expect(answer).toMatchObject({ ok: true, accountId: ACCOUNT });
    // The operator never left the automation; its answer is the boundary.
    expect(r.operator.commands.some((command) => command.command.kind === "setMode" && "mode" in command.command && command.command.mode === "manual_login")).toBe(false);
    expect(r.operator.commands.some((command) => command.command.kind === "setMode" && "mode" in command.command && command.command.mode === "automation")).toBe(true);
  });

  it("reads the account once a request, even when a look read the profile before the answer was written", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    r.operator.setSession(SESSION_A);
    let requestId = "";
    let stalled = 0;
    startTask(r, HOLDER, {
      // account.me's own budget would hold a second read back past the test.
      routeTimeScale: 0.01,
      afterProfileRead: async (profile) => {
        if (stalled > 0 || requestId === "" || profile?.identityRequest?.id !== requestId || profile.identityResult?.requestId === requestId || r.operator.physical.length !== 1) return;
        stalled += 1;
        // The read went; this look keeps its profile from before the
        // answer until the answer is written and the check is over.
        await until(async () => (await findOnboardingProfile(db(), r.profileId))!.identityResult?.requestId === requestId, 10_000, "answered");
        await sleep(200);
      },
    });
    // The read's answer comes a little later: looks run meanwhile.
    let holding = true;
    const held = intercept(r, (message) => (holding && message.type === "result" ? "hold" : message));
    held.holdFrames();
    requestId = await loginThenAsk(r);
    await until(async () => r.operator.physical.length === 1, 10_000, "the read sent");
    await until(async () => stalled === 1, 10_000, "a look with the profile of before the answer");
    holding = false;
    held.release();
    expect(await answerOf(r, requestId)).toMatchObject({ ok: true });
    await sleep(1_500);
    expect(r.operator.physical).toHaveLength(1);
  });

  it("never reads an identity request again once its read was granted, the link taken over meanwhile: answered as not known, a new request reads anew (Astra's review of PR 16, round 6)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    r.operator.setSession(SESSION_A);
    // The first read's answer held on its way.
    let holding = true;
    const held = intercept(r, (message) => (holding && message.type === "result" ? "hold" : message));
    held.holdFrames();
    const task = startTask(r);
    const first = await loginThenAsk(r);
    await until(async () => r.operator.physical.length === 1, 10_000, "the read sent");
    const bound = (await findOnboardingProfile(db(), r.profileId))!.identityAttemptId;
    expect(bound).toBe(r.operator.sends[0]!.attemptId);
    // The link taken over (another take of the profile): a new link finds the
    // request bound to the read that went, unanswered.
    const before = task.links.get(r.profileId)!.generation;
    await takeOnboardingLink(db(), r.profileId);
    await until(async () => (task.links.get(r.profileId)?.generation ?? 0n) > before + 1n, 10_000, "a new link");
    expect(await answerOf(r, first)).toMatchObject({ ok: false, indeterminate: true, attemptId: bound, error: expect.stringContaining("not known") });
    holding = false;
    held.release();
    await sleep(500);
    // One physical read of that request.
    expect(r.operator.physical).toHaveLength(1);
    // A new request reads anew, once.
    const requested = await requestOnboardingIdentity(db(), { profileId: r.profileId, source: "credentials_verify" });
    const second = requested.kind === "requested" ? requested.requestId : "";
    expect(await answerOf(r, second)).toMatchObject({ ok: true, accountId: ACCOUNT });
    expect(r.operator.physical).toHaveLength(2);
  });

  it("proves the account with the operator's own `sent` after the login closed, in the generation that holds", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    r.operator.setSession(SESSION_A);
    startTask(r);
    const answer = await answerOf(r, await loginThenAsk(r));
    const profile = (await findOnboardingProfile(db(), r.profileId))!;
    expect(answer).toMatchObject({ ok: true, accountId: ACCOUNT, onboardingGeneration: profile.onboardingGeneration.toString() });
    // The automation was asked for after the owner closed the login: its
    // answer is the boundary the read went after.
    const kinds = r.operator.commands.map((command) => command.command.kind === "setMode" ? `setMode:${command.command.mode}` : command.command.kind);
    expect(kinds.lastIndexOf("setMode:automation")).toBeGreaterThan(kinds.indexOf("setMode:manual_login"));
  });
});

describe("an account read's grant leaves under the profile's lock (Astra's review of PR 16, round 2)", () => {
  it("an abandon committed while the grant is decided waits for it — never a grant after a committed abandon", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    r.operator.setSession(SESSION_A);
    let abandon: Promise<unknown> | null = null;
    let committedBeforeGrant: boolean | null = null;
    startTask(r, HOLDER, {
      beforeCheckAnswer: async () => {
        let committed = false;
        abandon = moveOnboarding(r.profileId, "closing").then(() => (committed = true));
        // Until the abandon committed, or waits for the profile's lock.
        await until(async () => committed || (await testDb!.pool.query(
          "select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%from page_browsers%for no key update%' and pid <> pg_backend_pid()",
        )).rows.length > 0, 5_000, "the abandon committed or waiting");
        committedBeforeGrant = committed;
      },
    });
    await loginThenAsk(r);
    await until(async () => abandon !== null, 10_000, "the account read's check");
    await abandon;
    // The grant went before the abandon could commit.
    expect(committedBeforeGrant).toBe(false);
    expect(r.operator.checkResults.filter((result) => result.admit)).toHaveLength(1);
    // The read under it names nothing: the abandon voided the request.
    await until(async () => r.operator.acks.length >= 1, 10_000, "the read's answer taken");
    expect((await findOnboardingProfile(db(), r.profileId))!.identityResult).toBeNull();
  });
});

describe("the site's requests pass only while the owner's login is open (Astra's review of PR 16, item 3)", () => {
  it("refuses a request still waiting for its slot once the owner closed the login — no grant", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    startTask(r);
    await untilLoginMode(r);
    await until(async () => r.operator.state.mode === "manual_login" && r.operator.state.exitOpen, 10_000, "up in the manual login");
    r.operator.siteAdmit({ path: "/api/v1/versioning", route: "site.other" });
    await until(async () => granted(r).length === 1, 5_000, "the first admission");
    r.operator.siteDone(granted(r)[0]!, { status: 200 });
    // The next one waits for the owner's pause; meanwhile he closes the
    // login (the link stays: the onboarding is open).
    const waiting = r.operator.siteAdmit({ method: "POST", path: "/api/v1/login", route: "auth.login", operation: "login" });
    await moveOnboarding(r.profileId, "open");
    await until(async () => r.operator.siteAnswers.some((answer) => answer.siteRequestId === waiting.siteRequestId), 5_000, "the waiting one answered");
    expect(r.operator.siteAnswers.find((answer) => answer.siteRequestId === waiting.siteRequestId)).toMatchObject({ admit: false, reason: "mode" });
    expect(granted(r)).toHaveLength(1);
    expect((await journal(r.profileId)).map((row) => row.operation)).toEqual(["site:site.other"]);
  });

  it("refuses the grant when a move commits between the request's journal entry and its grant: no site request goes for an onboarding given up", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    let movedAt: string | null = null;
    startTask(r, HOLDER, {
      beforeGrant: async (siteRequestId) => {
        movedAt = siteRequestId;
        await moveOnboarding(r.profileId, "closing");
      },
    });
    await untilLoginMode(r);
    await until(async () => r.operator.state.mode === "manual_login" && r.operator.state.exitOpen, 10_000, "up in the manual login");
    const asked = r.operator.siteAdmit({ method: "POST", path: "/api/v1/login", route: "auth.login", operation: "login" });
    await until(async () => r.operator.siteAnswers.some((answer) => answer.siteRequestId === asked.siteRequestId), 5_000, "answered");
    expect(movedAt).toBe(asked.siteRequestId);
    expect(r.operator.siteAnswers.find((answer) => answer.siteRequestId === asked.siteRequestId)).toMatchObject({ admit: false, reason: "mode" });
    // Journaled before the move, closed as never sent.
    await until(async () => (await journal(r.profileId)).every((row) => row.completed_at !== null), 5_000, "closed");
    expect((await journal(r.profileId)).map((row) => [row.operation, row.outcome, row.sent_at])).toEqual([["login:auth.login", "aborted_before_send", null]]);
  });
});

describe("the site's requests keep the route and family budgets a page's keep, across a restart (Astra's review of PR 16, item 4)", () => {
  /** The next grant: the instant it was seen (polled every 25 ms: never early). */
  async function nextGrant(r: Rig, count: number): Promise<{ answer: SiteAdmitResult & { admit: true }; at: number }> {
    await until(async () => granted(r).length >= count, 15_000, `admission ${count}`);
    return { answer: granted(r)[count - 1]!, at: Date.now() };
  }

  async function upInTheLogin(r: Rig): Promise<void> {
    await untilLoginMode(r);
    await until(async () => r.operator.state.mode === "manual_login" && r.operator.state.exitOpen, 10_000, "up in the manual login");
  }

  it("admits the site's reads outside the catalogue no sooner than site.other's interval apart (15/min), not the owner's pause alone", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    // The budgets × 0.25: site.other 1 000 ms (its family's 750 ms); the pause 300–360 ms.
    startTask(r, HOLDER, { routeTimeScale: 0.25 });
    await upInTheLogin(r);
    for (let i = 0; i < 3; i++) r.operator.siteAdmit({ path: `/api/v1/notice/${i}`, route: "site.other" });
    const gaps: number[] = [];
    let done = 0;
    for (let n = 1; n <= 3; n++) {
      const next = await nextGrant(r, n);
      if (n > 1) gaps.push(next.at - done);
      done = Date.now();
      r.operator.siteDone(next.answer, { status: 200 });
    }
    expect(gaps).toHaveLength(2);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1_000 - 5);
  });

  it("reads the account no sooner than account.me's interval after its previous read", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    r.operator.setSession(SESSION_A);
    // × 0.25: account.me 1 000 ms apart; the pause 300–360 ms.
    startTask(r, HOLDER, { routeTimeScale: 0.25 });
    await answerOf(r, await loginThenAsk(r));
    const requested = await requestOnboardingIdentity(db(), { profileId: r.profileId, source: "credentials_verify" });
    await answerOf(r, requested.kind === "requested" ? requested.requestId : "");
    expect(r.operator.physical).toHaveLength(2);
    expect(r.operator.physical[1]!.sentMono - r.operator.physical[0]!.sentMono).toBeGreaterThanOrEqual(1_000 - 5);
  });

  it("holds a new link (a restart) to the interval and to a 429's hold its journal shows", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    // The production budgets: site.other 4 000 ms apart. A new link's own
    // floor is 1.2 × the owner's minimum pause (2 000 ms): 2 400 ms.
    const first = startTask(r);
    await upInTheLogin(r);
    r.operator.siteAdmit({ path: "/api/v1/notice/1", route: "site.other" });
    const sent = await nextGrant(r, 1);
    const sentAt = Date.now();
    r.operator.siteDone(sent.answer, { status: 200 });
    await until(async () => (await journal(r.profileId)).every((row) => row.completed_at !== null), 5_000, "journaled");
    // A restart: the next link's first site.other waits out the interval.
    await first.stop();
    const second = startTask(r);
    await until(async () => r.operator.hellos.length >= 2, 10_000, "the second link's hello");
    r.operator.siteAdmit({ path: "/api/v1/notice/2", route: "site.other" });
    const again = await nextGrant(r, 2);
    expect(again.at - sentAt).toBeGreaterThanOrEqual(4_000 - 5);
    // A 429 with its Retry-After (6 s): recorded with the send, and a link
    // after a restart is held by it.
    const limitedAt = Date.now();
    r.operator.siteDone(again.answer, { status: 429, retryAfter: "6" });
    await until(async () => (await journal(r.profileId)).every((row) => row.completed_at !== null), 5_000, "journaled");
    expect((await testDb.pool.query<{ outcome_detail: string | null }>("select outcome_detail from fansly_send_log where browser_profile_id = $1 order by id desc limit 1", [r.profileId])).rows[0]!.outcome_detail).toBe("route_hold_ms=6000");
    await second.stop();
    startTask(r);
    await until(async () => r.operator.hellos.length >= 3, 10_000, "the third link's hello");
    r.operator.siteAdmit({ path: "/api/v1/notice/3", route: "site.other" });
    const held = await nextGrant(r, 3);
    expect(held.at - limitedAt).toBeGreaterThanOrEqual(6_000 - 5);
  }, 60_000);
});

describe("the hour's ceiling of the site's requests counts what may have gone, across a restart (Astra's review of PR 16, item 5)", () => {
  it("refuses the 301st request of the hour when the 300th went and its process died before its outcome was written", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "login" });
    // 299 sends of the hour answered, the 300th admitted and never completed.
    await testDb.pool.query(
      `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance, captured_at,
                                    sent_at, completed_at, outcome, browser_profile_id, browser_attempt_id)
       select null, gen_random_uuid(), 'onboarding', 'site:site.other', 'h', 1, 'sync', gen_random_uuid(),
              clock_timestamp() - interval '50 minutes' + n * interval '1 second', clock_timestamp() - interval '50 minutes' + n * interval '1 second',
              clock_timestamp() - interval '50 minutes' + n * interval '1 second', 'response', $1, n
         from generate_series(1, 299) as n`,
      [r.profileId],
    );
    await testDb.pool.query(
      `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance, captured_at, browser_profile_id, browser_attempt_id)
       values (null, gen_random_uuid(), 'onboarding', 'login:auth.login', 'h', 1, 'sync', gen_random_uuid(), clock_timestamp() - interval '30 minutes', $1, 300)`,
      [r.profileId],
    );
    startTask(r);
    await untilLoginMode(r);
    await until(async () => r.operator.state.mode === "manual_login" && r.operator.state.exitOpen, 10_000, "up in the manual login");
    // The new link closed the 300th as unknown: it still counts.
    expect((await journal(r.profileId)).at(-1)).toMatchObject({ outcome: "transport_error", sent_at: null });
    const asked = r.operator.siteAdmit({ path: "/api/v1/versioning", route: "site.other" });
    await until(async () => r.operator.siteAnswers.some((answer) => answer.siteRequestId === asked.siteRequestId), 10_000, "answered");
    expect(r.operator.siteAnswers.find((answer) => answer.siteRequestId === asked.siteRequestId)).toMatchObject({ admit: false, reason: "site_hour_cap" });
    expect(await journal(r.profileId)).toHaveLength(300);
  });
});

describe("an identity request's answer that loses its link ends the link, never the process (Astra's review of PR 16, round 7)", () => {
  /** Unhandled rejections while `body` runs (one would end a `sync` process). */
  async function noUnhandled(body: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => void seen.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await body();
      await sleep(300);
    } finally {
      process.off("unhandledRejection", listener);
    }
    return seen;
  }

  it("a request bound to an earlier link's read, the link taken over between the look and its answer: no unhandled rejection, a new link answers it as not known", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ onboarding: "open" });
    r.operator.setSession(SESSION_A);
    // An earlier link's read granted for the request, never answered.
    const requested = await requestOnboardingIdentity(db(), { profileId: r.profileId, source: "onboarding" });
    const requestId = requested.kind === "requested" ? requested.requestId : "";
    await db().transaction((tx) => bindIdentityAttempt(tx as unknown as Database, { profileId: r.profileId, requestId, attemptId: 999_001 }));
    let taken = 0;
    const seen = await noUnhandled(async () => {
      const task: BrowserOnboardingTask = startTask(r, HOLDER, {
        afterProfileRead: async (profile) => {
          // The look (of a link up at its operator) read the request bound
          // and unanswered; the link is taken over before its answer is
          // written.
          const link = task.links.get(r.profileId);
          if (taken > 0 || link?.client.up !== true || link.client.quiesced === null || link.client.state === null) return;
          // Past the look that asked for the automation (the login's boundary).
          if (!r.operator.commands.some((command) => command.command.kind === "setMode" && "mode" in command.command && command.command.mode === "automation")) return;
          if (profile?.identityAttemptId !== 999_001 || profile.identityResult !== null) return;
          taken += 1;
          await takeOnboardingLink(db(), r.profileId);
        },
      });
      expect(await answerOf(r, requestId)).toMatchObject({ ok: false, indeterminate: true, attemptId: 999_001 });
      expect(taken).toBe(1);
      expect(task.links.get(r.profileId)?.generation ?? 0n).toBeGreaterThanOrEqual(3n);
    });
    expect(seen).toEqual([]);
  });

  it("a refusal written for a request the browser cannot serve, the link taken over meanwhile: no unhandled rejection", async (context) => {
    if (!testDb) return context.skip();
    // No live session: the request is answered with why, after the wait.
    const r = await rig({ onboarding: "open" });
    let taken = 0;
    let requestId = "";
    const seen = await noUnhandled(async () => {
      const task: BrowserOnboardingTask = startTask(r, HOLDER, {
        afterProfileRead: async (profile) => {
          const link = task.links.get(r.profileId);
          if (taken > 0 || link?.client.up !== true || link.client.quiesced === null || link.client.state === null) return;
          if (requestId === "" || profile?.identityRequest?.id !== requestId) return;
          if (Date.now() - profile.identityRequest.requestedAt.getTime() < TIMING.identityWaitMs) return;
          taken += 1;
          await takeOnboardingLink(db(), r.profileId);
        },
      });
      const requested = await requestOnboardingIdentity(db(), { profileId: r.profileId, source: "onboarding" });
      requestId = requested.kind === "requested" ? requested.requestId : "";
      expect(await answerOf(r, requestId)).toMatchObject({ ok: false });
      expect(taken).toBe(1);
    });
    expect(seen).toEqual([]);
  });
});
