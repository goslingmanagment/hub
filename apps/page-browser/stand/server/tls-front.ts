// The stand's HTTP front: TCP listeners on :443 (TLS, ALPN h2 / http/1.1) and
// :80 (plain HTTP/1.1). Life of a :443 connection:
//
//   accept (paused) → tcp.accept → [tcpDelay: ClientHello left unread]
//   → read the ClientHello → tls.hello → [tlsStall: ClientHello held]
//   → new tls.TLSSocket(raw) → tls.secure / tls.error
//   → ALPN h2  → h2server.emit("connection", tlsSocket) → one exchange per stream
//     otherwise → h1server.emit("connection", tlsSocket) → one exchange per request
//   … → tcp.close {bytesIn, bytesOut}
//
// Hand-off detail: Node's Http2Session waits for "secureConnect" while
// `socket.secureConnecting` is true, and a server-side TLSSocket made outside
// tls.Server keeps it true forever (tls.Server clears it before
// "secureConnection"). So the front clears it before handing the socket to
// the h2 server; without that the session never starts. http.Server needs nothing.

import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { errorText, isLoopback, plainAddress } from "./conn.ts";
import type { ConnInfo } from "./conn.ts";
import { H1Exchange, H1UpgradeExchange, H2Exchange } from "./exchange.ts";
import type { ExchangeInit } from "./exchange.ts";
import type { Fault, FaultStore } from "./faults.ts";
import { mono } from "./journal.ts";
import type { Journal } from "./journal.ts";
import type { Router } from "./routes.ts";
import { parseClientHello } from "./tls-hello.ts";
import type { ClientHelloInfo } from "./tls-hello.ts";

export interface FrontOptions {
  journal: Journal;
  faults: FaultStore;
  router: Router;
  secureContext: tls.SecureContext;
  /** ALPN protocols to offer for a ClientHello's SNI, in preference order. */
  alpnFor: (servername: string | null) => string[];
  /** Idle time before the server closes a keep-alive HTTP/1.1 connection. */
  keepAliveTimeoutMs: number;
}

/** A ClientHello larger than this is not waited for (handed to TLS as is). */
const HELLO_READ_LIMIT = 64 * 1024;

export class Front {
  readonly conns = new Map<number, ConnInfo>();
  readonly h1: http.Server;
  readonly h2: http2.Http2Server;
  #opts: FrontOptions;
  #nextConnId = 1;
  /** TLS socket (or the raw socket on :80) → connection. */
  #bySocket = new WeakMap<object, ConnInfo>();
  #bySession = new WeakMap<object, ConnInfo>();
  /** Set only while h2.emit("connection") runs; "session" fires synchronously inside it. */
  #pendingH2: ConnInfo | null = null;
  /** Local port of a SOCKS5 upstream socket → its socksId (see registerSocksUpstream). */
  #socksByLocalPort = new Map<number, number>();

