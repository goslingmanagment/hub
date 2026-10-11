// The page operator, PROTOTYPE (plan §3.1, §4.1–§4.4, §4.13). Drives Chrome
// over CDP through the holder, is Chrome's only network exit (egress.ts),
// admits every API request of the site and of Hub through the engine (RPC),
// guards the site's socket inside the page (guard.ts).
//
// Startup (plan §4.1): exit closed → Chrome started → control attached
// (Fetch on the browser target, auto-attach with every new target paused
// until it is set up) → self-test with the exit closed → exit IP check →
// exit open → the site loaded → ready. Any failure goes back to the start.

import { connect as tlsConnect } from "node:tls";
import { createConnection } from "node:net";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync, type WriteStream } from "node:fs";
import { createHash, type Hash } from "node:crypto";

import { Cdp, type CdpEvent } from "./cdp.ts";
import { Egress, socksConnect, type HostClass } from "./egress.ts";
import { guardSource, type GuardPolicy } from "./guard.ts";
import { RpcServer, type EngineMessage } from "./rpc.ts";
import { encodeMessage, readMessages } from "../shared/frames.ts";
import { envInt, envStr, makeLog, monoMs, sleep } from "../shared/util.ts";

const log = makeLog("operator");

// ── configuration ─────────────────────────────────────────────────────────

const list = (name: string, fallback: string) =>
  envStr(name, fallback)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

const CFG = {
  holderSock: envStr("PB_HOLDER_SOCK", "/run/pb/holder.sock"),
  ctlSock: envStr("PB_CTL_SOCK", "/run/pb/ctl.sock"),
  proxyPort: envInt("PB_PROXY_PORT", 3128),
  rpcPort: envInt("PB_RPC_PORT", 7700),
  rpcToken: envStr("PB_RPC_TOKEN", ""),
  socks: {
    // The address entry.sh resolved and opened in the egress rules: the
    // operator has no DNS of its own.
    host: existsSync("/run/socks-ip") ? readFileSync("/run/socks-ip", "utf8").trim() : envStr("PB_SOCKS_HOST", "stand-server"),
    port: envInt("PB_SOCKS_PORT", 1080),
    user: envStr("PB_SOCKS_USER", "pb"),
    pass: envStr("PB_SOCKS_PASS", "pb-secret"),
  },
  siteUrl: envStr("PB_SITE_URL", "https://site.stand.test/"),
  hosts: {
    site: list("PB_HOSTS_SITE", "site.stand.test"),
    api: list("PB_HOSTS_API", "api.stand.test"),
    ws: list("PB_HOSTS_WS", "ws.stand.test"),
    cdn: list("PB_HOSTS_CDN", "cdn.stand.test"),
  },
  ipCheckHost: envStr("PB_IPCHECK_HOST", "api.ipify.org"),
  pinnedIp: envStr("PB_PINNED_IP", "203.0.113.7"),
  /** What a blocked socket message does: `stop` (plan) or `log` (stand runs). */
  onBlockedSend: envStr("PB_ON_BLOCKED_SEND", "stop"),
  /** Candidate for condition №2: abort a Hub fetch 1 s before its deadline. */
  hubAbortBeforeDeadline: envStr("PB_HUB_ABORT", "1") === "1",
  /** Candidate: release Hub requests from an unreachable placeholder host. */
  hubPlaceholderHost: envStr("PB_HUB_PLACEHOLDER", "1") === "1",
  /** Refuse every non-socket request to the socket host (no HTTP/2 session
   *  there for a socket to ride). */
  refuseWsHostRequests: envStr("PB_WS_HOST_REFUSE", "1") === "1",
  siteAdmitWaitMs: envInt("PB_SITE_ADMIT_WAIT_MS", 60_000),
  /** The page's environment by its proxy's region (plan §4.1 step 2). */
  env: {
    timeZone: envStr("PB_TZ", "UTC"),
    language: envStr("PB_LANG", "en-US"),
    /** "latitude,longitude,accuracy" or empty: no geolocation override. */
    geolocation: envStr("PB_GEO", ""),
  },
  /** Where Fetch interception is enabled: "browser" (one browser-target
   *  handler; Chrome 155 also pauses CORS preflights there — and races on
   *  their request id, see FINDINGS) or "target" (each page, frame and
   *  worker; preflights travel with their request). */
  fetchScope: envStr("PB_FETCH_SCOPE", "browser"),
  /** Hand a preflight's answer on with Fetch.fulfillRequest (the fix of the
   *  duplicate-request-id race); stand knob to measure without it. */
  preflightFulfill: envStr("PB_PREFLIGHT_FULFILL", "1") === "1",
  /** The self-test also checks the rules extension (an image with it). */
  selftestRules: envStr("PB_SELFTEST_RULES", "0") === "1",
  selftestNeverPath: envStr("PB_SELFTEST_NEVER_PATH", "/api/v1/message/ack"),
  /** How a Hub request is made in the isolated world: "fetch", or "xhr" —
   *  as Fansly's own API calls (Angular's HttpClient over XMLHttpRequest),
   *  so their headers match (stage 1, item 15). */
  hubTransport: envStr("PB_HUB_TRANSPORT", "fetch"),
  /** Fansly's key of fansly-client-check (public bundle, 2026-10-11); it is
   *  checked against every value the site computes itself. */
  fanslyCheckKey: envStr("PB_FANSLY_CHECK_KEY", "necvac-govry3-tybkYz"),
  /** Capture response bodies of API requests to disk (plan §4.2 step 7,
   *  §4.3 step 4). */
  captureBodies: envStr("PB_CAPTURE_BODIES", "1") === "1",
  /** Paths whose responses may be written down (a regular expression); none
   *  when unset, except on the stand (Astra review 2, E: a filter of bad
   *  names missed /intercom/authorize). */
  captureAllow: (() => {
    const pattern = envStr("PB_CAPTURE_ALLOW", process.env.PB_STAND === "1" ? "^/api/" : "");
    return pattern === "" ? null : new RegExp(pattern);
  })(),
  bodiesDir: envStr("PB_BODIES_DIR", "/data/buffer/bodies"),
  /** A Hub response over this declared size is cancelled before its body. */
  hubBodyLimit: envInt("PB_HUB_BODY_LIMIT", 32 * 1024 * 1024),
  heartbeat: "/run/pb/operator.alive",
};

const PLACEHOLDER_SUFFIX = ".pb-hold.invalid";
const BINDING = `__pb${Math.random().toString(36).slice(2, 10)}`;
// Spec §2.6: Fansly's ping and the socket's authorisation
// {"t":1,"d":"{\"token\":…,\"v\":3}"}; what else the site sends — stage 1, item 9.
const GUARD_POLICY: GuardPolicy = {
  exact: envStr("PB_WS_ALLOW_EXACT", "p").split("|").filter(Boolean),
  json: JSON.parse(envStr("PB_WS_ALLOW_JSON", '[{"t":1,"keys":["t","d"],"dKeys":["token","v"]}]')) as GuardPolicy["json"],
};
const GUARD = guardSource(BINDING, GUARD_POLICY);

const GEO = (() => {
  const parts = CFG.env.geolocation.split(",").map((part) => Number(part.trim()));
  return parts.length >= 2 && parts.every((part) => Number.isFinite(part)) ? { latitude: parts[0]!, longitude: parts[1]!, accuracy: parts[2] ?? 50 } : null;
})();

/** A host list entry is a name, or a pattern with `*` for one label part
 *  (`cdn*.fansly.com`). */
function hostIn(list: string[], host: string): boolean {
  return list.some((entry) =>
    entry.includes("*") ? new RegExp(`^${entry.split("*").map((part) => part.replace(/[.\\^$+?()[\]{}|]/g, "\\$&")).join("[^.]*")}$`).test(host) : entry === host,
  );
}

function classify(host: string): HostClass {
  if (hostIn(CFG.hosts.site, host)) return "site";
  if (hostIn(CFG.hosts.api, host)) return "api";
  if (hostIn(CFG.hosts.ws, host)) return "ws";
  if (hostIn(CFG.hosts.cdn, host)) return "cdn";
  return "denied";
}

// ── state ─────────────────────────────────────────────────────────────────

type OpState = "starting" | "chrome_starting" | "attaching" | "selftest" | "ip_check" | "site_loading" | "ready" | "failed";

const cdp = new Cdp();
const egress = new Egress(CFG.socks, classify);
// The engine's token is required; the stand's own token only on the stand
// (Astra review of the prototype, finding 12).
if (CFG.rpcToken.length < 16 && !(process.env.PB_STAND === "1" && CFG.rpcToken !== "")) {
  log("fatal", { error: "PB_RPC_TOKEN is missing or too short" });
  process.exit(2);
}
const rpc = new RpcServer(CFG.rpcToken);
let state: OpState = "starting";
let stateReason = "";
let selftest: Record<string, unknown> | null = null;
let restarting = false;
/** The holder's last seq at hello: messages up to it are a replay. */
let replayUpTo = 0;

interface TargetInfo {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  mainFrameId?: string;
  worldId?: number;
  setup?: Promise<void>;
  /** A worker paused before its first script until the guard is in. */
  guardBreakpoint?: string;
  /** The next pause before a script is the first script of a (re)started
   *  worker: the guard goes in there. */
  needsGuard?: boolean;
  /** A service worker: Chrome stops and starts it again under the same
   *  session (Inspector.targetCrashed → targetReloadedAfterCrash), so the
   *  debugger and its breakpoint stay for the session's life. */
  persistentGuard?: boolean;
}
const targets = new Map<string, TargetInfo>();
let sitePage: TargetInfo | null = null;

function setState(next: OpState, reason = ""): void {
  if (state === next && reason === stateReason) return;
  log("state", { from: state, to: next, reason });
  state = next;
  stateReason = reason;
  sendState();
}

function sendState(): void {
  rpc.send({
    type: "state",
    state,
    reason: stateReason,
    exit: egress.exitOpen ? "open" : "closed",
    gate: egress.gate.state,
    cdp: cdp.cdpUp ? "up" : "down",
    selftest,
    mono: monoMs(),
  });
}

function observe(kind: string, fields: Record<string, unknown>): void {
  // Prototype telemetry for the stand's runner: what the operator saw.
  rpc.send({ type: "observe", ...fields, kind, mono: monoMs() });
}

// ── supervisor ────────────────────────────────────────────────────────────

function supervisor(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(CFG.ctlSock);
    socket.on("connect", () => socket.write(encodeMessage(JSON.stringify(command))));
    readMessages(socket, (value) => resolve(value as Record<string, unknown>));
    socket.on("error", reject);
    setTimeout(() => reject(new Error("supervisor timeout")), 15_000);
  });
}

// ── targets: every new one is set up before it runs ──────────────────────

/** Targets of the browser's own UI and extensions are only resumed. */
function isWebTarget(info: TargetInfo): boolean {
  return info.url === "" || /^(https?:|about:|blob:|data:)/.test(info.url);
}

