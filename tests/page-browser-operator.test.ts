import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBuffer } from "../apps/page-browser/src/buffer/buffer.ts";
import { MAX_WAITING, REPLAY_HIGH_WATER } from "../apps/page-browser/src/buffer/replay.ts";
import { DB_FILE } from "../apps/page-browser/src/buffer/store.ts";
import { authorizationBytes } from "../apps/page-browser/src/egress/socket-gate.ts";
import { ISSUE } from "../apps/page-browser/src/hub-requests/page.ts";
import { fanslyClientCheck, sessionFingerprint } from "../apps/page-browser/src/hub-requests/session.ts";
import { Operator, type OperatorDeps } from "../apps/page-browser/src/operator/operator.ts";
import { HaltStore, SLOT_BYTES, type HeldHalt } from "../apps/page-browser/src/state/halt-store.ts";
import { buildRules } from "../apps/page-browser/src/policy/rules.ts";
import { decodeBodyFrame } from "../apps/page-browser/src/rpc/protocol.ts";
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
  hubResult,
  proxyConnect,
  quiet,
  RawEngine,
  RPC_TOKEN,
  SOCKET_FILL,
  socketServer,
  SocketTunnelClient,
  SOCKS_PASSWORD,
  SOCKS_USER,
  tempDir,
  TLS13_OVERHEAD,
  tlsLikeServer,
  until,
  writeExtensionPackage,
  writeNetSelftest,
  wsFrame,
} from "./helpers/page-browser-fakes.ts";

/** Hang guards, not speed checks: a fake Chrome's start and its self-test on a
 *  loaded CI machine took over 10 s (the owner's PC); a test of several such
 *  steps gets the time for them. */
const START_MS = 30_000;
vi.setConfig({ testTimeout: 120_000 });

// The operator core (Project Browser plan §4.1, §4.9, §4.13; stage 3, PR 4)
// end to end, without Docker: the real holder and operator, a scripted fake
// Chrome behind them, a fake SOCKS5 and exit-IP service, and the engine's
// side of the RPC. What must hold: the start goes step by step to the open
// exit, then loads the site (PR 7); no API request leaves without the
// engine's admission; a planned stop closes the exit before CDP goes; a lost control
// closes it at once; a changed exit IP keeps it closed; a restarted operator
// fails what was left paused; no secret reaches a log.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setLogSink(null);
  forgetSecrets();
});

interface SetUp {
  /** The test's directory: the heartbeat is `alive` in it. */
  dir: string;
  operator: Operator;
  engine: FakeEngine;
  chrome: FakeChrome;
  model: BrowserModel;
  control: FakeChromeControl;
  holder: HolderUnderS6;
  socks: FakeSocks;
  logDir: string;
  netSelftest: string;
  /** The operator's hand-over of the page's environment to Chrome's start. */
  chromeEnv: string;
  /** The ID of the rules extension's package the operator serves. */
  extensionId: string | null;
  lines: string[];
  newOperator: () => Promise<Operator>;
  rpcPort: () => number;
}

async function setUp(
  options: {
    /** "not_installed": an image without the rules extension. */
    extension?: "not_installed";
    /** The operator has no package to serve: nothing installs. */
    noPackage?: boolean;
    exitIp?: () => string | Promise<string>;
    holderMaxBytes?: number;
    params?: Record<string, unknown>;
    buffer?: OperatorDeps["buffer"];
    socketTimings?: OperatorDeps["socketTimings"];
    siteTimings?: OperatorDeps["siteTimings"];
    /** How long the site's document may take (30 s in the operator). */
    siteLoadMs?: number;
    /** The page's slot past its admission's deadline (22 s in the operator). */
    slotLimitMs?: number;
    /** Before the operator: what its buffer volume holds. */
    prepare?: (paths: { bufferDir: string; stateDir: string }) => void;
    haltStore?: OperatorDeps["haltStore"];
    /** The strict gate of the site's admitted path (variant Б's is passive). */
    strictGate?: boolean;
  } = {},
): Promise<SetUp> {
  const temp = tempDir();
  cleanups.push(temp.remove);
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const chrome = new FakeChrome();
  // A port for Chrome's DevTools, then Chrome is down until the operator starts it.
  await chrome.boot();
  await chrome.shutdown();
  cleanups.push(() => chrome.close());
  const model = new BrowserModel(chrome);
  const holder = new HolderUnderS6(join(temp.dir, "holder.sock"), chrome, options.holderMaxBytes);
  await holder.start();
  cleanups.push(() => holder.stop());
  const socks = new FakeSocks(SOCKS_USER, SOCKS_PASSWORD);
  await socks.start();
  cleanups.push(() => socks.stop());
  const ipify = await fakeIpify(options.exitIp ?? (() => "203.0.113.7"));
  cleanups.push(ipify.close);
  socks.routes.set("api.ipify.org:443", ipify.port);
  const control = new FakeChromeControl(chrome);
  const chromeEnv = join(temp.dir, "chrome-env");
  // Chrome's run script takes the hand-over as Chrome starts.
  control.onStart = () => model.chromeStarts(chromeEnv);
  const netSelftest = join(temp.dir, "net-selftest.json");
  writeNetSelftest(netSelftest);
  const logDir = join(temp.dir, "logs");
  // The image's package of the rules extension: Chrome's policy installs it
  // from the operator's port at every start (the model does).
  const extensionDir = join(temp.dir, "extension");
  const extensionId = options.noPackage ? null : writeExtensionPackage(extensionDir);
  let rpcPort = 0;
  const newOperator = async () => {
    const operator = new Operator({
      config: {
        holderSock: holder.socketPath,
        proxyHost: "127.0.0.1",
        proxyPort: 0,
        rpcHost: "127.0.0.1",
        rpcPort: 0,
        rpcToken: RPC_TOKEN,
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
      ...(options.extension ? { extension: options.extension } : {}),
      ...(options.buffer ? { buffer: options.buffer } : {}),
      ...(options.socketTimings ? { socketTimings: options.socketTimings } : {}),
      ...(options.siteTimings ? { siteTimings: options.siteTimings } : {}),
      ...(options.strictGate ? { gatePassive: false } : {}),
      ...(options.haltStore ? { haltStore: options.haltStore } : {}),
      timings: { replayWaitMs: 2000, chromeUpMs: 5000, attachMs: 3000, envCheckMs: 3000, stateEveryMs: 200, healthEveryMs: 100, healthAnswerMs: 300, selfTestProbeMs: 2000, exitIpTimeoutMs: 2000, quitWaitMs: 1000, ...(options.siteLoadMs ? { siteLoadMs: options.siteLoadMs } : {}), ...(options.slotLimitMs ? { slotLimitMs: options.slotLimitMs } : {}) },
    });
    const ports = await operator.start();
    cleanups.push(() => operator.stop());
    model.proxyPort = ports.proxyPort;
    rpcPort = ports.rpcPort;
    return operator;
  };
  options.prepare?.({ bufferDir: join(temp.dir, "buffer"), stateDir: join(temp.dir, "state") });
  const operator = await newOperator();
  await until(() => operator.cdp.linked, 3000, "the holder link");
  const engine = new FakeEngine();
  await engine.connect(rpcPort);
  cleanups.push(() => engine.close());
  engine.send(hello({ protocol: { majors: [1], minor: 2 }, socks5: { ip: "127.0.0.1", port: socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }, options.params));
  await engine.waitFor("helloResult");
  return { dir: temp.dir, operator, engine, chrome, model, control, holder, socks, logDir, netSelftest, chromeEnv, extensionId, lines, newOperator, rpcPort: () => rpcPort };
}

let commandN = 0;
function command(engine: FakeEngine, kind: string): Promise<Record<string, unknown>> {
  const commandId = `c-${++commandN}`;
  engine.send({ type: "command", ownerGeneration: engine.generation, commandId, notAfterMono: monoMs() + 10_000, command: { kind } });
  return engine.waitFor("commandResult", (message) => message.commandId === commandId, 15_000);
}

async function started(s: SetUp): Promise<void> {
  expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
  await until(() => s.operator.page.step === "site_loaded", START_MS, "the open exit");
}

function journal(logDir: string, kind: string): Array<Record<string, unknown>> {
  return readdirSync(logDir)
    .filter((name) => name.startsWith(`${kind}-`) && name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The journals are written through file streams and the engine hears the
 *  operator through its socket: a line or a state may come after the event
 *  the test waited for (a loaded CI machine). What should be there is
 *  awaited with `expect.poll` — a hang guard, never a speed check — and a
 *  failure still shows its diff. */
const SETTLED = { timeout: 10_000, interval: 10 };

describe("the start (plan §4.1)", () => {
  it("stands with the exit closed until the engine starts the page", async () => {
    const s = await setUp();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.operator.page.snapshot).toEqual({ step: "exit_closed", stopReason: null, retryAtWall: null, halted: false });
    expect(s.control.calls).toEqual([]);
    expect(s.operator.egress.exitOpen).toBe(false);
    await expect.poll(() => s.engine.last("state"), SETTLED).toMatchObject({ step: "exit_closed", exitOpen: false });
  });

  it("goes step by step to the open exit, with the self-test passed and the exit IP verified, then loads the site (step 8) and stops there", async () => {
    const s = await setUp();
    await started(s);
    await until(() => s.engine.of("state").some((state) => state.step === "site_loaded"));
    const steps = s.engine.of("state").map((state) => state.step).filter((step, index, all) => step !== all[index - 1]);
    expect(steps.slice(steps.lastIndexOf("exit_closed"))).toEqual(["exit_closed", "env_applied", "chrome_started", "control_attached", "selftest_passed", "exit_ip_verified", "exit_open", "site_loaded"]);
    const state = s.engine.last("state")!;
    expect(state).toMatchObject({ exitOpen: true, exitIp: "203.0.113.7", chromeVersion: "Chrome/155.0.8059.39", operatorVersion: "test", stopReason: null });
    // Every mechanism, the rules extension's two among them: nothing "not installed".
    expect(state.selfTest).toEqual({ ok: true, atWall: expect.any(Number), failed: null });
    const checks = s.operator.lastSelfTest!.checks;
    expect([checks.proxy_closed.status, checks.os_rules.status, checks.dnr_never.status, checks.dnr_write.status]).toEqual(["passed", "passed", "passed", "passed"]);
    // The probe reached the interception, went on, and met the closed exit.
    const probe = s.model.requests.find((request) => request.fragment.startsWith("#pb-selftest-"))!;
    expect(probe).toMatchObject({ method: "GET", outcome: "continued", proxyStatus: 403 });
    expect(new URL(probe.url).hostname).toBe("apiv3.fansly.com");
    await expect.poll(() => journal(s.logDir, "connections"), SETTLED).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", port: 443, refused: true, result: "refused: exit closed" }));
    await expect.poll(() => journal(s.logDir, "requests"), SETTLED).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", path: "/api/v1/pb-selftest", decision: "continued", admission: "self-test probe (exit closed)" }));
    // The exit IP through the page's SOCKS5, with its password.
    expect(s.socks.connects).toContain("api.ipify.org:443");
    expect(s.socks.logins.every((login) => login.ok && login.password === SOCKS_PASSWORD)).toBe(true);
    // Step 8: the work tab, and only it, goes to the site once the exit is
    // open; its document passes unpaced, journaled.
    expect(s.chrome.sent("Page.navigate").map((command) => [command.sessionId, command.params.url])).toEqual([[s.operator.control.workTab!.sessionId, "https://fansly.com/"]]);
    expect(s.operator.control.workTab!.url).toBe("https://fansly.com/");
    await expect.poll(() => journal(s.logDir, "requests"), SETTLED).toContainEqual(expect.objectContaining({ host: "fansly.com", path: "/", resourceType: "Document", decision: "continued", admission: null, result: "passed unpaced" }));
    // No session confirmed without the engine's identity read (step 9).
    expect(s.operator.page.step).toBe("site_loaded");
    expect(s.operator.state.accountId).toBeNull();
    expect(s.operator.admissionsOpen()).toBe(true);
    // The states journal has every transition.
    await expect.poll(() => journal(s.logDir, "states").map((line) => line.to), SETTLED).toEqual(expect.arrayContaining(["exit_open", "site_loaded"]));
  });

  it("a site whose document never comes fails the start too: the page is not taken for loaded", async () => {
    const s = await setUp({ params: { restartBackoffMs: [5000] }, siteLoadMs: 300 });
    s.model.siteLoads = "never";
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.snapshot.stopReason === "proxy_unavailable", 10_000, "the failure");
    expect(s.engine.of("state").some((state) => state.step === "site_loaded")).toBe(false);
    expect(s.operator.egress.exitOpen).toBe(false);
  });

  it("a site that does not load fails the start (proxy_unavailable) and is tried again after the backoff", async () => {
    const s = await setUp({ params: { restartBackoffMs: [300] } });
    s.model.siteLoads = "error";
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.snapshot.stopReason === "proxy_unavailable", 10_000, "the failure");
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.operator.page.snapshot.retryAtWall).not.toBeNull();
    s.model.siteLoads = "commit";
    await until(() => s.operator.page.step === "site_loaded", START_MS, "the page up again");
    expect(s.control.calls.filter((call) => call === "start").length).toBeGreaterThanOrEqual(2);
  });

  it("decides every paused request of the site by the map: the page and other hosts pass, the API waits for the engine, a closed write, a local address and a probe's marker are failed", async () => {
    const s = await setUp();
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    const script = s.model.pause("https://fansly.com/main.4f2a.js", "GET", tab, "Script");
    const third = s.model.pause("https://widget.intercom.io/widget/abc", "GET", tab, "Script");
    const api = s.model.pause("https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true", "GET", tab, "XHR");
    const write = s.model.pause("https://apiv3.fansly.com/api/v1/message/ack", "POST", tab, "XHR");
    const local = s.model.pause("http://127.0.0.1:9222/json", "GET", tab, "Fetch");
    // A request carrying a probe's marker outside the self-test.
    const fakeProbe = s.model.pause("https://apiv3.fansly.com/api/v1/pb-selftest?pbst=x#pb-selftest-x", "GET");
    await until(() => [script, third].every((request) => request.outcome === "continued") && [write, local, fakeProbe].every((request) => request.outcome === "failed"));
    expect([write, local, fakeProbe].map((request) => request.failReason)).toEqual(["BlockedByClient", "BlockedByClient", "BlockedByClient"]);
    // The API read waits, paused, for the engine: asked with its route.
    const ask = await s.engine.waitFor("siteAdmit");
    expect(ask).toEqual({
      type: "siteAdmit",
      siteRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      method: "GET",
      host: "apiv3.fansly.com",
      path: "/api/v1/account/me",
      query: "?ngsw-bypass=true",
      resourceType: "XHR",
      route: "account.me",
      operation: "read",
      sessionFingerprint: null,
      pausedMono: expect.any(Number),
      waitDeadlineMono: (ask.pausedMono as number) + 60_000,
    });
    expect(api.outcome).toBe("paused");
    // Its id was in the buffer before it was asked.
    expect(s.operator.buffer.siteRequests().map((kept) => kept.siteRequestId)).toEqual([ask.siteRequestId]);
    s.engine.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: ask.siteRequestId, admit: false, reason: "paused" });
    await until(() => api.outcome === "failed", 3000, "the refused request to fail");
    expect(api.failReason).toBe("Failed");
    await until(() => s.operator.buffer.siteRequests().length === 0, 3000, "its id to go");
    // Not admitted: no end of it goes to the engine.
    expect(s.engine.of("siteDone")).toEqual([]);
    const requests = () => journal(s.logDir, "requests");
    await expect.poll(requests, SETTLED).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", path: "/api/v1/message/ack", decision: "failed", result: "BlockedByClient: a read mark: closed until the owner opens it (closed: POST|PUT|PATCH|DELETE /message/ack)" }));
    await expect.poll(requests, SETTLED).toContainEqual(expect.objectContaining({ host: "widget.intercom.io", decision: "continued", result: "passed unpaced" }));
    await expect.poll(requests, SETTLED).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", path: "/api/v1/account/me", decision: "failed", admission: expect.stringMatching(/^site request /), result: "Failed: refused by the engine: paused" }));
    // The gate opened no window: a CONNECT to the API host is refused even with the exit open.
    expect(s.operator.egress.gate.state.phase).toBe("closed");
  });

  it("keeps the exit closed and stands on a failed kernel check, alarming, and tries again later", async () => {
    const s = await setUp();
    writeNetSelftest(s.netSelftest, false);
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    const alarm = await s.engine.waitFor("alarm", (message) => message.kind === "selftest_failed", 10_000);
    expect(alarm.detail).toMatchObject({ failed: "os_rules" });
    await until(() => s.operator.page.snapshot.stopReason === "selftest_failed");
    expect(s.operator.page.snapshot.retryAtWall).not.toBeNull();
    expect(s.engine.of("state").some((state) => state.exitOpen === true)).toBe(false);
    await until(() => s.chrome.sent("Browser.close").length > 0, 5000, "failed Chrome asked to quit");
    // The retry runs the start again (and fails again).
    await until(() => s.control.calls.filter((call) => call === "start").length >= 2, 5000, "a retry");
    expect(s.engine.of("state").some((state) => state.exitOpen === true)).toBe(false);
  });

  it("Chrome's policy installs the rules extension from the operator's own port, and the self-test passes only when it cancels both probes before the interception", async () => {
    const s = await setUp();
    await started(s);
    // The package the operator served is what is installed: its ID, the map's rules.
    expect(s.model.installs).toEqual([{ id: s.extensionId, rules: buildRules().length }]);
    expect(s.model.rules).toEqual(buildRules());
    expect(s.lines.filter((line) => line.includes('"e":"extension.served"')).map((line) => (JSON.parse(line) as { path: string }).path)).toEqual(["/pb-extension/update.xml", "/pb-extension/hub.crx"]);
    const checks = s.operator.lastSelfTest!.checks;
    expect([checks.dnr_never, checks.dnr_write]).toEqual([
      { status: "passed", detail: "cancelled by the extension" },
      { status: "passed", detail: "cancelled by the extension" },
    ]);
    // Cancelled before the interception: neither probe was ever paused.
    const probes = s.model.requests.filter((request) => request.method === "POST");
    expect(probes.map((request) => [new URL(request.url).pathname, request.outcome])).toEqual([
      ["/api/v1/message/ack", "blocked_by_extension"],
      ["/api/v1/pb-selftest-unknown", "blocked_by_extension"],
    ]);
    await expect.poll(() => s.engine.last("state")?.selfTest, SETTLED).toEqual({ ok: true, atWall: expect.any(Number), failed: null });
  });

  it("without the package nothing installs: the self-test fails on the extension, the exit stays closed", async () => {
    const s = await setUp({ noPackage: true });
    s.engine.send({ type: "ping", n: 1, ownerGeneration: 1 });
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    const alarm = await s.engine.waitFor("alarm", (message) => message.kind === "selftest_failed", 15_000);
    expect(alarm.detail).toMatchObject({ failed: "dnr_never" });
    expect(s.model.installs[0]).toEqual({ failed: "the update manifest: 403" });
    expect(s.model.rules).toBeNull();
    expect(s.operator.lastSelfTest!.checks.dnr_never).toEqual({ status: "failed", detail: "the extension let it through: the operator stopped it" });
    expect(s.engine.of("state").some((state) => state.exitOpen === true)).toBe(false);
  });

  it("an extension that is installed but does not cancel the probes fails the self-test too", async () => {
    const s = await setUp();
    // Another extension's rules: nothing of the map in them.
    s.model.policyInstalls = false;
    s.model.rules = [];
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    const alarm = await s.engine.waitFor("alarm", (message) => message.kind === "selftest_failed", 15_000);
    expect(alarm.detail).toMatchObject({ failed: "dnr_never" });
    expect(s.engine.of("state").some((state) => state.exitOpen === true)).toBe(false);
  });

  it("an image without the rules extension reports its checks as not installed — never as passed", async () => {
    const s = await setUp({ extension: "not_installed", noPackage: true });
    await started(s);
    await expect.poll(() => s.engine.last("state")?.selfTest, SETTLED).toMatchObject({ ok: true, failed: null, notInstalled: ["dnr_never", "dnr_write"] });
    const checks = s.operator.lastSelfTest!.checks;
    expect([checks.dnr_never.status, checks.dnr_write.status]).toEqual(["not_installed", "not_installed"]);
  });
});

