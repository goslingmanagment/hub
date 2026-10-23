import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DB_FILE } from "../apps/page-browser/src/buffer/store.ts";
import { authorizationBytes } from "../apps/page-browser/src/egress/socket-gate.ts";
import { ISSUE } from "../apps/page-browser/src/hub-requests/page.ts";
import { fanslyClientTs } from "../apps/page-browser/src/hub-requests/client-ts.ts";
import { fanslyClientCheck, sessionFingerprint } from "../apps/page-browser/src/hub-requests/session.ts";
import { HealthProbe } from "../apps/page-browser/src/operator/health.ts";
import { Operator, type OperatorDeps } from "../apps/page-browser/src/operator/operator.ts";
import type { Cdp } from "../apps/page-browser/src/cdp/client.ts";
import type { BrowserControl } from "../apps/page-browser/src/cdp/control.ts";
import type { ChromeControl } from "../apps/page-browser/src/operator/chrome.ts";
import { parseOperatorMessage } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
import { HaltStore } from "../apps/page-browser/src/state/halt-store.ts";
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
    /** How long a request of the site in flight is waited out (30 s in the operator). */
    reloadWaitMs?: number;
    /** A failed tunnel's exit IP check out of turn, at most this often (30 s in the operator). */
    proxyRecheckMs?: number;
    /** How long the exit IP may stay unknown before the page fails (30 min in the operator). */
    exitIpUnknownMaxMs?: number;
    /** Before the operator: what its buffer volume holds. */
    prepare?: (paths: { bufferDir: string; stateDir: string }) => void;
    haltStore?: OperatorDeps["haltStore"];
    /** The strict gate of the site's admitted path (variant Б's is passive). */
    strictGate?: boolean;
    /** The engine's protocol minor (4: variant Б — it observes the site). */
    minor?: number;
    /** Chrome's crash dumps as root counted them, before the operator starts. */
    crashDumps?: Record<string, unknown>;
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
        crashDumpsPath: join(temp.dir, "crash-dumps.json"),
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
      timings: { replayWaitMs: 2000, chromeUpMs: 5000, attachMs: 3000, envCheckMs: 3000, stateEveryMs: 200, healthEveryMs: 100, healthAnswerMs: 300, selfTestProbeMs: 2000, exitIpTimeoutMs: 2000, quitWaitMs: 1000, observedDrainMs: 600, ...(options.siteLoadMs ? { siteLoadMs: options.siteLoadMs } : {}), ...(options.slotLimitMs ? { slotLimitMs: options.slotLimitMs } : {}), ...(options.reloadWaitMs ? { reloadWaitMs: options.reloadWaitMs } : {}), ...(options.proxyRecheckMs !== undefined ? { proxyRecheckMs: options.proxyRecheckMs } : {}), ...(options.exitIpUnknownMaxMs !== undefined ? { exitIpUnknownMaxMs: options.exitIpUnknownMaxMs } : {}) },
    });
    const ports = await operator.start();
    cleanups.push(() => operator.stop());
    model.proxyPort = ports.proxyPort;
    rpcPort = ports.rpcPort;
    return operator;
  };
  options.prepare?.({ bufferDir: join(temp.dir, "buffer"), stateDir: join(temp.dir, "state") });
  if (options.crashDumps !== undefined) writeFileSync(join(temp.dir, "crash-dumps.json"), JSON.stringify(options.crashDumps));
  const operator = await newOperator();
  await until(() => operator.cdp.linked, 3000, "the holder link");
  const engine = new FakeEngine();
  await engine.connect(rpcPort);
  cleanups.push(() => engine.close());
  engine.send(hello({ protocol: { majors: [1], minor: options.minor ?? 2 }, socks5: { ip: "127.0.0.1", port: socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }, options.params));
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
    // A tunnel that fails while the site loads has the IP checked out of turn
    // (#recheckProxy), at any moment: a total of checks races with it on a
    // loaded CI machine. What counts is a check while the exit is still
    // closed, during the engine's openExit.
    let opening = false;
    let checkedClosed = 0;
    let operator: Operator | null = null;
    const s = await setUp({
      exitIp: () => {
        if (opening && operator?.egress.exitOpen === false) checkedClosed += 1;
        return "203.0.113.7";
      },
    });
    operator = s.operator;
    await started(s);
    expect(await command(s.engine, "closeExit")).toMatchObject({ ok: true });
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.operator.page.step).toBe("exit_ip_verified");
    opening = true;
    expect(await command(s.engine, "openExit")).toMatchObject({ ok: true, detail: "the exit is open" });
    opening = false;
    expect(checkedClosed).toBeGreaterThanOrEqual(1);
    // The site loads again with the exit open.
    await until(() => s.operator.page.step === "site_loaded", START_MS, "the site loaded again");
    expect(s.model.navigations).toEqual(["https://fansly.com/", "https://fansly.com/"]);
  });

  it("a check of the page that is up with no answer holds Hub's requests and alarms; Chrome and the site go on, the check is retried, and a pinned answer lets Hub's requests go", async () => {
    // Checked every 300 ms here (hourly in production), retried after the
    // restart backoff (150 ms, 300 ms here).
    const s = await setUp({ minor: 7, params: { exitIpCheckMs: 300 } });
    await started(s);
    const starts = s.control.calls.filter((call) => call === "start").length;
    const checks = () => s.socks.connects.filter((target) => target === "api.ipify.org:443").length;
    // The SOCKS5 refuses the check's own tunnel ("not allowed by the ruleset").
    s.socks.answers.set("api.ipify.org:443", 2);
    const alarm = await s.engine.waitFor("alarm", (message) => message.kind === "exit_ip_unknown", 10_000);
    expect(alarm.detail).toMatchObject({ hubHeld: true });
    await expect.poll(() => s.engine.last("state")?.hubSend, SETTLED).toMatchObject({ allowed: false, reason: "exit_ip_unknown" });
    // Hub's parser takes what an operator of minor 7 says.
    expect(parseOperatorMessage(JSON.stringify(alarm)).ok).toBe(true);
    expect(parseOperatorMessage(JSON.stringify(s.engine.last("state"))).ok).toBe(true);
    // A Hub request now is answered, never started.
    const now = monoMs();
    s.engine.send({
      type: "send", ownerGeneration: s.engine.generation, attemptId: 7001, route: "account.me", credentialsGeneration: "c".repeat(64), sessionFingerprint: "f".repeat(64),
      method: "GET", url: "https://apiv3.fansly.com/api/v1/account/me", headers: {}, kind: "api", maxBodyBytes: 1024 * 1024, sendDeadlineMono: now + 15_000, requestDeadlineMono: now + 20_000,
    });
    const result = await s.engine.waitFor("result", (message) => message.attemptId === 7001);
    expect(result.outcome).toMatchObject({ kind: "transport_error", sent: false, message: expect.stringMatching(/exit IP/) });
    expect(s.chrome.sent("Runtime.callFunctionOn").filter((command) => command.params.functionDeclaration === ISSUE)).toEqual([]);
    // The check goes on failing: retried, one alarm for the episode, and the
    // page as it was — the exit open, the same Chrome, no stop.
    const failing = checks();
    await until(() => checks() >= failing + 2, 10_000, "the check retried");
    expect(s.engine.of("alarm").filter((message) => message.kind === "exit_ip_unknown")).toHaveLength(1);
    expect(s.operator.egress.exitOpen).toBe(true);
    expect(s.operator.page.snapshot).toMatchObject({ step: "site_loaded", stopReason: null, halted: false });
    expect(s.chrome.running).toBe(true);
    expect(s.control.calls.filter((call) => call === "start")).toHaveLength(starts);
    expect(s.control.calls).not.toContain("kill");
    expect(s.chrome.sent("Browser.close")).toEqual([]);
    // The check answers the pinned IP again: Hub's requests may go.
    s.socks.answers.delete("api.ipify.org:443");
    await expect.poll(() => s.engine.last("state")?.hubSend, SETTLED).not.toMatchObject({ reason: "exit_ip_unknown" });
    expect(s.operator.egress.exitOpen).toBe(true);
    expect(s.control.calls.filter((call) => call === "start")).toHaveLength(starts);
  });

  it("unknown without a break past its bound (30 min; 1.5 s here): the page fails as before — the exit closed, Chrome stopped, no halt — and the start's strict check brings it back once the pinned IP answers", async () => {
    const s = await setUp({ minor: 7, params: { exitIpCheckMs: 300 }, exitIpUnknownMaxMs: 1500 });
    await started(s);
    s.socks.answers.set("api.ipify.org:443", 2);
    await s.engine.waitFor("alarm", (message) => message.kind === "exit_ip_unknown", 10_000);
    // Held first: the page up, its exit open.
    expect(s.operator.egress.exitOpen).toBe(true);
    await until(() => s.operator.page.snapshot.stopReason === "proxy_unavailable", 10_000, "the failure at the bound");
    expect(s.operator.page.snapshot).toMatchObject({ halted: false, retryAtWall: expect.any(Number) });
    expect(s.operator.heldHalt).toBeNull();
    expect(s.operator.egress.exitOpen).toBe(false);
    await until(() => !s.chrome.running, 5000, "Chrome stopped");
    // The retries' strict check keeps the exit closed while the IP is unknown …
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(s.operator.egress.exitOpen).toBe(false);
    // … and opens it once the pinned IP answers.
    s.socks.answers.delete("api.ipify.org:443");
    await until(() => s.operator.page.step === "site_loaded", START_MS, "the page back");
    expect(s.operator.egress.exitOpen).toBe(true);
  });

  it("an engine before minor 7 hears the hold as the page not up, and no alarm of a kind it does not know", async () => {
    const s = await setUp({ minor: 6, params: { exitIpCheckMs: 300 } });
    await started(s);
    s.socks.answers.set("api.ipify.org:443", 2);
    await expect.poll(() => s.engine.last("state")?.hubSend, SETTLED).toMatchObject({ allowed: false, reason: "page_not_up" });
    expect(s.engine.of("alarm").filter((message) => message.kind === "exit_ip_unknown")).toEqual([]);
    expect(s.operator.egress.exitOpen).toBe(true);
    expect(s.chrome.running).toBe(true);
  });

  it("another IP named by a check of the page that is up stops it until the owner decides, as before", async () => {
    let ip = "203.0.113.7";
    const s = await setUp({ minor: 7, params: { exitIpCheckMs: 300 }, exitIp: () => ip });
    await started(s);
    ip = "198.51.100.9";
    await until(() => s.operator.page.snapshot.stopReason === "exit_ip_changed", 10_000, "the stop");
    expect(s.operator.page.snapshot).toMatchObject({ step: "exit_closed", halted: true, retryAtWall: null });
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.operator.heldHalt).toMatchObject({ reason: "exit_ip_changed" });
    await until(() => !s.chrome.running, 5000, "Chrome down");
    expect(s.engine.of("alarm").filter((message) => message.kind === "exit_ip_unknown")).toEqual([]);
    // It holds: the IP coming back starts nothing.
    ip = "203.0.113.7";
    const starts = s.control.calls.filter((call) => call === "start").length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(s.control.calls.filter((call) => call === "start")).toHaveLength(starts);
  });
});