async function setUpTarget(info: TargetInfo, waiting: boolean): Promise<void> {
  const s = info.sessionId;
  const web = isWebTarget(info);
  const isPage = web && (info.type === "page" || info.type === "iframe");
  const isWorker = web && (info.type === "worker" || info.type === "shared_worker" || info.type === "service_worker");
  const step = (name: string) => {
    if (process.env.PB_DEBUG_FETCH === "1" && isWorker) log("target.step", { type: info.type, step: name });
  };
  try {
    if ((isPage || isWorker) && CFG.fetchScope === "target") {
      step("fetch");
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, s);
    }
    if (isPage || isWorker) {
      step("network");
      await cdp.send("Network.enable", { maxTotalBufferSize: 100 * 1024 * 1024, maxResourceBufferSize: 20 * 1024 * 1024 }, s);
      // V8 installs a binding into new contexts only while Runtime is enabled.
      step("runtime");
      if (process.env.PB_RUNTIME_ENABLE !== "0") await cdp.send("Runtime.enable", {}, s);
      step("binding");
      await cdp.send("Runtime.addBinding", { name: BINDING }, s);
    }
    if (isPage) {
      // Geolocation of the page's region, before the target runs anything.
      if (GEO) await cdp.send("Emulation.setGeolocationOverride", GEO, s);
      await cdp.send("Page.enable", {}, s);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: GUARD, runImmediately: true }, s);
    }
    if (isWorker) {
      // A worker waiting for the debugger has no script context yet, so
      // Runtime.evaluate would wait forever (stand finding). Pause it before
      // its first script instead; the guard goes in there (Debugger.paused).
      step("instrumentation");
      await cdp.send("Debugger.enable", {}, s);
      const bp = await cdp.send<{ breakpointId: string }>("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptExecution" }, s);
      info.guardBreakpoint = bp.breakpointId;
      info.needsGuard = true;
      info.persistentGuard = info.type === "service_worker";
    }
    if (isPage || isWorker) {
      // Service workers are attached once, by the browser target; a second
      // session to the same worker (from the page) deadlocks its start.
      await cdp.send(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "service_worker", exclude: true }, {}] },
        s,
      );
    }
  } catch (error) {
    log("target.setup_failed", { type: info.type, url: info.url, error: (error as Error).message });
    // A web target without its interception or socket guard never runs
    // (Astra review of the prototype, finding 2) — unless it is gone already
    // (closed, or CDP itself lost: the loss path handles that).
    if (isPage || isWorker) {
      if (!targetGone(error as Error)) halt(`setup of a ${info.type} failed: ${(error as Error).message}`);
      return;
    }
  }
  if (waiting) cdp.post("Runtime.runIfWaitingForDebugger", {}, s);
  log("target.ready", { type: info.type, url: info.url, sessionId: s, waiting });
}

cdp.on("Target.attachedToTarget", (event) => {
  const params = event.params as { sessionId: string; targetInfo: { targetId: string; type: string; url: string }; waitingForDebugger: boolean };
  const info: TargetInfo = { sessionId: params.sessionId, targetId: params.targetInfo.targetId, type: params.targetInfo.type, url: params.targetInfo.url };
  targets.set(info.sessionId, info);
  log("target.attached", { type: info.type, url: info.url, waiting: params.waitingForDebugger, parent: event.sessionId ?? null });
  observe("target.attached", { type: info.type, url: info.url, waiting: params.waitingForDebugger, parent: event.sessionId ?? null });
  if (info.type === "page" && !event.sessionId && sitePage === null) sitePage = info;
  info.setup = setUpTarget(info, params.waitingForDebugger);
});

cdp.on("Debugger.paused", (event) => {
  const s = event.sessionId;
  const info = s ? targets.get(s) : undefined;
  const params = event.params as { reason: string; callFrames: Array<{ callFrameId: string }> };
  if (!s || !info?.guardBreakpoint || !info.needsGuard) {
    // A later script of the worker, or the site's own `debugger;`: go on.
    if (s) cdp.post("Debugger.resume", {}, s);
    return;
  }
  const breakpointId = info.guardBreakpoint;
  info.needsGuard = false;
  void (async () => {
    try {
      const frame = params.callFrames[0];
      const result = frame
        ? await cdp.send<{ exceptionDetails?: unknown }>("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: GUARD, silent: true }, s)
        : await cdp.send<{ exceptionDetails?: unknown }>("Runtime.evaluate", { expression: GUARD, silent: true }, s);
      if (result.exceptionDetails) throw new Error("the guard threw");
      log("guard.worker_installed", { type: info.type, url: info.url, reason: params.reason, persistent: info.persistentGuard === true });
      if (!info.persistentGuard) await cdp.send("Debugger.removeBreakpoint", { breakpointId }, s).catch(() => undefined);
    } catch (error) {
      // The worker stays paused before its first script; the page stops
      // (unless the worker or CDP is gone already).
      log("guard.worker_failed", { type: info.type, url: info.url, error: (error as Error).message });
      if (!targetGone(error as Error)) halt(`socket guard failed in a ${info.type}`);
      return;
    }
    if (info.persistentGuard) {
      // The breakpoint stays for the next start of the worker.
      cdp.post("Debugger.resume", {}, s);
    } else {
      // Disabling the debugger resumes the worker and leaves nothing behind
      // (no pauses on the site's own `debugger;` statements).
      info.guardBreakpoint = undefined;
      cdp.post("Debugger.disable", {}, s);
    }
  })();
});

// A service worker stopped by Chrome and started again (stand finding: the
// session stays, no new attach). Its next first script needs the guard; if
// it waits for the debugger, it is let go — the breakpoint stops it before
// that script.
cdp.on("Inspector.targetCrashed", (event) => {
  const info = event.sessionId ? targets.get(event.sessionId) : undefined;
  if (info?.persistentGuard) {
    info.needsGuard = true;
    observe("worker.stopped", { type: info.type, url: info.url });
  }
});

cdp.on("Inspector.targetReloadedAfterCrash", (event) => {
  const s = event.sessionId;
  const info = s ? targets.get(s) : undefined;
  if (!s || !info?.persistentGuard) return;
  info.needsGuard = true;
  observe("worker.restarted", { type: info.type, url: info.url });
  cdp.post("Runtime.runIfWaitingForDebugger", {}, s);
});

cdp.on("Target.detachedFromTarget", (event) => {
  const sessionId = (event.params as { sessionId: string }).sessionId;
  targets.delete(sessionId);
  if (sitePage?.sessionId === sessionId) sitePage = null;
});

cdp.on("Page.frameNavigated", (event) => {
  const frame = (event.params as { frame: { id: string; parentId?: string; url: string } }).frame;
  const info = event.sessionId ? targets.get(event.sessionId) : undefined;
  if (info && !frame.parentId) {
    info.mainFrameId = frame.id;
    info.url = frame.url;
    info.worldId = undefined; // the isolated world died with the document
  }
});

cdp.on("Runtime.bindingCalled", (event) => {
  const params = event.params as { name: string; payload: string };
  if (process.env.PB_DEBUG_FETCH === "1") log("binding.called", { name: params.name, payload: params.payload.slice(0, 200) });
  if (params.name !== BINDING) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(params.payload) as Record<string, unknown>;
  } catch {
    return;
  }
  const info = event.sessionId ? targets.get(event.sessionId) : undefined;
  observe("guard", { ...payload, target: info?.type ?? null });
  if (payload.k === "blocked_send") {
    log("guard.blocked_send", { msgType: payload.msgType, len: payload.len, target: info?.type });
    rpc.send({ type: "alarm", kind: "ws_blocked_send", detail: { msgType: payload.msgType, len: payload.len, target: info?.type } });
    // Plan §4.3: the exit closes and the page stays stopped (a halt: no
    // restart brings it back on its own).
    if (CFG.onBlockedSend === "stop") halt("an unknown outgoing socket message");
  }
  if (payload.k === "guard_failed") halt(`socket guard failed in a ${info?.type ?? "context"}: ${String(payload.why)}`);
});

// ── operations: what one admission covers ─────────────────────────────────
//
// Chrome 155 pauses a CORS preflight in Fetch as a request of its own, right
// before the request it guards (stand finding; the plan assumed it was not
// intercepted). Owner decision №1: preflight + request = one operation under
// one admission. So an operation has up to two physical requests; each
// physical request gets its own gate window inside the admission's window,
// and Chrome sending one of them twice is a retry.

/** A response body as it streams in (plan §4.2 step 7): written to disk
 *  chunk by chunk, never whole in memory. `decoded` — the body as the page
 *  gets it; `encoded` — the bytes of the transfer (compressed). */
interface Capture {
  file: string;
  stream: WriteStream;
  hash: Hash;
  decoded: number;
  encoded: number;
  chunks: number;
  /** A chunk whose data did not match its announced length. */
  broken: boolean;
  contentLength: number | null;
  contentEncoding: string | null;
  armedMono: number;
  /** The file could not be written (disk full...): the body is not whole. */
  writeError: string | null;
  /** Settles when the file is closed (or failed). */
  flushed: Promise<void> | null;
}

interface Physical {
  op: Operation;
  role: "preflight" | "main";
  networkId: string | null;
  sends: number;
  done: boolean;
  capture: Capture | null;
}

/** An admitted operation ends within this time whatever Chrome does (plan
 *  §4.14, the engine's REQUEST_TIMEOUT_MS + 1 s): a body nobody reads has no
 *  end event, a cancelled preflight has none for its request. */
const OP_LIMIT_MS = 21_000;

interface Operation {
  kind: "hub" | "site" | "selftest";
  id: string;
  /** Links a preflight to its request: URL without fragment + method. */
  key: string;
  admissionId: string | null;
  deadline: number | null;
  preflight: Physical | null;
  main: Physical | null;
  sendMono: number | null;
  preflightSendMono: number | null;
  status: number | null;
  /** The status the server really sent (304 for a revalidated cache entry;
   *  the page sees the cached 200). */
  wireStatus: number | null;
  fromCache: boolean;
  fromServiceWorker: boolean;
  /** Response headers the engine may use (Retry-After...), cookies left out. */
  headers: Record<string, string> | null;
  /** The preflight's status, when it had one. */
  preflightStatus: number | null;
  sessionId: string | null;
  done: boolean;
  mainTimer: NodeJS.Timeout | null;
  limitTimer: NodeJS.Timeout | null;
  onFinish: (outcome: Record<string, unknown>) => void;
}

const byNetworkId = new Map<string, Physical>();
/** Site operations whose preflight passed and whose request is not paused
 *  yet, by key. */
const awaitingMain = new Map<string, Operation>();

if (process.env.PB_DEBUG_NET === "1") {
  for (const method of ["Network.requestWillBeSent", "Network.requestWillBeSentExtraInfo", "Network.responseReceived", "Network.responseReceivedExtraInfo", "Network.loadingFinished", "Network.loadingFailed"]) {
    cdp.on(method, (event) => {
      const p = event.params as Record<string, any>;
      if (!byNetworkId.has(p.requestId)) return;
      log("net", { m: method.slice(8), id: p.requestId, type: p.type ?? null, url: String(p.request?.url ?? p.response?.url ?? "").split("?")[0], status: p.response?.status ?? p.statusCode ?? null, err: p.errorText ?? null });
    });
  }
}

/** Every operation not finished yet: a lost browser ends them all, so no
 *  timer of the old browser acts on the new one (Astra review of the
 *  prototype, finding 9). */
const liveOps = new Set<Operation>();

function newOperation(kind: Operation["kind"], id: string, key: string, onFinish: Operation["onFinish"]): Operation {
  const op: Operation = {
    kind,
    id,
    key,
    admissionId: null,
    deadline: null,
    preflight: null,
    main: null,
    sendMono: null,
    preflightSendMono: null,
    status: null,
    wireStatus: null,
    fromCache: false,
    fromServiceWorker: false,
    headers: null,
    preflightStatus: null,
    sessionId: null,
    done: false,
    mainTimer: null,
    limitTimer: null,
    onFinish,
  };
  liveOps.add(op);
  return op;
}

