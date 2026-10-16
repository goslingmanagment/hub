// The operator's RPC endpoint for the engine (plan §4.13; spec §6): one
// WebSocket at /rpc on :7700 — the container's input rules let only `sync`
// and `api` reach it — JSON messages.
//
// - The first message is `hello`. Its token is checked first, in constant
//   time; then the protocol's major; then the owner generation: a lower one
//   than the operator has accepted is refused, a higher one supersedes the
//   current connection, and the new one gets `quiesced` once the previous
//   generation's work has ended (plan §4.7). The hand-over is the
//   generation's, not the connection's: every accepted hello of that
//   generation gets its `quiesced` again (a connection that went before it
//   was delivered loses nothing — the engine sends nothing before it), and
//   an operator that started again, knowing no hand-over of the generation
//   it remembers, ends what came before and says so.
// - Every later message carries the connection's generation; a lower one is
//   refused, any other change of it is a protocol error.
// - ping/pong both ways every second; nothing heard from the engine for 5 s
//   and the link is lost: the operator admits nothing new (plan §4.13) and
//   the connection is closed — the engine says hello again.
// - A command runs once per id (rpc/ledger.ts); one past its notAfterMono
//   is not executed.
// - The buffer's messages (events.subscribe, ack, resultAck, recover) go to
//   the operator (buffer/); an event batch is sent as the buffer stored it
//   (`sendRaw`), not parsed and serialized again. A Hub request's messages
//   (send, checkResult) go to the operator too (hub-requests/); a `send` of
//   an earlier generation as well, so that it is answered (refused), never
//   carried out. The site socket's admissions (`wsAdmitResult`) go to the
//   operator too (ws/sockets.ts). A body goes as binary frames
//   (`sendBinary`) before the JSON
//   that names it (plan §4.13). What is sent in bulk (the
//   outcomes replayed, buffer/replay.ts) waits for the socket: `backlog`
//   and `drained`, for the connection of one `epoch`. A wait ends when the
//   connection changes too: work for a superseded connection must not hang
//   on a socket nobody reads.
// - A connection closed by the operator (superseded, lost, a protocol
//   error) is destroyed if its peer has not taken the close within a few
//   seconds: a peer that stopped reading does not keep its socket forever.
// - The API's calls of the login form (`login.*`, plan §4.8; PR 15) come on
//   the same endpoint with the API's own token: a connection whose first
//   message is a `login.*` call is the API's. Every call carries the token,
//   checked first, in constant time; a wrong one is refused and the
//   connection closes. The API's connections never touch the engine's: no
//   hello, no generation, no link. A call's answer goes on its connection —
//   a screenshot's JPEG as binary frames before the JSON that names it. A
//   call is never logged with what it carries: its type and id only.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import { CommandLedger, type CommandOutcome } from "./ledger.ts";
import type { GenerationStore } from "./generation.ts";
import type { LoginOutcome } from "../login/desk.ts";
import {
  BODY_PART_BYTES,
  encodeBodyFrame,
  parseEngineValue,
  parseLoginRequest,
  PROTOCOL,
  SUPPORTED_MAJORS,
  type BufferMessage,
  type Command,
  type Hello,
  type HelloResult,
  type HubMessage,
  type LoginReply,
  type LoginRequest,
  type OperatorToEngine,
  type SiteAdmitResult,
  type State,
  type WsAdmitResult,
} from "./protocol.ts";
import { acceptWebSocket, type WsConnection } from "../shared/ws.ts";
import { errorMessage, makeLog, monoMs, type Logger } from "../shared/util.ts";