describe("the diagnostic journals (logs/)", () => {
  it("a journal that cannot be written alarms the engine, and the page goes on: the start does not wait for it, the exit opens and stays, no stop", async () => {
    // Every journal's file of today (and tomorrow) is a directory: no line
    // of any can be written.
    const s = await setUp({
      minor: 7,
      prepare: ({ bufferDir }) => {
        const logDir = join(dirname(bufferDir), "logs");
        for (const day of [new Date(), new Date(Date.now() + 86_400_000)].map((date) => date.toISOString().slice(0, 10))) {
          for (const kind of ["connections", "requests", "states", "sockets"]) mkdirSync(join(logDir, `${kind}-${day}.jsonl`), { recursive: true });
        }
      },
    });
    await started(s);
    const alarm = await s.engine.waitFor("alarm", (message) => message.kind === "journal", 10_000);
    const detail = alarm.detail as { writeErrors: number; droppedLines: number };
    expect(detail.writeErrors).toBeGreaterThan(0);
    expect(detail.droppedLines).toEqual(expect.any(Number));
    expect(parseOperatorMessage(JSON.stringify(alarm)).ok).toBe(true);
    expect(s.operator.egress.exitOpen).toBe(true);
    expect(s.operator.page.snapshot).toMatchObject({ step: "site_loaded", stopReason: null, halted: false });
    expect(s.engine.of("state").some((state) => state.stopReason === "disk_full")).toBe(false);
    expect(s.control.calls).not.toContain("kill");
    // Lines go on failing: the alarms do not repeat at every line.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(s.engine.of("alarm").filter((message) => message.kind === "journal")).toHaveLength(1);
    expect(s.operator.egress.exitOpen).toBe(true);
  });
});