describe("the exit IP", () => {
  it("not the pinned one keeps the exit closed: the page stops until the owner decides", async () => {
    const s = await setUp({ exitIp: () => "198.51.100.9" });
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.snapshot.stopReason === "exit_ip_changed", 10_000);
    expect(s.operator.page.snapshot).toMatchObject({ step: "exit_closed", halted: true, retryAtWall: null });
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.engine.of("state").some((state) => state.exitOpen === true)).toBe(false);
    const starts = s.control.calls.filter((call) => call === "start").length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(s.control.calls.filter((call) => call === "start").length).toBe(starts);
    expect(s.chrome.running).toBe(false);
  });

  it("is checked again before the engine's openExit", async () => {
    const s = await setUp();
    await started(s);
    const checks = s.socks.connects.filter((target) => target === "api.ipify.org:443").length;
    expect(await command(s.engine, "closeExit")).toMatchObject({ ok: true });
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.operator.page.step).toBe("exit_ip_verified");
    expect(await command(s.engine, "openExit")).toMatchObject({ ok: true, detail: "the exit is open" });
    expect(s.socks.connects.filter((target) => target === "api.ipify.org:443").length).toBe(checks + 1);
    // The site loads again with the exit open.
    await until(() => s.operator.page.step === "site_loaded", START_MS, "the site loaded again");
    expect(s.model.navigations).toEqual(["https://fansly.com/", "https://fansly.com/"]);
  });
});

describe("the engine's link", () => {
  it("lost (no ping for 5 s — 600 ms here) admits nothing new; the exit and the browser stay", async () => {
    const s = await setUp();
    await started(s);
    expect(s.operator.admissionsOpen()).toBe(true);
    s.engine.answerPings = false;
    await until(() => !s.operator.admissionsOpen(), 3000, "admissions to close");
    expect(s.operator.rpc.linkUp).toBe(false);
    expect(s.operator.egress.exitOpen).toBe(true);
    expect(s.operator.page.step).toBe("site_loaded");
  });
});

describe("commands", () => {
  it("stopPage closes the exit before CDP goes, and the page stays stopped", async () => {
    const s = await setUp();
    await started(s);
    let exitOpenAtClose: boolean | null = null;
    s.model.onBrowserClose = () => (exitOpenAtClose = s.operator.egress.exitOpen);
    expect(await command(s.engine, "stopPage")).toMatchObject({ ok: true });
    expect(exitOpenAtClose).toBe(false);
    expect(s.chrome.sent("Browser.close")).toHaveLength(1);
    expect(s.operator.page.snapshot).toEqual({ step: "exit_closed", stopReason: "owner_stop", retryAtWall: null, halted: true });
    expect(s.chrome.running).toBe(false);
    const starts = s.control.calls.filter((call) => call === "start").length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(s.control.calls.filter((call) => call === "start").length).toBe(starts);
    // openExit cannot undo a stop; restartBrowser starts the page again.
    expect(await command(s.engine, "openExit")).toMatchObject({ ok: false });
    await started(s);
  });

  it("stopPage is answered as done only once Chrome is down: a Chrome that stays up confirms no stop (Astra PR 17, P1-3)", async () => {
    const s = await setUp();
    await started(s);
    // Chrome neither quits on Browser.close nor goes down at s6's stop.
    s.chrome.handlers.set("Browser.close", () => ({}));
    s.control.stop = async () => {
      s.control.calls.push("stop");
    };
    const answer = await command(s.engine, "stopPage");
    expect(answer).toMatchObject({ ok: false, detail: "the exit is closed, but Chrome is still up" });
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.chrome.running).toBe(true);
    // Once it is down, a stop is confirmed.
    await s.chrome.shutdown();
    expect(await command(s.engine, "stopPage")).toMatchObject({ ok: true });
  });

  it("restartBrowser on a running page starts it again at once: the previous Chrome's holder going is no failure", async () => {
    const s = await setUp();
    await started(s);
    const before = s.engine.of("state").length;
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.control.calls.filter((call) => call === "start").length === 2 && s.operator.page.step === "site_loaded", 5000, "the page up again");
    expect(s.engine.of("state").slice(before).every((state) => state.stopReason === null)).toBe(true);
    expect(s.holder.exits.length).toBeGreaterThanOrEqual(1);
  });

  it("selfTest runs only with the exit closed, and reports each mechanism", async () => {
    const s = await setUp();
    await started(s);
    expect(await command(s.engine, "selfTest")).toMatchObject({ ok: false, detail: expect.stringMatching(/exit is open/) });
    await command(s.engine, "closeExit");
    expect(await command(s.engine, "selfTest")).toEqual({
      type: "commandResult",
      commandId: expect.any(String),
      ok: true,
      detail: "proxy_closed: passed, os_rules: passed, dnr_never: passed, dnr_write: passed",
    });
  });

  it("not supported yet are refused, and a repeated id is not executed twice", async () => {
    const s = await setUp();
    expect(await command(s.engine, "profileSnapshot")).toMatchObject({ ok: false, detail: "profileSnapshot is not supported by this operator yet" });
    s.engine.send({ type: "command", ownerGeneration: 1, commandId: "same", notAfterMono: monoMs() + 10_000, command: { kind: "restartBrowser" } });
    s.engine.send({ type: "command", ownerGeneration: 1, commandId: "same", notAfterMono: monoMs() + 10_000, command: { kind: "restartBrowser" } });
    await until(() => s.engine.of("commandResult").filter((message) => message.commandId === "same").length === 2);
    await until(() => s.operator.page.step === "site_loaded", START_MS);
    expect(s.control.calls.filter((call) => call === "start")).toHaveLength(1);
  });
});