export interface RpcHandlers {
  /** A hello passed every check and its generation is recorded: adopt its
   *  settings. Returns what the answer carries. */
  onHello: (hello: Hello) => { bufferId: string; state: State };
  /** The previous generation's work is over (finished or cancelled):
   *  resolves with the moment of its last send. */
  quiesce: (previousGeneration: number) => Promise<{ lastSendMono: number | null; lastSendWall: number | null }>;
  onCommand: (command: Command) => Promise<CommandOutcome>;
  /** The buffer's messages (PR 11): events.subscribe, ack, resultAck,
   *  recover — of this connection's generation. */
  onBuffer: (message: BufferMessage) => void;
  /** A Hub request's messages (PR 9): `send` — of this connection's
   *  generation or an earlier one (the operator refuses that) — and
   *  `checkResult` of this connection's generation. */
  onHub?: (message: HubMessage) => void;
  /** The engine's answer to a socket's admission (PR 10), of this
   *  connection's generation. */
  onSocket?: (message: WsAdmitResult) => void;
  /** The engine's answer to a site request's admission (PR 14), of this
   *  connection's generation, for the site path (PR 7). Without a handler
   *  it is dropped. */
  onSite?: (message: SiteAdmitResult) => void;
  /** The engine link came up (a hello) or was lost. */
  onLink: (up: boolean, reason: string) => void;
  /** A call of the login form (PR 15), its token checked. Without a
   *  handler every call is refused as not in the manual login. */
  onLogin?: (request: LoginRequest) => Promise<LoginOutcome | { kind: "refused"; reason: "not_manual_login" }>;
}

export interface RpcServerOptions {
  /** The page's RPC token (plan §3.1). */
  token: string;
  /** The API's own token for the login form's calls (PR 15); null: the
   *  container has none, and every call is refused. */
  apiToken?: string | null;
  generations: GenerationStore;
  handlers: RpcHandlers;
  pingMs?: number;
  linkLossMs?: number;
  helloTimeoutMs?: number;
  maxMessageBytes?: number;
  log?: Logger;
}

interface Conn {
  ws: WsConnection;
  greeted: boolean;
  generation: number;
  engineMinor: number;
  /** The API's connection of the login form (its first message a call). */
  api: boolean;
}

const CLOSE_PROTOCOL = 1008;
const CLOSE_REFUSED = 4001;
const CLOSE_SUPERSEDED = 4002;
const CLOSE_LINK_LOST = 4003;
/** A closed connection's peer gets this long to take what is queued. */
const CLOSE_GRACE_MS = 5000;
/** The API's connections at once: the oldest goes when one more comes. */
const MAX_API_CONNECTIONS = 4;
/** An API connection with no call this long is closed. */
const API_IDLE_MS = 120_000;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant time whatever the lengths: both sides are hashed first. */
export function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected)) && expected.length > 0;
}

export class RpcServer {
  readonly #options: RpcServerOptions;
  readonly #log: Logger;
  readonly #ledger = new CommandLedger();
  /** The page of the last accepted hello. */
  #pageId: number | null = null;
  /** The hand-over of the current generation (plan §4.7): its `quiesced`,
   *  once the earlier generations' work has ended — delivered to every
   *  accepted hello of the generation. */
  #handover: { pageId: number; generation: number; previousGeneration: number; done: Promise<{ lastSendMono: number | null; lastSendWall: number | null }> } | null = null;
  #server: Server | null = null;
  #active: Conn | null = null;
  /** The protocol minor of the last engine whose hello was accepted. */
  #engineMinor = 0;
  /** Changes with the active connection. */
  #epoch = 0;
  /** Waits on the active connection's queue: woken when it changes. */
  readonly #drainWaiters = new Set<() => void>();
  #lastHeard = 0;
  #pingN = 0;
  #pingMs: number;
  #linkLossMs: number;
  #timer: NodeJS.Timeout | null = null;
  #lastPingAt = 0;
  /** The API's connections, with when each was last heard. */
  readonly #apiConns = new Map<Conn, number>();

  constructor(options: RpcServerOptions) {
    this.#options = options;
    this.#log = options.log ?? makeLog("rpc");
    this.#pingMs = options.pingMs ?? 1000;
    this.#linkLossMs = options.linkLossMs ?? 5000;
  }

  /** The highest generation accepted for the page of the last accepted
   *  hello (0: none yet). An engine that disconnects does not lower it. */
  get generation(): number {
    return this.#pageId === null ? 0 : this.#options.generations.current(this.#pageId);
  }

  /** Variant Б: the last accepted engine takes the site's traffic observed
   *  (protocol minor 4 on), not admitted — it holds through a brief loss of
   *  its link. */
  get engineObserves(): boolean {
    return this.#engineMinor >= 4;
  }

  /** The engine is connected and was heard within the link-loss time. */
  get linkUp(): boolean {
    return this.#active !== null && !this.#active.ws.closed && monoMs() - this.#lastHeard <= this.#linkLossMs;
  }