describe("the work tab's pulse (operator/health.ts)", () => {
  /** A probe of a tab that misses the next `misses` pulses, then answers. */
  function probe(): { start: () => void; stop: () => void; miss: (n: number) => void; pulses: () => number; unhealthy: string[] } {
    let misses = 0;
    let pulses = 0;
    const unhealthy: string[] = [];
    const cdp = {
      send: async () => {
        pulses += 1;
        if (misses > 0) {
          misses -= 1;
          throw new Error("no answer in time");
        }
        return {};
      },
    } as unknown as Cdp;
    const control = { workTab: { sessionId: "S1" } } as unknown as BrowserControl;
    const chrome = { networkServicePid: () => 4242 } as unknown as ChromeControl;
    const health = new HealthProbe(cdp, control, chrome, { everyMs: 5, answerMs: 50, onUnhealthy: (reason) => unhealthy.push(reason) });
    cleanups.push(() => health.stop());
    return { start: () => health.start(), stop: () => health.stop(), miss: (n) => (misses = n), pulses: () => pulses, unhealthy };
  }

  it("two missed pulses in a row are no lost browser; a third is", async () => {
    const p = probe();
    p.miss(2);
    p.start();
    await until(() => p.pulses() >= 6, 5000, "pulses after the misses");
    expect(p.unhealthy).toEqual([]);
    p.miss(3);
    await until(() => p.unhealthy.length > 0, 5000, "the third miss");
    expect(p.unhealthy).toHaveLength(1);
  });
});

