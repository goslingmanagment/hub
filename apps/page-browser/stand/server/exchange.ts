// One HTTP request/response with the same shape for HTTP/1.1 and HTTP/2, so
// the fault logic and the per-host handlers do not care about the protocol.
//
//   H1Exchange        — a normal HTTP/1.1 request (http.Server "request")
//   H1UpgradeExchange — an HTTP/1.1 request with Upgrade (http.Server "upgrade");
//                       the answer is written by hand on the socket
//   H2Exchange        — one HTTP/2 stream (incl. RFC 8441 extended CONNECT)
//
// Each exchange journals `req` when created (before any fault or answer) and
// exactly one `res` when it ends, completed or not.

import http from "node:http";
import http2 from "node:http2";
import type { Duplex, Readable } from "node:stream";
import type { EventEmitter } from "node:events";
import type net from "node:net";
import type { ConnInfo } from "./conn.ts";
import { mono } from "./journal.ts";
import type { Journal } from "./journal.ts";
import { acceptKey } from "./ws-codec.ts";

export type OutHeaders = Record<string, string | string[]>;

const EMPTY = Buffer.alloc(0);
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface ExchangeInit {
  proto: "h1" | "h2";
  conn: ConnInfo;
  streamId: number | null;
  method: string;
  /** Request target as received: origin-form path+query, absolute-form URL, or "*". */
  target: string;
  /** :authority or Host as received (may carry a port). */
  hostHeader: string;
  /** Flat [name, value, name, value, …] exactly as received, pseudo-headers included. */
  rawHeaders: string[];
  isWebSocket: boolean;
  journal: Journal;
}

export class Exchange {
  readonly proto: "h1" | "h2";
  readonly conn: ConnInfo;
  readonly streamId: number | null;
  readonly method: string;
  /** Host without port, lower case. */
  readonly authority: string;
  /** Path with query (as received for origin-form targets). */
  readonly path: string;
  readonly url: URL;
  readonly rid: string | null;
  /** Lower-cased header names; repeated headers joined with ", " ("; " for cookie). */
  readonly headers: Record<string, string>;
  readonly rawHeaderPairs: Array<[string, string]>;
  readonly nthOnConn: number;
  readonly reused: boolean;
  readonly isWebSocket: boolean;
  /** seq and mono of this exchange's `req` journal event. */
  reqSeq = 0;
  reqMono = 0;
  status: number | null = null;
  headersSent = false;
  /** The response was ended by the server. */
  finished = false;
  /** The exchange is over: response complete, or the client/connection went away. */
  closed = false;
  bodyBytesOut = 0;
  /** Close the connection once this response is complete (closeAfterResponse fault). */
  closeAfterResponse = false;
  /** Set when a fault ended the exchange; reported in `res`. */
  fault: string | null = null;
  protected journal: Journal;
  #bodyRead: Promise<number> | null = null;
  #closeWaiters = new Set<() => void>();

  constructor(init: ExchangeInit) {
    this.proto = init.proto;
    this.conn = init.conn;
    this.streamId = init.streamId;
    this.method = init.method.toUpperCase();
    this.journal = init.journal;
    this.isWebSocket = init.isWebSocket;
    this.nthOnConn = init.conn.requests;
    this.reused = init.conn.requests > 1;

    const pairs: Array<[string, string]> = [];
    for (let i = 0; i + 1 < init.rawHeaders.length; i += 2) pairs.push([init.rawHeaders[i]!, init.rawHeaders[i + 1]!]);
    this.rawHeaderPairs = pairs;
    const headers: Record<string, string> = {};
    for (const [name, value] of pairs) {
      const key = name.toLowerCase();
      if (key.startsWith(":")) continue;
      headers[key] = key in headers ? headers[key] + (key === "cookie" ? "; " : ", ") + value : value;
    }
    this.headers = headers;

    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(init.target);
    let url: URL;
    try {
      url = new URL(init.target, `https://${hostOnly(init.hostHeader) || "unknown.invalid"}`);
    } catch {
      url = new URL("https://unknown.invalid/");
    }
    this.url = url;
    this.authority = absolute ? hostOnly(url.host) : hostOnly(init.hostHeader);
    this.path = absolute ? url.pathname + url.search : init.target;
    this.rid = url.searchParams.get("rid");
  }

