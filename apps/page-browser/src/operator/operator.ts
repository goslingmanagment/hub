// The page operator (plan §3.1, §4.1, §4.9, §4.13): Chrome's only way out
// (egress/), its control over CDP through the holder (cdp/), the self-test
// (selftest/), the engine's RPC (rpc/), the journals (logs/), the buffer and
// its stream to the engine (buffer/) — and the start of plan §4.1, step by
// step:
//
//   1 exit closed → 2 environment → 3 Chrome started (by s6, on the
//   operator's command) → 4 control attached → 5 self-test with the exit
//   closed → 6 exit IP verified through the page's SOCKS5 → 7 exit open.
//
// Step 2 (env/): the page's time zone and languages from the engine's hello
// are handed to Chrome's start (env/handover.ts), its position is set in
// every page target (cdp/control.ts); once control is attached, what the
// browser shows is compared with them (env/check.ts) on every start, and a
// difference fails it (`env_mismatch`). A hello that changes them starts the
// page again: Chrome takes them only when it starts.
//
// Steps 8–10 (PR 7): with the exit open, the work tab loads the site
// (`https://fansly.com/`, step 8 once its document committed); the engine's
// identity read through the browser (`account.me`, a Hub request) naming the
// expected account under the live session confirms the session (9), and the
// page is ready (10). A session that changes goes back to step 8; a site
// that does not load fails the start (`proxy_unavailable`: the network
// between the page and Fansly) and it is tried again after the backoff.
// Until the engine has that identity read it admits nothing of the site
// (checks-only), so the site's first load may see its API requests fail —
// in the interception: none of them left. When the session is confirmed and
// any did, the work tab is loaded anew, once a start, so the site starts
// under an engine that admits; what still waited is closed first, and
// nothing admitted before the reload is released into it.
//
// Hub's requests (hub-requests/, PR 9; plan §4.2): the engine's `send` runs
// in the site's tab under the engine's admission (`check`), the gate's
// window holding its deadline; its outcome is kept in the buffer and sent
// once durable, the body first. They need the site in the work tab and its
// live session (plan §4.7): until then every `send` is answered, not sent
// ("the site is not loaded").
//
// The site's own requests (intercept/, PR 7; plan §4.3): the map of
// operations decides each (policy/operations.ts) — the page, static files
// and other hosts on at once and journaled; the API by the engine's
// admission (`siteAdmit`), waiting at most 60 s; what the map closes failed
// and journaled. Their answers with platform data go to the buffer whole or
// as a mark (`site.response`), their ends to the engine (`siteDone`).
//
// The site's socket (ws/, PR 10; plan §4.3, §4.4; mandatory condition №3):
// the guard (inpage/ws-guard.js) goes into every tab, frame and worker
// before the site's code, and lets no message but spec §2.6's leave — the
// first other one stops the page; the proxy's socket gate holds the same
// allow-list outside the page's JavaScript, record by record; each socket's
// CONNECT waits at the proxy for the engine's `wsAdmit`, and its handshake
// goes only before the admission's deadline; its frames go from CDP into
// the buffer — acknowledged to the holder once durable — its handshake's
// outcome to the engine as `wsDone`, and gaps mark where frames may be
// missing. After a restart, what the holder delivers again of the previous
// Chrome's sockets is dropped, and the connections the buffer kept from
// before are ended there.
//
// The manual login (login/, PR 15; plan §4.8; spec §7): the engine's
// `setMode` of the current owner generation switches it on — the map lets
// the login operations through beside the interface's reads, Hub's
// requests and the site's socket stay out, the page is never ready — and
// off again, with the checks before the page resumes: the exit IP now, the
// session and the account by an identity read of the engine's under the
// live session sent after the mode changed (what was confirmed before a
// person could be in the page confirms nothing). The API's calls of the
// login form (`login.*`, their own token) are taken only while the mode is
// that owner's: the screen, its screenshot, the owner's input typed in as a
// person types it. What was typed lives in the call for the time of the
// hand-over: never in a log line, a journal, the buffer or an error.
//
// What holds, whatever happens:
// - No API request leaves without the engine's admission. A Hub request goes
//   only by its `check` and through the gate's window; a socket only by its
//   `wsAdmit`, through a tunnel of its own; a site request only by its
//   `siteAdmit` and through the gate's window — the session is learned from
//   the site's requests as they stop. Nothing the map closes leaves, and no
//   other request to the socket host (no socket may ride it). Nothing of the
//   site goes before the exit opens.
// - A page starts only on the engine's restartBrowser; a failure stops it
//   and retries after 10 s, 30 s, 2 min, then every 5 min; a halt (the
//   engine's stopPage, a changed exit IP) holds until the next
//   restartBrowser. An operator that starts again stands until the engine
//   starts the page (stage 1, amendment 17).
// - A planned stop closes the exit before CDP goes (plan §4.1). A lost
//   control — CDP, the holder, its overflow, a browser that stops answering —
//   closes the exit at once, kills Chrome and retries.
// - Nothing passes that could not be kept (spec §5): a start waits for the
//   journals and the buffer to be written and to have room; a buffer that
//   fills up (its caps, the disk) closes the exit and fails the page with
//   `buffer_full` or `disk_full`, and the page starts again once there is
//   room. No admission while the buffer refuses writes (plan §4.3).
// - A buffer that cannot be opened (locked, a failing disk, a corrupt or too
//   new file) does not take the operator down: the RPC, the heartbeat and
//   the proxy (refusing) run, the page stands with `buffer_unavailable`,
//   the engine is alarmed, no start passes the gate, and the buffer is
//   opened again when that may help — its file is never touched.

import { closeSync, mkdirSync, openSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { EventBuffer, type BufferAlarm, type BufferOptions, type BufferUnavailable, type FullReason } from "../buffer/buffer.ts";
import { OutcomeReplay } from "../buffer/replay.ts";
import { EventStream } from "../buffer/stream.ts";
import { Cdp, type HolderLink } from "../cdp/client.ts";
import { BrowserControl, SITE_ORIGIN } from "../cdp/control.ts";
import { PausedRequests, type PausedDecision, type PausedRequest } from "../cdp/paused.ts";
import { HubRequests, type HubTimings } from "../hub-requests/hub.ts";
import { LoginDesk, type LoginGuard, type LoginOutcome, type LoginTimings } from "../login/desk.ts";
import { SiteRequests, type SiteTimings } from "../intercept/site.ts";
import { guardExpression, newBindingName } from "../ws/guard.ts";
import { GuardInstaller } from "../ws/install.ts";
import { BoundaryFile } from "../ws/boundary.ts";
import { SiteSockets, type SocketStop, type SocketTimings } from "../ws/sockets.ts";
import { PLACEHOLDER_SUFFIX, WORLD } from "../hub-requests/page.ts";
import { EnvCheck } from "../env/check.ts";
import { writeHandover } from "../env/handover.ts";
import { describeEnv, sameEnv } from "../env/rules.ts";
import { checkExitIp, IPIFY, normalizeIp, type ExitIpTarget } from "../egress/exit-ip.ts";
import { ExtensionFiles } from "../egress/extension-files.ts";
import { classifyFanslyHost, FANSLY_HOSTS, type HostClassifier } from "../egress/hosts.ts";
import { Egress } from "../egress/proxy.ts";
import { SocksError, type SocksConfig } from "../egress/socks5.ts";
import { hostAndPath, Journals } from "../logs/journal.ts";
import { GenerationStore } from "../rpc/generation.ts";
import type { CommandOutcome } from "../rpc/ledger.ts";
import { DEFAULT_PARAMS, type AlarmKind, type BufferMessage, type Command, type Hello, type LoginRequest, type Mode, type OperatorParams, type SelfTestMechanism, type State } from "../rpc/protocol.ts";
import { RpcServer } from "../rpc/server.ts";
import { EXTENSION_CHECKS, runSelfTest, type ExtensionChecks, type SelfTestResult } from "../selftest/selftest.ts";
import { ProbeDriver } from "../selftest/probes.ts";
import { PageState } from "../state/page-state.ts";
import { atLeast, type StopReason } from "../state/steps.ts";
import type { OperatorMode } from "../policy/operations.ts";
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
  /** The environment's check in the browser (env/check.ts). */
  envCheckMs: number;
  heartbeatMs: number;
  /** A `state` at least this often (the engine alarms after 2 min without). */
  stateEveryMs: number;
  healthEveryMs: number;
  healthAnswerMs: number;
  selfTestProbeMs: number;
  exitIpTimeoutMs: number;
  /** A planned stop waits this long for Chrome to quit by itself. */
  quitWaitMs: number;
  /** The site's document in the work tab (plan §4.1, step 8). */
  siteLoadMs: number;
  /** Before the work tab is loaded anew, how long a request of the site
   *  that is in flight is waited out. */
  reloadWaitMs: number;
}

