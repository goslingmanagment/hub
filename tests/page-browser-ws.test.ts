import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as Util from "../apps/page-browser/src/shared/util.ts";

// The operator's clock (CLOCK_MONOTONIC, counted from the machine's boot)
// as on a host up for a day. A fresh CI machine is minutes old: Chrome's
// clock an hour behind it would read below zero — no Chrome's does, and a
// calibration from such a reading is refused (chrome-clock.ts) — and "five
// minutes ago" would come before its boot. Every clock here moves with it:
// the operator's, the proxy's and the fakes' (Chrome's is the operator's
// plus its shift).
vi.mock("../apps/page-browser/src/shared/util.ts", async (importOriginal) => {
  const util = await importOriginal<typeof Util>();
  const UP_A_DAY_MS = 86_400_000;
  return { ...util, monoMs: () => util.monoMs() + UP_A_DAY_MS };
});

import { EventBuffer, type Appended, type BufferOptions } from "../apps/page-browser/src/buffer/buffer.ts";
import { Cdp, CdpError } from "../apps/page-browser/src/cdp/client.ts";
import { classifyFanslyHost } from "../apps/page-browser/src/egress/hosts.ts";
import { Egress, type SocketTicket, type TunnelRecord } from "../apps/page-browser/src/egress/proxy.ts";
import { authorizationBytes, clientFrameBytes } from "../apps/page-browser/src/egress/socket-gate.ts";
import type { SocketLine } from "../apps/page-browser/src/logs/journal.ts";
import { makeLog, monoMs, setLogSink } from "../apps/page-browser/src/shared/util.ts";
import { guardExpression } from "../apps/page-browser/src/ws/guard.ts";
import { GuardInstaller } from "../apps/page-browser/src/ws/install.ts";
import { CALIBRATION_MAX_MS, SiteSockets, type SocketBuffer, type SocketDeps, type SocketTimings } from "../apps/page-browser/src/ws/sockets.ts";
import {
  FakeCdpPort,
  FakeChrome,
  FakeSocks,
  HolderUnderS6,
  quiet,
  SOCKET_FILL,
  socketServer,
  SocketTunnelClient,
  SOCKS_PASSWORD,
  SOCKS_USER,
  tempDir,
  TLS13_OVERHEAD,
  UNANSWERED,
  until,
} from "./helpers/page-browser-fakes.ts";

// The site's socket, observed — never admitted (variant Б, plan-b §4.1.9;
// Project Browser plan §4.4; spec §2.6, §6.1; mandatory condition №3): each
// socket's CONNECT goes on at once; its handshake is told to the engine as a
// send of the site's (`ws.upgrade`) at the proxy's write, under the CDP
// connection's id; its own answer, failure or close gives the status. Its frames come from CDP into the
// buffer, durable and in order; gaps mark where frames may be missing; the
// socket gate lets up only spec §2.6's messages, holding one that may be the
// authorization until the site's session is observed; nothing of a frame, a
// token or an authorization reaches a log or a journal.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setLogSink(null);
});

const FINGERPRINT = "f".repeat(64);
const TOKEN = "eyJ-socket-token-value-9f8e7d6c5b4a";
const AUTH = JSON.stringify({ t: 1, d: JSON.stringify({ token: TOKEN, v: 3 }) });
/** The live session's token, as the site's stored session carries it. */
const SESSION_TOKEN = "MTA4NDU4OTk3MjEyNjE2NzA0MDoxOjI6MjZhNjU0M2Q0YWZmYzQyOWNiZWE0OWRmYjFmNmI4";
const FRAME_SECRET = "frame-content-marker-7c3b";
const URL_WS = "wss://wsv3.fansly.com/?v=3";

/** What the engine heard of the site's handshakes. */
type Observed = { type: "sent"; id: string; url: string; sentMono: number } | { type: "ended"; id: string; status: number | null; error: string | null };

function observing(): { observed: Observed[]; observe: SocketDeps["observe"] } {
  const observed: Observed[] = [];
  return {
    observed,
    observe: {
      sent: (handshake) => observed.push({ type: "sent", id: handshake.id, url: handshake.url.href, sentMono: handshake.sentMono }),
      ended: (end) => observed.push({ type: "ended", ...end }),
    },
  };
}

interface World {
  cdp: FakeCdpPort;
  egress: Egress;
  proxyPort: number;
  socks: FakeSocks;
  server: Awaited<ReturnType<typeof socketServer>>;
  buffer: EventBuffer;
  sockets: SiteSockets;
  observed: Observed[];
  records: TunnelRecord[];
  journal: SocketLine[];
  alarms: Array<{ kind: string; detail: Record<string, unknown> }>;
  stops: Array<{ reason: string; note: string; how: string; exitOpen: boolean }>;
  lines: string[];
  session: { fingerprint: string | null; token: string | null };
  /** The site's session read again (the socket gate holds a record). */
  refreshes: { count: number };
  events: () => Array<Record<string, unknown>>;
  /** The connection id of a socket CDP showed (also its observed send). */
  connectionOf: (index?: number) => string;
}