describe("a new owner", () => {
  it("is quiesced only after the previous owner's queued commands had their turn, and none of them runs", async () => {
    const s = await setUp();
    await started(s);
    const starts = () => s.control.calls.filter((call) => call === "start").length;
    expect(starts()).toBe(1);
    // Chrome does not answer Browser.close: the stop holds the queue for its 2 s.
    s.chrome.handlers.set("Browser.close", () => null);
    s.engine.send({ type: "command", ownerGeneration: 1, commandId: "slow-stop", notAfterMono: monoMs() + 10_000, command: { kind: "stopPage" } });
    s.engine.send({ type: "command", ownerGeneration: 1, commandId: "late-restart", notAfterMono: monoMs() + 10_000, command: { kind: "restartBrowser" } });
    await until(() => s.operator.page.halted, 2000, "the stop under way");
    const next = new FakeEngine();
    next.generation = 2;
    await next.connect(s.rpcPort());
    cleanups.push(() => next.close());
    next.send(hello({ ownerGeneration: 2, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    expect(await next.waitFor("helloResult")).toMatchObject({ ok: true });
    await next.waitFor("quiesced", undefined, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(starts()).toBe(1);
    expect(s.operator.page.halted).toBe(true);
  });
});

describe("a new owner, a start under way", () => {
  it("ends the start: Chrome goes, the exit never opens, the page stands until the new owner starts it", async () => {
    let held: (() => void) | null = null;
    const s = await setUp({ exitIp: () => (held === null ? "203.0.113.7" : new Promise<string>((resolve) => (held = () => resolve("203.0.113.7")))) });
    held = () => undefined;
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "selftest_passed", START_MS, "the exit-IP check under way");
    const next = new FakeEngine();
    next.generation = 2;
    await next.connect(s.rpcPort());
    cleanups.push(() => next.close());
    next.send(hello({ ownerGeneration: 2, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await next.waitFor("quiesced", undefined, 10_000);
    (held as (() => void) | null)?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.operator.page.snapshot).toEqual({ step: "exit_closed", stopReason: null, retryAtWall: null, halted: false });
    expect(s.control.calls).toContain("kill");
  });

  it("a third owner waits until the second one ended the start, and that ending never touches the third one's browser", async () => {
    let hold = false;
    const releases: Array<() => void> = [];
    const s = await setUp({ exitIp: () => (hold ? new Promise<string>((resolve) => releases.push(() => resolve("203.0.113.7"))) : "203.0.113.7") });
    hold = true;
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "selftest_passed", START_MS, "the exit-IP check under way");
    const socks5 = { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD };
    const second = new FakeEngine();
    second.generation = 2;
    await second.connect(s.rpcPort());
    cleanups.push(() => second.close());
    second.send(hello({ ownerGeneration: 2, socks5 }));
    await second.waitFor("helloResult");
    const third = new FakeEngine();
    third.generation = 3;
    await third.connect(s.rpcPort());
    cleanups.push(() => third.close());
    third.send(hello({ ownerGeneration: 3, socks5 }));
    await third.waitFor("quiesced", undefined, 10_000);
    hold = false;
    expect(await command(third, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded", START_MS, "the third owner's page up");
    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(s.operator.page.step).toBe("site_loaded");
    expect(s.operator.egress.exitOpen).toBe(true);
    expect(s.chrome.running).toBe(true);
  });

  it("a queued command of the old owner stays refused after the new one disconnected", async () => {
    const s = await setUp();
    await started(s);
    const starts = () => s.control.calls.filter((call) => call === "start").length;
    s.chrome.handlers.set("Browser.close", () => null);
    s.engine.send({ type: "command", ownerGeneration: 1, commandId: "slow-stop-2", notAfterMono: monoMs() + 10_000, command: { kind: "stopPage" } });
    s.engine.send({ type: "command", ownerGeneration: 1, commandId: "late-restart-2", notAfterMono: monoMs() + 10_000, command: { kind: "restartBrowser" } });
    await until(() => s.operator.page.halted, 2000, "the stop under way");
    const next = new FakeEngine();
    next.generation = 2;
    await next.connect(s.rpcPort());
    next.send(hello({ ownerGeneration: 2, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await next.waitFor("helloResult");
    await next.close();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(starts()).toBe(1);
    expect(s.operator.page.halted).toBe(true);
  });
});

describe("the holder stopping", () => {
  it("latches the exit closed: an openExit under way does not open it before the detach", async () => {
    let held: (() => void) | null = null;
    const s = await setUp({ exitIp: () => (held === null ? "203.0.113.7" : new Promise<string>((resolve) => (held = () => resolve("203.0.113.7")))) });
    await started(s);
    expect(await command(s.engine, "closeExit")).toMatchObject({ ok: true });
    held = () => undefined;
    const commandId = "open-under-way";
    s.engine.send({ type: "command", ownerGeneration: 1, commandId, notAfterMono: monoMs() + 10_000, command: { kind: "openExit" } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stopped = s.holder.holder!.stop();
    (held as (() => void) | null)?.();
    await stopped;
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(await s.engine.waitFor("commandResult", (message) => message.commandId === commandId, 10_000)).toMatchObject({ ok: false });
    expect(s.operator.egress.exitOpen).toBe(false);
  });
});

describe("a lost control (plan §4.9)", () => {
  it("the work tab gone: the browser is not trusted any more", async () => {
    const s = await setUp();
    await started(s);
    const tab = s.operator.control.workTab!;
    s.chrome.event("Target.detachedFromTarget", { sessionId: tab.sessionId, targetId: tab.targetId });
    await until(() => s.operator.page.snapshot.stopReason === "cdp_lost", 3000, "the failure");
    expect(s.operator.egress.exitOpen).toBe(false);
  });


  it("CDP lost with every process alive: the exit closes at once, the alarm says a foreign request may have left, Chrome is killed and the start retried", async () => {
    const s = await setUp();
    await started(s);
    s.chrome.live!.destroy("a CDP break");
    await until(() => !s.operator.egress.exitOpen, 2000, "the exit to close");
    const alarm = await s.engine.waitFor("alarm", (message) => message.kind === "cdp_lost");
    expect(alarm.detail).toMatchObject({ exitOpenAtLoss: true, foreignRequestMayHaveLeft: true });
    await until(() => s.operator.page.snapshot.stopReason === "cdp_lost");
    expect(s.control.calls).toContain("kill");
    // The retry after the backoff (150 ms here) starts the page again.
    await until(() => s.operator.page.step === "site_loaded", START_MS, "the page back");
  });

  it("Chrome crashed: the reason says so", async () => {
    const s = await setUp();
    await started(s);
    await s.chrome.shutdown();
    await until(() => s.operator.page.snapshot.stopReason === "chrome_crashed", 3000);
    expect(s.operator.egress.exitOpen).toBe(false);
  });

  it("the holder overflowed: the exit closes and the operator alarms", async () => {
    const s = await setUp({ holderMaxBytes: 512 * 1024 });
    await started(s);
    s.chrome.event("Network.dataReceived", { requestId: "R", data: "z".repeat(1024 * 1024) });
    const alarm = await s.engine.waitFor("alarm", (message) => message.kind === "overflow", 5000);
    expect(alarm.detail).toMatchObject({ exitOpenAtLoss: true });
    expect(s.operator.egress.exitOpen).toBe(false);
    await until(() => s.operator.page.snapshot.stopReason === "holder_overflow");
  });

  it("a restarted operator fails the requests left paused and stands until the engine starts the page", async () => {
    const s = await setUp();
    await started(s);
    await s.operator.stop();
    // While no operator is there, the page asks for something: the holder keeps it.
    const left = s.model.pause("https://apiv3.fansly.com/api/v1/account/me", "GET");
    await until(() => (s.holder.holder?.stats.stored ?? 0) >= 2);
    const next = await s.newOperator();
    await until(() => left.outcome === "failed", 5000, "the replayed pause to be failed");
    expect(left.failReason).toBe("BlockedByClient");
    // The previous instance's Chrome goes; the page stands.
    await until(() => !s.chrome.running, 5000);
    expect(next.page.snapshot).toEqual({ step: "exit_closed", stopReason: null, retryAtWall: null, halted: false });
    expect(next.egress.exitOpen).toBe(false);
  });
});

describe("the halt held for the owner's decision (PR 17, Astra round 3)", () => {
  function commandOf(engine: FakeEngine, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const commandId = `c-${++commandN}`;
    engine.send({ type: "command", ownerGeneration: engine.generation, commandId, notAfterMono: monoMs() + 10_000, command: body });
    return engine.waitFor("commandResult", (message) => message.commandId === commandId, 15_000);
  }
  const heldOnDisk = (s: SetUp) => new HaltStore(join(s.dir, "state", "halt.json")).read().halt;

  it("is on the volume before the browser stops, survives a restart of the operator, and refuses every start and the exit's opening until the owner's clearHalt names it; a stale id clears nothing", async () => {
    const s = await setUp({ exitIp: () => "198.51.100.9" });
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.heldHalt !== null, 10_000, "the halt held");
    const held = s.operator.heldHalt!;
    expect(held).toMatchObject({ reason: "exit_ip_changed" });
    expect(heldOnDisk(s)).toMatchObject({ id: held.id, reason: "exit_ip_changed" });
    await until(() => s.engine.last("state")?.halt != null, 5000, "the halt said");
    expect(s.engine.last("state")!.halt).toEqual({ id: held.id, reason: "exit_ip_changed", atWall: held.atWall });
    // Refused, from anyone.
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: false, detail: expect.stringContaining("clearHalt first") });
    expect(await command(s.engine, "openExit")).toMatchObject({ ok: false, detail: expect.stringContaining("clearHalt first") });
    // The operator starts again (its container too): the halt is still held.
    await s.operator.stop();
    await s.engine.close();
    const next = await s.newOperator();
    expect(next.heldHalt).toEqual(held);
    expect(next.page.snapshot).toMatchObject({ step: "exit_closed", stopReason: "exit_ip_changed", halted: true });
    const engine = new FakeEngine();
    await engine.connect(s.rpcPort());
    cleanups.push(() => engine.close());
    engine.send(hello({ socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    expect(await engine.waitFor("helloResult")).toMatchObject({ ok: true, state: { stopReason: "exit_ip_changed", halt: { id: held.id, reason: "exit_ip_changed" } } });
    const starts = s.control.calls.filter((call) => call === "start").length;
    expect(await command(engine, "restartBrowser")).toMatchObject({ ok: false });
    // A clearHalt that names another halt clears nothing.
    expect(await commandOf(engine, { kind: "clearHalt", haltId: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ ok: false, detail: expect.stringContaining("nothing cleared") });
    expect(next.heldHalt).toEqual(held);
    expect(heldOnDisk(s)).toMatchObject({ id: held.id });
    // The owner's: cleared on the volume, then a start is taken.
    expect(await commandOf(engine, { kind: "clearHalt", haltId: held.id })).toMatchObject({ ok: true });
    expect(next.heldHalt).toBeNull();
    expect(heldOnDisk(s)).toBeNull();
    expect(next.page.snapshot).toMatchObject({ halted: false, stopReason: null });
    expect(await command(engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.control.calls.filter((call) => call === "start").length > starts, 10_000, "the start");
  });

  it("a stricter halt replaces a held login_required and is never replaced by it; the login starts only a browser held for login_required", async () => {
    const loginRequired = { id: "11111111-1111-4111-8111-111111111111", reason: "login_required", atWall: Date.now() - 60_000 };
    const s = await setUp({
      exitIp: () => "198.51.100.9",
      prepare: ({ stateDir }) => {
        mkdirSync(stateDir, { recursive: true });
        new HaltStore(join(stateDir, "halt.json")).write({ halt: loginRequired as HeldHalt, lastClearedId: null });
      },
    });
    expect(s.operator.heldHalt).toEqual(loginRequired);
    // In the automation: no start for it.
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: false });
    // The owner's login: the start for it is taken; its exit IP changed.
    expect(await commandOf(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.heldHalt?.reason === "exit_ip_changed", 10_000, "the stricter halt held");
    const stricter = s.operator.heldHalt!;
    expect(stricter.id).not.toBe(loginRequired.id);
    expect(heldOnDisk(s)).toMatchObject({ id: stricter.id, reason: "exit_ip_changed" });
    // Not even the login starts it now; a clearHalt of the login_required clears nothing.
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: false });
    expect(await commandOf(s.engine, { kind: "clearHalt", haltId: loginRequired.id })).toMatchObject({ ok: false });
    expect(s.operator.heldHalt).toEqual(stricter);
  });

  it("a held halt that cannot be written is held in memory, refused all the same, and written once it can be", async () => {
    let failing = true;
    const store = new HaltStore(null);
    const write = store.write.bind(store);
    store.write = (halt) => {
      if (failing) throw new Error("EIO");
      write(halt);
    };
    const s = await setUp({ exitIp: () => "198.51.100.9", haltStore: store });
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.heldHalt !== null, 10_000, "the halt held");
    expect(store.read().halt).toBeNull();
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: false });
    failing = false;
    await until(() => store.read().halt !== null, 5000, "the halt written");
    expect(store.read().halt).toEqual(s.operator.heldHalt);
  });

  it("a halt file not this store's, or spoilt in both slots: a halt being written — a strict halt_unreadable of its own, never no halt (Astra round 5)", () => {
    const temp = tempDir();
    cleanups.push(temp.remove);
    const stateDir = join(temp.dir, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "halt.json"), "{ not json");
    expect(new HaltStore(join(stateDir, "halt.json")).read()).toMatchObject({ halt: { reason: "halt_unreadable" }, unreadable: true });
    // Its size, but neither slot this store's.
    writeFileSync(join(stateDir, "halt.json"), Buffer.alloc(2 * SLOT_BYTES, 0x41));
    const first = new HaltStore(join(stateDir, "halt.json")).read();
    const again = new HaltStore(join(stateDir, "halt.json")).read();
    expect(first.halt).toMatchObject({ reason: "halt_unreadable" });
    // A new id each time it is read so (one only the owner's decision clears).
    expect(again.halt!.id).not.toBe(first.halt!.id);
  });

  it("a write is checked whole: a short one is a failed one, and the record before it stays (Astra round 5)", () => {
    const temp = tempDir();
    cleanups.push(temp.remove);
    const path = join(temp.dir, "state", "halt.json");
    let short = false;
    const store = new HaltStore(path, { writeSync: (fd, buffer, offset, length, position) => writeSync(fd, buffer, offset, short ? 40 : length, position) });
    store.read();
    const h1 = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", reason: "header_mismatch" as const, atWall: 1_000 };
    store.write({ halt: h1, lastClearedId: null });
    short = true;
    expect(() => store.write({ halt: null, lastClearedId: h1.id })).toThrow(/short write/);
    // Its slot was being written (spoilt): the operator starts holding a halt.
    expect(new HaltStore(path).read()).toMatchObject({ halt: { reason: "halt_unreadable" }, unreadable: true });
  });

  it("Astra's round 5 sequence: H1 cleared, the write of H2 cut, a restart — the operator holds halt_unreadable and refuses a start until the owner's clearHalt names it", async () => {
    const h1 = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", reason: "header_mismatch" as const, atWall: 1_000 };
    let preparedPath = "";
    const s = await setUp({
      prepare: ({ stateDir }) => {
        preparedPath = join(stateDir, "halt.json");
        const store = new HaltStore(preparedPath);
        store.read();
        store.write({ halt: h1, lastClearedId: null });
        store.write({ halt: null, lastClearedId: h1.id });
        // The next write (H2) goes into the older slot (seq 1, slot 0): cut midway.
        const fd = openSync(preparedPath, "r+");
        writeSync(fd, Buffer.from('{"seq":3,"halt":{"id":'), 0, 22, 70);
        closeSync(fd);
      },
    });
    const held = s.operator.heldHalt!;
    expect(held).toMatchObject({ reason: "halt_unreadable" });
    expect(s.operator.page.snapshot).toMatchObject({ halted: true, stopReason: "halt_unreadable" });
    // Written: the spoilt slot repaired with it, kept across the next restart.
    expect(new HaltStore(preparedPath).read()).toMatchObject({ halt: { id: held.id, reason: "halt_unreadable" }, lastClearedId: h1.id });
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: false, detail: expect.stringContaining("clearHalt first") });
    expect(await commandOf(s.engine, { kind: "clearHalt", haltId: held.id })).toMatchObject({ ok: true });
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
  });

  it("is written in place into a preallocated file — never a write that needs new room — and a write cut midway is a halt being written (Astra rounds 4 and 5)", () => {
    const temp = tempDir();
    cleanups.push(temp.remove);
    const path = join(temp.dir, "state", "halt.json");
    // Made, both slots preallocated, when the operator first reads it.
    expect(new HaltStore(path).read()).toEqual({ halt: null, lastClearedId: null });
    const made = statSync(path);
    expect(made.size).toBe(2 * SLOT_BYTES);
    const first = { id: "66666666-6666-4666-8666-666666666666", reason: "header_mismatch" as const, atWall: 1_000 };
    const store = new HaltStore(path);
    store.read();
    store.write({ halt: first, lastClearedId: null });
    store.write({ halt: null, lastClearedId: first.id });
    store.write({ halt: { ...first, id: "77777777-7777-4777-8777-777777777777" }, lastClearedId: first.id });
    // The same file (the same inode), the same size: written in place.
    expect(statSync(path)).toMatchObject({ ino: made.ino, size: 2 * SLOT_BYTES });
    expect(new HaltStore(path).read()).toEqual({ halt: { ...first, id: "77777777-7777-4777-8777-777777777777" }, lastClearedId: first.id });
    // The next write is cut midway (its slot — the older one — spoilt): a
    // halt was being written, so one is held; the last clear is kept.
    const fd = openSync(path, "r+");
    writeSync(fd, Buffer.from("cut"), 0, 3, 1 * SLOT_BYTES + 10);
    closeSync(fd);
    expect(new HaltStore(path).read()).toMatchObject({ halt: { reason: "halt_unreadable" }, lastClearedId: first.id, unreadable: true });
  });

  it("says the last halt cleared, kept across a restart: the owner's clearHalt, and one for a halt it no longer holds", async () => {
    const s = await setUp({ exitIp: () => "198.51.100.9" });
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.heldHalt !== null, 10_000, "the halt held");
    const held = s.operator.heldHalt!;
    expect(s.operator.state.lastClearedHaltId ?? null).toBeNull();
    expect(await commandOf(s.engine, { kind: "clearHalt", haltId: held.id })).toMatchObject({ ok: true });
    expect(s.operator.state).toMatchObject({ halt: null, lastClearedHaltId: held.id });
    await s.operator.stop();
    await s.engine.close();
    const next = await s.newOperator();
    expect(next.state).toMatchObject({ halt: null, lastClearedHaltId: held.id });
    // A halt it does not hold (lost before): the owner's word, said as cleared.
    const engine = new FakeEngine();
    await engine.connect(s.rpcPort());
    cleanups.push(() => engine.close());
    engine.send(hello({ socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await engine.waitFor("helloResult");
    expect(await commandOf(engine, { kind: "clearHalt", haltId: "88888888-8888-4888-8888-888888888888" })).toMatchObject({ ok: true, detail: "no halt is held" });
    expect(next.state.lastClearedHaltId).toBe("88888888-8888-4888-8888-888888888888");
  });
});

describe("a failed Chrome's profile-writing quit (F7)", () => {
  it("finishes the old quit before a concurrent restart can start a new Chrome", async () => {
    const s = await setUp(); s.model.shows.timeZone = "UTC";
    let release: () => void = () => undefined; let closing = false;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const previous = s.chrome.handlers.get("Browser.close");
    s.chrome.handlers.set("Browser.close", async (c) => { closing = true; await waiting; return previous?.(c) ?? {}; });
    await command(s.engine, "restartBrowser");
    await until(() => closing, 5000, "old Chrome asked to quit");
    delete s.model.shows.timeZone;
    const restart = command(s.engine, "restartBrowser");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(s.control.calls.filter((c) => c === "start")).toHaveLength(1);
    release(); await restart;
    await until(() => s.control.calls.filter((c) => c === "start").length === 2 && s.operator.page.step === "site_loaded", START_MS, "new Chrome loaded the site");
    expect(s.control.calls).not.toContain("kill");
    expect(s.operator.egress.exitOpen).toBe(true);
  });

  it("closes the exit, then asks Browser.close before forcing a failed startup down", async () => {
    const s = await setUp();
    s.model.shows.timeZone = "UTC";
    const previous = s.chrome.handlers.get("Browser.close");
    let closedExit = false;
    s.chrome.handlers.set("Browser.close", (c) => { closedExit = !s.operator.egress.exitOpen; return previous?.(c) ?? {}; });
    await command(s.engine, "restartBrowser");
    await until(() => s.operator.page.snapshot.stopReason === "env_mismatch" && !s.chrome.running, 5000, "failed Chrome down");
    expect(s.chrome.sent("Browser.close")).toHaveLength(1);
    expect(closedExit).toBe(true);
    expect(s.control.calls).not.toContain("kill");
  });
});

describe("the page's environment (plan §4.1, step 2; PR 5)", () => {
  const evaluations = (s: SetUp, marker: string) => s.chrome.sent("Runtime.evaluate").filter((command) => String(command.params.expression).includes(marker));

  it("halts before Chrome when X retained the pilot's resized screen, with a restart-X reason", async () => {
    const s = await setUp();
    s.control.geometry = { width: 1728, height: 936, depth: 24 };
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.snapshot.halted, 4000, "the changed X screen is held");
    expect(s.operator.page.snapshot).toMatchObject({ step: "exit_closed", stopReason: "env_mismatch", retryAtWall: null });
    expect(s.control.calls).not.toContain("start");
    await expect.poll(() => journal(s.logDir, "states"), SETTLED).toContainEqual(expect.objectContaining({ note: expect.stringContaining("restart the container's X server") }));
    const geometry = s.lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.e === "x.geometry");
    expect(geometry).toMatchObject({ width: 1728, height: 936, depth: 24, matches: false });
    expect(s.socks.connects).toEqual([]);
  });

  it("goes to Chrome's start from the hello, its position to every tab before it runs, and is verified in the browser", async () => {
    const s = await setUp();
    await started(s);
    // Chrome's start took the hello's time zone and languages from the hand-over.
    expect(readFileSync(s.chromeEnv, "utf8")).toBe("TZ=Europe/Berlin\nLANGUAGES=en-US,en\n");
    expect(s.model.handovers).toEqual(["TZ=Europe/Berlin\nLANGUAGES=en-US,en\n"]);
    const noteOf = (step: string) => journal(s.logDir, "states").find((line) => line.to === step)?.note;
    await expect.poll(() => noteOf("env_applied"), SETTLED).toBe("time zone Europe/Berlin; languages en-US, en; position 52.5, 13.4 ±50 m");
    await expect.poll(() => String(noteOf("control_attached")), SETTLED).toContain("environment verified: time zone Europe/Berlin");
    // The site's grant came before any tab could run; every tab got the position before it ran.
    const order = s.chrome.commands.map((command) => `${command.method}${command.sessionId ? `@${command.sessionId}` : ""}`);
    expect(s.model.grants[0]).toEqual({ origin: "https://fansly.com", context: null, permissions: ["geolocation"] });
    expect(order.indexOf("Browser.grantPermissions")).toBeLessThan(order.indexOf("Target.setAutoAttach"));
    for (const session of ["S1", "S2"]) {
      expect(order.indexOf(`Emulation.setGeolocationOverride@${session}`), session).toBeGreaterThan(-1);
      expect(order.indexOf(`Emulation.setGeolocationOverride@${session}`), session).toBeLessThan(order.indexOf(`Runtime.runIfWaitingForDebugger@${session}`));
      expect(s.model.overrides.get(session), session).toEqual({ latitude: 52.5, longitude: 13.4, accuracy: 50 });
    }
    // The check page: in a throwaway context, granted there only, its
    // document answered by the operator — nothing sent — and the context gone.
    expect(s.model.grants[1]).toEqual({ origin: "http://127.0.0.1", context: "C1", permissions: ["geolocation"] });
    expect(s.model.requests.filter((request) => request.url === "http://127.0.0.1/pb-env-check").map((request) => request.outcome)).toEqual(["fulfilled"]);
    expect(s.model.disposed).toEqual(["C1"]);
    // The self-test's probe, and the site's document once the exit opened.
    expect(s.chrome.sent("Fetch.continueRequest").map((command) => s.model.requests.find((request) => request.interceptionId === command.params.requestId)?.url)).toEqual([expect.stringMatching(/^https:\/\/apiv3\.fansly\.com\/api\/v1\/pb-selftest\?pbst=/), "https://fansly.com/"]);
    await expect.poll(() => journal(s.logDir, "requests"), SETTLED).toContainEqual(expect.objectContaining({ host: "127.0.0.1", path: "/pb-env-check", decision: "fulfilled" }));
    // What the browser showed, in the log.
    const verified = s.lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.e === "env.verified");
    expect(verified?.seen).toEqual({
      timeZone: "Europe/Berlin",
      settingsTimeZone: "Europe/Berlin",
      languages: ["en-US", "en"],
      language: "en-US",
      screen: { width: 1920, height: 1080 },
      geolocation: { latitude: 52.5, longitude: 13.4, accuracy: 50 },
    });
    // The work tab was read from an isolated world, never its main one.
    expect(evaluations(s, "pbEnvShown").every((command) => typeof command.params.contextId === "number")).toBe(true);
  });

  it.each([
    ["a time zone", { timeZone: "UTC" }, "time zone UTC, not Europe/Berlin"],
    ["languages Chrome extends with its UI language's defaults", { languages: ["en-US", "en", "en-GB"] }, "Chrome adds its UI language's defaults"],
    ["a position", { position: { latitude: 0, longitude: 0, accuracy: 50 } }, "position 0, 0 ±50 m, not 52.5, 13.4 ±50 m"],
  ])("%s the browser does not show as set fails the start: env_mismatch, the exit never opens, and it is tried again", async (_what, shows, reason) => {
    const s = await setUp();
    Object.assign(s.model.shows, shows);
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.snapshot.stopReason === "env_mismatch", 10_000, "the failure");
    expect(s.operator.page.snapshot).toMatchObject({ step: "exit_closed", halted: false, retryAtWall: expect.any(Number) });
    // The journal is written through a stream: its line may lag the state.
    await until(() => journal(s.logDir, "states").some((line) => line.stopReason === "env_mismatch"), 3000, "the journal's line");
    const failure = journal(s.logDir, "states").find((line) => line.stopReason === "env_mismatch");
    expect(String(failure?.note)).toContain(reason);
    // The engine is told (its socket may still be delivering it).
    await s.engine.waitFor("state", (state) => state.stopReason === "env_mismatch");
    expect(s.engine.of("state").some((state) => state.exitOpen === true)).toBe(false);
    // No self-test, no exit IP: the start stopped at the check.
    expect(s.socks.connects).toEqual([]);
    await until(() => s.chrome.sent("Browser.close").length > 0, 5000, "failed Chrome asked to quit");
    await until(() => s.control.calls.filter((call) => call === "start").length >= 2, 5000, "a retry");
  });

  it("holds a screen mismatch found after Chrome starts with the same restart-X explanation", async () => {
    const s = await setUp();
    s.model.shows.screen = { width: 800, height: 600 };
    await command(s.engine, "restartBrowser");
    await until(() => s.operator.page.snapshot.halted, 5000, "screen mismatch held");
    expect(s.operator.page.snapshot).toMatchObject({ stopReason: "env_mismatch", retryAtWall: null });
    await expect.poll(() => journal(s.logDir, "states"), SETTLED).toContainEqual(expect.objectContaining({ note: expect.stringContaining("Chrome sees 800×600") }));
  });

  it("is verified again on every start: after Chrome crashed, and then a difference fails that start", async () => {
    const s = await setUp();
    await started(s);
    expect(evaluations(s, "pbEnvShown")).toHaveLength(1);
    await s.chrome.shutdown();
    await until(() => s.operator.page.snapshot.stopReason === "chrome_crashed", 3000);
    await until(() => s.operator.page.step === "site_loaded", START_MS, "the page back");
    expect(evaluations(s, "pbEnvShown")).toHaveLength(2);
    expect(s.model.handovers).toHaveLength(2);
    // The same profile, a Chrome that now shows another zone.
    s.model.shows.timeZone = "America/New_York";
    await s.chrome.shutdown();
    await until(() => s.operator.page.snapshot.stopReason === "env_mismatch", 10_000, "the difference found");
    expect(s.operator.egress.exitOpen).toBe(false);
  });

  it("changed by the engine starts the page again: Chrome takes the new one, and it is verified", async () => {
    const s = await setUp();
    await started(s);
    s.engine.close();
    await until(() => s.engine.closed !== null);
    const again = new FakeEngine();
    await again.connect(s.rpcPort());
    cleanups.push(() => again.close());
    const env = { timeZone: "Europe/Kyiv", languages: ["uk-UA", "uk", "en-US", "en"], geolocation: { latitude: 50.45, longitude: 30.52, accuracyM: 30 } };
    again.send(hello({ env, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await again.waitFor("helloResult");
    const kyiv = "TZ=Europe/Kyiv\nLANGUAGES=uk-UA,uk,en-US,en\n";
    await until(() => s.model.handovers.at(-1) === kyiv && s.operator.page.step === "site_loaded", 5000, "the page up again");
    expect(readFileSync(s.chromeEnv, "utf8")).toBe(kyiv);
    // One restart, nothing failed on the way.
    expect(s.model.handovers).toHaveLength(2);
    expect(journal(s.logDir, "states").some((line) => line.stopReason !== null)).toBe(false);
    expect(s.model.overrides.get(s.operator.control.workTab!.sessionId)).toEqual({ latitude: 50.45, longitude: 30.52, accuracy: 30 });
    // Chrome names the zone its own way (Europe/Kiev): the same zone.
    const verified = s.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.e === "env.verified").at(-1);
    expect(verified?.seen).toMatchObject({ timeZone: "Europe/Kiev", settingsTimeZone: "Europe/Kiev", languages: env.languages });
  });

  it("refuses a hello whose environment breaks its rules: the connection closes, nothing changes", async () => {
    const s = await setUp();
    await started(s);
    s.engine.close();
    await until(() => s.engine.closed !== null);
    const bad = new FakeEngine();
    await bad.connect(s.rpcPort());
    cleanups.push(() => bad.close());
    bad.send(hello({ env: { timeZone: "Europe/Berlin; touch /tmp/pb", languages: ["en-US"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } }, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await until(() => bad.closed !== null, 3000, "the connection to close");
    expect(bad.of("helloResult")).toEqual([]);
    expect(readFileSync(s.chromeEnv, "utf8")).toBe("TZ=Europe/Berlin\nLANGUAGES=en-US,en\n");
    expect(s.operator.page.step).toBe("site_loaded");
  });
});

describe("secrets", () => {
  it("never reach the journals or the process log", async () => {
    const s = await setUp();
    await started(s);
    s.model.pause("https://apiv3.fansly.com/api/v1/account/me?token=QUERY-SECRET-42", "GET");
    await command(s.engine, "closeExit");
    await command(s.engine, "openExit");
    await command(s.engine, "stopPage");
    await s.operator.journals.close();
    const files = readdirSync(s.logDir).map((name) => readFileSync(join(s.logDir, name), "utf8"));
    expect(files.length).toBeGreaterThan(0);
    const everything = [...files, ...s.lines].join("\n");
    for (const secret of [SOCKS_PASSWORD, SOCKS_USER, RPC_TOKEN, "QUERY-SECRET-42"]) expect(everything, secret).not.toContain(secret);
    // What is there is the facts.
    expect(everything).toContain("/api/v1/account/me");
    expect(everything).toContain("refused: exit closed");
  });
});

describe("the buffer (plan §4.4; spec §5, §6.2; PR 11)", () => {
  const bufferHello = (s: SetUp, overrides: Record<string, unknown> = {}, params?: Record<string, unknown>) =>
    hello({ socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD }, ...overrides }, params);
  const eventsOf = (engine: FakeEngine) => engine.of("events").flatMap((message) => message.events as Array<Record<string, unknown>>);
  const seqs = (engine: FakeEngine) => eventsOf(engine).map((event) => event.seq as number);

  async function reconnect(s: SetUp, previous: FakeEngine = s.engine): Promise<FakeEngine> {
    previous.close();
    await until(() => !s.operator.rpc.linkUp, 3000, "the old link to go");
    const again = new FakeEngine();
    await again.connect(s.rpcPort());
    cleanups.push(() => again.close());
    again.send(bufferHello(s));
    await again.waitFor("helloResult");
    return again;
  }

  async function durable(appended: ReturnType<Operator["buffer"]["append"]>): Promise<void> {
    if (!appended.ok) throw new Error(`refused: ${appended.reason}`);
    expect(await appended.durable).toMatchObject({ ok: true });
  }

  it("streams what the producers wrote, in order, to the engine that subscribed; after a reconnect it resumes from the last ack; a foreign buffer's ack is refused", async () => {
    const s = await setUp();
    const bufferId = s.engine.last("helloResult")!.bufferId as string;
    expect(bufferId).toBe(s.operator.buffer.id);
    // The operator's start is a gap in the socket's stream (PR 10).
    await until(() => s.operator.buffer.lastSeq === 1, 3000, "the operator's start gap");
    for (let n = 1; n < 30; n++) s.operator.buffer.append(wsFrame(n));
    await durable(s.operator.buffer.append(wsFrame(30)));
    // state.buffer is real now: a state sent after the writes carries their
    // bytes (an earlier one may carry the start gap's alone).
    const bytes = s.operator.buffer.stats().bytes;
    const state = await s.engine.waitFor("state", (message) => (message.buffer as { bytes: number }).bytes === bytes);
    // And what the open buffer holds: its id, its last number, nothing uncommitted.
    expect(state.buffer).toEqual({ bytes, oldestAgeMs: expect.any(Number), open: { id: bufferId, lastSeq: 31, outcomes: 0, pending: 0 } });
    s.engine.send({ type: "events.subscribe", ownerGeneration: 1, bufferId, afterSeq: 0 });
    await until(() => seqs(s.engine).length === 31, 5000, "31 events");
    expect(seqs(s.engine)).toEqual(Array.from({ length: 31 }, (_, n) => n + 1));
    expect(eventsOf(s.engine)[0]).toMatchObject({ kind: "gap", fromSeq: null, fromWall: null, reason: "operator_start" });
    expect(eventsOf(s.engine)[1]).toMatchObject({ kind: "ws.in", connectionId: "conn-1", atWall: expect.any(Number), atMono: expect.any(Number) });
    s.engine.send({ type: "ack", ownerGeneration: 1, bufferId, uptoSeq: 21 });
    await until(() => s.operator.buffer.stats().events === 10, 3000, "the acknowledged events to go");
    // Live: a new event goes out once it is durable.
    s.operator.buffer.append(wsFrame(31));
    await until(() => seqs(s.engine).includes(32), 3000, "event 32");
    // The engine goes and comes back (a Hub deploy): from its last ack.
    const again = await reconnect(s);
    again.send({ type: "events.subscribe", ownerGeneration: 1, bufferId, afterSeq: 21 });
    await until(() => seqs(again).length === 11, 5000, "the rest");
    expect(seqs(again)).toEqual(Array.from({ length: 11 }, (_, n) => n + 22));
    // The late ack of a buffer from before the volume was made anew.
    again.send({ type: "ack", ownerGeneration: 1, bufferId: "11111111-1111-4111-8111-111111111111", uptoSeq: 32 });
    expect(await again.waitFor("events.refused")).toEqual({ type: "events.refused", of: "ack", reason: "foreign_buffer", bufferId, givenBufferId: "11111111-1111-4111-8111-111111111111", givenSeq: 32 });
    await s.operator.buffer.flush();
    expect(s.operator.buffer.stats().events).toBe(11);
    // A restarted operator keeps the buffer, its id and its numbers — and
    // marks its own start in the stream, from the last event saved.
    await s.operator.stop();
    const next = await s.newOperator();
    expect(next.buffer.id).toBe(bufferId);
    await until(() => next.buffer.lastSeq === 33, 3000, "the new operator's start gap");
    const restartGap = JSON.parse(next.buffer.readEvents(32, 1, 1_000_000)[0]!.json) as Record<string, unknown>;
    expect(restartGap).toMatchObject({ seq: 33, kind: "gap", fromSeq: 32, reason: "operator_start" });
  });

  it("sends an attempt's outcome once durable, again on every new connection until its resultAck; recover resends what it has", async () => {
    const s = await setUp();
    await durable(s.operator.buffer.putOutcome(hubResult(501)));
    expect(await s.engine.waitFor("result")).toEqual(hubResult(501));
    const again = await reconnect(s);
    await again.waitFor("result", (message) => message.attemptId === 501);
    again.send({ type: "recover", ownerGeneration: 1, attemptIds: [501, 502, 501] });
    const recovered = await again.waitFor("recoverResult");
    expect(recovered.attempts).toEqual([
      { attemptId: 501, state: "outcome_resent" },
      { attemptId: 502, state: "unknown" },
    ]);
    // The outcome came again before the answer that says so.
    const order = again.messages.map((message) => message.type);
    expect(order.lastIndexOf("result")).toBeLessThan(order.indexOf("recoverResult"));
    expect(again.of("result")).toHaveLength(2);
    again.send({ type: "resultAck", ownerGeneration: 1, attemptId: 501 });
    await until(() => s.operator.buffer.stats().outcomes === 0, 3000, "the outcome to go");
    const third = await reconnect(s, again);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(third.of("result")).toEqual([]);
  });

  it("full: writes refused, the exit closed, the page stopped with buffer_full and alarms; once the engine takes the backlog, the gap and the page starts again", async () => {
    const s = await setUp({ params: { bufferCap: { bytes: 20_000, ageMs: 3_600_000, alarmPercents: [50, 80] }, restartBackoffMs: [60_000] }, buffer: { checkEveryMs: 50 } });
    await started(s);
    let refused: string | null = null;
    for (let n = 1; n <= 200 && refused === null; n++) {
      const appended = s.operator.buffer.append(wsFrame(n, 900));
      if (appended.ok) await appended.durable;
      else refused = appended.reason;
    }
    expect(refused).toBe("buffer_full");
    await until(() => s.operator.page.snapshot.stopReason === "buffer_full", 5000, "the stop");
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.operator.admissionsOpen()).toBe(false);
    expect(s.operator.page.halted).toBe(false);
    await until(() => s.engine.of("alarm").filter((alarm) => alarm.kind === "buffer").length >= 3, 3000, "the alarms");
    expect(s.engine.of("alarm").map((alarm) => [alarm.kind, (alarm.detail as Record<string, unknown>).percent, (alarm.detail as Record<string, unknown>).full ?? false])).toEqual([
      ["buffer", 50, false],
      ["buffer", 80, false],
      ["buffer", 100, true],
    ]);
    // No start while it is full: the engine's restartBrowser fails at the gate.
    const starts = s.control.calls.filter((call) => call === "start").length;
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.control.calls.filter((call) => call === "start")).toHaveLength(starts);
    expect(s.operator.page.snapshot.stopReason).toBe("buffer_full");
    // The engine takes everything: room, the gap, and the page goes again.
    const last = s.operator.buffer.lastSeq;
    s.engine.send({ type: "events.subscribe", ownerGeneration: 1, bufferId: s.operator.buffer.id, afterSeq: 0 });
    await until(() => seqs(s.engine).includes(last), 5000, "the backlog");
    s.engine.send({ type: "ack", ownerGeneration: 1, bufferId: s.operator.buffer.id, uptoSeq: last });
    await until(() => eventsOf(s.engine).some((event) => event.kind === "gap" && event.reason === "buffer_full"), 5000, "the gap");
    expect(eventsOf(s.engine).find((event) => event.kind === "gap" && event.reason === "buffer_full")).toMatchObject({ seq: last + 1, fromSeq: last, reason: "buffer_full" });
    await until(() => s.operator.page.step === "site_loaded", START_MS, "the page to start again");
    expect(s.operator.admissionsOpen()).toBe(true);
  });

  it("a full disk keeps the page from starting (disk_full); room again, and it starts", async () => {
    let free = 500;
    const s = await setUp({ params: { restartBackoffMs: [60_000] }, buffer: { diskFree: () => free, minFreeBytes: 1000, checkEveryMs: 50 } });
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.snapshot.stopReason === "disk_full", 5000, "the start to fail");
    expect(s.control.calls).not.toContain("start");
    expect(s.engine.of("alarm")).toContainEqual(expect.objectContaining({ kind: "buffer", detail: expect.objectContaining({ full: true, reason: "disk_full" }) }));
    free = 10_000;
    await until(() => s.operator.page.step === "site_loaded", START_MS, "the page to start");
    // The buffer's own gap, then the start's — refused while the disk was
    // full, written once there was room, from its first boundary.
    await until(() => s.operator.buffer.lastSeq === 2, 3000, "the start's gap");
    s.engine.send({ type: "events.subscribe", ownerGeneration: 1, bufferId: s.operator.buffer.id, afterSeq: 0 });
    await until(() => eventsOf(s.engine).length === 2, 3000, "the gaps");
    expect(eventsOf(s.engine)).toMatchObject([
      { kind: "gap", seq: 1, fromSeq: null, reason: "disk_full" },
      { kind: "gap", seq: 2, fromSeq: null, fromWall: null, reason: "operator_start" },
    ]);
  });
});

describe("the buffer under stress (Astra's review of PR 11)", () => {
  it("replays a large backlog of outcomes a page at a time, waiting for a stuck engine's socket; repeated recovers do not pile up copies", async () => {
    const s = await setUp();
    s.engine.close();
    await until(() => !s.operator.rpc.linkUp, 3000, "the engine to go");
    // 3000 outcomes of ~6 KB: ~18 MB waiting for their resultAck.
    const count = 3000;
    const big = (attemptId: number) => hubResult(attemptId, 200, 6000);
    for (let id = 1; id < count; id++) s.operator.buffer.putOutcome(big(id));
    const last = s.operator.buffer.putOutcome(big(count));
    if (!last.ok) throw new Error("refused");
    await last.durable;
    const engine = new RawEngine();
    cleanups.push(() => engine.close());
    await engine.connect(s.rpcPort());
    engine.send(hello({ socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await engine.waitFor("helloResult");
    // The engine stops reading (stuck, or slow on its database).
    engine.pause();
    const peak = async (ms: number) => {
      let max = 0;
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 10))) max = Math.max(max, s.operator.rpc.backlog());
      return max;
    };
    // What the operator holds for it stays small: no more than the mark
    // and one outcome, not the backlog.
    expect(await peak(400)).toBeLessThanOrEqual(REPLAY_HIGH_WATER + 64 * 1024);
    // The engine asks again and again: the asks are merged, not stacked.
    const ids = Array.from({ length: count }, (_, n) => n + 1);
    for (let n = 0; n < 100; n++) engine.send({ type: "recover", ownerGeneration: 1, attemptIds: ids });
    expect(await peak(400)).toBeLessThanOrEqual(REPLAY_HIGH_WATER + 64 * 1024);
    expect(s.operator.replay.queued).toBeLessThanOrEqual(1);
    // It reads again: every outcome once from the replay, once for the
    // merged recover, then one answer that names them all.
    engine.resume();
    const answer = await engine.waitFor("recoverResult", () => true, 30_000);
    expect((answer.attempts as Array<{ state: string }>).every((attempt) => attempt.state === "outcome_resent")).toBe(true);
    expect((answer.attempts as unknown[]).length).toBe(count);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(engine.of("recoverResult")).toHaveLength(1);
    expect(engine.of("result")).toHaveLength(2 * count);
    expect(new Set(engine.of("result").map((result) => result.attemptId)).size).toBe(count);
  }, 60_000);

  it("a corrupt buffer does not take the operator down: the RPC, the heartbeat and the refusing proxy run, the page stands with buffer_unavailable, the engine is alarmed, Chrome never starts, the file stays as it is", async () => {
    const garbage = Buffer.from("this is not a database, but the owner's to look at. ".repeat(100));
    let file = "";
    const s = await setUp({
      buffer: { openRetryMs: [20] },
      prepare: ({ bufferDir }) => {
        mkdirSync(bufferDir, { recursive: true });
        file = join(bufferDir, DB_FILE);
        writeFileSync(file, garbage);
      },
    });
    expect(s.engine.last("helloResult")).toMatchObject({ ok: true, state: { stopReason: "buffer_unavailable", exitOpen: false } });
    const alarm = await s.engine.waitFor("alarm", (message) => message.kind === "buffer");
    expect(alarm.detail).toMatchObject({ unavailable: true, cause: "corrupt", recoverable: false });
    // The heartbeat goes on.
    const beat = statSync(join(s.dir, "alive")).mtimeMs;
    await until(() => statSync(join(s.dir, "alive")).mtimeMs > beat, 3000, "a heartbeat");
    // The proxy is there, and refuses.
    const { status, socket } = await proxyConnect(s.model.proxyPort, "apiv3.fansly.com:443");
    socket.destroy();
    expect(status).toBe(403);
    // The engine's start goes no further than the gate: no Chrome.
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.snapshot.stopReason === "buffer_unavailable" && !s.operator.page.halted, 5000, "the start to fail at the gate");
    expect(s.control.calls).not.toContain("start");
    expect(s.operator.admissionsOpen()).toBe(false);
    // A subscription is refused, saying why.
    s.engine.send({ type: "events.subscribe", ownerGeneration: 1, bufferId: s.operator.buffer.id, afterSeq: 0 });
    expect(await s.engine.waitFor("events.refused")).toMatchObject({ reason: "unavailable" });
    // Not opened again, and the file is exactly as it was.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(s.operator.buffer.unavailable?.attempts).toBe(1);
    expect(readFileSync(file).equals(garbage)).toBe(true);
  });

  it("a buffer that cannot be opened says so in its state, through a stopPage too — its 0 bytes are no word that it is empty; once it opens, the state says what it holds (Astra PR 14 round 2)", async () => {
    let holder: EventBuffer | null = null;
    const s = await setUp({
      buffer: { openRetryMs: [50] },
      prepare: ({ bufferDir, stateDir }) => {
        mkdirSync(stateDir, { recursive: true });
        holder = new EventBuffer({ dir: bufferDir, idFile: join(stateDir, "buffer-id"), minFreeBytes: 0, log: quiet });
      },
    });
    const held = holder as unknown as EventBuffer;
    expect(s.engine.last("helloResult")).toMatchObject({ state: { stopReason: "buffer_unavailable", buffer: { bytes: 0, open: null } } });
    // The engine stops the page (a page leaving its browser): the stop
    // reason is the stop's now, the bytes still 0 — and `open` still null.
    expect(await command(s.engine, "stopPage")).toMatchObject({ ok: true });
    const stopped = await s.engine.waitFor("state", (state) => state.stopReason === "owner_stop");
    expect(stopped).toMatchObject({ exitOpen: false, step: "exit_closed", buffer: { bytes: 0, open: null } });
    await held.close();
    await until(() => s.operator.buffer.unavailable === null, 5000, "the open");
    // What it holds once its writes settle — the state sent at the open may
    // come before the operator's start gap is committed (a later one says it).
    await until(() => s.operator.buffer.stats().lastSeq === 1 && s.operator.buffer.stats().pending === 0, 5000, "the operator's start gap committed");
    const holds = s.operator.buffer.stats();
    const opened = await s.engine.waitFor("state", (state) => {
      const buffer = state.buffer as { bytes: number; open: { lastSeq: number; pending: number } | null };
      return buffer.open !== null && buffer.open.lastSeq === holds.lastSeq && buffer.open.pending === 0 && buffer.bytes === holds.bytes;
    });
    expect(opened.buffer).toEqual({ bytes: holds.bytes, oldestAgeMs: expect.any(Number), open: { id: held.id, lastSeq: 1, outcomes: 0, pending: 0 } });
  });

  it("a locked buffer is opened again once the lock goes: the page then stands as usual and starts on the engine's word", async () => {
    let holder: EventBuffer | null = null;
    const s = await setUp({
      buffer: { openRetryMs: [50] },
      prepare: ({ bufferDir, stateDir }) => {
        mkdirSync(stateDir, { recursive: true });
        holder = new EventBuffer({ dir: bufferDir, idFile: join(stateDir, "buffer-id"), minFreeBytes: 0, log: quiet });
      },
    });
    const held = holder as unknown as EventBuffer;
    // The id the buffer had, from its copy.
    expect(s.engine.last("helloResult")).toMatchObject({ bufferId: held.id, state: { stopReason: "buffer_unavailable" } });
    expect((await s.engine.waitFor("alarm", (message) => message.kind === "buffer")).detail).toMatchObject({ unavailable: true, cause: "locked", recoverable: true });
    await held.close();
    await until(() => s.operator.buffer.unavailable === null, 5000, "the open");
    expect(s.operator.page.snapshot).toEqual({ step: "exit_closed", stopReason: null, retryAtWall: null, halted: false });
    await s.engine.waitFor("state", (state) => state.stopReason === null);
    await started(s);
  });

  /** An engine linked with outcomes waiting for it, that stops reading. */
  async function stuckEngine(s: SetUp, count: number): Promise<RawEngine> {
    s.engine.close();
    await until(() => !s.operator.rpc.linkUp, 3000, "the engine to go");
    for (let id = 1; id < count; id++) s.operator.buffer.putOutcome(hubResult(id, 200, 6000));
    const last = s.operator.buffer.putOutcome(hubResult(count, 200, 6000));
    if (!last.ok) throw new Error("refused");
    await last.durable;
    const engine = new RawEngine();
    cleanups.push(() => engine.close());
    await engine.connect(s.rpcPort());
    engine.send(hello({ socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await engine.waitFor("helloResult");
    engine.pause();
    return engine;
  }

  it("an engine that asks about more attempts than are kept waiting, without reading the answers, is cut off: nothing goes around the socket's wait", async () => {
    const s = await setUp();
    const engine = await stuckEngine(s, 3000);
    let peak = 0;
    const sample = setInterval(() => (peak = Math.max(peak, s.operator.rpc.backlog())), 5);
    cleanups.push(() => clearInterval(sample));
    // Five asks of 10 000 attempts each, then the same 10 000 again and
    // again: 100 asks, past what waits for an answer.
    const asks = Array.from({ length: 6 }, (_, ask) => Array.from({ length: 10_000 }, (_, n) => 1_000_000 + ask * 10_000 + n));
    for (let n = 0; n < 100; n++) engine.send({ type: "recover", ownerGeneration: 1, attemptIds: asks[Math.min(n, 5)]! });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    clearInterval(sample);
    expect(peak).toBeLessThanOrEqual(REPLAY_HIGH_WATER + 64 * 1024);
    await until(() => !s.operator.rpc.linkUp, 5000, "the connection to be closed");
    expect(s.lines.some((line) => line.includes('"e":"protocol.error"') && line.includes("recover"))).toBe(true);
    expect(s.lines.some((line) => line.includes('"e":"recover.refused"') && line.includes(`"cap":${MAX_WAITING}`))).toBe(true);
    expect(s.operator.replay.queued).toBe(0);
  }, 30_000);

  it("a superseded engine that stopped reading does not hold up its successor: the new one gets every outcome and its recover's answer", async () => {
    const s = await setUp();
    await stuckEngine(s, 3000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The replay waits on the stuck socket. A new owner connects.
    const next = new FakeEngine();
    next.generation = 2;
    await next.connect(s.rpcPort());
    cleanups.push(() => next.close());
    next.send(hello({ ownerGeneration: 2, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await next.waitFor("helloResult", (message) => message.ok === true);
    next.send({ type: "recover", ownerGeneration: 2, attemptIds: [1, 2, 3000, 4000] });
    // Well before the old socket's grace runs out (5 s).
    await until(() => new Set(next.of("result").map((result) => result.attemptId)).size === 3000, 3000, "every outcome on the new connection");
    expect(await next.waitFor("recoverResult", () => true, 3000)).toMatchObject({
      attempts: [
        { attemptId: 1, state: "outcome_resent" },
        { attemptId: 2, state: "outcome_resent" },
        { attemptId: 3000, state: "outcome_resent" },
        { attemptId: 4000, state: "unknown" },
      ],
    });
  }, 30_000);
});

describe("Hub requests through the page (PR 9; plan §4.2)", () => {
  const TOKEN = "fansly-token-OpErAtOr0123456789xyz";
  const CLIENT_ID = "720167541418230001";
  const SESSION_ID = "720167541418230002";
  const FINGERPRINT = sessionFingerprint(TOKEN, CLIENT_ID);
  const ME = "/api/v1/account/me";

  function sendOf(engine: FakeEngine, attemptId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = monoMs();
    return {
      type: "send",
      ownerGeneration: engine.generation,
      attemptId,
      route: "account.me",
      credentialsGeneration: "c".repeat(64),
      sessionFingerprint: FINGERPRINT,
      method: "GET",
      url: `https://apiv3.fansly.com${ME}?ngsw-bypass=true`,
      headers: {},
      kind: "api",
      maxBodyBytes: 32 * 1024 * 1024,
      sendDeadlineMono: now + 15_000,
      requestDeadlineMono: now + 20_000,
      ...overrides,
    };
  }

  async function again(s: SetUp, previous: FakeEngine): Promise<FakeEngine> {
    previous.close();
    await until(() => !s.operator.rpc.linkUp, 3000, "the old link to go");
    const engine = new FakeEngine();
    await engine.connect(s.rpcPort());
    cleanups.push(() => engine.close());
    engine.send(hello({ socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await engine.waitFor("helloResult");
    return engine;
  }

  it("before the site is loaded: answered, never started; kept until its resultAck; a repeated id does nothing twice", async () => {
    const s = await setUp();
    // The site's document never comes: the page stays at the open exit.
    s.model.siteLoads = "never";
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "exit_open", START_MS, "the open exit");
    const send = sendOf(s.engine, 9001);
    s.engine.send(send);
    const result = await s.engine.waitFor("result", (message) => message.attemptId === 9001);
    expect(result).toEqual({ type: "result", attemptId: 9001, sessionFingerprint: FINGERPRINT, outcome: { kind: "transport_error", sent: false, message: "the page is not ready: the site is not loaded in the work tab" } });
    s.engine.send(send);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(s.engine.of("result")).toHaveLength(1);
    expect(s.chrome.sent("Runtime.callFunctionOn").filter((command) => command.params.functionDeclaration === ISSUE)).toEqual([]);
    expect(s.operator.buffer.stats().outcomes).toBe(1);
    s.engine.send({ type: "resultAck", ownerGeneration: 1, attemptId: 9001 });
    await until(() => s.operator.buffer.stats().outcomes === 0, 3000, "the outcome to go");
    // Acknowledged, and asked again: still nothing.
    s.engine.send(send);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(s.engine.of("result")).toHaveLength(1);
  });

  it("end to end: the session from the site's own request, the check, the real proxy and gate, the body in frames before its result, no secret anywhere", async () => {
    const s = await setUp();
    const server = await tlsLikeServer();
    cleanups.push(server.close);
    s.socks.routes.set("apiv3.fansly.com:443", server.port);
    await started(s);
    const tab = s.operator.control.workTab!;
    // The operator loaded the site in the work tab (step 8).
    expect(s.operator.control.workTab?.url).toBe("https://fansly.com/");
    // The site's own API request: its session learned as it stops; it waits
    // for the engine, which refuses it here.
    const siteHeaders = {
      Accept: "application/json, text/plain, */*",
      authorization: TOKEN,
      "fansly-client-check": fanslyClientCheck(ME, CLIENT_ID),
      "fansly-client-id": CLIENT_ID,
      "fansly-client-ts": String(Date.now()),
      "fansly-session-id": SESSION_ID,
      "User-Agent": "Mozilla/5.0",
    };
    const site = s.model.pause(`https://apiv3.fansly.com${ME}?ngsw-bypass=true`, "GET", tab.sessionId, "XHR", siteHeaders);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === FINGERPRINT);
    const ask = await s.engine.waitFor("siteAdmit");
    expect(ask).toMatchObject({ route: "account.me", sessionFingerprint: FINGERPRINT });
    s.engine.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: ask.siteRequestId, admit: false, reason: "route_hold" });
    await until(() => site.outcome === "failed", 3000, "the site's request to fail");
    s.engine.onMessage = (message) => {
      if (message.type === "check") s.engine.send({ type: "checkResult", ownerGeneration: 1, attemptId: message.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
    };
    s.engine.send(sendOf(s.engine, 9100));
    const result = await s.engine.waitFor("result", (message) => message.attemptId === 9100, 10_000);
    const outcome = result.outcome as { kind: string; status: number; headers: Record<string, string>; body: { bodyId: string; decodedBytes: number; sha256: string }; source: string; sentMono: number; sendMark: string };
    // The moment of the send is the gate's — the request's first bytes, on
    // this process's clock — never Chrome's timing (another clock's; Astra's
    // review of PR 15, round 5).
    const gateSent = s.engine.of("sent")[0]!.sentMono as number;
    expect(outcome).toMatchObject({ kind: "response", status: 200, headers: { "content-type": "application/json", "content-length": String(s.model.hubBody.length) }, source: "network", sentMono: gateSent, sendMark: "transport_reported" });
    expect(gateSent).toBe(s.operator.egress.gate.lastSend!.mono);
    expect(outcome.headers).not.toHaveProperty("set-cookie");
    expect(s.engine.of("check")).toEqual([{ type: "check", attemptId: 9100, pausedMono: expect.any(Number), liveSessionFingerprint: FINGERPRINT }]);
    // `sent`: the gate saw the request's first bytes, on a new connection.
    expect(s.engine.of("sent")).toEqual([{ type: "sent", attemptId: 9100, sentMono: expect.any(Number), sentWall: expect.any(Number), connectionReused: false }]);
    // What reached the server: the connection's records and the request, once.
    expect(server.received().length).toBe(300 + 58 + 70 + 90);
    // The body: one frame, the last, before the result that names it.
    expect(s.engine.frames).toHaveLength(1);
    const frame = decodeBodyFrame(s.engine.frames[0]!);
    expect(frame).toMatchObject({ bodyId: outcome.body.bodyId, part: 0, last: true });
    expect(frame.data.equals(s.model.hubBody)).toBe(true);
    expect(outcome.body).toEqual({ bodyId: frame.bodyId, decodedBytes: s.model.hubBody.length, sha256: createHash("sha256").update(s.model.hubBody).digest("hex") });
    expect(s.engine.order.indexOf("binary")).toBeLessThan(s.engine.order.indexOf("result"));
    // The journal: the Hub request by its real host and path, nothing more.
    await expect.poll(() => journal(s.logDir, "requests"), SETTLED).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", path: ME, admission: "hub attempt 9100", decision: "continued", result: "released under its admission" }));
    // A new connection gets it again, the body first.
    const next = await again(s, s.engine);
    await next.waitFor("result", (message) => message.attemptId === 9100);
    expect(next.order.indexOf("binary")).toBeLessThan(next.order.indexOf("result"));
    // Its resultAck: the outcome and its body's file go.
    next.send({ type: "resultAck", ownerGeneration: 1, attemptId: 9100 });
    await until(() => s.operator.buffer.stats().outcomes === 0, 3000, "the outcome to go");
    await until(() => readdirSync(join(s.dir, "buffer", "bodies")).length === 0, 3000, "the body's file to go");
    // No secret in any log line or journal.
    await s.operator.journals.flushed();
    const journals = readdirSync(s.logDir).map((name) => readFileSync(join(s.logDir, name), "utf8")).join("\n");
    for (const secret of [TOKEN, CLIENT_ID, SESSION_ID, fanslyClientCheck(ME, CLIENT_ID), "model-cookie-secret", '"success":true']) {
      expect(s.lines.join("\n"), secret).not.toContain(secret);
      expect(journals, secret).not.toContain(secret);
    }
  });

  it("recover: not_sent of a request the buffer says was never released, unknown of one that was", async () => {
    const s = await setUp({
      prepare: ({ bufferDir, stateDir }) => {
        mkdirSync(stateDir, { recursive: true });
        const buffer = new EventBuffer({ dir: bufferDir, idFile: join(stateDir, "buffer-id"), minFreeBytes: 0, log: quiet });
        buffer.markAttempt(7001, "issued");
        buffer.markAttempt(7002, "issued");
        buffer.markAttempt(7002, "released");
        void buffer.flush();
        void buffer.close();
      },
    });
    s.engine.send({ type: "recover", ownerGeneration: 1, attemptIds: [7001, 7002, 7003] });
    expect((await s.engine.waitFor("recoverResult")).attempts).toEqual([
      { attemptId: 7001, state: "not_sent" },
      { attemptId: 7002, state: "unknown" },
      { attemptId: 7003, state: "unknown" },
    ]);
    // A repeated send of either: what is known, never a request.
    s.engine.send(sendOf(s.engine, 7001));
    expect((await s.engine.waitFor("result", (message) => message.attemptId === 7001)).outcome).toEqual({ kind: "transport_error", sent: false, message: "the operator restarted before the request was released" });
    expect(s.chrome.sent("Runtime.callFunctionOn").filter((command) => command.params.functionDeclaration === ISSUE)).toEqual([]);
  });

  it("parses a send and a check's answer strictly: a malformed one closes the connection", async () => {
    const s = await setUp();
    s.engine.send({ ...sendOf(s.engine, 1), kind: "document" });
    await until(() => s.engine.closed !== null, 3000, "the connection to close");
  });
});

describe("the site's own requests (PR 7; plan §4.1 steps 8–10, §4.3, §4.9)", () => {
  const TOKEN = "fansly-token-SiTeOpEr0123456789xyz";
  const CLIENT_ID = "720167541418230021";
  const FINGERPRINT = sessionFingerprint(TOKEN, CLIENT_ID);
  const ME = "/api/v1/account/me";

  function headersOf(token = TOKEN, path = ME): Record<string, string> {
    return { Accept: "application/json, text/plain, */*", authorization: token, "fansly-client-check": fanslyClientCheck(path, CLIENT_ID), "fansly-client-id": CLIENT_ID, "fansly-client-ts": String(Date.now()), "fansly-session-id": "720167541418230022" };
  }

  it("end to end: asked of the engine, admitted, through the real proxy and gate; its answer's body in frames before the batch that names it; siteDone until its resultAck; no secret anywhere", async () => {
    const s = await setUp();
    const server = await tlsLikeServer();
    cleanups.push(server.close);
    s.socks.routes.set("apiv3.fansly.com:443", server.port);
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    s.engine.onMessage = (message) => {
      if (message.type === "siteAdmit") s.engine.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: message.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: 8100 });
    };
    s.engine.send({ type: "events.subscribe", ownerGeneration: 1, bufferId: s.operator.buffer.id, afterSeq: 0 });
    const request = s.model.pause(`https://apiv3.fansly.com${ME}?ngsw-bypass=true`, "GET", tab, "XHR", headersOf());
    const done = await s.engine.waitFor("siteDone", () => true, 10_000);
    const ask = s.engine.of("siteAdmit")[0]!;
    expect(ask).toMatchObject({ method: "GET", host: "apiv3.fansly.com", path: ME, query: "?ngsw-bypass=true", route: "account.me", operation: "read", sessionFingerprint: FINGERPRINT });
    expect(done).toEqual({
      type: "siteDone",
      siteRequestId: ask.siteRequestId,
      attemptId: 8100,
      sent: true,
      // The gate's moment of the send — the request's first bytes, on this
      // process's clock — never Chrome's timing (another clock's).
      sentMono: s.operator.egress.gate.lastSend!.mono,
      sentWall: expect.any(Number),
      connectionReused: false,
      status: 200,
      retryAfter: null,
      error: null,
      body: "buffered",
    });
    expect(request.outcome).toBe("continued");
    // What reached the server: the connection's records and the request, once.
    expect(server.received().length).toBe(300 + 58 + 70 + 90);
    // The answer in the stream: its body's frame first, then the batch.
    const batch = await s.engine.waitFor("events", (message) => (message.events as Array<{ kind: string }>).some((event) => event.kind === "site.response"));
    const response = (batch.events as Array<Record<string, unknown>>).find((event) => event.kind === "site.response")!;
    expect(response).toMatchObject({
      siteRequestId: ask.siteRequestId,
      attemptId: 8100,
      route: "account.me",
      method: "GET",
      path: ME,
      query: "?ngsw-bypass=true",
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(s.model.siteBody.length) },
      complete: true,
      source: "network",
      sessionFingerprint: FINGERPRINT,
      body: { decodedBytes: s.model.siteBody.length, sha256: createHash("sha256").update(s.model.siteBody).digest("hex") },
    });
    expect(response.headers).not.toHaveProperty("set-cookie");
    expect(s.engine.frames).toHaveLength(1);
    const frame = decodeBodyFrame(s.engine.frames[0]!);
    expect(frame).toMatchObject({ bodyId: (response.body as { bodyId: string }).bodyId, part: 0, last: true });
    expect(frame.data.equals(s.model.siteBody)).toBe(true);
    expect(s.engine.order.indexOf("binary")).toBeLessThan(s.engine.order.lastIndexOf("events"));
    // The journal: released under its admission, and its end.
    const requests = () => journal(s.logDir, "requests");
    await expect.poll(requests, SETTLED).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", path: ME, admission: `site request ${String(ask.siteRequestId)} (attempt 8100)`, decision: "continued", result: "released under its admission" }));
    await expect.poll(requests, SETTLED).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", path: ME, decision: "ended", status: 200, result: "200, body buffered" }));
    // A new connection gets the end again, until its resultAck.
    const next = new FakeEngine();
    s.engine.close();
    await until(() => !s.operator.rpc.linkUp, 3000, "the old link to go");
    await next.connect(s.rpcPort());
    cleanups.push(() => next.close());
    next.send(hello({ socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await next.waitFor("helloResult");
    expect(await next.waitFor("siteDone")).toMatchObject({ attemptId: 8100, status: 200 });
    next.send({ type: "resultAck", ownerGeneration: 1, attemptId: 8100 });
    await until(() => s.operator.buffer.stats().outcomes === 0, 3000, "the end to go");
    // The engine's ack of the event: the body's file goes with it.
    next.send({ type: "events.subscribe", ownerGeneration: 1, bufferId: s.operator.buffer.id, afterSeq: response.seq as number });
    await until(() => readdirSync(join(s.dir, "buffer", "bodies")).length === 0, 3000, "the body's file to go");
    // No secret in any log line or journal.
    await s.operator.journals.flushed();
    const journals = readdirSync(s.logDir).map((name) => readFileSync(join(s.logDir, name), "utf8")).join("\n");
    for (const secret of [TOKEN, CLIENT_ID, fanslyClientCheck(ME, CLIENT_ID), "model-cookie-secret", "300000000000000001"]) {
      expect(s.lines.join("\n"), secret).not.toContain(secret);
      expect(journals, secret).not.toContain(secret);
    }
  });

  /** The engine's identity read through the browser (a Hub request). */
  const identity = (attemptId: number, fingerprint: string) => ({
    type: "send",
    ownerGeneration: 1,
    attemptId,
    route: "account.me",
    credentialsGeneration: "c".repeat(64),
    sessionFingerprint: fingerprint,
    method: "GET",
    url: `https://apiv3.fansly.com${ME}?ngsw-bypass=true`,
    headers: {},
    kind: "api",
    maxBodyBytes: 32 * 1024 * 1024,
    sendDeadlineMono: monoMs() + 15_000,
    requestDeadlineMono: monoMs() + 20_000,
  });
  const account = (id: string) => Buffer.from(JSON.stringify({ success: true, response: { account: { id, email: "owner@example.test" } } }));
  /** A read of the site's own, paused in Fetch with the session's headers. */
  const read = (s: SetUp & { tab: string }, path: string, token = TOKEN) => s.model.pause(`https://apiv3.fansly.com${path}`, "GET", s.tab, "XHR", headersOf(token, path.split("?")[0]!));

  /** A started page whose engine answers checks, and each `siteAdmit` as
   *  `site` says: an admission (by attempt id), a refusal, or nothing. */
  async function siteSetUp(site: (ask: Record<string, unknown>) => { admit: number } | { refuse: string } | null, options: Parameters<typeof setUp>[0] = {}): Promise<SetUp & { tab: string }> {
    // The site's admitted path (before variant Б) with its strict gate.
    const s = await setUp({ strictGate: true, ...options });
    const server = await tlsLikeServer();
    cleanups.push(server.close);
    s.socks.routes.set("apiv3.fansly.com:443", server.port);
    await started(s);
    s.engine.onMessage = (message) => {
      if (message.type === "check") s.engine.send({ type: "checkResult", ownerGeneration: 1, attemptId: message.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
      if (message.type !== "siteAdmit") return;
      const answer = site(message);
      if (answer === null) return;
      if ("admit" in answer) s.engine.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: message.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: answer.admit });
      else s.engine.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: message.siteRequestId, admit: false, reason: answer.refuse });
    };
    return { ...s, tab: s.operator.control.workTab!.sessionId };
  }

  const stateNotes = (s: SetUp) => journal(s.logDir, "states").map((line) => `${String(line.from)}>${String(line.to)}: ${String(line.note)}`);

  it("steps 9–10: the engine's identity read naming the expected account confirms the session, and the page is ready; another account does not; a changed session goes back to step 8; nothing of the site failed — the tab is not loaded anew", async () => {
    let attempt = 9200;
    const s = await siteSetUp(() => ({ admit: ++attempt }));
    // The live session, from the site's own request — admitted, and answered.
    read(s, ME);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === FINGERPRINT);
    expect(await s.engine.waitFor("siteDone", () => true, 10_000)).toMatchObject({ attemptId: 9201, sent: true, status: 200 });
    // Another account than the page's: reported, not confirmed.
    s.model.hubBody = account("999");
    s.engine.send(identity(9301, FINGERPRINT));
    await s.engine.waitFor("result", (message) => message.attemptId === 9301, 10_000);
    await s.engine.waitFor("state", (state) => state.accountId === "999");
    expect(s.operator.page.step).toBe("site_loaded");
    // The expected one: confirmed, ready.
    s.model.hubBody = account("123456789");
    s.engine.send(identity(9302, FINGERPRINT));
    await s.engine.waitFor("result", (message) => message.attemptId === 9302, 10_000);
    await until(() => s.operator.page.step === "ready", START_MS, "the page ready");
    await expect.poll(() => s.engine.last("state"), SETTLED).toMatchObject({ step: "ready", accountId: "123456789", sessionFingerprint: FINGERPRINT });
    const stepsSinceTheExitOpened = () => {
      const steps = journal(s.logDir, "states").map((line) => line.to);
      return steps.slice(steps.lastIndexOf("exit_open"));
    };
    await expect.poll(stepsSinceTheExitOpened, SETTLED).toEqual(["exit_open", "site_loaded", "session_confirmed", "ready"]);
    expect(s.operator.admissionsOpen()).toBe(true);
    // Nothing of the site failed before the confirmation: no reload.
    expect(s.model.navigations).toEqual(["https://fansly.com/"]);
    // The site logs in anew: another session is not the confirmed one.
    read(s, ME, "fansly-token-AnotherLogin0123456789");
    await until(() => s.operator.page.step === "site_loaded", START_MS, "back to the loaded site");
    await expect.poll(() => s.engine.last("state"), SETTLED).toMatchObject({ step: "site_loaded", accountId: null });
    // Nothing of the answer but the account id was kept or logged.
    expect(s.lines.join("\n")).not.toContain("owner@example.test");
  });

  it("the site's API requests failed before the session was confirmed (the engine admits nothing in checks-only): the work tab is loaded anew at the confirmation — once a start, journaled with their count", async () => {
    let admitting = false;
    let attempt = 9400;
    const s = await siteSetUp(() => (admitting ? { admit: ++attempt } : { refuse: "held" }));
    // The site's first load: its reads are refused, in the interception.
    const refused = [read(s, ME), read(s, "/api/v1/messaging/groups?limit=25")];
    await until(() => refused.every((request) => request.outcome === "failed"), 3000, "the refusals");
    expect(s.operator.site.failures).toBe(2);
    // What the map closes does not count: it stays closed after any reload.
    const closed = s.model.pause("https://apiv3.fansly.com/api/v1/message/ack", "POST", s.tab, "XHR", headersOf(TOKEN, "/api/v1/message/ack"));
    await until(() => closed.outcome === "failed", 3000, "the closed write");
    expect(s.operator.site.failures).toBe(2);
    // The engine's identity read: the session is confirmed, the engine admits.
    const pendingSocket = s.operator.sockets.admit("wsv3.fansly.com", 443);
    if (typeof pendingSocket === "string") throw new Error(pendingSocket);
    const socketAsk = await s.engine.waitFor("wsAdmit");
    admitting = true;
    s.model.hubBody = account("123456789");
    s.engine.send(identity(9501, FINGERPRINT));
    await s.engine.waitFor("result", (message) => message.attemptId === 9501, 10_000);
    await until(() => s.operator.page.step === "ready", START_MS, "the page ready");
    expect(await s.engine.waitFor("admissionCancel", (m) => m.id === socketAsk.connectionId, 1_000)).toMatchObject({ kind: "ws", reason: "document_replaced" });
    expect(await pendingSocket.granted).toBeNull();
    // The old document's late grant cannot open a tunnel in the new one.
    s.engine.send({ type: "wsAdmitResult", ownerGeneration: 1, connectionId: socketAsk.connectionId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: 9599 });
    expect(await s.engine.waitFor("wsDone", (m) => m.attemptId === 9599)).toMatchObject({ sent: false });
    expect(s.operator.sockets.busy).toBe(false);
    // Loaded anew, once: the navigation of step 8, and this one.
    expect(s.model.navigations).toEqual(["https://fansly.com/", "https://fansly.com/"]);
    await expect.poll(() => stateNotes(s), SETTLED).toContain("site_loaded>exit_open: the session is confirmed; 2 API requests of the site failed before it, none sent: the work tab is loaded anew, once");
    await expect.poll(() => stateNotes(s).slice(-4).map((note) => note.split(":")[0]), SETTLED).toEqual(["site_loaded>exit_open", "exit_open>site_loaded", "site_loaded>session_confirmed", "session_confirmed>ready"]);
    await expect.poll(() => s.engine.last("state"), SETTLED).toMatchObject({ step: "ready", accountId: "123456789" });
    expect(s.operator.page.snapshot.stopReason).toBeNull();
    // The new document's request goes under the engine that admits now.
    const fresh = read(s, ME);
    expect(await s.engine.waitFor("siteDone", () => true, 10_000)).toMatchObject({ attemptId: 9401, sent: true, status: 200 });
    expect(fresh.outcome).toBe("continued");
    // No loop: more failures and another confirmation in the same start —
    // a new session, refused again, read again — reload nothing.
    admitting = false;
    const other = "fansly-token-SecondLogin000111222333";
    const again = read(s, ME, other);
    await until(() => again.outcome === "failed" && s.operator.page.step === "site_loaded", 3000, "the new session, its request refused");
    expect(s.operator.site.failures).toBeGreaterThan(0);
    s.engine.send(identity(9502, sessionFingerprint(other, CLIENT_ID)));
    await s.engine.waitFor("result", (message) => message.attemptId === 9502, 10_000);
    await until(() => s.operator.page.step === "ready", START_MS, "ready again");
    expect(s.model.navigations).toHaveLength(2);
    expect(s.chrome.sent("Page.navigate")).toHaveLength(2);
    // A new start counts its own: nothing of the site failed in it — the
    // failures of the start before do not reload it.
    admitting = true;
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.model.navigations.length === 3 && s.operator.page.step === "site_loaded", 10_000, "the new start's site");
    const ended = s.engine.of("siteDone").length;
    const admitted = s.model.pause(`https://apiv3.fansly.com${ME}`, "GET", s.operator.control.workTab!.sessionId, "XHR", headersOf(TOKEN, ME));
    await until(() => admitted.outcome === "continued", 3000, "its admission");
    // One admitted request of the page at a time: the read in its turn,
    // once the site's request ended.
    await until(() => s.engine.of("siteDone").length > ended, 5000, "the site's request to end");
    s.engine.send(identity(9503, FINGERPRINT));
    await s.engine.waitFor("result", (message) => message.attemptId === 9503, 10_000);
    await until(() => s.operator.page.step === "ready", START_MS, "ready in the new start");
    expect(s.model.navigations).toHaveLength(3);
    // And one where the site's request fails has its own once.
    admitting = false;
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.model.navigations.length === 4 && s.operator.page.step === "site_loaded", 10_000, "the third start's site");
    const next = s.model.pause(`https://apiv3.fansly.com${ME}`, "GET", s.operator.control.workTab!.sessionId, "XHR", headersOf(TOKEN, ME));
    await until(() => next.outcome === "failed", 3000, "its refusal");
    s.engine.send(identity(9504, FINGERPRINT));
    await s.engine.waitFor("result", (message) => message.attemptId === 9504, 10_000);
    await until(() => s.operator.page.step === "ready", START_MS, "ready in the third start");
    expect(s.model.navigations).toHaveLength(5);
    await expect.poll(() => stateNotes(s).filter((note) => note.includes("the work tab is loaded anew, once")), SETTLED).toHaveLength(2);
  });

  it("the reload's own document must come: a reload whose document never commits fails the start, the page not taken for loaded", async () => {
    const s = await siteSetUp(() => ({ refuse: "held" }), { params: { restartBackoffMs: [5000] }, siteLoadMs: 300 });
    const refused = read(s, ME);
    await until(() => refused.outcome === "failed", 3000, "the refusal");
    s.model.siteLoads = "never";
    s.model.hubBody = account("123456789");
    s.engine.send(identity(9951, FINGERPRINT));
    await s.engine.waitFor("result", (message) => message.attemptId === 9951, 10_000);
    await until(() => s.operator.page.snapshot.stopReason === "proxy_unavailable", 5000, "the failure");
    expect(s.model.navigations).toHaveLength(2);
    expect(s.engine.of("state").some((state) => state.step === "session_confirmed" || state.step === "ready")).toBe(false);
  });

  it("what of the site still waits at that reload is closed first: failed in Chrome, its late admission not used, nothing of it released into the new document", async () => {
    let attempt = 9600;
    const answers: Array<{ admit: number } | { refuse: string } | null> = [{ refuse: "held" }, null, null];
    const s = await siteSetUp(() => (answers.length > 0 ? answers.shift()! : { admit: ++attempt }));
    const refused = read(s, ME);
    await until(() => refused.outcome === "failed", 3000, "the refusal");
    // Two more wait for the engine's word when the session is confirmed.
    const waiting = [read(s, "/api/v1/notifications"), read(s, "/api/v1/subscribers")];
    await until(() => s.engine.of("siteAdmit").length === 3, 3000, "all asked");
    expect(s.operator.site.live).toBe(2);
    s.model.hubBody = account("123456789");
    s.engine.send(identity(9701, FINGERPRINT));
    await s.engine.waitFor("result", (message) => message.attemptId === 9701, 10_000);
    await until(() => s.operator.page.step === "ready", START_MS, "the page ready");
    expect(s.model.navigations).toHaveLength(2);
    // Closed before the tab navigated: failed in Chrome, gone here, never released.
    expect(waiting.map((request) => request.outcome)).toEqual(["failed", "failed"]);
    expect(s.operator.site.live).toBe(0);
    const failCommands = s.chrome.commands.map((command, index) => ({ command, index })).filter(({ command }) => command.method === "Fetch.failRequest" && waiting.some((request) => request.interceptionId === command.params.requestId));
    const reload = s.chrome.commands.findLastIndex((command) => command.method === "Page.navigate");
    expect(failCommands).toHaveLength(2);
    expect(failCommands.every(({ index }) => index < reload)).toBe(true);
    await expect.poll(() => journal(s.logDir, "requests").filter((line) => line.decision === "ended" && line.result === "the work tab is loaded anew"), SETTLED).toHaveLength(2);
    // They were not failures of the new document: only the refused one counted.
    await expect.poll(() => stateNotes(s).some((note) => note.includes("1 API request of the site failed before it")), SETTLED).toBe(true);
    // The engine's admission of one of them, coming after the reload: not used.
    const late = s.engine.of("siteAdmit")[1]!;
    s.engine.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: late.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: 9650 });
    expect(await s.engine.waitFor("siteDone", (message) => message.attemptId === 9650)).toMatchObject({ sent: false, status: null });
    expect(s.chrome.sent("Fetch.continueRequest").some((command) => waiting.some((request) => request.interceptionId === command.params.requestId))).toBe(false);
    await until(() => s.operator.buffer.siteRequests().length === 0, 3000, "their ids to go");
  });

  it("one admitted request of the page at a time: the identity read admitted while a request of the site is in flight is not released (not sent, \"pace\", the gate's refusal logged); after that request's answer it confirms, and the reload cancels nothing and stops nothing", async () => {
    let attempt = 9800;
    const answers: Array<{ admit: number } | { refuse: string }> = [{ refuse: "held" }];
    const s = await siteSetUp(() => (answers.length > 0 ? answers.shift()! : { admit: ++attempt }));
    const refused = read(s, ME);
    await until(() => refused.outcome === "failed", 3000, "the refusal");
    // A request of the site goes out and its answer is slow.
    s.model.siteAnswerDelayMs = 700;
    const flying = read(s, "/api/v1/notifications");
    await until(() => s.operator.site.released === 1, 3000, "the request in flight");
    s.model.hubBody = account("123456789");
    // An engine that overlaps them: the read is refused, nothing of it goes.
    s.engine.send(identity(9901, FINGERPRINT));
    expect(await s.engine.waitFor("result", (message) => message.attemptId === 9901, 10_000)).toMatchObject({ outcome: { kind: "aborted_before_send", refusal: "pace" } });
    expect(s.lines.join("\n")).toContain('"kind":"in_flight_refused"');
    expect(s.operator.page.step).toBe("site_loaded");
    expect(await s.engine.waitFor("siteDone", (message) => message.attemptId === 9801, 10_000)).toMatchObject({ sent: true, status: 200 });
    // In its turn: confirmed, the tab loaded anew once.
    s.engine.send(identity(9902, FINGERPRINT));
    await s.engine.waitFor("result", (message) => message.attemptId === 9902, 10_000);
    await until(() => s.operator.page.step === "ready", START_MS, "the page ready");
    expect(s.model.navigations).toHaveLength(2);
    const answered = s.chrome.commands.findIndex((command) => command.method === "Fetch.continueResponse" && command.params.requestId === flying.interceptionId);
    const reload = s.chrome.commands.findLastIndex((command) => command.method === "Page.navigate");
    expect(answered).toBeGreaterThan(-1);
    expect(answered).toBeLessThan(reload);
    expect(s.operator.page.snapshot.stopReason).toBeNull();
    expect(s.engine.of("state").every((state) => state.stopReason === null)).toBe(true);
  });

  it("the engine's closeExit keeps the page's slot while a released request of the site has no end: openExit is refused until Chrome is started anew (Astra's 2)", async () => {
    let attempt = 9600;
    const s = await siteSetUp(() => ({ admit: ++attempt }));
    // A request of the site released; its answer does not come.
    s.model.siteAnswerDelayMs = 60_000;
    const flying = read(s, "/api/v1/notifications");
    // Its tunnel up and its records written: Chrome waits for the answer.
    await until(() => flying.proxyStatus === 200 && s.model.requests.includes(flying) && s.operator.egress.gate.state.phase !== "open", 3000, "the request in flight");
    const owner = s.operator.egress.gate.slotOwner;
    expect(owner).toMatch(/^site:/);
    expect(await command(s.engine, "closeExit")).toMatchObject({ ok: true });
    // The site's operations are ended (told not sent); the slot is kept.
    expect(s.operator.site.live).toBe(0);
    expect(s.operator.egress.gate.slotOwner).toBe(owner);
    expect(await command(s.engine, "openExit")).toMatchObject({ ok: false, detail: expect.stringContaining(`has no end yet (${owner})`) });
    expect(s.operator.egress.exitOpen).toBe(false);
    // A fresh Chrome: nothing of the old one can go; the page comes up.
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded" && s.operator.egress.exitOpen, 10_000, "the page anew");
    expect(s.operator.egress.gate.slotOwner).toBeNull();
  });

  it("a request's end for the page's slot is Chrome's answer to its resolution, never the decision: while the fail of an ended operation's answer is unanswered, the slot stays (Astra's round 2)", async () => {
    let attempt = 9650;
    const s = await siteSetUp(() => ({ admit: ++attempt }));
    // Released, its records written; its answer comes 800 ms later.
    s.model.siteAnswerDelayMs = 800;
    const flying = read(s, "/api/v1/notifications");
    await until(() => flying.proxyStatus === 200 && s.operator.egress.gate.state.phase !== "open", 3000, "the request in flight");
    const owner = s.operator.egress.gate.slotOwner;
    // Its operation ends (the engine's closeExit); its answer is still to come.
    expect(await command(s.engine, "closeExit")).toMatchObject({ ok: true });
    expect(s.operator.site.live).toBe(0);
    // Chrome does not answer the fail of that answer (yet).
    let answer: (() => void) | null = null;
    s.chrome.handlers.set("Fetch.failRequest", () => new Promise((resolve) => (answer = () => resolve({}))));
    await until(() => s.chrome.commands.some((sent) => sent.method === "Fetch.failRequest" && sent.params.requestId === flying.interceptionId), 3000, "the answer's fail sent");
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Decided, not done: the slot is still the operation's.
    expect(s.operator.egress.gate.slotOwner).toBe(owner);
    expect(s.operator.egress.gate.slotPending).toHaveLength(1);
    // Chrome answers it: the request is over, and the slot free.
    answer!();
    await until(() => s.operator.egress.gate.slotOwner === null, 3000, "the slot free once answered");
  });

  it("the page's slot past its bound with a released request's end unknown: the page stops (request_unended), Chrome goes, and only then is the slot free", async () => {
    let attempt = 9700;
    const s = await siteSetUp(() => ({ admit: ++attempt }), { slotLimitMs: 300, params: { restartBackoffMs: [60_000] } });
    // Admissions of 1 s here.
    const answer = s.engine.onMessage;
    s.engine.onMessage = (message) => {
      if (message.type === "siteAdmit") s.engine.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: message.siteRequestId, admit: true, deadlineMono: monoMs() + 1000, attemptId: ++attempt });
      else answer?.(message);
    };
    s.model.siteAnswerDelayMs = 60_000;
    const flying = read(s, "/api/v1/notifications");
    await until(() => flying.proxyStatus === 200 && s.operator.egress.gate.state.phase !== "open", 3000, "the request in flight");
    const owner = s.operator.egress.gate.slotOwner;
    expect(await command(s.engine, "closeExit")).toMatchObject({ ok: true });
    expect(s.operator.egress.gate.slotOwner).toBe(owner);
    await until(() => s.operator.page.snapshot.stopReason === "request_unended", 5000, "the stop past the bound");
    expect(s.lines.join("\n")).toContain('"e":"slot.unended"');
    await until(() => s.operator.egress.gate.slotOwner === null, 5000, "Chrome gone, the slot free");
  });

  it("waits for the engine: a new connection is asked again by the same id; the wait is the engine's parameter, and past it the request fails (Failed)", async () => {
    const s = await setUp({ params: { siteAdmitWaitMs: 1500 } });
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    const waiting = s.model.pause(`https://apiv3.fansly.com${ME}`, "GET", tab, "XHR", headersOf());
    const first = await s.engine.waitFor("siteAdmit");
    expect((first.waitDeadlineMono as number) - (first.pausedMono as number)).toBe(1500);
    // The engine's connection goes (a deploy of sync) and comes back.
    const next = new FakeEngine();
    s.engine.close();
    await until(() => !s.operator.rpc.linkUp, 3000, "the old link to go");
    expect(waiting.outcome).toBe("paused");
    await next.connect(s.rpcPort());
    cleanups.push(() => next.close());
    next.send(hello({ socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }, { siteAdmitWaitMs: 1500 }));
    await next.waitFor("helloResult");
    const again = await next.waitFor("siteAdmit");
    expect(again).toEqual(first);
    // Nobody admits it: failed once its wait is over.
    await until(() => waiting.outcome === "failed", 5000, "the wait to end");
    expect(waiting.failReason).toBe("Failed");
    await expect.poll(() => journal(s.logDir, "requests"), SETTLED).toContainEqual(expect.objectContaining({ path: ME, decision: "ended", result: "no admission within 1500 ms" }));
  });

  it("the engine's closeExit cancels what the site has waiting: nothing of it goes when the exit opens again", async () => {
    const s = await setUp();
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    const waiting = s.model.pause(`https://apiv3.fansly.com${ME}`, "GET", tab, "XHR", headersOf());
    const ask = await s.engine.waitFor("siteAdmit");
    expect(await command(s.engine, "closeExit")).toMatchObject({ ok: true });
    await until(() => waiting.outcome === "failed", 3000, "the waiting request to fail");
    expect(waiting.failReason).toBe("Failed");
    expect(s.operator.site.live).toBe(0);
    // A request that comes with the exit closed is failed at once, not kept.
    const closed = s.model.pause(`https://apiv3.fansly.com${ME}`, "GET", tab, "XHR", headersOf());
    await until(() => closed.outcome === "failed", 3000, "the request to fail");
    expect(await command(s.engine, "openExit")).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded", START_MS, "the site loaded again");
    // The admission of the cancelled one, coming now, is not used.
    s.engine.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: ask.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: 8200 });
    expect(await s.engine.waitFor("siteDone")).toMatchObject({ attemptId: 8200, sent: false });
    expect(s.engine.of("siteAdmit")).toHaveLength(1);
    expect(s.chrome.sent("Fetch.continueRequest").some((sent) => sent.params.requestId === waiting.interceptionId || sent.params.requestId === closed.interceptionId)).toBe(false);
  });

  it("the page's proxy fails: what waited for an admission is failed, nothing is asked again, the page fails and starts again", async () => {
    const s = await setUp({ params: { restartBackoffMs: [300] } });
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    const waiting = s.model.pause(`https://apiv3.fansly.com${ME}`, "GET", tab, "XHR", headersOf());
    await s.engine.waitFor("siteAdmit");
    expect(s.operator.site.live).toBe(1);
    const starts = s.control.calls.filter((call) => call === "start").length;
    // The page's SOCKS5 is gone: the next tunnel fails.
    await s.socks.stop();
    void proxyConnect(s.model.proxyPort, "fansly.com:443").then(({ socket }) => socket.destroy()).catch(() => undefined);
    await until(() => s.operator.page.snapshot.stopReason === "proxy_unavailable", 5000, "the page to fail");
    // Cancelled, not kept for the next exit: failed in Chrome, and gone here.
    await until(() => s.operator.site.live === 0, 3000, "nothing left waiting");
    // Failed in Chrome — or dead with the Chrome that held it, killed at once.
    expect(waiting.outcome === "failed" || s.control.calls.includes("kill")).toBe(true);
    expect(s.chrome.sent("Fetch.continueRequest").some((command) => command.params.requestId === waiting.interceptionId)).toBe(false);
    expect(s.operator.egress.exitOpen).toBe(false);
    await expect.poll(() => journal(s.logDir, "requests"), SETTLED).toContainEqual(expect.objectContaining({ path: ME, decision: "ended", result: expect.stringContaining("the page stopped: the page's SOCKS5 failed a tunnel") }));
    await until(() => s.control.calls.filter((call) => call === "start").length > starts, 5000, "the page starting again");
    // Nothing of it is asked again.
    expect(s.engine.of("siteAdmit")).toHaveLength(1);
  });

  it("an operator that starts again ends what the previous one admitted: siteDone for the kept request, the paused one failed on the holder's replay", async () => {
    const s = await setUp({
      prepare: ({ bufferDir, stateDir }) => {
        mkdirSync(stateDir, { recursive: true });
        const buffer = new EventBuffer({ dir: bufferDir, idFile: join(stateDir, "buffer-id"), minFreeBytes: 0, log: quiet });
        buffer.changeSiteRequest({ siteRequestId: "33333333-3333-4333-8333-333333333333", asked: true });
        buffer.changeSiteRequest({ siteRequestId: "33333333-3333-4333-8333-333333333333", released: { attemptId: 6100 } });
        buffer.changeSiteRequest({ siteRequestId: "44444444-4444-4444-8444-444444444444", asked: true });
        void buffer.flush();
        void buffer.close();
      },
    });
    expect(await s.engine.waitFor("siteDone")).toMatchObject({ siteRequestId: "33333333-3333-4333-8333-333333333333", attemptId: 6100, sent: true, status: null, error: { afterSendStart: true } });
    await until(() => s.operator.buffer.siteRequests().length === 0, 3000, "the kept ids to go");
    expect(s.engine.of("siteDone")).toHaveLength(1);
    s.engine.send({ type: "recover", ownerGeneration: 1, attemptIds: [6100] });
    expect((await s.engine.waitFor("recoverResult")).attempts).toEqual([{ attemptId: 6100, state: "outcome_resent" }]);
  });
});