const DEFAULT_TIMINGS: OperatorTimings = {
  holderRelinkMs: 100,
  replayWaitMs: 10_000,
  chromeUpMs: 30_000,
  attachMs: 10_000,
  envCheckMs: 10_000,
  heartbeatMs: 1000,
  stateEveryMs: 5000,
  healthEveryMs: 2000,
  healthAnswerMs: 5000,
  selfTestProbeMs: 4000,
  exitIpTimeoutMs: 15_000,
  quitWaitMs: 5000,
  siteLoadMs: 30_000,
  reloadWaitMs: 30_000,
};

/** The site the work tab loads (plan §4.1, step 8). */
export const SITE_URL = `${SITE_ORIGIN}/`;
/** An identity answer is read for its account id up to this size. */
const IDENTITY_BODY_MAX = 1024 * 1024;

export interface OperatorDeps {
  config: OperatorConfig;
  chrome: ChromeControl;
  classify?: HostClassifier;
  /** The host of the self-test's probes: the API host. */
  apiHost?: string;
  exitIpTarget?: ExitIpTarget;
  extension?: ExtensionChecks;
  timings?: Partial<OperatorTimings>;
  /** Tests: the buffer's disk, its room, how often it looks, its retries. */
  buffer?: Pick<BufferOptions, "diskFree" | "minFreeBytes" | "checkEveryMs" | "resumePercent" | "maxPages" | "openRetryMs" | "retryMs">;
  /** Tests: the Hub requests' waits and limits. */
  hubTimings?: Partial<HubTimings>;
  /** Tests: the socket's waits. */
  socketTimings?: Partial<SocketTimings>;
  /** Tests: the site requests' waits and limits. */
  siteTimings?: Partial<SiteTimings>;
  /** Tests: the login desk's waits. */
  loginTimings?: Partial<LoginTimings>;
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
  /** The rules extension's package on the proxy's port (plan §4.6). */
  readonly extension: ExtensionFiles;
  readonly rpc: RpcServer;
  readonly cdp: Cdp;
  readonly control: BrowserControl;
  readonly probes: ProbeDriver;
  readonly envCheck: EnvCheck;
  readonly page: PageState;
  readonly journals: Journals;
  /** What the page captured, until the engine has it (plan §4.4): the
   *  producers of PRs 7, 9 and 10 write here. */
  readonly buffer: EventBuffer;
  readonly stream: EventStream;
  readonly replay: OutcomeReplay;
  readonly paused: PausedRequests;
  /** Hub's requests through the site's tab (plan §4.2). */
  readonly hub: HubRequests;
  /** The socket guard in every context of the page (plan §4.3). */
  readonly guard: GuardInstaller;
  /** The site's socket: admissions, frames, outcomes (plan §4.4). */
  readonly sockets: SiteSockets;
  /** The site's own requests: the map, the engine's admission, the
   *  answers (plan §4.3). */
  readonly site: SiteRequests;
  /** The login form's desk (plan §4.8): the screen, its screenshot, the
   *  owner's input. */
  readonly login: LoginDesk;
  readonly #health: HealthProbe;
  readonly #timings: OperatorTimings;
  readonly #log: Logger;
  readonly #apiHost: string;
  readonly #exitIpTarget: ExitIpTarget;
  readonly #extension: ExtensionChecks;
  readonly #classify: HostClassifier;
  #params: OperatorParams = DEFAULT_PARAMS;
  /** The operator's mode (spec §6.1; plan §4.8): `manual_login` only by the
   *  engine's `setMode`, for the owner generation that set it. */
  #mode: OperatorMode = "automation";
  /** The owner generation whose `setMode` switched the manual login on: the
   *  login form's calls are taken only while it is the current one. */
  #modeGeneration: number | null = null;
  /** The work tab is loaded anew for a change of the mode (it waits out
   *  what is in flight first). */
  #modeReload = 0;
  /** Changes whenever what a login call was taken under may have: a change
   *  of the mode, a hand-over, the engine's link lost or found. A step of
   *  the login form taken before stops at its next input step (Astra's
   *  review of PR 15, item 3). */
  #loginEpoch = 0;
  /** The account the engine's identity read named, and under which
   *  session (plan §4.1, step 9). */
  #identity: { accountId: string; fingerprint: string } | null = null;
  /** An identity read sent before this instant (CLOCK_MONOTONIC ms) names
   *  nothing: what it confirmed was before the last change of the mode — a
   *  person may have been in the page since (Astra's review of PR 15,
   *  item 6). */
  #identityFloorMono = Number.NEGATIVE_INFINITY;
  /** The work tab was loaded anew at a confirmation of this start: once. */
  #siteReloaded = false;
  /** That reload is under way (it waits out what is in flight first). */
  #reloadPending = false;
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
  /** The linked holder's Chrome connection closed: that holder exits (s6
   *  starts a fresh one), and its link closes soon. */
  #holderSpent = false;
  /** The site socket's part of this operator's start was done (after the
   *  holder's first replay). */
  #socketsRestarted = false;
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
    this.#classify = deps.classify ?? classifyFanslyHost;
    registerSecret(this.config.rpcToken);
    mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 });

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

    // The rules extension's package, for Chrome's policy (PR 6).
    this.extension = new ExtensionFiles(this.config.extensionDir, this.#log);
    this.egress = new Egress({
      classify: this.#classify,
      serve: (req, res) => this.extension.serve(req, res),
      admitSocket: (host, port) => this.sockets.admit(host, port),
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
        if (!atLeast(this.page.step, "exit_open")) return;
        void this.#fail(kind === "auth" ? "proxy_auth" : "proxy_unavailable", `the page's SOCKS5 failed a tunnel: ${message}`);
      },
    });

    this.cdp = new Cdp({ socketPath: this.config.holderSock });
    this.guard = new GuardInstaller({
      cdp: this.cdp,
      ...((binding) => ({ binding, expression: guardExpression(binding) }))(newBindingName()),
      onReport: (report, target) => this.sockets.onGuardReport(report, target),
      onFailed: (target, why) => this.#socketStop("ws_guard_failed", `${why} (${target.type})`, "kill"),
    });
    this.control = new BrowserControl(this.cdp, {
      networkBuffer: DEFAULT_PARAMS.chromeBodyBuffer,
      onSetupFailed: (target, error) => {
        if (!this.#controlExpected) return;
        void this.#fail("cdp_lost", `a ${target.type} could not be set up: ${error.message}`);
      },
      targetSetup: (target, kind, waiting) => this.guard.setUp(target, kind, waiting),
    });
    this.probes = new ProbeDriver(this.cdp, this.control, { apiHost: this.#apiHost, exitClosed: () => !this.egress.exitOpen });
    this.envCheck = new EnvCheck(this.cdp, this.control);
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
          this.#holderSpent = true;
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
      apiToken: this.config.apiToken ?? null,
      generations: new GenerationStore(join(this.config.stateDir, "owner-generation")),
      pingMs: DEFAULT_PARAMS.pingMs,
      linkLossMs: DEFAULT_PARAMS.linkLossMs,
      handlers: {
        onHello: (hello) => this.#onHello(hello),
        quiesce: () => this.#quiesce(),
        onCommand: (command) => this.#onCommand(command),
        onBuffer: (message) => this.#onBuffer(message),
        onHub: (message) => {
          if (message.type === "send") this.hub.onSend(message);
          else this.hub.onCheckResult(message);
        },
        onSocket: (message) => this.sockets.onAdmitResult(message),
        onSite: (message) => this.site.onAdmitResult(message),
        onLogin: (request) => this.#onLogin(request),
        onLink: (up, reason) => {
          // What the login form was typing for the engine of before stops.
          this.#cancelLogin(up ? "a new engine connection" : "the engine's link was lost");
          // A new connection subscribes anew; the outcomes not acknowledged
          // go to it again (spec §6.2), a page at a time.
          this.stream.reset();
          // An admission is answered only on the connection it was asked on.
          this.sockets.linkChanged();
          // The site's requests still waiting are asked on the new one — or
          // wait for one (plan §4.9).
          this.site.linkChanged(up);
          this.#log(up ? "engine.linked" : "engine.lost", { reason, admissionsOpen: this.admissionsOpen() });
          if (!up) {
            this.replay.disconnected();
            // No check is answered any more: what waits for one fails.
            this.hub.linkLost();
            return;
          }
          this.#sendState();
          this.replay.connected();
          // A buffer that filled up, or could not be opened, before this
          // engine came: it is told.
          const full = this.buffer.fullness;
          if (full) this.#alarm("buffer", { ...alarmDetail(full.alarm), full: true, reason: full.reason, detail: full.detail });
          const unavailable = this.buffer.unavailable;
          if (unavailable) this.#alarm("buffer", unavailableDetail(unavailable));
        },
      },
    });

    // Last: its handlers use everything above.
    this.buffer = new EventBuffer({
      dir: this.config.bufferDir,
      idFile: join(this.config.stateDir, "buffer-id"),
      operatorVersion: this.config.operatorVersion,
      batchMs: DEFAULT_PARAMS.bufferBatchMs,
      caps: DEFAULT_PARAMS.bufferCap,
      ...deps.buffer,
      onAlarm: (alarm) => this.#alarm("buffer", alarmDetail(alarm)),
      onFull: (reason, alarm, detail) => {
        // Spec §5, steps 1–2: writes are refused already; the exit closes
        // and the page stops — it starts again once there is room.
        this.egress.closeExit(`the buffer takes no writes: ${detail}`);
        this.#alarm("buffer", { ...alarmDetail(alarm), full: true, reason, detail });
        if (this.#controlExpected || this.#starting) void this.#fail(reason, `the buffer takes no writes: ${detail}`);
        this.#sendState();
      },
      onRoom: (reason) => this.#onBufferRoom(reason),
      onUnavailable: (unavailable) => this.#onBufferUnavailable(unavailable),
      onOpened: () => this.#onBufferOpened(),
      onCommitted: ({ events, outcomes }) => {
        if (events > 0) this.stream.pump();
        // As attempts end: one more delivery round, each outcome after its
        // body, read from the file (replay.ts).
        if (outcomes.length > 0) this.replay.live(outcomes);
      },
    });
    this.stream = new EventStream(this.buffer, (json) => this.rpc.sendRaw(json), {
      maxEvents: DEFAULT_PARAMS.eventBatch.maxEvents,
      maxBytes: DEFAULT_PARAMS.eventBatch.maxBytes,
      // The bodies of the site's answers go before the batch that names them.
      link: {
        epoch: () => this.rpc.epoch,
        sendBinary: (frame) => this.rpc.sendBinary(frame),
        backlog: () => this.rpc.backlog(),
        drained: () => this.rpc.drained(),
      },
    });
    this.replay = new OutcomeReplay(
      this.buffer,
      {
        epoch: () => this.rpc.epoch,
        send: (json) => this.rpc.sendRaw(json),
        sendBinary: (frame) => this.rpc.sendBinary(frame),
        backlog: () => this.rpc.backlog(),
        drained: () => this.rpc.drained(),
      },
      { stateOf: (attemptId) => this.sockets.recoverState(attemptId) ?? this.site.recoverState(attemptId) ?? this.hub.recoverState(attemptId) },
    );

    this.hub = new HubRequests({
      cdp: this.cdp,
      resolve: (request, decision) => this.paused.resolve(request, decision),
      gate: this.egress.gate,
      cut: (cls, reason) => this.egress.cutClass(cls, reason),
      classify: this.#classify,
      exitOpen: () => this.egress.exitOpen,
      buffer: this.buffer,
      site: {
        notReady: () => this.#siteNotReady(),
        tabSession: () => this.control.workTab?.sessionId ?? null,
        world: () => {
          const tab = this.control.workTab;
          return tab ? this.control.isolatedWorld(tab, WORLD) : Promise.reject(new Error("no work tab"));
        },
      },
      link: {
        up: () => this.rpc.linkUp,
        generation: () => this.rpc.generation,
        send: (message) => this.rpc.send(message),
      },
      fault: (reason, note) => this.#requestFault(reason, note),
      alarm: (kind, detail) => this.#alarm(kind, detail),
      sessionChanged: (fingerprint) => this.#onSessionChanged(fingerprint),
      identityAnswer: (answer) => this.#onIdentity(answer),
      ...(deps.hubTimings ? { timings: deps.hubTimings } : {}),
    });
    this.site = new SiteRequests({
      cdp: this.cdp,
      resolve: (request, decision) => this.paused.resolve(request, decision),
      gate: this.egress.gate,
      cutApi: (reason) => this.egress.cutClass("api", reason),
      buffer: this.buffer,
      link: {
        up: () => this.rpc.linkUp,
        epoch: () => this.rpc.epoch,
        generation: () => this.rpc.generation,
        send: (message) => this.rpc.send(message),
      },
      notUp: () => this.#siteNotUp(),
      session: { fingerprint: () => this.hub.session.fingerprint, note: (request) => this.hub.noteSiteRequest(request) },
      mode: () => this.#mode,
      fault: (reason, note) => this.#requestFault(reason, note),
      journal: (line) => this.journals.request(line),
      loginEnded: (end) => this.login.loginEnded(end),
      readEnded: (end) => this.login.readEnded(end),
      ...(deps.siteTimings ? { timings: deps.siteTimings } : {}),
    });
    this.login = new LoginDesk({
      cdp: this.cdp,
      tab: () => this.control.workTab?.sessionId ?? null,
      world: () => {
        const tab = this.control.workTab;
        return tab ? this.control.isolatedWorld(tab, WORLD) : Promise.reject(new Error("no work tab"));
      },
      session: () => this.hub.session.fingerprint,
      discard: (why) => this.#discardDocument(why),
      ...(deps.loginTimings ? { timings: deps.loginTimings } : {}),
    });
    this.sockets = new SiteSockets({
      cdp: this.cdp,
      buffer: this.buffer,
      link: { send: (message) => this.rpc.send(message) },
      // The site's socket is not of the manual login (spec §2.4).
      notAdmitting: () => (this.#mode === "manual_login" ? "the manual login: no socket of the site" : this.admissionsOpen() ? null : this.#noAdmissionWhy()),
      sessionFingerprint: () => this.hub.session.fingerprint,
      authorizationBytes: () => this.hub.session.socketAuthorizationBytes(),
      targetType: (sessionId) => this.control.targets.find((target) => target.sessionId === sessionId)?.type ?? null,
      socketHost: (host) => this.#classify(host) === "ws",
      cutTunnel: (connectionId, reason) => this.egress.cutSocket(connectionId, reason),
      journal: (line) => this.journals.socket(line),
      alarm: (kind, detail) => this.#alarm(kind, detail),
      stop: (reason, note, how) => this.#socketStop(reason, note, how),
      startBoundary: new BoundaryFile(join(this.config.stateDir, "start-boundary.json")),
      ...(deps.socketTimings ? { timings: deps.socketTimings } : {}),
    });
    this.egress.gate.onEvent = (event) => {
      // The send as the gate saw it is the Hub request's or the site
      // request's; what it held or cut goes to the log.
      this.hub.onGateEvent(event);
      this.site.onGateEvent(event);
      if (event.kind !== "first_bytes" && event.kind !== "announced") this.#log("gate", { kind: event.kind, window: event.window, ...event.detail });
    };
  }

  /** Listen (the exit closed), link to the holder, and stand until the
   *  engine starts the page. Returns the proxy's and the RPC's ports. */
  async start(): Promise<{ proxyPort: number; rpcPort: number }> {
    this.#beat();
    this.#heartbeatTimer = setInterval(() => this.#beat(), this.#timings.heartbeatMs);
    const proxyPort = await this.egress.listen(this.config.proxyPort, this.config.proxyHost);
    const rpcPort = await this.rpc.listen(this.config.rpcPort, this.config.rpcHost);
    this.#stateTimer = setInterval(() => this.#sendState(), this.#timings.stateEveryMs);
    this.buffer.start();
    void this.#linkHolder(true);
    this.#log("started", { proxyPort, rpcPort, bufferId: this.buffer.id, version: this.config.operatorVersion });
    return { proxyPort, rpcPort };
  }

  /** SIGTERM: the exit closes; Chrome and CDP stay with the holder. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.egress.closeExit("the operator stops");
    this.#endWork("the operator stops");
    this.#cancelRun();
    this.#clearRetry();
    this.#health.stop();
    this.#stopIpTimer();
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#stateTimer) clearInterval(this.#stateTimer);
    this.sockets.close();
    this.site.close();
    this.cdp.close();
    await this.rpc.close();
    await this.egress.close();
    await this.buffer.close();
    await this.journals.close();
  }

  /** May a request get an admission now (PR 7, PR 9, PR 10)? Only with the
   *  engine heard within 5 s (plan §4.13), the exit open — the page at step
   *  7 or past it: the site loaded, the session confirmed, ready (plan
   *  §4.1) — and the buffer taking writes (plan §4.3). */
  admissionsOpen(): boolean {
    return this.rpc.linkUp && this.#siteNotUp() === null && this.buffer.refusal() === null;
  }

  /** Why `admissionsOpen` says no. */
  #noAdmissionWhy(): string {
    if (!this.rpc.linkUp) return "no engine link";
    return this.#siteNotUp() ?? `the buffer takes no writes (${this.buffer.refusal() ?? "?"})`;
  }

  /** Why the page takes none of the site's requests now (the exit closed,
   *  the page not up or halted), or null. */
  #siteNotUp(): string | null {
    if (!this.egress.exitOpen) return "the exit is closed";
    if (this.page.halted || !atLeast(this.page.step, "exit_open")) return `the page is not up (${this.page.halted ? "halted" : this.page.step})`;
    return null;
  }

  /** What runs in the page ends: Hub's requests, the site's, the socket's
   *  admissions and connections (the exit is closed already). */
  #endWork(note: string): void {
    // The session goes with the browser, and what was confirmed of it.
    this.#identity = null;
    this.hub.endAll(note);
    this.site.endAll(note);
    this.sockets.endAll(note);
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
      mode: this.#mode,
      sessionFingerprint: this.hub.session.fingerprint,
      accountId: this.#identity !== null && this.#identity.fingerprint === this.hub.session.fingerprint ? this.#identity.accountId : null,
      exitIp: this.#exitIp,
      chromeVersion: this.#chromeVersion,
      operatorVersion: this.config.operatorVersion,
      buffer: this.#bufferState(),
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
          this.#holderSpent = false;
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
        if (!this.#socketsRestarted) {
          // What the holder kept of the site's socket from before is behind
          // (dropped); the gap of this start and the end of the connections
          // the buffer kept from before go in one commit, tried until
          // durable (plan §4.4, step 6).
          this.#socketsRestarted = true;
          await this.sockets.afterRestart();
          // The site requests the previous operator admitted end too.
          this.site.afterRestart();
        }
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
    this.#endWork(`control lost: ${detail}`);
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
    this.#endWork("a new start of the page");
    this.#siteReloaded = false;
    this.#health.stop();
    this.#stopIpTimer();
    this.page.beginStart(note, fresh);
    try {
      // Nothing may pass unrecorded: the journals must be writing, and the
      // buffer must be written and have room (spec §5).
      if (!(await this.journals.flushed())) throw new StartFailure("disk_full", "the journals cannot be written");
      check();
      const room = await this.buffer.ready();
      if (!room.ok) throw new StartFailure(room.reason, `the buffer takes no writes: ${room.detail}`);
      check();
      // A Chrome that runs now is a previous start's or nobody's: the page
      // starts with a fresh one.
      await this.#withChrome(async () => {
        if (await this.chrome.isUp()) await this.#stopChrome("a start begins with a fresh Chrome");
      });
      check();
      if (!(await this.#waitUntil(() => !this.cdp.cdpUp, 3000))) throw new StartFailure("cdp_lost", "the holder still holds the previous Chrome");
      check();
      // The holder of the previous Chrome exits after it (s6 starts a fresh
      // one): the start goes on with the fresh holder, so the old link's
      // close is not taken for a lost control of the new Chrome — which
      // made every restart of a running page fail once.
      if (!(await this.#waitUntil(() => !this.#holderSpent && this.cdp.linked, 3000))) throw new StartFailure("cdp_lost", "the holder of the previous Chrome did not go");
      check();
      // Step 2: the page's environment for this Chrome (it takes it when it
      // starts), from the engine's last hello.
      const env = this.#settings?.env;
      if (!env) throw new StartFailure("env_mismatch", "no environment of the page from the engine yet");
      try {
        writeHandover(this.config.chromeEnvPath, env);
      } catch (error) {
        throw new StartFailure("env_mismatch", `the page's environment could not be handed to Chrome: ${errorMessage(error)}`);
      }
      this.control.geolocation = env.geolocation;
      this.page.advance("env_applied", describeEnv(env));
      await this.#withChrome(async () => {
        check();
        this.control.reset();
        this.guard.reset();
        // A connection of the previous Chrome is gone (plan §4.4, step 6),
        // and so is its holder.
        await this.sockets.chromeStarting();
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
      // What the browser shows is the page's environment (plan §4.1, step
      // 2), after every start: a restarted or updated Chrome included.
      const shown = await this.envCheck.run(env, this.#timings.envCheckMs);
      check();
      this.#log(shown.ok ? "env.verified" : "env.mismatch", { durationMs: shown.durationMs, seen: shown.seen, mismatches: shown.mismatches });
      if (!shown.ok) throw new StartFailure("env_mismatch", `the browser does not show the page's environment: ${shown.mismatches.join("; ")}`);
      this.page.advance("control_attached", `${this.#chromeVersion}; environment verified: ${describeEnv(env)}`);
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
    void this.#loadSite(this.#run);
  }

  // ── the site (plan §4.1, steps 8–10) ──────────────────────────────────

  /** Step 8: the work tab loads the site. Its document goes as any page of
   *  the site does (intercept/site.ts); its API requests by the engine's
   *  admission. A site that does not load fails the start. */
  async #loadSite(run: number): Promise<void> {
    const stale = () => run !== this.#run || this.#stopped || this.page.halted || this.page.step !== "exit_open" || !this.egress.exitOpen;
    try {
      const tab = this.control.workTab;
      if (tab === null) throw new StartFailure("cdp_lost", "no work tab to load the site in");
      // What fails of the site from here to the session's confirmation
      // decides whether the tab is loaded anew then.
      this.site.resetFailures();
      const documents = () => this.site.documents.commits(this.control.workTab?.mainFrameId ?? null);
      const before = documents();
      const reply = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url: SITE_URL }, tab.sessionId, this.#timings.siteLoadMs);
      if (stale()) return;
      if (typeof reply.errorText === "string" && reply.errorText !== "") throw new StartFailure("proxy_unavailable", `the site did not load: ${reply.errorText}`);
      // Its document, not the one the tab had: a new one committed.
      const atSite = await this.#waitUntil(() => stale() || (this.#workTabAtSite() && documents() > before), this.#timings.siteLoadMs);
      if (stale()) return;
      if (!atSite) throw new StartFailure("proxy_unavailable", `the site's document did not come within ${this.#timings.siteLoadMs} ms`);
      this.page.advance("site_loaded", SITE_URL);
      this.#confirmSession();
    } catch (error) {
      if (stale()) return;
      const failure = error instanceof StartFailure ? error : new StartFailure("proxy_unavailable", `the site did not load: ${errorMessage(error)}`);
      await this.#fail(failure.reason, failure.message);
    }
  }

  #workTabAtSite(): boolean {
    const url = this.control.workTab?.url ?? "";
    try {
      return new URL(url).origin === SITE_ORIGIN;
    } catch {
      return false;
    }
  }

  /** Steps 9–10: the session is confirmed once the engine's identity read
   *  under the live session named the expected account; the page is ready
   *  then. */
  #confirmSession(): void {
    // In the manual login the page is never ready: a person is in it (plan
    // §4.8), and its session is confirmed once the automation is back.
    if (this.#mode === "manual_login") return;
    const identity = this.#identity;
    const live = this.hub.session.fingerprint;
    if (this.page.step !== "site_loaded" || identity === null || live === null || identity.fingerprint !== live) return;
    if (identity.accountId !== this.#settings?.expectedAccountId) return;
    if (this.#reloadPending) return;
    const failed = this.site.failures;
    if (failed > 0 && !this.#siteReloaded) {
      // The site's document saw its API requests fail before the engine
      // admitted any: it starts again under the confirmed session.
      this.#reloadPending = true;
      void this.#reloadSite(this.#run, failed);
      return;
    }
    this.page.advance("session_confirmed", "the engine's identity read named the expected account");
    this.page.advance("ready");
  }

  /** The work tab loaded anew at the session's confirmation, once a start:
   *  what of the site is in flight is waited out (a request cancelled by
   *  the reload would stop the page), what still waits is closed, then the
   *  tab navigates as at step 8 — and is confirmed and ready with its new
   *  document. */
  async #reloadSite(run: number, failed: number): Promise<void> {
    const stale = () => run !== this.#run || this.#stopped || this.page.halted || this.page.step !== "site_loaded" || !this.egress.exitOpen;
    try {
      const idle = await this.#waitUntil(() => stale() || this.site.released === 0, this.#timings.reloadWaitMs);
      if (stale()) return;
      if (!idle) {
        // Never while a request of the site is in flight: confirmed as it is.
        this.#log("site.reload_skipped", { failed, released: this.site.released });
        this.page.advance("session_confirmed", "the engine's identity read named the expected account; not loaded anew: a request of the site stayed in flight");
        this.page.advance("ready");
        return;
      }
      this.#siteReloaded = true;
      this.site.reloading(this.control.workTab?.mainFrameId ?? null);
      this.#log("site.reload", { failed });
      this.page.back("exit_open", `the session is confirmed; ${failed} API request${failed === 1 ? "" : "s"} of the site failed before it, none sent: the work tab is loaded anew, once`);
      // From here it is a load like step 8's: confirmed again when it is in.
      this.#reloadPending = false;
      await this.#loadSite(run);
    } finally {
      this.#reloadPending = false;
    }
  }

  /** A whole answer of the engine's identity read (hub-requests/): its
   *  account id, read from the body and nothing else of it kept. A read sent
   *  before the last change of the mode (or whose send is not known since
   *  then) names nothing: it is from before the person's login. */
  #onIdentity(answer: { fingerprint: string; status: number; bodyId: string; bytes: number; sentMono: number | null }): void {
    try {
      if (this.#mode === "manual_login") return;
      if (this.#identityFloorMono > Number.NEGATIVE_INFINITY && (answer.sentMono === null || answer.sentMono < this.#identityFloorMono)) {
        this.#log("session.identity_stale", { why: "sent before the mode last changed" });
        return;
      }
      if (answer.status !== 200 || answer.bytes > IDENTITY_BODY_MAX) return;
      const body = this.buffer.readBody(answer.bodyId, 0, Math.max(1, answer.bytes));
      if (body === null) return;
      const id = (JSON.parse(body.toString("utf8")) as { response?: { account?: { id?: unknown } } }).response?.account?.id;
      if (typeof id !== "string" || id === "") return;
      this.#identity = { accountId: id, fingerprint: answer.fingerprint };
      const expected = this.#settings?.expectedAccountId ?? null;
      this.#log(id === expected ? "session.confirmed" : "session.other_account", { matches: id === expected });
      this.#confirmSession();
      this.#sendState();
    } catch (error) {
      this.#log("session.identity_unread", { error: errorMessage(error) });
    }
  }

  /** The live session changed (a login, a new session, a new browser): a
   *  confirmation of another one no longer stands. */
  #onSessionChanged(fingerprint: string | null): void {
    if (this.#identity !== null && this.#identity.fingerprint !== fingerprint && atLeast(this.page.step, "session_confirmed")) {
      this.page.back("site_loaded", "the site's live session changed: it is confirmed again");
    }
    this.#sendState();
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
    if (this.#ipChecking || !atLeast(this.page.step, "exit_open")) return;
    this.#ipChecking = true;
    const run = this.#run;
    try {
      await this.#verifyExitIp();
    } catch (error) {
      if (run !== this.#run || !atLeast(this.page.step, "exit_open")) return;
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
    this.#endWork(note);
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
    this.#endWork(note);
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
    this.#endWork(note);
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

  /** The environment check's own page is answered here (never sent); a
   *  self-test probe and Hub's requests go by their paths (selftest/,
   *  hub-requests/); every other request is the site's, and the map of
   *  operations decides it (intercept/site.ts) — the live session is
   *  learned from those to the API. The socket host serves sockets only:
   *  any other request there could open a connection a later socket would
   *  ride without its own tunnel and admission (stage 1, §3.2) — CDP never
   *  shows a socket's handshake here. A response stage only a Hub request or
   *  an admitted site request asked for. */
  #decide(request: PausedRequest): PausedDecision {
    if (request.stage === "response") return this.hub.decide(request) ?? this.site.decide(request) ?? { action: "fail", reason: "BlockedByClient", why: "a response stage nobody asked for" };
    const envPage = this.envCheck.onPaused(request);
    if (envPage) return envPage;
    const probe = this.probes.onPaused(request);
    if (probe === "continue") return { action: "continue" };
    if (probe === "fail") return { action: "fail", reason: "BlockedByClient", why: "a self-test probe that may not go on" };
    const hub = this.hub.decide(request);
    if (hub) return hub;
    return this.site.decide(request) ?? { action: "fail", reason: "BlockedByClient", why: "no path decided it" };
  }

  /** One line per resolution: the host (a Hub request's real one) and path,
   *  never the query, the fragment or a header. */
  #journalRequest(request: PausedRequest, decision: PausedDecision): void {
    const { host: seen, path } = hostAndPath(request.url);
    const host = seen.endsWith(PLACEHOLDER_SUFFIX) ? seen.slice(0, -PLACEHOLDER_SUFFIX.length) : seen;
    const probe = /^#pb-selftest-/.test(request.urlFragment);
    const admitted = this.hub.describe(request) ?? this.site.describe(request);
    const line = { method: request.method, host, path, resourceType: request.resourceType };
    switch (decision.action) {
      case "continue":
        this.journals.request({
          ...line,
          admission: admitted ?? (probe ? "self-test probe (exit closed)" : null),
          decision: "continued",
          result: admitted ? "released under its admission" : probe ? "released to the closed exit" : "passed unpaced",
        });
        return;
      case "fail":
        this.journals.request({ ...line, admission: admitted, decision: "failed", result: `${decision.reason}: ${decision.why}` });
        return;
      case "fulfill":
        this.journals.request({ ...line, admission: admitted ?? (this.envCheck.isCheckPage(request) ? "environment check (answered here, not sent)" : null), decision: "fulfilled", result: `${decision.status}: ${decision.why}` });
        return;
      case "continueResponse":
        this.journals.request({ ...line, admission: admitted, decision: "continued", result: "the answer went on to the page" });
        return;
      case "hold":
        return;
    }
  }

  /** Why a Hub request may not start now, or null: the page is up, and the
   *  site is in the work tab (plan §4.1, step 8 — a later PR loads it). */
  #siteNotReady(): string | null {
    if (this.#mode === "manual_login") return "the manual login: no Hub request while a person is in the page";
    if (!this.admissionsOpen()) return `no admissions (${this.page.halted ? "halted" : this.page.step}${this.rpc.linkUp ? "" : ", no engine link"})`;
    const tab = this.control.workTab;
    if (!tab) return "no work tab";
    let origin = "";
    try {
      origin = new URL(tab.url).origin;
    } catch {
      // not the site
    }
    return origin === SITE_ORIGIN ? null : "the site is not loaded in the work tab";
  }

  /** The site's socket stops the page (ws/): a message the guard did not let
   *  go — or that went past it — or a context the guard could not go into.
   *  The exit closes now, in this turn; the page stands until the engine
   *  starts it again (spec §2.6; stage 1, amendment 17). A socket that
   *  could not be accounted for is a failure instead: Chrome goes with
   *  whatever it holds of that socket, and the page starts again. */
  #socketStop(reason: SocketStop, note: string, how: "stop" | "kill"): void {
    this.egress.closeExit(note);
    if (reason === "ws_unaccounted") {
      void this.#fail(reason, note);
      return;
    }
    if (this.page.halted && this.page.snapshot.stopReason === reason) return;
    void this.#halt(reason, note, how);
  }

  /** A Hub request the operator cannot vouch for (hub-requests/): the exit
   *  closes now, in this turn. A request Chrome may still hold dies with the
   *  browser, and the page starts again — the strict rule, until the owner's
   *  decision №16 says otherwise; headers that differ from the site's stop
   *  it for the owner (plan §4.7). */
  #requestFault(reason: "request_unended" | "header_mismatch", note: string): void {
    this.egress.closeExit(note);
    if (reason === "header_mismatch") void this.#halt("header_mismatch", note, "stop");
    else void this.#fail("request_unended", note);
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
    const egressChanged =
      previous !== null &&
      (previous.pinnedExitIp !== settings.pinnedExitIp ||
        previous.socks.ip !== settings.socks.ip ||
        previous.socks.port !== settings.socks.port ||
        previous.socks.username !== settings.socks.username ||
        previous.socks.password !== settings.socks.password);
    // Chrome takes the time zone and the languages only when it starts.
    const envChanged = previous !== null && !sameEnv(previous.env, settings.env);
    const changed = egressChanged || envChanged;
    if (changed && !this.page.halted && (this.#starting || atLeast(this.page.step, "chrome_started"))) {
      // What was verified is not what the engine says now: the exit closes
      // and the page starts again on the new settings.
      const why = egressChanged ? "the engine changed the page's SOCKS5 or pinned IP" : "the engine changed the page's environment";
      this.egress.closeExit(why);
      queueMicrotask(() => void this.#launch(false, why));
    }
    this.#log("engine.settings", { pageId: settings.pageId, pinnedExitIp: settings.pinnedExitIp, socks: `${settings.socks.ip}:${settings.socks.port}`, env: describeEnv(settings.env), changed });
    return { bufferId: this.buffer.id, state: this.state };
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
    this.sockets.setAdmitWait(this.#params.siteAdmitWaitMs);
    this.site.setTimings(this.#params.siteAdmitWaitMs, this.#params.siteRequestLimitMs);
    this.page.setBackoff(this.#params.restartBackoffMs);
    this.control.networkBuffer = this.#params.chromeBodyBuffer;
    this.buffer.setParams(this.#params.bufferBatchMs, this.#params.bufferCap);
    this.stream.setBatch(this.#params.eventBatch.maxEvents, this.#params.eventBatch.maxBytes);
    if (this.#ipTimer) this.#armIpTimer();
  }

  /** The previous owner's work is over once its queued commands had their
   *  turn — each is refused there now, the generation having moved on — and
   *  there are no admissions yet: the last send the gate saw is all there is. */
  async #quiesce(): Promise<{ lastSendMono: number | null; lastSendWall: number | null }> {
    // The login form's step under way was the earlier owner's: it stops at
    // its next input step, and is over before anything else is.
    this.#cancelLogin("a new owner of the page");
    await this.login.drain();
    await this.#commandChain;
    // The manual login is its owner's (plan §4.8): a new owner switches it on
    // again if it still wants it. The automation is back first.
    if (this.#mode === "manual_login") await this.#leaveManualLogin("a new owner of the page");
    // A start under way ends here, the exit closed: the new owner starts the
    // page. A page that is up stays up — the browser outlives its owner
    // (a Hub deploy is one).
    if (this.#starting) this.#standing = this.#stand("a new owner of the page");
    await this.#standing;
    // The earlier owners' Hub requests: refused if not released, ended
    // (their limits hold them to it) if they were. Their sockets whose
    // handshake has not gone up never go.
    this.sockets.quiesce(this.rpc.generation);
    await Promise.all([this.hub.quiesce(this.rpc.generation), this.site.quiesce(this.rpc.generation)]);
    const sends = [this.egress.gate.lastSend, this.hub.lastMediaSend, this.sockets.lastHandshake].filter((send): send is { mono: number; wall: number } => send !== null);
    const last = sends.length === 0 ? null : sends.reduce((a, b) => (b.mono > a.mono ? b : a));
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
        // What the site has waiting is cancelled, not kept for the next
        // open exit (plan §4.5, §4.9); the browser stays.
        this.site.endAll("the engine's closeExit", false);
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
      case "setMode":
        return command.command.mode === "manual_login" ? this.#enterManualLogin(command.ownerGeneration) : this.#leaveManualLogin("the engine's setMode");
      default:
        return { ok: false, detail: `${command.command.kind} is not supported by this operator yet` };
    }
  }

  async #openExitCommand(): Promise<CommandOutcome> {
    if (this.page.halted) return { ok: false, detail: `the page is stopped (${this.page.snapshot.stopReason ?? "?"}): restartBrowser starts it` };
    this.#exitHeld = false;
    if (this.#starting) return { ok: true, detail: "the running start opens it" };
    if (atLeast(this.page.step, "exit_open")) return { ok: true, detail: "the exit is open" };
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

  // ── the manual login (plan §4.8; spec §7) ─────────────────────────────

  /** The engine of `generation` puts the page into the manual login: the
   *  map lets the login operations through beside the interface's reads
   *  (policy/operations.ts), the site's socket and Hub's requests stay out,
   *  the page is never ready.
   *  A page that is up loads the site anew, so its login screen is shown
   *  under this mode; one that is not waits for the engine's start. */
  async #enterManualLogin(generation: number): Promise<CommandOutcome> {
    if (this.#mode === "manual_login") {
      if (this.#modeGeneration !== generation) this.#cancelLogin("the manual login is another owner's now");
      this.#modeGeneration = generation;
      return { ok: true, detail: "the manual login: already" };
    }
    this.#setMode("manual_login", generation, "the engine's setMode");
    this.login.begin();
    // Hub's requests that wait for their check are refused (#siteNotReady
    // says so from here); a ready page is no longer ready.
    if (atLeast(this.page.step, "session_confirmed")) this.page.back("site_loaded", "the manual login: a person is in the page");
    const reload = this.#reloadForMode("the manual login begins: the site is loaded anew for its login screen");
    return { ok: true, detail: `the manual login${reload ? "; the site is loaded anew" : ""}` };
  }

  /** The automation is back: the login operations are closed again, and
   *  before the page resumes the checks of plan §4.8, step 5 — the exit IP
   *  now (a changed one halts the page), the session and the account by the
   *  engine's identity read under the live session (#confirmSession: the
   *  page is ready only then). A page that is up loads the site anew under
   *  the automation. */
  async #leaveManualLogin(why: string): Promise<CommandOutcome> {
    if (this.#mode === "automation") return { ok: true, detail: "the automation: already" };
    this.#setMode("automation", null, why);
    // The login form's step under way stops at its next input step: nothing
    // of it acts once the automation is back.
    await this.login.drain();
    const up = atLeast(this.page.step, "exit_open") && !this.page.halted && this.egress.exitOpen;
    if (!up) return { ok: true, detail: "the automation; the page is not up: its start checks the exit IP and the session" };
    const run = this.#run;
    try {
      const ip = await this.#verifyExitIp();
      if (run !== this.#run) return { ok: true, detail: "the automation; superseded by a new start" };
      const reload = this.#reloadForMode("the manual login ended: the site is loaded anew under the automation");
      const session = this.hub.session.fingerprint === null ? "no live session yet" : "the live session waits for the engine's identity read";
      return { ok: true, detail: `the automation; the exit IP ${ip} is the pinned one; ${session}${reload ? "; the site is loaded anew" : ""}` };
    } catch (error) {
      if (run !== this.#run) return { ok: true, detail: "the automation; superseded by a new start" };
      const failure = error instanceof StartFailure ? error : new StartFailure("proxy_unavailable", errorMessage(error));
      if (failure.reason === "exit_ip_changed") await this.#halt(failure.reason, failure.message, "stop");
      else await this.#fail(failure.reason, failure.message);
      return { ok: true, detail: `the automation; the exit IP check failed: ${failure.message}` };
    }
  }

  #setMode(mode: Mode, generation: number | null, why: string): void {
    this.#cancelLogin(`the mode changes to ${mode}`);
    // What the engine's identity read confirmed was before a person could
    // be in the page: the session and the account are read anew, by a read
    // sent from now on, before the page is ready again.
    this.#identity = null;
    this.#identityFloorMono = monoMs();
    this.#mode = mode;
    this.#modeGeneration = generation;
    this.#log("mode", { mode, generation, why });
    this.journals.state({ from: this.page.step, to: this.page.step, stopReason: this.page.snapshot.stopReason, retryAtWall: this.page.snapshot.retryAtWall, halted: this.page.halted, note: `mode ${mode}: ${why}` });
    this.#sendState();
  }

  /** The work tab of a page that is up is loaded anew for the mode now —
   *  what of the site is in flight waited out first (a request cancelled by
   *  the reload would stop the page). False: nothing to load (the page is
   *  not up, or its site is loading already). */
  #reloadForMode(note: string): boolean {
    if (this.page.halted || !this.egress.exitOpen || !atLeast(this.page.step, "site_loaded")) return false;
    const run = this.#run;
    const reload = ++this.#modeReload;
    const stale = () => run !== this.#run || reload !== this.#modeReload || this.#stopped || this.page.halted || !this.egress.exitOpen || !atLeast(this.page.step, "site_loaded");
    void (async () => {
      const idle = await this.#waitUntil(() => stale() || this.site.released === 0, this.#timings.reloadWaitMs);
      if (stale()) return;
      if (!idle) {
        this.#log("site.mode_reload_skipped", { released: this.site.released });
        return;
      }
      this.site.reloading(this.control.workTab?.mainFrameId ?? null);
      this.page.back("exit_open", note);
      await this.#loadSite(run);
    })();
    return true;
  }

  /** The work tab's document goes, failed closed: a press of the login form
   *  could not be let go where it clicks nothing (login/desk.ts), and must
   *  not wait in it for a release. A page that is up loads the site anew at
   *  once — not waiting for what of the site is in flight: a request cut by
   *  it stops the page, as a reload's would (#reloadForMode) — and one whose
   *  site load fails starts again; a page that is not up gets a blank
   *  document. */
  async #discardDocument(why: string): Promise<void> {
    const tab = this.control.workTab;
    if (tab === null) return;
    this.#log("login.document_discarded", { why });
    if (this.page.halted || !this.egress.exitOpen || !atLeast(this.page.step, "site_loaded")) {
      await this.cdp.send("Page.navigate", { url: "about:blank" }, tab.sessionId, this.#timings.siteLoadMs);
      return;
    }
    const run = this.#run;
    this.site.reloading(tab.mainFrameId ?? null);
    this.page.back("exit_open", why);
    await this.#loadSite(run);
  }

  /** A call of the login form (spec §6.1 `login.*`): taken only in the
   *  manual login that the engine of the current owner generation switched
   *  on, with the page up; what types into the site, also only while that
   *  engine is heard (its admission is what lets the login go) — and only
   *  for as long as all of it holds (`#loginGuard`, read before every input
   *  step). */
  async #onLogin(request: LoginRequest): Promise<LoginOutcome | { kind: "refused"; reason: "not_manual_login" }> {
    const current = this.#mode === "manual_login" && this.#modeGeneration !== null && this.#modeGeneration === this.rpc.generation;
    const up = !this.page.halted && atLeast(this.page.step, "exit_open") && this.egress.exitOpen;
    if (!current || !up) return { kind: "refused", reason: "not_manual_login" };
    switch (request.type) {
      case "login.state":
        return this.login.state();
      case "login.screenshot":
        return this.login.screenshot();
      case "login.submit":
        return this.login.submit(request.login, request.password, this.#loginGuard());
      case "login.code":
        return this.login.code(request.code, this.#loginGuard());
    }
  }

  /** A login call's claim on the browser, taken now: null while the manual
   *  login it was taken in lasts — the same mode, owner generation and
   *  engine connection (`#loginEpoch`), that engine heard, the same start
   *  of the page and the page up — else why not. */
  #loginGuard(): LoginGuard {
    const epoch = this.#loginEpoch;
    const generation = this.#modeGeneration;
    const run = this.#run;
    return () => {
      if (epoch !== this.#loginEpoch) return "the manual login it was taken in is over";
      if (this.#mode !== "manual_login" || generation === null || this.#modeGeneration !== generation || this.rpc.generation !== generation) return "not the manual login it was taken in";
      if (!this.rpc.linkUp) return "no engine link";
      if (run !== this.#run || this.page.halted || !atLeast(this.page.step, "exit_open") || !this.egress.exitOpen) return "the page is not up as it was";
      return null;
    };
  }

  /** The login calls taken until now may act no more. */
  #cancelLogin(why: string): void {
    this.#loginEpoch += 1;
    this.#log("login.epoch", { why });
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

  // ── the buffer (plan §4.4; spec §5, §6.2) ──────────────────────────────

  #onBuffer(message: BufferMessage): void {
    switch (message.type) {
      case "events.subscribe": {
        const refused = this.stream.subscribe(message);
        if (refused) this.rpc.send(refused);
        return;
      }
      case "ack": {
        const refused = this.stream.ack(message);
        if (refused) this.rpc.send(refused);
        return;
      }
      case "resultAck":
        this.buffer.acknowledgeOutcome(message.attemptId);
        return;
      case "recover":
        // The engine's start (plan §3.2): the outcomes the buffer has go
        // first, then the answer for each attempt (buffer/replay.ts).
        if (!this.replay.recover(message.attemptIds)) this.rpc.protocolError("recover: more attempts waiting for their answer than the operator keeps");
        return;
    }
  }

  /** The buffer could not be opened: the page stands with the exit closed
   *  until it is — a halt, so a start comes only from the engine, and none
   *  passes the gate before the buffer opens. */
  #onBufferUnavailable(unavailable: BufferUnavailable): void {
    this.egress.closeExit(`the buffer cannot be opened: ${unavailable.detail}`);
    this.#alarm("buffer", unavailableDetail(unavailable));
    const note = `the buffer cannot be opened (${unavailable.cause}${unavailable.recoverable ? ", tried again" : ", left for the owner"}): ${unavailable.detail}`;
    if (this.#controlExpected || this.#starting) void this.#fail("buffer_unavailable", note);
    // A page that stands for nothing yet (the operator's start) stands for
    // this; one the engine already asked to start keeps failing at the gate.
    else if (!this.page.halted && this.page.snapshot.stopReason === null) this.page.halt("buffer_unavailable", note);
    this.#sendState();
  }

  /** The buffer opened after all: a page that stood for it stands as any
   *  other (or, if a start failed on it, starts again); the outcomes go to
   *  the engine, which subscribes again on seeing the state. */
  #onBufferOpened(): void {
    const snapshot = this.page.snapshot;
    this.#log("buffer.opened", { bufferId: this.buffer.id });
    this.sockets.bufferOpened();
    if (snapshot.stopReason === "buffer_unavailable" && !this.#stopped) {
      if (snapshot.halted) this.page.stand("the buffer is open");
      else if (!this.#starting) void this.#launch(false, "the buffer is open");
    }
    this.#sendState();
    if (this.rpc.linkUp) this.replay.connected();
  }

  /** Room in the buffer again, its gap written (spec §5, step 4): a page
   *  that stopped for it starts again now, not at its next retry. */
  #onBufferRoom(reason: FullReason): void {
    const snapshot = this.page.snapshot;
    // The socket's writes that waited for room go first.
    this.sockets.retryNow();
    this.site.retryNow();
    this.#sendState();
    if (this.#stopped || this.#starting || snapshot.halted) return;
    if (snapshot.stopReason !== "buffer_full" && snapshot.stopReason !== "disk_full") return;
    this.#log("buffer.room", { reason, action: "the start goes again" });
    void this.#launch(false, `the buffer has room again (${reason})`);
  }

  /** `open`: what the buffer holds, said only while its file is open — a
   *  buffer that cannot be opened counts nothing, and its zero is no word
   *  that it is empty (the engine takes a buffer for drained by `open`
   *  alone). */
  #bufferState(): State["buffer"] {
    const stats = this.buffer.stats();
    return {
      bytes: stats.bytes,
      oldestAgeMs: stats.oldestAgeMs,
      open: this.buffer.isOpen ? { id: this.buffer.id, lastSeq: stats.lastSeq, outcomes: stats.outcomes, pending: stats.pending } : null,
    };
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

function unavailableDetail(unavailable: BufferUnavailable): Record<string, string | number | boolean> {
  return { unavailable: true, cause: unavailable.cause, recoverable: unavailable.recoverable, attempts: unavailable.attempts, detail: unavailable.detail };
}

function alarmDetail(alarm: BufferAlarm): Record<string, string | number | boolean> {
  return { percent: Math.round(alarm.percent), by: alarm.by, bytes: alarm.bytes, capBytes: alarm.capBytes, oldestAgeMs: alarm.oldestAgeMs, capAgeMs: alarm.capAgeMs, freeDiskBytes: alarm.freeDiskBytes };
}
