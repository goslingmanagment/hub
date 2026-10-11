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
import { closeSync, openSync, utimesSync } from "node:fs";

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
  rpcToken: envStr("PB_RPC_TOKEN", "stand-token"),
  socks: {
    host: envStr("PB_SOCKS_HOST", "stand-server"),
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
  heartbeat: "/run/pb/operator.alive",
};

const PLACEHOLDER_SUFFIX = ".pb-hold.invalid";
const BINDING = `__pb${Math.random().toString(36).slice(2, 10)}`;
const GUARD_POLICY: GuardPolicy = {
  exact: envStr("PB_WS_ALLOW_EXACT", "p").split("|").filter(Boolean),
  jsonTypes: envStr("PB_WS_ALLOW_TYPES", "1")
    .split(",")
    .filter(Boolean)
    .map((value) => (/^\d+$/.test(value) ? Number(value) : value)),
};
const GUARD = guardSource(BINDING, GUARD_POLICY);

function classify(host: string): HostClass {
  if (CFG.hosts.site.includes(host)) return "site";
  if (CFG.hosts.api.includes(host)) return "api";
  if (CFG.hosts.ws.includes(host)) return "ws";
  if (CFG.hosts.cdn.includes(host)) return "cdn";
  return "denied";
}

// ── state ─────────────────────────────────────────────────────────────────

type OpState = "starting" | "chrome_starting" | "attaching" | "selftest" | "ip_check" | "site_loading" | "ready" | "failed";

const cdp = new Cdp();
const egress = new Egress(CFG.socks, classify);
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
    gate: egress.gateState,
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
  } finally {
    if (waiting) cdp.post("Runtime.runIfWaitingForDebugger", {}, s);
  }
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
  if (!s || !info?.guardBreakpoint) {
    if (s) cdp.post("Debugger.resume", {}, s);
    return;
  }
  const breakpointId = info.guardBreakpoint;
  info.guardBreakpoint = undefined;
  void (async () => {
    try {
      const frame = params.callFrames[0];
      const result = frame
        ? await cdp.send<{ exceptionDetails?: unknown }>("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: GUARD, silent: true }, s)
        : await cdp.send<{ exceptionDetails?: unknown }>("Runtime.evaluate", { expression: GUARD, silent: true }, s);
      if (result.exceptionDetails) log("guard.worker_failed", { type: info.type, url: info.url, details: result.exceptionDetails });
      await cdp.send("Debugger.removeBreakpoint", { breakpointId }, s).catch(() => undefined);
      log("guard.worker_installed", { type: info.type, url: info.url, reason: params.reason });
    } catch (error) {
      log("guard.worker_failed", { type: info.type, url: info.url, error: (error as Error).message });
    } finally {
      // Disabling the debugger resumes the worker and leaves nothing behind
      // (no pauses on the site's own `debugger;` statements).
      cdp.post("Debugger.disable", {}, s);
    }
  })();
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
    if (CFG.onBlockedSend === "stop") {
      egress.closeExit("blocked socket message");
      setState("failed", "blocked socket message");
    }
  }
});

// ── operations: what one admission covers ─────────────────────────────────
//
// Chrome 155 pauses a CORS preflight in Fetch as a request of its own, right
// before the request it guards (stand finding; the plan assumed it was not
// intercepted). Owner decision №1: preflight + request = one operation under
// one admission. So an operation has up to two physical requests; each
// physical request gets its own gate window inside the admission's window,
// and Chrome sending one of them twice is a retry.

interface Physical {
  op: Operation;
  role: "preflight" | "main";
  networkId: string | null;
  sends: number;
  done: boolean;
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
  fromCache: boolean;
  fromServiceWorker: boolean;
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
      log("net", { m: method.slice(8), id: p.requestId, type: p.type ?? null, url: p.request?.url ?? p.response?.url ?? null, status: p.response?.status ?? p.statusCode ?? null, err: p.errorText ?? null });
    });
  }
}

function newOperation(kind: Operation["kind"], id: string, key: string, onFinish: Operation["onFinish"]): Operation {
  return {
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
    fromCache: false,
    fromServiceWorker: false,
    sessionId: null,
    done: false,
    mainTimer: null,
    limitTimer: null,
    onFinish,
  };
}

/** Start the operation's clock at its admission. */
function startLimit(op: Operation): void {
  op.limitTimer = setTimeout(() => {
    if (op.done) return;
    observe("op.limit", { op: op.id, kind: op.kind, status: op.status, mainSends: op.main?.sends ?? 0 });
    // The gate's window goes with the operation; an API tunnel still busy
    // with it is cut so nothing of it leaves later.
    egress.cutApi("operation over its time limit");
    if (op.status !== null) {
      finishOp(op, { outcome: "response", status: op.status, sends: op.main?.sends ?? 0, sendMono: op.sendMono, fromCache: op.fromCache, fromServiceWorker: op.fromServiceWorker, bodyEnd: "limit" });
    } else {
      finishOp(op, { outcome: "transport_error", sent: (op.main?.sends ?? 0) > 0, error: "no end within the operation limit", sends: op.main?.sends ?? 0 });
    }
  }, OP_LIMIT_MS);
}

