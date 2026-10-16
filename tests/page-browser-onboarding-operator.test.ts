import { join } from "node:path";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { fanslyClientCheck, sessionFingerprint } from "../apps/page-browser/src/hub-requests/session.ts";
import { Operator } from "../apps/page-browser/src/operator/operator.ts";
import { forgetSecrets } from "../apps/page-browser/src/shared/secrets.ts";
import { monoMs, setLogSink } from "../apps/page-browser/src/shared/util.ts";
import {
  BrowserModel,
  FakeChrome,
  FakeChromeControl,
  FakeEngine,
  fakeIpify,
  FakeSocks,
  hello,
  HolderUnderS6,
  RPC_TOKEN,
  SOCKS_PASSWORD,
  SOCKS_USER,
  tempDir,
  tlsLikeServer,
  until,
  writeExtensionPackage,
  writeNetSelftest,
} from "./helpers/page-browser-fakes.ts";

// A new page's browser, its profile no page has yet (page 0: its onboarding,
// Project Browser PR 16), in the operator: the engine's account read names
// whatever account the browser is logged into, so the operator confirms the
// session it went under — PR 15's mechanism, «ready only after a fresh
// identity read under the live session» — only once the site showed that
// session in a document loaded after the mode last changed: the session that
// exists after the person's login (Astra's review of PR 16, rounds 2–3).
// Until the new document's own authorized GET, the Hub requests' headers may
// still be the session of before the login; a late GET of the replaced
// document still carries it. The document is Chrome's loader: the one named
// in answer to the navigation started after the change.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setLogSink(null);
  forgetSecrets();
});

const CLIENT = "720167541418239002";
const ACCOUNT_A = "300000000000000111";
const ACCOUNT_B = "300000000000000222";
const TOKEN_A = "fansly-token-BeFoReLoGiN0123456789";
const TOKEN_B = "fansly-token-AfTeRlOgIn9876543210";

interface SetUp {
  operator: Operator;
  engine: FakeEngine;
  model: BrowserModel;
  chrome: FakeChrome;
  lines: string[];
  /** The loader of each document committed, as Chrome named it. */
  loaders: string[];
  /** Runs before each navigation goes on (a test holds it, or acts there). */
  beforeNavigate: (() => Promise<void>) | null;
  /** Runs once a navigation's document committed, before its answer goes
   *  (what the test sends there reaches the operator before the answer). */
  afterNavigate: ((loaderId: string) => void) | null;
}

