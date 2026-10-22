import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { CdpError, type CdpPort, type EventHandler } from "../apps/page-browser/src/cdp/client.ts";
import { fanslyClientTs } from "../apps/page-browser/src/hub-requests/client-ts.ts";
import { fanslyClientCheck, sessionFingerprint } from "../apps/page-browser/src/hub-requests/session.ts";
import { LoginDesk } from "../apps/page-browser/src/login/desk.ts";
import { FOCUSED, HIT, locateExpression, PROBE, SCREEN_VERSION, type FormMarks, type PageMarks } from "../apps/page-browser/src/login/screens.ts";
import { loadConfig } from "../apps/page-browser/src/operator/config.ts";
import { Operator } from "../apps/page-browser/src/operator/operator.ts";
import { HaltStore } from "../apps/page-browser/src/state/halt-store.ts";
import { parseLoginRequest } from "../apps/page-browser/src/rpc/protocol.ts";
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
import { FakeLoginSite } from "./helpers/page-browser-login-site.ts";

// The login form in the operator (Project Browser plan §4.8, §4.13; spec
// §6.1 `login.*`, §7; stage 3 PR 15): the API's calls on the RPC endpoint
// with their own token, the manual login switched by the engine's `setMode`
// of the current owner generation only, the screens recognized from the
// isolated world, the owner's input typed as a person types (DOM.focus,
// Input.insertText, a press at the button's centre), the site's own login
// requests under the engine's admission — and what was typed nowhere but in
// the browser: no log line, no journal, no file of the buffer.

const cleanups: Array<() => Promise<void> | void> = [];

/** Hang guards, not speed checks: one awaited event — a fake Chrome's start
 *  and self-test among them — on a loaded CI machine (the owner's PC took
 *  over 10 s for a start), and a test of several. */
const WAIT_MS = 30_000;
const LONG_TEST_MS = 120_000;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setLogSink(null);
  forgetSecrets();
});

/** Markers: what the owner "types". Nothing else is a credential here. */
const LOGIN_MARKER = "pb15-login-marker-4d1e";
const PASSWORD_MARKER = "pb15-password-marker-9b7c2a";
const CODE_MARKER = "731948";
const API_TOKEN = "api-token-fedcba9876543210fedcba9876543210";
const SITE_TOKEN = "fansly-token-AfTeRlOgIn0123456789";
const SITE_CLIENT = "720167541418239001";

const form = (marks: Partial<FormMarks>): FormMarks => ({ password: 0, login: 0, code: 0, other: 0, submit: 1, error: null, newDevice: false, ...marks });
const page = (forms: FormMarks[], extra: Partial<PageMarks> = {}): PageMarks => ({ origin: "https://fansly.com", path: "/", readyState: "complete", captcha: false, outside: false, forms, ...extra });

describe("the screens (spec §7; signs fansly-login/2)", () => {
  it("the probe and the locator read no value of a field", () => {
    for (const source of [PROBE, locateExpression("password"), locateExpression("submit")]) {
      expect(source).not.toMatch(/\.value\b/);
      expect(source).not.toMatch(/selectionStart|selectionEnd|getSelection/);
    }
  });
});

describe("the API's token in the container (operator/config.ts)", () => {
  it("is its own: read when there, absent as none, never short, never the engine's", () => {
    const temp = tempDir();
    cleanups.push(temp.remove);
    const rpc = join(temp.dir, "rpc_token");
    const api = join(temp.dir, "api_token");
    writeFileSync(rpc, `${RPC_TOKEN}\n`);
    const env = { PB_RPC_TOKEN_FILE: rpc, PB_API_TOKEN_FILE: api };
    expect(loadConfig(env).apiToken).toBeNull();
    writeFileSync(api, `${API_TOKEN}\n`);
    expect(loadConfig(env).apiToken).toBe(API_TOKEN);
    writeFileSync(api, "short");
    expect(() => loadConfig(env)).toThrow(/shorter/);
    writeFileSync(api, RPC_TOKEN);
    expect(() => loadConfig(env)).toThrow(/each must be its own/);
  });
});

