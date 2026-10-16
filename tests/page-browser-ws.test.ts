import { existsSync } from "node:fs";
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
import { chromeToOperator, tightestOf } from "../apps/page-browser/src/cdp/chrome-clock.ts";
import { Cdp, CdpError } from "../apps/page-browser/src/cdp/client.ts";
import { classifyFanslyHost } from "../apps/page-browser/src/egress/hosts.ts";
import { Egress, type SocketTicket, type TunnelRecord } from "../apps/page-browser/src/egress/proxy.ts";
import { authorizationBytes, clientFrameBytes, recordOverhead, SocketRecordGate } from "../apps/page-browser/src/egress/socket-gate.ts";
import type { SocketLine } from "../apps/page-browser/src/logs/journal.ts";
import { makeLog, monoMs, setLogSink } from "../apps/page-browser/src/shared/util.ts";
import { guardExpression } from "../apps/page-browser/src/ws/guard.ts";
import { GuardInstaller } from "../apps/page-browser/src/ws/install.ts";
import { BoundaryFile } from "../apps/page-browser/src/ws/boundary.ts";
import { CALIBRATION_MAX_MS, CALIBRATION_WAIT_MS, SOCKET_PAIR_WAIT_MS, SiteSockets, type SocketBuffer, type SocketDeps, type SocketTimings } from "../apps/page-browser/src/ws/sockets.ts";
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
  tlsRecord,
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

/** The real buffer, its commits failing while `control.failing` (each
 *  group held until the test fails it, as a commit that fails takes all it
 *  carried), then taking nothing while `control.full` — a disk that failed. */
function failingCommits(inner: EventBuffer, control: { failing: boolean; pending: Array<() => void>; full: boolean }): SocketBuffer {
  const held = (): Appended => ({ ok: true, durable: new Promise((resolve) => control.pending.push(() => resolve({ ok: false, reason: "disk_full" }))) });
  return {
    append: (...args) => (control.full ? { ok: false, reason: "disk_full" } : control.failing ? held() : inner.append(...args)),
    appendGroup: (items) => (control.full ? { ok: false, reason: "disk_full" } : control.failing ? held() : inner.appendGroup(items)),
    changeConnection: (change) => inner.changeConnection(change),
    connections: () => inner.connections(),
    refusal: () => (control.full ? "disk_full" : inner.refusal()),
    flush: () => inner.flush(),
    get lastSeq() {
      return inner.lastSeq;
    },
    get lastWall() {
      return inner.lastWall;
    },
    get id() {
      return inner.id;
    },
  };
}