/** Start the operation's clock at its admission. */
function startLimit(op: Operation): void {
  op.limitTimer = setTimeout(() => {
    if (op.done) return;
    observe("op.limit", { op: op.id, kind: op.kind, status: op.status, mainSends: op.main?.sends ?? 0 });
    // The gate's window goes with the operation. A request without an
    // answer may still be on its way out: its API tunnels are cut so nothing
    // of it leaves later. One whose answer began left long ago (the page did
    // not read the body to its end — stand finding): the connection stays.
    if (op.status === null) egress.cutClass("api", "operation over its time limit");
    if (op.status !== null && op.main) {
      finishWithBody(op, op.main, "limit", null, { outcome: "response", status: op.status, headers: op.headers, sends: op.main.sends, sendMono: op.sendMono, fromCache: op.fromCache, fromServiceWorker: op.fromServiceWorker, bodyEnd: "limit" });
    } else {
      finishOp(op, { outcome: "transport_error", sent: (op.main?.sends ?? 0) > 0, error: "no end within the operation limit", sends: op.main?.sends ?? 0 });
    }
  }, OP_LIMIT_MS);
}

function finishOp(op: Operation, outcome: Record<string, unknown>): void {
  if (op.done) return;
  op.done = true;
  liveOps.delete(op);
  // A capture still open (control lost, a redirect, a limit) is closed
  // here: its file is not whole and no result says it is.
  for (const phys of [op.preflight, op.main]) {
    if (phys?.capture) {
      phys.capture.stream.destroy();
      phys.capture = null;
    }
  }
  if (op.mainTimer) clearTimeout(op.mainTimer);
  if (op.limitTimer) clearTimeout(op.limitTimer);
  for (const phys of [op.preflight, op.main]) if (phys?.networkId) byNetworkId.delete(phys.networkId);
  if (awaitingMain.get(op.key) === op) awaitingMain.delete(op.key);
  for (const phys of [op.preflight, op.main]) {
    const wid = phys ? windowId(phys) : null;
    if (wid) egress.gate.close(wid);
  }
  op.onFinish({ ...outcome, preflight: op.preflight ? { sends: op.preflight.sends, status: op.preflightStatus } : null, preflightSendMono: op.preflightSendMono });
}

/** Release one physical request of an admitted operation. */
/** The gate's window of one physical request (events of the preflight
 *  may arrive after its request is already out: CDP orders events within a
 *  session, not across the browser and page sessions). */
function windowId(phys: Physical): string | null {
  return phys.op.admissionId ? `${phys.op.admissionId}:${phys.role}` : null;
}

function releasePhysical(op: Operation, event: CdpEvent, params: PausedParams, role: Physical["role"], extra: Record<string, unknown> = {}): void {
  const phys: Physical = { op, role, networkId: params.networkId ?? null, sends: 0, done: false, capture: null };
  if (role === "preflight") op.preflight = phys;
  else op.main = phys;
  if (phys.networkId) byNetworkId.set(phys.networkId, phys);
  // Chrome sends the request only after its preflight passed: link them now,
  // not on the preflight's loadingFinished (that may come later).
  if (role === "preflight" && op.kind === "site") awaitingMain.set(op.key, op);
  const id = windowId(phys);
  const body = bodyBytes(params.request);
  if (body === null && egress.gate.enabled) {
    // The gate counts a request's records by its body: a body it cannot
    // measure (a stream) would leave the window open on CDP's word alone.
    log("release.refused", { op: op.id, why: "body of unknown length" });
    void resolvePaused(event, "fail", { requestId: params.requestId, errorReason: "BlockedByClient" });
    finishOp(op, { outcome: "transport_error", sent: false, error: "body of unknown length" });
    return;
  }
  if (id && op.deadline !== null) egress.gate.open(id, op.deadline, body);
  // The response stops once more at its headers: for a request, the body's
  // stream is armed there, before a byte of it reaches the page; for a
  // preflight, its answer is handed on by Fetch.fulfillRequest (see
  // onResponseStage — the race of Chrome's preflight interception).
  const intercept =
    (CFG.captureBodies && role === "main" && phys.networkId !== null && capturable(params.request)) || (role === "preflight" && CFG.preflightFulfill)
      ? { interceptResponse: true }
      : {};
  void resolvePaused(event, "continue", { requestId: params.requestId, ...extra, ...intercept });
}

/** The body of a paused request in bytes: 0 = none, null = not known (a
 *  stream or a blob the event does not carry). */
function bodyBytes(request: PausedParams["request"]): number | null {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return 0;
  const entries = request.postDataEntries;
  if (entries && entries.length > 0) {
    let total = 0;
    for (const entry of entries) {
      if (typeof entry.bytes !== "string") return null;
      total += Buffer.from(entry.bytes, "base64").length;
    }
    return total;
  }
  if (typeof request.postData === "string") return Buffer.byteLength(request.postData, "utf8");
  return request.hasPostData ? null : 0;
}

/** Responses that may carry secrets are never written down (spec §2.4: the
 *  login operations; Astra reviews of the prototype, findings 7 and E).
 *  Stage 1 keeps reads only, of the allowed paths only, and none that look
 *  like login, session, 2FA or an authorisation. */
function capturable(request: PausedParams["request"]): boolean {
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return false;
  if (CFG.captureAllow === null) return false;
  let path = "";
  try {
    path = new URL(request.url).pathname;
  } catch {
    return false;
  }
  if (!CFG.captureAllow.test(path)) return false;
  return !/\/(login|logout|session|sessions|twofa|auth|authorize|token|password)(\/|$)/i.test(path);
}

function isPreflight(params: PausedParams): boolean {
  if (params.request.method !== "OPTIONS") return false;
  // Scripts cannot set this header: only Chrome's own preflight carries it.
  return Object.keys(params.request.headers).some((name) => name.toLowerCase() === "access-control-request-method");
}

function preflightMethod(params: PausedParams): string {
  const entry = Object.entries(params.request.headers).find(([name]) => name.toLowerCase() === "access-control-request-method");
  return entry ? String(entry[1]).toUpperCase() : "GET";
}

function opKey(url: string, method: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return `${method} ${parsed.toString()}`;
}

cdp.on("Network.requestWillBeSentExtraInfo", (event) => {
  const params = event.params as { requestId: string; headers?: Record<string, string> };
  const phys = byNetworkId.get(params.requestId);
  if (!phys || phys.done) return;
  const op = phys.op;
  phys.sends += 1;
  // Stage 1, item 15: the names of the headers as sent, in order — of the
  // site's requests and of Hub's, to compare (never the values).
  if (phys.sends === 1 && params.headers) observe("headers", { op: op.id, opKind: op.kind, role: phys.role, path: op.key.split(" ")[1] ? new URL(op.key.split(" ")[1]!).pathname : null, names: Object.keys(params.headers) });
  observe("send", { op: op.id, kind: op.kind, role: phys.role, n: phys.sends });
  const wid = windowId(phys);
  if (wid) egress.gate.announced(wid);
  if (phys.sends > 1) {
    // Never seen on the stand: Chrome announces a request once even when it
    // repeats it. Kept as a tripwire for a Chrome that starts to.
    log("retry.detected", { op: op.id, role: phys.role, sends: phys.sends });
    observe("retry", { op: op.id, kind: op.kind, role: phys.role, sends: phys.sends });
  }
  if (op.kind === "hub" && phys.role === "main" && phys.sends === 1) rpc.send({ type: "sent", attemptId: op.id, mono: monoMs() });
});

/** Network ids of Hub requests that were redirected: their next hop is
 *  refused. */
const refusedHops = new Set<string>();

/** The session a request's Network events come on (its page or worker). */
const sessionOfRequest = new Map<string, string>();

cdp.on("Network.requestWillBeSent", (event) => {
  const params = event.params as { requestId: string; request: { url: string }; redirectResponse?: { status: number; headers?: Record<string, string> } };
  if (event.sessionId) {
    sessionOfRequest.set(params.requestId, event.sessionId);
    if (sessionOfRequest.size > 5000) sessionOfRequest.delete(sessionOfRequest.keys().next().value!);
  }
  const phys = byNetworkId.get(params.requestId);
  if (phys && params.redirectResponse) {
    // A redirect ends this admission: the operation finishes with it, and
    // the next hop stops in Fetch again as a request of its own that needs
    // its own admission (Astra review of the prototype, finding 10).
    observe("redirect", { op: phys.op.id, status: params.redirectResponse.status, to: params.request.url.split("?")[0] });
    const op = phys.op;
    if (phys.role === "main" && !op.done) {
      phys.done = true;
      // A Hub request never follows a redirect (XMLHttpRequest would): the
      // next hop is refused when it pauses.
      if (op.kind === "hub") {
        refusedHops.add(params.requestId);
        if (refusedHops.size > 1000) refusedHops.delete(refusedHops.values().next().value!);
      }
      const headers = engineHeaders(params.redirectResponse.headers);
      finishOp(op, { outcome: "response", status: params.redirectResponse.status, headers, location: headers?.location ?? null, redirect: true, sends: phys.sends, sendMono: op.sendMono });
    }
  }
});

cdp.on("Network.responseReceivedExtraInfo", (event) => {
  const params = event.params as { requestId: string; statusCode: number };
  const phys = byNetworkId.get(params.requestId);
  if (phys && phys.role === "main") phys.op.wireStatus = params.statusCode;
});

/** A response's headers for the engine: everything but cookies. */
function engineHeaders(headers: Record<string, string> | undefined): Record<string, string> | null {
  if (!headers) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^set-cookie2?$/i.test(name)) out[name.toLowerCase()] = value;
  }
  return out;
}

/** Where the answer came from (plan §4.2 step 8). */
function sourceOf(op: Operation): string {
  if (op.fromServiceWorker) return "service_worker";
  if (op.wireStatus === 304) return "revalidated_304";
  if (op.fromCache) return "cache_unconfirmed";
  return "network";
}

cdp.on("Network.responseReceived", (event) => {
  const params = event.params as {
    requestId: string;
    response: { status: number; timing?: { requestTime: number; sendStart: number }; fromDiskCache?: boolean; fromServiceWorker?: boolean };
  };
  const phys = byNetworkId.get(params.requestId);
  if (!phys) return;
  const op = phys.op;
  const timing = params.response.timing;
  const sendMono = timing && timing.sendStart >= 0 ? timing.requestTime * 1000 + timing.sendStart : null;
  if (process.env.PB_DEBUG_NET === "1") observe("timing", { op: op.id, role: phys.role, timing, reused: (params.response as Record<string, unknown>).connectionReused, connectionId: (params.response as Record<string, unknown>).connectionId });
  if (phys.role === "preflight") {
    op.preflightSendMono = sendMono;
  } else {
    op.sendMono = sendMono;
    op.status = params.response.status;
    op.headers = engineHeaders((params.response as { headers?: Record<string, string> }).headers);
    op.fromCache = params.response.fromDiskCache === true;
    op.fromServiceWorker = params.response.fromServiceWorker === true;
    op.sessionId = event.sessionId ?? null;
  }
  const wid = windowId(phys);
  if (wid) egress.gate.responding(wid);
});

cdp.on("Network.loadingFinished", (event) => {
  const params = event.params as { requestId: string; encodedDataLength: number };
  const phys = byNetworkId.get(params.requestId);
  if (!phys || phys.done) return;
  phys.done = true;
  const op = phys.op;
  const wid = windowId(phys);
  if (wid) egress.gate.close(wid);
  if (phys.role === "preflight") {
    // The request itself comes next (unless it is already out).
    if (!op.main) op.mainTimer = setTimeout(() => finishOp(op, { outcome: "transport_error", sent: false, error: "the request did not follow its preflight" }), 5000);
    return;
  }
  finishWithBody(op, phys, "finished", params.encodedDataLength, {
    outcome: "response",
    status: op.status,
    headers: op.headers,
    sends: phys.sends,
    sendMono: op.sendMono,
    fromCache: op.fromCache,
    fromServiceWorker: op.fromServiceWorker,
    encodedBytes: params.encodedDataLength,
    sessionId: event.sessionId ?? null,
    source: sourceOf(op),
    wireStatus: op.wireStatus,
  });
});