  constructor(opts: FrontOptions) {
    this.#opts = opts;

    this.h1 = http.createServer();
    this.h1.keepAliveTimeout = opts.keepAliveTimeoutMs;
    this.h1.on("request", (req, res) => this.#onH1Request(req, res));
    this.h1.on("upgrade", (req, socket, head) => this.#onH1Upgrade(req, socket, head));
    // CONNECT has its own event; without a listener Node would drop the socket unjournaled.
    this.h1.on("connect", (req, socket, head) => this.#onH1Upgrade(req, socket, head));
    this.h1.on("clientError", (err: NodeJS.ErrnoException, socket: Duplex) => this.#onH1ClientError(err, socket));

    this.h2 = http2.createServer({ settings: { enableConnectProtocol: true } });
    this.h2.on("session", (session) => this.#onH2Session(session));
    this.h2.on("stream", (stream, headers, _flags, rawHeaders) => this.#onH2Stream(stream, headers, rawHeaders));
  }

  /** Listen on `port`: TLS front when `withTls`, else plain HTTP/1.1. */
  listen(port: number, withTls: boolean): Promise<net.Server> {
    const server = net.createServer({ pauseOnConnect: withTls }, (raw) => {
      if (withTls) this.#acceptTls(raw, port);
      else this.#acceptPlain(raw, port);
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  }

  /**
   * The SOCKS5 server connects to this front over loopback; it registers the
   * upstream socket's local port before the connection can be accepted, so
   * `tcp.accept` can name the tunnel (`socksId`).
   */
  registerSocksUpstream(localPort: number, socksId: number): void {
    this.#socksByLocalPort.set(localPort, socksId);
  }

  unregisterSocksUpstream(localPort: number): void {
    this.#socksByLocalPort.delete(localPort);
  }

  listConns(): Array<Record<string, unknown>> {
    return [...this.conns.values()].map((c) => ({
      connId: c.connId,
      port: c.port,
      tls: c.tls,
      remote: c.remote,
      socksId: c.socksId,
      servername: c.servername,
      alpn: c.alpn,
      proto: c.proto,
      requests: c.requests,
      maxStreamId: c.maxStreamId,
      goawayLastStreamId: c.goawayLastStreamId,
      openedMono: c.openedMono,
    }));
  }

  // ------------------------------------------------------------- TCP

  #newConn(raw: net.Socket, port: number, withTls: boolean): ConnInfo {
    const { journal } = this.#opts;
    const remotePort = raw.remotePort ?? 0;
    let socksId: number | null = null;
    if (isLoopback(raw.remoteAddress)) {
      socksId = this.#socksByLocalPort.get(remotePort) ?? null;
      this.#socksByLocalPort.delete(remotePort);
    }
    const conn: ConnInfo = {
      connId: this.#nextConnId++,
      port,
      tls: withTls,
      remote: `${plainAddress(raw.remoteAddress)}:${remotePort}`,
      socksId,
      openedMono: 0,
      raw,
      tlsSocket: null,
      servername: null,
      alpn: null,
      proto: null,
      requests: 0,
      maxStreamId: 0,
      goawayLastStreamId: null,
      error: null,
      closed: false,
    };
    this.conns.set(conn.connId, conn);
    this.#bySocket.set(raw, conn);
    conn.openedMono = journal.log("tcp.accept", {
      connId: conn.connId, port, tls: withTls, remote: conn.remote, socksId,
    }).mono;
    raw.on("error", (err) => {
      conn.error ??= errorText(err);
    });
    raw.on("close", () => {
      conn.closed = true;
      this.conns.delete(conn.connId);
      // On a TLS connection these are raw TCP byte counts (TLS records included).
      journal.log("tcp.close", {
        connId: conn.connId,
        bytesIn: raw.bytesRead,
        bytesOut: raw.bytesWritten ?? 0,
        requests: conn.requests,
        ms: round(mono() - conn.openedMono),
        error: conn.error,
      });
    });
    return conn;
  }

  #acceptPlain(raw: net.Socket, port: number): void {
    const conn = this.#newConn(raw, port, false);
    conn.proto = "h1";
    this.h1.emit("connection", raw);
  }

  #acceptTls(raw: net.Socket, port: number): void {
    const conn = this.#newConn(raw, port, true);
    const delay = this.#opts.faults.take("tcpDelay", {});
    if (delay) {
      // The socket was accepted paused: the ClientHello waits in the kernel.
      this.#journalFault(delay, conn);
      setTimeout(() => this.#readHello(conn), delay.ms ?? 0);
    } else {
      this.#readHello(conn);
    }
  }

  // ------------------------------------------------------------- TLS

  /** Read until the ClientHello is complete, then put the bytes back for TLS. */
  #readHello(conn: ConnInfo): void {
    const raw = conn.raw;
    if (raw.destroyed) return;
    let buffered: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const hello = parseClientHello(buffered);
      if (hello.status === "incomplete" && buffered.length < HELLO_READ_LIMIT) return;
      raw.off("data", onData);
      raw.pause();
      raw.unshift(buffered);
      this.#onHello(conn, hello);
    };
    raw.on("data", onData);
    raw.resume();
  }

  #onHello(conn: ConnInfo, hello: ClientHelloInfo): void {
    if (hello.status === "ok") {
      conn.servername = hello.servername;
      this.#opts.journal.log("tls.hello", { connId: conn.connId, servername: hello.servername, alpn: hello.alpn });
    }
    const stall = this.#opts.faults.take("tlsStall", { host: conn.servername });
    if (stall) {
      // The ClientHello has been read (and journaled) but the TLS engine does
      // not see it until the stall ends: no ServerHello meanwhile.
      this.#journalFault(stall, conn);
      setTimeout(() => this.#startTls(conn), stall.ms ?? 0);
    } else {
      this.#startTls(conn);
    }
  }

  #startTls(conn: ConnInfo): void {
    const raw = conn.raw;
    if (raw.destroyed) return;
    // The TLS socket takes over the TCP handle; bytes put back with unshift()
    // are fed to it first (TLSSocket's initRead).
    const tlsSocket = new tls.TLSSocket(raw, {
      isServer: true,
      secureContext: this.#opts.secureContext,
      ALPNProtocols: this.#opts.alpnFor(conn.servername),
    });
    conn.tlsSocket = tlsSocket;
    this.#bySocket.set(tlsSocket, conn);
    let secure = false;
    tlsSocket.on("secure", () => {
      secure = true;
      this.#onSecure(conn, tlsSocket);
    });
    tlsSocket.on("error", (err) => {
      if (!secure) this.#opts.journal.log("tls.error", { connId: conn.connId, error: errorText(err) });
      conn.error ??= errorText(err);
    });
  }

  #onSecure(conn: ConnInfo, tlsSocket: tls.TLSSocket): void {
    conn.alpn = tlsSocket.alpnProtocol || null;
    const sni = (tlsSocket as unknown as { servername?: unknown }).servername;
    if (typeof sni === "string" && sni) conn.servername = sni;
    this.#opts.journal.log("tls.secure", {
      connId: conn.connId,
      alpn: conn.alpn,
      servername: conn.servername,
      version: tlsSocket.getProtocol(),
      resumed: tlsSocket.isSessionReused(),
    });
    if (conn.alpn === "h2") {
      conn.proto = "h2";
      (tlsSocket as unknown as { secureConnecting: boolean }).secureConnecting = false;
      this.#pendingH2 = conn;
      try {
        this.h2.emit("connection", tlsSocket);
      } finally {
        this.#pendingH2 = null;
      }
    } else {
      conn.proto = "h1";
      this.h1.emit("connection", tlsSocket);
    }
  }