/** Lets what waits on promises run (a session's calibration). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

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

describe("the site's socket goes as a browser's (variant Б, plan-b §4.1.9)", () => {
  it("its CONNECT goes on at once — nothing waits for the engine — and its handshake is a send of the site's: told at the proxy's write, its end at CDP's answer", async () => {
    const w = await world();
    const startedAt = monoMs();
    const client = await opened(w);
    // The engine heard the send and its 101; nothing was asked of it.
    expect(w.observed).toEqual([
      { type: "sent", id: expect.any(String), url: URL_WS, sentMono: expect.any(Number) },
      { type: "ended", id: w.observed[0]!.id, status: 101, error: null },
    ]);
    const sent = w.observed[0] as Extract<Observed, { type: "sent" }>;
    expect(sent.sentMono).toBeGreaterThanOrEqual(startedAt);
    expect(sent.sentMono).toBeLessThanOrEqual(monoMs());
    await w.buffer.flush();
    await until(() => w.events().length === 1, 3000, "the open durable");
    expect(w.connectionOf()).toBe(sent.id);
    expect(w.events()[0]).toEqual({ seq: 1, atMono: expect.any(Number), atWall: expect.any(Number), kind: "ws.open", connectionId: w.connectionOf(), attemptId: 0, sessionFingerprint: FINGERPRINT });
    // Kept in the buffer from its open: a restart ends it.
    expect(w.buffer.connections()).toEqual([{ connectionId: w.connectionOf(), attemptId: 0, opened: true }]);
    expect(w.journal.find((line) => line.event === "open")).toMatchObject({ connectionId: w.connectionOf(), status: 101 });
    client.destroy();
  });

  it.each([
    ["an answer of 401", { kind: "answer", status: 401 }, 401],
    ["an answer of 429", { kind: "answer", status: 429 }, 429],
    ["a handshake error with its code", { kind: "error", message: "Error during WebSocket handshake: Unexpected response code: 403" }, 403],
  ] as const)("%s: its end goes to the engine with the status (the engine holds `ws.upgrade` or the credentials), nothing is opened in the stream", async (_name, end, status) => {
    const w = await world();
    const client = await SocketTunnelClient.connect(w.proxyPort);
    expect(client.status).toBe(200);
    await client.tls();
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1", timestamp: monoMs() / 1000 }, "S1");
    client.request();
    await until(() => w.server.received().includes(SOCKET_FILL.request), 3000, "the handshake request at the server");
    await client.answered();
    if (end.kind === "answer") {
      w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", timestamp: monoMs() / 1000, response: { status: end.status } }, "S1");
      w.cdp.emit("Network.webSocketFrameError", { requestId: "WS1", errorMessage: `Unexpected response code: ${end.status}` }, "S1");
    } else {
      w.cdp.emit("Network.webSocketFrameError", { requestId: "WS1", errorMessage: end.message }, "S1");
    }
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    // The session's first events wait for its calibration (the stamps).
    await until(() => w.observed.some((one) => one.type === "ended"), 3000, "the end told");
    await settle();
    const ends = w.observed.filter((one) => one.type === "ended");
    expect(ends).toEqual([{ type: "ended", id: w.observed[0]!.id, status, error: end.kind === "answer" ? null : expect.any(String) }]);
    await w.buffer.flush();
    expect(w.events()).toEqual([]);
    expect(w.buffer.connections()).toEqual([]);
    expect(w.stops).toEqual([]);
    client.destroy();
  });

  it.each(["before", "after"])("sentMono is the proxy's write when CDP announces the handshake %s it; neither is told twice", async (when) => {
    const w = await world();
    const ticket = w.sockets.openTunnel("wsv3.fansly.com", 443);
    const proxyMono = monoMs() - (when === "after" ? 100 : 0);
    if (when === "after") ticket.event({ kind: "handshake_sent", mono: proxyMono, wall: Date.now() });
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1", timestamp: monoMs() / 1000 }, "S1");
    if (when === "before") {
      expect(w.observed).toEqual([]);
      ticket.event({ kind: "handshake_sent", mono: proxyMono, wall: Date.now() });
    }
    const id = w.observed[0]!.id;
    expect(id).not.toBe(ticket.id);
    expect(w.observed).toEqual([{ type: "sent", id, url: URL_WS, sentMono: proxyMono }]);
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", timestamp: monoMs() / 1000, response: { status: 101 } }, "S1");
    ticket.event({ kind: "handshake_sent", mono: proxyMono + 100, wall: Date.now() });
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1");
    await settle();
    expect(w.observed).toHaveLength(2);
    expect(w.observed[1]).toEqual({ type: "ended", id, status: 101, error: null });
    expect(w.connectionOf()).toBe(id);
  });

  it("a NewSessionTicket-like record before the 101 ends nothing and gives no other socket its status", async () => {
    const w = await world({ serverAnswer: false });
    const client = await SocketTunnelClient.connect(w.proxyPort);
    cleanups.push(() => client.destroy());
    await client.tls();
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1");
    client.request();
    await until(() => w.observed.length === 1, 3000, "the proxy's write");
    w.server.send(tlsRecord(23, 100, 0x66));
    await until(() => Buffer.concat(client.inbound).includes(0x66), 3000, "the ticket at Chrome");
    const first = w.observed[0]!.id;
    expect(w.observed.map((one) => one.type)).toEqual(["sent"]);
    const ticket = w.sockets.openTunnel("wsv3.fansly.com", 443);
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS2", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS2" }, "S1");
    ticket.event({ kind: "handshake_sent", mono: monoMs(), wall: Date.now() });
    const second = w.observed[1]!.id;
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS2", response: { status: 101 } }, "S1");
    expect(w.observed.filter((one) => one.type === "ended")).toEqual([{ type: "ended", id: second, status: 101, error: null }]);
    w.server.send(tlsRecord(23, 150, 0x55));
    await client.answered();
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", response: { status: 101 } }, "S1");
    expect(w.observed.at(-1)).toEqual({ type: "ended", id: first, status: 101, error: null });
  });

  it.each(["close", "error"])("an unanswered tunnel's end waits for its own CDP %s; another socket's 101 ends only that socket", async (how) => {
    const w = await world();
    const a = w.sockets.openTunnel("wsv3.fansly.com", 443);
    const b = w.sockets.openTunnel("wsv3.fansly.com", 443);
    for (const [requestId, ticket] of [["WS-A", a], ["WS-B", b]] as const) {
      w.cdp.emit("Network.webSocketCreated", { requestId, url: URL_WS }, "S1");
      w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId }, "S1");
      ticket.event({ kind: "handshake_sent", mono: monoMs(), wall: Date.now() });
    }
    const [first, second] = w.observed;
    a.event({ kind: "ended", result: "server closed", handshakeSent: true });
    expect(w.observed.map((one) => one.type)).toEqual(["sent", "sent"]);
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS-B", response: { status: 101 } }, "S1");
    if (how === "close") w.cdp.emit("Network.webSocketClosed", { requestId: "WS-A" }, "S1");
    else w.cdp.emit("Network.webSocketFrameError", { requestId: "WS-A", errorMessage: "connection reset" }, "S1");
    expect(w.observed.filter((one) => one.type === "ended")).toEqual([
      { type: "ended", id: second!.id, status: 101, error: null },
      { type: "ended", id: first!.id, status: null, error: how === "close" ? "the socket closed before its handshake's answer" : "connection reset" },
    ]);
  });

  it.each(["close", "error"])("a socket's %s while waiting wrote nothing: no send and no end; the next write stays unclaimed", async (how) => {
    const w = await world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1");
    if (how === "close") w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    else w.cdp.emit("Network.webSocketFrameError", { requestId: "WS1", errorMessage: "connection reset" }, "S1");
    expect(w.observed).toEqual([]);
    const ticket = w.sockets.openTunnel("wsv3.fansly.com", 443);
    ticket.event({ kind: "handshake_sent", mono: monoMs(), wall: Date.now() });
    expect(w.observed).toEqual([]);
    await vi.advanceTimersByTimeAsync(SOCKET_PAIR_WAIT_MS);
    expect(w.observed).toMatchObject([{ type: "sent", id: ticket.id }, { type: "ended", id: ticket.id, status: null, error: "a socket CDP did not show" }]);
  });

  it("a 401 taken while its frames wait for a calibration ends its own send at once", async () => {
    const w = await world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    w.cdp.handlers.set("Performance.getMetrics", () => new Promise(() => undefined));
    const ticket = w.sockets.openTunnel("wsv3.fansly.com", 443);
    const sentMono = monoMs();
    ticket.event({ kind: "handshake_sent", mono: sentMono, wall: Date.now() });
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1");
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", response: { status: 401 } }, "S1");
    expect(w.observed).toEqual([
      { type: "sent", id: expect.any(String), url: URL_WS, sentMono },
      { type: "ended", id: w.observed[0]!.id, status: 401, error: null },
    ]);
    await vi.advanceTimersByTimeAsync(SOCKET_PAIR_WAIT_MS);
    expect(w.observed).toHaveLength(2);
  });

  it.each([false, true])("an answer while waiting uses the latest proxy moment, else its take (a moment seen: %s)", async (seen) => {
    const w = await world();
    let latest: number | null = null;
    if (seen) {
      w.cdp.emit("Network.webSocketCreated", { requestId: "WS-A", url: URL_WS }, "S1");
      w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS-A" }, "S1");
      latest = monoMs() - 100;
      w.sockets.openTunnel("wsv3.fansly.com", 443).event({ kind: "handshake_sent", mono: latest, wall: Date.now() });
    }
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS-B", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS-B" }, "S1");
    const before = monoMs();
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS-B", response: { status: 429 } }, "S1");
    const send = w.observed.at(-2) as Extract<Observed, { type: "sent" }>;
    if (latest !== null) expect(send.sentMono).toBe(latest);
    else {
      expect(send.sentMono).toBeGreaterThanOrEqual(before);
      expect(send.sentMono).toBeLessThanOrEqual(monoMs());
    }
    expect(w.observed.at(-1)).toEqual({ type: "ended", id: send.id, status: 429, error: null });
  });

  it.each(["open", "ended", "refused"])("a socket CDP never shows is reported and ended after 2 s, even if its tunnel is %s", async (how) => {
    const w = await world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ticket = w.sockets.openTunnel("wsv3.fansly.com", 443);
    const sentMono = monoMs();
    ticket.event({ kind: "handshake_sent", mono: sentMono, wall: Date.now() });
    if (how === "ended") ticket.event({ kind: "ended", result: "server closed", handshakeSent: true });
    if (how === "refused") ticket.event({ kind: "refused", recordBytes: 100, why: "authorization wait expired", late: true });
    await vi.advanceTimersByTimeAsync(SOCKET_PAIR_WAIT_MS - 1);
    expect(w.observed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.observed).toEqual([
      { type: "sent", id: ticket.id, url: "wss://wsv3.fansly.com/", sentMono },
      { type: "ended", id: ticket.id, status: null, error: "a socket CDP did not show" },
    ]);
    ticket.event({ kind: "ended", result: "server closed", handshakeSent: true });
    await vi.advanceTimersByTimeAsync(SOCKET_PAIR_WAIT_MS);
    expect(w.observed).toHaveLength(2);
  });

  it.each(["writes first", "CDP first"])("two concurrent handshakes (%s): every write moment is reported, each socket keeps its 401/429", async (order) => {
    const w = await world();
    const a = w.sockets.openTunnel("wsv3.fansly.com", 443);
    const b = w.sockets.openTunnel("wsv3.fansly.com", 443);
    const moments = [monoMs() - 20, monoMs() - 10];
    const write = () => {
      a.event({ kind: "handshake_sent", mono: moments[0]!, wall: Date.now() });
      b.event({ kind: "handshake_sent", mono: moments[1]!, wall: Date.now() });
    };
    if (order === "writes first") write();
    for (const requestId of ["WS1", "WS2"]) {
      w.cdp.emit("Network.webSocketCreated", { requestId, url: URL_WS }, "S1");
      w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId }, "S1");
    }
    if (order === "CDP first") write();
    const sends = w.observed.filter((one) => one.type === "sent");
    expect(sends.map((one) => one.sentMono)).toEqual(order === "writes first" ? [...moments].reverse() : moments);
    expect(new Set(sends.map((one) => one.id)).size).toBe(2);
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS2", response: { status: 429 } }, "S1");
    w.cdp.emit("Network.webSocketFrameError", { requestId: "WS2", errorMessage: "Unexpected response code: 429" }, "S1");
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS2", response: { status: 429 } }, "S1");
    w.cdp.emit("Network.webSocketFrameError", { requestId: "WS1", errorMessage: "Unexpected response code: 401" }, "S1");
    expect(w.observed.filter((one) => one.type === "ended")).toEqual([
      { type: "ended", id: sends[1]!.id, status: 429, error: null },
      { type: "ended", id: sends[0]!.id, status: 401, error: "Unexpected response code: 401" },
    ]);
  });

  it("a worker goes after its socket's send: its handshake is ended once, with its status unknown; a replayed detach ends nothing", async () => {
    const w = await world();
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, "W1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "W1");
    const sentMono = monoMs();
    w.sockets.openTunnel("wsv3.fansly.com", 443).event({ kind: "handshake_sent", mono: sentMono, wall: Date.now() });
    await until(() => w.sockets.clockOf("W1") !== null, 3000, "the worker's events taken");
    w.cdp.emit("Target.detachedFromTarget", { sessionId: "W1" }, "S1", true);
    expect(w.observed).toEqual([{ type: "sent", id: expect.any(String), url: URL_WS, sentMono }]);
    const detaches: number[] = [];
    w.cdp.on("Target.detachedFromTarget", (event) => detaches.push(event.seq));
    w.cdp.emit("Target.detachedFromTarget", { sessionId: "W1" }, "S1");
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", response: { status: 101 } }, "W1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "W1");
    w.cdp.emit("Target.detachedFromTarget", { sessionId: "W1" }, "S1");
    w.sockets.endAll("a test");
    await w.buffer.flush();
    expect(w.observed).toEqual([
      { type: "sent", id: expect.any(String), url: URL_WS, sentMono },
      { type: "ended", id: w.observed[0]!.id, status: null, error: "its target went" },
    ]);
    expect(w.events()).toEqual([]);
    expect(w.cdp.heldAcks.has("Target.detachedFromTarget")).toBe(false);
    expect(detaches.every((seq) => !w.cdp.acks.includes(seq))).toBe(true);
  });

  it("Chrome gone reports unclaimed writes first, ends every reported socket, drops waiters and clears timers", async () => {
    const w = await world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1");
    w.sockets.openTunnel("wsv3.fansly.com", 443).event({ kind: "handshake_sent", mono: monoMs(), wall: Date.now() });
    const reported = w.observed[0]!.id;
    const unshown = w.sockets.openTunnel("wsv3.fansly.com", 443);
    unshown.event({ kind: "handshake_sent", mono: monoMs(), wall: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    w.sockets.endAll("control lost");
    expect(vi.getTimerCount()).toBe(0);
    expect(w.observed.slice(1)).toMatchObject([
      { type: "sent", id: unshown.id },
      { type: "ended", id: unshown.id, status: null, error: "a socket CDP did not show" },
      { type: "ended", id: reported, status: null, error: "the page stopped: control lost" },
    ]);
    await w.sockets.chromeStarting();
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS2", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS2" }, "S1");
    w.sockets.endAll("control lost again");
    await vi.advanceTimersByTimeAsync(SOCKET_PAIR_WAIT_MS);
    expect(w.observed).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closing the observer clears unclaimed writes' timers", async () => {
    const w = await world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ticket = w.sockets.openTunnel("wsv3.fansly.com", 443);
    ticket.event({ kind: "handshake_sent", mono: monoMs(), wall: Date.now() });
    w.sockets.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SOCKET_PAIR_WAIT_MS);
    expect(w.observed).toEqual([]);
  });

  it("two sockets at once each go and each are their own connection; a socket of another host is none of this path's", async () => {
    const w = await world();
    const a = await opened(w, "WS1");
    const b = await opened(w, "WS2", "S2");
    w.cdp.emit("Network.webSocketCreated", { requestId: "OTHER", url: "wss://chatws.fansly.com/" }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "OTHER", timestamp: monoMs() / 1000 }, "S1");
    await settle();
    expect(w.observed.filter((one) => one.type === "sent")).toHaveLength(2);
    expect(w.connectionOf(0)).not.toBe(w.connectionOf(1));
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS2", response: { opcode: 1, payloadData: '{"t":2,"d":"b"}' } }, "S2");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"a"}' } }, "S1");
    await w.buffer.flush();
    await until(() => w.events().length === 4, 3000, "both opens and frames");
    expect(w.events().map((event) => [event.kind, event.connectionId])).toEqual([
      ["ws.open", w.connectionOf(0)],
      ["ws.open", w.connectionOf(1)],
      ["ws.in", w.connectionOf(1)],
      ["ws.in", w.connectionOf(0)],
    ]);
    expect(w.sockets.openConnections).toBe(2);
    a.destroy();
    b.destroy();
  });

  it("a socket before the site's session keeps its verification and frames, in order under its own open, before a later frame", async () => {
    const w = await world();
    w.session.fingerprint = null;
    const client = await opened(w);
    await until(() => w.sockets.clockOf("S1") !== null, 3000, "the session's calibration");
    const seqs: number[] = [];
    w.cdp.on("Network.webSocketFrameReceived", (event) => seqs.push(event.seq));
    const frames = ['{"t":1,"d":{}}', '{"t":2,"d":"early-1"}', '{"t":2,"d":"early-2"}'];
    const seen = monoMs() - 5_000;
    for (const [index, payloadData] of frames.entries()) w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", timestamp: (seen + index * 1_000) / 1000, response: { opcode: 1, payloadData } }, "S1");
    await w.buffer.flush();
    expect(w.events()).toEqual([]);
    expect(seqs.every((seq) => !w.cdp.acks.includes(seq))).toBe(true);
    expect(w.journal.find((line) => line.event === "unkept")).toMatchObject({ connectionId: w.connectionOf() });
    w.session.fingerprint = FINGERPRINT;
    w.sockets.sessionKnown();
    w.sockets.sessionKnown();
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"kept"}' } }, "S1");
    await w.buffer.flush();
    await until(() => w.events().length === 6 && seqs.every((seq) => w.cdp.acks.includes(seq)), 3000, "the gap, the open and every frame durable and acknowledged");
    expect(w.events()).toMatchObject([
      { kind: "gap", reason: "ws_reconnect", fromSeq: null, fromWall: null },
      { kind: "ws.open", connectionId: w.connectionOf(), sessionFingerprint: FINGERPRINT },
      ...[...frames, '{"t":2,"d":"kept"}'].map((frame) => ({ kind: "ws.in", connectionId: w.connectionOf(), frame })),
    ]);
    for (const [index, event] of w.events().slice(2, 5).entries()) {
      expect(event.atMono as number).toBeLessThanOrEqual(seen + index * 1_000);
      expect(event.atMono as number).toBeGreaterThanOrEqual(seen + index * 1_000 - w.sockets.clockOf("S1")!.spread - 1);
    }
    for (const seq of seqs) expect(w.cdp.acks.filter((ack) => ack === seq)).toHaveLength(1);
    client.destroy();
  });

  it("a 101 and frame before the site's session keep their own stamps; the next reconnect starts from that frame", async () => {
    const w = await world();
    w.session.fingerprint = null;
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, "S1");
    await until(() => w.sockets.clockOf("S1") !== null, 3000, "the session's calibration");
    const answer = { mono: monoMs() - 10_000, wall: Date.now() - 10_000 };
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", timestamp: answer.mono / 1000, response: { status: 101 } }, "S1");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", timestamp: (answer.mono + 1_000) / 1000, response: { opcode: 1, payloadData: "before the session was known" } }, "S1");
    await w.buffer.flush();
    expect(w.events()).toEqual([]);
    w.session.fingerprint = FINGERPRINT;
    w.sockets.sessionKnown();
    await until(() => w.events().length === 3, 3000, "the first gap, the deferred open and frame");
    const open = w.events()[1]!;
    const frame = w.events()[2]!;
    const spread = w.sockets.clockOf("S1")!.spread;
    expect(open.atMono as number).toBeLessThanOrEqual(answer.mono);
    expect(open.atMono as number).toBeGreaterThanOrEqual(answer.mono - spread - 1);
    expect(open.atWall as number).toBeLessThanOrEqual(answer.wall + 1);
    expect(open.atWall as number).toBeGreaterThanOrEqual(answer.wall - spread - 2);
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1", timestamp: monoMs() / 1000 }, "S1");
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS2", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS2", timestamp: monoMs() / 1000, response: { status: 101 } }, "S1");
    await until(() => w.events().length === 6, 3000, "the close and the next connection's gap and open");
    expect(w.events().map((event) => event.kind)).toEqual(["gap", "ws.open", "ws.in", "ws.close", "gap", "ws.open"]);
    const gaps = w.events().filter((event) => event.kind === "gap");
    expect(gaps[1]).toMatchObject({ reason: "ws_reconnect", fromSeq: frame.seq, fromWall: frame.atWall });
    expect(gaps[1]!.fromWall as number).toBeLessThanOrEqual(answer.wall + 1_001);
  });

  it.each(["closed", "detached", "Chrome gone"])("a socket %s before the session drops its held frames and acknowledges each once, leaving the loss covered", async (how) => {
    const w = await world();
    w.session.fingerprint = null;
    const client = await opened(w);
    await until(() => w.sockets.clockOf("S1") !== null, 3000, "the session's calibration");
    const seqs: number[] = [];
    w.cdp.on("Network.webSocketFrameReceived", (event) => seqs.push(event.seq));
    for (const payloadData of ['{"t":1,"d":{}}', "early-1", "early-2"]) w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData } }, "S1");
    expect(seqs.every((seq) => !w.cdp.acks.includes(seq))).toBe(true);
    if (how === "closed") w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    else if (how === "detached") w.cdp.emit("Target.detachedFromTarget", { sessionId: "S1" });
    else w.sockets.endAll("a test");
    await w.buffer.flush();
    await until(() => seqs.every((seq) => w.cdp.acks.includes(seq)), 3000, "the dropped frames acknowledged");
    expect(w.events().filter((event) => event.kind !== "gap")).toEqual([]);
    w.session.fingerprint = FINGERPRINT;
    w.sockets.sessionKnown();
    await w.buffer.flush();
    expect(w.events().filter((event) => event.kind !== "gap")).toEqual([]);
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS2", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS2", response: { status: 101 } }, "S1");
    await until(() => w.events().some((event) => event.kind === "ws.open"), 3000, "the next open and its gap");
    expect(w.events().filter((event) => event.kind === "gap")).toContainEqual(expect.objectContaining({ reason: "ws_reconnect", fromSeq: null, fromWall: null }));
    for (const seq of seqs) expect(w.cdp.acks.filter((ack) => ack === seq)).toHaveLength(1);
    client.destroy();
  });

  it.each(["1000 frames", "4 MiB"])("before the session, %s is the bound: passing it drops everything held, acknowledges it, and starts the loss before it", async (bound) => {
    const w = await world();
    w.session.fingerprint = null;
    const client = await opened(w);
    await until(() => w.sockets.clockOf("S1") !== null, 3000, "the session's calibration");
    const seqs: number[] = [];
    w.cdp.on("Network.webSocketFrameReceived", (event) => seqs.push(event.seq));
    const frameCount = bound === "1000 frames" ? 1000 : 1;
    // Non-ASCII text: the cap counts bytes, not JavaScript characters.
    const payloadData = bound === "1000 frames" ? "early" : "я".repeat(2 * 1024 * 1024);
    for (let index = 0; index < frameCount; index += 1) w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData } }, "S1");
    expect(seqs.every((seq) => !w.cdp.acks.includes(seq))).toBe(true);
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: "past the bound" } }, "S1");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: "still dropped" } }, "S1");
    await until(() => seqs.every((seq) => w.cdp.acks.includes(seq)), 3000, "every dropped frame acknowledged");
    w.session.fingerprint = FINGERPRINT;
    w.sockets.sessionKnown();
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: "after the session" } }, "S1");
    await until(() => w.events().length === 3, 3000, "the gap, open and later frame");
    expect(w.events()).toMatchObject([
      { kind: "gap", reason: "ws_reconnect", fromSeq: null, fromWall: null },
      { kind: "ws.open", connectionId: w.connectionOf() },
      { kind: "ws.in", connectionId: w.connectionOf(), frame: "after the session" },
    ]);
    for (const seq of seqs) expect(w.cdp.acks.filter((ack) => ack === seq)).toHaveLength(1);
    client.destroy();
  });

  it("the site's socket is no less the site's in any mode: the proxy refuses none, and only the exit closed stops its CONNECT", async () => {
    const w = await world();
    const first = await SocketTunnelClient.connect(w.proxyPort);
    const second = await SocketTunnelClient.connect(w.proxyPort);
    expect([first.status, second.status]).toEqual([200, 200]);
    w.egress.closeExit("a test");
    expect((await SocketTunnelClient.connect(w.proxyPort)).status).toBe(403);
    await until(() => w.records.some((record) => record.result === "refused: exit closed"), 3000, "the refusal journaled");
    first.destroy();
    second.destroy();
  });
});

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

  it("go from CDP into the buffer, durable and in order: ws.open under the session, every text frame as it is, ws.close", async () => {
    const w = await world();
    const client = await opened(w, "WS1");
    const frames = Array.from({ length: 300 }, (_, n) => JSON.stringify({ t: 2, d: JSON.stringify({ n, marker: FRAME_SECRET }) }));
    for (const payloadData of frames) w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, mask: false, payloadData } }, "S1");
    // A binary frame is counted, not kept.
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 2, payloadData: "AAEC" } }, "S1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    await w.buffer.flush();
    await until(() => w.events().length === 302, 3000, "every event durable");
    const events = w.events();
    const connectionId = w.connectionOf();
    expect(events[0]).toEqual({ seq: 1, atMono: expect.any(Number), atWall: expect.any(Number), kind: "ws.open", connectionId, attemptId: 0, sessionFingerprint: FINGERPRINT });
    expect(events.slice(1, 301).map((event) => event.frame)).toEqual(frames);
    expect(events.slice(1, 301).every((event) => event.kind === "ws.in" && event.connectionId === connectionId)).toBe(true);
    expect(events[301]).toMatchObject({ seq: 302, kind: "ws.close", connectionId, code: null, reason: null });
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 302 }, (_, n) => n + 1));
    expect(w.buffer.connections()).toEqual([]);
    client.destroy();
  });

  it.each(["CDP's close", "the browser going (endAll)"])("Astra's round 5: an open whose commit fails is tried again whatever becomes of the socket — after %s, the open lands, then the close", async (how) => {
    const control = { failing: false, pending: [] as Array<() => void>, full: false };
    const w = await world({ buffer: (inner) => failingCommits(inner, control) });
    control.failing = true;
    await opened(w, "WS1");
    // Before the commit: the socket closes, or the browser goes under it.
    if (how === "CDP's close") w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    else w.sockets.endAll("buffer full");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The commit fails (the disk), and the buffer takes nothing until room.
    for (const fail of control.pending.splice(0)) fail();
    control.failing = false;
    control.full = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.events()).toEqual([]);
    control.full = false;
    w.sockets.retryNow();
    await until(() => w.events().some((event) => event.kind === "ws.close"), 3000, "the close");
    const kinds = w.events().map((event) => `${String(event.kind)}${event.kind === "gap" ? `:${String(event.reason)}` : ""}`);
    expect(kinds).toEqual(how === "CDP's close" ? ["ws.open", "ws.close"] : ["ws.open", "gap:chrome_restart", "ws.close"]);
    expect(w.buffer.connections()).toEqual([]);
    expect(w.sockets.unwritten).toBe(0);
  });

  it("an open the buffer refused is tried again; a close that comes before its retry waits for it — the close is never before its open", async () => {
    const control = { failing: false, pending: [] as Array<() => void>, full: false };
    const w = await world({ buffer: (inner) => failingCommits(inner, control), timings: { retryMs: [60_000] } });
    control.full = true;
    await opened(w, "WS1");
    // Room again — and CDP's close comes before the open is tried again.
    control.full = false;
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await w.buffer.flush();
    expect(w.events()).toEqual([]);
    w.sockets.retryNow();
    await until(() => w.events().length === 2, 3000, "the open, then the close");
    expect(w.events().map((event) => event.kind)).toEqual(["ws.open", "ws.close"]);
    expect(w.buffer.connections()).toEqual([]);
  });

  it("frames of a socket CDP did not show being created are dropped, counted — nothing fails", async () => {
    const w = await world();
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "GHOST", response: { opcode: 1, payloadData: '{"t":2,"d":"x"}' } }, "S1");
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "GHOST", response: { status: 101 } }, "S1");
    await until(() => w.lines.some((line) => line.includes("event.dropped")), 3000, "dropped");
    await w.buffer.flush();
    expect(w.events()).toEqual([]);
    expect(w.stops).toEqual([]);
    expect(w.lines.some((line) => line.includes("event.dropped"))).toBe(true);
  });
});

describe("gaps (plan §4.4, step 6; spec §6.1)", () => {
  it.each(["A first", "B first"])("two open connections, %s ends: A's late frame dropped after its target goes stays under A's boundary, before B's later pong", async (order) => {
    const w = await world();
    const a = await opened(w, "WS1", "S2");
    const b = await opened(w, "WS2", "S1");
    await until(() => w.sockets.clockOf("S1") !== null && w.sockets.clockOf("S2") !== null, 3000, "both sessions calibrated");
    const seen = monoMs() - 10_000;
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", timestamp: seen / 1000, response: { opcode: 1, payloadData: "A at 10" } }, "S2");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS2", timestamp: (seen + 2_000) / 1000, response: { opcode: 1, payloadData: '{"t":0}' } }, "S1");
    await until(() => w.events().length === 4, 3000, "both opens and frames saved");
    const lastA = w.events()[2]!;
    const lastB = w.events()[3]!;
    expect(lastB.atWall as number).toBeGreaterThan(lastA.atWall as number);
    if (order === "B first") w.cdp.emit("Network.webSocketClosed", { requestId: "WS2", timestamp: monoMs() / 1000 }, "S1");
    w.cdp.emit("Target.detachedFromTarget", { sessionId: "S2" }, "S1");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", timestamp: (seen + 1_000) / 1000, response: { opcode: 1, payloadData: "A at 11, delivered after the detach" } }, "S2");
    if (order === "A first") w.cdp.emit("Network.webSocketClosed", { requestId: "WS2", timestamp: monoMs() / 1000 }, "S1");
    const next = await opened(w, "WS3");
    await until(() => w.events().length === 8, 3000, "both closes and the next gap and open");
    const gap = w.events().find((event) => event.kind === "gap")!;
    expect(gap).toMatchObject({ reason: "ws_reconnect", fromSeq: lastA.seq, fromWall: lastA.atWall });
    expect(gap.fromWall as number).toBeLessThanOrEqual(lastA.atWall as number);
    expect(w.events().filter((event) => event.kind === "ws.in")).toHaveLength(2);
    a.destroy();
    b.destroy();
    next.destroy();
  });

  it("equal walls take the earlier connection's seq, even when it closes second", async () => {
    const w = await world();
    // No timestamp: each stamp is this Chrome's start, the same wall.
    for (const requestId of ["WS1", "WS2"]) {
      w.cdp.emit("Network.webSocketCreated", { requestId, url: URL_WS }, "S1");
      w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId, response: { status: 101 } }, "S1");
      w.cdp.emit("Network.webSocketFrameReceived", { requestId, response: { opcode: 1, payloadData: requestId } }, "S1");
    }
    await until(() => w.events().length === 4, 3000, "both connections saved at the same wall");
    const lastA = w.events()[1]!;
    expect(w.events()[3]!.atWall).toBe(lastA.atWall);
    for (const requestId of ["WS2", "WS1"]) w.cdp.emit("Network.webSocketClosed", { requestId }, "S1");
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS3", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS3", response: { status: 101 } }, "S1");
    await until(() => w.events().length === 8, 3000, "both closes, the gap and the next open");
    expect(w.events()[6]).toMatchObject({ reason: "ws_reconnect", fromSeq: lastA.seq, fromWall: lastA.atWall });
  });

  it("an unkept connection's unknown boundary stays earlier than another connection's saved frame", async () => {
    const w = await world();
    const a = await opened(w);
    await until(() => w.events().length === 1, 3000, "A's open saved");
    w.session.fingerprint = null;
    const b = await opened(w, "WS2", "S2");
    await until(() => w.sockets.clockOf("S2") !== null, 3000, "B's session calibrated");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS2" }, "S2");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", timestamp: monoMs() / 1000, response: { opcode: 1, payloadData: "A later" } }, "S1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    w.session.fingerprint = FINGERPRINT;
    const next = await opened(w, "WS3");
    await until(() => w.events().length === 5, 3000, "A's frame and close, the next gap and open");
    expect(w.events()[3]).toMatchObject({ reason: "ws_reconnect", fromSeq: null, fromWall: null });
    a.destroy();
    b.destroy();
    next.destroy();
  });

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

  it("an iframe goes under an open connection: its one close and the next reconnect's gap, from the frame before the detach", async () => {
    const w = await world();
    const client = await opened(w, "WS1", "S2");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", timestamp: monoMs() / 1000, response: { opcode: 1, payloadData: "before the detach" } }, "S2");
    await until(() => w.events().length === 2, 3000, "the iframe's open and frame");
    const last = w.events()[1]!;
    w.cdp.emit("Target.detachedFromTarget", { sessionId: "S2" }, "S1");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: "after the detach" } }, "S2");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S2");
    await until(() => w.events().length === 3, 3000, "the iframe's close");
    expect(w.sockets.openConnections).toBe(0);
    expect(w.buffer.connections()).toEqual([]);
    const next = await opened(w, "WS2");
    await until(() => w.events().length === 5, 3000, "the next connection's gap and open");
    expect(w.events().map((event) => [event.kind, event.connectionId])).toEqual([
      ["ws.open", w.connectionOf()],
      ["ws.in", w.connectionOf()],
      ["ws.close", w.connectionOf()],
      ["gap", undefined],
      ["ws.open", w.connectionOf(1)],
    ]);
    expect(w.events()[3]).toMatchObject({ reason: "ws_reconnect", fromSeq: last.seq, fromWall: last.atWall });
    client.destroy();
    next.destroy();
  });

  it.for([
    { reading: "fails", previous: false },
    { reading: "fails", previous: true },
    { reading: "never answers", previous: false },
    { reading: "never answers", previous: true },
    { reading: "has no Timestamp", previous: false },
  ].flatMap((test) => [ { ...test, next: "reconnect" }, { ...test, next: "restart" } ]))("no reading ($reading), a batch five minutes late: stamps and the $next gap are no later than the lost frame (a calibrated moment of this socket: $previous)", async ({ reading, previous, next }) => {
    const w = await world();
    const clock = await import("../apps/page-browser/src/shared/util.ts");
    const chromeStarted = { mono: monoMs() - 600_000, wall: Date.now() - 600_000 };
    const date = vi.spyOn(Date, "now").mockReturnValue(chromeStarted.wall);
    const mono = vi.spyOn(clock, "monoMs").mockReturnValue(chromeStarted.mono);
    try {
      await w.sockets.chromeStarting();
    } finally {
      date.mockRestore();
      mono.mockRestore();
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let boundaryWall = chromeStarted.wall;
    if (previous) {
      w.cdp.emit("Network.webSocketCreated", { requestId: "WS-L", url: URL_WS }, "S1");
      w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS-L", timestamp: (monoMs() - 365_000) / 1000, response: { status: 101 } }, "S1");
      w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS-L", timestamp: (monoMs() - 360_000) / 1000, response: { opcode: 1, payloadData: '{"t":2,"d":"previous"}' } }, "S1");
      await vi.advanceTimersByTimeAsync(0);
      await w.buffer.flush();
      boundaryWall = w.events().find((event) => event.kind === "ws.in")!.atWall as number;
      w.sockets.clocksInvalidated("a new CDP link");
    }
    w.cdp.handlers.set("Performance.getMetrics", () => {
      if (reading === "fails") throw new Error("Chrome did not give its clock");
      if (reading === "never answers") return new Promise(() => undefined);
      return { metrics: [] };
    });
    const seen = { mono: monoMs() - 300_000, wall: Date.now() - 300_000 };
    const lostWall = seen.wall + 60_000;
    if (!previous) {
      w.cdp.emit("Network.webSocketCreated", { requestId: "WS-L", url: URL_WS }, "S1");
      w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS-L", timestamp: (seen.mono - 5_000) / 1000, response: { status: 101 } }, "S1");
    }
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS-L", timestamp: seen.mono / 1000, response: { opcode: 1, payloadData: '{"t":2,"d":"late"}' } }, "S1");
    await vi.advanceTimersByTimeAsync(CALIBRATION_WAIT_MS);
    await w.buffer.flush();
    expect(w.sockets.clockOf("S1")).toBeNull();
    const lateFrame = w.events().find((event) => event.frame === '{"t":2,"d":"late"}')!;
    expect(lateFrame.atMono as number).toBeLessThanOrEqual(seen.mono);
    expect(lateFrame.atWall as number).toBeLessThanOrEqual(seen.wall);
    expect(Math.abs((lateFrame.atWall as number) - boundaryWall)).toBeLessThanOrEqual(1);
    // The durable stamp, too: a crash rebuilds its boundary from lastWall,
    // and the engine may have advanced lossSince by that very stamp.
    expect(w.buffer.lastWall).toBe(lateFrame.atWall);
    expect(w.buffer.lastWall!).toBeLessThanOrEqual(lostWall);
    if (next === "restart") {
      w.sockets.close();
      const restarted = new SiteSockets({
        cdp: new FakeCdpPort(), buffer: w.buffer, observe: observing().observe,
        sessionFingerprint: () => FINGERPRINT, authorizationBytes: () => null,
        targetType: () => null, journal: () => undefined, alarm: () => undefined,
        stop: () => undefined, log: quiet,
      });
      cleanups.push(() => restarted.close());
      await restarted.afterRestart();
    } else {
      w.cdp.emit("Network.webSocketClosed", { requestId: "WS-L", timestamp: (seen.mono + 1_000) / 1000 }, "S1");
      w.cdp.emit("Network.webSocketCreated", { requestId: "WS-N", url: URL_WS }, "S1");
      w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS-N", timestamp: monoMs() / 1000, response: { status: 101 } }, "S1");
      await vi.advanceTimersByTimeAsync(CALIBRATION_WAIT_MS);
    }
    await w.buffer.flush();
    const gap = w.events().filter((event) => event.kind === "gap").at(-1)!;
    expect(gap).toMatchObject({ reason: next === "restart" ? "operator_start" : "ws_reconnect", fromSeq: lateFrame.seq, fromWall: lateFrame.atWall });
    expect(gap.fromWall as number).toBeLessThanOrEqual(lostWall);
  });

  it("with no clock, Chrome's start is later than an old calibrated lower bound: the stamp takes the start", async () => {
    const w = await world();
    const started = monoMs();
    await w.sockets.chromeStarting();
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", timestamp: (started - 10_000) / 1000, response: { status: 101 } }, "S1");
    await settle();
    w.sockets.clocksInvalidated("a new CDP link");
    w.cdp.handlers.set("Performance.getMetrics", () => { throw new Error("no clock"); });
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", timestamp: monoMs() / 1000, response: { opcode: 1, payloadData: "after the start" } }, "S1");
    await settle();
    await w.buffer.flush();
    const frame = w.events().find((event) => event.kind === "ws.in")!;
    expect(frame.atMono as number).toBeGreaterThanOrEqual(started);
    expect(frame.atMono as number).toBeLessThanOrEqual(monoMs());
  });

  it("at the operator's start, before a connection that follows a closed one, and before the closes when the browser goes — each from the last event of the socket before the break", async () => {
    const w = await world();
    await w.sockets.afterRestart();
    let client = await opened(w, "WS1");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"a"}' } }, "S1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    client.destroy();
    await w.buffer.flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    client = await opened(w, "WS2");
    await w.buffer.flush();
    // The browser goes under the open connection: its gap, then its close.
    w.sockets.endAll("a test");
    // A Chrome with no connection leaves no gap.
    await w.sockets.chromeStarting();
    await w.sockets.chromeStarting();
    client.destroy();
    await until(() => w.events().length === 8, 3000, "8 events");
    const events = w.events();
    expect(events.map((event) => `${String(event.kind)}${event.kind === "gap" ? `:${String(event.reason)}` : ""}`)).toEqual([
      "gap:operator_start",
      "ws.open",
      "ws.in",
      "ws.close",
      "gap:ws_reconnect",
      "ws.open",
      "gap:chrome_restart",
      "ws.close",
    ]);
    expect(events[0]).toMatchObject({ fromSeq: null, fromWall: null });
    // From the last event before the close (a moment saved before the loss).
    expect(events[4]).toMatchObject({ fromSeq: 3, fromWall: events[2]!.atWall });
    expect(events[6]).toMatchObject({ fromSeq: 6, fromWall: events[5]!.atWall });
  });

  it("the browser goes under a handshake in flight: its end is told to the engine, and the browser's gap covers what it may have carried", async () => {
    const w = await world();
    await opened(w, "WS1");
    const ticket = w.sockets.openTunnel("wsv3.fansly.com", 443);
    ticket.event({ kind: "handshake_sent", mono: monoMs(), wall: Date.now() });
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS2", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS2", timestamp: monoMs() / 1000 }, "S1");
    w.sockets.endAll("control lost");
    expect(w.observed.filter((one) => one.type === "ended").at(-1)).toEqual({ type: "ended", id: w.observed.filter((one) => one.type === "sent").at(-1)!.id, status: null, error: "the page stopped: control lost" });
    await until(() => w.events().length === 3, 3000, "the open, the gap, the close");
    expect(w.events().map((event) => `${String(event.kind)}${event.kind === "gap" ? `:${String(event.reason)}` : ""}`)).toEqual(["ws.open", "gap:chrome_restart", "ws.close"]);
    // What CDP still says of either is dropped.
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS2", response: { status: 101 } }, "S1");
    await w.buffer.flush();
    expect(w.events()).toHaveLength(3);
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

  it("decided again and held again, a record keeps its first deadline", async () => {
    const w = await world({ authHoldMs: 300 });
    w.session.token = null;
    const client = await unguarded(w);
    client.message(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.authorization);
    await until(() => w.egress.socketHolds === 1, 3000, "the record held");
    const heldAt = monoMs();
    // Metadata that changes nothing for it, again and again.
    for (let n = 0; n < 4; n++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      w.egress.socketRulesChanged();
    }
    await client.closed;
    expect(monoMs() - heldAt).toBeLessThan(1_000);
    expect(w.alarms).toEqual([{ kind: "unknown_ws_message", detail: expect.objectContaining({ scope: "tunnel" }) }]);
    expect(w.refreshes.count).toBe(1);
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

  it("measures records by the version and suite the server chose", () => {
    expect([recordOverhead(true, 0x1301), recordOverhead(true, 0x1303), recordOverhead(false, 0xc02f), recordOverhead(false, 0xcca8), recordOverhead(false, 0xc013), recordOverhead(true, 0x1304)]).toEqual([22, 22, 29, 21, null, null]);
    expect([clientFrameBytes(0), clientFrameBytes(1), clientFrameBytes(125), clientFrameBytes(126), clientFrameBytes(65_535), clientFrameBytes(65_536)]).toEqual([6, 7, 131, 134, 65_543, 65_550]);
    expect(authorizationBytes("abc")).toBe(Buffer.byteLength(JSON.stringify({ t: 1, d: JSON.stringify({ token: "abc", v: 3 }) })));
    const gate = new SocketRecordGate(29);
    const rules = { authorizationBytes: 110 };
    expect(gate.decide(23, 29 + 7, rules)).toEqual({ up: true, record: "ping" });
    expect(gate.decide(23, 29 + 6, rules)).toEqual({ up: true, record: "empty_control" });
    expect(gate.decide(23, 29 + 8, rules)).toEqual({ up: true, record: "close_code" });
    expect(gate.decide(23, 31, rules)).toEqual({ up: true, record: "tls" });
    expect(gate.decide(21, 500, rules)).toEqual({ up: true, record: "tls" });
    expect(gate.decide(22, 100, rules)).toMatchObject({ up: false, hold: false });
    // Before the authorization, a size it is not: maybe it under a token not
    // observed yet — held; nothing about the gate changes.
    expect(gate.decide(23, 29 + 120, rules)).toMatchObject({ up: false, hold: true });
    expect(gate.decide(23, 29 + 120, { authorizationBytes: null })).toMatchObject({ up: false, hold: true });
    expect(gate.authorized).toBe(false);
    expect(gate.decide(23, 29 + 116, rules)).toEqual({ up: true, record: "authorization" });
    expect(gate.authorized).toBe(true);
    expect(gate.decide(23, 29 + 116, rules)).toMatchObject({ up: false, hold: false });
    expect(gate.decide(23, 29 + 9, rules)).toMatchObject({ up: false, hold: false });
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
  const framesOf = (events: Array<Record<string, unknown>>) => events.filter((event) => event.kind === "ws.in").map((event) => (JSON.parse(String(event.frame)) as { d: string }).d);

  it.each(["taken", "refused, then taken"])("frames before the live session hold their holder acks until durable; the open %s stays before them and every later frame", async (how) => {
    const { chrome, holder, openBuffer, stored } = await holderWorld();
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    const controlled = new ControlledBuffer(buffer);
    let fingerprint: string | null = null;
    const { cdp, sockets, connectionOf } = await operatorSide(holder, controlled, { sessionFingerprint: () => fingerprint });
    cleanups.push(() => cdp.close());
    const acks = vi.spyOn(cdp, "ack");
    const seqs: number[] = [];
    cdp.on("Network.webSocketFrameReceived", (event) => seqs.push(event.seq));
    tunnel(sockets);
    handshake(chrome, "WS1");
    answered(chrome, "WS1");
    await until(() => sockets.clockOf("S1") !== null && stored() === 0, 3000, "the 101 taken without a live session");
    chrome.event("Network.webSocketFrameReceived", { requestId: "WS1", timestamp: monoMs() / 1000, response: { opcode: 1, payloadData: '{"t":1,"d":{}}' } }, "S1");
    frame(chrome, "early-1");
    frame(chrome, "early-2");
    await until(() => seqs.length === 3 && stored() === 3, 3000, "all three frames held");
    expect(eventsOf(buffer)).toEqual([]);
    expect(acks.mock.calls.filter(([seq]) => seqs.includes(seq))).toEqual([]);
    let refusing = how === "refused, then taken";
    const appendGroup = controlled.appendGroup.bind(controlled);
    vi.spyOn(controlled, "appendGroup").mockImplementation((items) => refusing ? { ok: false, reason: "buffer_full" } : appendGroup(items));
    controlled.holding = true;
    fingerprint = FINGERPRINT;
    sockets.sessionKnown();
    if (refusing) {
      expect(eventsOf(buffer)).toEqual([]);
      refusing = false;
      sockets.retryNow();
      await until(() => controlled.held.length === 1, 3000, "the retried open taken, its durability held");
      expect(eventsOf(buffer).map((event) => event.kind)).toEqual(["gap", "ws.open"]);
    }
    frame(chrome, "later");
    await until(() => seqs.length === 4, 3000, "the later frame taken");
    if (how === "refused, then taken") {
      expect(eventsOf(buffer).map((event) => event.kind)).toEqual(["gap", "ws.open"]);
      controlled.release();
    }
    await until(() => controlled.held.length === (how === "taken" ? 5 : 4), 3000, "the writes held before their acknowledgements");
    const events = eventsOf(buffer);
    expect(events.map((event) => event.kind)).toEqual(["gap", "ws.open", "ws.in", "ws.in", "ws.in", "ws.in"]);
    expect(events.slice(1).every((event) => event.connectionId === connectionOf())).toBe(true);
    expect(events.slice(2).map((event) => event.frame)).toEqual(['{"t":1,"d":{}}', ...["early-1", "early-2", "later"].map((d) => JSON.stringify({ t: 2, d }))]);
    expect(stored()).toBe(4);
    expect(acks.mock.calls.filter(([seq]) => seqs.includes(seq))).toEqual([]);
    controlled.release();
    await until(() => stored() === 0, 3000, "every frame acknowledged after its write is durable");
    for (const seq of seqs) expect(acks.mock.calls.filter(([acked]) => acked === seq)).toHaveLength(1);
  });

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

  it("a close queued behind another session's calibration still lands after its target detaches, acknowledged only once durable", async () => {
    const { chrome, holder, openBuffer, stored } = await holderWorld();
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    const controlled = new ControlledBuffer(buffer);
    const types = new Map([["S1", "page"], ["S2", "iframe"]]);
    const { cdp, sockets, connectionOf } = await operatorSide(holder, controlled, { targetType: (sessionId) => types.get(sessionId ?? "") ?? null });
    cleanups.push(() => cdp.close());
    tunnel(sockets);
    handshake(chrome, "WS1");
    answered(chrome, "WS1");
    await until(() => eventsOf(buffer).length === 1 && stored() === 0, 3000, "the open kept and acknowledged");
    let release: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const metrics = chrome.handlers.get("Performance.getMetrics")!;
    chrome.handlers.set("Performance.getMetrics", async (command) => {
      if (command.sessionId === "S2") await wait;
      return metrics(command);
    });
    controlled.holding = true;
    const closeTaken = new Promise<void>((resolve) => cdp.on("Network.webSocketClosed", () => resolve()));
    chrome.event("Network.webSocketCreated", { requestId: "WS2", url: URL_WS }, "S2");
    frame(chrome, "before the close");
    chrome.event("Network.webSocketClosed", { requestId: "WS1", timestamp: monoMs() / 1000 }, "S1");
    await closeTaken;
    types.delete("S1");
    expect(eventsOf(buffer).map((event) => event.kind)).toEqual(["ws.open"]);
    release();
    await until(() => controlled.held.length === 2, 3000, "the frame and close durable, their acknowledgements held");
    expect(eventsOf(buffer).map((event) => [event.kind, event.connectionId])).toEqual([
      ["ws.open", connectionOf()],
      ["ws.in", connectionOf()],
      ["ws.close", connectionOf()],
    ]);
    expect(buffer.connections()).toEqual([]);
    await until(() => stored() === 2, 3000, "the holder's other acknowledgements delivered");
    controlled.release();
    await until(() => stored() === 0, 3000, "the queued events acknowledged after their writes");
  });

  it("a detach waits behind its session's events: the open and frame go before its close, and only socket events keep their acknowledgements", async () => {
    const { chrome, holder, openBuffer, stored } = await holderWorld();
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    const controlled = new ControlledBuffer(buffer);
    controlled.holding = true;
    const types = new Map([["S1", "page"], ["S2", "iframe"]]);
    const { cdp, sockets, connectionOf } = await operatorSide(holder, controlled, { targetType: (sessionId) => types.get(sessionId ?? "") ?? null });
    cleanups.push(() => cdp.close());
    const acks = vi.spyOn(cdp, "ack");
    let release: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const metrics = chrome.handlers.get("Performance.getMetrics")!;
    chrome.handlers.set("Performance.getMetrics", async (command) => {
      if (command.sessionId === "S2") await wait;
      return metrics(command);
    });
    let detachSeq = 0;
    const detached = new Promise<void>((resolve) => cdp.on("Target.detachedFromTarget", (event) => {
      types.delete(String(event.params.sessionId));
      detachSeq = event.seq;
      resolve();
    }));
    tunnel(sockets).event({ kind: "handshake_sent", mono: monoMs(), wall: Date.now() });
    chrome.event("Network.webSocketCreated", { requestId: "WS1", url: URL_WS }, "S2");
    chrome.event("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S2");
    chrome.event("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", timestamp: monoMs() / 1000, response: { status: 101 } }, "S2");
    chrome.event("Network.webSocketFrameReceived", { requestId: "WS1", timestamp: monoMs() / 1000, response: { opcode: 1, payloadData: "before the detach" } }, "S2");
    chrome.event("Target.detachedFromTarget", { sessionId: "S2" }, "S1");
    await detached;
    await until(() => stored() === 4, 3000, "the detach acknowledged, the socket's events still waiting");
    expect(eventsOf(buffer)).toEqual([]);
    release();
    await until(() => controlled.held.length === 3, 3000, "the open, frame and close durable, their acknowledgements held");
    expect(eventsOf(buffer).map((event) => [event.kind, event.connectionId])).toEqual([
      ["ws.open", connectionOf()],
      ["ws.in", connectionOf()],
      ["ws.close", connectionOf()],
    ]);
    expect(buffer.connections()).toEqual([]);
    await until(() => stored() === 2, 3000, "only the open and frame's acknowledgements held");
    controlled.release();
    await until(() => stored() === 0, 3000, "the socket's events acknowledged once durable");
    expect(acks.mock.calls.filter(([seq]) => seq === detachSeq)).toHaveLength(1);
  });

  it.each([
    ["before ws.open commits", 0],
    ["after ws.open commits", 1],
    ["between two frames", 2],
  ])("a crash %s: after the restart no frame is under a wrong connection, the old connection is ended exactly once, the start's gap covers the window, and what the holder kept is acknowledged unwritten", async (_when, kept) => {
    const { chrome, holder, openBuffer, stored } = await holderWorld();
    const first = openBuffer();
    const controlled = new ControlledBuffer(first);
    const a = await operatorSide(holder, controlled);
    tunnel(a.sockets);
    const handshaken = new Promise<void>((resolve) => a.cdp.on("Network.webSocketWillSendHandshakeRequest", () => resolve()));
    handshake(chrome, "WS1");
    await handshaken;
    await until(() => a.sockets.clockOf("S1") !== null, 3000, "the calibration replies before counting socket events");
    await until(() => a.observed.length === 1 && stored() === 0, 3000, "the handshake told and acknowledged");
    const steps = [() => answered(chrome, "WS1"), () => frame(chrome, "frame-1"), () => frame(chrome, "frame-2")];
    for (const step of steps.slice(0, kept)) {
      const before = holder.holder!.stats.lastSeq;
      step();
      await until(() => holder.holder!.stats.lastSeq === before + 1 && stored() === 0, 3000, "kept and acknowledged");
    }
    const connectionId = kept === 0 ? null : a.connectionOf();
    // The operator dies: what comes now is never written.
    controlled.crashed = true;
    for (const step of steps.slice(kept)) step();
    await until(() => stored() === steps.length - kept, 3000, "the rest kept by the holder");
    const lastSaved = { seq: first.lastSeq, wall: first.lastWall };
    a.cdp.close();
    await first.close();
    // The operator starts again on the same buffer and holder.
    const second = openBuffer();
    cleanups.push(() => second.close());
    const b = await operatorSide(holder, second);
    cleanups.push(() => b.cdp.close());
    await until(() => stored() === 0, 3000, "the holder's delivery acknowledged");
    await b.sockets.afterRestart();
    await second.flush();
    const events = eventsOf(second);
    const after = events.filter((event) => (event.seq as number) > lastSaved.seq);
    // Nothing of the holder's delivery was written; no frame under another connection.
    expect(framesOf(events)).toEqual(kept >= 2 ? ["frame-1"] : []);
    expect(events.filter((event) => event.kind === "ws.in").every((event) => event.connectionId === connectionId)).toBe(true);
    // Nothing of the delivery is told to the engine again either.
    expect(b.observed).toEqual([]);
    if (kept === 0) {
      // Never opened in the stream, never kept: nothing to end.
      expect(after.map((event) => event.kind)).toEqual(["gap"]);
    } else {
      // Opened: ended by its one close — in one commit with the gap, after it.
      expect(after.map((event) => event.kind)).toEqual(["gap", "ws.close"]);
      expect(events.filter((event) => event.kind === "ws.close" && event.connectionId === connectionId)).toHaveLength(1);
    }
    expect(after[0]).toMatchObject({ kind: "gap", reason: "operator_start", fromSeq: lastSaved.seq === 0 ? null : lastSaved.seq, fromWall: lastSaved.seq === 0 ? null : lastSaved.wall });
    expect(second.connections()).toEqual([]);
  });

  it("an older operator's admission kept and never opened is ended by the restart with its fate unknown — the engine's attempt is closed once", async () => {
    const { holder, openBuffer } = await holderWorld();
    const first = openBuffer();
    // As an operator before variant Б left it: admitted, its CONNECT gone on.
    const admitted = first.changeConnection({ connectionId: "c0ffee00-0000-4000-8000-000000000001", admitted: { attemptId: 77 } });
    if (!admitted.ok) throw new Error(admitted.reason);
    await admitted.durable;
    await first.close();
    const second = openBuffer();
    cleanups.push(() => second.close());
    const b = await operatorSide(holder, second);
    cleanups.push(() => b.cdp.close());
    await b.sockets.afterRestart();
    await until(() => b.sockets.unwritten === 0, 3000, "the start's commit");
    const stored = second.outcomes([77])[0];
    expect(stored && JSON.parse(stored.json)).toEqual({ type: "wsDone", connectionId: "c0ffee00-0000-4000-8000-000000000001", attemptId: 77, sent: false, sentMono: null, status: null, error: expect.stringContaining("the handshake's fate is unknown"), fate: "unknown" });
    expect(second.connections()).toEqual([]);
  });

  it("Astra's round 3: A opened and closed, B's open never written — the operator dies: A is never ended again, B leaves nothing to end; what the holder kept is dropped", async () => {
    const { chrome, holder, openBuffer, stored } = await holderWorld();
    const first = openBuffer();
    const controlled = new ControlledBuffer(first);
    const a = await operatorSide(holder, controlled);
    tunnel(a.sockets);
    handshake(chrome, "WS1");
    answered(chrome, "WS1");
    frame(chrome, "a-frame");
    chrome.event("Network.webSocketClosed", { requestId: "WS1", timestamp: monoMs() / 1000 }, "S1");
    await until(() => eventsOf(first).length === 3 && stored() === 0, 3000, "A written");
    const connectionA = a.connectionOf();
    tunnel(a.sockets);
    // The operator dies: B's answer is never written.
    controlled.crashed = true;
    const before = holder.holder!.stats.lastSeq;
    handshake(chrome, "WS2");
    answered(chrome, "WS2");
    await until(() => holder.holder!.stats.lastSeq === before + 3 && stored() === 1, 3000, "B's answer kept by the holder");
    await first.flush();
    expect(first.connections()).toEqual([]);
    a.cdp.close();
    await first.close();
    // The next operator.
    const second = openBuffer();
    cleanups.push(() => second.close());
    const b = await operatorSide(holder, second);
    cleanups.push(() => b.cdp.close());
    await until(() => stored() === 0, 3000, "B's answer delivered again and acknowledged");
    await b.sockets.afterRestart();
    await until(() => b.sockets.unwritten === 0, 3000, "the start's commit");
    const events = eventsOf(second);
    expect(events.map((event) => (event.kind === "gap" ? `gap:${String(event.reason)}` : `${String(event.kind)}:${event.connectionId === connectionA ? "A" : "?"}`))).toEqual(["ws.open:A", "ws.in:A", "ws.close:A", "gap:operator_start"]);
    expect(second.connections()).toEqual([]);
  });

  /** A first operator: A open, a frame of `frameBytes` — all durable and
   *  acknowledged; then it dies. */
  async function firstLife(world: Awaited<ReturnType<typeof holderWorld>>, frameBytes = 10): Promise<{ connectionId: string; lastSaved: { seq: number; wall: number | null }; bytes: number }> {
    const first = world.openBuffer();
    const a = await operatorSide(world.holder, first);
    tunnel(a.sockets);
    handshake(world.chrome, "WS1");
    answered(world.chrome, "WS1");
    frame(world.chrome, "x".repeat(frameBytes));
    await until(() => eventsOf(first).length === 2 && world.stored() === 0, 3000, "A's open and frame kept");
    const lastSaved = { seq: first.lastSeq, wall: first.lastWall };
    const bytes = first.stats().bytes;
    const connectionId = a.connectionOf();
    a.sockets.close();
    a.cdp.close();
    await first.close();
    return { connectionId, lastSaved, bytes };
  }

  // Astra's review of PR 15, round 7: the first events of a session told
  // late wait for its first calibration, and are stamped when Chrome saw
  // them — a gap from them starts early, never late; even a slow reading
  // gives a lower bound, and goes with its session.
  async function lateFirstBatch(shift: number) {
    const { chrome, holder, openBuffer } = await holderWorld();
    chrome.clockShiftMs = shift;
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    const { cdp, sockets } = await operatorSide(holder, buffer);
    cleanups.push(() => cdp.close());
    const chromeAt = (mono: number) => (mono + shift) / 1000;
    // Its calibration answers only once the batch is in (a pause of the operator).
    let answer: () => void = () => undefined;
    const metrics = chrome.handlers.get("Performance.getMetrics")!;
    chrome.handlers.set("Performance.getMetrics", async (command) => {
      await new Promise<void>((resolve) => (answer = resolve));
      return metrics(command);
    });
    const t = monoMs();
    const wallT = Date.now();
    tunnel(sockets);
    tunnelOf!.event({ kind: "handshake_sent", mono: t - 305_000, wall: wallT - 305_000 });
    // Chrome saw its handshake, its answer, a frame and the close five
    // minutes ago; CDP tells them all only now.
    chrome.event("Network.webSocketCreated", { requestId: "WS-L", url: URL_WS }, "S1");
    chrome.event("Network.webSocketWillSendHandshakeRequest", { requestId: "WS-L", timestamp: chromeAt(t - 305_000) }, "S1");
    chrome.event("Network.webSocketHandshakeResponseReceived", { requestId: "WS-L", timestamp: chromeAt(t - 304_000), response: { status: 101, headers: {} } }, "S1");
    chrome.event("Network.webSocketFrameReceived", { requestId: "WS-L", timestamp: chromeAt(t - 300_000), response: { opcode: 1, payloadData: JSON.stringify({ t: 2, d: "late" }) } }, "S1");
    chrome.event("Network.webSocketClosed", { requestId: "WS-L", timestamp: chromeAt(t - 299_000) }, "S1");
    // Taken, waiting for the session's first calibration: nothing written.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(eventsOf(buffer)).toEqual([]);
    expect(sockets.clockOf("S1")).toBeNull();
    answer();
    chrome.handlers.set("Performance.getMetrics", metrics);
    await until(() => sockets.clockOf("S1") !== null, 3000, "the session calibrated");
    await until(() => eventsOf(buffer).some((event) => event.kind === "ws.close"), 3000, "the batch kept");
    return { chrome, buffer, sockets, holder, t, wallT, chromeAt };
  }

  it.for([
    { chrome: "on the operator's clock", shift: 0 },
    { chrome: "an hour ahead", shift: 3_600_000 },
    { chrome: "an hour behind", shift: -3_600_000 },
  ])("Astra's round 7: the first batch told five minutes late, before its session's calibration (Chrome's clock $chrome): it waits for the calibration and is stamped when Chrome saw it — the next gap from there, a message missed four minutes ago inside the repair's window", async ({ shift }) => {
    const { chrome, buffer, sockets, wallT, t, chromeAt } = await lateFirstBatch(shift);
    const late = eventsOf(buffer);
    const spread = sockets.clockOf("S1")!.spread;
    for (const [kind, seen] of [["ws.open", t - 304_000], ["ws.in", t - 300_000], ["ws.close", t - 299_000]] as const) {
      const event = late.find((one) => one.kind === kind)!;
      // Never later than when Chrome saw it; at most the calibration's
      // round trip earlier.
      expect(event.atMono as number, kind).toBeLessThanOrEqual(seen);
      expect(event.atMono as number, kind).toBeGreaterThanOrEqual(seen - spread - 1);
    }
    // The next connection, the session calibrated: its gap from the late frame's stamp.
    tunnel(sockets);
    handshake(chrome, "WS-M");
    answered(chrome, "WS-M");
    chrome.event("Network.webSocketFrameReceived", { requestId: "WS-M", timestamp: chromeAt(monoMs() - 2_000), response: { opcode: 1, payloadData: JSON.stringify({ t: 2, d: "fresh" }) } }, "S1");
    await until(() => eventsOf(buffer).filter((event) => event.kind === "ws.in").length === 2, 3000, "the next connection's frame");
    const events = eventsOf(buffer);
    const gap = events.find((event) => event.kind === "gap")!;
    const lateFrame = events.find((event) => event.kind === "ws.in")!;
    expect(gap).toMatchObject({ reason: "ws_reconnect", fromSeq: lateFrame.seq, fromWall: lateFrame.atWall });
    const missed = wallT - 240_000;
    // The repair reads back 60 s before the gap (ws-gap.ts): the message inside.
    expect((gap.fromWall as number) - 60_000).toBeLessThanOrEqual(missed);
    expect(gap.fromWall as number).toBeLessThanOrEqual(wallT - 300_000 + 1);
    // A calibrated stamp: at most the round trip early, never late.
    const fresh = events.filter((event) => event.kind === "ws.in")[1]!;
    expect(fresh.atMono as number).toBeLessThanOrEqual(monoMs() - 2_000 + 1);
  });

  it("a session's calibration that does not answer holds its events only until it fails (or its wait ends): then they go, stamped no later than their take", async () => {
    const { chrome, holder, openBuffer } = await holderWorld();
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    const { cdp, sockets, observed } = await operatorSide(holder, buffer);
    cleanups.push(() => cdp.close());
    chrome.handlers.set("Performance.getMetrics", () => new Promise(() => undefined));
    tunnel(sockets);
    handshake(chrome, "WS-H");
    answered(chrome, "WS-H");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(observed.map((one) => one.type)).toEqual(["sent", "ended"]);
    await until(() => eventsOf(buffer).some((event) => event.kind === "ws.open"), CALIBRATION_WAIT_MS + 1000, "the open past the wait");
    expect(observed.map((one) => one.type)).toEqual(["sent", "ended"]);
    expect(eventsOf(buffer)[0]!.atMono as number).toBeLessThanOrEqual(monoMs());
  });

  it("a slow calibration gives a loose clock at once: a batch five minutes late is stamped as Chrome saw it, its gap before the missed message; a tight retry replaces it", async () => {
    const { chrome, holder, openBuffer } = await holderWorld();
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    const lines: string[] = [];
    const { cdp, sockets } = await operatorSide(holder, buffer, { log: (event, fields) => lines.push(`${event} ${JSON.stringify(fields ?? {})}`) });
    cleanups.push(() => cdp.close());
    chrome.clockDelayMs = CALIBRATION_MAX_MS + 2_000;
    const t = monoMs();
    const wallT = Date.now();
    tunnel(sockets);
    tunnelOf!.event({ kind: "handshake_sent", mono: t - 305_000, wall: wallT - 305_000 });
    chrome.event("Network.webSocketCreated", { requestId: "WS-S", url: URL_WS }, "S1");
    chrome.event("Network.webSocketWillSendHandshakeRequest", { requestId: "WS-S", timestamp: (t - 305_000) / 1000 }, "S1");
    chrome.event("Network.webSocketHandshakeResponseReceived", { requestId: "WS-S", timestamp: (t - 304_000) / 1000, response: { status: 101 } }, "S1");
    chrome.event("Network.webSocketFrameReceived", { requestId: "WS-S", timestamp: (t - 300_000) / 1000, response: { opcode: 1, payloadData: '{"t":2,"d":"late"}' } }, "S1");
    chrome.event("Network.webSocketClosed", { requestId: "WS-S", timestamp: (t - 299_000) / 1000 }, "S1");
    await until(() => lines.some((line) => line.startsWith("clock.refused")), 5000, "the slow calibration refused");
    const spread = sockets.clockOf("S1")!.spread;
    expect(spread).toBeGreaterThan(CALIBRATION_MAX_MS);
    expect(lines.find((line) => line.startsWith("clock.refused"))).toContain("a round trip of");
    await until(() => eventsOf(buffer).some((event) => event.kind === "ws.close"), 3000, "the waiting batch kept by the loose clock");
    for (const [kind, seen] of [["ws.open", t - 304_000], ["ws.in", t - 300_000], ["ws.close", t - 299_000]] as const) {
      const event = eventsOf(buffer).find((one) => one.kind === kind)!;
      expect(event.atMono as number, kind).toBeLessThanOrEqual(seen);
      expect(event.atMono as number, kind).toBeGreaterThanOrEqual(seen - spread - 1);
    }
    tunnel(sockets);
    handshake(chrome, "WS-N");
    answered(chrome, "WS-N");
    await until(() => eventsOf(buffer).some((event) => event.kind === "gap"), 3000, "the reconnect's gap");
    const gap = eventsOf(buffer).find((event) => event.kind === "gap")!;
    const lateFrame = eventsOf(buffer).find((event) => event.kind === "ws.in")!;
    expect(gap).toMatchObject({ fromSeq: lateFrame.seq, fromWall: lateFrame.atWall });
    expect(gap.fromWall as number).toBeLessThanOrEqual(wallT - 300_000 + 1);
    expect((gap.fromWall as number) - 60_000).toBeLessThanOrEqual(wallT - 240_000);
    // A short round trip: taken.
    chrome.clockDelayMs = 0;
    await until(() => (sockets.clockOf("S1")?.spread ?? Infinity) <= CALIBRATION_MAX_MS, 5000, "a tight calibration taken on retry");
    expect(sockets.clockOf("S1")!.spread).toBeLessThanOrEqual(CALIBRATION_MAX_MS);
  });

  it("a calibration's readings as one: the largest lower bound — never past the true offset, at most the smallest round trip short of it", () => {
    // Chrome's clock 1 h behind the operator's: true offset +3_600_000 ms.
    // Each reading: Chrome read somewhere inside [t0, t1].
    const trueOffset = 3_600_000;
    const read = (t0: number, t1: number, at: number) => ({ offset: t0 - (at - trueOffset), spread: t1 - t0, takenMono: t1 });
    const readings = [read(1_000, 1_400, 1_390), read(2_000, 2_002, 2_001), read(3_000, 3_900, 3_010)];
    const clock = tightestOf(readings)!;
    expect(clock.offset).toBeLessThanOrEqual(trueOffset);
    expect(trueOffset - clock.offset).toBeLessThanOrEqual(clock.spread);
    expect(clock.spread).toBe(2);
    expect(clock.takenMono).toBe(3_900);
    // A Chrome timestamp mapped by it: never after the same instant here, at
    // most the spread before it; never after the event's take.
    const instant = 50_000;
    const mapped = chromeToOperator((instant - trueOffset) / 1000, clock, 60_000);
    expect(mapped).toBeLessThanOrEqual(instant);
    expect(instant - mapped).toBeLessThanOrEqual(clock.spread + 1e-6);
    expect(chromeToOperator((instant - trueOffset) / 1000, clock, 49_000)).toBe(49_000);
    expect(tightestOf([])).toBeNull();
  });

  it("a calibration is its session's: another session (a new target) has none until its own; a new CDP link or a new Chrome drops them all", async () => {
    const { chrome, holder, openBuffer } = await holderWorld();
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    const { cdp, sockets } = await operatorSide(holder, buffer);
    cleanups.push(() => cdp.close());
    tunnel(sockets);
    handshake(chrome, "WS-1");
    await until(() => sockets.clockOf("S1") !== null, 3000, "S1 calibrated");
    expect(sockets.clockOf("S2")).toBeNull();
    // A socket event of another session: its own calibration.
    chrome.event("Network.webSocketCreated", { requestId: "WS-2", url: URL_WS }, "S2");
    await until(() => sockets.clockOf("S2") !== null, 3000, "S2 calibrated");
    // A new CDP link: none kept.
    sockets.clocksInvalidated("a new link to the CDP holder (test)");
    expect(sockets.clockOf("S1")).toBeNull();
    expect(sockets.clockOf("S2")).toBeNull();
    chrome.event("Network.webSocketCreated", { requestId: "WS-3", url: URL_WS }, "S1");
    await until(() => sockets.clockOf("S1") !== null, 3000, "S1 calibrated again");
    // A new Chrome: none kept either.
    await sockets.chromeStarting();
    expect(sockets.clockOf("S1")).toBeNull();
  });

  it("Astra's round 4: the start's gap and the closes go in one commit, the gap first; refused (the close would fit, the gap would not), they go once there is room — the gap from the first boundary", async () => {
    const world = await holderWorld();
    const { connectionId, lastSaved, bytes } = await firstLife(world, 1500);
    const closeBytes = Buffer.byteLength(JSON.stringify({ kind: "ws.close", connectionId, code: null, reason: null })) + 64;
    const boundaryFile = join(world.dir, "start-boundary.json");
    let sockets: SiteSockets | null = null;
    const second = world.openBuffer({ caps: { bytes: bytes + closeBytes + 8 }, onRoom: () => sockets?.retryNow() });
    cleanups.push(() => second.close());
    const b = await operatorSide(world.holder, second, { startBoundary: new BoundaryFile(boundaryFile), timings: { retryMs: [60_000] } });
    sockets = b.sockets;
    cleanups.push(() => b.cdp.close());
    await b.sockets.afterRestart();
    await second.flush();
    // Neither went: they are one commit.
    expect(second.refusal()).toBe("buffer_full");
    expect(second.lastSeq).toBe(lastSaved.seq);
    expect(b.sockets.unwritten).toBe(1);
    expect(existsSync(boundaryFile)).toBe(true);
    // Room again: the buffer's own gap, then the start's — from its first
    // boundary, not from that gap — then the close.
    second.setParams(5, { ...second.caps, bytes: 64 * 1024 * 1024 });
    await until(() => b.sockets.unwritten === 0, 3000, "the start's commit");
    expect(eventsOf(second).filter((event) => (event.seq as number) > lastSaved.seq)).toMatchObject([
      { kind: "gap", reason: "buffer_full", fromSeq: lastSaved.seq },
      { kind: "gap", reason: "operator_start", fromSeq: lastSaved.seq, fromWall: lastSaved.wall },
      { kind: "ws.close", connectionId },
    ]);
    expect(second.connections()).toEqual([]);
    expect(existsSync(boundaryFile)).toBe(false);
  });

  it("Astra's round 4: an operator that dies before its start's commit is durable leaves the boundary to the next one", async () => {
    const world = await holderWorld();
    const { connectionId, lastSaved } = await firstLife(world);
    const boundaryFile = join(world.dir, "start-boundary.json");
    // The second operator starts on a full disk: nothing of its start goes.
    let free = 0;
    const second = world.openBuffer({ diskFree: () => free, minFreeBytes: 1000, checkEveryMs: 20 });
    const b = await operatorSide(world.holder, second, { startBoundary: new BoundaryFile(boundaryFile), timings: { retryMs: [60_000] } });
    await b.sockets.afterRestart();
    expect(second.refusal()).toBe("disk_full");
    expect(new BoundaryFile(boundaryFile).load()).toEqual({ bufferId: second.id, seq: lastSaved.seq, wall: lastSaved.wall });
    // Room: the buffer's own gap goes in, and the operator dies before its
    // start is tried again.
    free = 1e12;
    await until(() => second.refusal() === null, 3000, "room");
    expect(second.lastSeq).toBe(lastSaved.seq + 1);
    b.sockets.close();
    b.cdp.close();
    await second.close();
    // The third: its gap from the first boundary.
    const third = world.openBuffer();
    cleanups.push(() => third.close());
    const c = await operatorSide(world.holder, third, { startBoundary: new BoundaryFile(boundaryFile) });
    cleanups.push(() => c.cdp.close());
    await c.sockets.afterRestart();
    await until(() => c.sockets.unwritten === 0, 3000, "the start's commit");
    expect(eventsOf(third).filter((event) => (event.seq as number) > lastSaved.seq)).toMatchObject([
      { kind: "gap", reason: "disk_full", fromSeq: lastSaved.seq },
      { kind: "gap", reason: "operator_start", fromSeq: lastSaved.seq, fromWall: lastSaved.wall },
      { kind: "ws.close", connectionId },
    ]);
    expect(existsSync(boundaryFile)).toBe(false);
  });

  it("Astra's round 4: started on a full disk, the old connection's close is tried again — whatever Chrome does — and written once there is room", async () => {
    const world = await holderWorld();
    const { connectionId, lastSaved } = await firstLife(world);
    let free = 0;
    const second = world.openBuffer({ diskFree: () => free, minFreeBytes: 1000, checkEveryMs: 20 });
    cleanups.push(() => second.close());
    const b = await operatorSide(world.holder, second, { timings: { retryMs: [30] } });
    cleanups.push(() => b.cdp.close());
    await b.sockets.afterRestart();
    // Chrome's starts while the disk is full end nothing twice.
    await b.sockets.chromeStarting();
    await b.sockets.chromeStarting();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(second.lastSeq).toBe(lastSaved.seq);
    expect(second.connections()).toMatchObject([{ connectionId, opened: true }]);
    free = 1e12;
    await until(() => second.connections().length === 0, 3000, "the close written");
    await b.sockets.chromeStarting();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const events = eventsOf(second);
    expect(events.filter((event) => event.kind === "ws.close")).toMatchObject([{ connectionId }]);
    expect(events.filter((event) => event.kind === "gap").map((event) => event.reason)).toEqual(["disk_full", "operator_start"]);
    expect(b.sockets.unwritten).toBe(0);
  });

  it("the browser's gap and its closes, refused (the buffer full), are written later — the gap from the last event saved before the closes", async () => {
    const { chrome, holder, openBuffer, stored } = await holderWorld();
    let sockets: SiteSockets | null = null;
    const buffer = openBuffer({ onRoom: () => sockets?.retryNow() });
    cleanups.push(() => buffer.close());
    const a = await operatorSide(holder, buffer, { timings: { retryMs: [60_000] } });
    sockets = a.sockets;
    cleanups.push(() => a.cdp.close());
    tunnel(a.sockets);
    handshake(chrome, "WS1");
    answered(chrome, "WS1");
    frame(chrome, "x".repeat(1500));
    await until(() => eventsOf(buffer).length === 2 && stored() === 0, 3000, "open, frame");
    const connectionId = a.connectionOf();
    const last = eventsOf(buffer)[1]!;
    // The next commit would pass the cap.
    buffer.setParams(5, { ...buffer.caps, bytes: buffer.stats().bytes + 8 });
    a.sockets.endAll("a test");
    await until(() => buffer.refusal() === "buffer_full", 3000, "refused");
    expect(buffer.lastSeq).toBe(last.seq);
    buffer.setParams(5, { ...buffer.caps, bytes: 64 * 1024 * 1024 });
    await until(() => a.sockets.unwritten === 0, 3000, "written");
    expect(eventsOf(buffer).slice(2)).toMatchObject([
      { kind: "gap", reason: "buffer_full", fromSeq: last.seq },
      { kind: "gap", reason: "chrome_restart", fromSeq: last.seq, fromWall: last.atWall },
      { kind: "ws.close", connectionId },
    ]);
  });
});

