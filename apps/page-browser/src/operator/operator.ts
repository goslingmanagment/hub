// The page operator (plan §3.1, §4.1, §4.9, §4.13): Chrome's only way out
// (egress/), its control over CDP through the holder (cdp/), the self-test
// (selftest/), the engine's RPC (rpc/), the journals (logs/) — and the start
// of plan §4.1, step by step:
//
//   1 exit closed → 2 environment → 3 Chrome started (by s6, on the
//   operator's command) → 4 control attached → 5 self-test with the exit
//   closed → 6 exit IP verified through the page's SOCKS5 → 7 exit open.
//
// Steps 8–10 (the site loads, the session is confirmed, ready) come with
// later PRs; this operator stops at the open exit and never navigates.
//
// What holds in this PR, whatever happens:
// - No request leaves without the engine's admission. No path admits one
//   yet (site requests: PR 7; Hub's: PR 9), so every paused request but a
//   self-test probe is failed, and the send gate opens no window: no API
//   record leaves.
// - A page starts only on the engine's restartBrowser; a failure stops it
//   and retries after 10 s, 30 s, 2 min, then every 5 min; a halt (the
//   engine's stopPage, a changed exit IP) holds until the next
//   restartBrowser. An operator that starts again stands until the engine
//   starts the page (stage 1, amendment 17).
// - A planned stop closes the exit before CDP goes (plan §4.1). A lost
//   control — CDP, the holder, its overflow, a browser that stops answering —
//   closes the exit at once, kills Chrome and retries.

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Cdp, type HolderLink } from "../cdp/client.ts";
import { BrowserControl } from "../cdp/control.ts";
import { PausedRequests, type PausedDecision, type PausedRequest } from "../cdp/paused.ts";
import { checkExitIp, IPIFY, normalizeIp, type ExitIpTarget } from "../egress/exit-ip.ts";
import { classifyFanslyHost, FANSLY_HOSTS, type HostClassifier } from "../egress/hosts.ts";
import { Egress } from "../egress/proxy.ts";
import { SocksError, type SocksConfig } from "../egress/socks5.ts";
import { hostAndPath, Journals } from "../logs/journal.ts";
import { GenerationStore } from "../rpc/generation.ts";
import type { CommandOutcome } from "../rpc/ledger.ts";
import { DEFAULT_PARAMS, type AlarmKind, type Command, type Hello, type OperatorParams, type SelfTestMechanism, type State } from "../rpc/protocol.ts";
import { RpcServer } from "../rpc/server.ts";
import { EXTENSION_CHECKS, runSelfTest, type ExtensionChecks, type SelfTestResult } from "../selftest/selftest.ts";
import { ProbeDriver } from "../selftest/probes.ts";
import { PageState } from "../state/page-state.ts";
import { atLeast, type StopReason } from "../state/steps.ts";
import { registerSecret } from "../shared/secrets.ts";
import { errorMessage, makeLog, monoMs, sleep, type Logger } from "../shared/util.ts";
import type { ChromeControl } from "./chrome.ts";
import type { OperatorConfig } from "./config.ts";
import { HealthProbe } from "./health.ts";

export interface OperatorTimings {
  /** Between attempts to link to the holder. */
  holderRelinkMs: number;
  /** How long a new link waits for the holder's replay to be handled. */
  replayWaitMs: number;
  /** From Chrome's start to its DevTools connection held. */
  chromeUpMs: number;
  /** The control's setup and the work tab. */
  attachMs: number;
  heartbeatMs: number;
  /** A `state` at least this often (the engine alarms after 2 min without). */
  stateEveryMs: number;
  healthEveryMs: number;
  healthAnswerMs: number;
  selfTestProbeMs: number;
  exitIpTimeoutMs: number;
  /** A planned stop waits this long for Chrome to quit by itself. */
  quitWaitMs: number;
}

const DEFAULT_TIMINGS: OperatorTimings = {
  holderRelinkMs: 100,
  replayWaitMs: 10_000,
  chromeUpMs: 30_000,
  attachMs: 10_000,
  heartbeatMs: 1000,
  stateEveryMs: 5000,
  healthEveryMs: 2000,
  healthAnswerMs: 5000,
  selfTestProbeMs: 4000,
  exitIpTimeoutMs: 15_000,
  quitWaitMs: 5000,
};

export interface OperatorDeps {
  config: OperatorConfig;
  chrome: ChromeControl;
  classify?: HostClassifier;
  /** The host of the self-test's probes: the API host. */
  apiHost?: string;
  exitIpTarget?: ExitIpTarget;
  extension?: ExtensionChecks;
  timings?: Partial<OperatorTimings>;
  log?: Logger;
}

