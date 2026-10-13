import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server as HttpServer } from "node:http";
import { connect as tcpConnect, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import type { EventBody } from "../../apps/page-browser/src/buffer/buffer.ts";
import { CdpError, CdpUnanswered, type CdpEvent, type CdpPort, type EventHandler } from "../../apps/page-browser/src/cdp/client.ts";
import type { ApiGate } from "../../apps/page-browser/src/egress/gate.ts";
import { clientFrameBytes } from "../../apps/page-browser/src/egress/socket-gate.ts";
import { unzip, verifyCrx3 } from "../../apps/page-browser/src/extension/crx.ts";
import { buildPackage, EXTENSION_ORIGIN, PACKAGE_FILES, UPDATE_PATH } from "../../apps/page-browser/src/extension/package.ts";
import { ISSUE, RELEASE } from "../../apps/page-browser/src/hub-requests/page.ts";
import { Holder } from "../../apps/page-browser/src/holder/holder.ts";
import type { ChromeControl } from "../../apps/page-browser/src/operator/chrome.ts";
import type { Result } from "../../apps/page-browser/src/rpc/protocol.ts";
import { buildRules, type DnrRule } from "../../apps/page-browser/src/policy/rules.ts";
import { monoMs } from "../../apps/page-browser/src/shared/util.ts";
import { acceptWebSocket, clientHandshake, type WsConnection } from "../../apps/page-browser/src/shared/ws.ts";
import { dnrBlocks } from "./page-browser-dnr.ts";

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
  /** Binary frames (bodies' parts), in order. */
  readonly frames: Buffer[] = [];
  /** Every message's type in order, "binary" for a frame. */
  readonly order: string[] = [];
  ws: WebSocket | null = null;
  closed: { code: number } | null = null;
  answerPings = true;
  /** Every JSON message as it comes (an engine that answers checks). */
  onMessage: (message: Record<string, unknown>) => void = () => undefined;

  connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this.closed = null;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the RPC connection failed"));
      ws.onclose = (event) => (this.closed = { code: event.code });
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.frames.push(Buffer.from(event.data));
          this.order.push("binary");
          return;
        }
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        this.messages.push(message);
        this.order.push(String(message.type));
        if (message.type === "ping" && this.answerPings) this.send({ type: "pong", n: message.n, ownerGeneration: this.generation });
        this.onMessage(message);
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

let extensionKey: KeyObject | null = null;

/** The rules extension's package as the image's build leaves it
 *  (apps/page-browser/extension/build.ts), in `dir`: what the operator
 *  serves to Chrome's policy. Returns its ID. */