cdp.on("Network.loadingFailed", (event) => {
  const params = event.params as { requestId: string; errorText: string; canceled?: boolean; blockedReason?: string; corsErrorStatus?: unknown };
  const phys = byNetworkId.get(params.requestId);
  if (!phys || phys.done) return;
  phys.done = true;
  const op = phys.op;
  if (op.kind === "site" && phys.role === "main" && op.status !== null && params.canceled === true) {
    // The site read the body as a stream (or dropped it): Chrome reports the
    // end as "canceled" although the response arrived. For the engine the
    // request was answered; whether the body is whole is judged by its
    // length or shape, not by this event.
    finishWithBody(op, phys, "canceled", null, {
      outcome: "response",
      status: op.status,
      headers: op.headers,
      sends: phys.sends,
      sendMono: op.sendMono,
      fromCache: op.fromCache,
      fromServiceWorker: op.fromServiceWorker,
      bodyEnd: "canceled",
      sessionId: event.sessionId ?? null,
      source: sourceOf(op),
      wireStatus: op.wireStatus,
    });
    return;
  }
  sealBody(phys, "failed", null);
  phys.capture = null;
  finishOp(op, {
    outcome: "transport_error",
    // Chrome reported the request's headers as sent at least once → its
    // outcome on the server's side is unknown; otherwise nothing of it left.
    sent: phys.role === "main" && phys.sends > 0,
    failedAt: phys.role,
    errorText: params.errorText,
    canceled: params.canceled ?? false,
    blockedReason: params.blockedReason ?? null,
    corsErrorStatus: params.corsErrorStatus ?? null,
    sends: phys.sends,
  });
});

// ── the site's socket: frames from CDP (plan §4.4) ──────────────────────────
//
// PROTOTYPE: frames are numbered and passed to the engine as they come; the
// durable buffer on disk is stage 3 (PR 11).

let wsSeq = 0;
const wsUrls = new Map<string, string>();

function wsEvent(kind: string, event: CdpEvent, fields: Record<string, unknown>): void {
  const info = event.sessionId ? targets.get(event.sessionId) : undefined;
  rpc.send({ type: "wsEvent", seq: ++wsSeq, kind, target: info?.type ?? null, mono: monoMs(), ...fields });
}

cdp.on("Network.webSocketCreated", (event) => {
  const params = event.params as { requestId: string; url: string };
  wsUrls.set(params.requestId, params.url);
  wsEvent("created", event, { connId: params.requestId, url: params.url });
});

cdp.on("Network.webSocketHandshakeResponseReceived", (event) => {
  const params = event.params as { requestId: string; response: { status: number } };
  wsEvent("open", event, { connId: params.requestId, url: wsUrls.get(params.requestId) ?? null, status: params.response.status });
});

cdp.on("Network.webSocketFrameReceived", (event) => {
  const params = event.params as { requestId: string; response: { opcode: number; payloadData: string } };
  wsEvent("in", event, { connId: params.requestId, opcode: params.response.opcode, data: params.response.payloadData });
});

cdp.on("Network.webSocketFrameSent", (event) => {
  const params = event.params as { requestId: string; response: { opcode: number; payloadData: string } };
  // The journal of outgoing socket messages (plan §4.11) keeps the shape,
  // not the content: an auth frame carries the token.
  wsEvent("out", event, { connId: params.requestId, opcode: params.response.opcode, len: params.response.payloadData.length });
});

cdp.on("Network.webSocketFrameError", (event) => {
  const params = event.params as { requestId: string; errorMessage: string };
  wsEvent("error", event, { connId: params.requestId, error: params.errorMessage });
});

cdp.on("Network.webSocketClosed", (event) => {
  const params = event.params as { requestId: string };
  wsEvent("close", event, { connId: params.requestId });
  wsUrls.delete(params.requestId);
});

// ── response bodies ───────────────────────────────────────────────────────

interface ResponseStage {
  requestId: string;
  networkId?: string;
  responseStatusCode?: number;
  responseStatusText?: string;
  responseErrorReason?: string;
  responseHeaders?: Array<{ name: string; value: string }>;
}

function headerOf(headers: Array<{ name: string; value: string }> | undefined, name: string): string | null {
  const found = headers?.find((header) => header.name.toLowerCase() === name);
  return found ? found.value : null;
}

/** The response of a released request stopped at its headers. */
async function onResponseStage(event: CdpEvent, params: ResponseStage): Promise<void> {
  const phys = params.networkId ? byNetworkId.get(params.networkId) : undefined;
  const release = () =>
    cdp
      .send("Fetch.continueResponse", { requestId: params.requestId }, event.sessionId)
      .catch((error: Error) => log("fetch.response_failed", { error: error.message }))
      .finally(() => cdp.ack(event.seq));
  if (!phys || phys.done || params.responseStatusCode === undefined) {
    await release();
    return;
  }
  const op = phys.op;
  // The response is here: no repeat of the request can follow.
  const wid = windowId(phys);
  if (wid) egress.gate.responding(wid);
  if (phys.role === "preflight") {
    // Its status goes with the operation: a 429 to the preflight is a 429
    // (Astra review 2, G).
    op.preflightStatus = params.responseStatusCode;
    // Chrome 155 pauses a preflight in Fetch as a request with the same
    // request id as the request it guards. Its client in the network
    // service is done at the headers and drops the loader; the browser
    // removes the interception job only when it notices that, while the
    // request itself may already be asking for a job under the same id —
    // "DevTools: Duplicate request ID", and the browser kills the network
    // service (stand finding, 4 crash dumps). Handing the server's own
    // answer on with fulfillRequest ends the job at once, before the client
    // sees it, so the request cannot meet it.
    await cdp
      .send(
        "Fetch.fulfillRequest",
        {
          requestId: params.requestId,
          responseCode: params.responseStatusCode,
          responseHeaders: params.responseHeaders ?? [],
          ...(params.responseStatusText ? { responsePhrase: params.responseStatusText } : {}),
          body: "",
        },
        event.sessionId,
      )
      .catch((error: Error) => {
        log("fetch.preflight_fulfill_failed", { error: error.message });
        return cdp.send("Fetch.continueResponse", { requestId: params.requestId }, event.sessionId).catch(() => undefined);
      })
      .finally(() => cdp.ack(event.seq));
    return;
  }
  const declared = headerOf(params.responseHeaders, "content-length");
  const contentLength = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
  if (op.kind === "hub" && contentLength !== null && contentLength > CFG.hubBodyLimit) {
    // Over the limit by its own word: cancelled before the body (plan §4.2).
    observe("body.over_limit", { op: op.id, contentLength });
    await cdp.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "Aborted" }, event.sessionId).catch(() => undefined);
    cdp.ack(event.seq);
    op.status = params.responseStatusCode;
    finishOp(op, { outcome: "response", status: op.status, bodyOverflow: true, contentLength, sends: phys.sends, sendMono: op.sendMono });
    return;
  }
  const sessionId = params.networkId ? sessionOfRequest.get(params.networkId) : undefined;
  if (sessionId && params.networkId) {
    let created: Capture | null = null;
    try {
      mkdirSync(CFG.bodiesDir, { recursive: true });
      const file = `${CFG.bodiesDir}/${Date.now()}-${params.networkId.replace(/[^A-Za-z0-9.]/g, "_")}.bin`;
      const capture: Capture = {
        file,
        stream: createWriteStream(file),
        hash: createHash("sha256"),
        decoded: 0,
        encoded: 0,
        chunks: 0,
        broken: false,
        contentLength,
        contentEncoding: headerOf(params.responseHeaders, "content-encoding"),
        armedMono: monoMs(),
        writeError: null,
        flushed: null,
      };
      capture.stream.on("error", (error: Error) => {
        capture.writeError = error.message;
        capture.broken = true;
      });
      created = capture;
      const armed = await cdp.send<{ bufferedData?: string }>("Network.streamResourceContent", { requestId: params.networkId }, sessionId);
      phys.capture = capture;
      if (armed.bufferedData) appendBody(capture, Buffer.from(armed.bufferedData, "base64"), null, 0);
    } catch (error) {
      observe("body.arm_failed", { op: op.id, error: (error as Error).message });
      // A file opened for nothing goes again.
      if (created !== null && phys.capture !== created) {
        created.stream.destroy();
        rmSync(created.file, { force: true });
      }
    }
  } else {
    observe("body.arm_failed", { op: op.id, error: "no session for the request" });
  }
  await release();
}

function appendBody(capture: Capture, data: Buffer, announced: number | null, encoded: number): void {
  if (announced !== null && data.length !== announced) capture.broken = true;
  capture.stream.write(data);
  capture.hash.update(data);
  capture.decoded += data.length;
  capture.encoded += encoded;
  capture.chunks += 1;
}

/** Stand: handle body chunks this much later (a slow operator). */
let testDataDelayMs = 0;

function onBodyData(params: { requestId: string; dataLength: number; encodedDataLength: number; data?: string }): void {
  const phys = byNetworkId.get(params.requestId);
  if (!phys?.capture) return;
  if (params.data === undefined) {
    // Data passed before the stream was armed or without it: a hole.
    if (params.dataLength > 0) phys.capture.broken = true;
    return;
  }
  appendBody(phys.capture, Buffer.from(params.data, "base64"), params.dataLength, params.encodedDataLength);
  const op = phys.op;
  if (op.kind === "hub" && phys.capture.decoded > CFG.hubBodyLimit && !op.done) {
    // No declared size (chunked, compressed): the limit holds while it comes.
    observe("body.over_limit", { op: op.id, received: phys.capture.decoded });
    const attempt = hub.get(op.id);
    if (attempt && sitePage && attempt.worldId !== null) {
      cdp.post(
        "Runtime.callFunctionOn",
        { functionDeclaration: "function (id) { const e = globalThis.__pbLive && globalThis.__pbLive.get(id); if (e) e.controller.abort(); return !!e; }", executionContextId: attempt.worldId, arguments: [{ value: op.id }], returnByValue: true },
        sitePage.sessionId,
      );
    }
    finishWithBody(op, phys, "limit", null, { outcome: "response", status: op.status, headers: op.headers, bodyOverflow: true, sends: phys.sends, sendMono: op.sendMono });
  }
}

cdp.on("Network.dataReceived", (event) => {
  const params = event.params as { requestId: string; dataLength: number; encodedDataLength: number; data?: string };
  if (testDataDelayMs > 0) setTimeout(() => onBodyData(params), testDataDelayMs);
  else onBodyData(params);
});

/** What was captured, for the outcome. `how` says why it counts as whole:
 *  the load finished; or it ended as a cancel (a body read as a stream does,
 *  see FINDINGS) and the transfer's length matches content-length. */
function sealBody(phys: Physical, ended: "finished" | "canceled" | "failed" | "limit", totalEncoded: number | null): Record<string, unknown> | null {
  const capture = phys.capture;
  if (!capture) return null;
  capture.flushed = new Promise<void>((resolve) => {
    capture.stream.once("error", () => resolve());
    capture.stream.end(() => resolve());
  });
  const encoded = totalEncoded ?? capture.encoded;
  let complete = false;
  let how = "incomplete";
  if (!capture.broken) {
    if (ended === "finished") {
      complete = true;
      how = "load finished";
    } else if (ended === "canceled") {
      // A body the page read as a stream ends as a cancel even when whole.
      // The per-chunk transfer lengths do not add up to the transfer's size
      // then (stand), so only an uncompressed body with a declared length
      // can be checked by length; the rest is checked by its shape (JSON).
      const identity = capture.contentEncoding === null || capture.contentEncoding === "identity";
      if (identity && capture.contentLength !== null) {
        complete = capture.decoded === capture.contentLength;
        how = complete ? "content-length matched" : "shorter than content-length";
      } else {
        how = "shape check needed";
      }
    }
  } else {
    how = "a chunk was missing or short";
  }
  return {
    file: capture.file,
    bytes: capture.decoded,
    encodedBytes: encoded,
    chunks: capture.chunks,
    sha256: capture.hash.digest("hex"),
    contentLength: capture.contentLength,
    contentEncoding: capture.contentEncoding,
    complete,
    how,
    ended,
  };
}