function finishOp(op: Operation, outcome: Record<string, unknown>): void {
  if (op.done) return;
  op.done = true;
  if (op.mainTimer) clearTimeout(op.mainTimer);
  if (op.limitTimer) clearTimeout(op.limitTimer);
  for (const phys of [op.preflight, op.main]) if (phys?.networkId) byNetworkId.delete(phys.networkId);
  if (awaitingMain.get(op.key) === op) awaitingMain.delete(op.key);
  for (const phys of [op.preflight, op.main]) {
    const wid = phys ? windowId(phys) : null;
    if (wid) egress.gateClose(wid);
  }
  op.onFinish({ ...outcome, preflight: op.preflight ? { sends: op.preflight.sends } : null, preflightSendMono: op.preflightSendMono });
}

/** Release one physical request of an admitted operation. */
/** The gate's window of one physical request (events of the preflight
 *  may arrive after its request is already out: CDP orders events within a
 *  session, not across the browser and page sessions). */
function windowId(phys: Physical): string | null {
  return phys.op.admissionId ? `${phys.op.admissionId}:${phys.role}` : null;
}

function releasePhysical(op: Operation, event: CdpEvent, params: PausedParams, role: Physical["role"], extra: Record<string, unknown> = {}): void {
  const phys: Physical = { op, role, networkId: params.networkId ?? null, sends: 0, done: false };
  if (role === "preflight") op.preflight = phys;
  else op.main = phys;
  if (phys.networkId) byNetworkId.set(phys.networkId, phys);
  // Chrome sends the request only after its preflight passed: link them now,
  // not on the preflight's loadingFinished (that may come later).
  if (role === "preflight" && op.kind === "site") awaitingMain.set(op.key, op);
  const id = windowId(phys);
  if (id && op.deadline !== null) egress.gateOpen(id, op.deadline);
  void resolvePaused(event, "continue", { requestId: params.requestId, ...extra });
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
  const params = event.params as { requestId: string };
  const phys = byNetworkId.get(params.requestId);
  if (!phys || phys.done) return;
  const op = phys.op;
  phys.sends += 1;
  observe("send", { op: op.id, kind: op.kind, role: phys.role, n: phys.sends });
  const wid = windowId(phys);
  if (wid) {
    const first = egress.gateSent(wid);
    if (!first || phys.sends > 1) {
      log("retry.detected", { op: op.id, role: phys.role, sends: phys.sends });
      observe("retry", { op: op.id, kind: op.kind, role: phys.role, sends: phys.sends });
    }
  }
  if (op.kind === "hub" && phys.role === "main" && phys.sends === 1) rpc.send({ type: "sent", attemptId: op.id, mono: monoMs() });
});

cdp.on("Network.requestWillBeSent", (event) => {
  const params = event.params as { requestId: string; request: { url: string }; redirectResponse?: { status: number } };
  const phys = byNetworkId.get(params.requestId);
  if (phys && params.redirectResponse) {
    // A redirect ends this admission: the next hop stops in Fetch again and
    // needs its own admission.
    observe("redirect", { op: phys.op.id, status: params.redirectResponse.status, to: params.request.url });
  }
});

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
    op.fromCache = params.response.fromDiskCache === true;
    op.fromServiceWorker = params.response.fromServiceWorker === true;
    op.sessionId = event.sessionId ?? null;
  }
  const wid = windowId(phys);
  if (wid) egress.gateResponding(wid);
});

