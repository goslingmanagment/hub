import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { connect as tcpConnect, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import type { EventBody } from "../../apps/page-browser/src/buffer/buffer.ts";
import { Holder } from "../../apps/page-browser/src/holder/holder.ts";
import type { ChromeControl } from "../../apps/page-browser/src/operator/chrome.ts";
import type { Result } from "../../apps/page-browser/src/rpc/protocol.ts";
import { acceptWebSocket, clientHandshake, type WsConnection } from "../../apps/page-browser/src/shared/ws.ts";

// Fakes for the page browser's unit tests (Project Browser plan §3.3:
// "the operator with a fake CDP"): Chrome's DevTools endpoint, the page's
// SOCKS5, the exit-IP service, the engine's side of the RPC. No Docker, no
// Chrome: everything listens on 127.0.0.1 or a unix socket in a temp dir.

export const quiet = (): void => undefined;

export async function until(predicate: () => boolean, timeoutMs = 5000, what = "a condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function tempDir(prefix = "pb-"): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface CdpCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

type Reply = Record<string, unknown> | { error: { code: number; message: string } } | null;

/** Chrome's DevTools endpoint, scripted: /json/version and the browser
 *  target's WebSocket. Commands get `{}` unless a handler answers them; a
 *  handler returning null answers nothing (yet). */
export class FakeChrome {
  readonly commands: CdpCommand[] = [];
  readonly handlers = new Map<string, (command: CdpCommand) => Reply | Promise<Reply>>();
  readonly connections: WsConnection[] = [];
  #server: HttpServer | null = null;
  port = 0;
  /** Accepting connections (the browser runs). */
  running = false;

  async boot(): Promise<void> {
    if (this.running) return;
    const server = createHttpServer((req, res) => {
      if (req.url === "/json/version") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ Browser: "Chrome/155.0.8059.39", webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser/fake` }));
        return;
      }
      res.writeHead(404).end();
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const ws = acceptWebSocket(req, socket, head, 64 * 1024 * 1024);
      if (!ws) return;
      this.connections.push(ws);
      ws.onText = (payload) => void this.#onCommand(ws, JSON.parse(payload.toString("utf8")) as CdpCommand);
    });
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (typeof address === "object" && address) this.port = address.port;
    this.#server = server;
    this.running = true;
  }

  /** The browser goes: its connections close, its port refuses. */
  async shutdown(): Promise<void> {
    this.running = false;
    for (const ws of this.connections.splice(0)) ws.destroy("chrome gone");
    const server = this.#server;
    this.#server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  get live(): WsConnection | undefined {
    return this.connections.filter((ws) => !ws.closed).at(-1);
  }

  /** An event to the (latest) DevTools connection. */
  event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.live?.sendText(JSON.stringify(sessionId === undefined ? { method, params } : { method, params, sessionId }));
  }

  reply(command: CdpCommand, result: Record<string, unknown>): void {
    const message: Record<string, unknown> = { id: command.id, result };
    if (command.sessionId !== undefined) message.sessionId = command.sessionId;
    this.live?.sendText(JSON.stringify(message));
  }

  sent(method: string): CdpCommand[] {
    return this.commands.filter((command) => command.method === method);
  }

  async #onCommand(ws: WsConnection, command: CdpCommand): Promise<void> {
    this.commands.push(command);
    const handler = this.handlers.get(command.method);
    const reply = handler ? await handler(command) : {};
    if (reply === null || ws.closed) return;
    const message: Record<string, unknown> = { id: command.id };
    if (command.sessionId !== undefined) message.sessionId = command.sessionId;
    if ("error" in reply) message.error = reply.error;
    else message.result = reply;
    ws.sendText(JSON.stringify(message));
  }
}

/** The CDP holder in this process, restarted like s6 restarts it. */
export class HolderUnderS6 {
  holder: Holder | null = null;
  exits: number[] = [];
  #stopped = false;
  readonly socketPath: string;
  readonly chrome: FakeChrome;
  readonly maxBytes: number;

  constructor(socketPath: string, chrome: FakeChrome, maxBytes = 128 * 1024 * 1024) {
    this.socketPath = socketPath;
    this.chrome = chrome;
    this.maxBytes = maxBytes;
  }

  async start(): Promise<void> {
    const holder = new Holder({
      cdpHost: "127.0.0.1",
      cdpPort: this.chrome.port,
      socketPath: this.socketPath,
      maxBytes: this.maxBytes,
      killChrome: () => this.chrome.shutdown(),
      overflowGraceMs: 2000,
      pollMs: 20,
      onExit: (code) => {
        this.exits.push(code);
        void holder.close().then(() => {
          if (!this.#stopped) setTimeout(() => void this.start(), 30);
        });
      },
      log: quiet,
    });
    this.holder = holder;
    await holder.start();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.holder?.close();
  }
}

/** Chrome's s6 service, around a FakeChrome. */
export class FakeChromeControl implements ChromeControl {
  readonly chrome: FakeChrome;
  readonly calls: string[] = [];
  networkPid: number | null = 4242;
  /** Chrome's run script, before Chrome is up (the model reads the
   *  page's environment there). */
  onStart: () => void = () => undefined;

  constructor(chrome: FakeChrome) {
    this.chrome = chrome;
  }

  async start(): Promise<void> {
    this.calls.push("start");
    this.onStart();
    await this.chrome.boot();
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
    await this.chrome.shutdown();
  }

  async kill(): Promise<void> {
    this.calls.push("kill");
    await this.chrome.shutdown();
  }

  async isUp(): Promise<boolean> {
    return this.chrome.running;
  }

  networkServicePid(): number | null {
    return this.networkPid;
  }
}

/** The page's SOCKS5: username/password (RFC 1929), CONNECT by domain name
 *  to a route of this table (host:port → a local port). */
export class FakeSocks {
  readonly username: string;
  readonly password: string;
  readonly routes = new Map<string, number>();
  readonly logins: Array<{ username: string; password: string; ok: boolean }> = [];
  readonly connects: string[] = [];
  #server: TcpServer | null = null;
  readonly #sockets = new Set<Socket>();
  port = 0;

  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
  }

  async start(): Promise<void> {
    const server = createTcpServer((socket) => this.#serve(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (typeof address === "object" && address) this.port = address.port;
    this.#server = server;
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #serve(socket: Socket): void {
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffered = Buffer.alloc(0);
    let step: "greeting" | "auth" | "connect" | "relay" = "greeting";
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (step === "greeting") {
        if (buffered.length < 2 || buffered.length < 2 + buffered[1]!) return;
        const methods = [...buffered.subarray(2, 2 + buffered[1]!)];
        buffered = buffered.subarray(2 + buffered[1]!);
        if (!methods.includes(2)) {
          socket.end(Buffer.from([5, 0xff]));
          return;
        }
        socket.write(Buffer.from([5, 2]));
        step = "auth";
      }
      if (step === "auth") {
        if (buffered.length < 2) return;
        const userLength = buffered[1]!;
        if (buffered.length < 3 + userLength) return;
        const passLength = buffered[2 + userLength]!;
        if (buffered.length < 3 + userLength + passLength) return;
        const username = buffered.subarray(2, 2 + userLength).toString();
        const password = buffered.subarray(3 + userLength, 3 + userLength + passLength).toString();
        buffered = buffered.subarray(3 + userLength + passLength);
        const ok = username === this.username && password === this.password;
        this.logins.push({ username, password, ok });
        if (!ok) {
          socket.end(Buffer.from([1, 1]));
          return;
        }
        socket.write(Buffer.from([1, 0]));
        step = "connect";
      }
      if (step === "connect") {
        if (buffered.length < 5) return;
        const nameLength = buffered[4]!;
        if (buffered.length < 5 + nameLength + 2) return;
        const host = buffered.subarray(5, 5 + nameLength).toString();
        const port = buffered.readUInt16BE(5 + nameLength);
        buffered = buffered.subarray(7 + nameLength);
        this.connects.push(`${host}:${port}`);
        const local = this.routes.get(`${host}:${port}`);
        const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
        if (local === undefined) {
          socket.end(reply(4));
          return;
        }
        step = "relay";
        socket.off("data", onData);
        socket.pause();
        const upstream = tcpConnect({ host: "127.0.0.1", port: local }, () => {
          socket.write(reply(0));
          if (buffered.length > 0) upstream.write(buffered);
          socket.pipe(upstream).pipe(socket);
          socket.resume();
        });
        upstream.on("error", () => socket.destroy());
        socket.on("close", () => upstream.destroy());
      }
    };
    socket.on("data", onData);
  }
}

/** The exit-IP service over plain HTTP: answers `ip`. */
export async function fakeIpify(answer: () => string | Promise<string>): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createHttpServer((_req, res) => {
    res.setHeader("content-type", "text/plain");
    void Promise.resolve(answer()).then((ip) => res.end(ip));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A local TCP echo server (what a tunnel reaches). */
export async function echoServer(): Promise<{ port: number; received: Buffer[]; close: () => Promise<void> }> {
  const received: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      received.push(chunk);
      socket.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A CONNECT through the operator's proxy; resolves with the status line
 *  and the socket (open on 200), paused. */
export function proxyConnect(proxyPort: number, target: string): Promise<{ status: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: "127.0.0.1", port: proxyPort }, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      // Paused, with what came after the answer put back: nothing is lost
      // before the caller reads (and resumes).
      socket.pause();
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(buffered.toString("latin1"))?.[1] ?? 0);
      const rest = buffered.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve({ status, socket });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("close", () => resolve({ status: 0, socket }));
  });
}

/** The engine's end of the RPC. */
export class FakeEngine {
  readonly messages: Array<Record<string, unknown>> = [];
  ws: WebSocket | null = null;
  closed: { code: number } | null = null;
  answerPings = true;

  connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
      this.ws = ws;
      this.closed = null;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the RPC connection failed"));
      ws.onclose = (event) => (this.closed = { code: event.code });
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        this.messages.push(message);
        if (message.type === "ping" && this.answerPings) this.send({ type: "pong", n: message.n, ownerGeneration: this.generation });
      };
    });
  }

  generation = 1;

  send(message: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(message));
  }

  of(type: string): Array<Record<string, unknown>> {
    return this.messages.filter((message) => message.type === type);
  }

  last(type: string): Record<string, unknown> | undefined {
    return this.of(type).at(-1);
  }

  async waitFor(type: string, predicate: (message: Record<string, unknown>) => boolean = () => true, timeoutMs = 5000): Promise<Record<string, unknown>> {
    let found: Record<string, unknown> | undefined;
    await until(() => (found = this.of(type).find(predicate)) !== undefined, timeoutMs, `a ${type} message`);
    return found!;
  }

  close(): void {
    this.ws?.close();
  }
}

/** A frame of the site's socket, as PR 10 will append it: number `n`,
 *  padded to make it bigger. */
export function wsFrame(n: number, pad = 0, connectionId = "conn-1"): EventBody {
  return { kind: "ws.in", connectionId, frame: `{"t":2,"d":"{\\"n\\":${n}}"}${"x".repeat(pad)}` };
}

/** A Hub request's outcome, as PR 9 will put it (`pad`: a header that
 *  makes it bigger). */
export function hubResult(attemptId: number, status = 200, pad = 0): Result {
  return {
    type: "result",
    attemptId,
    sessionFingerprint: "a".repeat(64),
    outcome: {
      kind: "response",
      status,
      headers: { "content-type": "application/json", ...(pad > 0 ? { "x-pad": "x".repeat(pad) } : {}) },
      body: { bodyId: `00000000-0000-4000-8000-${String(attemptId).padStart(12, "0")}`, decodedBytes: 2, sha256: "b".repeat(64) },
      encodedBytes: 2,
      source: "network",
      sentMono: 1000,
      sendMark: "transport_reported",
    },
  };
}

/** The engine's end of the RPC on a raw socket that can stop reading — what
 *  a slow or stuck engine looks like to the operator: its socket fills. It
 *  keeps pinging meanwhile, so the link stays up. */
export class RawEngine {
  readonly messages: Array<Record<string, unknown>> = [];
  generation = 1;
  #socket: Socket | null = null;
  #ws: WsConnection | null = null;
  #pings: NodeJS.Timeout | null = null;
  #n = 0;

  async connect(port: number): Promise<void> {
    const socket = tcpConnect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.on("error", () => undefined);
    this.#socket = socket;
    const ws = await clientHandshake(socket, `127.0.0.1:${port}`, "/rpc", 256 * 1024 * 1024);
    ws.onText = (payload) => this.messages.push(JSON.parse(payload.toString("utf8")) as Record<string, unknown>);
    this.#ws = ws;
    this.#pings = setInterval(() => this.send({ type: "ping", n: ++this.#n, ownerGeneration: this.generation }), 50);
  }

  send(message: Record<string, unknown>): void {
    this.#ws?.sendText(JSON.stringify(message));
  }

  /** Stops reading: what the operator sends waits in the sockets. */
  pause(): void {
    this.#socket?.pause();
  }

  resume(): void {
    this.#socket?.resume();
  }

  of(type: string): Array<Record<string, unknown>> {
    return this.messages.filter((message) => message.type === type);
  }

  async waitFor(type: string, predicate: (message: Record<string, unknown>) => boolean = () => true, timeoutMs = 5000): Promise<Record<string, unknown>> {
    let found: Record<string, unknown> | undefined;
    await until(() => (found = this.of(type).find(predicate)) !== undefined, timeoutMs, `a ${type} message`);
    return found!;
  }

  close(): void {
    if (this.#pings) clearInterval(this.#pings);
    this.#pings = null;
    this.#ws?.destroy("the test ends");
  }
}

export const SOCKS_USER = "pb-user-7f3a";
export const SOCKS_PASSWORD = "S0cks-Pa55-9c1e2d";
export const RPC_TOKEN = "rpc-token-0123456789abcdef0123456789abcdef";

export function hello(overrides: Record<string, unknown> = {}, params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "hello",
    ownerGeneration: 1,
    protocol: { majors: [1], minor: 0 },
    token: RPC_TOKEN,
    pageId: 7,
    expectedAccountId: "123456789",
    pinnedExitIp: "203.0.113.7",
    params: {
      pingMs: 100,
      linkLossMs: 600,
      cancelMarginMs: 1000,
      siteAdmitWaitMs: 60_000,
      siteRequestLimitMs: 20_000,
      bufferBatchMs: 20,
      eventBatch: { maxEvents: 500, maxBytes: 1_048_576 },
      exitIpCheckMs: 300_000,
      bufferCap: { bytes: 2_147_483_648, ageMs: 259_200_000, alarmPercents: [50, 80] },
      selfTestMaxMs: 4000,
      screenshotMs: 1000,
      chromeBodyBuffer: { totalBytes: 104_857_600, perResponseBytes: 20_971_520 },
      restartBackoffMs: [150, 300],
      ...params,
    },
    socks5: { ip: "127.0.0.1", port: 1080, username: SOCKS_USER, password: SOCKS_PASSWORD },
    env: { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } },
    ...overrides,
  };
}

export function writeNetSelftest(path: string, ok = true): void {
  writeFileSync(
    path,
    JSON.stringify({
      ok,
      at: new Date().toISOString(),
      results: [
        { user: "pb-chrome", what: "the operator's proxy", pass: true },
        { user: "pb-chrome", what: "the internet", pass: ok },
      ],
    }),
  );
}

/** What the scripted browser saw happen to a request. */
export interface ModelRequest {
  interceptionId: string;
  networkId: string;
  url: string;
  fragment: string;
  method: string;
  sessionId: string | undefined;
  outcome: "paused" | "continued" | "failed" | "fulfilled" | "blocked_by_extension";
  /** The proxy's answer to the request's CONNECT, when it was continued. */
  proxyStatus?: number;
  failReason?: string;
}

/** A tab or frame of the model: where it is, and whether its document came. */
interface ModelTarget {
  targetId: string;
  sessionId: string;
  url: string;
  context: string | null;
  loaded: boolean;
}

/** What Chrome shows of the page's environment (the model's process). */
export interface ModelEnv {
  timeZone: string;
  languages: string[];
  screen: { width: number; height: number };
}

/** A browser behind FakeChrome, scripted enough for the operator's start:
 *  targets and auto-attach, the work tab, isolated worlds, the self-test's
 *  fetch() — paused in Fetch, or cancelled by a rules extension — and what a
 *  continued request does: a CONNECT to the operator's proxy. And the page's
 *  environment: the time zone and languages Chrome's start took from the
 *  operator's hand-over (`chromeStarts`), geolocation grants and overrides,
 *  throwaway browser contexts, a page whose document the operator answers. */
export class BrowserModel {
  readonly chrome: FakeChrome;
  readonly requests: ModelRequest[] = [];
  extensionInstalled = false;
  /** The operator's proxy port (where a continued request goes). */
  proxyPort = 0;
  /** Called on Browser.close, before Chrome goes. */
  onBrowserClose: () => void = () => undefined;
  /** What this Chrome shows: set by its start from the hand-over. */
  env: ModelEnv = { timeZone: "UTC", languages: ["en-US", "en"], screen: { width: 1920, height: 1080 } };
  /** Chrome's own names of zones (its ICU's canonical names). */
  readonly aliases = new Map<string, string>([["Europe/Kyiv", "Europe/Kiev"]]);
  /** A test's way to make Chrome show something else. */
  shows: Partial<ModelEnv> & { position?: { latitude: number; longitude: number; accuracy: number } } = {};
  /** The hand-overs Chrome's starts read (null: none there). */
  readonly handovers: Array<string | null> = [];
  readonly grants: Array<{ origin: string; context: string | null; permissions: string[] }> = [];
  readonly overrides = new Map<string, { latitude: number; longitude: number; accuracy: number }>();
  readonly disposed: string[] = [];
  readonly #tabs = new Map<string, ModelTarget>();
  #targets = 0;
  #contexts = 0;
  #browserContexts = 0;
  #requests = 0;

  constructor(chrome: FakeChrome) {
    this.chrome = chrome;
    chrome.handlers.set("Target.setAutoAttach", (command) => {
      if (command.sessionId === undefined) {
        // The tab Chrome started with: already running, not waiting.
        setTimeout(() => chrome.event("Target.attachedToTarget", { sessionId: "S-initial", targetInfo: { targetId: "T-initial", type: "page", url: "about:blank" }, waitingForDebugger: false }), 0);
      }
      return {};
    });
    chrome.handlers.set("Target.createTarget", (command) => {
      const n = ++this.#targets;
      const url = String(command.params.url ?? "about:blank");
      const context = typeof command.params.browserContextId === "string" ? command.params.browserContextId : null;
      this.#tabs.set(`S${n}`, { targetId: `T${n}`, sessionId: `S${n}`, url, context, loaded: url === "about:blank" });
      setTimeout(() => chrome.event("Target.attachedToTarget", { sessionId: `S${n}`, targetInfo: { targetId: `T${n}`, type: "page", url }, waitingForDebugger: true }), 5);
      return { targetId: `T${n}` };
    });
    chrome.handlers.set("Target.closeTarget", (command) => {
      const targetId = String(command.params.targetId);
      setTimeout(() => chrome.event("Target.detachedFromTarget", { sessionId: targetId === "T-initial" ? "S-initial" : `S${targetId.slice(1)}` }), 0);
      return { success: true };
    });
    chrome.handlers.set("Target.createBrowserContext", () => ({ browserContextId: `C${++this.#browserContexts}` }));
    chrome.handlers.set("Target.disposeBrowserContext", (command) => {
      const context = String(command.params.browserContextId);
      this.disposed.push(context);
      for (const tab of [...this.#tabs.values()].filter((entry) => entry.context === context)) {
        this.#tabs.delete(tab.sessionId);
        setTimeout(() => chrome.event("Target.detachedFromTarget", { sessionId: tab.sessionId, targetId: tab.targetId }), 0);
      }
      return {};
    });
    chrome.handlers.set("Browser.grantPermissions", (command) => {
      this.grants.push({ origin: String(command.params.origin), context: typeof command.params.browserContextId === "string" ? command.params.browserContextId : null, permissions: command.params.permissions as string[] });
      return {};
    });
    chrome.handlers.set("Emulation.setGeolocationOverride", (command) => {
      const { latitude, longitude, accuracy } = command.params as { latitude: number; longitude: number; accuracy: number };
      this.overrides.set(String(command.sessionId), { latitude, longitude, accuracy });
      return {};
    });
    // A tab let run loads its document: through the interception.
    chrome.handlers.set("Runtime.runIfWaitingForDebugger", (command) => {
      const tab = command.sessionId === undefined ? undefined : this.#tabs.get(command.sessionId);
      if (tab && !tab.loaded && /^https?:/.test(tab.url)) setTimeout(() => this.#navigate(tab), 0);
      return {};
    });
    chrome.handlers.set("Browser.getVersion", () => ({ product: "Chrome/155.0.8059.39", protocolVersion: "1.3" }));
    chrome.handlers.set("Page.getFrameTree", (command) => ({ frameTree: { frame: { id: `F-${command.sessionId ?? ""}` } } }));
    chrome.handlers.set("Page.createIsolatedWorld", () => ({ executionContextId: ++this.#contexts }));
    chrome.handlers.set("Runtime.evaluate", (command) => ({ result: { type: "object", value: this.#evaluate(String(command.params.expression ?? ""), command.sessionId) } }));
    chrome.handlers.set("Runtime.callFunctionOn", (command) => {
      const args = command.params.arguments as Array<{ value: string }>;
      const [url, method] = [args[0]!.value, args[1]!.value];
      this.#fetch(url, method, command.sessionId);
      return { result: { type: "boolean", value: true } };
    });
    chrome.handlers.set("Fetch.continueRequest", (command) => {
      const request = this.#byInterception(String(command.params.requestId));
      if (request) void this.#continue(request);
      return {};
    });
    chrome.handlers.set("Fetch.fulfillRequest", (command) => {
      const request = this.#byInterception(String(command.params.requestId));
      if (!request) return { error: { code: -32602, message: "Invalid InterceptionId." } };
      request.outcome = "fulfilled";
      const tab = request.sessionId === undefined ? undefined : this.#tabs.get(request.sessionId);
      if (tab && `${request.url}${request.fragment}` === tab.url) tab.loaded = true;
      return {};
    });
    chrome.handlers.set("Fetch.failRequest", (command) => {
      const request = this.#byInterception(String(command.params.requestId));
      if (!request) return { error: { code: -32602, message: "Invalid InterceptionId." } };
      request.outcome = "failed";
      request.failReason = String(command.params.errorReason);
      setTimeout(() => chrome.event("Network.loadingFailed", { requestId: request.networkId, errorText: request.failReason === "BlockedByClient" ? "net::ERR_BLOCKED_BY_CLIENT" : "net::ERR_FAILED" }, request.sessionId), 0);
      return {};
    });
    chrome.handlers.set("Browser.close", () => {
      this.onBrowserClose();
      setTimeout(() => void chrome.shutdown(), 10);
      return {};
    });
  }

  /** Chrome starts, as its run script starts it: with the time zone and
   *  languages of the hand-over at `path`, if there is one. */
  chromeStarts(path: string): void {
    this.#tabs.clear();
    this.overrides.clear();
    let text: string | null;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = null;
    }
    this.handovers.push(text);
    const timeZone = /^TZ=(.*)$/m.exec(text ?? "")?.[1] ?? "UTC";
    const languages = (/^LANGUAGES=(.*)$/m.exec(text ?? "")?.[1] ?? "en-US").split(",");
    this.env = { timeZone, languages, screen: { width: 1920, height: 1080 } };
  }

  /** A request of the page itself pauses in Fetch (the site, a worker...). */
  pause(url: string, method = "GET", sessionId = "S1", resourceType = "Fetch"): ModelRequest {
    const n = ++this.#requests;
    const [bare, fragment = ""] = url.split("#");
    const request: ModelRequest = { interceptionId: `I${n}`, networkId: `R${n}`, url: bare!, fragment: fragment ? `#${fragment}` : "", method, sessionId, outcome: "paused" };
    this.requests.push(request);
    this.chrome.event("Network.requestWillBeSent", { requestId: request.networkId, request: { url: request.url, method } }, sessionId);
    this.chrome.event("Fetch.requestPaused", {
      requestId: request.interceptionId,
      networkId: request.networkId,
      request: { url: request.url, urlFragment: request.fragment, method, headers: {} },
      resourceType,
      frameId: `F-${sessionId}`,
    });
    return request;
  }

  #navigate(tab: ModelTarget): void {
    this.pause(tab.url, "GET", tab.sessionId, "Document");
  }

  /** What the page's script reads, by the operator's expression. */
  #evaluate(expression: string, sessionId: string | undefined): unknown {
    const tab = sessionId === undefined ? undefined : this.#tabs.get(sessionId);
    if (expression.includes("pbEnvShown")) {
      const zone = JSON.parse(/\}\)\((".*")\)$/.exec(expression)?.[1] ?? '""') as string;
      const env = { ...this.env, ...this.shows };
      const known = /^[A-Z][A-Za-z_]+(\/[A-Z][A-Za-z_]+)*$/.test(zone);
      return {
        timeZone: this.aliases.get(env.timeZone) ?? env.timeZone,
        settingsTimeZone: known ? (this.aliases.get(zone) ?? zone) : null,
        languages: env.languages,
        language: env.languages[0],
        screen: env.screen,
      };
    }
    if (expression.includes("pbEnvReady")) {
      const url = JSON.parse(/\}\)\((".*")\)$/.exec(expression)?.[1] ?? '""') as string;
      return tab !== undefined && tab.loaded && tab.url === url;
    }
    if (expression.includes("pbEnvPosition")) {
      if (!tab || !/^(https:|http:\/\/127\.0\.0\.1)/.test(tab.url)) return { error: "1 Only secure origins are allowed (see: https://goo.gl/Y0ZkNV)." };
      const origin = new URL(tab.url).origin;
      if (!this.grants.some((grant) => grant.origin === origin && grant.context === tab.context && grant.permissions.includes("geolocation"))) return { error: "1 User denied Geolocation" };
      return this.shows.position ?? this.overrides.get(tab.sessionId) ?? { error: "2 Position update is unavailable" };
    }
    return 1;
  }

  #byInterception(id: string): ModelRequest | undefined {
    return this.requests.find((request) => request.interceptionId === id && request.outcome === "paused");
  }

  #fetch(url: string, method: string, sessionId: string | undefined): void {
    const path = new URL(url).pathname;
    if (this.extensionInstalled && method !== "GET" && (path === "/api/v1/message/ack" || path.startsWith("/api/v1/pb-selftest-unknown"))) {
      const n = ++this.#requests;
      const request: ModelRequest = { interceptionId: `I${n}`, networkId: `R${n}`, url: url.split("#")[0]!, fragment: "", method, sessionId, outcome: "blocked_by_extension" };
      this.requests.push(request);
      this.chrome.event("Network.requestWillBeSent", { requestId: request.networkId, request: { url: request.url, method } }, sessionId);
      this.chrome.event("Network.loadingFailed", { requestId: request.networkId, errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: "other" }, sessionId);
      return;
    }
    this.pause(url, method, sessionId ?? "S1");
  }

  async #continue(request: ModelRequest): Promise<void> {
    request.outcome = "continued";
    const { status, socket } = await proxyConnect(this.proxyPort, `${new URL(request.url).hostname}:443`);
    socket.destroy();
    request.proxyStatus = status;
    if (status === 200) this.chrome.event("Network.loadingFinished", { requestId: request.networkId, encodedDataLength: 0 }, request.sessionId);
    else this.chrome.event("Network.loadingFailed", { requestId: request.networkId, errorText: "net::ERR_TUNNEL_CONNECTION_FAILED" }, request.sessionId);
  }
}
