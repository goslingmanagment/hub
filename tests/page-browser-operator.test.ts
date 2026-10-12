import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

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
  until,
  writeNetSelftest,
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
  operator: Operator;
  engine: FakeEngine;
  chrome: FakeChrome;
  model: BrowserModel;
  control: FakeChromeControl;
  holder: HolderUnderS6;
  socks: FakeSocks;
  logDir: string;
  netSelftest: string;
  lines: string[];
  newOperator: () => Promise<Operator>;
  rpcPort: () => number;
}

async function setUp(options: { extension?: "required"; exitIp?: () => string; holderMaxBytes?: number } = {}): Promise<SetUp> {
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
        logDir,
        stateDir: join(temp.dir, "state"),
        heartbeatPath: join(temp.dir, "alive"),
        operatorVersion: "test",
      },
      chrome: control,
      exitIpTarget: { host: "api.ipify.org", port: 443, path: "/", wrap: (socket: Socket) => socket },
      ...(options.extension ? { extension: options.extension } : {}),
      timings: { replayWaitMs: 2000, chromeUpMs: 5000, attachMs: 3000, stateEveryMs: 200, healthEveryMs: 100, healthAnswerMs: 300, selfTestProbeMs: 2000, exitIpTimeoutMs: 2000, quitWaitMs: 1000 },
    });
    const ports = await operator.start();
    cleanups.push(() => operator.stop());
    model.proxyPort = ports.proxyPort;
    rpcPort = ports.rpcPort;
    return operator;
  };
  const operator = await newOperator();
  await until(() => operator.cdp.linked, 3000, "the holder link");
  const engine = new FakeEngine();
  await engine.connect(rpcPort);
  cleanups.push(() => engine.close());
  engine.send(hello({ socks5: { ip: "127.0.0.1", port: socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
  await engine.waitFor("helloResult");
  return { operator, engine, chrome, model, control, holder, socks, logDir, netSelftest, lines, newOperator, rpcPort: () => rpcPort };
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