/** Finish an operation once its body file is closed: the result says the
 *  body is whole only if the file holds it (Astra review of the prototype,
 *  finding 11). */
function finishWithBody(op: Operation, phys: Physical, ended: "finished" | "canceled" | "failed" | "limit", totalEncoded: number | null, outcome: Record<string, unknown>): void {
  const capture = phys.capture;
  const body = sealBody(phys, ended, totalEncoded);
  phys.capture = null;
  if (!capture?.flushed || !body) {
    finishOp(op, { ...outcome, body });
    return;
  }
  void capture.flushed.then(() => {
    if (capture.writeError !== null) {
      body.complete = false;
      body.how = `the file was not written: ${capture.writeError}`;
    }
    finishOp(op, { ...outcome, body });
  });
}

// ── Fetch: every request of every context stops here ─────────────────────

interface PausedParams {
  requestId: string;
  /** Set when the request is the next hop of a redirect. */
  redirectedRequestId?: string;
  request: {
    url: string;
    urlFragment?: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    hasPostData?: boolean;
    postDataEntries?: Array<{ bytes?: string }>;
  };
  frameId?: string;
  resourceType: string;
  networkId?: string;
}

function resolvePaused(event: CdpEvent, action: "continue" | "fail", params: Record<string, unknown>): Promise<void> {
  const method = action === "continue" ? "Fetch.continueRequest" : "Fetch.failRequest";
  return cdp
    .send(method, params, event.sessionId)
    .then(() => undefined)
    .catch((error: Error) => log("fetch.resolve_failed", { method, error: error.message }))
    .finally(() => cdp.ack(event.seq));
}

cdp.on("Fetch.requestPaused", (event) => {
  const params = event.params as unknown as PausedParams;
  const requestId = params.requestId;
  const stage = event.params as unknown as ResponseStage;
  if (stage.responseStatusCode !== undefined || stage.responseErrorReason !== undefined) {
    if (event.seq <= replayUpTo) {
      void resolvePaused(event, "fail", { requestId, errorReason: "Aborted" });
      return;
    }
    void onResponseStage(event, stage);
    return;
  }
  if (process.env.PB_DEBUG_FETCH === "1") log("fetch.paused", { method: params.request.method, url: params.request.url.split("?")[0], frag: params.request.urlFragment ?? null, networkId: params.networkId ?? null, type: params.resourceType });
  if (event.seq <= replayUpTo) {
    // Paused under a previous operator instance: its admission (if any) is
    // gone with that instance. Never released — failed.
    observe("paused.replayed_failed", { url: params.request.url });
    void resolvePaused(event, "fail", { requestId, errorReason: "Aborted" });
    return;
  }
  let url: URL;
  try {
    url = new URL(params.request.url);
  } catch {
    void resolvePaused(event, "fail", { requestId, errorReason: "BlockedByClient" });
    return;
  }
  const fragment = params.request.urlFragment ?? url.hash;
  if (params.redirectedRequestId !== undefined || (params.networkId && refusedHops.has(params.networkId))) {
    // A redirect's next hop. A Hub request never follows one; a site's hop
    // is a new request with an admission of its own — not the old one
    // (Astra review 2, B: Fetch may pause the hop before the Network events
    // of the redirect arrive on the page's session).
    if (params.redirectedRequestId !== undefined && !(params.networkId && refusedHops.has(params.networkId)) && !(fragment.startsWith("#hub-") || url.hostname.endsWith(PLACEHOLDER_SUFFIX))) {
      const cls = classify(url.hostname);
      if (cls === "api") return onSitePaused(event, params, true);
      if (cls === "site" || cls === "cdn") {
        void resolvePaused(event, "continue", { requestId });
        return;
      }
    }
    observe("hub.redirect_hop_refused", { url: params.request.url.split("?")[0] });
    void resolvePaused(event, "fail", { requestId, errorReason: "BlockedByClient" });
    return;
  }
  if (fragment.startsWith("#pb-selftest-") && onSelftestPaused(event, params, fragment)) return;
  if (fragment.startsWith("#hub-") || url.hostname.endsWith(PLACEHOLDER_SUFFIX)) return onHubPaused(event, params, fragment.slice(5));
  const cls = classify(url.hostname);
  observe("paused", { url: params.request.url, method: params.request.method, cls, resourceType: params.resourceType, networkId: params.networkId ?? null });
  if (cls === "site" || cls === "cdn") {
    void resolvePaused(event, "continue", { requestId });
    return;
  }
  if (cls === "api") return onSitePaused(event, params);
  if (cls === "ws" && !CFG.refuseWsHostRequests) {
    void resolvePaused(event, "continue", { requestId });
    return;
  }
  // The socket host serves sockets only: any other request to it could open
  // an HTTP/2 session a later socket would ride without its own tunnel.
  void resolvePaused(event, "fail", { requestId, errorReason: "BlockedByClient" });
});

// ── the site's session, for Hub requests (plan §4.7) ──────────────────────
//
// Taken from the site's own API requests as they pause in Fetch and kept in
// memory only: never logged, never written. A Hub request gets the headers
// the site's script set on its last API request, in their order (Angular's
// interceptors: accept, authorization, fansly-client-id, -ts, -session-id,
// -check), with the time and the check of its own path.

/** Headers Chrome sets itself: not the site's, not copied. */
const BROWSER_HEADERS = new Set(["user-agent", "referer", "origin", "accept-encoding", "accept-language", "host", "connection", "cookie", "content-length", "priority", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user", "sec-fetch-storage-access", "upgrade-insecure-requests"]);

const siteSession = {
  /** The site's script-set headers of its last API GET, in order. */
  template: null as Array<[string, string]> | null,
  /** fansly-client-check computed with our key matched the site's own. */
  checkOk: null as boolean | null,
  checkAlarmed: false,
};

/** The site's cached client time: now ± 5 s, never going back, refreshed
 *  every 3 s (Fansly's bundle). */
let fanslyClientTs = Date.now() + (5000 - Math.floor(10_000 * Math.random()));
setInterval(() => {
  const next = Date.now() + (5000 - Math.floor(10_000 * Math.random()));
  if (next > fanslyClientTs) fanslyClientTs = next;
}, 3000).unref();

/** cyrb53, as Fansly's bundle computes fansly-client-check. */
function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function fanslyClientCheck(pathname: string, deviceId: string): string {
  return cyrb53(`${CFG.fanslyCheckKey}_${pathname}_${deviceId}`).toString(16);
}

function noteSiteSession(request: PausedParams["request"]): void {
  if (request.method.toUpperCase() !== "GET") return;
  const template: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(request.headers)) {
    if (!BROWSER_HEADERS.has(name.toLowerCase())) template.push([name, value]);
  }
  if (!template.some(([name]) => name.toLowerCase() === "authorization")) return;
  siteSession.template = template;
  const check = template.find(([name]) => name.toLowerCase() === "fansly-client-check")?.[1];
  const deviceId = template.find(([name]) => name.toLowerCase() === "fansly-client-id")?.[1];
  if (check !== undefined && deviceId !== undefined) {
    let pathname = "";
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return;
    }
    siteSession.checkOk = fanslyClientCheck(pathname, deviceId) === check;
    if (!siteSession.checkOk && !siteSession.checkAlarmed) {
      // The site's algorithm or key changed: Hub requests would differ from
      // the site's — the transport is not ready (plan §4.7).
      siteSession.checkAlarmed = true;
      log("session.check_mismatch", {});
      rpc.send({ type: "alarm", kind: "client_check_mismatch", detail: {} });
    }
  }
}

/** The headers of a Hub request: the site's template, its time and check
 *  for this path, then the engine's own; or why there are none. */
function sessionHeaders(pathname: string, extra: Record<string, string>): Array<[string, string]> | string {
  const template = siteSession.template;
  if (template === null) return "no session seen yet: the site made no API request with authorization";
  if (siteSession.checkOk === false) return "fansly-client-check of the site differs from ours: transport not ready";
  const deviceId = template.find(([name]) => name.toLowerCase() === "fansly-client-id")?.[1] ?? "";
  const out: Array<[string, string]> = [];
  for (const [name, value] of template) {
    const lower = name.toLowerCase();
    if (lower === "fansly-client-ts") out.push([name, String(fanslyClientTs)]);
    else if (lower === "fansly-client-check") out.push([name, fanslyClientCheck(pathname, deviceId)]);
    else out.push([name, value]);
  }
  for (const [name, value] of Object.entries(extra)) if (!out.some(([have]) => have.toLowerCase() === name.toLowerCase())) out.push([name, value]);
  return out;
}

// ── site requests: admitted by the engine (plan §4.3) ─────────────────────

interface PendingSite {
  event: CdpEvent;
  params: PausedParams;
  op: Operation;
  role: Physical["role"];
  timer: NodeJS.Timeout;
}
const pendingSite = new Map<string, PendingSite>();

function onSitePaused(event: CdpEvent, params: PausedParams, hop = false): void {
  if (testSiteBypass) {
    void resolvePaused(event, "continue", { requestId: params.requestId });
    return;
  }
  const preflight = isPreflight(params);
  const method = preflight ? preflightMethod(params) : params.request.method;
  const key = opKey(params.request.url, method);
  if (!preflight && !hop) noteSiteSession(params.request);
  // A redirect's hop asks for an admission of its own.
  if (!preflight && !hop) {
    // The request of an operation whose preflight was admitted and passed.
    const op = awaitingMain.get(key);
    if (op && !op.done) {
      awaitingMain.delete(key);
      if (op.mainTimer) clearTimeout(op.mainTimer);
      if (op.deadline !== null && op.deadline > monoMs() && egress.exitOpen) {
        releasePhysical(op, event, params, "main");
      } else {
        void resolvePaused(event, "fail", { requestId: params.requestId, errorReason: "Failed" });
        finishOp(op, { outcome: "aborted_before_send", reason: "admission expired between preflight and request" });
      }
      return;
    }
  }
  const id = params.requestId;
  const op = newOperation("site", id, key, (outcome) => rpc.send({ type: "siteDone", siteRequestId: id, ...outcome }));
  const timer = setTimeout(() => {
    if (!pendingSite.delete(id)) return;
    observe("site.admit_timeout", { req: id });
    void resolvePaused(event, "fail", { requestId: id, errorReason: "Failed" });
  }, CFG.siteAdmitWaitMs);
  pendingSite.set(id, { event, params, op, role: preflight ? "preflight" : "main", timer });
  askSiteAdmit(id, params, method);
}

function askSiteAdmit(id: string, params: PausedParams, method: string): void {
  rpc.send({ type: "siteAdmit", siteRequestId: id, method, url: params.request.url, resourceType: params.resourceType, preflight: isPreflight(params) });
}

function onSiteAdmitResult(message: EngineMessage): void {
  const id = message.siteRequestId as string;
  const pending = pendingSite.get(id);
  if (!pending) return;
  pendingSite.delete(id);
  clearTimeout(pending.timer);
  const deadline = Number(message.deadlineMono);
  if (message.ok !== true || !(deadline > monoMs()) || !egress.exitOpen) {
    observe("site.refused", { req: id, reason: message.reason ?? (message.ok ? "expired" : "refused") });
    void resolvePaused(pending.event, "fail", { requestId: id, errorReason: "Failed" });
    return;
  }
  const op = pending.op;
  op.admissionId = `site:${id}`;
  op.deadline = deadline;
  startLimit(op);
  releasePhysical(op, pending.event, pending.params, pending.role, testSiteUrlSame ? { url: pending.params.request.url } : {});
}

