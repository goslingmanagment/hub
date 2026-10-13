// The stand's Fansly behind its SOCKS5: one TLS front for every name the
// stand answers to, HTTP/2 and HTTP/1.1, and the site's socket.
//
//   api.ipify.org     the exit-IP service: answers the address the runner set
//   apiv3.fansly.com  the API: every request journaled (method, path, the
//                     run's request id), answered with JSON of the asked size
//   wsv3.fansly.com   the site's socket (HTTP/1.1 Upgrade only): every
//                     handshake and every message from the page journaled;
//                     frames pushed at the runner's rate
//   cdn*.fansly.com   media: bytes of the asked size
//   fansly.com and the rest of *.fansly.com — the site: the stand's page and
//                     the paths the stand's own traffic uses
//
// The journal is the stand's truth: `req` when a request's headers arrived,
// `res` when its answer was written, `ws.open` / `ws.in` / `ws.close` for
// the socket. A request that is in the journal reached "Fansly"; one that is
// not, did not.
//
// The direct listener (the stand's address on the egress network, :443) is
// not a way in: the page container's kernel rules let nothing reach it.
// Whatever connects there came past the operator's proxy, and is journaled as
// that (`direct.connect`) — except the stand's own trust check, which asks
// it on purpose from a container without those rules (stand.sh trust-check).