describe("the calls (spec §6.1 `login.*`)", () => {
  it("are read strictly, and an error names the field, never what was typed", () => {
    const base = { callId: "c-1", token: API_TOKEN };
    expect(parseLoginRequest({ ...base, type: "login.submit", login: LOGIN_MARKER, password: PASSWORD_MARKER })).toEqual({ ok: true, request: { ...base, type: "login.submit", login: LOGIN_MARKER, password: PASSWORD_MARKER } });
    for (const bad of [
      { ...base, type: "login.submit", login: LOGIN_MARKER, password: `${PASSWORD_MARKER}\n` },
      { ...base, type: "login.submit", login: LOGIN_MARKER, password: PASSWORD_MARKER.repeat(100) },
      { ...base, type: "login.submit", login: "", password: PASSWORD_MARKER },
      { ...base, type: "login.code", code: `${CODE_MARKER}${"9".repeat(40)}` },
      { ...base, type: "login.submit", login: LOGIN_MARKER },
      { ...base, callId: "bad id!", type: "login.state" },
      { ...base, type: "login.other" },
    ]) {
      const parsed = parseLoginRequest(bad);
      expect(parsed.ok).toBe(false);
      const error = parsed.ok ? "" : parsed.error;
      expect(error).not.toContain(PASSWORD_MARKER);
      expect(error).not.toContain(LOGIN_MARKER);
      expect(error).not.toContain(CODE_MARKER);
    }
  });
});

// ── the desk alone, on an in-process Chrome ─────────────────────────────────

class DeskChrome implements CdpPort {
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  screen: "landing" | "login" | "code" | "other" | "none" = "login";
  hit = true;
  /** The field focused is the one the desk focused. */
  focused = true;
  /** The isolated world of the document now (a new document, a new one). */
  world = 7;
  /** What the page does when a command reaches it (before it answers). */
  react: ((method: string, params: Record<string, unknown>) => void) | null = null;
  /** The documents the desk had discarded, and why. */
  readonly discarded: string[] = [];
  /** A command Chrome does not answer well. */
  fail: ((method: string, params: Record<string, unknown>) => boolean) | null = null;
  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.commands.push({ method, params });
    this.react?.(method, params);
    if (this.fail?.(method, params) === true) return Promise.reject(new CdpError(method, -32000, "no answer"));
    const value = ((): unknown => {
      switch (method) {
        case "Runtime.evaluate": {
          const expression = String(params.expression);
          if (expression.includes("pbLoginProbe")) {
            if (this.screen === "landing") return { result: { value: page([], { landing: { roots: 1, login: 1, windows: 0 } }) } };
            if (this.screen === "login") return { result: { value: page([form({ password: 1, login: 1 })]) } };
            if (this.screen === "code") return { result: { value: page([form({ code: 1 })]) } };
            if (this.screen === "none") return { result: { value: page([]) } };
            return { result: { value: page([form({ password: 1, login: 1, other: 1 })]) } };
          }
          return { result: { objectId: `o-${this.commands.length}` } };
        }
        case "DOM.getBoxModel":
          return { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } };
        case "Runtime.callFunctionOn": {
          const declaration = String(params.functionDeclaration);
          if (declaration === HIT) return { result: { value: this.hit } };
          if (declaration === FOCUSED) return { result: { value: this.focused } };
          return { result: { value: true } };
        }
        default:
          return {};
      }
    })();
    return Promise.resolve(value as T);
  }
  on(_method: string, _handler: EventHandler): void {}
  ack(): void {}
  holdAcks(): void {}
  of(method: string) {
    return this.commands.filter((command) => command.method === method);
  }
}

/** The operator's discard of the work tab's document, as the fake sees it. */
function discarding(chrome: DeskChrome): (why: string) => Promise<void> {
  return (why) => {
    chrome.discarded.push(why);
    return Promise.resolve();
  };
}