interface EngineSettings {
  pageId: number;
  expectedAccountId: string;
  pinnedExitIp: string;
  socks: SocksConfig;
  env: Hello["env"];
}

/** A step of the start failed, and why the page stands. */
class StartFailure extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The start was superseded (a newer start, a stop, a failure elsewhere). */
class Cancelled extends Error {}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class Operator {
  readonly config: OperatorConfig;
  readonly chrome: ChromeControl;
  readonly egress: Egress;
  readonly rpc: RpcServer;
  readonly cdp: Cdp;
  readonly control: BrowserControl;
  readonly probes: ProbeDriver;
  readonly page: PageState;
  readonly journals: Journals;
  readonly paused: PausedRequests;
  readonly #health: HealthProbe;
  readonly #timings: OperatorTimings;
  readonly #log: Logger;
  readonly #apiHost: string;
  readonly #exitIpTarget: ExitIpTarget;
  readonly #extension: ExtensionChecks;
  readonly #bufferId: string;
  #params: OperatorParams = DEFAULT_PARAMS;
  #settings: EngineSettings | null = null;
  /** The current start; a newer one, a stop or a failure supersedes it. */
  #run = 0;
  #starting = false;
  /** The start that runs now, or the last one: settles when it ended. */
  #runDone: Promise<void> = Promise.resolve();
  /** A start being ended for a new owner (#stand): settles when it ended. */
  #standing: Promise<void> = Promise.resolve();
  /** The holder is stopping: the exit stays closed until a holder links
   *  again — nothing may open it between "exit.closed" and the detach. */
  #holderStopping = false;
  #stopped = false;
  #linking = false;
  /** Chrome runs under the operator's control: losing it is a failure. */
  #controlExpected = false;
  /** The engine closed the exit: a start stops short of opening it. */
  #exitHeld = false;
  #selfTest: SelfTestResult | null = null;
  #exitIp: string | null = null;
  #chromeVersion = "";
  #retryTimer: NodeJS.Timeout | null = null;
  #ipTimer: NodeJS.Timeout | null = null;
  #ipChecking = false;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #stateTimer: NodeJS.Timeout | null = null;
  #commandChain: Promise<void> = Promise.resolve();
  /** Chrome is started, stopped and killed one operation at a time. */
  #chromeChain: Promise<void> = Promise.resolve();

