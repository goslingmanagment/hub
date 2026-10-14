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
// exists after the person's login (Astra's review of PR 16, round 2). Until
// the new document's own authorized GET, the Hub requests' headers may still
// be the session of before the login.

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
  lines: string[];
}

async function setUp(): Promise<SetUp> {
  const temp = tempDir();
  cleanups.push(temp.remove);
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const chrome = new FakeChrome();
  await chrome.boot();
  await chrome.shutdown();
  cleanups.push(() => chrome.shutdown());
  const model = new BrowserModel(chrome);
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
    exitIpTarget: { host: "api.ipify.org", port: 443, path: "/", wrap: (socket: Socket) => socket },
    loginTimings: { settleMs: 3000, pollMs: 20 },
    timings: { replayWaitMs: 2000, chromeUpMs: 5000, attachMs: 3000, envCheckMs: 3000, stateEveryMs: 200, healthEveryMs: 100, healthAnswerMs: 300, selfTestProbeMs: 2000, exitIpTimeoutMs: 2000, quitWaitMs: 1000 },
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
  return { operator, engine, model, lines };
}

let commandN = 0;
function command(engine: FakeEngine, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  const commandId = `onb-${++commandN}`;
  engine.send({ type: "command", ownerGeneration: 1, commandId, notAfterMono: monoMs() + 10_000, command });
  return engine.waitFor("commandResult", (message) => message.commandId === commandId, 15_000);
}

/** The site's own authorized read, as its script sets its headers. */
function siteRead(s: SetUp, token: string): void {
  const path = "/api/v1/account/me";
  s.model.pause(`https://apiv3.fansly.com${path}?ngsw-bypass=true`, "GET", s.operator.control.workTab!.sessionId, "XHR", {
    Accept: "application/json, text/plain, */*",
    authorization: token,
    "fansly-client-check": fanslyClientCheck(path, CLIENT),
    "fansly-client-id": CLIENT,
    "fansly-client-ts": String(Date.now()),
    "fansly-session-id": "720167541418230033",
  });
}

let readN = 9700;
/** The engine's account read under `fingerprint`, answered with `account`. */
async function accountRead(s: SetUp, fingerprint: string, account: string): Promise<void> {
  s.model.hubBody = Buffer.from(JSON.stringify({ success: true, response: { account: { id: account } } }));
  const attemptId = ++readN;
  s.engine.send({ type: "send", ownerGeneration: 1, attemptId, route: "account.me", credentialsGeneration: "c".repeat(64), sessionFingerprint: fingerprint, method: "GET", url: "https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true", headers: {}, kind: "api", maxBodyBytes: 32 * 1024 * 1024, sendDeadlineMono: monoMs() + 15_000, requestDeadlineMono: monoMs() + 20_000 });
  expect((await s.engine.waitFor("result", (message) => message.attemptId === attemptId, 10_000)).outcome).toMatchObject({ kind: "response", status: 200 });
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
    siteRead(s, TOKEN_B);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === b);
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
    siteRead(s, TOKEN_A);
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
});