  /** The engine's ping and link-loss times (from its hello). */
  setTiming(pingMs: number, linkLossMs: number): void {
    this.#pingMs = pingMs;
    this.#linkLossMs = linkLossMs;
  }

  /** Changes whenever the engine's connection does (a hello, a loss): work
   *  begun for one connection stops when it changes. */
  get epoch(): number {
    return this.#epoch;
  }

  /** Bytes queued for the engine and not yet handed to its socket (0 with
   *  no engine connected). */
  backlog(): number {
    const conn = this.#active;
    return conn && !conn.ws.closed ? conn.ws.socket.writableLength : 0;
  }

  /** Settles once the connection's queue has drained, or it is gone, or
   *  another connection took its place. */
  drained(): Promise<void> {
    const conn = this.#active;
    if (!conn || conn.ws.closed || !conn.ws.socket.writableNeedDrain) return Promise.resolve();
    const socket = conn.ws.socket;
    return new Promise((resolve) => {
      const done = () => {
        socket.off("drain", done);
        socket.off("close", done);
        this.#drainWaiters.delete(done);
        resolve();
      };
      socket.once("drain", done);
      socket.once("close", done);
      this.#drainWaiters.add(done);
    });
  }

  /** The engine's connection breaks the protocol (as the operator sees it,
   *  e.g. more asked than it keeps): closed, the engine connects again. */
  protocolError(error: string): void {
    const conn = this.#active;
    if (conn) this.#protocolError(conn, error);
  }