async function world(options: { timings?: Partial<SocketTimings>; buffer?: (buffer: EventBuffer) => SocketBuffer; tls12Suite?: number; serverAnswer?: boolean; authHoldMs?: number } = {}): Promise<World> {
  const temp = tempDir("pb-ws-");
  cleanups.push(temp.remove);
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const cdp = new FakeCdpPort();
  const server = await socketServer({ ...(options.tls12Suite === undefined ? {} : { tls12Suite: options.tls12Suite }), ...(options.serverAnswer === undefined ? {} : { answer: options.serverAnswer }) });
  cleanups.push(server.close);
  const socks = new FakeSocks(SOCKS_USER, SOCKS_PASSWORD);
  await socks.start();
  cleanups.push(() => socks.stop());
  socks.routes.set("wsv3.fansly.com:443", server.port);
  const buffer = new EventBuffer({ dir: join(temp.dir, "buffer"), idFile: join(temp.dir, "buffer-id"), batchMs: 5, log: quiet });
  buffer.start();
  cleanups.push(() => buffer.close());
  const records: TunnelRecord[] = [];
  const journal: SocketLine[] = [];
  const alarms: World["alarms"] = [];
  const stops: World["stops"] = [];
  const { observed, observe } = observing();
  const session = { fingerprint: FINGERPRINT as string | null, token: SESSION_TOKEN as string | null };
  const refreshes = { count: 0 };
  let sockets: SiteSockets | null = null;
  const egress = new Egress({
    classify: classifyFanslyHost,
    openSocket: (host, port) => sockets!.openTunnel(host, port),
    onRecord: (record) => records.push(record),
    ...(options.authHoldMs === undefined ? {} : { authHoldMs: options.authHoldMs }),
    log: makeLog("egress"),
  });
  const proxyPort = await egress.listen(0);
  cleanups.push(() => egress.close());
  egress.setSocks({ ip: "127.0.0.1", port: socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD });
  egress.openExit();
  const types = new Map<string, string>([
    ["S1", "page"],
    ["S2", "iframe"],
    ["W1", "worker"],
  ]);
  sockets = new SiteSockets({
    cdp,
    buffer: options.buffer ? options.buffer(buffer) : buffer,
    observe,
    sessionFingerprint: () => session.fingerprint,
    authorizationBytes: () => (session.token === null ? null : authorizationBytes(session.token)),
    refreshAuthorization: () => {
      refreshes.count += 1;
    },
    targetType: (sessionId) => (sessionId === null ? null : (types.get(sessionId) ?? null)),
    socketHost: (host) => classifyFanslyHost(host) === "ws",
    journal: (line) => journal.push(line),
    alarm: (kind, detail) => alarms.push({ kind, detail }),
    stop: (reason, note, how) => {
      stops.push({ reason, note, how, exitOpen: egress.exitOpen });
      egress.closeExit(note);
    },
    ...(options.timings ? { timings: options.timings } : {}),
    log: makeLog("ws"),
  });
  const created = sockets;
  cleanups.push(() => created.close());
  const events = () => buffer.readEvents(0, 10_000, 100_000_000).map((event) => JSON.parse(event.json) as Record<string, unknown>);
  const connectionOf = (index = 0) => journal.filter((line) => line.event === "open")[index]!.connectionId!;
  return { cdp, egress, proxyPort, socks, server, buffer, sockets: created, observed, records, journal, alarms, stops, lines, session, refreshes, events, connectionOf };
}

/** A socket to the 101: its CONNECT (on at once), the TLS handshake, the
 *  handshake request as CDP and the proxy see it, the answer.
 *  `chrome`: Chrome's clock of an instant of this process's (its own base). */
async function opened(w: World, requestId = "WS1", sessionId = "S1", chrome: (mono: number) => number = (mono) => mono): Promise<SocketTunnelClient> {
  const client = await SocketTunnelClient.connect(w.proxyPort);
  expect(client.status).toBe(200);
  await client.tls();
  w.cdp.emit("Network.webSocketCreated", { requestId, url: URL_WS }, sessionId);
  w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId, timestamp: chrome(monoMs()) / 1000 }, sessionId);
  const before = w.server.received().length;
  client.request();
  await until(() => w.server.received().subarray(before).includes(SOCKET_FILL.request), 3000, "the handshake request at the server");
  await client.answered();
  w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId, timestamp: chrome(monoMs()) / 1000, response: { status: 101 } }, sessionId);
  return client;
}