describe("the page's environment (env/)", () => {
  it("no tab is granted geolocation or given a position, and none is asked for", async () => {
    const s = await setUp();
    await started(s);
    expect(s.chrome.sent("Browser.grantPermissions")).toEqual([]);
    expect(s.chrome.sent("Emulation.setGeolocationOverride")).toEqual([]);
    // No throwaway context to read a position in either.
    expect(s.chrome.sent("Target.createBrowserContext")).toEqual([]);
    expect(s.operator.page.snapshot).toMatchObject({ step: "site_loaded", stopReason: null });
  });

  it("a screen that is not the image's alarms, and the page goes on", async () => {
    const s = await setUp({ minor: 7 });
    s.control.geometry = { width: 1728, height: 936, depth: 24 };
    s.model.shows = { screen: { width: 1728, height: 936 } };
    await started(s);
    await expect.poll(() => s.engine.of("alarm").filter((message) => message.kind === "env_mismatch").map((message) => (message.detail as { screen: string }).screen), SETTLED).toEqual(["x_server", "chrome"]);
    expect(s.operator.page.snapshot).toMatchObject({ step: "site_loaded", stopReason: null, halted: false });
    expect(s.operator.heldHalt).toBeNull();
    expect(s.operator.egress.exitOpen).toBe(true);
    expect(s.control.calls.filter((call) => call === "start")).toHaveLength(1);
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

describe("the permissions of Hub's writes (wall posts PR 7, minor 8)", () => {
  const setPublishing = (engine: FakeEngine, create: boolean, withdraw: boolean) => {
    const commandId = `p-${++commandN}`;
    engine.send({ type: "command", ownerGeneration: engine.generation, commandId, notAfterMono: monoMs() + 10_000, command: { kind: "setPublishing", create, withdraw } });
    return engine.waitFor("commandResult", (message) => message.commandId === commandId, 15_000);
  };

  it("are off at the hello, set by the engine, said in the state, and off again at the next hello", async () => {
    const s = await setUp({ minor: 8 });
    expect((await s.engine.waitFor("helloResult")).writes).toEqual({ fingerprint: "fansly-write.v1" });
    expect(s.operator.state.publishing).toEqual({ create: false, withdraw: false });
    expect(await setPublishing(s.engine, true, true)).toMatchObject({ ok: true });
    expect(s.operator.hub.publishing).toEqual({ create: true, withdraw: true });
    await expect.poll(() => s.engine.last("state")?.publishing, SETTLED).toEqual({ create: true, withdraw: true });
    expect(await setPublishing(s.engine, false, true)).toMatchObject({ ok: true });
    expect(s.operator.hub.publishing).toEqual({ create: false, withdraw: true });
    // The engine says hello again on a new connection: off until it says them.
    const again = new FakeEngine();
    await again.connect(s.rpcPort());
    cleanups.push(() => again.close());
    again.send(hello({ protocol: { majors: [1], minor: 8 }, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    expect(await again.waitFor("helloResult")).toMatchObject({ ok: true, state: { publishing: { create: false, withdraw: false } } });
    expect(s.operator.hub.publishing).toEqual({ create: false, withdraw: false });
  });

  it("an engine before minor 8 is told nothing of them, and its state parses as it did", async () => {
    const s = await setUp({ minor: 7 });
    expect(s.operator.state).not.toHaveProperty("publishing");
    expect(s.operator.hub.publishing).toEqual({ create: false, withdraw: false });
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
});

describe("the buffer under stress (Astra's review of PR 11)", () => {
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
      "fansly-client-ts": String(fanslyClientTs(Date.now(), SESSION_ID)),
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
    expect(s.engine.of("sent")).toEqual([{ type: "sent", attemptId: 9100, sentMono: expect.any(Number), sentWall: expect.any(Number), connectionReused: false, releasedMono: expect.any(Number) }]);
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
});

describe("the site's socket (PR 10; plan §4.3, §4.4; mandatory condition №3; variant Б, plan-b §4.1.9)", () => {
  const URL_WS = "wss://wsv3.fansly.com/?v=3";
  const SITE_TOKEN = "MTA4NDU4OTk3MjEyNjE2NzA0MDoxOjI6MjZhNjU0M2Q0YWZmYzQyOWNiZWE0OWRmYjFmNmI4";
  const CLIENT_ID = "720167541418230011";

  function bindingOf(s: SetUp): string {
    return String(s.chrome.sent("Runtime.addBinding")[0]!.params.name);
  }

  /** The site's own API request with its session, as it stops in Fetch: the
   *  operator learns the live session from it (a connection opens in the
   *  stream under it). */
  async function siteSession(s: SetUp, tab: string): Promise<string> {
    const headers = { authorization: SITE_TOKEN, "fansly-client-id": CLIENT_ID, "fansly-client-check": fanslyClientCheck("/api/v1/account/me", CLIENT_ID), "fansly-client-ts": String(fanslyClientTs(Date.now(), CLIENT_ID)) };
    s.model.pause("https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true", "GET", tab, "XHR", headers);
    const fingerprint = sessionFingerprint(SITE_TOKEN, CLIENT_ID);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === fingerprint);
    return fingerprint;
  }

  /** The site's socket to the 101: its CONNECT goes on at once. */
  async function socketOpened(s: SetUp, server: { received: () => Buffer }, tab: string, n: number): Promise<{ client: SocketTunnelClient }> {
    s.chrome.event("Network.webSocketCreated", { requestId: `WS${n}`, url: URL_WS }, tab);
    const client = await SocketTunnelClient.connect(s.model.proxyPort);
    expect(client.status).toBe(200);
    await client.tls();
    s.chrome.event("Network.webSocketWillSendHandshakeRequest", { requestId: `WS${n}`, timestamp: monoMs() / 1000 }, tab);
    const before = server.received().length;
    client.request();
    await until(() => server.received().subarray(before).includes(SOCKET_FILL.request), 3000, "the handshake request at the server");
    await client.answered();
    s.chrome.event("Network.webSocketHandshakeResponseReceived", { requestId: `WS${n}`, timestamp: monoMs() / 1000, response: { status: 101 } }, tab);
    return { client };
  }

  it("a message from a context without the guard is held at the proxy: it never reaches Fansly, that tunnel alone is cut with an alarm that says where; the gate's third refusal within its window kills the page", async () => {
    const s = await setUp();
    const server = await socketServer();
    cleanups.push(server.close);
    s.socks.routes.set("wsv3.fansly.com:443", server.port);
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    await siteSession(s, tab);
    const refused = async (n: number) => {
      const { client } = await socketOpened(s, server, tab, n);
      client.message(authorizationBytes(SITE_TOKEN), SOCKET_FILL.authorization);
      client.message(1, SOCKET_FILL.ping);
      await until(() => server.received().includes(SOCKET_FILL.ping), 3000, "the authorization and the ping at the server");
      // No guard report comes (Astra's exhausted-stack frame): only the bytes.
      client.message(52, SOCKET_FILL.forbidden);
      await client.closed;
    };
    await refused(4500);
    const alarm = await s.engine.waitFor("alarm", (message) => message.kind === "unknown_ws_message");
    expect(alarm.detail).toEqual({ at: "proxy", left: false, recordBytes: TLS13_OVERHEAD + 58, why: "a message of no allowed size", refusals: 1, scope: "tunnel" });
    expect(server.received().includes(SOCKET_FILL.forbidden)).toBe(false);
    expect(s.operator.page.halted).toBe(false);
    expect(s.operator.egress.exitOpen).toBe(true);
    expect(s.control.calls).not.toContain("kill");
    // The site connects again, and its records are refused again.
    await refused(4501);
    await refused(4502);
    await until(() => s.operator.page.snapshot.stopReason === "unknown_ws_message", 5000, "the stop");
    expect(server.received().includes(SOCKET_FILL.forbidden)).toBe(false);
    expect(s.operator.page.halted).toBe(true);
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.control.calls.at(-1)).toBe("kill");
    const last = await s.engine.waitFor("alarm", (message) => message.kind === "unknown_ws_message" && (message.detail as Record<string, unknown>).refusals === 3);
    expect(last.detail).toEqual({ at: "proxy", left: false, recordBytes: TLS13_OVERHEAD + 58, why: "a message of no allowed size", refusals: 3 });
    await s.operator.journals.close();
    expect(journal(s.logDir, "connections")).toContainEqual(expect.objectContaining({ host: "wsv3.fansly.com", result: `cut: the socket gate held a record of ${TLS13_OVERHEAD + 58} bytes (a message of no allowed size)` }));
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
});

describe("the site's delivered marks (owner decision 2026-10-23)", () => {
  it("are decided by their body as they stop in Fetch, the same in both modes: a delivered mark goes on unchanged, a read mark is failed — each journaled with why", async () => {
    const s = await setUp();
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    const ack = "https://apiv3.fansly.com/api/v1/message/ack?ngsw-bypass=true";
    const headers = { "Content-Type": "application/json" };
    const delivered = s.model.pause(ack, "POST", tab, "XHR", headers, '{"messageIds":["123456789012345678"],"type":1}');
    const read = s.model.pause(ack, "POST", tab, "XHR", headers, '{"messageIds":["123456789012345678"],"type":3}');
    await until(() => delivered.outcome !== "paused" && read.outcome !== "paused", 3000, "both decided");
    expect(delivered.outcome).toBe("continued");
    expect(read).toMatchObject({ outcome: "failed", failReason: "BlockedByClient" });
    // Nothing asked of the engine: the site's own requests are observed.
    expect(s.engine.of("siteAdmit")).toEqual([]);
    const admission = "the check of a write opened by its body (owner decision 2026-10-23)";
    await expect.poll(() => journal(s.logDir, "requests"), SETTLED).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "POST", host: "apiv3.fansly.com", path: "/api/v1/message/ack", admission, decision: "continued", result: "a delivered mark (type 1) of 1 message id(s), its body checked" }),
      expect.objectContaining({ method: "POST", host: "apiv3.fansly.com", path: "/api/v1/message/ack", admission, decision: "failed", result: expect.stringContaining("BlockedByClient: a read mark (type 3)") }),
    ]));
    // In the manual login too.
    const commandId = `c-${++commandN}`;
    s.engine.send({ type: "command", ownerGeneration: s.engine.generation, commandId, notAfterMono: monoMs() + 10_000, command: { kind: "setMode", mode: "manual_login" } });
    expect(await s.engine.waitFor("commandResult", (message) => message.commandId === commandId, 15_000)).toMatchObject({ ok: true });
    expect(s.operator.state.mode).toBe("manual_login");
    const manualRead = s.model.pause(ack, "POST", tab, "XHR", headers, '{"messageIds":["1"],"type":2}');
    const manualDelivered = s.model.pause(ack, "POST", tab, "XHR", headers, '{"messageIds":["1"],"type":1}');
    await until(() => manualRead.outcome !== "paused" && manualDelivered.outcome !== "paused", 3000, "both decided in the manual login");
    expect(manualRead).toMatchObject({ outcome: "failed", failReason: "BlockedByClient" });
    expect(manualDelivered.outcome).toBe("continued");
  });
});