describe("the site's socket (PR 10; plan §4.3, §4.4; mandatory condition №3)", () => {
  const URL_WS = "wss://wsv3.fansly.com/?v=3";
  const TOKEN = "eyJ-operator-socket-token-1a2b3c4d";
  const AUTH = JSON.stringify({ t: 1, d: JSON.stringify({ token: TOKEN, v: 3 }) });
  const FRAME_SECRET = "operator-frame-marker-5e6f";

  const SITE_TOKEN = "MTA4NDU4OTk3MjEyNjE2NzA0MDoxOjI6MjZhNjU0M2Q0YWZmYzQyOWNiZWE0OWRmYjFmNmI4";
  const CLIENT_ID = "720167541418230011";

  function bindingOf(s: SetUp): string {
    return String(s.chrome.sent("Runtime.addBinding")[0]!.params.name);
  }

  /** The site's own API request with its session, as it stops in Fetch: the
   *  operator learns the live session from it (a socket is admitted only
   *  with one). */
  async function siteSession(s: SetUp, tab: string): Promise<string> {
    const headers = { authorization: SITE_TOKEN, "fansly-client-id": CLIENT_ID, "fansly-client-check": fanslyClientCheck("/api/v1/account/me", CLIENT_ID), "fansly-client-ts": String(Date.now()) };
    s.model.pause("https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true", "GET", tab, "XHR", headers);
    const fingerprint = sessionFingerprint(SITE_TOKEN, CLIENT_ID);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === fingerprint);
    return fingerprint;
  }

  /** The site's socket to the 101, the engine admitting it. */
  async function socketOpened(s: SetUp, server: { received: () => Buffer }, tab: string, attemptId: number): Promise<{ client: SocketTunnelClient; connectionId: string }> {
    s.chrome.event("Network.webSocketCreated", { requestId: `WS${attemptId}`, url: URL_WS }, tab);
    const asked = s.engine.of("wsAdmit").length;
    const connecting = SocketTunnelClient.connect(s.model.proxyPort);
    await until(() => s.engine.of("wsAdmit").length > asked, 5000, "the admission asked");
    const ask = s.engine.of("wsAdmit").at(-1)!;
    s.engine.send({ type: "wsAdmitResult", ownerGeneration: 1, connectionId: ask.connectionId, admit: true, deadlineMono: monoMs() + 5000, attemptId });
    const client = await connecting;
    expect(client.status).toBe(200);
    await client.tls();
    s.chrome.event("Network.webSocketWillSendHandshakeRequest", { requestId: `WS${attemptId}`, timestamp: monoMs() / 1000 }, tab);
    const before = server.received().length;
    client.request();
    await until(() => server.received().subarray(before).includes(SOCKET_FILL.request), 3000, "the handshake request at the server");
    s.chrome.event("Network.webSocketHandshakeResponseReceived", { requestId: `WS${attemptId}`, timestamp: monoMs() / 1000, response: { status: 101 } }, tab);
    await client.answered();
    return { client, connectionId: String(ask.connectionId) };
  }

  it("goes into every tab before it runs: Runtime, the binding, the guard as a script of every new document", async () => {
    const s = await setUp();
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    const ofTab = s.chrome.commands.filter((command) => command.sessionId === tab).map((command) => command.method);
    const [runtime, binding, guard, run] = ["Runtime.enable", "Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument", "Runtime.runIfWaitingForDebugger"].map((method) => ofTab.indexOf(method));
    expect(runtime).toBeGreaterThanOrEqual(0);
    expect(runtime).toBeLessThan(binding!);
    expect(binding).toBeLessThan(guard!);
    expect(guard).toBeLessThan(run!);
    const script = s.chrome.commands.find((command) => command.sessionId === tab && command.method === "Page.addScriptToEvaluateOnNewDocument")!;
    expect(script.params.runImmediately).toBe(true);
    expect(String(script.params.source)).toContain("pbWsGuard(");
    expect(String(script.params.source)).toContain(JSON.stringify(bindingOf(s)));
    expect(bindingOf(s)).toMatch(/^pb[0-9a-f]{18}$/);
  });

  it("end to end: the CONNECT waits for wsAdmit, the admitted socket is a tunnel of its own, wsDone once durable, its frames to the engine in order; nothing secret in a log", async () => {
    const s = await setUp();
    const server = await socketServer();
    cleanups.push(server.close);
    s.socks.routes.set("wsv3.fansly.com:443", server.port);
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    const fingerprint = await siteSession(s, tab);
    s.chrome.event("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, tab);
    const connecting = SocketTunnelClient.connect(s.model.proxyPort);
    const ask = await s.engine.waitFor("wsAdmit");
    expect(ask).toMatchObject({ url: URL_WS, context: "page", sessionFingerprint: fingerprint });
    expect(s.socks.connects).not.toContain("wsv3.fansly.com:443");
    s.engine.send({ type: "wsAdmitResult", ownerGeneration: 1, connectionId: ask.connectionId, admit: true, deadlineMono: monoMs() + 5000, attemptId: 4242 });
    const client = await connecting;
    expect(client.status).toBe(200);
    await client.tls();
    s.chrome.event("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1", timestamp: monoMs() / 1000 }, tab);
    client.request();
    await until(() => server.received().includes(SOCKET_FILL.request), 3000, "the handshake request at the server");
    s.chrome.event("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", timestamp: monoMs() / 1000, response: { status: 101 } }, tab);
    // The authorization and a ping, as Chrome writes them: the socket gate lets them go.
    await client.answered();
    client.message(authorizationBytes(SITE_TOKEN), SOCKET_FILL.authorization);
    client.message(1, SOCKET_FILL.ping);
    await until(() => server.received().includes(SOCKET_FILL.ping), 3000, "the authorization and the ping at the server");
    s.chrome.event("Network.webSocketFrameSent", { requestId: "WS1", response: { opcode: 1, payloadData: AUTH } }, tab);
    for (let n = 0; n < 5; n++) s.chrome.event("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: JSON.stringify({ t: 2, d: JSON.stringify({ n, marker: FRAME_SECRET }) }) } }, tab);
    const done = await s.engine.waitFor("wsDone");
    expect(done).toEqual({ type: "wsDone", connectionId: ask.connectionId, attemptId: 4242, sent: true, sentMono: expect.any(Number), status: 101, error: null });
    s.engine.send({ type: "events.subscribe", ownerGeneration: 1, bufferId: s.operator.buffer.id, afterSeq: 0 });
    const events = () => s.engine.of("events").flatMap((message) => message.events as Array<Record<string, unknown>>);
    await until(() => events().length === 7, 5000, "7 events");
    expect(events().map((event) => event.kind)).toEqual(["gap", "ws.open", "ws.in", "ws.in", "ws.in", "ws.in", "ws.in"]);
    expect(events()[1]).toMatchObject({ kind: "ws.open", connectionId: ask.connectionId, attemptId: 4242, sessionFingerprint: fingerprint });
    // The outcome stays until the engine's resultAck.
    s.engine.send({ type: "resultAck", ownerGeneration: 1, attemptId: 4242 });
    await until(() => s.operator.buffer.stats().outcomes === 0, 3000, "the outcome to go");
    await s.operator.journals.close();
    const journals = readdirSync(s.logDir).map((name) => readFileSync(join(s.logDir, name), "utf8"));
    expect(journal(s.logDir, "sockets").map((line) => line.event)).toEqual(["asked", "admitted", "open", "out"]);
    expect(journal(s.logDir, "sockets")[3]).toMatchObject({ message: { kind: "auth", opcode: 1, bytes: AUTH.length } });
    const everything = [...journals, ...s.lines].join("\n");
    for (const secret of [TOKEN, SITE_TOKEN, FRAME_SECRET, "?v=3"]) expect(everything, secret).not.toContain(secret);
    client.destroy();
  });

  it("a message from a context without the guard is held at the proxy: it never reaches Fansly, the page is killed, the alarm says where", async () => {
    const s = await setUp();
    const server = await socketServer();
    cleanups.push(server.close);
    s.socks.routes.set("wsv3.fansly.com:443", server.port);
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    await siteSession(s, tab);
    const { client } = await socketOpened(s, server, tab, 4500);
    client.message(authorizationBytes(SITE_TOKEN), SOCKET_FILL.authorization);
    client.message(1, SOCKET_FILL.ping);
    await until(() => server.received().includes(SOCKET_FILL.ping), 3000, "the authorization and the ping at the server");
    // No guard report comes (Astra's exhausted-stack frame): only the bytes.
    client.message(52, SOCKET_FILL.forbidden);
    await until(() => s.operator.page.snapshot.stopReason === "unknown_ws_message", 5000, "the stop");
    expect(server.received().includes(SOCKET_FILL.forbidden)).toBe(false);
    expect(s.operator.page.halted).toBe(true);
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.control.calls.at(-1)).toBe("kill");
    const alarm = await s.engine.waitFor("alarm", (message) => message.kind === "unknown_ws_message");
    expect(alarm.detail).toMatchObject({ at: "proxy", left: false, recordBytes: TLS13_OVERHEAD + 58, why: "a message of no allowed size" });
    await s.operator.journals.close();
    expect(journal(s.logDir, "connections")).toContainEqual(expect.objectContaining({ host: "wsv3.fansly.com", result: `cut: the socket gate held a record of ${TLS13_OVERHEAD + 58} bytes (a message of no allowed size)` }));
  });

  it("without the engine (no ping for 5 s — 600 ms here) no new socket is admitted, and no wsAdmit is asked; what is open stays", async () => {
    const s = await setUp();
    const server = await socketServer();
    cleanups.push(server.close);
    s.socks.routes.set("wsv3.fansly.com:443", server.port);
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    await siteSession(s, tab);
    const { client: open } = await socketOpened(s, server, tab, 4300);
    await s.engine.waitFor("wsDone");
    s.engine.answerPings = false;
    await until(() => !s.operator.rpc.linkUp, 3000, "the link to go");
    s.chrome.event("Network.webSocketCreated", { requestId: "WS2", url: URL_WS }, tab);
    const refused = await SocketTunnelClient.connect(s.model.proxyPort);
    expect(refused.status).toBe(403);
    expect(s.engine.of("wsAdmit")).toHaveLength(1);
    // The journal's line is written asynchronously: wait for it, do not race it.
    await until(() => journal(s.logDir, "connections").some((line) => line.result === "refused: socket not admitted (no engine link)"), 3000, "the refusal journaled");
    expect(journal(s.logDir, "connections").at(-1)).toMatchObject({ host: "wsv3.fansly.com", refused: true, result: "refused: socket not admitted (no engine link)" });
    // The open one: still a tunnel, its frames still kept.
    expect(s.operator.sockets.openConnections).toBe(1);
    s.chrome.event("Network.webSocketFrameReceived", { requestId: "WS4300", response: { opcode: 1, payloadData: '{"t":2,"d":"{}"}' } }, tab);
    await until(() => s.operator.buffer.lastSeq === 3, 3000, "the frame kept");
    expect(s.operator.egress.exitOpen).toBe(true);
    open.destroy();
  });

  it("a message the guard did not let go stops the page: the exit closed, the stop held for the engine's restart, the alarm with no content", async () => {
    const s = await setUp();
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    const payload = JSON.stringify({ k: "blocked_send", form: "json", len: 58, msgType: 46001, keys: '["t","d"]', dKeys: '["chatRoomId"]', where: "https://fansly.com/messages" });
    s.chrome.event("Runtime.bindingCalled", { name: bindingOf(s), payload, executionContextId: 3 }, tab);
    await until(() => s.operator.page.snapshot.stopReason === "unknown_ws_message", 5000, "the stop");
    expect(s.operator.page.halted).toBe(true);
    expect(s.operator.egress.exitOpen).toBe(false);
    const alarm = await s.engine.waitFor("alarm", (message) => message.kind === "unknown_ws_message");
    expect(alarm.detail).toEqual({ form: "json", len: 58, msgType: 46001, keys: "t,d", dKeys: "chatRoomId", context: "page", where: "https://fansly.com/messages", left: false });
    // Another name's call is not the guard's.
    const before = s.engine.of("alarm").length;
    s.chrome.event("Runtime.bindingCalled", { name: "notTheGuard", payload, executionContextId: 3 }, tab);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.engine.of("alarm")).toHaveLength(before);
  });

  it("a context the guard could not go into stops the page at once (ws_guard_failed)", async () => {
    const s = await setUp();
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    s.chrome.event("Runtime.bindingCalled", { name: bindingOf(s), payload: JSON.stringify({ k: "guard_failed", why: "WebSocketStream stays", where: "" }), executionContextId: 3 }, tab);
    await until(() => s.operator.page.snapshot.stopReason === "ws_guard_failed", 5000, "the stop");
    expect(s.operator.page.halted).toBe(true);
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.control.calls.at(-1)).toBe("kill");
  });

  it("a request to the socket host that is not a socket is failed: no socket may ride its connection", async () => {
    const s = await setUp();
    await started(s);
    const request = s.model.pause("https://wsv3.fansly.com/?v=3", "GET", s.operator.control.workTab!.sessionId, "Fetch");
    await until(() => request.outcome === "failed", 3000, "the request to fail");
    expect(request.failReason).toBe("BlockedByClient");
    await s.operator.journals.close();
    expect(journal(s.logDir, "requests")).toContainEqual(expect.objectContaining({ host: "wsv3.fansly.com", decision: "failed", result: "BlockedByClient: the socket host serves the site's socket only (socket_host)" }));
  });

  it("a socket that cannot be accounted for — a handshake on its tunnel CDP never shows — fails the page: the exit closed, Chrome started again, nothing reassigned", async () => {
    const s = await setUp({ params: { restartBackoffMs: [300] }, socketTimings: { bindWaitMs: 200 } });
    const server = await socketServer();
    cleanups.push(server.close);
    s.socks.routes.set("wsv3.fansly.com:443", server.port);
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    await siteSession(s, tab);
    s.chrome.event("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, tab);
    const connecting = SocketTunnelClient.connect(s.model.proxyPort);
    await until(() => s.engine.of("wsAdmit").length === 1, 5000, "the admission asked");
    s.engine.send({ type: "wsAdmitResult", ownerGeneration: 1, connectionId: s.engine.of("wsAdmit")[0]!.connectionId, admit: true, deadlineMono: monoMs() + 5000, attemptId: 4500 });
    const client = await connecting;
    expect(client.status).toBe(200);
    await client.tls();
    // The request goes up its tunnel; CDP never shows the handshake.
    client.request();
    await until(() => s.operator.page.snapshot.stopReason === "ws_unaccounted", 5000, "the failure");
    expect(s.operator.egress.exitOpen).toBe(false);
    await until(() => s.chrome.sent("Browser.close").length > 0, 5000, "failed Chrome asked to quit");
    expect(await s.engine.waitFor("wsDone")).toMatchObject({ attemptId: 4500, sent: true, status: null, error: expect.stringContaining("not accounted for") });
    await until(() => s.control.calls.filter((call) => call === "start").length >= 2 && s.operator.page.step === "site_loaded", 10_000, "Chrome started again");
    client.destroy();
  });

  it("a browser that goes under an open connection marks the gap — from its last event — then closes it in the stream", async () => {
    const s = await setUp();
    const server = await socketServer();
    cleanups.push(server.close);
    s.socks.routes.set("wsv3.fansly.com:443", server.port);
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    await siteSession(s, tab);
    const { client } = await socketOpened(s, server, tab, 4400);
    await s.engine.waitFor("wsDone");
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.operator.buffer.lastSeq === 4, 10_000, "the close and the gap");
    s.engine.send({ type: "events.subscribe", ownerGeneration: 1, bufferId: s.operator.buffer.id, afterSeq: 0 });
    const events = () => s.engine.of("events").flatMap((message) => message.events as Array<Record<string, unknown>>);
    await until(() => events().length === 4, 5000, "4 events");
    expect(events().map((event) => (event.kind === "gap" ? `gap:${String(event.reason)}` : event.kind))).toEqual(["gap:operator_start", "ws.open", "gap:chrome_restart", "ws.close"]);
    expect(events()[2]).toMatchObject({ fromSeq: 2, fromWall: events()[1]!.atWall });
    client.destroy();
  });
});