  #setActive(conn: Conn | null): void {
    if (this.#active === conn) return;
    this.#active = conn;
    this.#epoch += 1;
    for (const wake of [...this.#drainWaiters]) wake();
  }

  /** Closes a connection; one whose peer does not take the close (it stopped
   *  reading) is destroyed after a grace. */
  #close(conn: Conn, code: number): void {
    conn.ws.close(code);
    setTimeout(() => conn.ws.destroy("closed, its peer did not take it"), CLOSE_GRACE_MS).unref();
  }

  /** To the engine, when one is connected. */
  send(message: OperatorToEngine): boolean {
    const conn = this.#active;
    if (!conn || conn.ws.closed) return false;
    // Older engines parse operator messages strictly. Keep their legacy
    // timeout/late-result path instead of breaking the link on a new type.
    if (message.type === "admissionCancel" && conn.engineMinor < 2) return false;
    // Variant Б's observations exist from minor 4 on; an older engine admits
    // and counts nothing of them (and would break the link on the type).
    if ((message.type === "siteSent" || message.type === "siteEnded" || message.type === "siteIdentity") && conn.engineMinor < 4) return false;
    return conn.ws.sendText(JSON.stringify(message));
  }

  /** A message already serialized (an event batch, a stored outcome): true
   *  when an engine is connected to take it — queued, maybe not written yet. */
  sendRaw(json: string): boolean {
    const conn = this.#active;
    if (!conn || conn.ws.closed) return false;
    conn.ws.sendText(json);
    return true;
  }

  /** A binary frame (a body's part, plan §4.13): true when an engine is
   *  connected to take it — queued, maybe not written yet. */
  sendBinary(frame: Buffer): boolean {
    const conn = this.#active;
    if (!conn || conn.ws.closed) return false;
    conn.ws.sendBinary(frame);
    return true;
  }

  listen(port: number, host = "0.0.0.0"): Promise<number> {
    const server = createServer((_req, res) => res.writeHead(404, { "content-length": "0" }).end());
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on("error", () => undefined);
      if ((req.url ?? "").split("?")[0] !== "/rpc") {
        socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const ws = acceptWebSocket(req, socket, head, this.#options.maxMessageBytes ?? 1024 * 1024);
      if (ws) this.#adopt(ws);
    });
    this.#server = server;
    this.#timer = setInterval(() => this.#tick(), 100);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#active?.ws.destroy("the operator stops");
    this.#setActive(null);
    for (const conn of this.#apiConns.keys()) conn.ws.destroy("the operator stops");
    this.#apiConns.clear();
    const server = this.#server;
    this.#server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  #tick(): void {
    const now = monoMs();
    for (const [api, heard] of this.#apiConns) {
      if (api.ws.closed) this.#apiConns.delete(api);
      else if (now - heard > API_IDLE_MS) {
        this.#apiConns.delete(api);
        this.#close(api, 1000);
      }
    }
    const conn = this.#active;
    if (!conn || conn.ws.closed) return;
    if (now - this.#lastHeard > this.#linkLossMs) {
      this.#log("link.lost", { silentMs: Math.round(now - this.#lastHeard), generation: conn.generation });
      this.#drop(conn, CLOSE_LINK_LOST, `nothing from the engine for ${Math.round(now - this.#lastHeard)} ms`);
      return;
    }
    if (now - this.#lastPingAt >= this.#pingMs) {
      this.#lastPingAt = now;
      conn.ws.sendText(JSON.stringify({ type: "ping", n: ++this.#pingN }));
    }
  }

  /** Close a connection; the active one takes the link down with it. */
  #drop(conn: Conn, code: number, reason: string): void {
    const wasActive = this.#active === conn;
    if (wasActive) this.#setActive(null);
    this.#close(conn, code);
    if (wasActive) this.#options.handlers.onLink(false, reason);
  }

  #adopt(ws: WsConnection): void {
    const conn: Conn = { ws, greeted: false, generation: 0, engineMinor: 0, api: false };
    const helloTimer = setTimeout(() => {
      if (!conn.greeted) ws.close(CLOSE_PROTOCOL);
    }, this.#options.helloTimeoutMs ?? 5000);
    ws.onText = (payload) => {
      let value: unknown;
      try {
        value = JSON.parse(payload.toString("utf8"));
      } catch {
        this.#protocolError(conn, "not JSON");
        return;
      }
      if (conn.api) {
        this.#onLoginCall(conn, value);
        return;
      }
      if (!conn.greeted) {
        clearTimeout(helloTimer);
        const type = (value as { type?: unknown } | null)?.type;
        if (typeof type === "string" && type.startsWith("login.")) {
          // The API's connection: the login form's calls, nothing else.
          conn.greeted = true;
          conn.api = true;
          this.#adoptApi(conn);
          this.#onLoginCall(conn, value);
          return;
        }
        this.#onHello(conn, value);
        return;
      }
      this.#onMessage(conn, value);
    };
    ws.onBinary = () => this.#protocolError(conn, conn.api ? "a binary frame from the API" : "a binary frame from the engine");
    ws.onClose = (reason) => {
      clearTimeout(helloTimer);
      if (conn.api) {
        this.#apiConns.delete(conn);
        return;
      }
      if (this.#active !== conn) return;
      this.#setActive(null);
      this.#log("link.closed", { reason, generation: conn.generation });
      this.#options.handlers.onLink(false, `the connection closed (${reason})`);
    };
  }

  #protocolError(conn: Conn, error: string): void {
    if (conn.api) {
      this.#log("login.protocol_error", { error });
      this.#apiConns.delete(conn);
      this.#close(conn, CLOSE_PROTOCOL);
      return;
    }
    this.#log("protocol.error", { error, generation: conn.generation });
    this.#drop(conn, CLOSE_PROTOCOL, `a protocol error: ${error}`);
  }

  // ── the login form's calls (PR 15) ─────────────────────────────────────

  #adoptApi(conn: Conn): void {
    if (this.#apiConns.size >= MAX_API_CONNECTIONS) {
      const oldest = this.#apiConns.keys().next().value!;
      this.#apiConns.delete(oldest);
      this.#close(oldest, 1000);
    }
    this.#apiConns.set(conn, monoMs());
  }

  #onLoginCall(conn: Conn, value: unknown): void {
    if (conn.ws.closed) return;
    this.#apiConns.set(conn, monoMs());
    const raw = (value ?? {}) as { callId?: unknown; token?: unknown };
    const callId = typeof raw.callId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(raw.callId) ? raw.callId : "";
    // The token before anything else, as the engine's hello.
    const expected = this.#options.apiToken ?? null;
    if (expected === null || typeof raw.token !== "string" || !tokenMatches(raw.token, expected)) {
      this.#log("login.refused", { reason: "token", callId });
      conn.ws.sendText(JSON.stringify({ type: "login.refused", callId, reason: "token" } satisfies LoginReply));
      this.#apiConns.delete(conn);
      this.#close(conn, CLOSE_REFUSED);
      return;
    }
    const parsed = parseLoginRequest(value);
    if (!parsed.ok) {
      this.#protocolError(conn, parsed.error);
      return;
    }
    const request = parsed.request;
    this.#log("login.call", { type: request.type, callId: request.callId });
    const handler = this.#options.handlers.onLogin;
    const outcome = handler ? handler(request) : Promise.resolve({ kind: "refused" as const, reason: "not_manual_login" as const });
    void outcome.then(
      (done) => this.#answerLogin(conn, request, done),
      (error: unknown) => {
        this.#log("login.failed", { type: request.type, callId: request.callId, error: errorMessage(error) });
        this.#answerLogin(conn, request, { kind: "refused", reason: "screen_changed" });
      },
    );
  }

  #answerLogin(conn: Conn, request: LoginRequest, outcome: LoginOutcome | { kind: "refused"; reason: "not_manual_login" }): void {
    if (conn.ws.closed) return;
    const callId = request.callId;
    let reply: LoginReply;
    switch (outcome.kind) {
      case "refused":
        reply = { type: "login.refused", callId, reason: outcome.reason };
        break;
      case "state":
        reply = { type: "login.stateResult", callId, screen: outcome.screen, screenVersion: outcome.screenVersion, fields: outcome.fields, siteError: outcome.siteError, ...(outcome.codeFrom === "email" ? { codeFrom: "email" as const } : {}) };
        break;
      case "screenshot": {
        const bodyId = randomUUID();
        const jpeg = outcome.jpeg;
        const parts = Math.max(1, Math.ceil(jpeg.length / BODY_PART_BYTES));
        for (let part = 0; part < parts; part++) {
          conn.ws.sendBinary(encodeBodyFrame(bodyId, part, part === parts - 1, jpeg.subarray(part * BODY_PART_BYTES, (part + 1) * BODY_PART_BYTES)));
        }
        reply = { type: "login.screenshotResult", callId, jpeg: { bodyId, decodedBytes: jpeg.length, sha256: createHash("sha256").update(jpeg).digest("hex") } };
        break;
      }
    }
    conn.ws.sendText(JSON.stringify(reply));
    this.#log("login.answered", { type: request.type, callId, answer: reply.type, ...(reply.type === "login.refused" ? { reason: reply.reason } : {}), ...(reply.type === "login.stateResult" ? { screen: reply.screen } : {}) });
  }

  #refuseHello(conn: Conn, reason: "token" | "protocol_major" | "generation_stale"): void {
    const answer: HelloResult = { type: "helloResult", ok: false, reason, supportedMajors: [...SUPPORTED_MAJORS] };
    conn.ws.sendText(JSON.stringify(answer));
    conn.ws.close(CLOSE_REFUSED);
  }

