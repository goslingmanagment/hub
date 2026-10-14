import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bindOnboardedProfile,
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
import { BrowserOnboardingTask } from "../apps/runtime/src/sync/fansly/browser-onboarding.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOperator, linkSettings, OPERATOR_TOKEN, SESSION_A } from "./helpers/page-browser-operator.ts";
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
const TIMING = { everyMs: 100, driveEveryMs: 50, commandWaitMs: 2_000, unreachableEndMs: 1_000, restartEveryMs: 500, lockRetryMs: 200, identityWaitMs: 2_000, resultWaitMs: 5_000 };
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
 *  pinned as the owner does in the dashboard. */
async function rig(options: { onboarding?: "login" | "open" } = {}): Promise<Rig> {
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
  return { operator, profileId, config };
}

async function moveOnboarding(profileId: string, to: "login" | "open" | "closing"): Promise<void> {
  await db().transaction(async (tx) => {
    const result = await setPageBrowserOnboarding(tx as unknown as Database, { profileId, to, by: "owner:1" });
    expect(["changed", "unchanged"]).toContain(result.kind);
  });
}

function startTask(r: Rig, holder: FanslySendHolderIdentity = HOLDER): BrowserOnboardingTask {
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
    await db().transaction(async (tx) => {
      expect(await bindOnboardedProfile(tx as unknown as Database, { profileId: r.profileId, pageId })).toBe(true);
    });
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