  constructor(deps: OperatorDeps) {
    this.config = deps.config;
    this.chrome = deps.chrome;
    this.#timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.#log = deps.log ?? makeLog("operator");
    this.#apiHost = deps.apiHost ?? FANSLY_HOSTS.api[0];
    this.#exitIpTarget = deps.exitIpTarget ?? IPIFY;
    this.#extension = deps.extension ?? EXTENSION_CHECKS;
    registerSecret(this.config.rpcToken);
    mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 });
    this.#bufferId = loadBufferId(this.config.stateDir);

    this.journals = new Journals({
      dir: this.config.logDir,
      // Nothing may pass unrecorded: the exit closes, and a running page
      // fails (and tries again after the backoff).
      onTrouble: (reason) => {
        this.egress.closeExit(`journals: ${reason}`);
        if (this.#controlExpected || this.#starting) void this.#fail("disk_full", `the journals cannot be written: ${reason}`);
      },
    });
    this.page = new PageState({ backoffMs: DEFAULT_PARAMS.restartBackoffMs });
    this.page.onTransition = (transition) => {
      this.#log("state", { from: transition.from, to: transition.to, stopReason: transition.stopReason, retryAtWall: transition.retryAtWall, halted: transition.halted, note: transition.note });
      this.journals.state({ ...transition });
      this.#sendState();
    };

    this.egress = new Egress({
      classify: deps.classify ?? classifyFanslyHost,
      onRecord: (record) =>
        this.journals.connection({
          id: record.id,
          host: record.host,
          port: record.port,
          cls: record.cls,
          openedWall: record.openedWall,
          closedWall: record.closedWall,
          durationMs: record.closedMono === null ? null : Math.round(record.closedMono - record.openedMono),
          up: record.up,
          down: record.down,
          held: record.held,
          refused: record.refused,
          result: record.result,
        }),
      onSocksFailure: (kind, message) => {
        if (this.page.step !== "exit_open") return;
        void this.#fail(kind === "auth" ? "proxy_auth" : "proxy_unavailable", `the page's SOCKS5 failed a tunnel: ${message}`);
      },
    });

    this.cdp = new Cdp({ socketPath: this.config.holderSock });
    this.control = new BrowserControl(this.cdp, {
      networkBuffer: DEFAULT_PARAMS.chromeBodyBuffer,
      onSetupFailed: (target, error) => {
        if (!this.#controlExpected) return;
        void this.#fail("cdp_lost", `a ${target.type} could not be set up: ${error.message}`);
      },
    });
    this.probes = new ProbeDriver(this.cdp, this.control, { apiHost: this.#apiHost, exitClosed: () => !this.egress.exitOpen });
    this.paused = new PausedRequests(this.cdp, {
      decide: (request) => this.#decide(request),
      onDecided: (request, decision) => this.#journalRequest(request, decision),
      // With CDP or the holder link down, their own loss handles it; with
      // both up, Chrome is not answering for its paused requests.
      onIndeterminate: (_request, why) => {
        if (this.cdp.cdpUp && this.cdp.linked) this.#controlLost("cdp_lost", `a paused request's resolution got no answer (${why})`);
      },
    });
    this.#health = new HealthProbe(this.cdp, this.control, this.chrome, {
      everyMs: this.#timings.healthEveryMs,
      answerMs: this.#timings.healthAnswerMs,
      onUnhealthy: (reason) => this.#controlLost("cdp_lost", reason),
    });
    this.cdp.onHolderEvent = (event) => {
      switch (event.t) {
        case "cdp.down":
          this.#controlLost("cdp_lost", `Chrome's DevTools connection closed (${event.reason})`);
          return;
        case "overflow":
          this.#controlLost("holder_overflow", "the holder's store overflowed: the operator fell behind");
          return;
        case "stopping":
          // The holder is told to stop: the exit closes before it lets go of
          // CDP, and stays closed — a start or an openExit under way ends
          // here, none may open it before the detach.
          this.#holderStopping = true;
          this.#cancelRun();
          this.#clearRetry();
          this.egress.closeExit("the holder stops");
          this.cdp.holderCommand("exit.closed");
          return;
        case "cdp.up":
          if (!this.#controlExpected) this.#log("chrome.up_without_a_start", { note: "left alone: the exit is closed" });
          return;
      }
    };
    this.cdp.onHolderGone = () => {
      this.#controlLost("cdp_lost", "the holder link closed");
      if (!this.#stopped) void this.#linkHolder(false);
    };

    this.rpc = new RpcServer({
      token: this.config.rpcToken,
      generations: new GenerationStore(join(this.config.stateDir, "owner-generation")),
      pingMs: DEFAULT_PARAMS.pingMs,
      linkLossMs: DEFAULT_PARAMS.linkLossMs,
      handlers: {
        onHello: (hello) => this.#onHello(hello),
        quiesce: () => this.#quiesce(),
        onCommand: (command) => this.#onCommand(command),
        onLink: (up, reason) => {
          this.#log(up ? "engine.linked" : "engine.lost", { reason, admissionsOpen: this.admissionsOpen() });
          if (up) this.#sendState();
        },
      },
    });
  }

  /** Listen (the exit closed), link to the holder, and stand until the
   *  engine starts the page. Returns the proxy's and the RPC's ports. */
  async start(): Promise<{ proxyPort: number; rpcPort: number }> {
    this.#beat();
    this.#heartbeatTimer = setInterval(() => this.#beat(), this.#timings.heartbeatMs);
    const proxyPort = await this.egress.listen(this.config.proxyPort, this.config.proxyHost);
    const rpcPort = await this.rpc.listen(this.config.rpcPort, this.config.rpcHost);
    this.#stateTimer = setInterval(() => this.#sendState(), this.#timings.stateEveryMs);
    void this.#linkHolder(true);
    this.#log("started", { proxyPort, rpcPort, bufferId: this.#bufferId, version: this.config.operatorVersion });
    return { proxyPort, rpcPort };
  }

  /** SIGTERM: the exit closes; Chrome and CDP stay with the holder. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.egress.closeExit("the operator stops");
    this.#cancelRun();
    this.#clearRetry();
    this.#health.stop();
    this.#stopIpTimer();
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#stateTimer) clearInterval(this.#stateTimer);
    this.cdp.close();
    await this.rpc.close();
    await this.egress.close();
    await this.journals.close();
  }

  /** May a request get an admission now (PR 7, PR 9)? Only with the engine
   *  heard within 5 s (plan §4.13) and the exit open. */
  admissionsOpen(): boolean {
    return this.rpc.linkUp && this.egress.exitOpen && this.page.step === "exit_open" && !this.page.halted;
  }

  get state(): State {
    const snapshot = this.page.snapshot;
    const selfTest = this.#selfTest;
    const notInstalled = selfTest ? (Object.entries(selfTest.checks).filter(([, check]) => check.status === "not_installed").map(([name]) => name) as SelfTestMechanism[]) : [];
    return {
      type: "state",
      step: snapshot.step,
      stopReason: snapshot.stopReason,
      retryAtWall: snapshot.retryAtWall,
      exitOpen: this.egress.exitOpen,
      mode: "automation",
      sessionFingerprint: null,
      accountId: null,
      exitIp: this.#exitIp,
      chromeVersion: this.#chromeVersion,
      operatorVersion: this.config.operatorVersion,
      buffer: { bytes: 0, oldestAgeMs: 0 },
      selfTest: selfTest ? { ok: selfTest.ok, atWall: selfTest.atWall, failed: selfTest.failed, ...(notInstalled.length > 0 ? { notInstalled } : {}) } : null,
    };
  }

  get lastSelfTest(): SelfTestResult | null {
    return this.#selfTest;
  }

  // ── the holder ─────────────────────────────────────────────────────────

  async #linkHolder(first: boolean): Promise<void> {
    if (this.#linking) return;
    this.#linking = true;
    try {
      while (!this.#stopped) {
        let link: HolderLink;
        try {
          link = await this.cdp.connect();
          this.#holderStopping = false;
        } catch {
          await sleep(this.#timings.holderRelinkMs);
          continue;
        }
        this.#log("holder.linked", { cdpUp: link.cdpUp, stored: link.stored, lastSeq: link.lastSeq });
        // What the holder kept from before this instance is handled first:
        // paused requests among it are failed (cdp/paused.ts), and Chrome
        // has answered that before anything else is decided.
        const replayDeadline = Date.now() + this.#timings.replayWaitMs;
        await Promise.race([this.cdp.replayEnded, sleep(this.#timings.replayWaitMs)]);
        await this.#waitUntil(() => this.paused.resolving === 0, Math.max(0, replayDeadline - Date.now()));
        if (first && link.cdpUp && !this.#controlExpected && !this.#starting) {
          // A previous instance's Chrome: this one does not know its targets.
          // The page stands until the engine starts it again.
          this.#log("chrome.from_previous_instance", { action: "killed" });
          this.egress.closeExit("a Chrome from before this operator");
          await this.#withChrome(() => this.chrome.kill()).catch((error: unknown) => this.#log("chrome.kill_failed", { error: errorMessage(error) }));
        }
        // The link may have gone during the replay or the cleanup; its loss
        // could not start another link while this one ran: link again.
        if (!this.cdp.linked) continue;
        return;
      }
    } finally {
      this.#linking = false;
    }
  }

  /** Control of Chrome is gone, or cannot be trusted: the exit closes at
   *  once; if the operator was running Chrome, that is a failure. */
  #controlLost(reason: "cdp_lost" | "holder_overflow", detail: string): void {
    const exitWasOpen = this.egress.exitOpen;
    const gate = this.egress.gate.state;
    this.egress.closeExit(`control lost: ${detail}`);
    if (!this.#controlExpected) {
      this.#log("control.closed", { detail });
      return;
    }
    // Owner decision №10's fallback (stage 1, amendment 29): Chrome lets go of
    // every held request when it loses CDP. With the exit open, one it let
    // go by itself may have left (through a plain tunnel, or in a window of
    // the gate) — the alarm says so until a send is proven the admitted one.
    this.#alarm(reason === "holder_overflow" ? "overflow" : "cdp_lost", {
      detail,
      exitOpenAtLoss: exitWasOpen,
      gatePhaseAtLoss: gate.phase,
      foreignRequestMayHaveLeft: exitWasOpen,
    });
    void this.#fail(reason, `control lost: ${detail}`);
  }

  // ── the start (plan §4.1) ─────────────────────────────────────────────

  /** A start, remembered until it ends (a new owner waits for it). */
  #launch(fresh: boolean, note: string): Promise<void> {
    const done = this.#startRun(fresh, note);
    this.#runDone = done;
    return done;
  }

  async #startRun(fresh: boolean, note: string): Promise<void> {
    if (this.#stopped || (!fresh && this.page.halted)) return;
    this.#clearRetry();
    const run = ++this.#run;
    this.#starting = true;
    const check = () => {
      if (run !== this.#run || this.#stopped) throw new Cancelled();
    };
    this.egress.closeExit("a start");
    this.#health.stop();
    this.#stopIpTimer();
    this.page.beginStart(note, fresh);
    try {
      // Nothing may pass unrecorded: the journals must be writing.
      if (!(await this.journals.flushed())) throw new StartFailure("disk_full", "the journals cannot be written");
      check();
      // A Chrome that runs now is a previous start's or nobody's: the page
      // starts with a fresh one.
      await this.#withChrome(async () => {
        if (await this.chrome.isUp()) await this.#stopChrome("a start begins with a fresh Chrome");
      });
      check();
      if (!(await this.#waitUntil(() => !this.cdp.cdpUp, 3000))) throw new StartFailure("cdp_lost", "the holder still holds the previous Chrome");
      check();
      this.page.advance("env_applied", "the container's time zone and language; the page's own come with PR 5");
      await this.#withChrome(async () => {
        check();
        this.control.reset();
        this.#controlExpected = true;
        await this.chrome.start();
      });
      check();
      if (!(await this.#waitUntil(() => this.cdp.cdpUp, this.#timings.chromeUpMs))) {
        throw new StartFailure((await this.chrome.isUp()) ? "cdp_lost" : "chrome_crashed", "Chrome's DevTools connection did not come up");
      }
      check();
      this.page.advance("chrome_started");
      await this.control.attach(this.#timings.attachMs);
      this.#chromeVersion = await this.control.version();
      check();
      this.page.advance("control_attached", this.#chromeVersion);
      this.#health.start();
      const result = await this.#selfTestNow();
      check();
      if (!result.ok) throw new StartFailure("selftest_failed", `the self-test failed: ${result.failed ?? "?"}`);
      this.page.advance("selftest_passed", `in ${result.durationMs} ms`);
      const ip = await this.#verifyExitIp();
      check();
      this.page.advance("exit_ip_verified", ip);
      if (this.#exitHeld) this.#log("exit.held", { note: "the engine's closeExit: the start stops short of opening it" });
      else this.#openExit();
    } catch (error) {
      if (error instanceof Cancelled || run !== this.#run) return;
      const failure = error instanceof StartFailure ? error : new StartFailure("cdp_lost", errorMessage(error));
      if (failure.reason === "exit_ip_changed") await this.#halt(failure.reason, failure.message, "stop");
      else await this.#fail(failure.reason, failure.message);
    } finally {
      if (run === this.#run) this.#starting = false;
    }
  }

  #openExit(): void {
    if (this.#holderStopping) {
      this.#log("exit.kept_closed", { why: "the holder is stopping" });
      return;
    }
    this.egress.openExit();
    this.page.advance("exit_open");
    this.#armIpTimer();
  }

  async #selfTestNow(): Promise<SelfTestResult> {
    if (this.egress.exitOpen) throw new Error("the self-test runs only with the exit closed");
    const result = await runSelfTest({
      probe: (kind, method, path, marker, deadline) => this.probes.probe(kind, method, path, marker, deadline),
      closedExitRefusalsSince: (since) => this.egress.refusalsSince(this.#apiHost, 443, since).filter((record) => record.result === "refused: exit closed").length,
      readKernelResult: () => JSON.parse(readFileSync(this.config.netSelftestPath, "utf8")) as unknown,
      extension: this.#extension,
      maxMs: this.#params.selfTestMaxMs,
      probeMs: this.#timings.selfTestProbeMs,
    });
    this.#selfTest = result;
    this.#log("selftest", {
      ok: result.ok,
      failed: result.failed,
      durationMs: result.durationMs,
      checks: Object.fromEntries(Object.entries(result.checks).map(([name, check]) => [name, `${check.status}: ${check.detail}`])),
    });
    if (!result.ok && result.failed) this.#alarm("selftest_failed", { failed: result.failed, detail: result.checks[result.failed].detail });
    this.#sendState();
    return result;
  }

  async #verifyExitIp(): Promise<string> {
    const settings = this.#settings;
    if (!settings) throw new StartFailure("proxy_unavailable", "no SOCKS5 of the page from the engine yet");
    let ip: string;
    try {
      ip = await checkExitIp(settings.socks, this.#exitIpTarget, this.#timings.exitIpTimeoutMs);
    } catch (error) {
      if (error instanceof SocksError && error.kind === "auth") throw new StartFailure("proxy_auth", "the page's SOCKS5 refused the login");
      throw new StartFailure("proxy_unavailable", `the exit IP check failed: ${errorMessage(error)}`);
    }
    if (ip !== settings.pinnedExitIp) throw new StartFailure("exit_ip_changed", `the exit IP ${ip} is not the pinned ${settings.pinnedExitIp}`);
    this.#exitIp = ip;
    return ip;
  }

  #armIpTimer(): void {
    this.#stopIpTimer();
    this.#ipTimer = setInterval(() => void this.#periodicIpCheck(), this.#params.exitIpCheckMs);
  }

  #stopIpTimer(): void {
    if (this.#ipTimer) clearInterval(this.#ipTimer);
    this.#ipTimer = null;
  }

  /** Every 5 min while the exit is open (plan §4.5): a changed IP stops the
   *  page until the owner decides; a SOCKS5 that is gone or refuses the
   *  login fails it (a retry resumes it once the proxy is back as it was). */
  async #periodicIpCheck(): Promise<void> {
    if (this.#ipChecking || this.page.step !== "exit_open") return;
    this.#ipChecking = true;
    const run = this.#run;
    try {
      await this.#verifyExitIp();
    } catch (error) {
      if (run !== this.#run || this.page.step !== "exit_open") return;
      const failure = error instanceof StartFailure ? error : new StartFailure("proxy_unavailable", errorMessage(error));
      if (failure.reason === "exit_ip_changed") await this.#halt(failure.reason, failure.message, "stop");
      else await this.#fail(failure.reason, failure.message);
    } finally {
      this.#ipChecking = false;
    }
  }

  // ── failures and stops ─────────────────────────────────────────────────

  #cancelRun(): void {
    this.#run += 1;
    this.#starting = false;
  }

  #clearRetry(): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** End whatever start runs, kill its Chrome, and let the page stand with
   *  the exit closed until the engine starts it. */
  async #stand(note: string): Promise<void> {
    this.egress.closeExit(note);
    this.#cancelRun();
    const run = this.#run;
    this.#clearRetry();
    this.#health.stop();
    this.#stopIpTimer();
    await this.#runDone;
    // A newer start that began meanwhile has the browser: nothing of it is
    // touched here (it stops whatever Chrome it finds itself).
    if (run !== this.#run) return;
    this.#controlExpected = false;
    await this.#withChrome(async () => {
      if (run === this.#run) await this.chrome.kill();
    }).catch((error: unknown) => this.#log("chrome.kill_failed", { error: errorMessage(error) }));
    if (run !== this.#run) return;
    this.control.reset();
    this.page.stand(note);
  }

  /** A failure: the exit closes, Chrome is killed (nothing of it is trusted
   *  any more; a self-test probe still queued dies with it), and the start
   *  is tried again after the backoff. */
  async #fail(reason: StopReason, note: string): Promise<void> {
    this.egress.closeExit(note);
    if (this.page.halted || this.#stopped) return;
    this.#cancelRun();
    const run = this.#run;
    this.#clearRetry();
    this.#health.stop();
    this.#stopIpTimer();
    const wasControlled = this.#controlExpected;
    this.#controlExpected = false;
    let why = reason;
    if (why === "cdp_lost" && wasControlled && !(await this.chrome.isUp().catch(() => true))) why = "chrome_crashed";
    if (run !== this.#run) return;
    const retryAtWall = this.page.fail(why, note);
    await this.#withChrome(() => this.chrome.kill()).catch((error: unknown) => this.#log("chrome.kill_failed", { error: errorMessage(error) }));
    if (run !== this.#run || this.#stopped) return; // a newer start took over meanwhile
    this.control.reset();
    this.#retryTimer = setTimeout(() => void this.#launch(false, `a retry after ${why}`), Math.max(0, retryAtWall - Date.now()));
  }

  /** A stop that holds until the engine's restartBrowser. `stop`: Chrome
   *  quits as on a user's quit (its profile is written); `kill`: at once. */
  async #halt(reason: StopReason, note: string, how: "stop" | "kill"): Promise<void> {
    this.egress.closeExit(note);
    this.#cancelRun();
    const run = this.#run;
    this.#clearRetry();
    this.#health.stop();
    this.#stopIpTimer();
    this.page.halt(reason, note);
    this.#controlExpected = false;
    try {
      await this.#withChrome(() => (how === "stop" ? this.#stopChrome(note) : this.chrome.kill()));
    } catch (error) {
      this.#log("chrome.stop_failed", { error: errorMessage(error) });
    }
    if (run === this.#run) this.control.reset();
  }

  /** A planned stop of Chrome: the exit closes first, then Chrome is asked
   *  to quit (Browser.close — CDP goes with it), and s6 makes sure. */
  async #stopChrome(note: string): Promise<void> {
    this.egress.closeExit(note);
    this.#controlExpected = false;
    if (this.cdp.cdpUp) {
      await this.cdp.send("Browser.close", {}, undefined, 2000).catch(() => undefined);
      await this.#waitUntil(async () => !(await this.chrome.isUp()), this.#timings.quitWaitMs);
    }
    await this.chrome.stop();
  }

  /** One operation on Chrome's process at a time: a stop that is still
   *  running never stops the Chrome a newer start brings up. */
  async #withChrome<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#chromeChain;
    let release: () => void = () => undefined;
    this.#chromeChain = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return true;
      if (Date.now() >= deadline || this.#stopped) return false;
      await sleep(25);
    }
  }

  // ── the interception ───────────────────────────────────────────────────

  /** No path admits a request in this operator yet: whatever is not a
   *  self-test probe the self-test waits for is failed. */
  #decide(request: PausedRequest): PausedDecision {
    const probe = this.probes.onPaused(request);
    if (probe === "continue") return { action: "continue" };
    if (probe === "fail") return { action: "fail", reason: "BlockedByClient", why: "a self-test probe that may not go on" };
    return { action: "fail", reason: "BlockedByClient", why: "no admission: no request is admitted by this operator yet" };
  }

  #journalRequest(request: PausedRequest, decision: PausedDecision): void {
    const { host, path } = hostAndPath(request.url);
    const probe = /^#pb-selftest-/.test(request.urlFragment);
    this.journals.request({
      method: request.method,
      host,
      path,
      resourceType: request.resourceType,
      admission: probe && decision.action === "continue" ? "self-test probe (exit closed)" : null,
      decision: decision.action === "continue" ? "continued" : "failed",
      result: decision.action === "continue" ? "released to the closed exit" : `${decision.reason}: ${decision.why}`,
    });
  }

  // ── the engine ─────────────────────────────────────────────────────────

  #onHello(hello: Hello): { bufferId: string; state: State } {
    registerSecret(hello.socks5.username);
    registerSecret(hello.socks5.password);
    const previous = this.#settings;
    const settings: EngineSettings = {
      pageId: hello.pageId,
      expectedAccountId: hello.expectedAccountId,
      pinnedExitIp: normalizeIp(hello.pinnedExitIp),
      socks: { ip: hello.socks5.ip, port: hello.socks5.port, username: hello.socks5.username, password: hello.socks5.password },
      env: hello.env,
    };
    this.#settings = settings;
    this.#applyParams(hello.params);
    this.egress.setSocks(settings.socks);
    const changed =
      previous !== null &&
      (previous.pinnedExitIp !== settings.pinnedExitIp ||
        previous.socks.ip !== settings.socks.ip ||
        previous.socks.port !== settings.socks.port ||
        previous.socks.username !== settings.socks.username ||
        previous.socks.password !== settings.socks.password);
    if (changed && !this.page.halted && (this.#starting || atLeast(this.page.step, "chrome_started"))) {
      // What was verified is not what the engine says now: the exit closes
      // and the page starts again on the new settings.
      this.egress.closeExit("the engine changed the page's SOCKS5 or pinned IP");
      queueMicrotask(() => void this.#launch(false, "the engine changed the page's SOCKS5 or pinned IP"));
    }
    this.#log("engine.settings", { pageId: settings.pageId, pinnedExitIp: settings.pinnedExitIp, socks: `${settings.socks.ip}:${settings.socks.port}`, changed });
    return { bufferId: this.#bufferId, state: this.state };
  }

  /** The engine's parameters (plan §4.14), within what keeps the page safe. */
  #applyParams(params: OperatorParams): void {
    const pingMs = clamp(params.pingMs, 10, 10_000);
    this.#params = {
      ...params,
      pingMs,
      linkLossMs: clamp(params.linkLossMs, 2 * pingMs, 60_000),
      selfTestMaxMs: clamp(params.selfTestMaxMs, 500, 10_000),
      exitIpCheckMs: clamp(params.exitIpCheckMs, 100, 3_600_000),
      restartBackoffMs: params.restartBackoffMs.filter((ms) => ms >= 10),
    };
    this.rpc.setTiming(this.#params.pingMs, this.#params.linkLossMs);
    this.page.setBackoff(this.#params.restartBackoffMs);
    this.control.networkBuffer = this.#params.chromeBodyBuffer;
    if (this.#ipTimer) this.#armIpTimer();
  }

  /** The previous owner's work is over once its queued commands had their
   *  turn — each is refused there now, the generation having moved on — and
   *  there are no admissions yet: the last send the gate saw is all there is. */
  async #quiesce(): Promise<{ lastSendMono: number | null; lastSendWall: number | null }> {
    await this.#commandChain;
    // A start under way ends here, the exit closed: the new owner starts the
    // page. A page that is up stays up — the browser outlives its owner
    // (a Hub deploy is one).
    if (this.#starting) this.#standing = this.#stand("a new owner of the page");
    await this.#standing;
    const last = this.egress.gate.lastSend;
    return { lastSendMono: last?.mono ?? null, lastSendWall: last?.wall ?? null };
  }

  /** One command at a time. The RPC checked its owner and deadline when it
   *  came; both are checked again at its turn: an owner superseded while it
   *  waited, or a deadline gone, and it is not executed. */
  async #onCommand(command: Command): Promise<CommandOutcome> {
    const previous = this.#commandChain;
    let release: () => void = () => undefined;
    this.#commandChain = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      if (command.ownerGeneration < this.rpc.generation) return { ok: false, detail: "generation_stale" };
      if (monoMs() > command.notAfterMono) return { ok: false, detail: "expired" };
      return await this.#execute(command);
    } finally {
      release();
    }
  }

  async #execute(command: Command): Promise<CommandOutcome> {
    switch (command.command.kind) {
      case "closeExit":
        this.#exitHeld = true;
        this.egress.closeExit("the engine's closeExit");
        this.#stopIpTimer();
        this.page.exitClosed("the engine's closeExit");
        this.#sendState();
        return { ok: true, detail: "the exit is closed" };
      case "openExit":
        return this.#openExitCommand();
      case "stopPage":
        this.#exitHeld = false;
        await this.#halt("owner_stop", "the engine's stopPage", "stop");
        return { ok: true, detail: "the page is stopped" };
      case "restartBrowser":
        this.#exitHeld = false;
        void this.#launch(true, "the engine's restartBrowser");
        return { ok: true, detail: "the start began" };
      case "selfTest":
        return this.#selfTestCommand();
      default:
        return { ok: false, detail: `${command.command.kind} is not supported by this operator yet` };
    }
  }

  async #openExitCommand(): Promise<CommandOutcome> {
    if (this.page.halted) return { ok: false, detail: `the page is stopped (${this.page.snapshot.stopReason ?? "?"}): restartBrowser starts it` };
    this.#exitHeld = false;
    if (this.#starting) return { ok: true, detail: "the running start opens it" };
    if (this.page.step === "exit_open") return { ok: true, detail: "the exit is open" };
    if (this.page.step !== "exit_ip_verified") return { ok: false, detail: `the page is at ${this.page.step}: its start opens the exit` };
    // The IP is checked before the exit opens (plan §4.5).
    const run = this.#run;
    try {
      await this.#verifyExitIp();
    } catch (error) {
      if (run !== this.#run) return { ok: false, detail: "superseded" };
      const failure = error instanceof StartFailure ? error : new StartFailure("proxy_unavailable", errorMessage(error));
      if (failure.reason === "exit_ip_changed") await this.#halt(failure.reason, failure.message, "stop");
      else await this.#fail(failure.reason, failure.message);
      return { ok: false, detail: failure.message };
    }
    if (run !== this.#run || this.page.step !== "exit_ip_verified" || this.#exitHeld) return { ok: false, detail: "superseded" };
    this.#openExit();
    return { ok: true, detail: "the exit is open" };
  }

  async #selfTestCommand(): Promise<CommandOutcome> {
    if (this.#starting) return { ok: false, detail: "a start is running: it runs the self-test itself" };
    if (this.egress.exitOpen) return { ok: false, detail: "the exit is open: the self-test runs with it closed (closeExit first)" };
    if (this.page.halted || !atLeast(this.page.step, "control_attached")) return { ok: false, detail: `no browser under control (${this.page.step})` };
    const run = this.#run;
    const result = await this.#selfTestNow();
    const summary = Object.entries(result.checks)
      .map(([name, check]) => `${name}: ${check.status}`)
      .join(", ");
    if (!result.ok && run === this.#run) await this.#fail("selftest_failed", `the self-test failed: ${result.failed ?? "?"}`);
    return { ok: result.ok, detail: summary };
  }

  #alarm(kind: AlarmKind, detail: Record<string, string | number | boolean>): void {
    this.#log("alarm", { kind, ...detail });
    this.rpc.send({ type: "alarm", atWall: Date.now(), kind, detail });
  }

  #sendState(): void {
    this.rpc.send(this.state);
  }

  #beat(): void {
    const path = this.config.heartbeatPath;
    if (path === null) return;
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      try {
        closeSync(openSync(path, "a"));
      } catch (error) {
        this.#log("heartbeat.failed", { error: errorMessage(error) });
      }
    }
  }
}

/** The buffer's id (plan §4.4): a UUID made once with the volume. */
function loadBufferId(stateDir: string): string {
  const path = join(stateDir, "buffer-id");
  try {
    const id = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f-]{36}$/.test(id)) return id;
  } catch {
    // made below
  }
  const id = randomUUID();
  writeFileSync(`${path}.tmp`, `${id}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return id;
}