import { createHash } from "node:crypto";
import { createServer as createHttpServer, ServerResponse, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createServer as createHttp2Server, type Http2Server, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from "node:tls";

import { FANSLY_HOSTS, hostMatches } from "../../src/egress/hosts.ts";
import { cyrb53, FANSLY_CHECK_KEY } from "../../src/hub-requests/session.ts";
import { acceptWebSocket, type WsConnection } from "../../src/shared/ws.ts";
import { IPIFY_HOST } from "../shared.ts";
import type { Journal } from "./journal.ts";
import type { SocksMeta } from "./socks.ts";

export const TRUST_PATH = "/stand/trust";
export const TRUST_MARKER = "pb-suite-stand: trusted";

export type Role = "ipify" | "api" | "ws" | "cdn" | "site";

/** What the stand answers as, by name; null: not a name of the stand. */
export function roleOf(host: string): Role | null {
  if (host === IPIFY_HOST) return "ipify";
  if (FANSLY_HOSTS.api.some((entry) => hostMatches(entry, host))) return "api";
  if (FANSLY_HOSTS.ws.some((entry) => hostMatches(entry, host))) return "ws";
  if (FANSLY_HOSTS.cdn.some((entry) => hostMatches(entry, host))) return "cdn";
  if (host === "fansly.com" || host.endsWith(".fansly.com")) return "site";
  return null;
}

export interface FrontConfig {
  /** What the exit-IP service answers. */
  exitIp: string;
  /** The account the API's `account/me` answers. */
  accountId: string;
  /** Access-Control-Max-Age of the API's preflight answers. */
  corsMaxAge: number;
  /** Frames pushed into every open socket: per minute, and their size. */
  wsPush: { perMinute: number; bytes: number };
  /** What the stand's fansly.com page does once the operator loads it
   *  (PR 7); null: a page that does nothing. */
  site: SiteBehaviour | null;
}

export interface SiteBehaviour {
  /** A read of the API this often (0: none). */
  readEveryMs: number;
  /** A closed write (POST message/ack) this often (0: none). */
  writeEveryMs: number;
  /** The site's socket, authorized, pinging. */
  socket: boolean;
  /** Once authorized, a message spec §2.6 does not allow. */
  forbiddenWs: boolean;
}

/** The stand site's session: Fansly-shaped, nobody's. */
export const STAND_SESSION = { token: "pb-suite-stand-token-0123456789abcdef0123456789abcdef", clientId: "pb-suite-client-000000000001", sessionId: "pb-suite-session-000000000001" } as const;

/** Which page a browser has loaded: the behaviour it was served with. The
 *  page says it once it runs (`GET /stand/hello?variant=…`), so a run can
 *  tell that the browser has the variant it configured, not an earlier one. */
export function siteVariant(site: SiteBehaviour | null): string {
  return site === null ? "idle" : createHash("sha256").update(JSON.stringify([site.readEveryMs, site.writeEveryMs, site.socket, site.forbiddenWs])).digest("hex").slice(0, 12);
}

export const HELLO_PATH = "/stand/hello";
export const REPORT_PATH = "/stand/report";

/** The stand's fansly.com: as Fansly's client does it — its API requests by
 *  XMLHttpRequest with the session's headers (fansly-client-check computed
 *  as the site's bundle does), its socket authorized and pinging. It tells
 *  the stand, by plain requests to its own host, which variant it is and
 *  how each of its writes ended (`/stand/report?what=write-failed` when the
 *  browser cancelled it, `write-done` when an answer came): a closed write
 *  that was never attempted proves nothing about the closure. */
export function sitePage(site: SiteBehaviour | null): string {
  const hello = `function tell(path) { new Image().src = "https://fansly.com" + path + "&t=" + Date.now(); }
  tell(${JSON.stringify(HELLO_PATH)} + "?variant=" + ${JSON.stringify(siteVariant(site))});`;
  const traffic =
    site === null
      ? ""
      : `
  var cfg = ${JSON.stringify(site)};
  var session = ${JSON.stringify(STAND_SESSION)};
  var KEY = ${JSON.stringify(FANSLY_CHECK_KEY)};
  var cyrb53 = ${cyrb53.toString()};
  function call(method, path) {
    var rid = "site-" + Math.random().toString(36).slice(2, 12);
    var x = new XMLHttpRequest();
    if (method !== "GET") x.onloadend = function () { tell(${JSON.stringify(REPORT_PATH)} + "?what=" + (x.status === 0 ? "write-failed" : "write-done") + "&rid=" + rid); };
    x.open(method, "https://apiv3.fansly.com" + path + (path.indexOf("?") < 0 ? "?" : "&") + "rid=" + rid);
    x.withCredentials = true;
    x.setRequestHeader("accept", "application/json, text/plain, */*");
    x.setRequestHeader("authorization", session.token);
    x.setRequestHeader("fansly-client-id", session.clientId);
    x.setRequestHeader("fansly-client-ts", String(Date.now()));
    x.setRequestHeader("fansly-session-id", session.sessionId);
    x.setRequestHeader("fansly-client-check", cyrb53(KEY + "_" + path.split("?")[0] + "_" + session.clientId).toString(16));
    if (method !== "GET") x.setRequestHeader("content-type", "application/json");
    x.send(method === "GET" ? null : "{}");
  }
  call("GET", "/api/v1/account/me");
  if (cfg.readEveryMs > 0) setInterval(function () { call("GET", "/api/v1/stand/read?bytes=2048"); }, cfg.readEveryMs);
  if (cfg.writeEveryMs > 0) setInterval(function () { call("POST", "/api/v1/message/ack"); }, cfg.writeEveryMs);
  function socket() {
    var ws = new WebSocket("wss://wsv3.fansly.com/?v=3");
    var ping = null;
    ws.onopen = function () {
      ws.send(JSON.stringify({ t: 1, d: JSON.stringify({ token: session.token, v: 3 }) }));
      ping = setInterval(function () { ws.send("p"); }, 10000);
      if (cfg.forbiddenWs) setTimeout(function () { ws.send(JSON.stringify({ t: 46001, d: JSON.stringify({ chatRoomId: "1" }) })); }, 1000);
    };
    ws.onclose = function () { if (ping) clearInterval(ping); setTimeout(socket, 2000); };
  }
  if (cfg.socket) setTimeout(socket, 1500);`;
  // The idle page (no behaviour) still says which variant it is: a run of a
  // scenario without the site's traffic must know the browser has none.
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>pb-suite stand</title></head>\n<body><p>The stand's Fansly. Nothing here is Fansly's.</p><script>\n(function () {\n  "use strict";\n  ${hello}${traffic}\n})();\n</script></body></html>\n`;
}

export interface FrontOptions {
  key: Buffer;
  cert: Buffer;
  journal: Journal;
  config: FrontConfig;
  /** The SOCKS connection behind a loopback connection (by its port). */
  metaOf: (remotePort: number | undefined) => SocksMeta | null;
}

type AnyRequest = IncomingMessage | Http2ServerRequest;
type AnyResponse = ServerResponse | Http2ServerResponse;

interface OpenSocket {
  wsId: string;
  ws: WsConnection;
  socksId: number | null;
  /** The page it belongs to (the client's address at the SOCKS5). */
  from: string | null;
  received: number;
}

const MAX_BODY_BYTES = 48 * 1024 * 1024;

function intParam(params: URLSearchParams, name: string, max: number): number {
  const value = Number(params.get(name) ?? "0");
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : 0;
}

export class Front {
  readonly #options: FrontOptions;
  readonly #h1: HttpServer;
  readonly #h2: Http2Server;
  #tls: TlsServer | null = null;
  #direct: TlsServer | null = null;
  readonly #sockets = new Map<string, OpenSocket>();
  #nextWs = 1;
  #nextFrame = 1;
  #pushTimer: NodeJS.Timeout | null = null;
  /** Every connection the front holds (a fault drops them all). */
  readonly #connections = new Set<TLSSocket>();

  constructor(options: FrontOptions) {
    this.#options = options;
    this.#h1 = createHttpServer((req, res) => this.#onRequest(req, res, "http/1.1"));
    this.#h1.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.#onUpgrade(req, socket, head));
    this.#h1.on("clientError", (_error, socket) => socket.destroy());
    this.#h1.keepAliveTimeout = 75_000;
    this.#h2 = createHttp2Server({ maxSessionMemory: 64 }, (req, res) => this.#onRequest(req, res, "h2"));
    this.#h2.on("sessionError", () => undefined);
  }

  /** The front the SOCKS5 connects names to; returns its loopback port. */
  listenLoopback(): Promise<number> {
    const journal = this.#options.journal;
    const server = createTlsServer({
      key: this.#options.key,
      cert: this.#options.cert,
      // The socket host speaks HTTP/1.1 only: Chrome then opens each socket
      // with an Upgrade on a connection of its own (the operator gives every
      // socket its own tunnel).
      ALPNCallback: ({ servername, protocols }) => (roleOf(servername) !== "ws" && protocols.includes("h2") ? "h2" : protocols.includes("http/1.1") ? "http/1.1" : undefined),
    });
    server.on("secureConnection", (socket: TLSSocket) => {
      socket.on("error", () => undefined);
      this.#connections.add(socket);
      socket.on("close", () => this.#connections.delete(socket));
      if (socket.alpnProtocol === "h2") this.#h2.emit("connection", socket);
      else this.#h1.emit("connection", socket);
    });
    server.on("tlsClientError", (error: Error, socket: TLSSocket) => {
      journal.log("tls.error", { socksId: this.#options.metaOf(socket.remotePort)?.socksId ?? null, error: error.message });
    });
    this.#tls = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  }

  /** The stand's own address on the egress network: nothing of the page may
   *  come here. */
  listenDirect(host: string, port: number): Promise<void> {
    const journal = this.#options.journal;
    const http = createHttpServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      journal.log("direct.req", { from: req.socket.remoteAddress ?? "", host: String(req.headers.host ?? ""), method: req.method ?? "", path });
      const trusted = path === TRUST_PATH;
      const body = trusted ? `${TRUST_MARKER}\n` : "";
      res.writeHead(trusted ? 200 : 404, { "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)), connection: "close" }).end(body);
    });
    http.on("clientError", (_error, socket) => socket.destroy());
    const server = createTlsServer({ key: this.#options.key, cert: this.#options.cert, ALPNProtocols: ["http/1.1"] });
    server.on("connection", (socket: Socket) => {
      journal.log("direct.connect", { from: socket.remoteAddress ?? "", port: socket.remotePort ?? 0 });
    });
    server.on("secureConnection", (socket: TLSSocket) => {
      socket.on("error", () => undefined);
      http.emit("connection", socket);
    });
    server.on("tlsClientError", () => undefined);
    this.#direct = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
  }

  // ── requests ───────────────────────────────────────────────────────────

  #onRequest(req: AnyRequest, res: AnyResponse, proto: "h2" | "http/1.1"): void {
    const journal = this.#options.journal;
    const config = this.#options.config;
    const authority = String(req.headers[":authority"] ?? req.headers.host ?? "");
    const host = authority.replace(/:\d+$/, "").toLowerCase();
    const method = req.method ?? "";
    const target = req.url ?? "/";
    const url = new URL(target, "https://stand.invalid");
    const params = url.searchParams;
    const role = roleOf(host);
    const meta = this.#options.metaOf(req.socket.remotePort);
    const header = req.headers["x-stand-rid"];
    const rid = (typeof header === "string" ? header : null) ?? params.get("rid");
    const streamId = "stream" in req && req.stream ? req.stream.id : null;
    const arrived = journal.log(role === "ipify" ? "ipify" : "req", {
      host,
      role,
      method,
      path: `${url.pathname}${url.search}`,
      pathname: url.pathname,
      proto,
      socksId: meta?.socksId ?? null,
      from: meta?.from ?? null,
      streamId: streamId ?? null,
      rid,
      headers: Object.keys(req.headers).filter((name) => !name.startsWith(":")),
    });
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    req.resume();
    const answer = (status: number, headers: Record<string, string>, body: Buffer | string) => {
      const data = typeof body === "string" ? Buffer.from(body, "utf8") : body;
      const send = () => {
        if (res.destroyed || res.writableEnded) return;
        if (res instanceof ServerResponse) res.writeHead(status, { ...headers, "content-length": String(data.length) });
        else res.writeHead(status, { ...headers, "content-length": String(data.length) });
        res.end(data, () => {
          if (role !== "ipify") journal.log("res", { req: arrived.seq, host, role, method, pathname: url.pathname, rid, status, bytes: data.length, socksId: meta?.socksId ?? null, from: meta?.from ?? null });
        });
      };
      const delayMs = intParam(params, "delayMs", 60_000);
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    };
    const status = intParam(params, "status", 599);
    const bytes = intParam(params, "bytes", MAX_BODY_BYTES);
    switch (role) {
      case "ipify":
        return answer(200, { "content-type": "text/plain" }, config.exitIp);
      case "api": {
        const origin = "https://fansly.com";
        const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" };
        if (method === "OPTIONS") {
          const asked = req.headers["access-control-request-headers"];
          return answer(204, { ...cors, "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-allow-headers": typeof asked === "string" ? asked : "*", "access-control-max-age": String(config.corsMaxAge) }, "");
        }
        const response = url.pathname === "/api/v1/account/me" ? { account: { id: config.accountId, username: "pb-suite-stand" } } : { stand: true, rid, pad: "x".repeat(bytes) };
        return answer(status >= 100 ? status : 200, { ...cors, "content-type": "application/json; charset=utf-8" }, JSON.stringify({ success: true, response }));
      }
      case "cdn":
        return answer(status >= 100 ? status : 200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" }, Buffer.alloc(bytes, 0x5a));
      case "ws":
        // The socket host serves sockets only.
        return answer(400, { "content-type": "text/plain" }, "the socket host serves sockets only\n");
      case "site":
        if (url.pathname === "/") return answer(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, sitePage(config.site));
        if (url.pathname.startsWith("/stand/")) return answer(status >= 100 ? status : 200, { "content-type": "text/plain", "cache-control": "no-store" }, url.pathname === TRUST_PATH ? `${TRUST_MARKER}\n` : `pb-suite-stand ${rid ?? ""}\n${"x".repeat(bytes)}`);
        return answer(404, { "content-type": "text/plain" }, "not on the stand\n");
      default:
        return answer(421, { "content-type": "text/plain" }, "not a name of the stand\n");
    }
  }

  // ── the site's socket ──────────────────────────────────────────────────

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const journal = this.#options.journal;
    socket.on("error", () => undefined);
    const host = String(req.headers.host ?? "")
      .replace(/:\d+$/, "")
      .toLowerCase();
    const meta = this.#options.metaOf(req.socket.remotePort);
    const path = req.url ?? "/";
    if (roleOf(host) !== "ws") {
      journal.log("req", { host, role: roleOf(host), method: req.method ?? "", path, pathname: path.split("?")[0], proto: "http/1.1", socksId: meta?.socksId ?? null, from: meta?.from ?? null, streamId: null, rid: null, upgrade: true, headers: Object.keys(req.headers) });
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const wsId = `ws-${this.#nextWs++}`;
    const ws = acceptWebSocket(req, socket, head, 1024 * 1024);
    if (ws === null) {
      journal.log("ws.refused", { host, path, socksId: meta?.socksId ?? null, from: meta?.from ?? null });
      return;
    }
    const open: OpenSocket = { wsId, ws, socksId: meta?.socksId ?? null, from: meta?.from ?? null, received: 0 };
    this.#sockets.set(wsId, open);
    journal.log("ws.open", { wsId, host, path, url: `wss://${host}${path}`, socksId: open.socksId, from: open.from, origin: String(req.headers.origin ?? "") });
    ws.onText = (payload) => {
      open.received += 1;
      const text = payload.toString("utf8");
      // The message as it came — the stand's own traffic carries no secret —
      // cut to what a criterion needs to tell its kind.
      journal.log("ws.in", { wsId, socksId: open.socksId, from: open.from, n: open.received, bytes: payload.length, text: text.length > 512 ? `${text.slice(0, 512)}…` : text });
      if (/^\{"t":1,/.test(text)) ws.sendText(JSON.stringify({ t: 1, d: JSON.stringify({ session: { id: "pb-suite-stand", accountId: this.#options.config.accountId } }) }));
    };
    ws.onBinary = (payload) => {
      open.received += 1;
      journal.log("ws.in", { wsId, socksId: open.socksId, from: open.from, n: open.received, bytes: payload.length, binary: true, text: "" });
    };
    ws.onClose = (reason) => {
      this.#sockets.delete(wsId);
      journal.log("ws.close", { wsId, socksId: open.socksId, from: open.from, reason, received: open.received });
    };
  }

  /** One frame into every open socket (or into `wsId`): journaled with its
   *  number, so each can be looked for in what the engine committed. */
  push(bytes: number, wsId?: string): number {
    let sent = 0;
    for (const open of this.#sockets.values()) {
      if (wsId !== undefined && open.wsId !== wsId) continue;
      const frame = this.#nextFrame++;
      const body = JSON.stringify({ standFrame: frame, wsId: open.wsId, pad: "x".repeat(Math.max(0, bytes - 64)) });
      if (!open.ws.sendText(JSON.stringify({ t: 0, d: body })) && open.ws.closed) continue;
      this.#options.journal.log("ws.out", { wsId: open.wsId, socksId: open.socksId, from: open.from, frame, bytes: body.length });
      sent += 1;
    }
    return sent;
  }

  pushText(text: string, wsId?: string): number {
    let sent = 0;
    for (const open of this.#sockets.values()) {
      if (wsId !== undefined && open.wsId !== wsId) continue;
      open.ws.sendText(text);
      sent += 1;
    }
    return sent;
  }

  closeSockets(code = 1001, wsId?: string): number {
    let closed = 0;
    for (const open of [...this.#sockets.values()]) {
      if (wsId !== undefined && open.wsId !== wsId) continue;
      open.ws.close(code);
      closed += 1;
    }
    return closed;
  }

  /** Every connection dropped: the browser's next request needs a new one
   *  (a warm HTTP/2 connection would carry it past a slow CONNECT). */
  dropConnections(): number {
    const count = this.#connections.size;
    for (const socket of this.#connections) socket.destroy();
    this.#options.journal.log("stand.dropped", { connections: count });
    return count;
  }

  /** The push rate changed (config.wsPush): frames at even intervals. */
  applyPush(): void {
    if (this.#pushTimer) clearInterval(this.#pushTimer);
    this.#pushTimer = null;
    const { perMinute, bytes } = this.#options.config.wsPush;
    if (perMinute <= 0) return;
    this.#pushTimer = setInterval(() => this.push(bytes), Math.max(5, Math.round(60_000 / perMinute)));
  }

  get openSockets(): Array<{ wsId: string; socksId: number | null; from: string | null; received: number }> {
    return [...this.#sockets.values()].map(({ wsId, socksId, from, received }) => ({ wsId, socksId, from, received }));
  }

  close(): void {
    if (this.#pushTimer) clearInterval(this.#pushTimer);
    this.#tls?.close();
    this.#direct?.close();
  }
}