cdp.on("Network.loadingFinished", (event) => {
  const params = event.params as { requestId: string; encodedDataLength: number };
  const phys = byNetworkId.get(params.requestId);
  if (!phys || phys.done) return;
  phys.done = true;
  const op = phys.op;
  const wid = windowId(phys);
  if (wid) egress.gateClose(wid);
  if (phys.role === "preflight") {
    // The request itself comes next (unless it is already out).
    if (!op.main) op.mainTimer = setTimeout(() => finishOp(op, { outcome: "transport_error", sent: false, error: "the request did not follow its preflight" }), 5000);
    return;
  }
  finishOp(op, {
    outcome: "response",
    status: op.status,
    sends: phys.sends,
    sendMono: op.sendMono,
    fromCache: op.fromCache,
    fromServiceWorker: op.fromServiceWorker,
    encodedBytes: params.encodedDataLength,
    sessionId: event.sessionId ?? null,
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
    finishOp(op, {
      outcome: "response",
      status: op.status,
      sends: phys.sends,
      sendMono: op.sendMono,
      fromCache: op.fromCache,
      fromServiceWorker: op.fromServiceWorker,
      bodyEnd: "canceled",
      sessionId: event.sessionId ?? null,
    });
    return;
  }
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

// ── Fetch: every request of every context stops here ─────────────────────

interface PausedParams {
  requestId: string;
  request: { url: string; urlFragment?: string; method: string; headers: Record<string, string> };
  frameId?: string;
  resourceType: string;
  networkId?: string;
}

function resolvePaused(event: CdpEvent, action: "continue" | "fail", params: Record<string, unknown>): Promise<void> {
  const method = action === "continue" ? "Fetch.continueRequest" : "Fetch.failRequest";
  return cdp
    .send(method, params)
    .then(() => undefined)
    .catch((error: Error) => log("fetch.resolve_failed", { method, error: error.message }))
    .finally(() => cdp.ack(event.seq));
}

cdp.on("Fetch.requestPaused", (event) => {
  const params = event.params as unknown as PausedParams;
  const requestId = params.requestId;
  if (process.env.PB_DEBUG_FETCH === "1") log("fetch.paused", { method: params.request.method, url: params.request.url, frag: params.request.urlFragment ?? null, networkId: params.networkId ?? null, type: params.resourceType });
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
  if (fragment.startsWith("#pb-selftest-")) return onSelftestPaused(event, params, fragment);
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

// ── site requests: admitted by the engine (plan §4.3) ─────────────────────

interface PendingSite {
  event: CdpEvent;
  params: PausedParams;
  op: Operation;
  role: Physical["role"];
  timer: NodeJS.Timeout;
}
const pendingSite = new Map<string, PendingSite>();

function onSitePaused(event: CdpEvent, params: PausedParams): void {
  const preflight = isPreflight(params);
  const method = preflight ? preflightMethod(params) : params.request.method;
  const key = opKey(params.request.url, method);
  if (!preflight) {
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
      if (wid) egress.gateClose(wid);
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
const HUB_FETCH = `function (id, url, method, headers) {
  const g = globalThis;
  const live = g.__pbLive || (g.__pbLive = new Map());
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
        arguments: [{ value: attemptId }, { value: issued.toString() }, { value: attempt.method }, { value: attempt.headers }],
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
    const op = attempt.op;
    if (op.mainTimer) clearTimeout(op.mainTimer);
    if (role === "main" && op.deadline !== null && op.deadline > monoMs() && egress.exitOpen) {
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

function onSelftestPaused(event: CdpEvent, params: PausedParams, fragment: string): void {
  const waiter = selftestWaiters.get(fragment);
  if (waiter && params.networkId) {
    const op = newOperation("selftest", fragment, fragment, waiter);
    const phys: Physical = { op, role: "main", networkId: params.networkId, sends: 0, done: false };
    op.main = phys;
    byNetworkId.set(params.networkId, phys);
  }
  // No admission: the exit is closed, the request has nowhere to go.
  void resolvePaused(event, "continue", { requestId: params.requestId });
}

async function runSelftest(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  const page = sitePage;
  if (!page) throw new Error("no page target");
  const world = await isolatedWorld(page);
  const fragment = `#pb-selftest-${Date.now()}`;
  const outcome = new Promise<Record<string, unknown>>((resolve) => {
    selftestWaiters.set(fragment, resolve);
    setTimeout(() => resolve({ outcome: "timeout" }), 10_000);
  });
  const apiHost = CFG.hosts.api[0]!;
  await cdp.send(
    "Runtime.callFunctionOn",
    {
      functionDeclaration: "function (u) { fetch(u, { mode: 'no-cors' }).catch(() => {}); return true; }",
      executionContextId: world,
      arguments: [{ value: `https://${apiHost}/api/selftest${fragment}` }],
      returnByValue: true,
    },
    page.sessionId,
  );
  const exitClosed = await outcome;
  selftestWaiters.delete(fragment);
  results.exitClosed = exitClosed;
  const net = await supervisor({ cmd: "netselftest" }).catch((error: Error) => ({ ok: false, error: error.message }));
  results.kernel = net;
  const pass =
    exitClosed.outcome === "transport_error" &&
    exitClosed.sent === false &&
    String(exitClosed.errorText).includes("TUNNEL_CONNECTION_FAILED") &&
    (net as { ok?: boolean }).ok === true;
  return { pass, ...results };
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
  egress.closeExit("startup");
  setState("chrome_starting");
  const status = await supervisor({ cmd: "chrome.status" });
  if (!status.running) await supervisor({ cmd: "chrome.start", env: { TZ: envStr("PB_TZ", "UTC"), LANG_TAG: envStr("PB_LANG", "en-US") } });
  // Wait until the holder holds the DevTools connection.
  for (let i = 0; i < 300 && !cdp.cdpUp; i++) await sleep(100);
  if (!cdp.cdpUp) throw new Error("no CDP connection");
  setState("attaching");
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
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
  egress.openExit();
  setState("site_loading");
  await cdp.send("Page.navigate", { url: CFG.siteUrl }, sitePage.sessionId);
  setState("ready");
}

async function startLoop(): Promise<void> {
  const ladder = [10_000, 30_000, 120_000, 300_000];
  for (let attempt = 0; ; attempt++) {
    try {
      await start();
      return;
    } catch (error) {
      egress.closeExit("startup failed");
      setState("failed", (error as Error).message);
      const wait = ladder[Math.min(attempt, ladder.length - 1)]!;
      log("start.failed", { error: (error as Error).message, retryInMs: wait });
      await sleep(Number(process.env.PB_FAST_RETRY) > 0 ? 2000 : wait);
    }
  }
}

/** Control is lost (the holder died or Chrome closed the DevTools
 *  connection): Chrome has released every held request. Close the exit at
 *  once, kill Chrome, start over (plan §4.1, §4.9). */
let lossReactionDelayMs = Number(process.env.PB_TEST_LOSS_DELAY_MS ?? "0");
/** Stand: pass `url` to Fetch.continueRequest even when it is unchanged. */
let testUrlAlways = false;
/** Stand: pass the same `url` for site requests too. */
let testSiteUrlSame = false;

async function controlLost(reason: string): Promise<void> {
  // Stand only: react late, so what Chrome releases meets the open exit and
  // only the gate stands in its way.
  if (lossReactionDelayMs > 0) await sleep(lossReactionDelayMs);
  egress.closeExit(`control lost: ${reason}`);
  rpc.send({ type: "alarm", kind: "cdp_lost", detail: { reason } });
  if (restarting) return;
  restarting = true;
  setState("failed", `control lost: ${reason}`);
  targets.clear();
  sitePage = null;
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
  await startLoop();
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
const pendingWs = new Map<string, (ok: boolean) => void>();
let wsSeq = 0;
egress.admitWsTunnel = (host) =>
  new Promise((resolve) => {
    if (!rpc.up) return resolve(false);
    const connId = `ws-${process.pid}-${++wsSeq}`;
    pendingWs.set(connId, resolve);
    rpc.send({ type: "wsAdmit", connId, host });
    setTimeout(() => {
      if (pendingWs.delete(connId)) resolve(false);
    }, 10_000);
  });

function onWsAdmitResult(message: EngineMessage): void {
  const resolve = pendingWs.get(String(message.connId));
  if (!resolve) return;
  pendingWs.delete(String(message.connId));
  resolve(message.ok === true && Number(message.deadlineMono) > monoMs());
}

egress.onGateEvent = (event) => {
  if (event.kind !== "up_chunk") log("gate.event", event);
  observe("gate", { ...event, gateEvent: event.kind });
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
        egress.openExit();
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
        return reply({ ok: true, cut: egress.cutApi("stand: cut API tunnels") });
      case "test.cutWs":
        return reply({ ok: true, cut: egress.cutClass("ws", "stand: cut socket tunnels") });
      case "test.config": {
        // Stand only: switch the candidates for comparison runs.
        if (typeof message.gate === "boolean") egress.gateEnabled = message.gate;
        if (typeof message.placeholder === "boolean") CFG.hubPlaceholderHost = message.placeholder;
        if (typeof message.hubAbort === "boolean") CFG.hubAbortBeforeDeadline = message.hubAbort;
        if (typeof message.wsHostRefuse === "boolean") CFG.refuseWsHostRequests = message.wsHostRefuse;
        if (typeof message.lossDelayMs === "number") lossReactionDelayMs = message.lossDelayMs;
        if (typeof message.urlAlways === "boolean") testUrlAlways = message.urlAlways;
        if (typeof message.siteUrlSame === "boolean") testSiteUrlSame = message.siteUrlSame;
        return reply({ ok: true, gate: egress.gateEnabled, placeholder: CFG.hubPlaceholderHost, hubAbort: CFG.hubAbortBeforeDeadline, wsHostRefuse: CFG.refuseWsHostRequests });
      }
      case "test.tunnels":
        return reply({ ok: true, tunnels: egress.journal().slice(-200), gate: egress.gateState });
      case "status":
        return reply({ ok: true, binding: BINDING, state, reason: stateReason, exit: egress.exitOpen, gate: egress.gateState, targets: [...targets.values()].map((t) => ({ type: t.type, url: t.url })) });
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