// ── Hub requests (plan §4.2) ──────────────────────────────────────────────

interface HubAttempt {
  attemptId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  op: Operation | null;
  waiting: { event: CdpEvent; params: PausedParams; role: Physical["role"] } | null;
  pausedTimer: NodeJS.Timeout | null;
  abortTimer: NodeJS.Timeout | null;
  worldId: number | null;
  done: boolean;
}
const hub = new Map<string, HubAttempt>();

function hubResult(attempt: HubAttempt, outcome: Record<string, unknown>): void {
  if (attempt.done) return;
  attempt.done = true;
  if (sitePage && attempt.worldId !== null && cdp.cdpUp) {
    cdp.post("Runtime.callFunctionOn", { functionDeclaration: HUB_RELEASE, executionContextId: attempt.worldId, arguments: [{ value: attempt.attemptId }], returnByValue: true }, sitePage.sessionId);
  }
  if (attempt.pausedTimer) clearTimeout(attempt.pausedTimer);
  if (attempt.abortTimer) clearTimeout(attempt.abortTimer);
  if (attempt.op && !attempt.op.done) {
    attempt.op.done = true;
    if (attempt.op.limitTimer) clearTimeout(attempt.op.limitTimer);
    if (attempt.op.mainTimer) clearTimeout(attempt.op.mainTimer);
    for (const phys of [attempt.op.preflight, attempt.op.main]) {
      const wid = phys ? windowId(phys) : null;
      if (wid) egress.gate.close(wid);
    }
  }
  rpc.send({ type: "result", attemptId: attempt.attemptId, ...outcome });
}

async function isolatedWorld(page: TargetInfo): Promise<number> {
  if (page.worldId !== undefined) return page.worldId;
  if (!page.mainFrameId) {
    const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, page.sessionId);
    page.mainFrameId = tree.frameTree.frame.id;
  }
  const world = await cdp.send<{ executionContextId: number }>(
    "Page.createIsolatedWorld",
    { frameId: page.mainFrameId, worldName: "pb", grantUniveralAccess: false },
    page.sessionId,
  );
  page.worldId = world.executionContextId;
  return page.worldId;
}

// The fetch of a Hub request, in the isolated world. The body is consumed
// with arrayBuffer(), not with a stream reader: Chrome 155 ends a fetch whose
// body JS reads as a stream (getReader, for-await, pipeTo) with
// Network.loadingFailed (ERR_ABORTED, canceled) even after the whole body was
// read, when the body was still arriving during the read; and it sends no end
// event at all while a body is not consumed (stand findings). The operator
// reads the response from CDP; the buffer here is dropped at once.
// Headers come as [name, value] pairs: their order is the site's.
const HUB_FETCH = `function (id, url, method, headers, transport) {
  const g = globalThis;
  const live = g.__pbLive || (g.__pbLive = new Map());
  if (transport === "xhr") {
    const x = new XMLHttpRequest();
    const entry = { controller: { abort: () => x.abort() }, request: x };
    live.set(id, entry);
    x.open(method, url, true);
    x.withCredentials = true;
    x.responseType = "arraybuffer";
    for (let i = 0; i < headers.length; i++) x.setRequestHeader(headers[i][0], headers[i][1]);
    x.send();
    return true;
  }
  const entry = { controller: new AbortController(), promise: null };
  live.set(id, entry);
  entry.promise = fetch(url, { method: method, headers: headers, credentials: "include", mode: "cors", redirect: "manual", signal: entry.controller.signal })
    .then((response) => response.arrayBuffer())
    .then(() => undefined, () => undefined);
  return true;
}`;

/** Lets go of a finished attempt in the isolated world (see HUB_FETCH). */
const HUB_RELEASE = `function (id) { const live = globalThis.__pbLive; return live ? live.delete(id) : false; }`;

async function onHubSend(message: EngineMessage): Promise<void> {
  const attemptId = String(message.attemptId);
  if (hub.has(attemptId)) return; // the same id twice does nothing twice
  const attempt: HubAttempt = {
    attemptId,
    method: String(message.method ?? "GET"),
    url: String(message.url),
    headers: (message.headers as Record<string, string>) ?? {},
    op: null,
    waiting: null,
    pausedTimer: null,
    abortTimer: null,
    worldId: null,
    done: false,
  };
  hub.set(attemptId, attempt);
  if (state !== "ready" || !sitePage) {
    hubResult(attempt, { outcome: "transport_error", sent: false, error: `operator not ready (${state})` });
    return;
  }
  const real = new URL(attempt.url);
  const issued = new URL(attempt.url);
  if (CFG.hubPlaceholderHost) issued.hostname = `${real.hostname}${PLACEHOLDER_SUFFIX}`;
  issued.hash = `hub-${attemptId}`;
  // The session's headers come from the site's own requests (plan §4.7).
  let headers: Array<[string, string]> = Object.entries(attempt.headers);
  if (message.session === true) {
    const built = sessionHeaders(real.pathname, attempt.headers);
    if (typeof built === "string") {
      hubResult(attempt, { outcome: "transport_error", sent: false, error: built });
      return;
    }
    headers = built;
  }
  try {
    attempt.worldId = await isolatedWorld(sitePage);
    attempt.pausedTimer = setTimeout(
      () => hubResult(attempt, { outcome: "transport_error", sent: false, error: "the request never reached the interception" }),
      5000,
    );
    await cdp.send(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: HUB_FETCH,
        executionContextId: attempt.worldId,
        arguments: [{ value: attemptId }, { value: issued.toString() }, { value: attempt.method }, { value: CFG.hubTransport === "xhr" ? headers : Object.fromEntries(headers) }, { value: CFG.hubTransport }],
        returnByValue: true,
      },
      sitePage.sessionId,
    );
  } catch (error) {
    hubResult(attempt, { outcome: "transport_error", sent: false, error: `isolated world: ${(error as Error).message}` });
  }
}

/** The real URL of a physical request of a Hub attempt (the placeholder host
 *  swapped back; the fragment never leaves Chrome anyway). */
/** `url` for Fetch.continueRequest — only when the paused URL is the
 *  placeholder (stand knob: PB_TEST_URL_ALWAYS passes it always). */
function urlOverride(attempt: HubAttempt, pausedUrl: string): Record<string, unknown> {
  const needed = new URL(pausedUrl).hostname.endsWith(PLACEHOLDER_SUFFIX) || testUrlAlways;
  return needed ? { url: realUrl(attempt, pausedUrl) } : {};
}

function realUrl(attempt: HubAttempt, pausedUrl: string): string {
  const paused = new URL(pausedUrl);
  const real = new URL(attempt.url);
  paused.hostname = real.hostname;
  paused.hash = "";
  return paused.toString();
}

function onHubPaused(event: CdpEvent, params: PausedParams, attemptId: string): void {
  const attempt = hub.get(attemptId);
  if (!attempt || attempt.done) {
    void resolvePaused(event, "fail", { requestId: params.requestId, errorReason: "Aborted" });
    return;
  }
  if (attempt.pausedTimer) clearTimeout(attempt.pausedTimer);
  const role: Physical["role"] = isPreflight(params) ? "preflight" : "main";
  if (attempt.op && attempt.op.admissionId) {
    // The request after its admitted preflight: same admission, no new check.
    // One admission covers one request: a second one (a redirect's hop) is
    // refused.
    const op = attempt.op;
    if (op.mainTimer) clearTimeout(op.mainTimer);
    if (role === "main" && op.main === null && op.deadline !== null && op.deadline > monoMs() && egress.exitOpen) {
      releasePhysical(op, event, params, "main", urlOverride(attempt, params.request.url));
    } else {
      void resolvePaused(event, "fail", { requestId: params.requestId, errorReason: "Aborted" });
      hubResult(attempt, { outcome: "aborted_before_send", reason: role === "main" ? "admission expired between preflight and request" : "a second preflight" });
    }
    return;
  }
  attempt.op = newOperation("hub", attemptId, attemptId, (outcome) => hubResult(attempt, outcome));
  attempt.waiting = { event, params, role };
  rpc.send({ type: "check", attemptId });
  attempt.pausedTimer = setTimeout(() => {
    observe("hub.check_timeout", { attemptId });
    void resolvePaused(event, "fail", { requestId: params.requestId, errorReason: "Aborted" });
    hubResult(attempt, { outcome: "aborted_before_send", reason: "no check result" });
  }, 5000);
}

function onCheckResult(message: EngineMessage): void {
  const attempt = hub.get(String(message.attemptId));
  if (!attempt || attempt.done || !attempt.waiting || !attempt.op) return;
  if (attempt.pausedTimer) clearTimeout(attempt.pausedTimer);
  const { event, params, role } = attempt.waiting;
  attempt.waiting = null;
  const deadline = Number(message.deadlineMono);
  if (message.ok !== true || !(deadline > monoMs()) || !egress.exitOpen) {
    void resolvePaused(event, "fail", { requestId: params.requestId, errorReason: "Aborted" });
    hubResult(attempt, { outcome: "aborted_before_send", reason: message.reason ?? "refused" });
    return;
  }
  const op = attempt.op;
  op.admissionId = `hub:${attempt.attemptId}`;
  op.deadline = deadline;
  startLimit(op);
  if (CFG.hubAbortBeforeDeadline) {
    attempt.abortTimer = setTimeout(() => {
      if (op.main?.sends || attempt.done || !sitePage || attempt.worldId === null) return;
      observe("hub.abort_before_deadline", { attemptId: attempt.attemptId });
      // The abort of a fetch still in its preflight has no end event of a
      // request we track: close the attempt ourselves if none comes.
      setTimeout(() => {
        if (!attempt.done && !(op.main?.sends)) finishOp(op, { outcome: "transport_error", sent: false, errorText: "net::ERR_ABORTED", canceled: true, error: "aborted before its deadline", sends: 0 });
      }, 500);
      cdp.post(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: "function (id) { const e = globalThis.__pbLive && globalThis.__pbLive.get(id); if (e) e.controller.abort(); return !!e; }",
          executionContextId: attempt.worldId,
          arguments: [{ value: attempt.attemptId }],
          returnByValue: true,
        },
        sitePage.sessionId,
      );
    }, Math.max(0, deadline - 1000 - monoMs()));
  }
  releasePhysical(op, event, params, role, urlOverride(attempt, params.request.url));
}

// ── self-test with the exit closed (plan §4.1 step 5) ─────────────────────

const selftestWaiters = new Map<string, (outcome: Record<string, unknown>) => void>();

function onSelftestPaused(event: CdpEvent, params: PausedParams, fragment: string): boolean {
  // Only the self-test's own request, while it runs and the exit is closed;
  // the same marker on any other request means nothing (Astra review 2, B).
  const waiter = selftestWaiters.get(fragment);
  if (state !== "selftest" || egress.exitOpen || !waiter) return false;
  if (params.networkId) {
    const op = newOperation("selftest", fragment, fragment, waiter);
    const phys: Physical = { op, role: "main", networkId: params.networkId, sends: 0, done: false, capture: null };
    op.main = phys;
    byNetworkId.set(params.networkId, phys);
  }
  // No admission: the exit is closed, the request has nowhere to go.
  void resolvePaused(event, "continue", { requestId: params.requestId });
  return true;
}

/** Network.loadingFailed of requests that never stop in Fetch (the rules
 *  extension cancels them first): by the self-test's marker in the URL. */
const selftestByRequest = new Map<string, string>();
const selftestFailed = new Map<string, { errorText: string; blockedReason: string | null }>();

cdp.on("Network.requestWillBeSent", (event) => {
  const params = event.params as { requestId: string; request: { url: string } };
  const marker = /[?&]pbst=([\w-]+)/.exec(params.request.url)?.[1];
  if (marker) selftestByRequest.set(params.requestId, marker);
});