  #onHello(conn: Conn, value: unknown): void {
    const raw = (value ?? {}) as { type?: unknown; token?: unknown };
    if (raw.type !== "hello") return this.#protocolError(conn, "the first message is not hello");
    // The token before anything else: nothing about the rest is said to a
    // peer that does not have it.
    if (typeof raw.token !== "string" || !tokenMatches(raw.token, this.#options.token)) {
      this.#log("hello.refused", { reason: "token" });
      return this.#refuseHello(conn, "token");
    }
    const parsed = parseEngineValue(value);
    if (!parsed.ok || parsed.message.type !== "hello") return this.#protocolError(conn, parsed.ok ? "not a hello" : parsed.error);
    const hello = parsed.message;
    if (!hello.protocol.majors.includes(PROTOCOL.major)) {
      this.#log("hello.refused", { reason: "protocol_major", majors: hello.protocol.majors });
      return this.#refuseHello(conn, "protocol_major");
    }
    const generations = this.#options.generations;
    const previous = generations.current(hello.pageId);
    if (hello.ownerGeneration < previous) {
      this.#log("hello.refused", { reason: "generation_stale", generation: hello.ownerGeneration, current: previous });
      return this.#refuseHello(conn, "generation_stale");
    }
    try {
      generations.raise(hello.pageId, hello.ownerGeneration);
    } catch (error) {
      // An owner the operator cannot remember is not accepted.
      this.#log("hello.unrecorded", { error: errorMessage(error) });
      conn.ws.close(1011);
      return;
    }
    const replaced = this.#active;
    if (replaced && replaced !== conn) {
      this.#log(hello.ownerGeneration > replaced.generation ? "link.superseded" : "link.replaced", { from: replaced.generation, to: hello.ownerGeneration });
      this.#setActive(null);
      this.#close(replaced, CLOSE_SUPERSEDED);
    }
    conn.greeted = true;
    conn.generation = hello.ownerGeneration;
    conn.engineMinor = hello.protocol.minor;
    this.#engineMinor = hello.protocol.minor;
    this.#pageId = hello.pageId;
    this.#setActive(conn);
    this.#lastHeard = monoMs();
    this.#lastPingAt = 0;
    const answer = this.#options.handlers.onHello(hello);
    const result: HelloResult = { type: "helloResult", ok: true, protocol: { major: PROTOCOL.major, minor: PROTOCOL.minor }, bufferId: answer.bufferId, state: answer.state };
    conn.ws.sendText(JSON.stringify(result));
    this.#log("link.up", { generation: conn.generation, superseded: hello.ownerGeneration > previous ? previous : null });
    this.#options.handlers.onLink(true, "hello");
    let handover = this.#handover;
    if (handover === null || handover.pageId !== hello.pageId || handover.generation !== hello.ownerGeneration) {
      // A new generation — or one this operator remembers but whose
      // hand-over it does not know (it started again): what came before ends.
      handover = { pageId: hello.pageId, generation: hello.ownerGeneration, previousGeneration: previous, done: this.#options.handlers.quiesce(previous) };
      this.#handover = handover;
    }
    const current = handover;
    void current.done.then(
      (last) => {
        if (this.#active !== conn) return;
        conn.ws.sendText(JSON.stringify({ type: "quiesced", previousGeneration: current.previousGeneration, lastSendMono: last.lastSendMono, lastSendWall: last.lastSendWall }));
      },
      (error: unknown) => {
        // Asked again by the next hello of the generation.
        if (this.#handover === current) this.#handover = null;
        this.#log("quiesce.failed", { error: errorMessage(error) });
      },
    );
  }

  #onMessage(conn: Conn, value: unknown): void {
    if (this.#active !== conn) return; // superseded meanwhile
    const parsed = parseEngineValue(value);
    if (!parsed.ok) return this.#protocolError(conn, parsed.error);
    const message = parsed.message;
    if (message.type === "hello") return this.#protocolError(conn, "a second hello");
    if (message.ownerGeneration !== conn.generation) {
      if (message.ownerGeneration > conn.generation) return this.#protocolError(conn, "a new generation without a hello");
      this.#log("message.stale", { type: message.type, generation: message.ownerGeneration, current: conn.generation });
      if (message.type === "command") conn.ws.sendText(JSON.stringify({ type: "commandResult", commandId: message.commandId, ok: false, detail: "generation_stale" }));
      // Answered with its refusal (hub-requests/), never carried out.
      if (message.type === "send") this.#options.handlers.onHub?.(message);
      return;
    }
    switch (message.type) {
      case "ping":
        this.#lastHeard = monoMs();
        conn.ws.sendText(JSON.stringify({ type: "pong", n: message.n }));
        return;
      case "pong":
        this.#lastHeard = monoMs();
        return;
      case "command":
        this.#lastHeard = monoMs();
        this.#onCommand(message);
        return;
      case "events.subscribe":
      case "ack":
      case "resultAck":
      case "recover":
        this.#lastHeard = monoMs();
        this.#options.handlers.onBuffer(message);
        return;
      case "send":
      case "checkResult":
        this.#lastHeard = monoMs();
        this.#options.handlers.onHub?.(message);
        return;
      case "wsAdmitResult":
        this.#lastHeard = monoMs();
        this.#options.handlers.onSocket?.(message);
        return;
      case "siteAdmitResult":
        this.#lastHeard = monoMs();
        this.#options.handlers.onSite?.(message);
        return;
    }
  }

  #onCommand(command: Command): void {
    const { outcome, repeat } = this.#ledger.run(command.commandId, async () => {
      if (monoMs() > command.notAfterMono) return { ok: false, detail: "expired" };
      return this.#options.handlers.onCommand(command);
    });
    this.#log(repeat ? "command.repeat" : "command", { commandId: command.commandId, kind: command.command.kind });
    void outcome.then((result) => {
      this.send({ type: "commandResult", commandId: command.commandId, ok: result.ok, detail: result.detail });
      this.#log("command.done", { commandId: command.commandId, kind: command.command.kind, ok: result.ok, detail: result.detail });
    });
  }
}
