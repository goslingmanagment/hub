import { existsSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";

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
import type { WsAdmitResult } from "../apps/page-browser/src/rpc/protocol.ts";
import { makeLog, monoMs, setLogSink } from "../apps/page-browser/src/shared/util.ts";
import { guardExpression } from "../apps/page-browser/src/ws/guard.ts";
import { GuardInstaller } from "../apps/page-browser/src/ws/install.ts";
import { BoundaryFile } from "../apps/page-browser/src/ws/boundary.ts";
import { CALIBRATION_MAX_MS, SiteSockets, type SocketBuffer, type SocketDeps, type SocketTimings } from "../apps/page-browser/src/ws/sockets.ts";
import {
  FakeCdpPort,
  FakeChrome,
  FakeSocketLink,
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

// The site's socket under the engine's admission (Project Browser plan §4.3,
// §4.4, §4.9; spec §2.3, §6.1, §9; mandatory condition №3; stage 1,
// amendment 8): each socket's CONNECT waits at the proxy for `wsAdmit` and
// is refused without it; its handshake request goes up only before the
// admission's deadline; its frames come from CDP into the buffer, durable
// and in order; its handshake's outcome goes to the engine as `wsDone`; gaps
// mark where frames may be missing; without the engine nothing new is
// admitted and what is open stays; nothing of a frame, a token or an
// authorization reaches a log or a journal.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setLogSink(null);
});

const FINGERPRINT = "f".repeat(64);
const TOKEN = "eyJ-socket-token-value-9f8e7d6c5b4a";
const AUTH = JSON.stringify({ t: 1, d: JSON.stringify({ token: TOKEN, v: 3 }) });
/** The live session's token, as the site's API requests carry it. */
const SESSION_TOKEN = "MTA4NDU4OTk3MjEyNjE2NzA0MDoxOjI6MjZhNjU0M2Q0YWZmYzQyOWNiZWE0OWRmYjFmNmI4";
const FRAME_SECRET = "frame-content-marker-7c3b";
const URL_WS = "wss://wsv3.fansly.com/?v=3";

interface World {
  cdp: FakeCdpPort;
  egress: Egress;
  proxyPort: number;
  socks: FakeSocks;
  server: Awaited<ReturnType<typeof socketServer>>;
  buffer: EventBuffer;
  sockets: SiteSockets;
  link: FakeSocketLink;
  records: TunnelRecord[];
  journal: SocketLine[];
  alarms: Array<{ kind: string; detail: Record<string, unknown> }>;
  stops: Array<{ reason: string; note: string; how: string; exitOpen: boolean }>;
  lines: string[];
  admitting: { why: string | null };
  session: { fingerprint: string | null; token: string | null };
  tcpEpochs: number[];
  /** The engine's answer to the latest (or a given) wsAdmit. */
  answer: (fields: Partial<WsAdmitResult> & { admit: boolean }, connectionId?: string) => string;
  events: () => Array<Record<string, unknown>>;
  outcome: (attemptId: number) => Record<string, unknown> | null;
}

async function world(options: { timings?: Partial<SocketTimings>; buffer?: (buffer: EventBuffer) => SocketBuffer; tls12Suite?: number; soleDocument?: boolean } = {}): Promise<World> {
  const temp = tempDir("pb-ws-");
  cleanups.push(temp.remove);
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const cdp = new FakeCdpPort();
  const server = await socketServer(options.tls12Suite === undefined ? {} : { tls12Suite: options.tls12Suite });
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
  const link = new FakeSocketLink();
  const admitting = { why: null as string | null };
  const session = { fingerprint: FINGERPRINT as string | null, token: SESSION_TOKEN as string | null };
  let sockets: SiteSockets | null = null;
  const tcpEpochs: number[] = [];
  const egress = new Egress({ classify: classifyFanslyHost, socketEpoch: () => { const epoch = sockets!.documentEpoch; tcpEpochs.push(epoch); return epoch; }, admitSocket: (host, port, epoch) => sockets!.admit(host, port, epoch), onRecord: (record) => records.push(record), log: makeLog("egress") });
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
    link,
    notAdmitting: () => admitting.why,
    sessionFingerprint: () => session.fingerprint,
    authorizationBytes: () => (session.token === null ? null : authorizationBytes(session.token)),
    targetType: (sessionId) => (sessionId === null ? null : (types.get(sessionId) ?? null)),
    documentOwner: () => options.soleDocument ? "S1" : null,
    socketHost: (host) => classifyFanslyHost(host) === "ws",
    cutTunnel: (connectionId, reason) => egress.cutSocket(connectionId, reason),
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
  const answer: World["answer"] = (fields, connectionId) => {
    const id = connectionId ?? String(link.of("wsAdmit").at(-1)!.connectionId);
    const base = { type: "wsAdmitResult" as const, ownerGeneration: 1, connectionId: id };
    created.onAdmitResult(
      fields.admit
        ? { ...base, admit: true, deadlineMono: fields.deadlineMono ?? monoMs() + 5000, attemptId: fields.attemptId ?? 41, ownerGeneration: fields.ownerGeneration ?? 1 }
        : { ...base, admit: false, reason: (fields as { reason?: string }).reason ?? "pace", retryNotBeforeWall: null },
    );
    return id;
  };
  const events = () => buffer.readEvents(0, 10_000, 100_000_000).map((event) => JSON.parse(event.json) as Record<string, unknown>);
  const outcome = (attemptId: number) => {
    const stored = buffer.outcomes([attemptId])[0];
    return stored ? (JSON.parse(stored.json) as Record<string, unknown>) : null;
  };
  return { cdp, egress, proxyPort, socks, server, buffer, sockets: created, link, records, journal, alarms, stops, lines, admitting, session, tcpEpochs, answer, events, outcome };
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

/** The site opens a socket: CDP shows it, Chrome CONNECTs (it waits). */
function siteOpens(w: World, requestId = "WS1", sessionId = "S1"): Promise<SocketTunnelClient> {
  w.cdp.emit("Network.webSocketCreated", { requestId, url: URL_WS }, sessionId);
  return SocketTunnelClient.connect(w.proxyPort);
}

/** An admitted socket to the 101: the TLS handshake, the handshake request
 *  as CDP and the proxy see it, the answer. */
/** `chrome`: Chrome's clock of an instant of this process's (its own base). */
async function opened(w: World, requestId = "WS1", attemptId = 41, sessionId = "S1", chrome: (mono: number) => number = (mono) => mono): Promise<SocketTunnelClient> {
  const connecting = siteOpens(w, requestId, sessionId);
  const asked = w.link.of("wsAdmit").length;
  await until(() => w.link.of("wsAdmit").length > asked, 3000, "the admission asked");
  w.answer({ admit: true, attemptId });
  const client = await connecting;
  expect(client.status).toBe(200);
  await client.tls();
  w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId, timestamp: chrome(monoMs()) / 1000 }, sessionId);
  const before = w.server.received().length;
  client.request();
  await until(() => w.server.received().subarray(before).includes(SOCKET_FILL.request), 3000, "the handshake request at the server");
  w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId, timestamp: chrome(monoMs()) / 1000, response: { status: 101 } }, sessionId);
  return client;
}

