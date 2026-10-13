import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { EventBuffer } from "../apps/page-browser/src/buffer/buffer.ts";
import { MAX_WAITING, REPLAY_HIGH_WATER } from "../apps/page-browser/src/buffer/replay.ts";
import { DB_FILE } from "../apps/page-browser/src/buffer/store.ts";
import { authorizationBytes } from "../apps/page-browser/src/egress/socket-gate.ts";
import { ISSUE } from "../apps/page-browser/src/hub-requests/page.ts";
import { fanslyClientCheck, sessionFingerprint } from "../apps/page-browser/src/hub-requests/session.ts";
import { Operator, type OperatorDeps } from "../apps/page-browser/src/operator/operator.ts";
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
  writeNetSelftest,
  wsFrame,
} from "./helpers/page-browser-fakes.ts";

// The operator core (Project Browser plan §4.1, §4.9, §4.13; stage 3, PR 4)
// end to end, without Docker: the real holder and operator, a scripted fake
// Chrome behind them, a fake SOCKS5 and exit-IP service, and the engine's
// side of the RPC. What must hold: the start goes step by step to the open
// exit and no further; nothing leaves without an admission (none exists
// yet); a planned stop closes the exit before CDP goes; a lost control
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
  lines: string[];
  newOperator: () => Promise<Operator>;
  rpcPort: () => number;
}