  /** Record the `req` event; called by the front before anything else happens. */
  journalRequest(): void {
    const event = this.journal.log("req", {
      connId: this.conn.connId,
      proto: this.proto,
      streamId: this.streamId,
      method: this.method,
      authority: this.authority,
      path: this.path,
      rid: this.rid,
      headers: this.rawHeaderPairs,
      reused: this.reused,
      nthOnConn: this.nthOnConn,
      ws: this.isWebSocket,
    });
    this.reqSeq = event.seq;
    this.reqMono = event.mono;
  }

  // ---- protocol primitives, overridden by the subclasses ----

  protected doSendHeaders(_status: number, _headers: OutHeaders, _endStream: boolean): void {
    throw new Error("not implemented");
  }
  protected doWrite(_chunk: Buffer): boolean {
    throw new Error("not implemented");
  }
  protected doEnd(_chunk?: Buffer): void {
    throw new Error("not implemented");
  }
  /** Emits "drain" when doWrite() returned false. */
  protected drainTarget(): EventEmitter {
    throw new Error("not implemented");
  }
  /** Where the request body comes from; null when there is none. */
  protected bodySource(): Readable | null {
    return null;
  }
  /** Close the connection after a complete response (closeAfterResponse). */
  closeConnection(): void {
    throw new Error("not implemented");
  }
  /** Accept a WebSocket handshake; returns the byte stream and bytes already read. */
  acceptWebSocket(_protocol: string | null): { duplex: Duplex; head: Buffer } {
    throw new Error("not a WebSocket exchange");
  }

  // ---- response API used by the handlers ----

  /** Send the status line / HEADERS frame. `endStream` = no body follows. */
  sendHeaders(status: number, headers: OutHeaders, endStream = false): void {
    if (this.closed || this.headersSent) return;
    this.headersSent = true;
    this.status = status;
    if (endStream) this.finished = true;
    this.doSendHeaders(status, headers, endStream);
  }

  /** Write a body chunk; resolves when it is buffered below the high-water mark. */
  async write(chunk: Buffer): Promise<void> {
    if (this.closed || this.finished) return;
    if (!this.headersSent) throw new Error("write() before sendHeaders()");
    this.bodyBytesOut += chunk.length;
    if (this.doWrite(chunk)) return;
    const target = this.drainTarget();
    await new Promise<void>((resolve) => {
      const done = (): void => {
        target.off("drain", done);
        this.#closeWaiters.delete(done);
        resolve();
      };
      target.on("drain", done);
      this.#closeWaiters.add(done);
    });
  }

  end(chunk?: Buffer): void {
    if (this.closed || this.finished) return;
    if (!this.headersSent) throw new Error("end() before sendHeaders()");
    if (chunk) this.bodyBytesOut += chunk.length;
    this.finished = true;
    this.doEnd(chunk);
  }

  /** A complete response with a known body (Content-Length set, HEAD honoured). */
  respond(status: number, headers: OutHeaders, body?: Buffer | string): void {
    if (this.closed || this.headersSent) return;
    const data = body === undefined ? EMPTY : typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const bodyless = status === 204 || status === 304 || status < 200;
    const out: OutHeaders = { ...headers };
    if (!bodyless) out["content-length"] = String(data.length);
    const sendBody = !bodyless && this.method !== "HEAD" && data.length > 0;
    this.sendHeaders(status, out, !sendBody);
    if (sendBody) this.end(data);
  }