describe("admission before connection (condition №3; amendment 8)", () => {
  it("holds the CONNECT until the engine admits it; nothing reaches Fansly before", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1, 3000, "wsAdmit");
    const ask = w.link.of("wsAdmit")[0]!;
    expect(ask).toEqual({
      type: "wsAdmit",
      connectionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      url: URL_WS,
      context: "page",
      sessionFingerprint: FINGERPRINT,
      requestedMono: expect.any(Number),
      waitDeadlineMono: expect.any(Number),
    });
    // At most 2.5 s from the CONNECT, separately from HTTP's 60 s.
    expect((ask.waitDeadlineMono as number) - (ask.requestedMono as number)).toBeGreaterThan(2000);
    expect((ask.waitDeadlineMono as number) - (ask.requestedMono as number)).toBeLessThanOrEqual(2500);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Waiting: no SOCKS5 connection, no byte to the socket host.
    expect(w.socks.connects).toEqual([]);
    w.answer({ admit: true, deadlineMono: monoMs() + 5000, attemptId: 41 });
    const client = await connecting;
    expect(client.status).toBe(200);
    expect(w.socks.connects).toEqual(["wsv3.fansly.com:443"]);
    expect(w.journal.map((line) => line.event)).toEqual(["cdp_created", "asked", "admitted"]);
  });

  it("refused by the engine: the CONNECT is refused, nothing goes, no outcome is owed", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: false, reason: "route_hold" } as never);
    const client = await connecting;
    expect(client.status).toBe(403);
    await until(() => w.records.length === 1);
    expect(w.records[0]).toMatchObject({ host: "wsv3.fansly.com", cls: "ws", refused: true, result: "refused: socket not admitted" });
    expect(w.socks.connects).toEqual([]);
    expect(w.link.of("wsDone")).toEqual([]);
    expect(w.sockets.pending).toBe(0);
  });

  it("asks nothing and refuses at once when no admission may be given (no engine link, the buffer full...)", async () => {
    const w = await world();
    w.admitting.why = "no engine link";
    const client = await siteOpens(w);
    expect(client.status).toBe(403);
    expect(w.link.of("wsAdmit")).toEqual([]);
    await until(() => w.records.length === 1);
    expect(w.records[0]?.result).toBe("refused: socket not admitted (no engine link)");
  });

  it("one socket at a time: a second CONNECT waits — asked for once the first is accounted for (here: refused)", async () => {
    const w = await world();
    const first = siteOpens(w, "WS1");
    await until(() => w.link.of("wsAdmit").length === 1);
    const second = siteOpens(w, "WS2");
    await until(() => w.sockets.pending === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.link.of("wsAdmit")).toHaveLength(1);
    w.answer({ admit: false } as never);
    expect((await first).status).toBe(403);
    await until(() => w.link.of("wsAdmit").length === 2);
    const [a, b] = w.link.of("wsAdmit").map((message) => String(message.connectionId));
    expect(a).not.toBe(b);
    w.answer({ admit: false } as never, b);
    expect((await second).status).toBe(403);
  });

  it("tells the context of the socket waiting to connect: a frame's, a worker's", async () => {
    const w = await world();
    w.cdp.emit("Network.webSocketCreated", { requestId: "F1", url: URL_WS }, "S2");
    const frame = SocketTunnelClient.connect(w.proxyPort);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: false } as never);
    await frame;
    w.cdp.emit("Network.webSocketFrameError", { requestId: "F1", errorMessage: "net::ERR_TUNNEL_CONNECTION_FAILED" }, "S2");
    w.cdp.emit("Network.webSocketCreated", { requestId: "K1", url: URL_WS }, "W1");
    const worker = SocketTunnelClient.connect(w.proxyPort);
    await until(() => w.link.of("wsAdmit").length === 2);
    expect(w.link.of("wsAdmit").map((message) => message.context)).toEqual(["frame", "worker"]);
    w.answer({ admit: false } as never);
    await worker;
  });
});

describe("F2: the socket's document lifetime", () => {
  const navigate = (w: World, loaderId: string, session = "S1") => w.cdp.emit("Page.frameNavigated", { frame: { id: `FRAME-${session}`, loaderId, url: "https://fansly.com/" } }, session);

  it("withdraws both asked and queued CONNECTs before navigation, rejects the reload gap and returns a durable not-sent result to the old grant", async () => {
    const w = await world();
    navigate(w, "A");
    const first = siteOpens(w, "OLD1");
    await until(() => w.link.of("wsAdmit").length === 1);
    const id = String(w.link.of("wsAdmit")[0]!.connectionId);
    const second = siteOpens(w, "OLD2");
    await until(() => w.sockets.pending === 2);
    w.sockets.reloading("S1");
    expect((await first).status).toBe(403);
    expect((await second).status).toBe(403);
    expect(w.link.of("cancelAdmit")).toEqual([{ type: "cancelAdmit", kind: "ws", requestId: id, reason: "document_replaced" }]);
    expect((await SocketTunnelClient.connect(w.proxyPort)).status).toBe(403);
    w.answer({ admit: true, attemptId: 201 }, id);
    await until(() => w.outcome(201) !== null);
    expect(w.outcome(201)).toMatchObject({ sent: false, status: null });
    expect(w.socks.connects).toEqual([]);
    navigate(w, "B");
    const client = await opened(w, "NEW", 202);
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "OLD1" }, "S1");
    w.cdp.emit("Network.webSocketFrameError", { requestId: "OLD1", errorMessage: "old error" }, "S1");
    await until(() => w.outcome(202) !== null);
    expect(w.outcome(202)).toMatchObject({ sent: true, status: 101 });
    expect(w.sockets.openConnections).toBe(1);
    expect(w.stops).toEqual([]);
    expect(w.journal).toContainEqual(expect.objectContaining({ event: "cdp_ended", requestId: "OLD1", documentEpoch: expect.any(Number) }));
    client.destroy();
  });

  it("an old TCP connection whose CONNECT arrives after the new document is refused before any upstream connection", async () => {
    const w = await world();
    navigate(w, "A");
    const client = createConnection({ host: "127.0.0.1", port: w.proxyPort });
    cleanups.push(() => { client.destroy(); });
    let response = "";
    client.on("data", (data) => { response += data.toString("latin1"); });
    await until(() => w.tcpEpochs.length === 1);
    navigate(w, "B");
    client.write("CONNECT wsv3.fansly.com:443 HTTP/1.1\r\nHost: wsv3.fansly.com:443\r\n\r\n");
    await until(() => response.includes("\r\n\r\n"));
    expect(response).toContain("403");
    expect(w.link.of("wsAdmit")).toEqual([]);
    expect(w.socks.connects).toEqual([]);
    expect(w.records[0]?.result).toContain("replaced document epoch");
  });

  it("a committed document accounts for its unbound opened tunnel; a late old handshake cannot bind to the next tunnel", async () => {
    const w = await world({ soleDocument: true, timings: { accountWaitMs: 100 } });
    navigate(w, "A");
    const connecting = siteOpens(w, "OLD");
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 203 });
    const old = await connecting;
    await old.tls();
    // Navigation intent alone is no proof: it has not committed yet.
    w.sockets.reloading("S1");
    expect(w.sockets.busy).toBe(true);
    navigate(w, "B");
    await until(() => !w.sockets.busy);
    expect(w.outcome(203)).toMatchObject({ sent: false });
    const next = siteOpens(w, "NEW");
    await until(() => w.link.of("wsAdmit").length === 2);
    w.answer({ admit: true, attemptId: 204 });
    const client = await next;
    await client.tls();
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "OLD" }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "NEW" }, "S1");
    client.request();
    await until(() => w.server.received().includes(SOCKET_FILL.request));
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "NEW", response: { status: 101 } }, "S1");
    await until(() => w.outcome(204) !== null);
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(w.outcome(204)).toMatchObject({ status: 101 });
    expect(w.stops).toEqual([]);
    client.destroy();
    old.destroy();
  });

  it("a document commit is not proof for an unbound CONNECT with an ambiguous owner: round-6 fail-closed remains", async () => {
    const w = await world({ timings: { accountWaitMs: 80 } });
    navigate(w, "A");
    const connecting = siteOpens(w, "OLD");
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 205, deadlineMono: monoMs() + 100 });
    const client = await connecting;
    await client.tls();
    client.socket.resume();
    navigate(w, "B");
    await until(() => w.stops.length === 1);
    expect(w.stops[0]).toMatchObject({ reason: "ws_unaccounted" });
    expect(w.outcome(205)).toMatchObject({ sent: false });
    client.destroy();
  });

  it("the work tab's reload does not end a bound worker socket; losing its CDP target is not proof of a safe end", async () => {
    const w = await world();
    navigate(w, "A");
    const worker = await opened(w, "WORKER", 206, "W1");
    await until(() => w.outcome(206) !== null);
    navigate(w, "B");
    expect(w.sockets.openConnections).toBe(1);
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WORKER", response: { opcode: 1, payloadData: "kept" } }, "W1");
    await until(() => w.events().some((event) => event.kind === "ws.in"));
    w.cdp.emit("Target.detachedFromTarget", { sessionId: "W1" });
    expect(w.stops).toMatchObject([{ reason: "ws_unaccounted", note: expect.stringContaining("target detached") }]);
    w.sockets.endAll("the detached target cannot be observed");
    worker.destroy();
  });

  it("expires from CONNECT and withdraws the ask; reconnect cancellation is never sent on the new RPC epoch", async () => {
    const w = await world({ timings: { admitWaitMs: 80 } });
    const waiting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    expect((await waiting).status).toBe(403);
    expect(w.link.of("cancelAdmit")).toMatchObject([{ reason: "wait_expired", kind: "ws" }]);
    w.sockets.setAdmitWait(60_000);
    const next = siteOpens(w, "NEXT");
    await until(() => w.link.of("wsAdmit").length === 2);
    const ask = w.link.of("wsAdmit")[1]!;
    expect(Number(ask.waitDeadlineMono) - Number(ask.requestedMono)).toBeLessThanOrEqual(2500);
    w.link.epoch += 1;
    w.sockets.linkChanged();
    expect((await next).status).toBe(403);
    expect(w.link.of("cancelAdmit")).toHaveLength(1);
  });

  it.each(["document", "deadline"])("a grant whose durable commit waits past the %s boundary never opens its CONNECT", async (boundary) => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const w = await world({
      timings: { admitWaitMs: boundary === "deadline" ? 100 : 2500 },
      buffer: (inner) => {
        const wrapped = failingCommits(inner, { failing: false, pending: [], full: false });
        wrapped.changeConnection = (change) => {
          const kept = inner.changeConnection(change);
          return kept.ok ? { ...kept, durable: kept.durable.then(async (result) => { await blocked; return result; }) } : kept;
        };
        return wrapped;
      },
    });
    navigate(w, "A");
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 207 });
    if (boundary === "document") {
      w.sockets.reloading("S1");
      navigate(w, "B");
    } else await new Promise((resolve) => setTimeout(resolve, 150));
    // Expiry must answer the CONNECT even if the durable callback never
    // arrives. Rechecking only when that callback returns is unbounded.
    const beforeRelease = await Promise.race([connecting.then((client) => client.status), new Promise<number>((resolve) => setTimeout(() => resolve(-1), 1000))]);
    release();
    expect(beforeRelease).toBe(403);
    expect((await connecting).status).toBe(403);
    await until(() => w.outcome(207) !== null);
    expect(w.outcome(207)).toMatchObject({ sent: false });
    expect(w.socks.connects).toEqual([]);
  });

  it("Chrome restart withdraws waits, keeps the late grant not sent and admits the new document", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    const id = String(w.link.of("wsAdmit")[0]!.connectionId);
    w.sockets.endAll("Chrome restart");
    expect((await connecting).status).toBe(403);
    expect(w.link.of("cancelAdmit")).toEqual([{ type: "cancelAdmit", kind: "ws", requestId: id, reason: "operator_stopped" }]);
    await w.sockets.chromeStarting();
    navigate(w, "B");
    w.answer({ admit: true, attemptId: 208 }, id);
    await until(() => w.outcome(208) !== null);
    expect(w.outcome(208)).toMatchObject({ sent: false });
    const client = await opened(w, "FRESH", 209);
    expect(w.stops).toEqual([]);
    client.destroy();
  });
});