export function writeExtensionPackage(dir: string): string {
  extensionKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const template = JSON.parse(readFileSync(new URL("../../apps/page-browser/extension/manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const built = buildPackage({ template, rules: buildRules(), key: extensionKey });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PACKAGE_FILES.crx), built.crx);
  writeFileSync(join(dir, PACKAGE_FILES.update), built.updateXml);
  writeFileSync(join(dir, PACKAGE_FILES.id), `${built.id}\n`);
  writeFileSync(join(dir, PACKAGE_FILES.rules), built.rules);
  return built.id;
}

/** A plain GET to the operator's proxy port, as Chrome makes it to loopback. */
function plainGet(port: number, path: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** What Chrome shows of the page's environment (the model's process). */
export interface ModelEnv {
  timeZone: string;
  languages: string[];
  screen: { width: number; height: number };
}

/** A browser behind FakeChrome, scripted enough for the operator's start:
 *  targets and auto-attach, the work tab, isolated worlds, the self-test's
 *  fetch() — paused in Fetch, or cancelled by the rules extension — and what
 *  a continued request does: a CONNECT to the operator's proxy. The rules
 *  extension as Chrome's policy installs it at a start: the update manifest
 *  and the package from the operator's port, verified, its rules.json
 *  applied by the model of DNR (page-browser-dnr.ts). And the page's
 *  environment: the time zone and languages Chrome's start took from the
 *  operator's hand-over (`chromeStarts`), geolocation grants and overrides,
 *  throwaway browser contexts, a page whose document the operator answers. */
export class BrowserModel {
  readonly chrome: FakeChrome;
  readonly requests: ModelRequest[] = [];
  /** The installed extension's rules (the profile keeps them over Chrome's
   *  restarts); null — none installed. */
  rules: DnrRule[] | null = null;
  /** Chrome's policy force-installs the extension at every start. */
  policyInstalls = true;
  /** What each start's install came to: the ID installed, or why not. */
  readonly installs: Array<{ id: string; rules: number } | { failed: string }> = [];
  /** The operator's proxy port (where a continued request goes, and where
   *  the policy's update URL points). */
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
      if (command.params.functionDeclaration === RELEASE) return { result: { type: "boolean", value: true } };
      if (command.params.functionDeclaration === ISSUE) {
        const [attemptId, url, , headers] = (command.params.arguments as Array<{ value: unknown }>).map((arg) => arg.value) as [number, string, string, Array<[string, string]>];
        setTimeout(() => this.#hubStart(attemptId, url, headers, command.sessionId), 0);
        return { result: { type: "boolean", value: true } };
      }
      const args = command.params.arguments as Array<{ value: string }>;
      const [url, method] = [args[0]!.value, args[1]!.value];
      this.#fetch(url, method, command.sessionId);
      return { result: { type: "boolean", value: true } };
    });
    chrome.handlers.set("Fetch.continueRequest", (command) => {
      const hub = this.hubRequests.find((request) => request.interceptionId === command.params.requestId && request.outcome === "paused");
      if (hub) {
        hub.outcome = "continued";
        hub.url = String(command.params.url ?? hub.url);
        void this.#hubContinue(hub);
        return {};
      }
      const request = this.#byInterception(String(command.params.requestId));
      if (request) void this.#continue(request);
      return {};
    });
    chrome.handlers.set("Network.streamResourceContent", (command) => {
      const hub = this.hubRequests.find((request) => request.networkId === command.params.requestId);
      if (hub) hub.streamed = true;
      return { bufferedData: "" };
    });
    chrome.handlers.set("Fetch.continueResponse", (command) => {
      const hub = this.hubRequests.find((request) => request.interceptionId === command.params.requestId);
      if (!hub) return { error: { code: -32602, message: "Invalid InterceptionId." } };
      setTimeout(() => this.#hubBodyGoes(hub), 0);
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
  get extensionInstalled(): boolean {
    return this.rules !== null;
  }

  /** A test's shortcut: the image's own rules installed, or none (and no
   *  policy to install them). */
  set extensionInstalled(installed: boolean) {
    this.rules = installed ? buildRules() : null;
    if (!installed) this.policyInstalls = false;
  }

  /** Chrome's policy at a start (ExtensionSettings, force_installed): the
   *  update manifest from the operator's port, the package it names — its
   *  bytes checked against the manifest's hash, its signature and ID as
   *  Chrome checks them — and its rules.json enabled. */
  async installByPolicy(): Promise<void> {
    try {
      const update = await plainGet(this.proxyPort, `${UPDATE_PATH}?os=linux&acceptformat=crx3&x=installedby%3Dpolicy%26uc`);
      if (update.status !== 200) throw new Error(`the update manifest: ${update.status}`);
      const xml = update.body.toString();
      const attribute = (name: string) => new RegExp(`${name}='([^']*)'`).exec(xml)?.[1] ?? "";
      const codebase = new URL(attribute("codebase"));
      if (codebase.origin !== EXTENSION_ORIGIN) throw new Error(`the package is not on the operator's port: ${codebase.origin}`);
      const crx = await plainGet(this.proxyPort, codebase.pathname);
      if (crx.status !== 200) throw new Error(`the package: ${crx.status}`);
      if (createHash("sha256").update(crx.body).digest("hex") !== attribute("hash_sha256")) throw new Error("the package is not the bytes the update manifest names");
      const read = verifyCrx3(crx.body);
      if (read.id !== attribute("appid")) throw new Error("the package's ID is not the update manifest's");
      const rules = JSON.parse(unzip(read.archive).find((file) => file.name === "rules.json")!.data.toString()) as DnrRule[];
      this.rules = rules;
      this.installs.push({ id: read.id, rules: rules.length });
    } catch (error) {
      this.installs.push({ failed: error instanceof Error ? error.message : String(error) });
    }
  }

  chromeStarts(path: string): void {
    this.#tabs.clear();
    this.overrides.clear();
    if (this.policyInstalls) void this.installByPolicy();
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
  pause(url: string, method = "GET", sessionId = "S1", resourceType = "Fetch", headers: Record<string, string> = {}): ModelRequest {
    const n = ++this.#requests;
    const [bare, fragment = ""] = url.split("#");
    const request: ModelRequest = { interceptionId: `I${n}`, networkId: `R${n}`, url: bare!, fragment: fragment ? `#${fragment}` : "", method, sessionId, outcome: "paused" };
    this.requests.push(request);
    this.chrome.event("Network.requestWillBeSent", { requestId: request.networkId, request: { url: request.url, urlFragment: request.fragment, method } }, sessionId);
    this.chrome.event("Fetch.requestPaused", {
      requestId: request.interceptionId,
      networkId: request.networkId,
      request: { url: request.url, urlFragment: request.fragment, method, headers },
      resourceType,
      frameId: `F-${sessionId}`,
    });
    return request;
  }

  /** The tab's main frame commits a document at `url` (no request: the
   *  site's own load is a later PR's; this only moves the tab there). */
  navigate(sessionId: string, url: string): void {
    this.chrome.event("Page.frameNavigated", { frame: { id: `F-${sessionId}`, url, loaderId: `L${++this.#requests}` } }, sessionId);
  }

  /** Hub's requests this browser ran: the body they get, and what
   *  happened to each. */
  hubBody: Buffer = Buffer.from('{"success":true,"response":{"id":"1"}}');
  readonly hubRequests: Array<ModelRequest & { attemptId: number; headers: Array<[string, string]>; socket: Socket | null; streamed: boolean }> = [];

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

  #hubStart(attemptId: number, issued: string, headers: Array<[string, string]>, sessionId: string | undefined): void {
    const n = ++this.#requests;
    const [bare, fragment = ""] = issued.split("#");
    const request = { interceptionId: `I${n}`, networkId: `R${n}`, url: bare!, fragment: `#${fragment}`, method: "GET", sessionId, outcome: "paused" as const, attemptId, headers, socket: null, streamed: false };
    this.hubRequests.push(request);
    this.chrome.event("Network.requestWillBeSent", { requestId: request.networkId, request: { url: request.url, urlFragment: request.fragment, method: "GET" }, initiator: { type: "script" } }, sessionId);
    this.chrome.event("Fetch.requestPaused", {
      requestId: request.interceptionId,
      networkId: request.networkId,
      request: { url: request.url, urlFragment: request.fragment, method: "GET", headers: Object.fromEntries(headers) },
      resourceType: "XHR",
      frameId: `F-${sessionId ?? ""}`,
    });
  }

  /** Released: a tunnel through the operator's proxy to the API host, a TLS
   *  1.3 connection's records (its Finished, the HTTP/2 preface) and the
   *  request's HEADERS — what the gate decides on — then its answer stops
   *  at its headers. */
  async #hubContinue(request: (typeof this.hubRequests)[number]): Promise<void> {
    const { status, socket } = await proxyConnect(this.proxyPort, `${new URL(request.url).hostname}:443`);
    request.proxyStatus = status;
    if (status !== 200) {
      socket.destroy();
      this.chrome.event("Network.loadingFailed", { requestId: request.networkId, errorText: "net::ERR_TUNNEL_CONNECTION_FAILED" }, request.sessionId);
      return;
    }
    request.socket = socket;
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => {
      socket.once("data", () => resolve());
      socket.resume();
    });
    const record = (type: number, size: number) => Buffer.concat([Buffer.from([type, 0x03, 0x03, (size - 5) >> 8, (size - 5) & 0xff]), Buffer.alloc(size - 5, 0xab)]);
    socket.write(Buffer.concat([record(22, 300), record(23, 58), record(23, 70), record(23, 90)]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.chrome.event("Network.requestWillBeSentExtraInfo", { requestId: request.networkId, headers: Object.fromEntries(request.headers.map(([name, value]) => [name.toLowerCase(), value])) }, request.sessionId);
    this.chrome.event("Fetch.requestPaused", {
      requestId: request.interceptionId,
      networkId: request.networkId,
      request: { url: request.url, method: "GET", headers: {} },
      resourceType: "XHR",
      responseStatusCode: 200,
      responseStatusText: "OK",
      responseHeaders: [
        { name: "content-type", value: "application/json" },
        { name: "content-length", value: String(this.hubBody.length) },
        { name: "set-cookie", value: "sid=model-cookie-secret" },
      ],
    });
  }

  #hubBodyGoes(request: (typeof this.hubRequests)[number]): void {
    const session = request.sessionId;
    this.chrome.event("Network.responseReceived", { requestId: request.networkId, response: { status: 200, timing: { requestTime: 777.125, sendStart: 1.5 }, connectionReused: false } }, session);
    this.chrome.event("Network.responseReceivedExtraInfo", { requestId: request.networkId, statusCode: 200 }, session);
    this.chrome.event("Network.dataReceived", { requestId: request.networkId, dataLength: this.hubBody.length, encodedDataLength: this.hubBody.length, ...(request.streamed ? { data: this.hubBody.toString("base64") } : {}) }, session);
    this.chrome.event("Network.loadingFinished", { requestId: request.networkId, encodedDataLength: this.hubBody.length + 100 }, session);
    request.outcome = "fulfilled";
  }

  #byInterception(id: string): ModelRequest | undefined {
    return this.requests.find((request) => request.interceptionId === id && request.outcome === "paused");
  }

  #fetch(url: string, method: string, sessionId: string | undefined): void {
    if (this.rules !== null && dnrBlocks(this.rules, { method, url })) {
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

// ── Hub requests (PR 9) ────────────────────────────────────────────────────

/** An in-process Chrome behind the CdpPort the request paths take: commands
 *  answered by handlers (`{}` by default; `{ error }` rejects as Chrome's
 *  error, UNANSWERED as no answer), events emitted in order. */
export const UNANSWERED = Symbol("unanswered");

export class FakeCdpPort implements CdpPort {
  readonly commands: CdpCommand[] = [];
  readonly handlers = new Map<string, (command: CdpCommand) => unknown>();
  readonly acks: number[] = [];
  readonly #listeners = new Map<string, EventHandler[]>();
  #seq = 0;
  #id = 0;

  async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const command: CdpCommand = { id: ++this.#id, method, params };
    if (sessionId !== undefined) command.sessionId = sessionId;
    this.commands.push(command);
    const handler = this.handlers.get(method);
    const reply = handler ? await handler(command) : {};
    if (reply === UNANSWERED) throw new CdpUnanswered(method, "no answer (test)");
    if (reply !== null && typeof reply === "object" && "error" in reply) {
      const error = (reply as { error: { code: number; message: string } }).error;
      throw new CdpError(method, error.code, error.message);
    }
    return (reply ?? {}) as T;
  }

  on(method: string, handler: EventHandler): void {
    this.#listeners.set(method, [...(this.#listeners.get(method) ?? []), handler]);
  }

  ack(seq: number): void {
    this.acks.push(seq);
  }

  /** Methods a path took the acknowledgement of over. */
  readonly heldAcks = new Set<string>();

  holdAcks(method: string): void {
    this.heldAcks.add(method);
  }

  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    const event: CdpEvent = { method, params, seq: ++this.#seq, replayed: false };
    if (sessionId !== undefined) event.sessionId = sessionId;
    for (const handler of this.#listeners.get(method) ?? []) handler(event);
  }

  sent(method: string): CdpCommand[] {
    return this.commands.filter((command) => command.method === method);
  }
}

/** What one Hub request does in HubChrome. */
export interface HubScript {
  /** A CORS preflight first, answered with this status. */
  preflight?: number;
  status?: number;
  headers?: Array<{ name: string; value: string }>;
  /** The body in chunks; its content-length is declared unless `chunked`. */
  chunks?: Buffer[];
  chunked?: boolean;
  contentLength?: number;
  /** Chrome's moment of the send (null: no timing). */
  timing?: { requestTime: number; sendStart: number } | null;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  /** The status the server really sent (304 of a revalidated cache entry). */
  wireStatus?: number;
  connectionReused?: boolean;
  noResponseReceived?: boolean;
  /** The request opens a new connection (one per window). */
  newTunnel?: boolean;
  /** After its release, this long before its records are written. */
  sendDelayMs?: number;
  /** What happens after the release. */
  then?: "answer" | "hang_before_send" | "hang_after_send" | "fail_before_send" | "fail_after_send" | "cancel_after_send" | "body_fails" | "retry" | "never_pauses";
  /** A chunk whose data is shorter than its dataLength. */
  brokenChunk?: boolean;
  /** Chunks without their data (the stream not armed). */
  unstreamed?: boolean;
  chunkDelayMs?: number;
  /** Network.streamResourceContent answers this late. */
  armDelayMs?: number;
}

export interface HubWireRequest {
  attemptId: number;
  role: "preflight" | "main";
  method: string;
  url: string;
}

interface HubModelRequest {
  attemptId: number;
  role: "preflight" | "main";
  interceptionId: string;
  networkId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  cls: "api" | "cdn";
  stage: "request" | "response";
  continued: boolean;
  interceptResponse: boolean;
  ended: boolean;
  tunnel: number | null;
  sendCount: number;
}

/** A browser that runs Hub requests as Chrome would show them over CDP: the
 *  isolated world's start (Runtime.callFunctionOn), Fetch pauses at both
 *  stages, the Network events, the body's stream — and the proxy's view of
 *  the API's tunnels through the real gate: `wire` is what physically left
 *  (what the gate let up, and every CDN request released). */
export class HubChrome {
  readonly cdp: FakeCdpPort;
  readonly gate: ApiGate;
  readonly scripts = new Map<number, HubScript>();
  defaultScript: HubScript = {};
  readonly issued: Array<{ attemptId: number; url: string; kind: string; headers: Array<[string, string]> }> = [];
  readonly wire: HubWireRequest[] = [];
  readonly releasedInPage: number[] = [];
  readonly armed = new Set<string>();
  readonly session = "S1";
  readonly #requests: HubModelRequest[] = [];
  #n = 0;
  #tunnels = 100;

  constructor(cdp: FakeCdpPort, gate: ApiGate) {
    this.cdp = cdp;
    this.gate = gate;
    cdp.handlers.set("Runtime.callFunctionOn", (command) => this.#call(command));
    cdp.handlers.set("Fetch.continueRequest", (command) => this.#continue(command));
    cdp.handlers.set("Fetch.continueResponse", (command) => this.#continueResponse(command));
    cdp.handlers.set("Fetch.fulfillRequest", (command) => this.#fulfill(command));
    cdp.handlers.set("Fetch.failRequest", (command) => this.#failCommand(command));
    cdp.handlers.set("Network.streamResourceContent", async (command) => {
      const request = this.#requests.find((entry) => entry.networkId === command.params.requestId);
      const script = request ? this.#script(request.attemptId) : {};
      if (script.armDelayMs) await new Promise((resolve) => setTimeout(resolve, script.armDelayMs));
      this.armed.add(String(command.params.requestId));
      return { bufferedData: "" };
    });
  }

  /** The tab's main frame goes to `url` (a new document). */
  navigate(url: string): void {
    this.cdp.emit("Page.frameNavigated", { frame: { id: "F1", url, loaderId: `L${++this.#n}` } }, this.session);
  }

  /** The site's own API request, paused in Fetch with its headers. */
  siteRequest(path: string, headers: Record<string, string>, method = "GET"): { interceptionId: string; networkId: string } {
    const n = ++this.#n;
    const url = `https://apiv3.fansly.com${path}`;
    this.cdp.emit("Network.requestWillBeSent", { requestId: `site-${n}`, request: { url, method }, initiator: { type: "script" } }, this.session);
    this.cdp.emit("Fetch.requestPaused", { requestId: `I-site-${n}`, networkId: `site-${n}`, request: { url, method, headers }, resourceType: "XHR", frameId: "F1" });
    return { interceptionId: `I-site-${n}`, networkId: `site-${n}` };
  }

  /** What Chrome announced a site request went with (its header names). */
  siteSent(networkId: string, names: string[]): void {
    this.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: networkId, headers: Object.fromEntries(names.map((name) => [name, "v"])) }, this.session);
  }

  /** The tunnels of a class are cut: what is in flight there fails. */
  cut(cls: "api" | "cdn"): number {
    let cut = 0;
    for (const request of this.#requests) {
      if (request.cls !== cls || !request.continued || request.ended) continue;
      cut += 1;
      this.#end(request, "net::ERR_CONNECTION_CLOSED", false);
    }
    return cut;
  }

  requestsOf(attemptId: number): HubModelRequest[] {
    return this.#requests.filter((request) => request.attemptId === attemptId);
  }

  #script(attemptId: number): HubScript {
    return this.scripts.get(attemptId) ?? this.defaultScript;
  }

  #call(command: CdpCommand): unknown {
    const declaration = String(command.params.functionDeclaration ?? "");
    const args = (command.params.arguments as Array<{ value: unknown }>).map((arg) => arg.value);
    if (declaration === RELEASE) {
      this.releasedInPage.push(Number(args[0]));
      return { result: { type: "boolean", value: true } };
    }
    const [attemptId, url, kind, headers] = args as [number, string, string, Array<[string, string]>];
    this.issued.push({ attemptId, url, kind, headers });
    const script = this.#script(attemptId);
    if (script.then === "never_pauses") return { result: { type: "boolean", value: true } };
    setImmediate(() => this.#start(attemptId, url, kind, headers));
    return { result: { type: "boolean", value: true } };
  }

  #start(attemptId: number, issued: string, kind: string, headers: Array<[string, string]>): void {
    const n = ++this.#n;
    const [bare, fragment = ""] = issued.split("#");
    const cls = kind === "api" ? "api" : "cdn";
    const main: HubModelRequest = { attemptId, role: "main", interceptionId: `I-${n}`, networkId: `R-${n}`, url: bare!, method: "GET", headers: Object.fromEntries(headers), cls, stage: "request", continued: false, interceptResponse: false, ended: false, tunnel: null, sendCount: 0 };
    this.#requests.push(main);
    this.cdp.emit("Network.requestWillBeSent", { requestId: main.networkId, request: { url: main.url, urlFragment: `#${fragment}`, method: "GET" }, initiator: { type: "script" } }, this.session);
    const script = this.#script(attemptId);
    if (script.preflight !== undefined) {
      const preflight: HubModelRequest = { ...main, role: "preflight", interceptionId: `I-${n}p`, networkId: `P-${n}`, method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } };
      this.#requests.push(preflight);
      this.cdp.emit("Network.requestWillBeSent", { requestId: preflight.networkId, request: { url: main.url, urlFragment: `#${fragment}`, method: "OPTIONS" }, initiator: { type: "preflight", requestId: main.networkId } }, this.session);
      this.#pause(preflight, fragment);
      return;
    }
    this.#pause(main, fragment);
  }

  #pause(request: HubModelRequest, fragment: string): void {
    this.cdp.emit("Fetch.requestPaused", {
      requestId: request.interceptionId,
      networkId: request.networkId,
      request: { url: request.url, urlFragment: `#${fragment}`, method: request.method, headers: request.headers },
      resourceType: request.cls === "api" ? "XHR" : "Image",
      frameId: "F1",
    });
  }

  #byInterception(id: unknown): HubModelRequest | undefined {
    return this.#requests.find((request) => request.interceptionId === id && !request.ended);
  }

  #continue(command: CdpCommand): unknown {
    const request = this.#byInterception(command.params.requestId);
    if (!request || request.stage !== "request") return { error: { code: -32602, message: "Invalid InterceptionId." } };
    request.continued = true;
    request.interceptResponse = command.params.interceptResponse === true;
    if (typeof command.params.url === "string") request.url = command.params.url;
    setTimeout(() => this.#afterRelease(request), this.#script(request.attemptId).sendDelayMs ?? 0);
    return {};
  }

  /** The request's records through the gate (API) — "up", "held", or
   *  "refused" (no new tunnel in this window). */
  #write(request: HubModelRequest, script: HubScript): "up" | "held" | "refused" {
    if (request.cls === "cdn") {
      request.sendCount += 1;
      this.wire.push({ attemptId: request.attemptId, role: request.role, method: request.method, url: request.url });
      return "up";
    }
    let tunnel = request.tunnel ?? 1;
    if (script.newTunnel && request.tunnel === null) {
      if (!this.gate.admitsTunnel()) return "refused";
      tunnel = ++this.#tunnels;
      this.gate.noteTunnel(tunnel);
      this.gate.record(tunnel, true, false, true); // ClientHello
      for (let i = 0; i < 2; i++) {
        if (this.gate.record(tunnel, true, true, true) !== "up") return "held"; // Finished, preface
        this.gate.recordDone(tunnel);
      }
    }
    request.tunnel = tunnel;
    const verdict = this.gate.record(tunnel, true, true, true); // HEADERS
    if (verdict !== "up") {
      this.gate.noteHeld(tunnel, 90);
      return "held";
    }
    this.gate.recordDone(tunnel);
    request.sendCount += 1;
    this.wire.push({ attemptId: request.attemptId, role: request.role, method: request.method, url: request.url });
    return "up";
  }

  #afterRelease(request: HubModelRequest): void {
    if (request.ended) return;
    const script = this.#script(request.attemptId);
    const then = script.then ?? "answer";
    if (then === "fail_before_send") return this.#end(request, "net::ERR_TUNNEL_CONNECTION_FAILED", false);
    if (then === "hang_before_send") return;
    const went = this.#write(request, script);
    if (went === "refused") return this.#end(request, "net::ERR_TUNNEL_CONNECTION_FAILED", false);
    if (went === "held") return;
    this.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: request.networkId, headers: { ...Object.fromEntries(Object.keys(request.headers).map((name) => [name.toLowerCase(), "v"])), "user-agent": "v" } }, this.session);
    if (then === "retry" && request.role === "main") {
      // The server refuses the stream; Chrome repeats on the same connection.
      this.gate.noteServerBytes(request.tunnel ?? 1);
      if (this.#write(request, script) === "held") return;
      return;
    }
    if (then === "hang_after_send") return;
    if (then === "fail_after_send") return this.#end(request, "net::ERR_CONNECTION_RESET", false);
    if (then === "cancel_after_send") return this.#end(request, "net::ERR_ABORTED", true);
    request.stage = "response";
    if (request.role === "preflight") {
      this.cdp.emit("Fetch.requestPaused", {
        requestId: request.interceptionId,
        networkId: request.networkId,
        request: { url: request.url, method: "OPTIONS", headers: request.headers },
        resourceType: "Preflight",
        responseStatusCode: script.preflight ?? 204,
        responseStatusText: "No Content",
        responseHeaders: [{ name: "access-control-allow-origin", value: "https://fansly.com" }, { name: "access-control-allow-headers", value: "authorization" }],
      });
      return;
    }
    const body = Buffer.concat(script.chunks ?? [Buffer.from('{"success":true}')]);
    const headers = [...(script.headers ?? [{ name: "content-type", value: "application/json" }])];
    if (!script.chunked) headers.push({ name: "content-length", value: String(script.contentLength ?? body.length) });
    this.cdp.emit("Fetch.requestPaused", {
      requestId: request.interceptionId,
      networkId: request.networkId,
      request: { url: request.url, method: "GET", headers: request.headers },
      resourceType: request.cls === "api" ? "XHR" : "Image",
      responseStatusCode: script.status ?? 200,
      responseStatusText: "OK",
      responseHeaders: headers,
    });
  }

  #fulfill(command: CdpCommand): unknown {
    const request = this.#byInterception(command.params.requestId);
    if (!request) return { error: { code: -32602, message: "Invalid InterceptionId." } };
    const script = this.#script(request.attemptId);
    request.ended = true;
    this.#responseReceived(request, script, Number(command.params.responseCode));
    setImmediate(() => {
      this.cdp.emit("Network.loadingFinished", { requestId: request.networkId, encodedDataLength: 120 }, this.session);
      if (request.role !== "preflight") return;
      const main = this.#requests.find((entry) => entry.attemptId === request.attemptId && entry.role === "main")!;
      const status = Number(command.params.responseCode);
      if (status >= 200 && status < 300) this.#pause(main, `hub-${request.attemptId}`);
      else this.#end(main, "net::ERR_FAILED", false);
    });
    return {};
  }

  #responseReceived(request: HubModelRequest, script: HubScript, status: number): void {
    if (script.noResponseReceived && request.role === "main") return;
    const timing = script.timing === undefined ? { requestTime: 1000 + this.#n, sendStart: request.role === "preflight" ? 1.5 : 2.5 } : script.timing;
    this.cdp.emit(
      "Network.responseReceived",
      {
        requestId: request.networkId,
        response: {
          status,
          ...(timing ? { timing: { requestTime: timing.requestTime, sendStart: timing.sendStart } } : {}),
          fromDiskCache: script.fromDiskCache === true,
          fromServiceWorker: script.fromServiceWorker === true,
          connectionReused: script.connectionReused !== false,
        },
      },
      this.session,
    );
    if (request.role === "main") this.cdp.emit("Network.responseReceivedExtraInfo", { requestId: request.networkId, statusCode: script.wireStatus ?? status }, this.session);
  }

  #continueResponse(command: CdpCommand): unknown {
    const request = this.#byInterception(command.params.requestId);
    if (!request || request.stage !== "response") return { error: { code: -32602, message: "Invalid InterceptionId." } };
    const script = this.#script(request.attemptId);
    this.#responseReceived(request, script, script.status ?? 200);
    void this.#body(request, script);
    return {};
  }

  async #body(request: HubModelRequest, script: HubScript): Promise<void> {
    const chunks = script.chunks ?? [Buffer.from('{"success":true}')];
    let total = 0;
    for (const [index, chunk] of chunks.entries()) {
      if (script.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, script.chunkDelayMs));
      else await new Promise((resolve) => setImmediate(resolve));
      if (request.ended) return;
      total += chunk.length;
      const streamed = this.armed.has(request.networkId) && !script.unstreamed;
      const data = script.brokenChunk && index === 0 ? chunk.subarray(0, Math.max(0, chunk.length - 1)) : chunk;
      this.cdp.emit("Network.dataReceived", { requestId: request.networkId, dataLength: chunk.length, encodedDataLength: chunk.length, ...(streamed ? { data: data.toString("base64") } : {}) }, this.session);
    }
    await new Promise((resolve) => setImmediate(resolve));
    if (request.ended) return;
    if (script.then === "body_fails") return this.#end(request, "net::ERR_CONNECTION_CLOSED", false);
    request.ended = true;
    this.cdp.emit("Network.loadingFinished", { requestId: request.networkId, encodedDataLength: total + 200 }, this.session);
  }

  #failCommand(command: CdpCommand): unknown {
    const request = this.#byInterception(command.params.requestId);
    if (!request) return { error: { code: -32602, message: "Invalid InterceptionId." } };
    this.#end(request, command.params.errorReason === "Aborted" ? "net::ERR_ABORTED" : "net::ERR_FAILED", false);
    return {};
  }

  #end(request: HubModelRequest, errorText: string, canceled: boolean): void {
    if (request.ended) return;
    request.ended = true;
    setImmediate(() => this.cdp.emit("Network.loadingFailed", { requestId: request.networkId, errorText, canceled }, this.session));
  }
}