cdp.on("Network.loadingFailed", (event) => {
  const params = event.params as { requestId: string; errorText: string; blockedReason?: string };
  const marker = selftestByRequest.get(params.requestId);
  if (!marker) return;
  selftestByRequest.delete(params.requestId);
  selftestFailed.set(marker, { errorText: params.errorText, blockedReason: params.blockedReason ?? null });
});

/** One self-test request from the isolated world; resolves with how it
 *  failed (it must fail: the exit is closed). */
async function selftestRequest(page: TargetInfo, world: number, method: string, path: string, marker: string): Promise<{ errorText: string; blockedReason: string | null; paused: boolean }> {
  const fragment = `#pb-selftest-${marker}`;
  let paused = false;
  const viaFetch = new Promise<Record<string, unknown>>((resolve) => selftestWaiters.set(fragment, (outcome) => {
    paused = true;
    resolve(outcome);
  }));
  const apiHost = CFG.hosts.api[0]!;
  await cdp.send(
    "Runtime.callFunctionOn",
    {
      functionDeclaration: "function (u, m) { fetch(u, { method: m, mode: 'no-cors', body: m === 'GET' ? undefined : '{}' }).catch(() => {}); return true; }",
      executionContextId: world,
      arguments: [{ value: `https://${apiHost}${path}?pbst=${marker}${fragment}` }, { value: method }],
      returnByValue: true,
    },
    page.sessionId,
  );
  const deadline = monoMs() + 4000;
  for (;;) {
    const failed = selftestFailed.get(marker);
    if (failed) {
      selftestFailed.delete(marker);
      selftestWaiters.delete(fragment);
      return { ...failed, paused };
    }
    if (monoMs() > deadline) {
      selftestWaiters.delete(fragment);
      return { errorText: "timeout", blockedReason: null, paused };
    }
    await Promise.race([viaFetch, sleep(20)]);
  }
}

/** Plan §4.1 step 5: every lock is checked on its own, with the exit closed,
 *  and the answer shows which lock stopped the request. */
async function runSelftest(): Promise<Record<string, unknown>> {
  const page = sitePage;
  if (!page) throw new Error("no page target");
  const world = await isolatedWorld(page);
  const run = `${Date.now()}`;
  const results: Record<string, unknown> = {};
  // 1. A permitted request reaches the operator's proxy and is refused there.
  const exitClosed = await selftestRequest(page, world, "GET", "/api/selftest", `${run}-exit`);
  results.exitClosed = exitClosed;
  const exitOk = exitClosed.paused && exitClosed.errorText.includes("TUNNEL_CONNECTION_FAILED");
  // 2-3. The rules extension cancels a "never" request and an unknown write
  // before they reach the interception. On the first start of a profile the
  // policy is still installing the extension: retried for a few seconds.
  let rulesOk = !CFG.selftestRules;
  if (CFG.selftestRules) {
    for (let attempt = 0; attempt < 12 && !rulesOk; attempt++) {
      const never = await selftestRequest(page, world, "POST", CFG.selftestNeverPath, `${run}-never${attempt}`);
      const write = await selftestRequest(page, world, "POST", "/api/v1/pb-selftest-unknown", `${run}-write${attempt}`);
      results.never = never;
      results.unknownWrite = write;
      rulesOk = [never, write].every((r) => !r.paused && r.errorText.includes("BLOCKED_BY_CLIENT"));
      if (!rulesOk) await sleep(700);
    }
  }
  // 4. The kernel lets Chrome's user reach nothing but the proxy.
  const net = await supervisor({ cmd: "netselftest" }).catch((error: Error) => ({ ok: false, error: error.message }));
  results.kernel = net;
  const pass = exitOk && rulesOk && (net as { ok?: boolean }).ok === true;
  return { pass, exitOk, rulesOk, ...results };
}

async function checkExitIp(): Promise<string> {
  const socket = await socksConnect(CFG.socks, CFG.ipCheckHost, 443);
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername: CFG.ipCheckHost });
    let body = "";
    tls.on("secureConnect", () => tls.write(`GET / HTTP/1.1\r\nHost: ${CFG.ipCheckHost}\r\nConnection: close\r\n\r\n`));
    tls.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    tls.on("end", () => resolve(body.split("\r\n\r\n")[1]?.trim() ?? ""));
    tls.on("error", reject);
    socket.resume();
    setTimeout(() => reject(new Error("ip check timeout")), 15_000);
  });
}

// ── startup (plan §4.1) ───────────────────────────────────────────────────

async function start(): Promise<void> {
  notHalted();
  egress.closeExit("startup");
  setState("chrome_starting");
  const status = await supervisor({ cmd: "chrome.status" });
  notHalted();
  if (!status.running) await supervisor({ cmd: "chrome.start", env: { TZ: CFG.env.timeZone, LANG_TAG: CFG.env.language } });
  // Wait until the holder holds the DevTools connection.
  for (let i = 0; i < 300 && !cdp.cdpUp; i++) await sleep(100);
  if (!cdp.cdpUp) throw new Error("no CDP connection");
  setState("attaching");
  if (GEO) {
    // The site may read the position without a prompt nobody would answer.
    await cdp.send("Browser.grantPermissions", { permissions: ["geolocation"], origin: new URL(CFG.siteUrl).origin });
  }
  if (CFG.fetchScope === "browser") await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  for (let i = 0; i < 50 && !sitePage; i++) await sleep(100);
  if (!sitePage) throw new Error("no page target attached");
  // The tab Chrome started with got its network loaders before the
  // interception existed: those are not intercepted (stand finding). Work in
  // a tab opened after Fetch.enable, close the first one.
  const first = sitePage;
  const created = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  for (let i = 0; i < 50 && ![...targets.values()].some((t) => t.targetId === created.targetId); i++) await sleep(100);
  const page = [...targets.values()].find((t) => t.targetId === created.targetId);
  if (!page) throw new Error("the new tab was not attached");
  sitePage = page;
  await page.setup;
  if (first.targetId !== page.targetId) cdp.post("Target.closeTarget", { targetId: first.targetId });
  setState("selftest");
  selftest = await runSelftest();
  log("selftest", selftest);
  if (selftest.pass !== true) throw new Error("self-test failed");
  setState("ip_check");
  const ip = await checkExitIp();
  if (ip !== CFG.pinnedIp) throw new Error(`exit IP ${ip} is not the pinned ${CFG.pinnedIp}`);
  notHalted();
  egress.openExit();
  setState("site_loading");
  await cdp.send("Page.navigate", { url: CFG.siteUrl }, sitePage.sessionId);
  networkServicePid = null;
  probeMisses = 0;
  setState("ready");
}

async function startLoop(): Promise<void> {
  const ladder = [10_000, 30_000, 120_000, 300_000];
  for (let attempt = 0; halted === null; attempt++) {
    try {
      await start();
      return;
    } catch (error) {
      egress.closeExit("startup failed");
      // A halt during the start stays: no retry (Astra review 2, D).
      if (halted !== null) break;
      setState("failed", (error as Error).message);
      const wait = ladder[Math.min(attempt, ladder.length - 1)]!;
      log("start.failed", { error: (error as Error).message, retryInMs: wait });
      await sleep(Number(process.env.PB_FAST_RETRY) > 0 ? 2000 : wait);
    }
  }
  if (halted !== null) setState("failed", `halted: ${halted}`);
}

/** Every step of the start checks the halt latch: only the engine's
 *  `restart` clears it. */
function notHalted(): void {
  if (halted !== null) throw new Error(`halted: ${halted}`);
}

/** Control is lost (the holder died or Chrome closed the DevTools
 *  connection): Chrome has released every held request. Close the exit at
 *  once, kill Chrome, start over (plan §4.1, §4.9). */
let lossReactionDelayMs = Number(process.env.PB_TEST_LOSS_DELAY_MS ?? "0");
/** Stand: pass `url` to Fetch.continueRequest even when it is unchanged. */
let testUrlAlways = false;
/** Stand: pass the same `url` for site requests too. */
let testSiteUrlSame = false;
/** Stand: a broken operator — every API request of the site is released at
 *  once, unasked (what the rules extension must still stop). */
let testSiteBypass = false;

/** The command failed because its target or CDP itself is gone: nothing of
 *  that target runs any more. */
function targetGone(error: Error): boolean {
  return restarting || !cdp.cdpUp || /session with given id not found|target closed|no target with given id|holder link down|cdp (closed|down)/i.test(error.message);
}

/** A check that must hold did not (the socket guard or the interception of
 *  a target is not in place): the exit closes, Chrome goes, and the page
 *  stays stopped until the engine restarts it — the same failure would come
 *  back with every automatic restart. */
/** The latch survives a restart of the operator (and of the container): a
 *  stopped page stays stopped until the engine's `restart`. */
const HALT_FILE = envStr("PB_HALT_FILE", "/data/buffer/halted");
let halted: string | null = existsSync(HALT_FILE) ? readFileSync(HALT_FILE, "utf8").trim() || "halted before a restart" : null;
if (halted !== null) egress.latch(halted);

function halt(reason: string): void {
  if (halted !== null) return;
  halted = reason;
  try {
    writeFileSync(HALT_FILE, `${reason}\n`);
  } catch (error) {
    log("halt.file_failed", { error: (error as Error).message });
  }
  egress.latch(reason);
  log("halted", { reason });
  rpc.send({ type: "alarm", kind: "halted", detail: { reason } });
  setState("failed", `halted: ${reason}`);
  void supervisor({ cmd: "chrome.kill", reason: `halted: ${reason}` }).catch(() => undefined);
}

async function controlLost(reason: string): Promise<void> {
  // Stand only: react late, so what Chrome releases meets the open exit and
  // only the gate stands in its way.
  // A window still open at the loss may have carried a request Chrome
  // released without us instead of the admitted one (the gate cannot tell
  // two requests apart inside TLS; Astra review of the prototype, finding 4):
  // at most the window's budget of one request the rules extension allows —
  // the fallback rule of owner decision №10. The alarm says so.
  const gateAtLoss = egress.gate.state;
  if (lossReactionDelayMs > 0) await sleep(lossReactionDelayMs);
  egress.closeExit(`control lost: ${reason}`);
  rpc.send({ type: "alarm", kind: "cdp_lost", detail: { reason, windowOpen: gateAtLoss.phase === "open", window: gateAtLoss.window } });
  if (restarting) return;
  restarting = true;
  setState("failed", `control lost: ${reason}`);
  targets.clear();
  sitePage = null;
  for (const op of [...liveOps]) {
    finishOp(op, { outcome: "transport_error", sent: (op.main?.sends ?? 0) > 0 || op.main !== null, error: `control lost: ${reason}` });
  }
  byNetworkId.clear();
  awaitingMain.clear();
  for (const [, pending] of pendingSite) clearTimeout(pending.timer);
  pendingSite.clear();
  for (const [, attempt] of hub) if (!attempt.done) hubResult(attempt, { outcome: "transport_error", sent: true, error: `control lost: ${reason}` });
  await supervisor({ cmd: "chrome.kill", reason }).catch(() => undefined);
  await sleep(1000);
  const linked = await cdp.connect(CFG.holderSock);
  // Nothing the new holder replays belongs to a live admission.
  replayUpTo = linked.lastSeq;
  log("holder.relinked", linked);
  restarting = false;
  if (halted !== null) {
    setState("failed", `halted: ${halted}`);
    return;
  }
  await startLoop();
}