describe("the admission's deadline (spec §9)", () => {
  it("lets the handshake request go before the deadline, and reports when it went", async () => {
    const w = await world();
    const before = monoMs();
    await opened(w);
    await w.buffer.flush();
    await until(() => w.outcome(41) !== null, 3000, "the outcome");
    const done = w.outcome(41)!;
    expect(done).toEqual({ type: "wsDone", connectionId: expect.any(String), attemptId: 41, sent: true, sentMono: expect.any(Number), status: 101, error: null });
    expect(done.sentMono as number).toBeGreaterThan(before);
    expect(w.sockets.lastHandshake?.mono).toBe(done.sentMono);
  });

  it("cuts the tunnel at the deadline when the request has not gone: it never reaches Fansly", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, deadlineMono: monoMs() + 400, attemptId: 52 });
    const client = await connecting;
    expect(client.status).toBe(200);
    await client.tls();
    // TLS stalls past the deadline (ws-expiry-tls).
    await new Promise((resolve) => setTimeout(resolve, 600));
    client.request();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(w.server.received().includes(SOCKET_FILL.request)).toBe(false);
    expect(w.records.at(-1)).toMatchObject({ cls: "ws", result: "cut: the socket's admission expired before its handshake request" });
    await until(() => w.outcome(52) !== null, 3000, "the outcome");
    expect(w.outcome(52)).toMatchObject({ attemptId: 52, sent: false, sentMono: null, status: null });
  });

  it("refuses the CONNECT of an admission that came expired, and closes the attempt", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, deadlineMono: monoMs() - 1, attemptId: 53 });
    expect((await connecting).status).toBe(403);
    await until(() => w.outcome(53) !== null);
    expect(w.outcome(53)).toMatchObject({ sent: false, status: null, error: "not used: the admission came expired" });
    expect(w.socks.connects).toEqual([]);
  });

  it("an admission that finds its CONNECT gone ends at once, not sent", async () => {
    const w = await world();
    const client = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    const connectionId = String(w.link.of("wsAdmit")[0]!.connectionId);
    // Chrome drops it (the stand had the proxy end it: Chrome keeps one).
    w.egress.cutSocket(connectionId, "cut: a test");
    await client;
    await until(() => w.sockets.pending === 0);
    w.answer({ admit: true, attemptId: 54 }, connectionId);
    await until(() => w.outcome(54) !== null);
    expect(w.outcome(54)).toMatchObject({ connectionId, sent: false, error: expect.stringContaining("not used: the connection went before its admission") });
  });

  it("a repeated answer does nothing twice: the outcome of a used admission stands", async () => {
    const w = await world();
    await opened(w, "WS1", 75);
    const connectionId = String(w.link.of("wsAdmit")[0]!.connectionId);
    await until(() => w.outcome(75) !== null);
    w.answer({ admit: true, attemptId: 75 }, connectionId);
    w.answer({ admit: false } as never, connectionId);
    await w.buffer.flush();
    expect(w.outcome(75)).toMatchObject({ sent: true, status: 101 });
    expect(w.link.of("wsDone")).toEqual([]);
  });

  it("two sockets at once: the second waits for the first's whole life — asked for only once the first closed and its close is durable", async () => {
    const w = await world();
    await opened(w, "WS1", 61);
    const second = siteOpens(w, "WS2");
    await until(() => w.sockets.pending === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The first is open: the second's CONNECT waits, nothing asked.
    expect(w.link.of("wsAdmit")).toHaveLength(1);
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    await until(() => w.link.of("wsAdmit").length === 2, 3000, "the second asked");
    expect(w.events().map((event) => event.kind)).toEqual(["ws.open", "ws.close"]);
    w.answer({ admit: false } as never);
    expect((await second).status).toBe(403);
  });

  it("refuses the CONNECTs still waiting when the engine's link changes; an answer that comes later is closed, not used", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.sockets.linkChanged();
    expect((await connecting).status).toBe(403);
    w.answer({ admit: true, attemptId: 71 });
    await until(() => w.outcome(71) !== null);
    expect(w.outcome(71)).toMatchObject({ sent: false, error: expect.stringContaining("the engine's link changed") });
  });
});