describe("frames (plan §4.4)", () => {
  // Astra's review of PR 15, rounds 5–7: an event's stamp is Chrome's
  // timestamp on the operator's clock, by an active calibration of its
  // session (at most its round trip early, never late) — so a delivery delay
  // never makes it late, and Chrome's own base never crosses; a gap's
  // boundary is the last event received before the loss, never a late close.
  it.for([
    { chrome: "on the operator's clock", shift: 0 },
    { chrome: "an hour ahead", shift: 3_600_000 },
    { chrome: "an hour behind", shift: -3_600_000 },
  ])("are stamped when Chrome saw them, on the operator's clock (Chrome's clock $chrome): a frame delivered five minutes late is five minutes old; the next connection's gap starts at it, not at the late close", async ({ shift }) => {
    const w = await world();
    w.cdp.clockShiftMs = shift;
    const chrome = (mono: number) => mono + shift;
    // Opened: the session's clock calibrated with its first event.
    const first = await opened(w, "WS1", "S1", chrome);
    await until(() => w.sockets.clockOf("S1") !== null, 3000, "the session's calibration");
    expect(w.sockets.clockOf("S1")!.spread).toBeLessThanOrEqual(CALIBRATION_MAX_MS);
    // The last frame Chrome saw five minutes ago, and the close; CDP tells
    // both only now.
    const take = monoMs();
    const lateFrame = take - 300_000;
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", timestamp: chrome(lateFrame) / 1000, response: { opcode: 1, mask: false, payloadData: JSON.stringify({ t: 2, d: "late" }) } }, "S1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1", timestamp: chrome(take - 1_000) / 1000 }, "S1");
    await w.buffer.flush();
    await until(() => w.events().some((event) => event.kind === "ws.close"), 3000, "the close durable");
    first.destroy();
    // The next connection: its gap from the late frame, as Chrome saw it.
    const second = await opened(w, "WS2", "S1", chrome);
    await w.buffer.flush();
    await until(() => w.events().some((event) => event.kind === "gap"), 3000, "the reconnect's gap durable");
    const events = w.events();
    const frame = events.find((event) => event.kind === "ws.in")!;
    const close = events.find((event) => event.kind === "ws.close")!;
    const gap = events.find((event) => event.kind === "gap")!;
    // Five minutes old — at most the calibration's round trip early, never
    // later — not the take.
    expect(frame.atMono as number).toBeLessThanOrEqual(lateFrame);
    expect(frame.atMono as number).toBeGreaterThanOrEqual(lateFrame - w.sockets.clockOf("S1")!.spread);
    // Every stamp at most its take.
    for (const event of events) expect(event.atMono as number, String(event.kind)).toBeLessThanOrEqual(monoMs());
    // The gap starts at the last frame received — not the close, not now.
    expect(gap).toMatchObject({ reason: "ws_reconnect", fromSeq: frame.seq, fromWall: frame.atWall });
    expect(close.atWall as number).toBeGreaterThan(gap.fromWall as number);
    second.destroy();
  });
});

describe("gaps (plan §4.4, step 6; spec §6.1)", () => {
  it("Chrome goes under two open connections: its gap starts at the earliest of their last saved frames", async () => {
    const w = await world();
    const a = await opened(w, "WS1", "S2");
    const b = await opened(w, "WS2", "S1");
    await until(() => w.sockets.clockOf("S1") !== null && w.sockets.clockOf("S2") !== null, 3000, "both sessions calibrated");
    const seen = monoMs() - 10_000;
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", timestamp: seen / 1000, response: { opcode: 1, payloadData: "A earlier" } }, "S2");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS2", timestamp: (seen + 2_000) / 1000, response: { opcode: 1, payloadData: "B later" } }, "S1");
    await until(() => w.events().length === 4, 3000, "both frames saved");
    const lastA = w.events()[2]!;
    w.sockets.endAll("a test");
    await until(() => w.events().length === 7, 3000, "the browser's gap and both closes");
    expect(w.events()[4]).toMatchObject({ kind: "gap", reason: "chrome_restart", fromSeq: lastA.seq, fromWall: lastA.atWall });
    expect(w.events().slice(5).map((event) => event.kind)).toEqual(["ws.close", "ws.close"]);
    a.destroy();
    b.destroy();
  });
});

describe("outgoing messages (spec §2.6)", () => {
  it("the guard's report of a blocked message stops the page — the exit closed first — and alarms with its shape, never its content", async () => {
    const w = await world();
    await opened(w);
    w.sockets.onGuardReport(
      { k: "blocked_send", where: "https://fansly.com/messages?token=QUERY-9", shape: { form: "json", len: 64, msgType: 46001, keys: ["t", "d"], dKeys: ["chatRoomId"] } },
      { sessionId: "S1", type: "page" },
    );
    expect(w.stops).toEqual([{ reason: "unknown_ws_message", note: expect.stringContaining("it was not sent"), how: "stop", exitOpen: true }]);
    expect(w.egress.exitOpen).toBe(false);
    expect(w.alarms).toEqual([{ kind: "unknown_ws_message", detail: { form: "json", len: 64, msgType: 46001, keys: "t,d", dKeys: "chatRoomId", context: "page", where: "https://fansly.com/messages", left: false } }]);
    expect(w.journal.at(-1)).toMatchObject({ event: "blocked", context: "page", shape: { msgType: 46001 } });
  });

  it("a guard that failed in a context stops the page at once", async () => {
    const w = await world();
    w.sockets.onGuardReport({ k: "guard_failed", why: "WebSocketStream stays", where: "" }, { sessionId: "W1", type: "service_worker" });
    expect(w.stops).toEqual([{ reason: "ws_guard_failed", note: "the socket guard could not guard a service_worker: WebSocketStream stays", how: "kill", exitOpen: true }]);
  });

  it("journals what left by its kind and size; a message the guard should not have let go means it was passed by: the page is killed", async () => {
    const w = await world();
    await opened(w);
    w.cdp.emit("Network.webSocketFrameSent", { requestId: "WS1", response: { opcode: 1, mask: true, payloadData: AUTH } }, "S1");
    w.cdp.emit("Network.webSocketFrameSent", { requestId: "WS1", response: { opcode: 1, mask: true, payloadData: "p" } }, "S1");
    expect(w.stops).toEqual([]);
    const connectionId = w.connectionOf();
    expect(w.journal.filter((line) => line.event === "out")).toEqual([
      { connectionId, event: "out", message: { kind: "auth", opcode: 1, bytes: Buffer.byteLength(AUTH) } },
      { connectionId, event: "out", message: { kind: "ping", opcode: 1, bytes: 1 } },
    ]);
    w.cdp.emit("Network.webSocketFrameSent", { requestId: "WS1", response: { opcode: 1, mask: true, payloadData: JSON.stringify({ t: 46001, d: FRAME_SECRET }) } }, "S1");
    expect(w.stops).toEqual([{ reason: "unknown_ws_message", note: "an unknown socket message left the page past the guard", how: "kill", exitOpen: true }]);
    expect(w.alarms[0]).toMatchObject({ kind: "unknown_ws_message", detail: { msgType: 46001, left: true } });
  });

  it("no frame, token or authorization in a log line or a journal line", async () => {
    const w = await world();
    await opened(w);
    w.cdp.emit("Network.webSocketFrameSent", { requestId: "WS1", response: { opcode: 1, payloadData: AUTH } }, "S1");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: JSON.stringify({ t: 1, d: JSON.stringify({ session: { token: TOKEN }, marker: FRAME_SECRET }) }) } }, "S1");
    w.cdp.emit("Network.webSocketFrameSent", { requestId: "WS1", response: { opcode: 1, payloadData: JSON.stringify({ t: 7, d: TOKEN }) } }, "S1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    await w.buffer.flush();
    const everything = [...w.lines, ...w.journal.map((line) => JSON.stringify(line)), ...w.alarms.map((alarm) => JSON.stringify(alarm)), ...w.stops.map((stop) => JSON.stringify(stop))].join("\n");
    for (const secret of [TOKEN, SESSION_TOKEN, FRAME_SECRET, "?v=3"]) expect(everything, secret).not.toContain(secret);
    // The frame itself is in the buffer, as it came.
    expect(w.events().some((event) => String(event.frame).includes(FRAME_SECRET))).toBe(true);
  });
});


