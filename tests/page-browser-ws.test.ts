import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventBuffer } from "../apps/page-browser/src/buffer/buffer.ts";
import { CdpError } from "../apps/page-browser/src/cdp/client.ts";
import { classifyFanslyHost } from "../apps/page-browser/src/egress/hosts.ts";
import { Egress, type TunnelRecord } from "../apps/page-browser/src/egress/proxy.ts";
import type { SocketLine } from "../apps/page-browser/src/logs/journal.ts";
import type { WsAdmitResult } from "../apps/page-browser/src/rpc/protocol.ts";
import { makeLog, monoMs, setLogSink } from "../apps/page-browser/src/shared/util.ts";
import { guardExpression } from "../apps/page-browser/src/ws/guard.ts";
import { GuardInstaller } from "../apps/page-browser/src/ws/install.ts";
import { SiteSockets, type SocketTimings } from "../apps/page-browser/src/ws/sockets.ts";
import { FakeCdpPort, FakeSocketLink, FakeSocks, quiet, SOCKET_FILL, SocketTunnelClient, SOCKS_PASSWORD, SOCKS_USER, tempDir, tlsLikeServer, UNANSWERED, until } from "./helpers/page-browser-fakes.ts";

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
const FRAME_SECRET = "frame-content-marker-7c3b";
const URL_WS = "wss://wsv3.fansly.com/?v=3";

interface World {
  cdp: FakeCdpPort;
  egress: Egress;
  proxyPort: number;
  socks: FakeSocks;
  server: Awaited<ReturnType<typeof tlsLikeServer>>;
  buffer: EventBuffer;
  sockets: SiteSockets;
  link: FakeSocketLink;
  records: TunnelRecord[];
  journal: SocketLine[];
  alarms: Array<{ kind: string; detail: Record<string, unknown> }>;
  stops: Array<{ reason: string; note: string; how: string; exitOpen: boolean }>;
  lines: string[];
  admitting: { why: string | null };
  session: { fingerprint: string | null };
  /** The engine's answer to the latest (or a given) wsAdmit. */
  answer: (fields: Partial<WsAdmitResult> & { admit: boolean }, connectionId?: string) => string;
  events: () => Array<Record<string, unknown>>;
  outcome: (attemptId: number) => Record<string, unknown> | null;
}

async function world(options: { timings?: Partial<SocketTimings> } = {}): Promise<World> {
  const temp = tempDir("pb-ws-");
  cleanups.push(temp.remove);
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const cdp = new FakeCdpPort();
  const server = await tlsLikeServer();
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
  const session = { fingerprint: FINGERPRINT as string | null };
  let sockets: SiteSockets | null = null;
  const egress = new Egress({ classify: classifyFanslyHost, admitSocket: (host, port) => sockets!.admit(host, port), onRecord: (record) => records.push(record), log: makeLog("egress") });
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
    buffer,
    link,
    notAdmitting: () => admitting.why,
    sessionFingerprint: () => session.fingerprint,
    targetType: (sessionId) => (sessionId === null ? null : (types.get(sessionId) ?? null)),
    cutTunnel: (connectionId, reason) => egress.cutSocket(connectionId, reason),
    journal: (line) => journal.push(line),
    alarm: (kind, detail) => alarms.push({ kind, detail }),
    stop: (reason, note, how) => {
      stops.push({ reason, note, how, exitOpen: egress.exitOpen });
      egress.closeExit(note);
    },
    timings: { handshakeGraceMs: 300, ...options.timings },
    log: makeLog("ws"),
  });
  const created = sockets;
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
  return { cdp, egress, proxyPort, socks, server, buffer, sockets: created, link, records, journal, alarms, stops, lines, admitting, session, answer, events, outcome };
}

/** The site opens a socket: CDP shows it, Chrome CONNECTs (it waits). */
function siteOpens(w: World, requestId = "WS1", sessionId = "S1"): Promise<SocketTunnelClient> {
  w.cdp.emit("Network.webSocketCreated", { requestId, url: URL_WS }, sessionId);
  return SocketTunnelClient.connect(w.proxyPort);
}