/** The engine's side for Hub requests: what the operator sends it (`check`,
 *  `sent`, a result it could not keep), and its answer to each check — an
 *  admission for 15 s by default, or whatever `answer` says (null: none). */
export class FakeHubEngine {
  readonly messages: Array<Record<string, unknown>> = [];
  generation = 1;
  up = true;
  answer: (check: Record<string, unknown>) => Record<string, unknown> | null = (check) => ({ type: "checkResult", ownerGeneration: this.generation, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
  /** Where answers go (HubRequests.onCheckResult). */
  deliver: (result: never) => void = () => undefined;

  link(): { up: () => boolean; generation: () => number; send: (message: object) => boolean } {
    return {
      up: () => this.up,
      generation: () => this.generation,
      send: (message) => {
        const record = message as Record<string, unknown>;
        this.messages.push(record);
        if (record.type === "check") {
          const answer = this.answer(record);
          if (answer !== null) setImmediate(() => this.deliver(answer as never));
        }
        return this.up;
      },
    };
  }

  of(type: string): Array<Record<string, unknown>> {
    return this.messages.filter((message) => message.type === type);
  }
}

/** A server that answers a TLS 1.3 ServerHello and keeps what it gets (what
 *  the gate let up a tunnel to the API). */
export async function tlsLikeServer(): Promise<{ port: number; received: () => Buffer; close: () => Promise<void> }> {
  const chunks: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => chunks.push(chunk));
    const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32, 7), Buffer.from([0]), Buffer.from([0x13, 0x01, 0x00, 0x00, 0x06, 0x00, 0x2b, 0x00, 0x02, 0x03, 0x04])]);
    const handshake = Buffer.concat([Buffer.from([0x02, 0, 0, body.length]), body]);
    socket.write(Buffer.concat([Buffer.from([0x16, 0x03, 0x03, 0, handshake.length]), handshake]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    received: () => Buffer.concat(chunks),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

// ── the site's socket (PR 10) ──────────────────────────────────────────────

/** A TLS record of `size` bytes in all, its body filled with `fill`. */
export function tlsRecord(type: number, size: number, fill: number): Buffer {
  return Buffer.concat([Buffer.from([type, 0x03, 0x03, (size - 5) >> 8, (size - 5) & 0xff]), Buffer.alloc(size - 5, fill)]);
}

/** What each of Chrome's records on a socket's tunnel is filled with: the
 *  server can tell what reached it. */
export const SOCKET_FILL = { clientHello: 0x11, finished: 0x22, request: 0x33, frame: 0x44, authorization: 0x66, ping: 0x77, forbidden: 0x99 } as const;

/** TLS 1.3 (AES-128-GCM, what socketServer's hello chooses): a record is
 *  its frame and 22 bytes. */
export const TLS13_OVERHEAD = 22;

/** The site socket's host behind the page's SOCKS5: a TLS 1.3 ServerHello
 *  (AES-128-GCM) at once, its answer to the handshake request (a record
 *  standing for the 101) once the request reached it, and records of its
 *  own on demand. It keeps what reached it. */
export async function socketServer(options: { tls12Suite?: number } = {}): Promise<{ port: number; received: () => Buffer; send: (record: Buffer) => void; close: () => Promise<void> }> {
  const chunks: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let answered = false;
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (!answered && chunk.includes(SOCKET_FILL.request)) {
        answered = true;
        socket.write(tlsRecord(23, 150, 0x55));
      }
    });
    const suite = options.tls12Suite;
    const tail = suite === undefined ? Buffer.from([0x13, 0x01, 0x00, 0x00, 0x06, 0x00, 0x2b, 0x00, 0x02, 0x03, 0x04]) : Buffer.from([suite >> 8, suite & 0xff, 0x00]);
    const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32, 7), Buffer.from([0]), tail]);
    const handshake = Buffer.concat([Buffer.from([0x02, 0, 0, body.length]), body]);
    socket.write(Buffer.concat([Buffer.from([0x16, 0x03, 0x03, 0, handshake.length]), handshake]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    received: () => Buffer.concat(chunks),
    send: (record) => {
      for (const socket of sockets) socket.write(record);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Chrome's side of a socket's tunnel through the operator's proxy, as TLS
 *  records (TLS 1.3 against tlsLikeServer): its ClientHello, the server's
 *  hello back, its Finished, then the WebSocket handshake request — the
 *  record the proxy holds to the admission's deadline — and frames. */
export class SocketTunnelClient {
  readonly status: number;
  readonly socket: Socket;
  readonly closed: Promise<void>;

  private constructor(status: number, socket: Socket) {
    this.status = status;
    this.socket = socket;
    socket.on("error", () => undefined);
    this.closed = new Promise((resolve) => socket.once("close", () => resolve()));
  }

  /** The CONNECT; resolves with the proxy's answer (it waits for the
   *  admission first). */
  static async connect(proxyPort: number, target = "wsv3.fansly.com:443"): Promise<SocketTunnelClient> {
    const { status, socket } = await proxyConnect(proxyPort, target);
    return new SocketTunnelClient(status, socket);
  }

  /** What the server sent back through the tunnel. */
  readonly inbound: Buffer[] = [];

  /** The TLS handshake: ClientHello, the server's hello, the Finished. */
  async tls(): Promise<void> {
    this.socket.write(tlsRecord(22, 200, SOCKET_FILL.clientHello));
    await new Promise<void>((resolve) => {
      this.socket.on("data", (chunk: Buffer) => {
        this.inbound.push(chunk);
        resolve();
      });
      this.socket.resume();
    });
    this.socket.write(tlsRecord(23, 58, SOCKET_FILL.finished));
  }

  /** The server's answer to the handshake request came through (socketServer's 101). */
  answered(timeoutMs = 3000): Promise<void> {
    return until(() => Buffer.concat(this.inbound).includes(0x55), timeoutMs, "the handshake's answer");
  }

  /** The handshake request: one big application-data record. */
  request(): void {
    this.socket.write(tlsRecord(23, 300, SOCKET_FILL.request));
  }

  /** One record carrying frames of these payload sizes (two or more: a
   *  coalesced write), as Chrome writes them over TLS 1.3. */
  message(payloads: number | number[], fill: number = SOCKET_FILL.frame): void {
    const frames = (Array.isArray(payloads) ? payloads : [payloads]).reduce((sum, payload) => sum + clientFrameBytes(payload), 0);
    this.socket.write(tlsRecord(23, TLS13_OVERHEAD + frames, fill));
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** The engine's end, as the site socket's path sees it: what the operator
 *  sent it. */
export class FakeSocketLink {
  readonly messages: Array<Record<string, unknown>> = [];

  send(message: object): boolean {
    this.messages.push(message as Record<string, unknown>);
    return true;
  }

  of(type: string): Array<Record<string, unknown>> {
    return this.messages.filter((message) => message.type === type);
  }
}