describe("the guard into every context (ws/install.ts)", () => {
  function installer() {
    const cdp = new FakeCdpPort();
    const reports: Array<{ report: unknown; target: unknown }> = [];
    const failures: Array<{ type: string; why: string }> = [];
    const expression = guardExpression("pbBinding");
    const guard = new GuardInstaller({ cdp, binding: "pbBinding", expression, onReport: (report, target) => reports.push({ report, target }), onFailed: (target, why) => failures.push({ type: target.type, why }), log: quiet });
    return { cdp, guard, reports, failures, expression };
  }

  it("a tab or frame: Runtime on, the binding, and the guard as a script of every new document — the current one included", async () => {
    const { cdp, guard, expression } = installer();
    await guard.setUp({ sessionId: "S1", type: "iframe", url: "about:blank" }, "page", true);
    expect(cdp.commands.map((command) => [command.method, command.sessionId])).toEqual([
      ["Runtime.enable", "S1"],
      ["Runtime.addBinding", "S1"],
      ["Page.addScriptToEvaluateOnNewDocument", "S1"],
    ]);
    expect(cdp.sent("Runtime.addBinding")[0]!.params).toEqual({ name: "pbBinding" });
    expect(cdp.sent("Page.addScriptToEvaluateOnNewDocument")[0]!.params).toEqual({ source: expression, runImmediately: true });
  });

  it("a worker: stopped before its first script, the guard goes in on that frame, then the debugger goes", async () => {
    const { cdp, guard, expression } = installer();
    cdp.handlers.set("Debugger.setInstrumentationBreakpoint", () => ({ breakpointId: "bp-1" }));
    await guard.setUp({ sessionId: "W1", type: "worker", url: "https://fansly.com/worker.js" }, "worker", true);
    expect(cdp.commands.map((command) => command.method)).toEqual(["Runtime.enable", "Runtime.addBinding", "Debugger.enable", "Debugger.setInstrumentationBreakpoint"]);
    expect(cdp.sent("Debugger.setInstrumentationBreakpoint")[0]!.params).toEqual({ instrumentation: "beforeScriptExecution" });
    cdp.emit("Debugger.paused", { reason: "instrumentation", callFrames: [{ callFrameId: "cf-1" }] }, "W1");
    await until(() => cdp.sent("Debugger.disable").length === 1);
    expect(cdp.sent("Debugger.evaluateOnCallFrame")[0]!.params).toEqual({ callFrameId: "cf-1", expression, silent: true });
    // The site's own `debugger;` later: let go.
    cdp.emit("Debugger.paused", { reason: "other", callFrames: [{ callFrameId: "cf-2" }] }, "W1");
    await until(() => cdp.sent("Debugger.resume").length === 1);
    expect(cdp.sent("Debugger.evaluateOnCallFrame")).toHaveLength(1);
  });

  it("a service worker keeps its breakpoint: Chrome stops and starts it in the same session, and the guard goes in at every start (ws-sw-restart)", async () => {
    const { cdp, guard } = installer();
    await guard.setUp({ sessionId: "SW", type: "service_worker", url: "https://fansly.com/ngsw-worker.js" }, "worker", true);
    cdp.emit("Debugger.paused", { reason: "instrumentation", callFrames: [{ callFrameId: "cf-1" }] }, "SW");
    await until(() => cdp.sent("Debugger.resume").length === 1);
    expect(cdp.sent("Debugger.disable")).toEqual([]);
    // A later script of the same run: let go, no second guard.
    cdp.emit("Debugger.paused", { reason: "instrumentation", callFrames: [{ callFrameId: "cf-2" }] }, "SW");
    await until(() => cdp.sent("Debugger.resume").length === 2);
    expect(cdp.sent("Debugger.evaluateOnCallFrame")).toHaveLength(1);
    cdp.emit("Inspector.targetCrashed", {}, "SW");
    cdp.emit("Inspector.targetReloadedAfterCrash", {}, "SW");
    await until(() => cdp.sent("Runtime.runIfWaitingForDebugger").length === 1);
    cdp.emit("Debugger.paused", { reason: "instrumentation", callFrames: [{ callFrameId: "cf-3" }] }, "SW");
    await until(() => cdp.sent("Debugger.evaluateOnCallFrame").length === 2);
    expect(cdp.sent("Debugger.evaluateOnCallFrame")[1]!.params).toMatchObject({ callFrameId: "cf-3" });
  });

  it("a worker already running gets the guard at once, in its context", async () => {
    const { cdp, guard, expression } = installer();
    await guard.setUp({ sessionId: "W2", type: "shared_worker", url: "https://fansly.com/shared.js" }, "worker", false);
    expect(cdp.sent("Runtime.evaluate")[0]!.params).toEqual({ expression, silent: true });
  });

  it("a guard that throws in a worker stops the page; a worker that is gone does not", async () => {
    const { cdp, guard, failures } = installer();
    await guard.setUp({ sessionId: "W1", type: "worker", url: "https://fansly.com/a.js" }, "worker", true);
    await guard.setUp({ sessionId: "W2", type: "worker", url: "https://fansly.com/b.js" }, "worker", true);
    cdp.handlers.set("Debugger.evaluateOnCallFrame", (command) => (command.sessionId === "W1" ? { result: { type: "object" }, exceptionDetails: { text: "x" } } : { error: { code: -32001, message: "Session with given id not found." } }));
    cdp.emit("Debugger.paused", { reason: "instrumentation", callFrames: [{ callFrameId: "cf-1" }] }, "W1");
    cdp.emit("Debugger.paused", { reason: "instrumentation", callFrames: [{ callFrameId: "cf-2" }] }, "W2");
    await until(() => failures.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failures).toEqual([{ type: "worker", why: expect.stringContaining("the socket guard did not go into a worker") }]);
    // Neither is let run.
    expect(cdp.sent("Debugger.disable")).toEqual([]);
    expect(cdp.sent("Debugger.resume")).toEqual([]);
  });

  it("a setup command that fails fails the target's setup (it never runs)", async () => {
    const { cdp, guard } = installer();
    cdp.handlers.set("Page.addScriptToEvaluateOnNewDocument", () => ({ error: { code: -32000, message: "Not allowed" } }));
    await expect(guard.setUp({ sessionId: "S1", type: "page", url: "about:blank" }, "page", true)).rejects.toBeInstanceOf(CdpError);
    cdp.handlers.set("Runtime.addBinding", () => UNANSWERED);
    await expect(guard.setUp({ sessionId: "S2", type: "page", url: "about:blank" }, "page", true)).rejects.toThrow("no answer");
  });

  it("takes the guard's reports by its binding only, as untrusted text", async () => {
    const { cdp, guard, reports } = installer();
    await guard.setUp({ sessionId: "S1", type: "page", url: "about:blank" }, "page", true);
    cdp.emit("Runtime.bindingCalled", { name: "somethingElse", payload: '{"k":"installed","ws":true}' }, "S1");
    cdp.emit("Runtime.bindingCalled", { name: "pbBinding", payload: "garbage" }, "S1");
    cdp.emit("Runtime.bindingCalled", { name: "pbBinding", payload: '{"k":"installed","ws":true,"where":"https://fansly.com/"}' }, "S1");
    cdp.emit("Runtime.bindingCalled", { name: "pbBinding", payload: '{"k":"blocked_send","form":"text","len":4,"where":""}' }, "S1");
    expect(reports).toEqual([
      { report: { k: "installed", ws: true, where: "https://fansly.com/" }, target: { sessionId: "S1", type: "page" } },
      { report: { k: "blocked_send", where: "", shape: { form: "text", len: 4, msgType: null, keys: null, dKeys: null } }, target: { sessionId: "S1", type: "page" } },
    ]);
    expect(guard.installed).toBe(1);
  });
});