describe("the handshake's outcome (wsDone)", () => {
  it("401/403/429: the status goes to the engine (its auth stop or ws.upgrade hold)", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 81 });
    const client = await connecting;
    await client.tls();
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1", timestamp: monoMs() / 1000 }, "S1");
    client.request();
    await until(() => w.server.received().includes(SOCKET_FILL.request));
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", timestamp: monoMs() / 1000, response: { status: 429 } }, "S1");
    await until(() => w.outcome(81) !== null);
    expect(w.outcome(81)).toMatchObject({ sent: true, status: 429, error: "the handshake was answered 429" });
    expect(w.events().filter((event) => event.kind === "ws.open")).toEqual([]);
    // No tunnel lives without its socket open (self-review of Astra's round 4).
    await until(() => w.records.some((record) => record.result === "cut: the handshake was answered 429"), 3000, "the tunnel cut");
    // Its end is Chrome's word on it, not the answer (self-review of round 6).
    expect(w.sockets.busy).toBe(true);
    w.cdp.emit("Network.webSocketFrameError", { requestId: "WS1", errorMessage: "Error during WebSocket handshake: Unexpected response code: 429" }, "S1");
    await until(() => !w.sockets.busy, 3000, "accounted for");
    expect(w.stops).toEqual([]);
  });

  it("a tunnel that ends after its request waits for CDP's status: the proxy's end and CDP's answer travel apart", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    const connectionId = w.answer({ admit: true, attemptId: 82 });
    const client = await connecting;
    await client.tls();
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1", timestamp: monoMs() / 1000 }, "S1");
    client.request();
    await until(() => w.server.received().includes(SOCKET_FILL.request));
    w.egress.cutSocket(connectionId, "closed by the server");
    await new Promise((resolve) => setTimeout(resolve, 50));
    w.cdp.emit("Network.webSocketFrameError", { requestId: "WS1", timestamp: monoMs() / 1000, errorMessage: "Error during WebSocket handshake: Unexpected response code: 403" }, "S1");
    await until(() => w.outcome(82) !== null);
    expect(w.outcome(82)).toMatchObject({ sent: true, status: 403, error: "Error during WebSocket handshake: Unexpected response code: 403" });
  });

  it("an unaccounted tunnel — its request went up, it ended, CDP silent on its socket — fails closed: the page stops (ws_unaccounted), nothing is reassigned, nothing admitted until Chrome starts again", async () => {
    const w = await world({ timings: { accountWaitMs: 200 } });
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    const connectionId = w.answer({ admit: true, attemptId: 83 });
    const client = await connecting;
    await client.tls();
    client.request();
    await until(() => w.server.received().includes(SOCKET_FILL.request));
    w.egress.cutSocket(connectionId, "closed by the server");
    await until(() => w.stops.length === 1, 3000, "the stop");
    expect(w.stops[0]).toMatchObject({ reason: "ws_unaccounted", how: "kill", note: expect.stringContaining("CDP did not say how its socket ended") });
    await until(() => w.outcome(83) !== null);
    expect(w.outcome(83)).toMatchObject({ sent: true, status: null, error: expect.stringContaining("not accounted for") });
    // The next socket is not admitted — not this Chrome's, whatever CDP says
    // later of the first.
    w.egress.openExit();
    const next = await siteOpens(w, "WS2");
    expect(next.status).toBe(403);
    expect(w.link.of("wsAdmit")).toHaveLength(1);
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1");
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", response: { status: 101 } }, "S1");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"late"}' } }, "S1");
    await w.buffer.flush();
    expect(w.events()).toEqual([]);
    // A new Chrome: admitted again.
    w.sockets.endAll("ws_unaccounted");
    await w.sockets.chromeStarting();
    await opened(w, "WS3", 84);
    await until(() => w.events().length === 3);
    // What the first socket carried is not in the stream: the browser's gap
    // when it went, and the reconnect's before the next.
    expect(w.events()).toMatchObject([
      { kind: "gap", reason: "chrome_restart", fromSeq: null, fromWall: null },
      // No socket event saved before the loss: the boundary is unknown.
      { kind: "gap", reason: "ws_reconnect", fromSeq: null, fromWall: null },
      { kind: "ws.open", attemptId: 84 },
    ]);
  });

  it("a second socket's handshake while the current one is bound fails closed: it cannot be told apart", async () => {
    const w = await world();
    await opened(w, "WS1", 85);
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS2", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS2" }, "S1");
    expect(w.stops).toMatchObject([{ reason: "ws_unaccounted", note: expect.stringContaining("a second socket's handshake") }]);
    await until(() => w.records.some((record) => record.result.startsWith("cut: a second socket's handshake")), 3000, "the tunnel cut");
  });

  it("a handshake on the tunnel that CDP never shows fails closed: its tunnel cut, the page stops (ws_unaccounted)", async () => {
    const w = await world({ timings: { bindWaitMs: 200 } });
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 87 });
    const client = await connecting;
    await client.tls();
    client.request();
    await until(() => w.server.received().includes(SOCKET_FILL.request));
    await until(() => w.outcome(87) !== null, 3000, "its outcome");
    expect(w.outcome(87)).toMatchObject({ sent: true, status: null, error: "not accounted for: its tunnel carried a handshake CDP did not show" });
    expect(w.stops).toMatchObject([{ reason: "ws_unaccounted" }]);
    await until(() => w.records.some((record) => record.result === "cut: its tunnel carried a handshake CDP did not show"), 3000, "the tunnel cut");
  });

  it.each(["CDP's close", "the browser going (endAll)"])("Astra's round 5: an open whose commit fails is tried again whatever becomes of the socket — after %s, the open and its outcome land, then the close", async (how) => {
    const control = { failing: false, pending: [] as Array<() => void>, full: false };
    const w = await world({ buffer: (inner) => failingCommits(inner, control) });
    control.failing = true;
    await opened(w, "WS1", 88);
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
    expect(w.outcome(88)).toMatchObject({ sent: true, status: 101, error: null });
    expect(w.buffer.connections()).toEqual([]);
    expect(w.sockets.unwritten).toBe(0);
  });

  it("an open the buffer refused is tried again; a close that comes before its retry waits for it — the close is never before its open", async () => {
    const control = { failing: false, pending: [] as Array<() => void>, full: false };
    const w = await world({ buffer: (inner) => failingCommits(inner, control), timings: { retryMs: [60_000] } });
    control.full = true;
    await opened(w, "WS1", 89);
    await until(() => w.link.of("wsDone").length === 1, 3000, "told from memory");
    expect(w.link.of("wsDone")[0]).toMatchObject({ attemptId: 89, status: 101 });
    // Room again — and CDP's close comes before the open is tried again.
    control.full = false;
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await w.buffer.flush();
    expect(w.events()).toEqual([]);
    w.sockets.retryNow();
    await until(() => w.events().length === 2, 3000, "the open, then the close");
    expect(w.events().map((event) => event.kind)).toEqual(["ws.open", "ws.close"]);
    expect(w.outcome(89)).toMatchObject({ status: 101 });
    expect(w.link.of("wsDone")).toHaveLength(1);
  });

  it("self-review: CDP told the socket's end in time and only the buffer is slow — no failure; the socket is accounted for once its writes are durable", async () => {
    const control = { failing: false, pending: [] as Array<() => void>, full: false };
    const w = await world({ buffer: (inner) => failingCommits(inner, control), timings: { accountWaitMs: 150, retryMs: [60_000] } });
    control.full = true;
    const client = await opened(w, "WS1", 90);
    const connectionId = String(w.link.of("wsAdmit")[0]!.connectionId);
    // The server goes; CDP says so in time.
    w.egress.cutSocket(connectionId, "closed by the server");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(w.stops).toEqual([]);
    expect(w.sockets.busy).toBe(true);
    control.full = false;
    w.sockets.retryNow();
    await until(() => !w.sockets.busy, 3000, "accounted for");
    expect(w.events().map((event) => event.kind)).toEqual(["ws.open", "ws.close"]);
    client.destroy();
  });

  it("Astra's round 6: a tunnel that ended with no request on it is not accounted for until CDP shows its socket's end — the next CONNECT waits, and the late handshake is its own admission's", async () => {
    const w = await world();
    const connecting = siteOpens(w, "WS1");
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 95, deadlineMono: monoMs() + 300 });
    const client = await connecting;
    await client.tls();
    // No request before the deadline: the proxy cuts the tunnel. Chrome may
    // have told the page the handshake started all the same.
    client.socket.resume();
    await until(() => w.outcome(95) !== null, 3000, "A's outcome");
    expect(w.outcome(95)).toMatchObject({ sent: false, error: expect.stringContaining("the tunnel ended before the handshake request") });
    const next = siteOpens(w, "WS2");
    await until(() => w.sockets.pending === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(w.link.of("wsAdmit")).toHaveLength(1);
    // A's handshake and its failure, late: they are A's, and A is accounted for.
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1");
    w.cdp.emit("Network.webSocketFrameError", { requestId: "WS1", errorMessage: "net::ERR_CONNECTION_CLOSED" }, "S1");
    await until(() => w.link.of("wsAdmit").length === 2, 3000, "B asked");
    w.answer({ admit: false } as never);
    expect((await next).status).toBe(403);
    expect(w.stops).toEqual([]);
    expect(w.outcome(95)).toMatchObject({ sent: false });
  });

  it("Astra's round 6: the same with CDP silent fails closed — nothing admitted after it until Chrome starts again", async () => {
    const w = await world({ timings: { accountWaitMs: 200 } });
    const connecting = siteOpens(w, "WS1");
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 96, deadlineMono: monoMs() + 300 });
    const client = await connecting;
    await client.tls();
    client.socket.resume();
    const next = siteOpens(w, "WS2");
    await until(() => w.stops.length === 1, 3000, "the stop");
    expect(w.stops[0]).toMatchObject({ reason: "ws_unaccounted" });
    // B was never asked for (its CONNECT went with the closed exit).
    expect((await next).status).not.toBe(200);
    expect(w.link.of("wsAdmit")).toHaveLength(1);
  });

  it("Astra's round 6: Chrome lost before the first 101 is told — the browser's gap covers what the socket carried, open in the stream or not", async () => {
    const w = await world();
    await w.sockets.afterRestart();
    const connecting = siteOpens(w, "WS1");
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 97 });
    const client = await connecting;
    await client.tls();
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1");
    client.request();
    await until(() => w.server.received().includes(SOCKET_FILL.request));
    // Chrome goes before CDP tells the 101; what it tells later is dropped.
    w.sockets.endAll("control lost");
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", response: { status: 101 } }, "S1");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"lost"}' } }, "S1");
    await until(() => w.events().length === 2, 3000, "the browser's gap");
    await w.sockets.chromeStarting();
    client.destroy();
    await opened(w, "WS2", 98);
    await until(() => w.events().length === 4, 3000, "B's open");
    expect(w.events().map((event) => `${String(event.kind)}${event.kind === "gap" ? `:${String(event.reason)}` : ""}`)).toEqual(["gap:operator_start", "gap:chrome_restart", "gap:ws_reconnect", "ws.open"]);
    // Both from the moment saved before the loss — none here: unknown.
    expect(w.events()[1]).toMatchObject({ fromSeq: null, fromWall: null });
    expect(w.events()[2]).toMatchObject({ fromSeq: null, fromWall: null });
    expect(w.events().filter((event) => event.kind === "ws.in")).toEqual([]);
    expect(w.outcome(97)).toMatchObject({ sent: true, status: null });
  });

  it("Astra's round 6: the sockets kept never lose a live one — sockets of other hosts are not kept, ended ones make room; only live ones at the bound fail closed", async () => {
    const w = await world();
    await opened(w, "WS1", 99);
    for (let n = 0; n < 1100; n++) w.cdp.emit("Network.webSocketCreated", { requestId: `X${n}`, url: `wss://other${n}.example/` }, "S1");
    for (let n = 0; n < 1100; n++) {
      w.cdp.emit("Network.webSocketCreated", { requestId: `R${n}`, url: URL_WS }, "S1");
      w.cdp.emit("Network.webSocketFrameError", { requestId: `R${n}`, errorMessage: "net::ERR_TUNNEL_CONNECTION_FAILED" }, "S1");
    }
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"still"}' } }, "S1");
    await until(() => w.events().length === 2, 3000, "the frame kept");
    expect(w.events()[1]).toMatchObject({ kind: "ws.in", frame: '{"t":2,"d":"still"}' });
    expect(w.stops).toEqual([]);
    // Live ones only, up to the bound: fail closed.
    for (let n = 0; n < 1000; n++) w.cdp.emit("Network.webSocketCreated", { requestId: `L${n}`, url: URL_WS }, "S1");
    expect(w.stops).toMatchObject([{ reason: "ws_unaccounted", note: expect.stringContaining("sockets of the host alive at once") }]);
  });

  it("self-review: a handshake of a socket no admitted tunnel is open for fails closed", async () => {
    const w = await world();
    w.cdp.emit("Network.webSocketCreated", { requestId: "WS9", url: URL_WS }, "S1");
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS9" }, "S1");
    expect(w.stops).toMatchObject([{ reason: "ws_unaccounted", note: expect.stringContaining("a handshake no admitted tunnel is open for") }]);
  });

  it.each([
    ["a second handshake of one socket", (w: World) => w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1")],
    ["a handshake of a socket CDP did not show being created, while a tunnel is open", (w: World) => w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "NEVER-CREATED" }, "S1")],
    [
      "frames of a socket no admitted tunnel was bound to",
      (w: World) => {
        w.cdp.emit("Network.webSocketCreated", { requestId: "WS2", url: URL_WS }, "S1");
        w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS2", response: { opcode: 1, payloadData: '{"t":2,"d":"x"}' } }, "S1");
      },
    ],
    ["frames of a socket no admitted tunnel was bound to", (w: World) => w.cdp.emit("Network.webSocketFrameReceived", { requestId: "NEVER-CREATED", response: { opcode: 1, payloadData: '{"t":2,"d":"x"}' } }, "S1")],
  ])("self-review (round 6): %s fails closed — nothing of it is kept", async (why, act) => {
    const w = await world();
    await opened(w, "WS1", 86);
    act(w);
    expect(w.stops).toMatchObject([{ reason: "ws_unaccounted", note: expect.stringContaining(why) }]);
    await w.buffer.flush();
    expect(w.events().filter((event) => event.kind === "ws.in")).toEqual([]);
  });

  it("Astra's round 7: a late first 101 after its tunnel ended — the frames lost before it are under the next gap, whose boundary is unknown, never the moment the 101 was taken", async () => {
    const w = await world();
    await w.sockets.afterRestart();
    const connecting = siteOpens(w, "WS1");
    await until(() => w.link.of("wsAdmit").length === 1);
    const connectionId = w.answer({ admit: true, attemptId: 101 });
    const client = await connecting;
    await client.tls();
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1");
    client.request();
    await until(() => w.server.received().includes(SOCKET_FILL.request));
    // Chrome got the 101 and a frame; the tunnel ended; CDP tells them late.
    w.egress.cutSocket(connectionId, "closed by the server");
    await new Promise((resolve) => setTimeout(resolve, 100));
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", response: { status: 101 } }, "S1");
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"lost"}' } }, "S1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    await until(() => !w.sockets.busy, 3000, "A accounted for");
    expect(w.stops).toEqual([]);
    client.destroy();
    await opened(w, "WS2", 102);
    await until(() => w.events().length === 3, 3000, "B's open");
    const events = w.events();
    expect(events.map((event) => `${String(event.kind)}${event.kind === "gap" ? `:${String(event.reason)}` : ""}`)).toEqual(["gap:operator_start", "gap:ws_reconnect", "ws.open"]);
    expect(events[1]).toMatchObject({ fromSeq: null, fromWall: null });
    expect(events.filter((event) => event.kind === "ws.in")).toEqual([]);
  });

  it("a tunnel that is not TLS is cut before anything goes", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 84 });
    const client = await connecting;
    client.socket.resume();
    client.socket.write("GET /?v=3 HTTP/1.1\r\nUpgrade: websocket\r\n\r\n");
    await client.closed;
    expect(w.server.received().toString("latin1")).not.toContain("GET /");
    await until(() => w.outcome(84) !== null);
    expect(w.outcome(84)).toMatchObject({ sent: false });
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
    const first = await opened(w, "WS1", 43, "S1", chrome);
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
    const second = await opened(w, "WS2", 44, "S1", chrome);
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

  it("go from CDP into the buffer, durable and in order: ws.open with the attempt and the session, every text frame as it is, ws.close", async () => {
    const w = await world();
    const client = await opened(w, "WS1", 41);
    const frames = Array.from({ length: 300 }, (_, n) => JSON.stringify({ t: 2, d: JSON.stringify({ n, marker: FRAME_SECRET }) }));
    for (const payloadData of frames) w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, mask: false, payloadData } }, "S1");
    // A binary frame is counted, not kept.
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 2, payloadData: "AAEC" } }, "S1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    await w.buffer.flush();
    await until(() => w.events().length === 302, 3000, "every event durable");
    const events = w.events();
    const connectionId = String(w.link.of("wsAdmit")[0]!.connectionId);
    expect(events[0]).toEqual({ seq: 1, atMono: expect.any(Number), atWall: expect.any(Number), kind: "ws.open", connectionId, attemptId: 41, sessionFingerprint: FINGERPRINT });
    expect(events.slice(1, 301).map((event) => event.frame)).toEqual(frames);
    expect(events.slice(1, 301).every((event) => event.kind === "ws.in" && event.connectionId === connectionId)).toBe(true);
    expect(events[301]).toMatchObject({ seq: 302, kind: "ws.close", connectionId, code: null, reason: null });
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 302 }, (_, n) => n + 1));
    client.destroy();
  });

  it("no admission is asked before the site's session is known: its socket could not authorize (the socket gate)", async () => {
    const w = await world();
    w.session.fingerprint = null;
    w.session.token = null;
    const client = await siteOpens(w);
    expect(client.status).toBe(403);
    expect(w.link.of("wsAdmit")).toEqual([]);
    await until(() => w.records.length === 1);
    expect(w.records[0]?.result).toBe("refused: socket not admitted (no session of the site yet: its socket could not authorize)");
  });

  it("an open connection stays when the engine's link goes (plan §4.9): its frames keep coming into the buffer", async () => {
    const w = await world();
    await opened(w);
    w.admitting.why = "no engine link";
    w.sockets.linkChanged();
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"{}"}' } }, "S1");
    await w.buffer.flush();
    await until(() => w.events().length === 2);
    expect(w.events().map((event) => event.kind)).toEqual(["ws.open", "ws.in"]);
    expect(w.egress.openTunnels).toBe(1);
    // ...and no new one is admitted.
    const next = await siteOpens(w, "WS2");
    expect(next.status).toBe(403);
    expect(w.link.of("wsAdmit")).toHaveLength(1);
  });
});