function desk(chrome: DeskChrome): LoginDesk {
  return new LoginDesk({ cdp: chrome, tab: () => "S1", world: () => Promise.resolve(chrome.world), session: () => null, discard: discarding(chrome), timings: { settleMs: 50, pollMs: 10 }, log: () => undefined });
}

/** A call that may act throughout. */
const acting = () => null;

describe("the desk (plan §4.8: input as a person's)", () => {
  it("presses nothing on a screen that is not the form's, or when something lies over the button", async () => {
    const other = new DeskChrome();
    other.screen = "other";
    expect(await desk(other).submit(LOGIN_MARKER, PASSWORD_MARKER, acting)).toEqual({ kind: "refused", reason: "screen_changed" });
    expect(other.of("Input.insertText")).toHaveLength(0);
    expect(other.of("Input.dispatchMouseEvent")).toHaveLength(0);
    const code = new DeskChrome();
    expect(await desk(code).code(CODE_MARKER, acting)).toEqual({ kind: "refused", reason: "screen_changed" });
    const covered = new DeskChrome();
    covered.hit = false;
    expect(await desk(covered).submit(LOGIN_MARKER, PASSWORD_MARKER, acting)).toEqual({ kind: "refused", reason: "screen_changed" });
    expect(covered.of("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("the text goes in only into the field it was meant for, focused, on the same screen and document", async () => {
    const changes: Array<{ what: string; on: (method: string, params: Record<string, unknown>, chrome: DeskChrome) => boolean; change: (chrome: DeskChrome) => void }> = [
      { what: "the focus taken away", on: (method, _params, chrome) => method === "DOM.focus" && chrome.of("DOM.focus").length === 2, change: (chrome) => (chrome.focused = false) },
      { what: "another screen once focused", on: (method, _params, chrome) => method === "DOM.focus" && chrome.of("DOM.focus").length === 2, change: (chrome) => (chrome.screen = "code") },
      { what: "a new document once selected", on: (method, params, chrome) => method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("select()") && chrome.of("Input.insertText").length === 1, change: (chrome) => (chrome.world = 9) },
    ];
    for (const { what, on, change } of changes) {
      const chrome = new DeskChrome();
      chrome.react = (method, params) => {
        if (on(method, params, chrome)) change(chrome);
      };
      expect(await desk(chrome).submit(LOGIN_MARKER, PASSWORD_MARKER, acting), what).toEqual({ kind: "refused", reason: "screen_changed" });
      // The login went in; the password never.
      expect(chrome.of("Input.insertText").map((command) => command.params.text), what).toEqual([LOGIN_MARKER]);
      expect(chrome.of("Input.dispatchMouseEvent"), what).toHaveLength(0);
    }
    // The check runs right before each text: the focus asked of the field itself.
    const chrome = new DeskChrome();
    await desk(chrome).submit(LOGIN_MARKER, PASSWORD_MARKER, acting);
    const order = chrome.commands.map((command) => command.method === "Runtime.callFunctionOn" && String(command.params.functionDeclaration).includes("activeElement") ? "focused?" : command.method);
    for (let at = 0; at < order.length; at++) if (order[at] === "Input.insertText") expect(order[at - 1]).toBe("focused?");
  });
});

// ── the operator end to end ────────────────────────────────────────────────

interface SetUp {
  dir: string;
  operator: Operator;
  engine: FakeEngine;
  chrome: FakeChrome;
  model: BrowserModel;
  socks: FakeSocks;
  site: FakeLoginSite;
  logDir: string;
  lines: string[];
  rpcPort: number;
}

async function setUp(options: { apiToken?: string | null; haltStore?: HaltStore } = {}): Promise<SetUp> {
  const temp = tempDir();
  cleanups.push(temp.remove);
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const chrome = new FakeChrome();
  await chrome.boot();
  await chrome.shutdown();
  cleanups.push(() => chrome.close());
  const model = new BrowserModel(chrome);
  const site = new FakeLoginSite(model, { login: LOGIN_MARKER, password: PASSWORD_MARKER, code: CODE_MARKER, token: SITE_TOKEN, clientId: SITE_CLIENT });
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
  const logDir = join(temp.dir, "logs");
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
      apiToken: options.apiToken === undefined ? API_TOKEN : options.apiToken,
      netSelftestPath: netSelftest,
      chromeEnvPath: chromeEnv,
      logDir,
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
    ...(options.haltStore ? { haltStore: options.haltStore } : {}),
    timings: { replayWaitMs: 2000, chromeUpMs: 5000, attachMs: 3000, envCheckMs: 3000, stateEveryMs: 200, healthEveryMs: 100, healthAnswerMs: 300, selfTestProbeMs: 2000, exitIpTimeoutMs: 2000, quitWaitMs: 1000 },
  });
  const ports = await operator.start();
  cleanups.push(() => operator.stop());
  model.proxyPort = ports.proxyPort;
  await until(() => operator.cdp.linked, WAIT_MS, "the holder link");
  const engine = new FakeEngine();
  await engine.connect(ports.rpcPort);
  cleanups.push(() => engine.close());
  engine.send(hello({ socks5: { ip: "127.0.0.1", port: socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
  await engine.waitFor("helloResult", undefined, WAIT_MS);
  return { dir: temp.dir, operator, engine, chrome, model, socks, site, logDir, lines, rpcPort: ports.rpcPort };
}

let commandN = 0;
function command(engine: FakeEngine, command: Record<string, unknown>, generation = engine.generation): Promise<Record<string, unknown>> {
  const commandId = `c-${++commandN}`;
  engine.send({ type: "command", ownerGeneration: generation, commandId, notAfterMono: monoMs() + 10_000, command });
  return engine.waitFor("commandResult", (message) => message.commandId === commandId, WAIT_MS);
}

/** The API's end of the login form: one WebSocket, calls by id. */
class Caller {
  readonly replies: Array<Record<string, unknown>> = [];
  readonly frames: Buffer[] = [];
  closed: number | null = null;
  #ws: WebSocket | null = null;

  static async open(port: number): Promise<Caller> {
    const caller = new Caller();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
      ws.binaryType = "arraybuffer";
      caller.#ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("no connection"));
      ws.onclose = (event) => (caller.closed = event.code);
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) caller.frames.push(Buffer.from(event.data));
        else caller.replies.push(JSON.parse(String(event.data)) as Record<string, unknown>);
      };
    });
    return caller;
  }

  async call(type: string, fields: Record<string, unknown> = {}, token = API_TOKEN, timeoutMs = WAIT_MS): Promise<Record<string, unknown>> {
    const callId = randomUUID();
    this.#ws!.send(JSON.stringify({ type, callId, token, ...fields }));
    let found: Record<string, unknown> | undefined;
    await until(() => (found = this.replies.find((reply) => reply.callId === callId)) !== undefined || this.closed !== null, timeoutMs, `the answer to ${type}`);
    return found ?? { closed: this.closed };
  }

  close(): void {
    this.#ws?.close();
  }
}