async function setUp(options: { sessionShowWaitMs?: number } = {}): Promise<SetUp> {
  const temp = tempDir();
  cleanups.push(temp.remove);
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const chrome = new FakeChrome();
  await chrome.boot();
  await chrome.shutdown();
  cleanups.push(() => chrome.close());
  const model = new BrowserModel(chrome);
  const navigate = chrome.handlers.get("Page.navigate")!;
  const s: Partial<SetUp> & { loaders: string[]; beforeNavigate: SetUp["beforeNavigate"]; afterNavigate: SetUp["afterNavigate"] } = { loaders: [], beforeNavigate: null, afterNavigate: null };
  chrome.handlers.set("Page.navigate", async (command) => {
    if (s.beforeNavigate !== null) await s.beforeNavigate();
    const reply = (await navigate(command)) as { loaderId?: unknown; errorText?: unknown };
    if (typeof reply.loaderId === "string" && typeof reply.errorText !== "string" && command.params.url !== "about:blank") {
      s.loaders.push(reply.loaderId);
      s.afterNavigate?.(reply.loaderId);
    }
    return reply as Record<string, unknown>;
  });
  const holder = new HolderUnderS6(join(temp.dir, "holder.sock"), chrome);
  await holder.start();
  cleanups.push(() => holder.stop());
  const socks = new FakeSocks(SOCKS_USER, SOCKS_PASSWORD);
  await socks.start();
  cleanups.push(() => socks.stop());
  const ipify = await fakeIpify(() => "203.0.113.7");
  cleanups.push(ipify.close);
  socks.routes.set("api.ipify.org:443", ipify.port);
  const server = await tlsLikeServer();
  cleanups.push(server.close);
  socks.routes.set("apiv3.fansly.com:443", server.port);
  const control = new FakeChromeControl(chrome);
  const chromeEnv = join(temp.dir, "chrome-env");
  control.onStart = () => model.chromeStarts(chromeEnv);
  const netSelftest = join(temp.dir, "net-selftest.json");
  writeNetSelftest(netSelftest);
  const extensionDir = join(temp.dir, "extension");
  writeExtensionPackage(extensionDir);
  const operator = new Operator({
    config: {
      holderSock: holder.socketPath,
      proxyHost: "127.0.0.1",
      proxyPort: 0,
      rpcHost: "127.0.0.1",
      rpcPort: 0,
      rpcToken: RPC_TOKEN,
      apiToken: "api-token-0123456789abcdef0123456789abcdef",
      netSelftestPath: netSelftest,
      chromeEnvPath: chromeEnv,
      logDir: join(temp.dir, "logs"),
      stateDir: join(temp.dir, "state"),
      bufferDir: join(temp.dir, "buffer"),
      extensionDir,
      heartbeatPath: join(temp.dir, "alive"),
      operatorVersion: "test",
    },
    chrome: control,
      display: async () => control.geometry,
    exitIpTarget: { host: "api.ipify.org", port: 443, path: "/", wrap: (socket: Socket) => socket },
    loginTimings: { settleMs: 3000, pollMs: 20 },
    timings: { replayWaitMs: 2000, chromeUpMs: 5000, attachMs: 3000, envCheckMs: 3000, stateEveryMs: 200, healthEveryMs: 100, healthAnswerMs: 300, selfTestProbeMs: 2000, exitIpTimeoutMs: 2000, quitWaitMs: 1000, reloadWaitMs: 300, ...(options.sessionShowWaitMs === undefined ? {} : { sessionShowWaitMs: options.sessionShowWaitMs }) },
  });
  const ports = await operator.start();
  cleanups.push(() => operator.stop());
  model.proxyPort = ports.proxyPort;
  await until(() => operator.cdp.linked, 3000, "the holder link");
  const engine = new FakeEngine();
  await engine.connect(ports.rpcPort);
  cleanups.push(() => engine.close());
  // The onboarding's link: page 0, no account expected.
  engine.send(hello({ pageId: 0, expectedAccountId: "", socks5: { ip: "127.0.0.1", port: socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
  await engine.waitFor("helloResult");
  // The engine admits every site request and every check.
  let attempt = 8000;
  engine.onMessage = (message) => {
    if (message.type === "siteAdmit") engine.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: message.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: ++attempt });
    if (message.type === "check") engine.send({ type: "checkResult", ownerGeneration: 1, attemptId: message.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
  };
  expect(await command(engine, { kind: "restartBrowser" })).toMatchObject({ ok: true });
  await until(() => operator.page.step === "site_loaded", 10_000, "the site loaded");
  return Object.assign(s, { operator, engine, model, chrome, lines }) as SetUp;
}

let commandN = 0;
function command(engine: FakeEngine, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  const commandId = `onb-${++commandN}`;
  engine.send({ type: "command", ownerGeneration: 1, commandId, notAfterMono: monoMs() + 10_000, command });
  return engine.waitFor("commandResult", (message) => message.commandId === commandId, 15_000);
}

/** The site's own read of the new document, under `token`, ended (its
 *  admission, its send and its answer) before anything else goes. */
async function siteReadDone(s: SetUp, token: string): Promise<void> {
  const ended = s.engine.of("siteDone").length;
  siteRead(s, token);
  await until(() => s.engine.of("siteDone").length > ended, 10_000, "the site's read ended");
}

/** The site's own authorized read, as its script sets its headers — of the
 *  document `loaderId` (default: the one committed last; null: Chrome never
 *  names it), in the top frame or `frameId`. */
function siteRead(s: SetUp, token: string, loaderId: string | null = s.loaders.at(-1)!, frameId?: string): ReturnType<BrowserModel["pause"]> {
  const path = "/api/v1/account/me";
  return s.model.pause(`https://apiv3.fansly.com${path}?ngsw-bypass=true`, "GET", s.operator.control.workTab!.sessionId, "XHR", {
    Accept: "application/json, text/plain, */*",
    authorization: token,
    "fansly-client-check": fanslyClientCheck(path, CLIENT),
    "fansly-client-id": CLIENT,
    "fansly-client-ts": String(Date.now()),
    "fansly-session-id": "720167541418230033",
  }, undefined, loaderId ?? undefined, frameId);
}

/** The site's GET under `token` from the document committed last, then
 *  the engine's read under it: confirmed (ready, with `account`) — the two
 *  done again from the newest document if the site was loaded anew
 *  meanwhile (its API requests failed before the engine admitted any: the
 *  operator loads it once more, and only that document's GET counts). */
async function confirmedUnder(s: SetUp, token: string, fingerprint: string, account: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    await until(() => s.operator.page.step === "site_loaded" || s.operator.page.step === "ready", 10_000, "the site loaded");
    await siteReadDone(s, token);
    expect(s.operator.state.sessionFingerprint).toBe(fingerprint);
    await accountRead(s, fingerprint, account);
    try {
      await until(() => s.operator.page.step === "ready", tries < 2 ? 3_000 : 10_000, "confirmed");
      expect(s.operator.state).toMatchObject({ sessionFingerprint: fingerprint, accountId: account });
      return;
    } catch (error) {
      if (tries >= 2) throw error;
    }
  }
}

let readN = 9700;
/** The engine's account read under `fingerprint`, answered with `account` —
 *  asked again when it did not go at all (the page's one request in flight
 *  still the site's last, the gate busy with it), as the engine asks again. */
async function accountRead(s: SetUp, fingerprint: string, account: string): Promise<void> {
  s.model.hubBody = Buffer.from(JSON.stringify({ success: true, response: { account: { id: account } } }));
  for (let tries = 0; ; tries++) {
    const attemptId = ++readN;
    s.engine.send({ type: "send", ownerGeneration: 1, attemptId, route: "account.me", credentialsGeneration: "c".repeat(64), sessionFingerprint: fingerprint, method: "GET", url: "https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true", headers: {}, kind: "api", maxBodyBytes: 32 * 1024 * 1024, sendDeadlineMono: monoMs() + 15_000, requestDeadlineMono: monoMs() + 20_000 });
    const outcome = (await s.engine.waitFor("result", (message) => message.attemptId === attemptId, 10_000)).outcome as { kind: string; sent?: boolean; refusal?: string };
    if (((outcome.kind === "transport_error" && outcome.sent === false) || outcome.kind === "aborted_before_send") && tries < 3) {
      await pause(200);
      continue;
    }
    expect(outcome).toMatchObject({ kind: "response", status: 200 });
    return;
  }
}

/** The owner's login through the form, the operator in the manual login and
 *  back in the automation, the site loaded anew. */
async function loginAndBack(s: SetUp): Promise<void> {
  expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
  await until(() => s.operator.page.step === "site_loaded", 10_000, "the login screen loaded");
  const loads = s.model.navigations.length;
  expect(await command(s.engine, { kind: "setMode", mode: "automation" })).toMatchObject({ ok: true });
  await until(() => s.model.navigations.length > loads && s.operator.page.step === "site_loaded", 10_000, "the site loaded anew under the automation");
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a profile no page has yet: its account read confirms only the session that exists after the login (PR 16, Astra's round 2)", () => {
  it("never on the session of before the login its headers still carry; once the site shows the new one, a read under it is confirmed — whatever account it names", async () => {
    const s = await setUp();
    const a = sessionFingerprint(TOKEN_A, CLIENT);
    const b = sessionFingerprint(TOKEN_B, CLIENT);
    siteRead(s, TOKEN_A);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === a);
    await s.engine.waitFor("siteDone", () => true, 10_000);
    // A person logs the browser into account B; the automation is back, the
    // site loaded anew — and it has made no authorized request yet: the Hub
    // request's headers are still A's.
    await loginAndBack(s);
    expect(s.operator.state.sessionFingerprint).toBe(a);
    await accountRead(s, a, ACCOUNT_A);
    await pause(300);
    expect(s.operator.page.step).toBe("site_loaded");
    // The new document's own read shows B: A's read confirms nothing.
    await siteReadDone(s, TOKEN_B);
    expect(s.operator.state.sessionFingerprint).toBe(b);
    await pause(300);
    expect(s.operator.page.step).toBe("site_loaded");
    // A read under B: confirmed, with the account it names (no account is
    // expected of a profile no page has).
    await accountRead(s, b, ACCOUNT_B);
    await until(() => s.operator.page.step === "ready", 10_000, "confirmed");
    expect(s.operator.state).toMatchObject({ sessionFingerprint: b, accountId: ACCOUNT_B });
  });

  it("a read that went before the site showed its session again is confirmed once the new document shows that same session", async () => {
    const s = await setUp();
    const a = sessionFingerprint(TOKEN_A, CLIENT);
    siteRead(s, TOKEN_A);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === a);
    await s.engine.waitFor("siteDone", () => true, 10_000);
    // The person logged in to the same account (the session unchanged).
    await loginAndBack(s);
    await accountRead(s, a, ACCOUNT_A);
    await pause(300);
    expect(s.operator.page.step).toBe("site_loaded");
    await siteReadDone(s, TOKEN_A);
    await until(() => s.operator.page.step === "ready", 10_000, "confirmed once shown");
    expect(s.operator.state).toMatchObject({ sessionFingerprint: a, accountId: ACCOUNT_A });
  });

  it("with no mode change in its life, a read under the live session is confirmed at once", async () => {
    const s = await setUp();
    const a = sessionFingerprint(TOKEN_A, CLIENT);
    siteRead(s, TOKEN_A);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === a);
    await s.engine.waitFor("siteDone", () => true, 10_000);
    await accountRead(s, a, ACCOUNT_A);
    await until(() => s.operator.page.step === "ready", 10_000, "confirmed");
    expect(s.operator.state.accountId).toBe(ACCOUNT_A);
  });

  it("a late GET of the replaced document — between the navigation and its commit, under the session of before — confirms nothing; the new document's GET does (Astra's review of PR 16, round 3)", async () => {
    const s = await setUp();
    const a = sessionFingerprint(TOKEN_A, CLIENT);
    const b = sessionFingerprint(TOKEN_B, CLIENT);
    siteRead(s, TOKEN_A);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === a);
    await s.engine.waitFor("siteDone", () => true, 10_000);
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded", 10_000, "the login screen loaded");
    // The person logs into B. The automation's load starts — and before its
    // document commits, the old document's late GET still carries A.
    const old = s.loaders.at(-1)!;
    let late = false;
    s.beforeNavigate = async () => {
      s.beforeNavigate = null;
      siteRead(s, TOKEN_A, old);
      late = true;
      await pause(100);
    };
    const loads = s.model.navigations.length;
    expect(await command(s.engine, { kind: "setMode", mode: "automation" })).toMatchObject({ ok: true });
    await until(() => late && s.model.navigations.length > loads && s.operator.page.step === "site_loaded", 10_000, "the site loaded anew under the automation");
    expect(s.loaders.at(-1)).not.toBe(old);
    // Later still, after the new document committed: another of the old one's.
    siteRead(s, TOKEN_A, old);
    await pause(200);
    // The Hub request's headers are A's: a read under them confirms nothing.
    await accountRead(s, a, ACCOUNT_A);
    await pause(300);
    expect(s.operator.page.step).toBe("site_loaded");
    expect(s.operator.state.accountId === ACCOUNT_A && atLeastConfirmed(s)).toBe(false);
    // The new document's GET shows B; a read under B is confirmed.
    await confirmedUnder(s, TOKEN_B, b, ACCOUNT_B);
  });

  it("a late GET of the old document cannot restore its fansly-session-id after the new document's GET without one", async () => {
    const s = await setUp();
    const fingerprint = sessionFingerprint(TOKEN_A, CLIENT);
    await siteReadDone(s, TOKEN_A);
    const old = s.loaders.at(-1)!;
    await loginAndBack(s);
    expect(s.loaders.at(-1)).not.toBe(old);
    const ended = s.engine.of("siteDone").length;
    const path = "/api/v1/account/me";
    s.model.pause(`https://apiv3.fansly.com${path}?ngsw-bypass=true`, "GET", s.operator.control.workTab!.sessionId, "XHR", {
      Accept: "application/json, text/plain, */*",
      authorization: TOKEN_A,
      "fansly-client-check": fanslyClientCheck(path, CLIENT),
      "fansly-client-id": CLIENT,
      "fansly-client-ts": String(Date.now()),
    }, undefined, s.loaders.at(-1)!);
    await until(() => s.engine.of("siteDone").length > ended, 10_000, "the new document's GET without a socket session ended");
    // Same token and client id: the fingerprint cannot detect the old
    // document overwriting the new template with its socket session id.
    const late = siteRead(s, TOKEN_A, old);
    await until(() => late.outcome === "failed", 10_000, "the old document's late GET was failed");
    const issued = s.model.hubRequests.length;
    await accountRead(s, fingerprint, ACCOUNT_A);
    expect(s.model.hubRequests).toHaveLength(issued + 1);
    expect(s.model.hubRequests[issued]!.headers.map(([name]) => name.toLowerCase())).not.toContain("fansly-session-id");
  });

  it("the login closed while a load is under way: once it is in, the site is loaded anew for the automation, and its GET confirms (Astra's review of PR 16, round 3)", async () => {
    const s = await setUp();
    const b = sessionFingerprint(TOKEN_B, CLIENT);
    siteRead(s, TOKEN_A);
    await s.engine.waitFor("siteDone", () => true, 10_000);
    // The manual login's own load is held under way …
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = false;
    s.beforeNavigate = async () => {
      s.beforeNavigate = null;
      holding = true;
      await held;
    };
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    await until(() => holding, 10_000, "the manual login's load under way");
    // … when the login is closed: the automation finds no loaded page to reload.
    expect(await command(s.engine, { kind: "setMode", mode: "automation" })).toMatchObject({ ok: true });
    const loads = s.model.navigations.length;
    release();
    // That load comes in, and the site is loaded anew for the automation.
    await until(() => s.model.navigations.length > loads && s.loaders.length >= 3 && s.operator.page.step === "site_loaded", 10_000, "loaded anew for the automation");
    await confirmedUnder(s, TOKEN_B, b, ACCOUNT_B);
  });

  it("the login closed while a request of the site is in flight longer than the reload's wait: the load anew waits it out, and comes (Astra's review of PR 16, round 3)", async () => {
    const s = await setUp();
    const b = sessionFingerprint(TOKEN_B, CLIENT);
    await siteReadDone(s, TOKEN_A);
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded", 10_000, "the login screen loaded");
    // An interface read of the login, released and held in flight.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const continueRequest = s.chrome.handlers.get("Fetch.continueRequest")!;
    let heldId = "";
    s.chrome.handlers.set("Fetch.continueRequest", async (cmd) => {
      if (cmd.params.requestId === heldId) await gate;
      return continueRequest(cmd);
    });
    heldId = siteRead(s, TOKEN_A).interceptionId;
    await until(() => s.operator.site.released > 0, 10_000, "the read in flight");
    const loads = s.model.navigations.length;
    expect(await command(s.engine, { kind: "setMode", mode: "automation" })).toMatchObject({ ok: true });
    // Longer than the reload's wait (300 ms): no load yet …
    await pause(900);
    expect(s.model.navigations.length).toBe(loads);
    // … and once the read ends, the load anew comes.
    release();
    await until(() => s.model.navigations.length > loads && s.operator.page.step === "site_loaded", 10_000, "loaded anew for the automation");
    await confirmedUnder(s, TOKEN_B, b, ACCOUNT_B);
  });

  it("the new document's GET that comes before the operator took its navigation's answer still confirms (one batch of Chrome's messages; Astra's review of PR 16, round 4)", async () => {
    const s = await setUp();
    const b = sessionFingerprint(TOKEN_B, CLIENT);
    await siteReadDone(s, TOKEN_A);
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded", 10_000, "the login screen loaded");
    // The automation's load: its document commits, and its GET under B goes
    // out before the answer to the navigation — the only GET of the site.
    let sent = 0;
    s.afterNavigate = (loaderId) => {
      s.afterNavigate = null;
      siteRead(s, TOKEN_B, loaderId);
      sent += 1;
    };
    const ended = s.engine.of("siteDone").length;
    expect(await command(s.engine, { kind: "setMode", mode: "automation" })).toMatchObject({ ok: true });
    await until(() => sent === 1 && s.operator.page.step === "site_loaded" && s.engine.of("siteDone").length > ended, 10_000, "the new document and its GET");
    expect(s.operator.state.sessionFingerprint).toBe(b);
    await accountRead(s, b, ACCOUNT_B);
    await until(() => s.operator.page.step === "ready", 10_000, "confirmed");
    expect(s.operator.state.accountId).toBe(ACCOUNT_B);
  });

  it("the GETs of eight child frames' documents between the new document's GET and its navigation's answer do not lose it: a child frame's document is never the mode's (Astra's review of PR 16, round 5)", async () => {
    const s = await setUp();
    const b = sessionFingerprint(TOKEN_B, CLIENT);
    await siteReadDone(s, TOKEN_A);
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded", 10_000, "the login screen loaded");
    const tab = s.operator.control.workTab!.sessionId;
    let sent = 0;
    s.afterNavigate = (loaderId) => {
      // The new document's GET, then eight child frames' documents' GETs —
      // all before the answer to the navigation. (A document loaded anew
      // later — the child frames' requests failed — reads as it loads.)
      siteRead(s, TOKEN_B, loaderId);
      if (sent > 0) return;
      for (let i = 1; i <= 8; i++) siteRead(s, TOKEN_B, `L-child-${i}`, `F-${tab}-child-${i}`);
      sent = 9;
    };
    expect(await command(s.engine, { kind: "setMode", mode: "automation" })).toMatchObject({ ok: true });
    await until(() => sent === 9 && s.operator.page.step === "site_loaded" && s.engine.of("siteDone").length >= 10, 10_000, "the new document and the GETs");
    await accountRead(s, b, ACCOUNT_B);
    await until(() => s.operator.page.step === "ready", 10_000, "confirmed");
    expect(s.operator.state.accountId).toBe(ACCOUNT_B);
  });

  it("a mode's document whose session the operator never saw: the next identity read past the wait loads the site anew, once, and the new document's GET confirms (Astra's review of PR 16, round 5)", async () => {
    const s = await setUp({ sessionShowWaitMs: 300 });
    const b = sessionFingerprint(TOKEN_B, CLIENT);
    await siteReadDone(s, TOKEN_A);
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded", 10_000, "the login screen loaded");
    // The automation's document makes its GET under B, but Chrome never
    // names its document: the operator never sees its session.
    s.afterNavigate = () => {
      s.afterNavigate = null;
      siteRead(s, TOKEN_B, null);
    };
    const loads = s.model.navigations.length;
    expect(await command(s.engine, { kind: "setMode", mode: "automation" })).toMatchObject({ ok: true });
    await until(() => s.model.navigations.length > loads && s.operator.page.step === "site_loaded" && s.operator.state.sessionFingerprint === b, 10_000, "the new document");
    await pause(500);
    // The next document reads with its session as it loads.
    s.afterNavigate = (loaderId) => {
      s.afterNavigate = null;
      siteRead(s, TOKEN_B, loaderId);
    };
    const before = s.model.navigations.length;
    await accountRead(s, b, ACCOUNT_B);
    // Loaded anew, once, and confirmed by that document's GET.
    await until(() => s.operator.page.step === "ready", 10_000, "confirmed");
    expect(s.model.navigations.length).toBe(before + 1);
    expect(s.operator.state.accountId).toBe(ACCOUNT_B);
  });
});

function atLeastConfirmed(s: SetUp): boolean {
  return s.operator.page.step === "session_confirmed" || s.operator.page.step === "ready";
}