describe("gaps (plan §4.4, step 6; spec §6.1)", () => {
  it("at the operator's start, before a connection that follows a closed one, and before the closes when the browser goes — each from the last event of the socket before the break", async () => {
    const w = await world();
    await w.sockets.afterRestart();
    let client = await opened(w, "WS1", 41);
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"a"}' } }, "S1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    client.destroy();
    await w.buffer.flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    client = await opened(w, "WS2", 42);
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
    // The second connection's admission ended with the browser too.
    expect(w.outcome(42)).toMatchObject({ status: 101 });
  });
});

describe("the end of the page", () => {
  it("refuses what waits, ends what was admitted (not sent), closes what is open", async () => {
    const w = await world();
    const waiting = siteOpens(w, "WS1");
    await until(() => w.link.of("wsAdmit").length === 1);
    w.sockets.endAll("control lost");
    expect((await waiting).status).toBe(403);
    // Nothing is admitted before a new Chrome.
    expect((await siteOpens(w, "WS2")).status).toBe(403);
    await w.sockets.chromeStarting();
    const connecting = siteOpens(w, "WS3");
    await until(() => w.link.of("wsAdmit").length === 2);
    w.answer({ admit: true, attemptId: 91 });
    const client = await connecting;
    expect(client.status).toBe(200);
    w.sockets.endAll("control lost");
    await until(() => w.outcome(91) !== null);
    expect(w.outcome(91)).toMatchObject({ sent: false, error: "the page stopped: control lost" });
    client.destroy();
  });

  it("a new owner's quiesce: an earlier owner's admitted socket that has not sent its request never goes", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 92, ownerGeneration: 1 });
    const client = await connecting;
    w.sockets.quiesce(2);
    client.socket.resume();
    await client.closed;
    await until(() => w.outcome(92) !== null);
    expect(w.outcome(92)).toMatchObject({ sent: false, error: "a new owner of the page" });
    expect(w.server.received().includes(SOCKET_FILL.request)).toBe(false);
  });

  it("the engine's recover: an admitted socket whose request has not gone is not_sent and never goes; one that went is unknown", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 93 });
    const client = await connecting;
    expect(w.sockets.recoverState(93)).toBe("not_sent");
    client.socket.resume();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.outcome(93)).toBeNull();
    expect(w.sockets.recoverState(12345)).toBeNull();
    // Its tunnel opened: until CDP shows its socket's end (or Chrome goes),
    // no other socket is admitted.
    expect(w.sockets.busy).toBe(true);
    w.sockets.endAll("a test");
    await w.sockets.chromeStarting();
    const sent = await opened(w, "WS2", 94);
    expect(w.sockets.recoverState(94)).toBeNull();
    sent.destroy();
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
    const connectionId = String(w.link.of("wsAdmit")[0]!.connectionId);
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
    for (const secret of [TOKEN, FRAME_SECRET, "?v=3"]) expect(everything, secret).not.toContain(secret);
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
    expect(w.alarms).toEqual([{ kind: "unknown_ws_message", detail: { at: "proxy", recordBytes: TLS13_OVERHEAD + clientFrameBytes(40), why: "a message of no allowed size", context: "page", left: false } }]);
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

  it("the authorization goes once a connection, at the live token's size only", async () => {
    const twice = await world();
    const client = await unguarded(twice);
    client.message(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.authorization);
    client.message(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.forbidden);
    await client.closed;
    expect(twice.server.received().includes(SOCKET_FILL.forbidden)).toBe(false);
    expect(twice.alarms[0]?.detail).toMatchObject({ why: "a second authorization-sized message on the connection" });
    // Another token's size (a session the operator does not know).
    const other = await world();
    const second = await unguarded(other);
    second.message(authorizationBytes(`${SESSION_TOKEN}xx`), SOCKET_FILL.forbidden);
    await second.closed;
    expect(other.server.received().includes(SOCKET_FILL.forbidden)).toBe(false);
    // The session gone meanwhile: no authorization at all.
    const gone = await world();
    const third = await unguarded(gone);
    gone.session.token = null;
    third.message(authorizationBytes(SESSION_TOKEN), SOCKET_FILL.forbidden);
    await third.closed;
    expect(gone.server.received().includes(SOCKET_FILL.forbidden)).toBe(false);
    expect(gone.alarms[0]?.detail).toMatchObject({ why: "a message that is not the ping, and no live session to authorize" });
  });

  it("Chrome's own control frames go: an empty pong or close, a close with its code (1001 when the page goes), TLS alerts; a pong echoing a ping's payload is held", async () => {
    const w = await world();
    const client = await unguarded(w);
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
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.answer({ admit: true, attemptId: 101 });
    const client = await connecting;
    client.socket.write(Buffer.concat([Buffer.from([22, 3, 3, 0, 195]), Buffer.alloc(195, SOCKET_FILL.clientHello)]));
    client.socket.resume();
    await client.closed;
    expect(w.records.at(-1)).toMatchObject({ result: "cut: a TLS the socket gate cannot measure (1.2, suite 0xc013)" });
    await until(() => w.outcome(101) !== null);
    expect(w.outcome(101)).toMatchObject({ sent: false });
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
    expect(gate.decide(22, 100, rules)).toMatchObject({ up: false });
    expect(gate.decide(23, 29 + 116, rules)).toEqual({ up: true, record: "authorization" });
    expect(gate.decide(23, 29 + 116, rules)).toMatchObject({ up: false });
    expect(gate.decide(23, 29 + 9, rules)).toMatchObject({ up: false });
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

  async function operatorSide(holder: HolderUnderS6, buffer: SocketBuffer, extra: Partial<SocketDeps> = {}): Promise<{ cdp: Cdp; sockets: SiteSockets; link: FakeSocketLink }> {
    const cdp = new Cdp({ socketPath: holder.socketPath, commandTimeoutMs: 500, log: quiet });
    const link = new FakeSocketLink();
    const sockets = new SiteSockets({
      cdp,
      buffer,
      link,
      notAdmitting: () => null,
      sessionFingerprint: () => FINGERPRINT,
      authorizationBytes: () => authorizationBytes(SESSION_TOKEN),
      targetType: () => "page",
      documentOwner: () => null,
      socketHost: (host) => classifyFanslyHost(host) === "ws",
      cutTunnel: () => false,
      journal: () => undefined,
      alarm: () => undefined,
      stop: () => undefined,
      log: quiet,
      ...extra,
    });
    cleanups.push(() => sockets.close());
    await cdp.connect();
    await cdp.replayEnded;
    return { cdp, sockets, link };
  }

  /** The proxy's tunnel of the latest admission (its events). */
  let tunnelOf: SocketTicket | null = null;

  /** An admission of the operator, as the proxy asks it and the engine
   *  answers, and its tunnel open (the CONNECT went on). */
  async function admitted(sockets: SiteSockets, attemptId: number): Promise<string> {
    const ticket = sockets.admit("wsv3.fansly.com", 443);
    if (typeof ticket === "string") throw new Error(ticket);
    sockets.onAdmitResult({ type: "wsAdmitResult", ownerGeneration: 1, connectionId: ticket.id, admit: true, deadlineMono: monoMs() + 5000, attemptId });
    ticket.event({ kind: "open" });
    tunnelOf = ticket;
    return ticket.id;
  }

  /** The site's socket as Chrome reports it: created, its handshake — and
   *  the request up its tunnel, as the proxy sees it; then the 101. */
  function handshake(chrome: FakeChrome, requestId: string): void {
    chrome.event("Network.webSocketCreated", { requestId, url: "wss://wsv3.fansly.com/?v=3" }, "S1");
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
  const outcomeOf = (buffer: EventBuffer, attemptId: number) => {
    const stored = buffer.outcomes([attemptId])[0];
    return stored === undefined ? null : (JSON.parse(stored.json) as Record<string, unknown>);
  };

  it("a frame is acknowledged to the holder only once it is durable", async () => {
    const { chrome, holder, openBuffer, stored } = await holderWorld();
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    const controlled = new ControlledBuffer(buffer);
    const { cdp, sockets } = await operatorSide(holder, controlled);
    cleanups.push(() => cdp.close());
    await admitted(sockets, 41);
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

  it.each([
    ["before ws.open commits", 0],
    ["after ws.open commits", 1],
    ["between two frames", 2],
  ])("a crash %s: after the restart no frame is under a wrong connection, the old connection is ended exactly once, the start's gap covers the window, and what the holder kept is acknowledged unwritten", async (_when, kept) => {
    const { chrome, holder, openBuffer, stored } = await holderWorld();
    const first = openBuffer();
    const controlled = new ControlledBuffer(first);
    const a = await operatorSide(holder, controlled);
    const connectionId = await admitted(a.sockets, 61);
    handshake(chrome, "WS1");
    await until(() => first.connections().length === 1 && stored() === 0, 3000, "the admission kept");
    const steps = [() => answered(chrome, "WS1"), () => frame(chrome, "frame-1"), () => frame(chrome, "frame-2")];
    for (const step of steps.slice(0, kept)) {
      const before = holder.holder!.stats.lastSeq;
      step();
      await until(() => holder.holder!.stats.lastSeq === before + 1 && stored() === 0, 3000, "kept and acknowledged");
    }
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
    if (kept === 0) {
      // Never opened in the stream: ended by its outcome, its fate unknown.
      expect(after.map((event) => event.kind)).toEqual(["gap"]);
      expect(outcomeOf(second, 61)).toEqual({ type: "wsDone", connectionId, attemptId: 61, sent: false, sentMono: null, status: null, error: expect.stringContaining("the handshake's fate is unknown"), fate: "unknown" });
    } else {
      // Opened: ended by its one close — in one commit with the gap, after it.
      expect(after.map((event) => event.kind)).toEqual(["gap", "ws.close"]);
      expect(events.filter((event) => event.kind === "ws.close" && event.connectionId === connectionId)).toHaveLength(1);
      expect(outcomeOf(second, 61)).toMatchObject({ status: 101, sent: true });
    }
    expect(after[0]).toMatchObject({ kind: "gap", reason: "operator_start", fromSeq: lastSaved.seq === 0 ? null : lastSaved.seq, fromWall: lastSaved.seq === 0 ? null : lastSaved.wall });
    expect(second.connections()).toEqual([]);
  });

  it("Astra's round 3: A opened and closed, B admitted after it, B's answer never written — the operator dies: B is ended as never opened, its fate unknown; A is never ended again; what the holder kept is dropped", async () => {
    const { chrome, holder, openBuffer, stored } = await holderWorld();
    const first = openBuffer();
    const controlled = new ControlledBuffer(first);
    const a = await operatorSide(holder, controlled);
    const connectionA = await admitted(a.sockets, 71);
    handshake(chrome, "WS1");
    answered(chrome, "WS1");
    frame(chrome, "a-frame");
    chrome.event("Network.webSocketClosed", { requestId: "WS1", timestamp: monoMs() / 1000 }, "S1");
    await until(() => !a.sockets.busy && stored() === 0, 3000, "A accounted for");
    const connectionB = await admitted(a.sockets, 72);
    await until(() => first.connections().length === 1 && stored() === 0, 3000, "B kept");
    // The operator dies: B's answer is never written.
    controlled.crashed = true;
    const before = holder.holder!.stats.lastSeq;
    handshake(chrome, "WS2");
    answered(chrome, "WS2");
    await until(() => holder.holder!.stats.lastSeq === before + 3 && stored() === 1, 3000, "B's answer kept by the holder");
    await first.flush();
    expect(first.connections().map((connection) => connection.connectionId)).toEqual([connectionB]);
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
    expect(outcomeOf(second, 72)).toEqual({ type: "wsDone", connectionId: connectionB, attemptId: 72, sent: false, sentMono: null, status: null, error: expect.stringContaining("the handshake's fate is unknown"), fate: "unknown" });
    expect(outcomeOf(second, 71)).toMatchObject({ connectionId: connectionA, status: 101 });
    expect(second.connections()).toEqual([]);
  });

  /** A first operator: A admitted, open, a frame of `frameBytes` — all
   *  durable and acknowledged; then it dies. */
  async function firstLife(world: Awaited<ReturnType<typeof holderWorld>>, frameBytes = 10): Promise<{ connectionId: string; lastSaved: { seq: number; wall: number | null }; bytes: number }> {
    const first = world.openBuffer();
    const a = await operatorSide(world.holder, first);
    const connectionId = await admitted(a.sockets, 91);
    handshake(world.chrome, "WS1");
    answered(world.chrome, "WS1");
    frame(world.chrome, "x".repeat(frameBytes));
    await until(() => eventsOf(first).length === 2 && world.stored() === 0, 3000, "A's open and frame kept");
    const lastSaved = { seq: first.lastSeq, wall: first.lastWall };
    const bytes = first.stats().bytes;
    a.sockets.close();
    a.cdp.close();
    await first.close();
    return { connectionId, lastSaved, bytes };
  }

  // Astra's review of PR 15, round 7: the first events of a session told
  // late, before it has a calibration, are stamped no later than what is
  // proven of their connection (its CONNECT, its handshake as the proxy saw
  // it): a gap from them starts early, never late; a calibration is taken
  // only from a short round trip, and goes with its session.
  async function lateFirstBatch(shift: number) {
    const { chrome, holder, openBuffer } = await holderWorld();
    chrome.clockShiftMs = shift;
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    let past = 0;
    const { cdp, sockets } = await operatorSide(holder, buffer, { now: () => monoMs() - past });
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
    // The CONNECT and the handshake went five minutes ago (the proxy's clock).
    past = 310_000;
    await admitted(sockets, 91);
    past = 0;
    tunnelOf!.event({ kind: "handshake_sent", mono: t - 305_000, wall: wallT - 305_000 });
    // Chrome saw its answer, a frame and the close five minutes ago; CDP
    // tells them all only now.
    chrome.event("Network.webSocketCreated", { requestId: "WS-L", url: URL_WS }, "S1");
    chrome.event("Network.webSocketWillSendHandshakeRequest", { requestId: "WS-L", timestamp: chromeAt(t - 305_000) }, "S1");
    chrome.event("Network.webSocketHandshakeResponseReceived", { requestId: "WS-L", timestamp: chromeAt(t - 304_000), response: { status: 101, headers: {} } }, "S1");
    chrome.event("Network.webSocketFrameReceived", { requestId: "WS-L", timestamp: chromeAt(t - 300_000), response: { opcode: 1, payloadData: JSON.stringify({ t: 2, d: "late" }) } }, "S1");
    chrome.event("Network.webSocketClosed", { requestId: "WS-L", timestamp: chromeAt(t - 299_000) }, "S1");
    await until(() => eventsOf(buffer).some((event) => event.kind === "ws.close"), 3000, "the batch kept");
    expect(sockets.clockOf("S1")).toBeNull();
    answer();
    chrome.handlers.set("Performance.getMetrics", metrics);
    await until(() => sockets.clockOf("S1") !== null, 3000, "the session calibrated");
    return { chrome, buffer, sockets, t, wallT, chromeAt };
  }

  it.for([
    { chrome: "on the operator's clock", shift: 0 },
    { chrome: "an hour ahead", shift: 3_600_000 },
    { chrome: "an hour behind", shift: -3_600_000 },
  ])("Astra's round 7: the first batch told five minutes late, before its session's calibration (Chrome's clock $chrome): stamped no later than its handshake — the next gap from there, a message missed four minutes ago inside the repair's window", async ({ shift }) => {
    const { chrome, buffer, sockets, t, wallT, chromeAt } = await lateFirstBatch(shift);
    const late = eventsOf(buffer);
    for (const [kind, seen] of [["ws.open", t - 304_000], ["ws.in", t - 300_000], ["ws.close", t - 299_000]] as const) {
      const event = late.find((one) => one.kind === kind)!;
      // Never later than when Chrome saw it; no earlier than its CONNECT.
      expect(event.atMono as number, kind).toBeLessThanOrEqual(seen);
      expect(event.atMono as number, kind).toBeGreaterThanOrEqual(t - 310_000 - 1_000);
    }
    // The next connection, the session calibrated now: its events mapped,
    // its gap from the late frame's stamp.
    await admitted(sockets, 92);
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
    expect(gap.fromWall as number).toBeLessThanOrEqual(wallT - 300_000);
    // A calibrated stamp: at most the round trip early, never late.
    const fresh = events.filter((event) => event.kind === "ws.in")[1]!;
    const seen = (fresh.atMono as number);
    expect(seen).toBeLessThanOrEqual(monoMs() - 2_000 + 1);
  });

  it("a calibration from a round trip over a second is refused: the session stays uncalibrated (its events stamped by what is proven) until a short one is taken", async () => {
    const { chrome, holder, openBuffer } = await holderWorld();
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    const lines: string[] = [];
    const { cdp, sockets } = await operatorSide(holder, buffer, { log: (event, fields) => lines.push(`${event} ${JSON.stringify(fields ?? {})}`) });
    cleanups.push(() => cdp.close());
    chrome.clockDelayMs = CALIBRATION_MAX_MS + 300;
    await admitted(sockets, 93);
    handshake(chrome, "WS-S");
    await until(() => lines.some((line) => line.startsWith("clock.refused")), 5000, "the slow calibration refused");
    expect(sockets.clockOf("S1")).toBeNull();
    expect(lines.find((line) => line.startsWith("clock.refused"))).toContain("a round trip of");
    // Its events meanwhile: no later than its handshake (the proxy's).
    answered(chrome, "WS-S");
    await until(() => eventsOf(buffer).some((event) => event.kind === "ws.open"), 3000, "the open kept");
    const open = eventsOf(buffer).find((event) => event.kind === "ws.open")!;
    expect(open.atMono as number).toBeLessThanOrEqual(monoMs());
    // A short round trip: taken.
    chrome.clockDelayMs = 0;
    await until(() => sockets.clockOf("S1") !== null, 5000, "a calibration taken on retry");
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
    await admitted(sockets, 94);
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

  it("Astra's round 5: a worker stuck past every bound — its tunnel carried a handshake CDP does not show: the page stops, B is not admitted, and A's late events (freshly stamped) never reach anyone", async () => {
    const { chrome, holder, openBuffer, stored } = await holderWorld();
    const buffer = openBuffer();
    cleanups.push(() => buffer.close());
    const stops: string[] = [];
    // A's worker is a target of the first Chrome ("W0"): gone with it.
    let restarted = false;
    const { cdp, sockets } = await operatorSide(holder, buffer, { timings: { bindWaitMs: 100 }, stop: (reason) => stops.push(reason), targetType: (sessionId) => (sessionId === "W0" && restarted ? null : "worker") });
    cleanups.push(() => cdp.close());
    const connectionA = await admitted(sockets, 81);
    // A's request up its tunnel; the worker's CDP events do not come.
    tunnelOf!.event({ kind: "handshake_sent", mono: monoMs(), wall: Date.now() });
    await until(() => stops.length === 1, 3000, "the stop");
    expect(stops).toEqual(["ws_unaccounted"]);
    await until(() => outcomeOf(buffer, 81) !== null, 3000, "A's outcome");
    expect(outcomeOf(buffer, 81)).toMatchObject({ connectionId: connectionA, sent: true, status: null, error: expect.stringContaining("not accounted for") });
    // B's CONNECT: not admitted before a new Chrome.
    expect(sockets.admit("wsv3.fansly.com", 443)).toEqual(expect.stringContaining("nothing is admitted until Chrome starts again"));
    // The worker comes back: A's events, stamped now.
    const delivered = holder.holder!.stats.lastSeq;
    chrome.event("Network.webSocketCreated", { requestId: "WS-A", url: URL_WS }, "W0");
    chrome.event("Network.webSocketWillSendHandshakeRequest", { requestId: "WS-A", timestamp: monoMs() / 1000 }, "W0");
    chrome.event("Network.webSocketHandshakeResponseReceived", { requestId: "WS-A", timestamp: monoMs() / 1000, response: { status: 101, headers: {} } }, "W0");
    chrome.event("Network.webSocketFrameReceived", { requestId: "WS-A", response: { opcode: 1, payloadData: JSON.stringify({ t: 2, d: "a-frame" }) } }, "W0");
    // (The holder numbers the answers of the clock's calibration too.)
    await until(() => holder.holder!.stats.lastSeq >= delivered + 4 && stored() === 0, 3000, "A's late events taken");
    expect(eventsOf(buffer)).toEqual([]);
    // The page stopped (the browser went), a new Chrome starts: C is its own.
    sockets.endAll("ws_unaccounted");
    await sockets.chromeStarting();
    restarted = true;
    chrome.event("Network.webSocketFrameReceived", { requestId: "WS-A", response: { opcode: 1, payloadData: JSON.stringify({ t: 2, d: "a-frame-2" }) } }, "W0");
    const connectionC = await admitted(sockets, 83);
    handshake(chrome, "WS-C");
    answered(chrome, "WS-C");
    frame(chrome, "c-frame", "WS-C");
    await until(() => eventsOf(buffer).length === 4, 3000, "C's open and frame");
    // What A carried is not in the stream: the browser's gap and the one
    // before C cover it.
    expect(eventsOf(buffer).map((event) => [event.kind, event.connectionId ?? event.reason])).toEqual([
      ["gap", "chrome_restart"],
      ["gap", "ws_reconnect"],
      ["ws.open", connectionC],
      ["ws.in", connectionC],
    ]);
    expect(framesOf(eventsOf(buffer))).toEqual(["c-frame"]);
    expect(outcomeOf(buffer, 81)).toMatchObject({ sent: true, status: null });
    expect(outcomeOf(buffer, 83)).toMatchObject({ connectionId: connectionC, sent: true, status: 101 });
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
    const connectionId = await admitted(a.sockets, 86);
    handshake(chrome, "WS1");
    answered(chrome, "WS1");
    frame(chrome, "x".repeat(1500));
    await until(() => eventsOf(buffer).length === 2 && stored() === 0, 3000, "open, frame");
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