// ── the browser's health ──────────────────────────────────────────────────
//
// Stand finding: Chrome's network service crashed once; Chrome restarted it
// by itself and stayed up, the CDP connection stayed up — and the page never
// answered again. None of that is a lost connection. Two checks every 2 s
// while ready: the page answers a trivial evaluate within 5 s (twice in a row
// missed = hung), and the network service is still the same process. Either
// failing: the exit closes and the browser starts over, as on a lost CDP.

let networkServicePid: number | null = null;
let probeMisses = 0;
let probing = false;

async function healthProbe(): Promise<void> {
  if (probing || restarting || state !== "ready" || !sitePage) return;
  probing = true;
  try {
    const page = sitePage;
    const answered = await Promise.race([
      // Any answer counts, an error too: the renderer is processing commands.
      cdp.send("Runtime.evaluate", { expression: "1", returnByValue: true }, page.sessionId).then(
        () => true,
        (error: Error) => error.name === "CdpError",
      ),
      sleep(5000).then(() => false),
    ]);
    if (state !== "ready" || restarting || sitePage !== page) return;
    probeMisses = answered ? 0 : probeMisses + 1;
    const net = await supervisor({ cmd: "chrome.netpid" }).then((reply) => (typeof reply.pid === "number" ? reply.pid : null), () => null);
    const netChanged = networkServicePid !== null && net !== null && net !== networkServicePid;
    if (networkServicePid === null) networkServicePid = net;
    if (netChanged || probeMisses >= 2) {
      const reason = netChanged ? "the network service restarted" : "the page stopped answering";
      log("browser.unhealthy", { reason, probeMisses, networkServicePid, now: net });
      rpc.send({ type: "alarm", kind: "browser_down", detail: { reason } });
      probeMisses = 0;
      networkServicePid = null;
      await controlLost(`browser unhealthy: ${reason}`);
    }
  } finally {
    probing = false;
  }
}

// ── engine messages ───────────────────────────────────────────────────────

rpc.onConnected = () => {
  // Site requests waiting for an admission are asked again (plan §3.2).
  for (const [id, pending] of pendingSite) askSiteAdmit(id, pending.params, isPreflight(pending.params) ? preflightMethod(pending.params) : pending.params.request.method);
  queueMicrotask(sendState);
  return { state, bufferId: "prototype", operatorPid: process.pid };
};

rpc.onLost = (reason) => {
  observe("engine.lost", { reason });
};

rpc.onMessage = (message) => {
  switch (message.type) {
    case "send":
      void onHubSend(message);
      break;
    case "checkResult":
      onCheckResult(message);
      break;
    case "siteAdmitResult":
      onSiteAdmitResult(message);
      break;
    case "wsAdmitResult":
      onWsAdmitResult(message);
      break;
    case "resultAck":
      hub.delete(String(message.attemptId));
      break;
    case "command":
      void onCommand(message);
      break;
    default:
      log("engine.unknown", { type: message.type });
  }
};

// Socket tunnels: admitted by the engine, one CONNECT = one socket.
const pendingWs = new Map<string, (deadline: number | null) => void>();
let wsAdmitSeq = 0;
egress.onWsTunnel = (connId, event) => rpc.send({ type: "wsTunnel", connId, event, mono: monoMs() });

egress.admitWsTunnel = (host) =>
  new Promise((resolve) => {
    if (!rpc.up) return resolve(null);
    const connId = `ws-${process.pid}-${++wsAdmitSeq}`;
    pendingWs.set(connId, (deadline) => resolve(deadline === null ? null : { deadline, connId }));
    rpc.send({ type: "wsAdmit", connId, host });
    setTimeout(() => {
      if (pendingWs.delete(connId)) resolve(null);
    }, 10_000);
  });

function onWsAdmitResult(message: EngineMessage): void {
  const resolve = pendingWs.get(String(message.connId));
  if (!resolve) return;
  pendingWs.delete(String(message.connId));
  // The deadline goes with the tunnel: the socket's handshake must leave
  // before it, however long SOCKS and TLS take.
  const deadline = Number(message.deadlineMono);
  resolve(message.ok === true && Number.isFinite(deadline) && deadline > monoMs() ? deadline : null);
}

egress.gate.onEvent = (event) => {
  if (event.kind !== "first_bytes") log("gate.event", { kind: event.kind, window: event.window, ...event.detail });
  observe("gate", { gateEvent: event.kind, window: event.window, ...event.detail });
};

async function onCommand(message: EngineMessage): Promise<void> {
  const name = String(message.name);
  const reply = (body: Record<string, unknown>) => rpc.send({ type: "commandResult", id: message.id, name, ...body });
  try {
    switch (name) {
      case "closeExit":
        egress.closeExit("engine command");
        return reply({ ok: true });
      case "openExit":
        if (halted !== null) return reply({ ok: false, error: `halted: ${halted}` });
        egress.openExit();
        return reply({ ok: true });
      case "restart":
        // After a halt: the engine starts the page again on purpose.
        halted = null;
        rmSync(HALT_FILE, { force: true });
        egress.unlatch();
        if (state === "failed" && !restarting) void startLoop();
        return reply({ ok: true });
      case "stop":
        // The engine stops the page: the exit closes at once (every tunnel,
        // the site's socket too) and stays closed until `restart`.
        halt("engine stop");
        return reply({ ok: true });
      case "test.breakCdp":
      case "test.dropCdp":
        cdp.holderCommand(name);
        return reply({ ok: true });
      case "test.eval": {
        // Stand only: drive the "site" from its main world.
        if (!sitePage) return reply({ ok: false, error: "no page" });
        const result = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>(
          "Runtime.evaluate",
          { expression: String(message.expression), awaitPromise: message.await === true, returnByValue: true },
          sitePage.sessionId,
        );
        return reply({ ok: !result.exceptionDetails, value: result.result?.value ?? null, error: result.exceptionDetails?.text ?? null });
      }
      case "test.navigate":
        if (!sitePage) return reply({ ok: false, error: "no page" });
        await cdp.send("Page.navigate", { url: String(message.url ?? CFG.siteUrl) }, sitePage.sessionId);
        return reply({ ok: true });
      case "test.evalIsolated": {
        // Stand only: run an expression in the operator's isolated world.
        if (!sitePage) return reply({ ok: false, error: "no page" });
        const world = await isolatedWorld(sitePage);
        const result = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>(
          "Runtime.evaluate",
          { expression: String(message.expression), contextId: world, awaitPromise: message.await === true, returnByValue: true },
          sitePage.sessionId,
        );
        return reply({ ok: !result.exceptionDetails, value: result.result?.value ?? null, error: result.exceptionDetails?.text ?? null });
      }
      case "test.callIsolated": {
        // Stand only: Runtime.callFunctionOn in the isolated world.
        if (!sitePage) return reply({ ok: false, error: "no page" });
        const world = await isolatedWorld(sitePage);
        const result = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>(
          "Runtime.callFunctionOn",
          { functionDeclaration: String(message.fn), executionContextId: world, arguments: (message.args as unknown[]) ?? [], returnByValue: true, awaitPromise: message.await === true },
          sitePage.sessionId,
        );
        return reply({ ok: !result.exceptionDetails, value: result.result?.value ?? null, error: result.exceptionDetails?.text ?? null });
      }
      case "test.gc":
        // Stand only: a full garbage collection in the page's renderer.
        if (!sitePage) return reply({ ok: false, error: "no page" });
        await cdp.send("HeapProfiler.collectGarbage", {}, sitePage.sessionId);
        return reply({ ok: true });
      case "test.cutApi":
        return reply({ ok: true, cut: egress.cutClass("api", "stand: cut API tunnels") });
      case "test.stopServiceWorkers":
        // Stand only: stop the site's service workers; Chrome starts one
        // again on the next event for it.
        if (!sitePage) return reply({ ok: false, error: "no page" });
        await cdp.send("ServiceWorker.enable", {}, sitePage.sessionId);
        await cdp.send("ServiceWorker.stopAllWorkers", {}, sitePage.sessionId);
        return reply({ ok: true });
      case "test.cutWs":
        return reply({ ok: true, cut: egress.cutClass("ws", "stand: cut socket tunnels") });
      case "test.config": {
        // Stand only: switch the candidates for comparison runs.
        if (typeof message.gate === "boolean") egress.gate.enabled = message.gate;
        if (typeof message.placeholder === "boolean") CFG.hubPlaceholderHost = message.placeholder;
        if (typeof message.hubAbort === "boolean") CFG.hubAbortBeforeDeadline = message.hubAbort;
        if (typeof message.wsHostRefuse === "boolean") CFG.refuseWsHostRequests = message.wsHostRefuse;
        if (typeof message.lossDelayMs === "number") lossReactionDelayMs = message.lossDelayMs;
        if (typeof message.urlAlways === "boolean") testUrlAlways = message.urlAlways;
        if (typeof message.dataDelayMs === "number") testDataDelayMs = message.dataDelayMs;
        if (typeof message.cdpDelayMs === "number") cdp.testDelayMs = message.cdpDelayMs;
        if (typeof message.burstClose === "boolean") egress.gate.burstClose = message.burstClose;
        if (typeof message.preflightFulfill === "boolean") CFG.preflightFulfill = message.preflightFulfill;
        if (typeof message.fetchScope === "string") CFG.fetchScope = message.fetchScope;
        if (typeof message.hubBodyLimit === "number") CFG.hubBodyLimit = message.hubBodyLimit;
        if (message.hubTransport === "xhr" || message.hubTransport === "fetch") CFG.hubTransport = message.hubTransport;
        if (typeof message.siteUrlSame === "boolean") testSiteUrlSame = message.siteUrlSame;
        if (typeof message.siteBypass === "boolean") testSiteBypass = message.siteBypass;
        return reply({ ok: true, gate: egress.gate.enabled, placeholder: CFG.hubPlaceholderHost, hubAbort: CFG.hubAbortBeforeDeadline, wsHostRefuse: CFG.refuseWsHostRequests });
      }
      case "test.tunnels":
        return reply({ ok: true, tunnels: egress.journal().slice(-200), gate: egress.gate.state });
      case "status":
        return reply({ ok: true, binding: BINDING, state, reason: stateReason, exit: egress.exitOpen, gate: egress.gate.state, targets: [...targets.values()].map((t) => ({ type: t.type, url: t.url })) });
      default:
        return reply({ ok: false, error: "unknown command" });
    }
  } catch (error) {
    reply({ ok: false, error: (error as Error).message });
  }
}

// ── main ──────────────────────────────────────────────────────────────────

function heartbeat(): void {
  try {
    utimesSync(CFG.heartbeat, new Date(), new Date());
  } catch {
    closeSync(openSync(CFG.heartbeat, "w"));
  }
}

async function main(): Promise<void> {
  heartbeat();
  setInterval(heartbeat, 1000);
  setInterval(sendState, 5000);
  setInterval(() => void healthProbe(), 2000);
  await egress.listen(CFG.proxyPort);
  await rpc.listen(CFG.rpcPort);
  cdp.onHolderEvent = (event) => {
    if (event.t === "cdp.down") void controlLost(`CDP closed (${event.reason ?? "?"})`);
    if (event.t === "overflow") void controlLost("holder overflow");
  };
  cdp.onHolderGone = () => void controlLost("holder link closed");
  const linked = await cdp.connect(CFG.holderSock);
  // Everything the holder replays happened before this instance: requests
  // still paused then are failed, never released (Fetch.requestPaused above).
  replayUpTo = linked.lastSeq;
  log("holder.linked", linked);
  if (linked.cdp === "up") {
    // A previous instance died under a live Chrome. The holder kept the
    // session, so nothing was released; this instance does not know that
    // session's targets, so it starts the browser over (prototype choice).
    await controlLost("operator restarted under a live Chrome");
    return;
  }
  await startLoop();
}

process.on("uncaughtException", (error) => {
  log("uncaught", { error: error.stack });
  process.exit(1);
});
void main();