describe("the socket gate: spec §2.6 outside the page's JavaScript (Astra's review of PR 10, P1)", () => {
  /** An open connection whose page has no guard: Chrome writes whatever the
   *  page's native send gives it, as TLS 1.3 records. */
  async function unguarded(w: World): Promise<SocketTunnelClient> {
    const client = await opened(w);
    await client.answered();
    return client;
  }

  it("a forbidden message from a context the guard did not go into never reaches Fansly: held, the tunnel cut, the page killed with an alarm — the authorization and the pings before it went", async () => {
    const w = await world();
    const client = await unguarded(w);
    client.message(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.authorization);
    client.message(1, SOCKET_FILL.ping);
    client.message(1, SOCKET_FILL.ping);
    await until(() => w.server.received().includes(SOCKET_FILL.ping), 3000, "the pings at the server");
    expect(w.server.received().includes(SOCKET_FILL.authorization)).toBe(true);
    // A chat room's subscription: 40 bytes of payload.
    client.message(40, SOCKET_FILL.forbidden);
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(w.server.received().includes(SOCKET_FILL.forbidden)).toBe(false);
    expect(w.stops).toEqual([{ reason: "unknown_ws_message", note: expect.stringContaining("it was not sent"), how: "kill", exitOpen: true }]);
    expect(w.alarms).toEqual([{ kind: "unknown_ws_message", detail: { at: "proxy", recordBytes: TLS13_OVERHEAD + clientFrameBytes(40), why: "a message of no allowed size", left: false } }]);
    expect(w.records.at(-1)).toMatchObject({ cls: "ws", result: `cut: the socket gate held a record of ${TLS13_OVERHEAD + clientFrameBytes(40)} bytes (a message of no allowed size)` });
    expect(w.journal.at(-1)).toMatchObject({ event: "blocked", detail: expect.stringContaining("the socket gate held a record") });
  });

  it("coalesced frames — two messages in one record — fail closed", async () => {
    const w = await world();
    const client = await unguarded(w);
    client.message(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.authorization);
    await until(() => w.server.received().includes(SOCKET_FILL.authorization), 3000, "the authorization at the server");
    client.message([1, 1], SOCKET_FILL.ping);
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(w.server.received().includes(SOCKET_FILL.authorization)).toBe(true);
    expect(w.server.received().includes(SOCKET_FILL.ping)).toBe(false);
    expect(w.stops).toHaveLength(1);
  });

  it("records let up before a held one in the same write still go; the held one and what follows never do", async () => {
    const w = await world();
    const client = await unguarded(w);
    const record = (payload: number, fill: number) => Buffer.concat([Buffer.from([23, 3, 3, (TLS13_OVERHEAD + clientFrameBytes(payload) - 5) >> 8, (TLS13_OVERHEAD + clientFrameBytes(payload) - 5) & 0xff]), Buffer.alloc(TLS13_OVERHEAD + clientFrameBytes(payload) - 5, fill)]);
    client.socket.write(Buffer.concat([record(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.authorization), record(1, SOCKET_FILL.ping), record(30, SOCKET_FILL.forbidden), record(1, 0x78)]));
    await client.closed;
    await until(() => w.server.received().includes(SOCKET_FILL.ping), 3000, "the records before the held one");
    expect(w.server.received().includes(SOCKET_FILL.authorization)).toBe(true);
    expect(w.server.received().includes(SOCKET_FILL.forbidden)).toBe(false);
    expect(w.server.received().includes(0x78)).toBe(false);
  });

  it("the authorization goes once a connection: a second one is refused at once, the page stopped", async () => {
    const w = await world();
    const client = await unguarded(w);
    client.message(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.authorization);
    client.message(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.forbidden);
    await client.closed;
    expect(w.server.received().includes(SOCKET_FILL.forbidden)).toBe(false);
    expect(w.alarms[0]?.detail).toMatchObject({ why: "a second authorization-sized message on the connection" });
    expect(w.stops).toHaveLength(1);
  });

  // Plan-b §4.1.9: the site's session is observed over CDP through the
  // holder, its socket's bytes come through the proxy — nothing orders the
  // two. A record that may be the authorization under a token not observed
  // yet is held, never refused at once, and the exit never closes for it.
  it("an authorization before the site's session is observed is held, not refused: the session is read again, and once it is the record and what followed it go — nothing stops", async () => {
    const w = await world();
    w.session.token = null;
    const client = await unguarded(w);
    client.message(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.authorization);
    client.message(1, SOCKET_FILL.ping);
    await until(() => w.egress.socketHolds === 1 && w.refreshes.count === 1, 3000, "the record held, the session read again");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(w.server.received().includes(SOCKET_FILL.authorization)).toBe(false);
    expect(w.server.received().includes(SOCKET_FILL.ping)).toBe(false);
    // The site's session observed: decided again, it goes, the ping after it.
    w.session.token = SESSION_TOKEN;
    w.egress.socketRulesChanged();
    await until(() => w.server.received().includes(SOCKET_FILL.ping), 3000, "the authorization and the ping at the server");
    expect(w.server.received().includes(SOCKET_FILL.authorization)).toBe(true);
    expect(w.egress.socketHolds).toBe(0);
    expect([w.stops, w.alarms]).toEqual([[], []]);
    expect(w.egress.exitOpen).toBe(true);
    client.destroy();
  });

  it("an authorization under the site's new session, before its storage told it: held under the old size, it goes once the new one is observed", async () => {
    const w = await world();
    const NEW_TOKEN = `${SESSION_TOKEN}-a-new-login`;
    const client = await unguarded(w);
    client.message(authorizationBytes(NEW_TOKEN), SOCKET_FILL.authorization);
    await until(() => w.egress.socketHolds === 1, 3000, "the record held");
    // Something else changed meanwhile — not this token: still held.
    w.egress.socketRulesChanged();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.egress.socketHolds).toBe(1);
    expect(w.refreshes.count).toBe(1);
    w.session.token = NEW_TOKEN;
    w.egress.socketRulesChanged();
    await until(() => w.server.received().includes(SOCKET_FILL.authorization), 3000, "the authorization at the server");
    expect(w.stops).toEqual([]);
    client.destroy();
  });

  it("held past its bound: only that tunnel is cut, with an alarm — the exit stays open, the page goes on, and the site's next socket goes", async () => {
    const w = await world({ authHoldMs: 150 });
    w.session.token = null;
    const client = await unguarded(w);
    client.message(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.authorization);
    await client.closed;
    expect(w.server.received().includes(SOCKET_FILL.authorization)).toBe(false);
    expect(w.stops).toEqual([]);
    expect(w.egress.exitOpen).toBe(true);
    const recordBytes = TLS13_OVERHEAD + clientFrameBytes(authorizationBytes(SESSION_TOKEN));
    expect(w.alarms).toEqual([{ kind: "unknown_ws_message", detail: { at: "proxy", recordBytes, why: expect.stringContaining("no live session of the site known"), left: false, scope: "tunnel" } }]);
    await until(() => w.records.some((record) => record.cls === "ws" && record.result.startsWith(`cut: the socket gate held a record of ${recordBytes} bytes`)), 3000, "the tunnel's line");
    expect(w.records.find((record) => record.cls === "ws" && record.result.startsWith("cut:"))!.held).toBeGreaterThan(0);
    // The site's socket connects again, as it would.
    const next = await SocketTunnelClient.connect(w.proxyPort);
    expect(next.status).toBe(200);
    next.destroy();
  });

  it("a forbidden message before the authorization is held too — and never goes: past its bound its tunnel is cut (CDP's word on what left stops the page if it was not the authorization)", async () => {
    const w = await world({ authHoldMs: 150 });
    const client = await unguarded(w);
    client.message(40, SOCKET_FILL.forbidden);
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.server.received().includes(SOCKET_FILL.forbidden)).toBe(false);
    expect(w.alarms[0]).toMatchObject({ kind: "unknown_ws_message", detail: { scope: "tunnel", left: false } });
    // Chrome reports it written: its kind says what it was.
    w.cdp.emit("Network.webSocketFrameSent", { requestId: "WS1", response: { opcode: 1, payloadData: JSON.stringify({ t: 46001, d: "{}" }) } }, "S1");
    expect(w.stops).toEqual([{ reason: "unknown_ws_message", note: "an unknown socket message left the page past the guard", how: "kill", exitOpen: true }]);
  });

  it("Chrome's own control frames go: an empty pong or close, a close with its code (1001 when the page goes), TLS alerts; a pong echoing a ping's payload is held", async () => {
    const w = await world();
    const client = await unguarded(w);
    client.message(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.authorization);
    client.message(0, 0x61);
    client.message(2, 0x62);
    // A TLS 1.3 alert (close_notify): 24 bytes, too small for any frame.
    client.socket.write(Buffer.concat([Buffer.from([23, 3, 3, 0, 19]), Buffer.alloc(19, 0x63)]));
    client.socket.write(Buffer.concat([Buffer.from([21, 3, 3, 0, 2]), Buffer.alloc(2, 0x64)]));
    await until(() => w.server.received().includes(0x64), 3000, "the alert at the server");
    for (const fill of [0x61, 0x62, 0x63]) expect(w.server.received().includes(fill)).toBe(true);
    client.message(4, SOCKET_FILL.forbidden);
    await client.closed;
    expect(w.server.received().includes(SOCKET_FILL.forbidden)).toBe(false);
  });

  it("a socket whose TLS the gate cannot measure (a CBC suite) is cut before its handshake request", async () => {
    const w = await world({ tls12Suite: 0xc013 });
    const client = await SocketTunnelClient.connect(w.proxyPort);
    expect(client.status).toBe(200);
    client.socket.write(Buffer.concat([Buffer.from([22, 3, 3, 0, 195]), Buffer.alloc(195, SOCKET_FILL.clientHello)]));
    client.socket.resume();
    await client.closed;
    await until(() => w.records.length > 0, 3000, "the tunnel's line");
    expect(w.records.at(-1)).toMatchObject({ result: "cut: a TLS the socket gate cannot measure (1.2, suite 0xc013)" });
  });

  it("a tunnel that is not TLS is cut before anything goes", async () => {
    const w = await world();
    const client = await SocketTunnelClient.connect(w.proxyPort);
    expect(client.status).toBe(200);
    client.socket.write("GET /?v=3 HTTP/1.1\r\nHost: wsv3.fansly.com\r\nUpgrade: websocket\r\n\r\n");
    client.socket.resume();
    await client.closed;
    await until(() => w.records.length > 0, 3000, "the tunnel's line");
    expect(w.records.at(-1)).toMatchObject({ result: "cut: a socket's tunnel that is not TLS" });
    expect(w.server.received().includes(0x47)).toBe(false);
  });
});