async function setUp(
  options: {
    extension?: "required";
    exitIp?: () => string | Promise<string>;
    holderMaxBytes?: number;
    params?: Record<string, unknown>;
    buffer?: OperatorDeps["buffer"];
    socketTimings?: OperatorDeps["socketTimings"];
    /** Before the operator: what its buffer volume holds. */
    prepare?: (paths: { bufferDir: string; stateDir: string }) => void;
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
  cleanups.push(() => chrome.shutdown());
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
        heartbeatPath: join(temp.dir, "alive"),
        operatorVersion: "test",
      },
      chrome: control,
      exitIpTarget: { host: "api.ipify.org", port: 443, path: "/", wrap: (socket: Socket) => socket },
      ...(options.extension ? { extension: options.extension } : {}),
      ...(options.buffer ? { buffer: options.buffer } : {}),
      ...(options.socketTimings ? { socketTimings: options.socketTimings } : {}),
      timings: { replayWaitMs: 2000, chromeUpMs: 5000, attachMs: 3000, envCheckMs: 3000, stateEveryMs: 200, healthEveryMs: 100, healthAnswerMs: 300, selfTestProbeMs: 2000, exitIpTimeoutMs: 2000, quitWaitMs: 1000 },
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
  engine.send(hello({ socks5: { ip: "127.0.0.1", port: socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }, options.params));
  await engine.waitFor("helloResult");
  return { dir: temp.dir, operator, engine, chrome, model, control, holder, socks, logDir, netSelftest, chromeEnv, lines, newOperator, rpcPort: () => rpcPort };
}

let commandN = 0;
function command(engine: FakeEngine, kind: string): Promise<Record<string, unknown>> {
  const commandId = `c-${++commandN}`;
  engine.send({ type: "command", ownerGeneration: engine.generation, commandId, notAfterMono: monoMs() + 10_000, command: { kind } });
  return engine.waitFor("commandResult", (message) => message.commandId === commandId, 15_000);
}

async function started(s: SetUp): Promise<void> {
  expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
  await until(() => s.operator.page.step === "exit_open", 10_000, "the open exit");
}

function journal(logDir: string, kind: string): Array<Record<string, unknown>> {
  return readdirSync(logDir)
    .filter((name) => name.startsWith(`${kind}-`) && name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the start (plan §4.1)", () => {
  it("stands with the exit closed until the engine starts the page", async () => {
    const s = await setUp();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.operator.page.snapshot).toEqual({ step: "exit_closed", stopReason: null, retryAtWall: null, halted: false });
    expect(s.control.calls).toEqual([]);
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.engine.last("state")).toMatchObject({ step: "exit_closed", exitOpen: false });
  });

  it("goes step by step to the open exit, with the self-test passed and the exit IP verified, and stops there", async () => {
    const s = await setUp();
    await started(s);
    await until(() => s.engine.of("state").some((state) => state.step === "exit_open"));
    const steps = s.engine.of("state").map((state) => state.step).filter((step, index, all) => step !== all[index - 1]);
    expect(steps.slice(steps.lastIndexOf("exit_closed"))).toEqual(["exit_closed", "env_applied", "chrome_started", "control_attached", "selftest_passed", "exit_ip_verified", "exit_open"]);
    const state = s.engine.last("state")!;
    expect(state).toMatchObject({ exitOpen: true, exitIp: "203.0.113.7", chromeVersion: "Chrome/155.0.8059.39", operatorVersion: "test", stopReason: null });
    expect(state.selfTest).toMatchObject({ ok: true, failed: null, notInstalled: ["dnr_never", "dnr_write"] });
    const checks = s.operator.lastSelfTest!.checks;
    expect([checks.proxy_closed.status, checks.os_rules.status, checks.dnr_never.status, checks.dnr_write.status]).toEqual(["passed", "passed", "not_installed", "not_installed"]);
    // The probe reached the interception, went on, and met the closed exit.
    const probe = s.model.requests.find((request) => request.fragment.startsWith("#pb-selftest-"))!;
    expect(probe).toMatchObject({ method: "GET", outcome: "continued", proxyStatus: 403 });
    expect(new URL(probe.url).hostname).toBe("apiv3.fansly.com");
    expect(journal(s.logDir, "connections")).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", port: 443, refused: true, result: "refused: exit closed" }));
    expect(journal(s.logDir, "requests")).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", path: "/api/v1/pb-selftest", decision: "continued", admission: "self-test probe (exit closed)" }));
    // The exit IP through the page's SOCKS5, with its password.
    expect(s.socks.connects).toContain("api.ipify.org:443");
    expect(s.socks.logins.every((login) => login.ok && login.password === SOCKS_PASSWORD)).toBe(true);
    // No navigation: steps 8–10 are later PRs'.
    expect(s.chrome.sent("Page.navigate")).toEqual([]);
    expect(s.operator.admissionsOpen()).toBe(true);
    // The states journal has every transition.
    expect(journal(s.logDir, "states").map((line) => line.to)).toContain("exit_open");
  });

  it("fails every paused request that is not a self-test probe: nothing leaves without an admission", async () => {
    const s = await setUp();
    await started(s);
    const site = s.model.pause("https://fansly.com/", "GET");
    const api = s.model.pause("https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true", "GET");
    const write = s.model.pause("https://apiv3.fansly.com/api/v1/message/ack", "POST");
    // A request carrying a probe's marker outside the self-test.
    const fakeProbe = s.model.pause("https://apiv3.fansly.com/api/v1/pb-selftest?pbst=x#pb-selftest-x", "GET");
    await until(() => [site, api, write, fakeProbe].every((request) => request.outcome === "failed"));
    expect([site, api, write, fakeProbe].map((request) => request.failReason)).toEqual(["BlockedByClient", "BlockedByClient", "BlockedByClient", "BlockedByClient"]);
    expect(s.chrome.sent("Fetch.continueRequest")).toHaveLength(1); // the self-test's own probe only
    expect(journal(s.logDir, "requests")).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", path: "/api/v1/account/me", decision: "failed", admission: null }));
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
    expect(s.control.calls).toContain("kill");
    // The retry runs the start again (and fails again).
    await until(() => s.control.calls.filter((call) => call === "start").length >= 2, 5000, "a retry");
    expect(s.engine.of("state").some((state) => state.exitOpen === true)).toBe(false);
  });

  it("with the rules extension required, passes only when it cancels both probes before the interception", async () => {
    const s = await setUp({ extension: "required" });
    s.model.extensionInstalled = true;
    await started(s);
    const checks = s.operator.lastSelfTest!.checks;
    expect([checks.dnr_never.status, checks.dnr_write.status]).toEqual(["passed", "passed"]);
    expect(s.engine.last("state")!.selfTest).toEqual({ ok: true, atWall: expect.any(Number), failed: null });
  });

  it("with the rules extension required and missing, fails the self-test", async () => {
    const s = await setUp({ extension: "required" });
    s.engine.send({ type: "ping", n: 1, ownerGeneration: 1 });
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
    const s = await setUp();
    await started(s);
    const checks = s.socks.connects.filter((target) => target === "api.ipify.org:443").length;
    expect(await command(s.engine, "closeExit")).toMatchObject({ ok: true });
    expect(s.operator.egress.exitOpen).toBe(false);
    expect(s.operator.page.step).toBe("exit_ip_verified");
    expect(await command(s.engine, "openExit")).toMatchObject({ ok: true, detail: "the exit is open" });
    expect(s.socks.connects.filter((target) => target === "api.ipify.org:443").length).toBe(checks + 1);
    expect(s.operator.page.step).toBe("exit_open");
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
    expect(s.operator.page.step).toBe("exit_open");
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

  it("restartBrowser on a running page starts it again at once: the previous Chrome's holder going is no failure", async () => {
    const s = await setUp();
    await started(s);
    const before = s.engine.of("state").length;
    expect(await command(s.engine, "restartBrowser")).toMatchObject({ ok: true });
    await until(() => s.control.calls.filter((call) => call === "start").length === 2 && s.operator.page.step === "exit_open", 5000, "the page up again");
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
      detail: "proxy_closed: passed, os_rules: passed, dnr_never: not_installed, dnr_write: not_installed",
    });
  });

  it("not supported yet are refused, and a repeated id is not executed twice", async () => {
    const s = await setUp();
    expect(await command(s.engine, "profileSnapshot")).toMatchObject({ ok: false, detail: "profileSnapshot is not supported by this operator yet" });
    s.engine.send({ type: "command", ownerGeneration: 1, commandId: "same", notAfterMono: monoMs() + 10_000, command: { kind: "restartBrowser" } });
    s.engine.send({ type: "command", ownerGeneration: 1, commandId: "same", notAfterMono: monoMs() + 10_000, command: { kind: "restartBrowser" } });
    await until(() => s.engine.of("commandResult").filter((message) => message.commandId === "same").length === 2);
    await until(() => s.operator.page.step === "exit_open", 10_000);
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
    await until(() => s.operator.page.step === "selftest_passed", 10_000, "the exit-IP check under way");
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
    await until(() => s.operator.page.step === "selftest_passed", 10_000, "the exit-IP check under way");
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
    await until(() => s.operator.page.step === "exit_open", 10_000, "the third owner's page up");
    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(s.operator.page.step).toBe("exit_open");
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
    await until(() => s.operator.page.step === "exit_open", 10_000, "the page back");
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

describe("the page's environment (plan §4.1, step 2; PR 5)", () => {
  const evaluations = (s: SetUp, marker: string) => s.chrome.sent("Runtime.evaluate").filter((command) => String(command.params.expression).includes(marker));

  it("goes to Chrome's start from the hello, its position to every tab before it runs, and is verified in the browser", async () => {
    const s = await setUp();
    await started(s);
    // Chrome's start took the hello's time zone and languages from the hand-over.
    expect(readFileSync(s.chromeEnv, "utf8")).toBe("TZ=Europe/Berlin\nLANGUAGES=en-US,en\n");
    expect(s.model.handovers).toEqual(["TZ=Europe/Berlin\nLANGUAGES=en-US,en\n"]);
    const states = journal(s.logDir, "states");
    expect(states.find((line) => line.to === "env_applied")?.note).toBe("time zone Europe/Berlin; languages en-US, en; position 52.5, 13.4 ±50 m");
    expect(String(states.find((line) => line.to === "control_attached")?.note)).toContain("environment verified: time zone Europe/Berlin");
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
    expect(s.chrome.sent("Fetch.continueRequest")).toHaveLength(1); // the self-test's probe only
    expect(journal(s.logDir, "requests")).toContainEqual(expect.objectContaining({ host: "127.0.0.1", path: "/pb-env-check", decision: "fulfilled" }));
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
    ["a screen", { screen: { width: 800, height: 600 } }, "screen 800×600, not 1920×1080"],
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
    expect(s.control.calls).toContain("kill");
    await until(() => s.control.calls.filter((call) => call === "start").length >= 2, 5000, "a retry");
  });

  it("is verified again on every start: after Chrome crashed, and then a difference fails that start", async () => {
    const s = await setUp();
    await started(s);
    expect(evaluations(s, "pbEnvShown")).toHaveLength(1);
    await s.chrome.shutdown();
    await until(() => s.operator.page.snapshot.stopReason === "chrome_crashed", 3000);
    await until(() => s.operator.page.step === "exit_open", 10_000, "the page back");
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
    await until(() => s.model.handovers.at(-1) === kyiv && s.operator.page.step === "exit_open", 5000, "the page up again");
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
    expect(s.operator.page.step).toBe("exit_open");
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
    expect(state.buffer).toEqual({ bytes, oldestAgeMs: expect.any(Number) });
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
    await until(() => s.operator.page.step === "exit_open", 10_000, "the page to start again");
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
    await until(() => s.operator.page.step === "exit_open", 10_000, "the page to start");
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
    await started(s);
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
    s.model.navigate(tab.sessionId, "https://fansly.com/");
    await until(() => s.operator.control.workTab?.url === "https://fansly.com/", 3000, "the tab at the site");
    // The site's own API request: failed (no admitting path for it yet), its session learned.
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
    await until(() => site.outcome === "failed", 3000, "the site's request to fail");
    s.engine.onMessage = (message) => {
      if (message.type === "check") s.engine.send({ type: "checkResult", ownerGeneration: 1, attemptId: message.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
    };
    s.engine.send(sendOf(s.engine, 9100));
    const result = await s.engine.waitFor("result", (message) => message.attemptId === 9100, 10_000);
    const outcome = result.outcome as { kind: string; status: number; headers: Record<string, string>; body: { bodyId: string; decodedBytes: number; sha256: string }; source: string; sentMono: number; sendMark: string };
    // Chrome's moment of the send, never earlier than the gate's.
    const gateSent = s.engine.of("sent")[0]!.sentMono as number;
    expect(outcome).toMatchObject({ kind: "response", status: 200, headers: { "content-type": "application/json", "content-length": String(s.model.hubBody.length) }, source: "network", sentMono: Math.max(777_125 + 1.5, gateSent), sendMark: "transport_reported" });
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
    expect(journal(s.logDir, "requests")).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", path: ME, admission: "hub attempt 9100", decision: "continued", result: "released under its admission" }));
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
    expect(journal(s.logDir, "requests")).toContainEqual(expect.objectContaining({ host: "wsv3.fansly.com", decision: "failed", result: "BlockedByClient: the socket host serves sockets only" }));
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
    expect(s.control.calls).toContain("kill");
    expect(await s.engine.waitFor("wsDone")).toMatchObject({ attemptId: 4500, sent: true, status: null, error: expect.stringContaining("not accounted for") });
    await until(() => s.control.calls.filter((call) => call === "start").length >= 2 && s.operator.page.step === "exit_open", 10_000, "Chrome started again");
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