  // ------------------------------------------------------------- HTTP/1.1

  #onH1Request(req: http.IncomingMessage, res: http.ServerResponse): void {
    const conn = this.#bySocket.get(req.socket);
    if (!conn) {
      req.socket.destroy();
      return;
    }
    conn.requests += 1;
    const init = this.#init(conn, "h1", null, req.method ?? "GET", req.url ?? "/", req.headers.host ?? "", req.rawHeaders, false);
    const ex = new H1Exchange(init, req, res);
    ex.journalRequest();
    this.#opts.router.handle(ex);
  }

  /** Upgrade (WebSocket or other) and CONNECT requests: Node hands over the socket. */
  #onH1Upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const conn = this.#bySocket.get(socket);
    if (!conn) {
      socket.destroy();
      return;
    }
    conn.requests += 1;
    socket.on("error", (err) => {
      conn.error ??= errorText(err);
    });
    const isWebSocket = req.method !== "CONNECT" && /\bwebsocket\b/i.test(req.headers.upgrade ?? "");
    const init = this.#init(conn, "h1", null, req.method ?? "GET", req.url ?? "/", req.headers.host ?? "", req.rawHeaders, isWebSocket);
    const ex = new H1UpgradeExchange(init, socket as net.Socket, head);
    ex.journalRequest();
    this.#opts.router.handle(ex);
  }

  #onH1ClientError(err: NodeJS.ErrnoException, socket: Duplex): void {
    const conn = this.#bySocket.get(socket);
    // A peer reset is reported by tcp.close; anything else (unparsable
    // request, header/request timeout) is journaled here.
    if (err.code !== "ECONNRESET") {
      this.#opts.journal.log("h1.error", { connId: conn?.connId ?? null, code: err.code ?? null, error: err.message });
    }
    if (err.code === "ECONNRESET" || !socket.writable) {
      socket.destroy();
      return;
    }
    const status = err.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request";
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  // ------------------------------------------------------------- HTTP/2

  #onH2Session(session: http2.ServerHttp2Session): void {
    const conn = this.#pendingH2;
    if (!conn) {
      session.destroy();
      return;
    }
    const { journal } = this.#opts;
    this.#bySession.set(session, conn);
    session.on("goaway", (code: number, lastStreamId: number) => {
      journal.log("h2.goaway", { connId: conn.connId, lastStreamId, code, by: "client" });
    });
    session.on("frameError", (frameType: number, code: number, streamId: number) => {
      journal.log("h2.frameError", { connId: conn.connId, frameType, code, streamId });
    });
    session.on("error", (err: Error) => {
      journal.log("h2.error", { connId: conn.connId, error: errorText(err) });
      conn.error ??= errorText(err);
    });
  }

  #onH2Stream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, rawHeaders: string[] | undefined): void {
    const session = stream.session as http2.ServerHttp2Session | undefined;
    const conn = session ? this.#bySession.get(session) : undefined;
    if (!conn || !session) {
      stream.on("error", () => {});
      stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      return;
    }
    conn.requests += 1;
    conn.maxStreamId = Math.max(conn.maxStreamId, stream.id ?? 0);
    const method = String(headers[":method"] ?? "GET");
    const isWebSocket = method === "CONNECT" && headers[":protocol"] === "websocket";
    const target = String(headers[":path"] ?? "");
    const host = String(headers[":authority"] ?? headers.host ?? "");
    const init = this.#init(conn, "h2", stream.id ?? null, method, target, host, rawHeaders ?? flattenHeaders(headers), isWebSocket);
    const ex = new H2Exchange(init, stream, session);
    ex.journalRequest();
    this.#opts.router.handle(ex);
  }

  // ------------------------------------------------------------- helpers

  #init(
    conn: ConnInfo,
    proto: "h1" | "h2",
    streamId: number | null,
    method: string,
    target: string,
    hostHeader: string,
    rawHeaders: string[],
    isWebSocket: boolean,
  ): ExchangeInit {
    return { proto, conn, streamId, method, target, hostHeader, rawHeaders, isWebSocket, journal: this.#opts.journal };
  }

  #journalFault(fault: Fault, conn: ConnInfo): void {
    this.#opts.journal.log("fault", {
      faultId: fault.id,
      kind: fault.kind,
      connId: conn.connId,
      streamId: null,
      rid: null,
      ...(fault.ms !== null ? { ms: fault.ms } : {}),
      ...(conn.servername ? { servername: conn.servername } : {}),
    });
  }
}

function flattenHeaders(headers: http2.IncomingHttpHeaders): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined) out.push(name, String(one));
  }
  return out;
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