  /** Read the whole request body, journal its size (`req.body`), return it. */
  readBody(): Promise<number> {
    if (this.#bodyRead) return this.#bodyRead;
    this.#bodyRead = new Promise<number>((resolve) => {
      const source = this.bodySource();
      if (source === null || source.readableEnded) {
        resolve(0);
        return;
      }
      let bytes = 0;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (bytes > 0 || !BODYLESS_METHODS.has(this.method)) {
          this.journal.log("req.body", { connId: this.conn.connId, streamId: this.streamId, rid: this.rid, bytes });
        }
        resolve(bytes);
      };
      source.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      source.on("end", finish);
      source.on("close", finish);
      source.on("error", finish);
      source.resume();
    });
    return this.#bodyRead;
  }

  /** End of the exchange: journal `res` once, wake up waiters. */
  protected markClosed(complete: boolean, extra: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.closed = true;
    this.journal.log("res", {
      connId: this.conn.connId,
      proto: this.proto,
      streamId: this.streamId,
      rid: this.rid,
      status: this.status,
      bodyBytes: this.bodyBytesOut,
      complete,
      ms: round(mono() - this.reqMono),
      ...(this.fault ? { fault: this.fault } : {}),
      ...extra,
    });
    for (const waiter of [...this.#closeWaiters]) waiter();
    if (complete && this.closeAfterResponse) this.closeConnection();
  }
}

// ---------------------------------------------------------------- HTTP/1.1

export class H1Exchange extends Exchange {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;

  constructor(init: ExchangeInit, req: http.IncomingMessage, res: http.ServerResponse) {
    super(init);
    this.req = req;
    this.res = res;
    res.on("finish", () => this.markClosed(true));
    res.on("close", () => this.markClosed(this.finished && res.writableFinished));
  }

  protected override doSendHeaders(status: number, headers: OutHeaders, endStream: boolean): void {
    // Node closes the socket after a response carrying "Connection: close".
    const out = this.closeAfterResponse ? { ...headers, connection: "close" } : headers;
    this.res.writeHead(status, out);
    if (endStream) this.res.end();
  }
  protected override doWrite(chunk: Buffer): boolean {
    return this.res.write(chunk);
  }
  protected override doEnd(chunk?: Buffer): void {
    if (chunk) this.res.end(chunk);
    else this.res.end();
  }
  protected override drainTarget(): EventEmitter {
    return this.res;
  }
  protected override bodySource(): Readable | null {
    return this.req;
  }
  override closeConnection(): void {
    // Nothing to do: faults are taken before the response starts, so
    // doSendHeaders() already sent "Connection: close" and Node ends the
    // socket once this response is written.
  }
}

/** An HTTP/1.1 request carrying Upgrade; Node hands us the bare socket. */
export class H1UpgradeExchange extends Exchange {
  readonly socket: net.Socket;
  readonly head: Buffer;
  #upgraded = false;

  constructor(init: ExchangeInit, socket: net.Socket, head: Buffer) {
    super(init);
    this.socket = socket;
    this.head = head;
    socket.once("close", () => this.markClosed(this.finished));
  }

  protected override doSendHeaders(status: number, headers: OutHeaders, endStream: boolean): void {
    // Anything but 101 ends the connection: the parser is gone after Upgrade.
    const out = status === 101 ? headers : { ...headers, connection: "close" };
    let head = `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Unknown"}\r\n`;
    for (const [name, value] of Object.entries(out)) {
      for (const one of Array.isArray(value) ? value : [value]) head += `${name}: ${one}\r\n`;
    }
    this.socket.write(head + "\r\n");
    if (endStream) this.#endSocket();
  }
  protected override doWrite(chunk: Buffer): boolean {
    return this.socket.write(chunk);
  }
  protected override doEnd(chunk?: Buffer): void {
    if (chunk) this.socket.write(chunk);
    this.#endSocket();
  }
  protected override drainTarget(): EventEmitter {
    return this.socket;
  }
  override closeConnection(): void {
    this.socket.end();
  }

  override acceptWebSocket(protocol: string | null): { duplex: Duplex; head: Buffer } {
    const headers: OutHeaders = {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-accept": acceptKey(this.headers["sec-websocket-key"] ?? ""),
    };
    if (protocol) headers["sec-websocket-protocol"] = protocol;
    this.sendHeaders(101, headers);
    this.finished = true;
    this.#upgraded = true;
    this.markClosed(true);
    return { duplex: this.socket, head: this.head };
  }

  #endSocket(): void {
    if (this.#upgraded) return;
    this.socket.once("finish", () => this.markClosed(true));
    this.socket.end();
  }
}

// ---------------------------------------------------------------- HTTP/2

const H2_CONNECTION_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);

export class H2Exchange extends Exchange {
  readonly stream: http2.ServerHttp2Stream;
  /** Captured at creation: stream.session is unset once the stream closes. */
  readonly session: http2.ServerHttp2Session;
  /** The server reset this stream (fault); a later rstCode is not the client's doing. */
  serverClosedStream = false;

  constructor(init: ExchangeInit, stream: http2.ServerHttp2Stream, session: http2.ServerHttp2Session) {
    super(init);
    this.stream = stream;
    this.session = session;
    // Stream errors (resets, session teardown) surface as "close" with an
    // rstCode; without a listener they would crash the process.
    stream.on("error", () => {});
    stream.on("close", () => this.#onClose());
  }

  #onClose(): void {
    const code = this.stream.rstCode ?? 0;
    const conn = this.conn;
    const aboveGoaway = conn.goawayLastStreamId !== null && (this.streamId ?? 0) > conn.goawayLastStreamId;
    if (code !== http2.constants.NGHTTP2_NO_ERROR && !this.serverClosedStream && !this.session.destroyed && !aboveGoaway) {
      // Not reset by us, session alive: an RST_STREAM from the client.
      this.journal.log("h2.rst", { connId: conn.connId, streamId: this.streamId, rid: this.rid, code, by: "client" });
    }
    this.markClosed(this.finished && code === http2.constants.NGHTTP2_NO_ERROR, { rstCode: code });
  }

