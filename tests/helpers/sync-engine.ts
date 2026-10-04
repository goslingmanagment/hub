import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import type { Pool } from "pg";

import {
  capturePayloadRefFromColumns,
  createFanslyPage,
  createModel,
  ensureFanslyPageSendGuard,
  ensureSyncPage,
  storeFanslySession,
  storeProxyConfig,
  upsertDemand,
  upsertFans,
  upsertPageDmMessages,
  writeThreadChain,
  type Database,
  type SyncPageMode,
  type ThreadChainState,
} from "@agency_hub_core/db";
import {
  composeFanslySendCheck,
  createOneShotSendCheck,
  findFanslySendRefusal,
  safeFanslyAnswerHeaders,
  type FanslyWireId,
  type FanslyWireOutcome,
  type FanslyWireRequest,
} from "@agency_hub_core/fansly";
import { encryptJson, loadConfig, type AppConfig } from "@agency_hub_core/shared";

import { readFanslyPageGeneration } from "../../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { resolveEgress, type AppEgressContext } from "../../apps/runtime/src/services/egress/resolver.ts";
import { resolveCapturePayloadRow } from "../../apps/runtime/src/services/payload-reader.ts";
import type { SyncHostOptions } from "../../apps/runtime/src/sync/engine/host.ts";
import { createPacer, REQUEST_TIMEOUT_MS, type Pacer } from "../../apps/runtime/src/sync/engine/pacer.ts";
import type {
  Clock,
  LivePageSocket,
  LivePageSocketRef,
  PauseSource,
  Rng,
  SendHooks,
  TransportOutcome,
  WsSourceState,
} from "../../apps/runtime/src/sync/engine/ports.ts";
import {
  createEngineRegistry,
  type EngineRegistry,
  type EngineResourceSpec,
  type ReplayVerdict,
  type ResourceModule,
} from "../../apps/runtime/src/sync/engine/resource.ts";
import type { PageTransport } from "../../apps/runtime/src/sync/engine/shadow.ts";
import { fanslyCaptureCodec } from "../../apps/runtime/src/sync/fansly/capture.ts";
import { fanslyReplayOwner, fanslyResourceSpec } from "../../apps/runtime/src/sync/fansly/registry.ts";
import { createMediaDownloadModule, mediaDownloadSubject } from "../../apps/runtime/src/sync/fansly/resources/media-download.ts";
import { createPageTransport } from "../../apps/runtime/src/sync/fansly/transport.ts";
import { encryptSyncWorkSecret } from "../../apps/runtime/src/sync/requests/secret-params.ts";
import { onHistoryThreadChainChanged, onHistoryWorkClosed } from "../../apps/runtime/src/sync/requests/history.ts";
import { seededRandom } from "./sync-fakes.ts";
import { quietLogger, setModeDirect, testSpec } from "./sync-engine-host.ts";

export { FakeClock, SeededRng, seededRandom } from "./sync-fakes.ts";

// The physical-request harness of the Fansly Sync Engine (design §10): the
// pieces every engine test that needs Fansly on the other side shares.
//
// - FakeFanslyServer: a local origin (REST, CDN hops, the WebSocket Upgrade)
//   that records every request the moment it ARRIVES, on this process's
//   monotonic clock, before it answers.
// - CountingConnectProxy: the page proxy — an HTTP CONNECT proxy with a
//   tunnel delay the test sets, counting tunnels and the bytes it forwards.
// - seedHarnessPage: a Fansly page with its encrypted session, its proxy and
//   its engine row, so the production page transport (`createPageTransport`,
//   the page egress of `resolveEgress`) runs unchanged against the fakes.
// - FakeChats: synthetic Fansly chats served the way `/message` serves them.
// - The harness transport and registry: every request of the page through the
//   production transport (`createPageTransport`) and the production
//   resources of the CDN download (`media-download.fetch`, its URL policy
//   widened to the loopback origin) and of the WebSocket Upgrade
//   (`ws.connect`), whose page socket owner — S3-03's `FanslyWsSource` in
//   production — is `HarnessSocket`: a real Upgrade of the fake origin
//   through the page egress with the admission's check.
// - The journal replay driver, the actor runner and the child process.
//
// The fake origin speaks plain HTTP behind the CONNECT proxy, as the step-1
// network helpers do: the tunnel (and with it the "long connect before the
// headers") is the proxy's, and the send check runs at undici's
// `onRequestStart` after it either way; TLS would only need a trust root a
// test worker cannot add after it started.

// ── the fake origin ─────────────────────────────────────────────────────────

export interface FakeArrival {
  /** 1-based, in arrival order. */
  seq: number;
  /** `performance.now()` when the request head was parsed (this process). */
  mono: number;
  wallMs: number;
  method: string;
  /** Path and query, as the request line carried them. */
  path: string;
  upgrade: boolean;
  /** The status the origin answered with (set once answered). */
  status: number | null;
}

export interface FakeRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
}

export interface FakeAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Close the connection after the answer: the next request needs a new tunnel. */
  close?: boolean;
  /** Hold the answer back this long (a slow origin). */
  delayMs?: number;
  /** Drip the body: the headers at once, then one byte every `everyMs` (an
   *  origin that keeps the connection busy past any inactivity timer). */
  drip?: { everyMs: number };
}

/** An origin route: an answer, or null for "not mine". */
export type FakeRoute = (request: FakeRequest) => FakeAnswer | null;

/** The Fansly envelope of a successful answer. */
export function fanslyJson(response: unknown): FakeAnswer {
  return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: true, response }) };
}

/** Where the harness WebSocket Upgrade goes (the live socket is `/?v=3` on wsv3). */
export const HARNESS_WS_PATH = "/ws";
/** CDN hops: `/cdn/<name>` answers 302 to `/cdn/final/<name>`, which answers the bytes. */
export const HARNESS_CDN_PREFIX = "/cdn/";