/** An admitted socket to the 101: the TLS handshake, the handshake request
 *  as CDP and the proxy see it, the answer. */
async function opened(w: World, requestId = "WS1", attemptId = 41, sessionId = "S1"): Promise<SocketTunnelClient> {
  const connecting = siteOpens(w, requestId, sessionId);
  const asked = w.link.of("wsAdmit").length;
  await until(() => w.link.of("wsAdmit").length > asked, 3000, "the admission asked");
  w.answer({ admit: true, attemptId });
  const client = await connecting;
  expect(client.status).toBe(200);
  await client.tls();
  w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId }, sessionId);
  client.request();
  await until(() => w.server.received().includes(SOCKET_FILL.request), 3000, "the handshake request at the server");
  w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId, response: { status: 101 } }, sessionId);
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
    expect((ask.waitDeadlineMono as number) - (ask.requestedMono as number)).toBe(60_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Waiting: no SOCKS5 connection, no byte to the socket host.
    expect(w.socks.connects).toEqual([]);
    w.answer({ admit: true, deadlineMono: monoMs() + 5000, attemptId: 41 });
    const client = await connecting;
    expect(client.status).toBe(200);
    expect(w.socks.connects).toEqual(["wsv3.fansly.com:443"]);
    expect(w.journal.map((line) => line.event)).toEqual(["asked", "admitted"]);
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

  it("one tunnel per socket: every CONNECT asks for its own admission", async () => {
    const w = await world();
    const first = siteOpens(w, "WS1");
    const second = siteOpens(w, "WS2");
    await until(() => w.link.of("wsAdmit").length === 2);
    const [a, b] = w.link.of("wsAdmit").map((message) => String(message.connectionId));
    expect(a).not.toBe(b);
    w.answer({ admit: false } as never, a);
    w.answer({ admit: false } as never, b);
    expect((await first).status).toBe(403);
    expect((await second).status).toBe(403);
  });

  it("tells the context of the socket waiting to connect: a frame's, a worker's", async () => {
    const w = await world();
    w.cdp.emit("Network.webSocketCreated", { requestId: "F1", url: URL_WS }, "S2");
    const frame = SocketTunnelClient.connect(w.proxyPort);
    await until(() => w.link.of("wsAdmit").length === 1);
    w.cdp.emit("Network.webSocketCreated", { requestId: "K1", url: URL_WS }, "W1");
    const worker = SocketTunnelClient.connect(w.proxyPort);
    await until(() => w.link.of("wsAdmit").length === 2);
    expect(w.link.of("wsAdmit").map((message) => message.context)).toEqual(["frame", "worker"]);
    w.answer({ admit: false } as never, String(w.link.of("wsAdmit")[0]!.connectionId));
    w.answer({ admit: false } as never, String(w.link.of("wsAdmit")[1]!.connectionId));
    await frame;
    await worker;
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

  it("closes unused an admission given while another admitted socket is not tied yet", async () => {
    const w = await world();
    const first = siteOpens(w, "WS1");
    const second = siteOpens(w, "WS2");
    await until(() => w.link.of("wsAdmit").length === 2);
    const [a, b] = w.link.of("wsAdmit").map((message) => String(message.connectionId));
    w.answer({ admit: true, attemptId: 61 }, a);
    w.answer({ admit: true, attemptId: 62 }, b);
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(403);
    await until(() => w.outcome(62) !== null);
    expect(w.outcome(62)).toMatchObject({ sent: false, error: "not used: another admitted socket is not tied to its CDP socket yet" });
    (await first).destroy();
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
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1");
    client.request();
    await until(() => w.server.received().includes(SOCKET_FILL.request));
    w.cdp.emit("Network.webSocketHandshakeResponseReceived", { requestId: "WS1", response: { status: 429 } }, "S1");
    await until(() => w.outcome(81) !== null);
    expect(w.outcome(81)).toMatchObject({ sent: true, status: 429, error: "the handshake was answered 429" });
    expect(w.events().filter((event) => event.kind === "ws.open")).toEqual([]);
  });

  it("a tunnel that ends after its request waits for CDP's status: the proxy's end and CDP's answer travel apart", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    const connectionId = w.answer({ admit: true, attemptId: 82 });
    const client = await connecting;
    await client.tls();
    w.cdp.emit("Network.webSocketWillSendHandshakeRequest", { requestId: "WS1" }, "S1");
    client.request();
    await until(() => w.server.received().includes(SOCKET_FILL.request));
    w.egress.cutSocket(connectionId, "closed by the server");
    await new Promise((resolve) => setTimeout(resolve, 50));
    w.cdp.emit("Network.webSocketFrameError", { requestId: "WS1", errorMessage: "Error during WebSocket handshake: Unexpected response code: 403" }, "S1");
    await until(() => w.outcome(82) !== null);
    expect(w.outcome(82)).toMatchObject({ sent: true, status: 403, error: "Error during WebSocket handshake: Unexpected response code: 403" });
  });

  it("without CDP's word in time, ends as sent with no status", async () => {
    const w = await world();
    const connecting = siteOpens(w);
    await until(() => w.link.of("wsAdmit").length === 1);
    const connectionId = w.answer({ admit: true, attemptId: 83 });
    const client = await connecting;
    await client.tls();
    client.request();
    await until(() => w.server.received().includes(SOCKET_FILL.request));
    w.egress.cutSocket(connectionId, "closed by the server");
    await until(() => w.outcome(83) !== null, 3000);
    expect(w.outcome(83)).toMatchObject({ sent: true, status: null, error: expect.stringContaining("the tunnel ended before the handshake's answer") });
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

  it("ws.open says no session when the site has none yet (an addition to spec §6.1)", async () => {
    const w = await world();
    w.session.fingerprint = null;
    await opened(w);
    await w.buffer.flush();
    await until(() => w.events().length === 1);
    expect(w.events()[0]).toMatchObject({ kind: "ws.open", sessionFingerprint: null });
    expect(w.link.of("wsAdmit")[0]).toMatchObject({ sessionFingerprint: null });
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
  it("at the operator's start, before a connection that follows a closed one, and after a Chrome that had one — each from the last event before the break", async () => {
    const w = await world();
    w.sockets.operatorStarted();
    let client = await opened(w, "WS1", 41);
    w.cdp.emit("Network.webSocketFrameReceived", { requestId: "WS1", response: { opcode: 1, payloadData: '{"t":2,"d":"a"}' } }, "S1");
    w.cdp.emit("Network.webSocketClosed", { requestId: "WS1" }, "S1");
    client.destroy();
    await w.buffer.flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    client = await opened(w, "WS2", 42);
    await w.buffer.flush();
    // The browser goes under the open connection: it is closed in the stream
    // (and durable long before the next Chrome is up).
    w.sockets.endAll("a test");
    await w.buffer.flush();
    w.sockets.chromeStarting();
    // A Chrome that had no connection leaves no gap.
    w.sockets.chromeStarting();
    client.destroy();
    await w.buffer.flush();
    await until(() => w.events().length === 8, 3000, "8 events");
    const events = w.events();
    expect(events.map((event) => `${String(event.kind)}${event.kind === "gap" ? `:${String(event.reason)}` : ""}`)).toEqual([
      "gap:operator_start",
      "ws.open",
      "ws.in",
      "ws.close",
      "gap:ws_reconnect",
      "ws.open",
      "ws.close",
      "gap:chrome_restart",
    ]);
    expect(events[0]).toMatchObject({ fromSeq: null, fromWall: null });
    expect(events[4]).toMatchObject({ fromSeq: 4, fromWall: events[3]!.atWall });
    expect(events[7]).toMatchObject({ fromSeq: 7, fromWall: events[6]!.atWall });
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
    const connecting = siteOpens(w, "WS2");
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