describe("the holder's acknowledgement, and a restart after a crash (Astra's reviews of PR 10)", () => {
  /** The site socket's writes as a SocketBuffer over the real one: `holding`
   *  keeps their durability back until `release` (a slow disk — or the
   *  acknowledgements a crash never sent); once `crashed`, a write never
   *  reaches the file (the operator died before its commit). */
  class ControlledBuffer implements SocketBuffer {
    readonly inner: EventBuffer;
    holding = false;
    crashed = false;
    readonly held: Array<() => void> = [];
    constructor(inner: EventBuffer) {
      this.inner = inner;
    }
    #lost(): Appended {
      return { ok: true, durable: new Promise(() => undefined) };
    }
    #hold(appended: Appended): Appended {
      if (!appended.ok || !this.holding) return appended;
      return { ok: true, durable: appended.durable.then((durable) => new Promise((resolve) => this.held.push(() => resolve(durable)))) };
    }
    append(...args: Parameters<SocketBuffer["append"]>): Appended {
      return this.crashed ? this.#lost() : this.#hold(this.inner.append(...args));
    }
    appendGroup(...args: Parameters<SocketBuffer["appendGroup"]>): Appended {
      return this.crashed ? this.#lost() : this.#hold(this.inner.appendGroup(...args));
    }
    changeConnection(...args: Parameters<SocketBuffer["changeConnection"]>): Appended {
      return this.crashed ? this.#lost() : this.#hold(this.inner.changeConnection(...args));
    }
    release(): void {
      for (const resolve of this.held.splice(0)) resolve();
    }
    connections(): ReturnType<SocketBuffer["connections"]> {
      return this.inner.connections();
    }
    refusal(): ReturnType<SocketBuffer["refusal"]> {
      return this.inner.refusal();
    }
    get id(): string {
      return this.inner.id;
    }
    flush(): Promise<void> {
      return this.inner.flush();
    }
    get lastSeq(): number {
      return this.inner.lastSeq;
    }
    get lastWall(): number | null {
      return this.inner.lastWall;
    }
  }

  async function holderWorld() {
    const temp = tempDir("pb-ws-holder-");
    cleanups.push(temp.remove);
    setLogSink(() => undefined);
    const chrome = new FakeChrome();
    await chrome.boot();
    cleanups.push(() => chrome.close());
    const holder = new HolderUnderS6(join(temp.dir, "holder.sock"), chrome);
    await holder.start();
    cleanups.push(() => holder.stop());
    await until(() => chrome.live !== undefined, 3000, "the holder's DevTools connection");
    const openBuffer = (options: Partial<BufferOptions> = {}) => {
      const buffer = new EventBuffer({ dir: join(temp.dir, "buffer"), idFile: join(temp.dir, "buffer-id"), batchMs: 5, log: quiet, ...options });
      buffer.start();
      return buffer;
    };
    const stored = () => holder.holder!.stats.stored;
    return { chrome, holder, openBuffer, stored, dir: temp.dir };
  }

  async function operatorSide(holder: HolderUnderS6, buffer: SocketBuffer, extra: Partial<SocketDeps> = {}): Promise<{ cdp: Cdp; sockets: SiteSockets; observed: Observed[]; connectionOf: (index?: number) => string }> {
    const cdp = new Cdp({ socketPath: holder.socketPath, commandTimeoutMs: 500, log: quiet });
    const { observed, observe } = observing();
    const connections: string[] = [];
    const sockets = new SiteSockets({
      cdp,
      buffer,
      observe,
      sessionFingerprint: () => FINGERPRINT,
      authorizationBytes: () => authorizationBytes(SESSION_TOKEN),
      targetType: () => "page",
      socketHost: (host) => classifyFanslyHost(host) === "ws",
      journal: (line) => {
        if (line.event === "open") connections.push(line.connectionId!);
      },
      alarm: () => undefined,
      stop: () => undefined,
      log: quiet,
      ...extra,
    });
    cleanups.push(() => sockets.close());
    await cdp.connect();
    await cdp.replayEnded;
    const connectionOf = (index = 0) => connections[index]!;
    return { cdp, sockets, observed, connectionOf };
  }

  /** The proxy's tunnel of the latest socket (its events). */
  let tunnelOf: SocketTicket | null = null;

  /** A socket's CONNECT through the proxy (it goes on at once). */
  function tunnel(sockets: SiteSockets): SocketTicket {
    const ticket = sockets.openTunnel("wsv3.fansly.com", 443);
    ticket.event({ kind: "open" });
    tunnelOf = ticket;
    return ticket;
  }

  /** The site's socket as Chrome reports its handshake — and
   *  the request up its tunnel, as the proxy sees it; then the 101. */
  function handshake(chrome: FakeChrome, requestId: string): void {
    chrome.event("Network.webSocketCreated", { requestId, url: URL_WS }, "S1");
    chrome.event("Network.webSocketWillSendHandshakeRequest", { requestId, timestamp: monoMs() / 1000 }, "S1");
    tunnelOf?.event({ kind: "handshake_sent", mono: monoMs(), wall: Date.now() });
  }
  function answered(chrome: FakeChrome, requestId: string): void {
    chrome.event("Network.webSocketHandshakeResponseReceived", { requestId, timestamp: monoMs() / 1000, response: { status: 101, headers: {} } }, "S1");
  }
  function frame(chrome: FakeChrome, text: string, requestId = "WS1"): void {
    chrome.event("Network.webSocketFrameReceived", { requestId, timestamp: monoMs() / 1000, response: { opcode: 1, mask: false, payloadData: JSON.stringify({ t: 2, d: text }) } }, "S1");
  }

  const eventsOf = (buffer: EventBuffer) => buffer.readEvents(0, 1000, 10_000_000).map((event) => JSON.parse(event.json) as Record<string, unknown>);

  it("a frame is acknowledged to the holder only once it is durable", async () => {
    const { chrome, holder, openBuffer, stored } = await holderWorld();
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    const controlled = new ControlledBuffer(buffer);
    const { cdp, sockets } = await operatorSide(holder, controlled);
    cleanups.push(() => cdp.close());
    tunnel(sockets);
    handshake(chrome, "WS1");
    answered(chrome, "WS1");
    await until(() => eventsOf(buffer).length === 1 && stored() === 0, 3000, "the open kept and acknowledged");
    controlled.holding = true;
    frame(chrome, "f-1");
    await until(() => controlled.held.length === 1, 3000, "the frame's write");
    // Written, not yet durable — as long as an fsync takes: the holder keeps it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stored()).toBe(1);
    controlled.release();
    await until(() => stored() === 0, 3000, "the acknowledgement after the write is durable");
    expect(eventsOf(buffer).map((event) => event.kind)).toEqual(["ws.open", "ws.in"]);
  });
});