export class FakeFanslyServer {
  readonly arrivals: FakeArrival[] = [];
  /** The share of answers that close their connection (new tunnels). */
  closeShare = 0;
  /** Every answer is held back this long (on top of a route's own delay). */
  answerDelayMs = 0;
  /** A WebSocket peer for every accepted Upgrade to `HARNESS_WS_PATH`, in
   *  order. Without `onWebSocket` the harness hangs up after the 101. */
  readonly wsPeers: FakeWsPeer[] = [];
  /** Speaks the socket's protocol for each accepted Upgrade (null: hang up). */
  onWebSocket: ((peer: FakeWsPeer) => void) | null = null;
  /** The status of the next Upgrades (101 accepts; 0 drops the connection
   *  without an answer). */
  upgradeStatus: (index: number) => number = () => 101;
  /** The headers of a refused Upgrade's answer (`Retry-After`, a cookie). */
  upgradeHeaders: (index: number) => Record<string, string> = () => ({});
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  #routes: FakeRoute[] = [];
  #origin = "";

  private constructor() {
    this.#server = createServer((request, response) => this.#onRequest(request, response));
    this.#server.on("connection", (socket) => this.#track(socket));
    this.#server.on("upgrade", (request: IncomingMessage, socket: Socket) => this.#onUpgrade(request, socket));
  }

  static async start(): Promise<FakeFanslyServer> {
    const server = new FakeFanslyServer();
    await new Promise<void>((resolve) => server.#server.listen(0, "127.0.0.1", () => resolve()));
    server.#origin = `http://127.0.0.1:${(server.#server.address() as AddressInfo).port}`;
    return server;
  }

  /** `http://127.0.0.1:<port>` */
  get origin(): string {
    return this.#origin;
  }

  /** The page's `fanslyBaseUrl`. */
  get apiBaseUrl(): string {
    return `${this.#origin}/api/v1`;
  }

  /** Add a route; earlier routes win. */
  route(route: FakeRoute): this {
    this.#routes.push(route);
    return this;
  }

  /** Arrivals whose path starts with `prefix` (the API prefix included). */
  arrivalsAt(prefix: string): FakeArrival[] {
    return this.arrivals.filter((arrival) => arrival.path.startsWith(prefix));
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #track(socket: Socket): void {
    this.#sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.#sockets.delete(socket));
  }

  #arrive(request: IncomingMessage, upgrade: boolean): FakeArrival {
    const arrival: FakeArrival = {
      seq: this.arrivals.length + 1,
      mono: performance.now(),
      wallMs: Date.now(),
      method: request.method ?? "GET",
      path: request.url ?? "/",
      upgrade,
      status: null,
    };
    this.arrivals.push(arrival);
    return arrival;
  }

  #answer(request: IncomingMessage): FakeAnswer {
    const fake: FakeRequest = { method: request.method ?? "GET", url: new URL(request.url ?? "/", this.#origin), headers: request.headers };
    for (const route of this.#routes) {
      const answer = route(fake);
      if (answer !== null) return answer;
    }
    const cdn = cdnAnswer(fake.url.pathname);
    if (cdn !== null) return cdn;
    return { status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: false, error: { code: 404 } }) };
  }

  #onRequest(request: IncomingMessage, response: ServerResponse): void {
    const arrival = this.#arrive(request, false);
    const answer = this.#answer(request);
    const close = answer.close === true || (this.closeShare > 0 && Math.random() < this.closeShare);
    const send = () => {
      arrival.status = answer.status;
      response.writeHead(answer.status, { ...(answer.headers ?? {}), ...(close ? { connection: "close" } : {}) });
      const drip = answer.drip;
      if (drip === undefined) {
        response.end(answer.body ?? "");
        return;
      }
      const body = Buffer.from(answer.body ?? "");
      let at = 0;
      const timer = setInterval(() => {
        if (response.destroyed || at >= body.length) {
          clearInterval(timer);
          if (!response.destroyed) response.end();
          return;
        }
        response.write(body.subarray(at, at + 1));
        at += 1;
      }, drip.everyMs);
      response.once("close", () => clearInterval(timer));
    };
    const delayMs = this.answerDelayMs + (answer.delayMs ?? 0);
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  }

  #onUpgrade(request: IncomingMessage, socket: Socket): void {
    this.#track(socket);
    const arrival = this.#arrive(request, true);
    const path = new URL(request.url ?? "/", this.#origin).pathname;
    const key = request.headers["sec-websocket-key"];
    if (path !== HARNESS_WS_PATH || typeof key !== "string") {
      arrival.status = 400;
      socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const index = this.arrivals.filter((item) => item.upgrade).length - 1;
    const status = this.upgradeStatus(index);
    if (status === 0) {
      arrival.status = 0;
      socket.destroy();
      return;
    }
    if (status !== 101) {
      arrival.status = status;
      const extra = Object.entries(this.upgradeHeaders(index)).map(([name, value]) => `${name}: ${value}\r\n`).join("");
      socket.end(`HTTP/1.1 ${status} Refused\r\ncontent-length: 0\r\nconnection: close\r\n${extra}\r\n`);
      return;
    }
    arrival.status = 101;
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n"
      + `sec-websocket-accept: ${accept}\r\n\r\n`);
    if (this.onWebSocket === null) {
      // The frames of an open socket are not requests: the harness hangs up.
      socket.end();
      return;
    }
    const peer = new FakeWsPeer(socket);
    this.wsPeers.push(peer);
    this.onWebSocket(peer);
  }
}

/** One server-side WebSocket frame (unmasked, FIN). */
function wsFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * The origin's end of one accepted WebSocket: reads the client's (masked)
 * frames, answers pings and the close handshake, and sends text frames the
 * test scripts. `onText` sees every text frame the client sent.
 */
export class FakeWsPeer {
  readonly received: string[] = [];
  closed = false;
  onText: (text: string) => void = () => undefined;
  readonly #socket: Socket;
  #buffer = Buffer.alloc(0);

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.once("close", () => {
      this.closed = true;
    });
  }

  send(text: string): void {
    if (this.closed || this.#socket.destroyed) return;
    this.#socket.write(wsFrame(0x1, Buffer.from(text)));
  }

  /** The close handshake from the origin's side. */
  close(code = 1000): void {
    if (this.closed || this.#socket.destroyed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.#socket.end(wsFrame(0x8, payload));
  }

  /** Drop the connection without a close frame. */
  destroy(): void {
    this.#socket.destroy();
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const buffer = this.#buffer;
      if (buffer.length < 2) return;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask !== null) for (let i = 0; i < payload.length; i += 1) payload[i]! ^= mask[i % 4]!;
      this.#buffer = buffer.subarray(offset + length);
      if (opcode === 0x1) {
        const text = payload.toString("utf8");
        this.received.push(text);
        this.onText(text);
      } else if (opcode === 0x8) {
        this.#socket.end(wsFrame(0x8, payload.subarray(0, 2)));
      } else if (opcode === 0x9) {
        this.#socket.write(wsFrame(0xa, payload));
      }
    }
  }
}