/** The page started, the site loaded (step 8), the engine admitting every
 *  site request and every check. */
async function started(s: SetUp, generation = 1): Promise<void> {
  let attempt = 7000;
  s.engine.onMessage = (message) => {
    if (message.type === "siteAdmit") s.engine.send({ type: "siteAdmitResult", ownerGeneration: generation, siteRequestId: message.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: ++attempt });
    if (message.type === "check") s.engine.send({ type: "checkResult", ownerGeneration: generation, attemptId: message.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
  };
  expect(await command(s.engine, { kind: "restartBrowser" })).toMatchObject({ ok: true });
  await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded");
  s.site.setTab(s.operator.control.workTab!.sessionId);
}

describe("the login form through the operator (plan §4.8; PR 15)", { timeout: LONG_TEST_MS }, () => {
  it("takes no call before the engine's manual login, and none with a wrong token", async () => {
    const s = await setUp();
    await started(s);
    const api = await Caller.open(s.rpcPort);
    cleanups.push(() => api.close());
    expect(await api.call("login.state")).toMatchObject({ type: "login.refused", reason: "not_manual_login" });
    expect(await api.call("login.submit", { login: LOGIN_MARKER, password: PASSWORD_MARKER })).toMatchObject({ type: "login.refused", reason: "not_manual_login" });
    expect(s.site.inserted).toEqual([]);
    // The engine's token is not the API's.
    const wrong = await Caller.open(s.rpcPort);
    expect(await wrong.call("login.state", {}, RPC_TOKEN)).toMatchObject({ type: "login.refused", reason: "token" });
    await until(() => wrong.closed !== null, WAIT_MS, "the wrong token's connection to close");
    // An API connection is not the engine's: the engine's link stands.
    expect(s.operator.rpc.linkUp).toBe(true);
  });

  it("a container without an API token refuses every call", async () => {
    const s = await setUp({ apiToken: null });
    const api = await Caller.open(s.rpcPort);
    expect(await api.call("login.state")).toMatchObject({ type: "login.refused", reason: "token" });
  });

  it("the manual login only by the current owner: an earlier generation's setMode is refused, and a new owner ends it", async () => {
    const s = await setUp();
    await started(s);
    const api = await Caller.open(s.rpcPort);
    cleanups.push(() => api.close());
    // A second engine of a newer generation takes the page.
    const newer = new FakeEngine();
    newer.generation = 2;
    await newer.connect(s.rpcPort);
    cleanups.push(() => newer.close());
    newer.send(hello({ ownerGeneration: 2, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await newer.waitFor("quiesced", undefined, WAIT_MS);
    // The old one's command never reaches the operator's mode.
    s.engine.send({ type: "command", ownerGeneration: 1, commandId: "old-1", notAfterMono: monoMs() + 10_000, command: { kind: "setMode", mode: "manual_login" } });
    // A negative check (no event comes of a superseded connection's command):
    // the wait only gives a wrong operator the time to take it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(s.operator.state.mode).toBe("automation");
    expect(await api.call("login.state")).toMatchObject({ reason: "not_manual_login" });
    // The current owner's does.
    expect(await command(newer, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    expect(s.operator.state.mode).toBe("manual_login");
    await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
    expect(await api.call("login.state")).toMatchObject({ type: "login.stateResult", screen: "login", screenVersion: SCREEN_VERSION, fields: ["login", "password"], siteError: null });
    // Generation 3 comes: the manual login was generation 2's.
    const third = new FakeEngine();
    third.generation = 3;
    await third.connect(s.rpcPort);
    cleanups.push(() => third.close());
    third.send(hello({ ownerGeneration: 3, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await third.waitFor("quiesced", undefined, WAIT_MS);
    expect(s.operator.state.mode).toBe("automation");
    expect(await api.call("login.state")).toMatchObject({ reason: "not_manual_login" });
  });

  /** The site's own read with a session (its headers as the site sets them). */
  function siteRead(s: SetUp, token: string, clientId: string): void {
    const path = "/api/v1/account/me";
    s.model.pause(`https://apiv3.fansly.com${path}?ngsw-bypass=true`, "GET", s.operator.control.workTab!.sessionId, "XHR", {
      Accept: "application/json, text/plain, */*",
      authorization: token,
      "fansly-client-check": fanslyClientCheck(path, clientId),
      "fansly-client-id": clientId,
      "fansly-client-ts": String(fanslyClientTs(Date.now(), "720167541418230022")),
      "fansly-session-id": "720167541418230022",
    });
  }

  it("a browser Fansly signed out (login_required held): started only for the owner's login, and that halt cleared by the operator once the expected account is confirmed after it (PR 17, Astra round 3)", async () => {
    const store = new HaltStore(null);
    const held = { id: randomUUID(), reason: "login_required" as const, atWall: Date.now() - 60_000 };
    store.write({ halt: held, lastClearedId: null });
    const s = await setUp({ haltStore: store });
    expect(s.operator.heldHalt).toEqual(held);
    let attempt = 7600;
    s.engine.onMessage = (message) => {
      if (message.type === "siteAdmit") s.engine.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: message.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: ++attempt });
      if (message.type === "check") s.engine.send({ type: "checkResult", ownerGeneration: 1, attemptId: message.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
    };
    // In the automation: no start for it.
    expect(await command(s.engine, { kind: "restartBrowser" })).toMatchObject({ ok: false, detail: expect.stringContaining("clearHalt first") });
    // The owner's login: its start is taken.
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    expect(await command(s.engine, { kind: "restartBrowser" })).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded");
    s.site.setTab(s.operator.control.workTab!.sessionId);
    const token = "fansly-token-SiGnEdOuT0123456789ab";
    const fingerprint = sessionFingerprint(token, SITE_CLIENT);
    siteRead(s, token, SITE_CLIENT);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === fingerprint, WAIT_MS);
    // Still held while the person is in the page.
    expect(s.operator.heldHalt).toEqual(held);
    // The automation; the engine's identity read names the expected account: cleared.
    const loads = s.model.navigations.length;
    expect(await command(s.engine, { kind: "setMode", mode: "automation" })).toMatchObject({ ok: true });
    await until(() => s.model.navigations.length > loads && s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
    // The new document's own first API read (as the site's load makes it):
    // Hub's headers are learned from it, not from the document before.
    const loadedEndsA = s.engine.of("siteDone").length;
    siteRead(s, token, SITE_CLIENT);
    await until(() => s.engine.of("siteDone").length > loadedEndsA, WAIT_MS, "the new document's read ended");
    s.model.hubBody = Buffer.from(JSON.stringify({ success: true, response: { account: { id: "123456789" } } }));
    s.engine.send({ type: "send", ownerGeneration: 1, attemptId: 9701, route: "account.me", credentialsGeneration: "c".repeat(64), sessionFingerprint: fingerprint, method: "GET", url: "https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true", headers: {}, kind: "api", maxBodyBytes: 32 * 1024 * 1024, sendDeadlineMono: monoMs() + 15_000, requestDeadlineMono: monoMs() + 20_000 });
    await until(() => s.operator.page.step === "ready", WAIT_MS, "the page ready");
    expect(s.operator.heldHalt).toBeNull();
    expect(store.read()).toEqual({ halt: null, lastClearedId: held.id });
    await s.engine.waitFor("state", (state) => state.halt === null && state.step === "ready", WAIT_MS);
  });
});



it("keeps probe exceptions and site error text out of login-state diagnostics", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const chrome = new DeskChrome(); let throws = false;
  const cdp: CdpPort = {
    ...chrome,
    send: <T>(method: string, params: Record<string, unknown> = {}) => {
      if (method === "Runtime.evaluate" && String(params.expression).includes("pbLoginProbe")) {
        return Promise.resolve((throws ? { exceptionDetails: { text: PASSWORD_MARKER } } : { result: { value: page([form({ password: 1, login: 1, error: PASSWORD_MARKER })], { path: "/private-marker" }) } }) as T);
      }
      return chrome.send<T>(method, params);
    }, on: () => undefined, ack: () => undefined, holdAcks: () => undefined,
  };
  const d = new LoginDesk({ cdp, tab: () => "S1", world: async () => 7, session: () => null, discard: async () => undefined, log: (e, fields) => lines.push({ e, ...fields }) });
  expect(await d.state()).toMatchObject({ kind: "state", screen: "error" });
  throws = true;
  expect(await d.state()).toMatchObject({ kind: "state", screen: "unknown" });
  expect(lines.filter((line) => line.e === "login.state")).toHaveLength(2);
  expect(JSON.stringify(lines)).not.toContain(PASSWORD_MARKER);
  expect(JSON.stringify(lines)).not.toContain("private-marker");
  expect(lines).toContainEqual(expect.objectContaining({ e: "read.failed", why: "the login probe threw in the page" }));
});