  #usable(): boolean {
    return !this.stream.destroyed && !this.stream.closed;
  }

  protected override doSendHeaders(status: number, headers: OutHeaders, endStream: boolean): void {
    if (!this.#usable()) return;
    const out: http2.OutgoingHttpHeaders = { ":status": status };
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      if (!H2_CONNECTION_HEADERS.has(key)) out[key] = value;
    }
    this.stream.respond(out, { endStream });
  }
  protected override doWrite(chunk: Buffer): boolean {
    if (!this.#usable()) return true;
    return this.stream.write(chunk);
  }
  protected override doEnd(chunk?: Buffer): void {
    if (!this.#usable()) return;
    if (chunk) this.stream.end(chunk);
    else this.stream.end();
  }
  protected override drainTarget(): EventEmitter {
    return this.stream;
  }
  protected override bodySource(): Readable | null {
    return this.isWebSocket ? null : this.stream;
  }

  /** Graceful close: GOAWAY with the last processed stream, then FIN when streams are done. */
  override closeConnection(): void {
    const session = this.session;
    if (session.closed || session.destroyed) return;
    const lastStreamId = this.conn.goawayLastStreamId ?? this.conn.maxStreamId;
    this.journal.log("h2.goaway", {
      connId: this.conn.connId, lastStreamId, code: http2.constants.NGHTTP2_NO_ERROR, by: "server", reason: "closeAfterResponse",
    });
    if (this.conn.goawayLastStreamId === null) this.conn.goawayLastStreamId = lastStreamId;
    session.close();
  }

  override acceptWebSocket(protocol: string | null): { duplex: Duplex; head: Buffer } {
    this.sendHeaders(200, protocol ? { "sec-websocket-protocol": protocol } : {});
    this.finished = true;
    this.markClosed(true);
    return { duplex: this.stream, head: EMPTY };
  }

  /** h2RefusedStream: RST_STREAM(code) without answering. */
  refuseStream(code: number): void {
    this.serverClosedStream = true;
    this.journal.log("h2.rst", { connId: this.conn.connId, streamId: this.streamId, rid: this.rid, code, by: "server" });
    if (this.#usable()) this.stream.close(code);
  }

  /**
   * h2Goaway: GOAWAY whose last-stream-id is below this stream, so the client
   * learns the stream was never processed; the stream is not answered and the
   * session is closed gracefully ~200 ms later.
   *
   * Node cannot send last-stream-id 0 (Http2Session::Goaway replaces any value
   * ≤ 0 with the last processed stream id), so for stream 1 the server sends
   * GOAWAY(last=1) and then RST_STREAM(REFUSED_STREAM) on stream 1; Chrome
   * retries it on a new connection, as it would after GOAWAY(last=0). The
   * order matters: with the RST first, Chrome's retry picks the same session
   * (its GOAWAY is not processed yet) and then fails with
   * ERR_CONNECTION_CLOSED (seen with Chrome 155). Journaled `emulated: true`.
   */
  goawayBelowStream(code: number): void {
    const session = this.session;
    const streamId = this.streamId ?? 1;
    const emulated = streamId <= 2;
    const lastStreamId = emulated ? streamId : streamId - 2;
    this.serverClosedStream = true;
    this.journal.log("h2.goaway", {
      connId: this.conn.connId, lastStreamId, code, by: "server", reason: "h2Goaway", ...(emulated ? { emulated: true } : {}),
    });
    this.conn.goawayLastStreamId = lastStreamId;
    // nghttp2 sends queued GOAWAY and RST_STREAM frames in submission order.
    if (!session.closed && !session.destroyed) session.goaway(code, lastStreamId);
    if (emulated) {
      this.journal.log("h2.rst", {
        connId: this.conn.connId, streamId, rid: this.rid, code: http2.constants.NGHTTP2_REFUSED_STREAM, by: "server", emulated: true,
      });
      if (this.#usable()) this.stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
    }
    setTimeout(() => {
      if (!session.closed && !session.destroyed) session.close();
    }, 200).unref();
  }
}

/** Host without port, lower case, no trailing dot; "[v6]" kept bracketed. */
export function hostOnly(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 0 ? host.slice(0, end + 1) : host;
  }
  const colon = host.lastIndexOf(":");
  return (colon >= 0 ? host.slice(0, colon) : host).replace(/\.$/, "");
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