function cdnAnswer(pathname: string): FakeAnswer | null {
  if (!pathname.startsWith(HARNESS_CDN_PREFIX)) return null;
  const rest = pathname.slice(HARNESS_CDN_PREFIX.length);
  if (rest.startsWith("final/")) {
    return { status: 200, headers: { "content-type": "image/jpeg" }, body: Buffer.from(`jpeg:${rest.slice("final/".length)}`) };
  }
  return { status: 302, headers: { location: `${HARNESS_CDN_PREFIX}final/${rest}` } };
}

// ── the page proxy ──────────────────────────────────────────────────────────

export class CountingConnectProxy {
  /** Tunnels opened (CONNECT requests accepted). */
  tunnels = 0;
  /** Request bytes forwarded to the origin over every tunnel. */
  bytesToOrigin = 0;
  /** Request bytes forwarded per tunnel, in tunnel order. */
  readonly bytesPerTunnel: number[] = [];
  /** How long tunnel `index` (0-based) takes to come up. */
  tunnelDelayMs: (index: number) => number = () => 0;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  #url = "";

  private constructor() {
    this.#server = createServer();
    this.#server.on("connection", (socket) => this.#track(socket));
    this.#server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => this.#onConnect(request, client, head));
  }

  static async start(): Promise<CountingConnectProxy> {
    const proxy = new CountingConnectProxy();
    await new Promise<void>((resolve) => proxy.#server.listen(0, "127.0.0.1", () => resolve()));
    proxy.#url = `http://127.0.0.1:${(proxy.#server.address() as AddressInfo).port}`;
    return proxy;
  }

  get url(): string {
    return this.#url;
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #track(socket: Socket): void {
    this.#sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.#sockets.delete(socket));
  }

  #onConnect(request: IncomingMessage, client: Socket, head: Buffer): void {
    const index = this.tunnels;
    this.tunnels += 1;
    this.bytesPerTunnel.push(0);
    const [host, port] = (request.url ?? "").split(":");
    setTimeout(() => {
      if (client.destroyed) return;
      const upstream = connect(Number(port), host ?? "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const forward = (chunk: Buffer) => {
          this.bytesToOrigin += chunk.length;
          this.bytesPerTunnel[index] = (this.bytesPerTunnel[index] ?? 0) + chunk.length;
          upstream.write(chunk);
        };
        if (head.length > 0) forward(head);
        client.on("data", forward);
        client.once("end", () => upstream.end());
        upstream.pipe(client);
      });
      this.#track(upstream);
      upstream.once("close", () => client.destroy());
      client.once("close", () => upstream.destroy());
    }, Math.max(0, this.tunnelDelayMs(index)));
  }
}

// ── the page ────────────────────────────────────────────────────────────────

/** The encryption key of `harnessConfig` (and of `testConfig` in sync-engine-host). */
export const HARNESS_ENCRYPTION_KEY = Buffer.alloc(32, 7);
/** The page's own Fansly account id (`pages.external_page_id`). */
export const HARNESS_OWN_REF = "300000000000000001";

/** A config whose Fansly base URL is the fake origin's. */
export function harnessConfig(connectionString: string, fanslyBaseUrl = "https://fansly.invalid/api/v1"): AppConfig {
  return loadConfig({
    DATABASE_URL: connectionString,
    APP_ENCRYPTION_KEY: HARNESS_ENCRYPTION_KEY.toString("base64"),
    LOG_LEVEL: "silent",
    FANSLY_BASE_URL: fanslyBaseUrl,
  }, { loadDotEnv: false });
}

export interface HarnessHandles {
  db: Database;
  pool: Pool;
}

export interface HarnessPage {
  pageId: number;
  pageLabel: string;
}

/**
 * A Fansly page as the switch would leave it: encrypted session, the page
 * proxy (`proxyUrl`, or none), its engine row in `mode`, the step-1 guard row
 * handed to the engine for a live page (`engine_switched_at` at the page's
 * `mode_changed_at`: phase A stamps it before the page goes live), the legacy
 * import stamped, history requests open, and — with a proxy — the stored
 * credentials verified by the engine (`credentials_generation`, as the
 * takeover `account.verify` leaves it; S3-05: the live transport sends
 * nothing else before it).
 */
export async function seedHarnessPage(
  handles: HarnessHandles,
  options: { mode: SyncPageMode; proxyUrl?: string | null; label?: string; ownRef?: string },
): Promise<HarnessPage> {
  const pageLabel = options.label ?? "harness-page";
  const model = await createModel(handles.db, { slug: `model-${pageLabel}`, name: pageLabel });
  const page = await createFanslyPage(handles.db, { modelId: model!.id, label: pageLabel });
  const pageId = page!.id;
  const session = { authorization: "token", fanslyClientId: "client-id", fanslyClientCheck: "client-check", fanslySessionId: "session-id" };
  await storeFanslySession(handles.db, pageId, JSON.stringify(encryptJson(session, HARNESS_ENCRYPTION_KEY, 1)), 1);
  if (options.proxyUrl !== undefined && options.proxyUrl !== null) {
    await storeProxyConfig(handles.db, pageId, { url: options.proxyUrl, encryptedAuth: null, keyVersion: null });
  }
  await handles.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, options.ownRef ?? HARNESS_OWN_REF]);
  await ensureSyncPage(handles.db, { pageId });
  await setModeDirect(handles.pool, pageId, options.mode);
  await handles.pool.query(
    `update sync_pages set mode_changed_at = clock_timestamp() - interval '1 day',
            legacy_imported_at = case when mode = 'live' then clock_timestamp() - interval '1 hour' end,
            requests_enabled_at = case when mode = 'live' then clock_timestamp() - interval '1 hour' end
      where page_id = $1`,
    [pageId],
  );
  if (options.mode === "live") {
    await ensureFanslyPageSendGuard(handles.db, pageId);
    await handles.pool.query(
      `update fansly_page_send_guards g set owner_engine = 'fansly_sync_engine', engine_switched_at = sp.mode_changed_at
         from sync_pages sp
        where g.page_id = $1 and sp.page_id = g.page_id`,
      [pageId],
    );
    if (options.proxyUrl !== undefined && options.proxyUrl !== null) await stampVerifiedCredentials(handles, { pageId, pageLabel });
  }
  return { pageId, pageLabel };
}