describe("a connection's one terminal close (Astra's re-review of PR 10, 4)", () => {
  it("Astra's round 5: when the page stops, the browser's gap goes before the synthetic close, from the last frame saved — a frame CDP tells late is dropped and covered; nothing after", async () => {
    const w = await world();
    await opened(w);
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"before"}' } }, "S1");
    // The open and the frame are committed: the kept connection says open.
    await w.buffer.flush();
    await until(() => w.events().length === 2, 3000, "the open and the frame");
    expect(w.buffer.connections()).toMatchObject([{ opened: true }]);
    w.sockets.endAll("control lost");
    // The browser goes, and CDP still speaks of the socket for a moment: a
    // frame Chrome got before the stop, told late.
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"after"}' } }, "S1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", timestamp: monoMs() / 1000, response: { status: 101 } }, "S1");
    await until(() => w.events().length === 4, 3000, "the gap and the close");
    await w.sockets.chromeStarting();
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"later"}' } }, "S1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    await w.buffer.flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const events = w.events();
    expect(events.map((event) => `${String(event.kind)}${event.kind === "gap" ? `:${String(event.reason)}` : ""}`)).toEqual(["ws.open", "ws.in", "gap:chrome_restart", "ws.close"]);
    expect(events[1]).toMatchObject({ frame: '{"t":2,"d":"before"}' });
    expect(events[2]).toMatchObject({ fromSeq: 2, fromWall: events[1]!.atWall });
    expect(w.buffer.connections()).toEqual([]);
    // Every one of them acknowledged to the holder, none kept.
    expect(w.cdp.acks.length).toBeGreaterThanOrEqual(5);
  });
});