/** The stored credentials digest as the engine's verified one (what an
 *  applied `account.verify` writes): a test that changed the page's session
 *  or proxy re-stamps it. */
export async function stampVerifiedCredentials(handles: HarnessHandles, page: HarnessPage): Promise<string> {
  const generation = await handles.db.transaction(
    async (raw) => readFanslyPageGeneration(raw as unknown as Database, page.pageLabel),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  await handles.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1", [page.pageId, generation]);
  return generation;
}

// ── synthetic chats ─────────────────────────────────────────────────────────

/** Fansly's snowflake epoch (`packages/shared/src/snowflake.ts`). */
export const FANSLY_EPOCH_MS = 1561494359900;

export function snowflakeAt(ms: number, seq = 0): string {
  return ((BigInt(Math.floor(ms) - FANSLY_EPOCH_MS) << 22n) | BigInt(seq)).toString();
}

export interface FakeChatMessage {
  id: string;
  createdAtMs: number;
  senderId: string;
}

export interface FakeChat {
  groupId: string;
  fanRef: string;
  /** Oldest first. */
  messages: FakeChatMessage[];
}

/**
 * Fansly chats as `/message` serves them: newest first, `limit` a page, ids
 * strictly below `before`, the empty page below the first message. Message
 * k of a chat is sent k × `spacingMs` (default 1 s) after its start,
 * alternately by the fan and the page; ids are unique across chats (the
 * chat's index is the snowflake sequence).
 */
export class FakeChats {
  readonly #chats = new Map<string, FakeChat & { index: number; startMs: number; spacingMs: number }>();
  readonly #ownRef: string;

  constructor(ownRef = HARNESS_OWN_REF) {
    this.#ownRef = ownRef;
  }

  /** A chat of `count` messages that started `ageMs` ago. */
  add(input: { count: number; ageMs: number; fanRef?: string; spacingMs?: number }): FakeChat {
    const index = this.#chats.size;
    if (index >= 4096) throw new Error("FakeChats holds at most 4096 chats");
    const startMs = Date.now() - input.ageMs;
    const chat = {
      groupId: snowflakeAt(startMs - 1_000, index),
      fanRef: input.fanRef ?? snowflakeAt(startMs - 2_000, index),
      messages: [] as FakeChatMessage[],
      index,
      startMs,
      spacingMs: input.spacingMs ?? 1_000,
    };
    this.#chats.set(chat.groupId, chat);
    this.append(chat.groupId, input.count);
    return chat;
  }

  /** `count` new messages at the end of the chat: on the chat's own clock
   *  (never in the future), or one millisecond apart from `atMs`. */
  append(
    groupId: string,
    count: number,
    sender: "fan" | "page" | "alternate" = "alternate",
    atMs: number | null = null,
  ): FakeChatMessage[] {
    const chat = this.#chat(groupId);
    const added: FakeChatMessage[] = [];
    for (let n = 0; n < count; n += 1) {
      const k = chat.messages.length;
      const createdAtMs = atMs !== null ? atMs + n : Math.min(chat.startMs + k * chat.spacingMs, Date.now() - 1_000 + n);
      const fromFan = sender === "fan" || (sender === "alternate" && k % 2 === 1);
      const message = { id: snowflakeAt(createdAtMs, chat.index), createdAtMs, senderId: fromFan ? chat.fanRef : this.#ownRef };
      if (chat.messages.length > 0 && BigInt(message.id) <= BigInt(chat.messages.at(-1)!.id)) {
        throw new Error(`chat ${groupId} would get a non-increasing message id`);
      }
      chat.messages.push(message);
      added.push(message);
    }
    return added;
  }

  get(groupId: string): FakeChat {
    return this.#chat(groupId);
  }

  all(): FakeChat[] {
    return [...this.#chats.values()];
  }

  /** The Fansly wire shape of one message. */
  wire(groupId: string, message: FakeChatMessage): Record<string, unknown> {
    return {
      id: message.id,
      type: 1,
      dataVersion: 1,
      content: `message ${message.id}`,
      groupId,
      senderId: message.senderId,
      correlationId: null,
      inReplyTo: null,
      inReplyToRoot: null,
      createdAt: Math.floor(message.createdAtMs / 1000),
      attachments: [],
      embeds: [],
      interactions: [],
      likes: [],
      totalTipAmount: 0,
    };
  }

  /** One `/message` page. */
  page(groupId: string, before: string | null, limit: number): Array<Record<string, unknown>> {
    const chat = this.#chat(groupId);
    let end = chat.messages.length;
    if (before !== null) {
      const bound = BigInt(before);
      let lo = 0;
      let hi = chat.messages.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (BigInt(chat.messages[mid]!.id) < bound) lo = mid + 1;
        else hi = mid;
      }
      end = lo;
    }
    const out: Array<Record<string, unknown>> = [];
    for (let i = end - 1; i >= 0 && out.length < limit; i -= 1) out.push(this.wire(groupId, chat.messages[i]!));
    return out;
  }

  /** The answer to a `/message` request URL, or null for another route. */
  answer(url: URL): { messages: Array<Record<string, unknown>> } | null {
    if (!url.pathname.endsWith("/message")) return null;
    const groupId = url.searchParams.get("groupId");
    if (groupId === null || !this.#chats.has(groupId)) return { messages: [] };
    return { messages: this.page(groupId, url.searchParams.get("before"), Number(url.searchParams.get("limit") ?? "25")) };
  }

  /** The origin route of `/api/v1/message`. */
  route(): FakeRoute {
    return (request) => {
      const answer = this.answer(request.url);
      return answer === null ? null : fanslyJson(answer);
    };
  }

  /** A scripted transport's answer (no network). */
  respond(req: FanslyWireRequest): FanslyWireOutcome {
    const answer = this.answer(new URL(req.url));
    if (answer === null) throw new Error(`FakeChats: unexpected request ${req.url}`);
    const bodyText = JSON.stringify({ success: true, response: answer });
    return { kind: "response", status: 200, headers: {}, bodyText, bodyBytes: bodyText.length, sendMark: "request_start" };
  }

  #chat(groupId: string) {
    const chat = this.#chats.get(groupId);
    if (chat === undefined) throw new Error(`FakeChats: no chat ${groupId}`);
    return chat;
  }
}

/**
 * The page's thread of a fake chat, as legacy and the journal rebuild left it:
 * the fan bound (unless `bound: false`), `stored` (the chat's messages the hub
 * holds, a legacy window), and with `chain` the contiguous chain the rebuild
 * proved over them. Returns the thread id.
 */
export async function seedChatThread(
  handles: HarnessHandles,
  pageId: number,
  chat: FakeChat,
  options: { stored?: readonly FakeChatMessage[]; chain?: boolean; bound?: boolean; ownRef?: string } = {},
): Promise<number> {
  const ownRef = options.ownRef ?? HARNESS_OWN_REF;
  const stored = [...(options.stored ?? [])].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const fanId = options.bound === false
    ? null
    : (await upsertFans(handles.db, [{ platform: "fansly" as const, platformUserId: chat.fanRef }]))[0]!.id;
  const newest = stored.at(-1) ?? null;
  const oldest = stored[0] ?? null;
  const inserted = await handles.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
            partner_username, conversation_flags, unread_count, last_message_id, last_message_at, last_message_sender_id,
            last_message_sender_role, newest_stored_message_id, oldest_stored_message_id, stored_message_count,
            message_coverage_status, is_visible, metadata, history_state)
     values ($1, $2, $3, $4, 'fan', 0, 0, $5, $6, $4, 'fan', $5, $7, $8, 'partial_window', true, '{}'::jsonb,
             case when $8 > 0 then 'unverified' else 'none' end)
     returning id::text as id`,
    [
      pageId, chat.groupId, fanId, chat.fanRef,
      newest?.id ?? null, newest === null ? null : new Date(newest.createdAtMs), oldest?.id ?? null, stored.length,
    ],
  );
  const threadId = Number(inserted.rows[0]!.id);
  for (let at = 0; at < stored.length; at += 1_000) {
    await upsertPageDmMessages(handles.db, stored.slice(at, at + 1_000).map((message) => ({
      conversationId: threadId,
      platformAccountId: pageId,
      platformMessageId: message.id,
      senderPlatformUserId: message.senderId,
      senderRole: message.senderId === ownRef ? "model" as const : "fan" as const,
      createdAt: new Date(Math.floor(message.createdAtMs / 1000) * 1000),
      content: `message ${message.id}`,
      totalTipAmountCents: 0,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    })));
  }
  if (options.chain === true && newest !== null && oldest !== null) {
    const chain: ThreadChainState = {
      epoch: 0,
      state: "partial",
      headId: newest.id,
      headAt: new Date(Date.now() - 3_600_000),
      oldestId: oldest.id,
      oldestCreatedAtMs: oldest.createdAtMs,
      count: stored.length,
      upwardCount: 0,
      proof: null,
      proofWitness: null,
      provenAt: null,
    };
    await handles.db.transaction(async (tx) => {
      await writeThreadChain(tx as unknown as Database, threadId, { chain, source: "journal_rebuild" });
    });
  }
  return threadId;
}

// ── the harness transport ───────────────────────────────────────────────────

type PageDispatcher = NonNullable<AppEgressContext["dispatcher"]>;

/** The harness's CDN: the fake origin on loopback, `/cdn/…` (the production
 *  policy allows Fansly media CDN hosts over https only). */
export function harnessCdnUrlAllowed(url: URL): boolean {
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname.startsWith(HARNESS_CDN_PREFIX);
}

/**
 * The page's transport for the harness: the production page transport
 * (`fansly/transport.ts`: page egress, stored session, the wire layer's
 * single-request send, a CDN hop's secret URL, the Upgrade through the page's
 * socket owner), with the CDN URL policy widened to the loopback origin.
 */
export async function createHarnessTransport(
  ctx: { db: Database; config: AppConfig },
  page: HarnessPage,
  options: { socket?: LivePageSocketRef } = {},
): Promise<PageTransport> {
  return createPageTransport(ctx, page, {
    ...(options.socket === undefined ? {} : { socket: options.socket }),
    cdnUrlAllowed: harnessCdnUrlAllowed,
  });
}

/**
 * The page's WebSocket owner of the harness (S3-03's `FanslyWsSource` stands
 * here): each admitted `ws.upgrade` is one real HTTP Upgrade of the fake
 * origin's `/ws` through the page egress, the admission's check composed per
 * request (one-shot). The origin hangs up after its 101, so the socket is
 * `down` again (the next `ws.connect` may go); `state` is the test's to set.
 */
export class HarnessSocket implements LivePageSocket {
  state: WsSourceState = "owning";
  readonly outcomes: TransportOutcome[] = [];
  readonly #ctx: { db: Database; config: AppConfig };
  readonly #pageId: number;

  constructor(ctx: { db: Database; config: AppConfig }, pageId: number) {
    this.#ctx = ctx;
    this.#pageId = pageId;
  }

  async handshake(hooks: SendHooks, signal: AbortSignal): Promise<TransportOutcome> {
    this.state = "connecting";
    const egress = await resolveEgress(this.#ctx, { kind: "page", pageId: this.#pageId });
    try {
      if (egress.dispatcher === null) return { kind: "aborted_before_send", refusal: "lease_inactive" };
      const origin = new URL(this.#ctx.config.fanslyBaseUrl).origin;
      const outcome = await sendUpgrade(egress.dispatcher, `${origin}${HARNESS_WS_PATH}`, hooks, signal);
      this.outcomes.push(outcome);
      return outcome;
    } finally {
      this.state = "down";
      await egress.close().catch(() => undefined);
    }
  }
}

/** One HTTP Upgrade (the WebSocket handshake): the request completes at 101
 *  or at the status the origin answered instead, with the answer's safe
 *  headers as the production lease carries them (`bindFanslyUpgradeLease`);
 *  the socket is closed at once (its frames are not requests). */
async function sendUpgrade(
  dispatcher: PageDispatcher,
  url: string,
  hooks: SendHooks,
  signal: AbortSignal,
): Promise<TransportOutcome> {
  const gate = createOneShotSendCheck(hooks.check);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const target = new URL(url);
  let status: number | null = null;
  let answerHeaders: Record<string, string> = {};
  const observed = dispatcher.compose((dispatch) => (options, handler) => dispatch(options, {
    onRequestStart: (controller, context) => handler.onRequestStart?.(controller, context),
    onRequestUpgrade(controller, statusCode, headers, socket) {
      status = statusCode;
      answerHeaders = safeFanslyAnswerHeaders(headers);
      handler.onRequestUpgrade?.(controller, statusCode, headers, socket);
    },
    onResponseStart(controller, statusCode, headers, statusMessage) {
      status = statusCode;
      answerHeaders = safeFanslyAnswerHeaders(headers);
      handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
    },
    onResponseData: (controller, chunk) => handler.onResponseData?.(controller, chunk),
    onResponseEnd: (controller, trailers) => handler.onResponseEnd?.(controller, trailers),
    onResponseError: (controller, error) => handler.onResponseError?.(controller, error),
  }));
  const response = (code: number): TransportOutcome => ({
    kind: "response",
    status: code,
    headers: answerHeaders,
    bodyText: "",
    bodyBytes: 0,
    sendMark: gate.sent ? "request_start" : "completion_fallback",
  });
  try {
    // The dispatcher needs the origin; undici's `UpgradeOptions` type omits it.
    const options = {
      origin: target.origin,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      protocol: "websocket",
      headers: { "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13" },
      signal: AbortSignal.any([signal, timeout]),
    } as Parameters<PageDispatcher["upgrade"]>[0];
    const upgraded = await composeFanslySendCheck(observed, gate.check).upgrade(options);
    upgraded.socket.destroy();
    return response(101);
  } catch (error) {
    const refusal = findFanslySendRefusal(error) ?? gate.refusal;
    if (!gate.sent && refusal !== null) return { kind: "aborted_before_send", refusal: refusal.reason };
    if (status !== null) return response(status);
    const message = error instanceof Error ? error.message : String(error);
    return timeout.aborted ? { kind: "timeout", sent: gate.sent, message } : { kind: "transport_error", sent: gate.sent, message };
  }
}

/** A chat file the describer would ask the engine for: its description row and
 *  the `media-download.fetch` work with `url` sealed in its secret. */
export async function demandHarnessDownload(
  handles: HarnessHandles,
  input: { pageId: number; config: AppConfig; url: string; mediaRef?: string },
): Promise<{ descriptionId: number; workId: number }> {
  const description = await handles.pool.query<{ id: string }>(
    `insert into ai_media_descriptions (page_id, platform, media_ref, variant, media_kind, sender_role, status)
     values ($1, 'fansly', $2, 'full', 'photo', 'fan', 'pending') returning id::text as id`,
    [input.pageId, input.mediaRef ?? `media-${randomBytes(6).toString("hex")}`],
  );
  const descriptionId = Number(description.rows[0]!.id);
  const work = await upsertDemand(handles.db, {
    pageId: input.pageId,
    shadow: false,
    resource: "media-download.fetch",
    subject: mediaDownloadSubject(descriptionId),
    kind: "trigger",
    class: "planned",
    demand: { reasons: ["ai_describe"] },
    secretParams: encryptSyncWorkSecret(input.config, { url: input.url }),
    createOnly: true,
  });
  return { descriptionId, workId: work.id };
}

// ── the harness registry ────────────────────────────────────────────────────

/** Test-only keys, one per physical request kind of a page (design §10). */
export const HARNESS_KEY = {
  /** A standing planned poll (`/polls`). */
  poll: "harness.poll",
  /** Urgent triggers (`/trackinglinks`). */
  urgent: "harness.urgent",
  /** The identity check's `/account/me` (`account.identity` arrives with S3-05). */
  identity: "harness.identity",
  /** A CDN download, one admission per hop (the production resource). */
  cdn: "media-download.fetch",
  /** The WebSocket Upgrade (the production resource). */
  ws: "ws.connect",
  /** A REST route the origin answers 302 (`/recapstats`). */
  redirect: "harness.redirect",
  /** A REST route the origin answers 421 (`/message/broadcast/scheduled`). */
  misdirected: "harness.misdirected",
} as const;

export const HARNESS_POLL_EVERY_MS = 400;

function oneRequest(spec: FanslyWireId, extra: Record<string, unknown> = {}): ResourceModule {
  return {
    plan: async () => ({ kind: "request", request: { spec, params: extra as never } }),
    apply: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
    shadow: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
  };
}

/**
 * The registry of the transport tests: the REST request kinds of a page as
 * test-only keys (each its own resource file, so one kind's breaker never
 * holds another); the production CDN download (its URL policy widened to the
 * loopback origin) and WebSocket Upgrade; the production `dm-messages.*`
 * entries for the history reads of the requests class.
 */
export function harnessRegistry(): EngineRegistry {
  const pollModule: ResourceModule = {
    plan: async () => ({ kind: "request", request: { spec: "polls", params: {} } }),
    apply: async () => ({ work: { satisfiesRevision: true }, followups: [] }),
    shadow: async () => ({ work: { satisfiesRevision: true }, followups: [] }),
  };
  const specs: EngineResourceSpec[] = [
    testSpec(HARNESS_KEY.poll, pollModule, { kind: "poll", class: "planned", period: { everyMs: HARNESS_POLL_EVERY_MS } }),
    testSpec(HARNESS_KEY.urgent, oneRequest("trackinglinks")),
    testSpec(HARNESS_KEY.identity, oneRequest("account.me")),
    { ...fanslyResourceSpec("media-download.fetch")!, module: async () => createMediaDownloadModule({ urlAllowed: harnessCdnUrlAllowed }) },
    fanslyResourceSpec("ws.connect")!,
    testSpec(HARNESS_KEY.redirect, oneRequest("recapstats"), { terminalStatuses: [302] }),
    testSpec(HARNESS_KEY.misdirected, oneRequest("broadcast.scheduled"), { terminalStatuses: [421] }),
    ...["dm-messages.head", "dm-messages.catchup", "dm-messages.history"].map((key) => fanslyResourceSpec(key)!),
  ];
  return createEngineRegistry(specs);
}

/** The harness registry plus the production identity checks the credentials
 *  flows use (`account.verify` is a new owner's first read of a page,
 *  `account.identity` the check of a candidate session or proxy). */
export function harnessIdentityRegistry(): EngineRegistry {
  return createEngineRegistry([
    ...harnessRegistry().specs,
    fanslyResourceSpec("account.verify")!,
    fanslyResourceSpec("account.identity")!,
  ]);
}

/** The origin routes the harness registry's REST keys need. */
export function harnessRoutes(chats: FakeChats): FakeRoute[] {
  const api = (suffix: string) => (request: FakeRequest) => request.url.pathname === `/api/v1${suffix}`;
  const when = (match: (request: FakeRequest) => boolean, answer: FakeAnswer): FakeRoute =>
    (request) => (match(request) ? answer : null);
  return [
    chats.route(),
    when(api("/polls"), fanslyJson([])),
    when(api("/trackinglinks"), fanslyJson([])),
    when(api("/account/me"), fanslyJson({
      account: { id: HARNESS_OWN_REF, username: "harness", displayName: null, createdAt: 0, followCount: 0, subscriberCount: 0 },
    })),
    when(api("/recapstats"), { status: 302, headers: { location: "/api/v1/recapstats/elsewhere" } }),
    when(api("/message/broadcast/scheduled"), { status: 421, body: "misdirected" }),
  ];
}

// ── the host of the transport tests ─────────────────────────────────────────

/** The owner's setting as a test table every process reads per admission. */
export async function ensureHarnessSettingTable(pool: Pool, settingMs: number): Promise<void> {
  await pool.query(`
    create table if not exists sync_test_setting (id int primary key default 1 check (id = 1), ms int not null);
    insert into sync_test_setting (id, ms) values (1, ${Math.trunc(settingMs)})
      on conflict (id) do update set ms = excluded.ms;
  `);
}

export async function setHarnessSetting(pool: Pool, settingMs: number): Promise<void> {
  await pool.query("update sync_test_setting set ms = $1 where id = 1", [Math.trunc(settingMs)]);
}

/** S read fresh per admission, as `loadEffectiveConfig` reads the live key. */
export function harnessPauseSource(pool: Pool): PauseSource {
  return {
    async readSettingMs() {
      const result = await pool.query<{ ms: number }>("select ms from sync_test_setting where id = 1");
      const ms = result.rows[0]?.ms;
      if (ms === undefined) throw new Error("sync_test_setting is empty");
      return Number(ms);
    },
  };
}

/**
 * Jitter in [0.1, 0.2): the arrival log is taken at the origin, after the
 * proxy, so it carries a few milliseconds of loopback scheduling the pacer
 * cannot see; a 10 % floor keeps "no two arrivals closer than S" a statement
 * about the pacer rather than about the scheduler. The pacer's own gap is
 * checked exactly against its journal (`gap_prev_ms ≥ pause_ms`).
 */
export function harnessRng(seed: number): Rng {
  const random = seededRandom(seed);
  return { next: () => 0.5 + random() / 2 };
}

/** A clock whose sleeps return `earlyMs` early (timers that fire early). */
export function earlyWakingClock(base: Clock, earlyMs: number): Clock {
  return {
    monoNow: () => base.monoNow(),
    wallNow: () => base.wallNow(),
    sleep: (ms, signal) => base.sleep(Math.max(0, ms - earlyMs), signal),
  };
}

export interface TakeoverRecord {
  /** `performance.now()` when the pacer got its floor. */
  mono: number;
  floorDelayMs: number;
}

/**
 * The options of a live host over the harness: the production host, ownership
 * session and takeover floor (`paceFloorFromDb`), journal codec and history
 * hooks (as `main.ts` wires them), the harness transport and registry, S from
 * `sync_test_setting`, the test-only 1 ms setting floor and no route budget
 * unless asked (`routeTimeScale`). `takeovers` records every pacer's takeover
 * instant.
 */
export function harnessHostOptions(input: {
  db: Database;
  pool: Pool;
  connectionString: string;
  config: AppConfig;
  rng: Rng;
  clock?: Clock;
  takeovers?: TakeoverRecord[];
  registry?: EngineRegistry;
  probe?: SyncHostOptions["probe"];
  /** The page's socket owner; default a `HarnessSocket` per acquisition. */
  liveSocket?: SyncHostOptions["liveSocket"];
  /** Default: silent. */
  logger?: SyncHostOptions["logger"];
  alerts?: SyncHostOptions["alerts"];
  faults?: SyncHostOptions["faults"];
  /** The route budgets' time scale (default 0: none at the test pause). */
  routeTimeScale?: number;
}): SyncHostOptions {
  return {
    db: input.db,
    connectionString: input.connectionString,
    config: input.config,
    rawConfig: input.config,
    logger: input.logger ?? quietLogger,
    ...(input.alerts === undefined ? {} : { alerts: input.alerts }),
    ...(input.faults === undefined ? {} : { faults: input.faults }),
    registry: input.registry ?? harnessRegistry(),
    capture: fanslyCaptureCodec,
    onThreadChainChanged: onHistoryThreadChainChanged,
    onWorkClosed: onHistoryWorkClosed,
    rng: input.rng,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.probe === undefined ? {} : { probe: input.probe }),
    pause: harnessPauseSource(input.pool),
    liveLoopEnabled: true,
    routeTimeScale: input.routeTimeScale ?? 0,
    pacerFactory: (deps): Pacer => {
      const pacer = createPacer({ ...deps, minSettingMs: 1 });
      const takeovers = input.takeovers;
      if (takeovers !== undefined) {
        const init = pacer.initTakeover.bind(pacer);
        pacer.initTakeover = (floorDelayMs: number) => {
          init(floorDelayMs);
          takeovers.push({ mono: performance.now(), floorDelayMs });
        };
      }
      return pacer;
    },
    liveTransportFactory: async (page, options) => createHarnessTransport(
      { db: input.db, config: input.config },
      { pageId: page.pageId, pageLabel: page.pageLabel ?? `page-${page.pageId}` },
      options,
    ),
    liveSocket: input.liveSocket ?? ((page) => new HarnessSocket({ db: input.db, config: input.config }, page.pageId)),
    modeLoopIntervalMs: 200,
  };
}

// ── the journal replay ("повтор ресурсов на журнале") ───────────────────────

export interface ReplayTally {
  resource: string;
  kind: string;
  total: number;
  matched: number;
  mismatches: Array<{ observationId: number; reason: string }>;
  notReplayable: Array<{ observationId: number; reason: string }>;
}

/**
 * Every journaled observation of the page whose kind a registry entry
 * replays, oldest first, through its body seam (inline or pointer-only in the
 * content-addressed catalog) and that entry's `replay()` (design §3.12 B5).
 * Read-only. One tally per resource and kind.
 */
export async function replayPageJournal(
  handles: HarnessHandles,
  input: { pageId: number; registry: EngineRegistry; kinds?: readonly string[] },
): Promise<ReplayTally[]> {
  const { db } = handles;
  const rows = await handles.pool.query<{ id: string; receivedAt: Date; kind: string; payload: unknown; bucket: string | null; objectId: string | null }>(
    `select o.id::text as id, o.received_at as "receivedAt", o.kind, o.payload,
            to_char(o.payload_bucket_month, 'YYYY-MM-DD') as bucket, o.payload_object_id::text as "objectId"
       from observations o
      where o.account_id = $1 and o.platform = 'fansly' and o.source = 'pull'
      order by o.received_at, o.id`,
    [input.pageId],
  );
  const tallies = new Map<string, ReplayTally>();
  for (const row of rows.rows) {
    if (input.kinds !== undefined && !input.kinds.includes(row.kind)) continue;
    const owner = fanslyReplayOwner(row.kind);
    if (owner === null) continue;
    const key = `${owner.key}\u0000${row.kind}`;
    let tally = tallies.get(key);
    if (tally === undefined) {
      tally = { resource: owner.key, kind: row.kind, total: 0, matched: 0, mismatches: [], notReplayable: [] };
      tallies.set(key, tally);
    }
    const observationId = Number(row.id);
    const resolved = await resolveCapturePayloadRow({ db, logger: quietLogger as never }, "observation", observationId, {
      payload: row.payload,
      payloadRef: capturePayloadRefFromColumns(row.bucket, row.objectId),
    });
    const module = await input.registry.module(owner.key);
    const verdict: ReplayVerdict = module.replay === undefined
      ? { kind: "not_replayable", reason: "no_replay" }
      : await module.replay(
        { id: observationId, receivedAt: new Date(row.receivedAt), kind: row.kind, pageId: input.pageId, payload: resolved.payload },
        { db, pageId: input.pageId },
      );
    tally.total += 1;
    if (verdict.kind === "match") tally.matched += 1;
    else if (verdict.kind === "mismatch") tally.mismatches.push({ observationId, reason: verdict.reason });
    else tally.notReplayable.push({ observationId, reason: verdict.reason });
  }
  return [...tallies.values()].sort((a, b) => a.resource.localeCompare(b.resource) || a.kind.localeCompare(b.kind));
}

// ── running ─────────────────────────────────────────────────────────────────

/** Poll `probe` every `pollMs` until it returns true, or fail after `timeoutMs`. */
export async function until(probe: () => Promise<boolean>, timeoutMs: number, what: string, pollMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(pollMs);
  }
}

/** Run an actor until `done` holds (or `timeoutMs`), then stop it gracefully. */
export async function runActorUntil(
  made: { actor: { run(signals: { stop: AbortSignal; abort: AbortSignal }): Promise<unknown> }; stop: AbortController; abort: AbortController },
  done: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
  pollMs = 25,
): Promise<void> {
  const run = made.actor.run({ stop: made.stop.signal, abort: made.abort.signal });
  try {
    await Promise.race([
      until(done, timeoutMs, what, pollMs),
      run.then(() => {
        throw new Error(`the actor ended before ${what}`);
      }),
    ]);
  } finally {
    made.stop.abort();
    await run;
  }
}

/** Run an actor for `ms`, then stop it gracefully. */
export async function runActorFor(
  made: { actor: { run(signals: { stop: AbortSignal; abort: AbortSignal }): Promise<unknown> }; stop: AbortController; abort: AbortController },
  ms: number,
): Promise<void> {
  const run = made.actor.run({ stop: made.stop.signal, abort: made.abort.signal });
  await sleep(ms);
  made.stop.abort();
  await run;
}

export interface SyncChild {
  pid: number;
  /** Resolves once the child printed "ready <pid>". */
  ready: Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr(): string;
  kill(signal: NodeJS.Signals): void;
}

/**
 * `tests/helpers/sync-engine-child.ts <mode>` as a real process (kill -9,
 * SIGSTOP/SIGCONT, two processes on one page), with `env` added.
 */
export function spawnSyncChild(mode: string, env: Record<string, string>): SyncChild {
  const child = spawn(process.execPath, ["--import", "tsx/esm", "tests/helpers/sync-engine-child.ts", mode], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<void>((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (/^ready \d+/m.test(stdout)) resolve();
    });
    void exited.then((exit) => reject(new Error(`sync child exited before ready: ${JSON.stringify(exit)}\n${stderr}`)));
  });
  ready.catch(() => undefined);
  return {
    pid: child.pid ?? -1,
    ready,
    exited,
    stderr: () => stderr,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}
