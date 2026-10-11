// What the stand answers, the same for HTTP/1.1 and HTTP/2: first the
// request-level faults, then the per-host handlers
//   site.stand.test  static pages from STAND_PAGES_DIR
//   api.stand.test   JSON API with CORS and response-shaping query options
//   ws.stand.test    WebSocket (HTTP/1.1 Upgrade or HTTP/2 extended CONNECT)
//   cdn.stand.test   PNG images and range-capable "video" bytes
//   api.ipify.org    the configured exit IP
// Any other host gets 421 Misdirected Request.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http2 from "node:http2";
import path from "node:path";
import zlib from "node:zlib";
import { resetConnection } from "./conn.ts";
import { H2Exchange } from "./exchange.ts";
import type { Exchange, OutHeaders } from "./exchange.ts";
import type { Fault, FaultStore } from "./faults.ts";
import type { Journal } from "./journal.ts";
import type { WsRegistry } from "./websocket.ts";
import { isValidKey } from "./ws-codec.ts";

export interface StandConfig {
  /** Access-Control-Max-Age of api.stand.test preflights (seconds). */
  corsMaxAge: number;
  /** What api.ipify.org reports as the client's IP. */
  exitIp: string;
  /** SNI hosts for which the TLS front offers only ALPN http/1.1 (Chrome then uses HTTP/1.1). */
  h1Hosts: string[];
}

export interface RouterDeps {
  journal: Journal;
  faults: FaultStore;
  config: StandConfig;
  pagesDir: string;
  ws: WsRegistry;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webmanifest": "application/manifest+json",
};

/** A valid 1×1 RGBA PNG; cdn images are this plus zero padding after IEND. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** cdn "video" bytes: a fixed random pool, tiled, so ranges agree with full downloads. */
const NOISE = randomBytes(1024 * 1024);
const DEFAULT_VIDEO_SIZE = 1024 * 1024;

const STAND_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*stand\.test(:\d+)?$/i;

export class Router {
  #deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.#deps = deps;
  }

  /** Entry point for every exchange, after its `req` was journaled. */
  handle(ex: Exchange): void {
    this.#handle(ex).catch((err: unknown) => {
      this.#deps.journal.log("server.error", {
        where: "router",
        connId: ex.conn.connId,
        streamId: ex.streamId,
        rid: ex.rid,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      if (!ex.headersSent && !ex.closed) ex.respond(500, { "content-type": "text/plain" }, "stand: internal error\n");
      else if (!ex.closed) ex.end();
    });
  }

  async #handle(ex: Exchange): Promise<void> {
    if (await this.#applyFaults(ex)) return;
    if (ex.isWebSocket) return this.#serveWebSocket(ex);
    if (ex.method === "CONNECT") {
      return ex.respond(405, { "content-type": "text/plain" }, "stand: CONNECT is only for WebSockets\n");
    }
    await ex.readBody();
    if (ex.closed) return;
    switch (ex.authority) {
      case "site.stand.test":
        return this.#serveSite(ex);
      case "api.stand.test":
        return this.#serveApi(ex);
      case "ws.stand.test":
        return ex.respond(426, { upgrade: "websocket", "content-type": "text/plain" }, "stand: WebSocket only\n");
      case "cdn.stand.test":
        return this.#serveCdn(ex);
      case "api.ipify.org":
        return this.#serveIpify(ex);
      default:
        return ex.respond(421, { "content-type": "text/plain" }, `stand: unknown host ${ex.authority}\n`);
    }
  }

  // ------------------------------------------------------------- faults

  /** Apply request faults in a fixed order; true when the exchange is finished. */
  async #applyFaults(ex: Exchange): Promise<boolean> {
    const faults = this.#deps.faults;
    const ctx = { host: ex.authority, path: ex.path, rid: ex.rid, method: ex.method };

    // `ms` on these faults is the round trip the stand has not got: a real
    // server's refusal reaches Chrome that much later.
    const lag = (ms: number | null) => (ms && ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
    let fault = faults.take("resetAfterHeaders", ctx);
    if (fault) {
      this.#journalFault(fault, ex);
      ex.fault = fault.kind;
      await lag(fault.ms);
      resetConnection(ex.conn);
      return true;
    }
    if (ex instanceof H2Exchange) {
      fault = faults.take("h2RefusedStream", ctx);
      if (fault) {
        this.#journalFault(fault, ex);
        ex.fault = fault.kind;
        await lag(fault.ms);
        ex.refuseStream(fault.code ?? http2.constants.NGHTTP2_REFUSED_STREAM);
        return true;
      }
      fault = faults.take("h2Goaway", ctx);
      if (fault) {
        this.#journalFault(fault, ex);
        ex.fault = fault.kind;
        await lag(fault.ms);
        ex.goawayBelowStream(fault.code ?? http2.constants.NGHTTP2_NO_ERROR);
        return true;
      }
    } else if (ex.reused) {
      // Only a request on a reused keep-alive connection consumes this fault.
      fault = faults.take("h1_408_on_reuse", ctx);
      if (fault) {
        this.#journalFault(fault, ex);
        ex.fault = fault.kind;
        ex.closeAfterResponse = true;
        ex.respond(fault.code ?? 408, { "content-type": "text/plain" }, "Request Timeout\n");
        return true;
      }
    }
    fault = faults.take("closeAfterResponse", ctx);
    if (fault) {
      this.#journalFault(fault, ex);
      ex.closeAfterResponse = true;
    }
    fault = faults.take("delayResponse", ctx);
    if (fault) {
      this.#journalFault(fault, ex);
      await sleep(fault.ms ?? 0);
      if (ex.closed) return true;
    }
    return false;
  }

  #journalFault(fault: Fault, ex: Exchange): void {
    this.#deps.journal.log("fault", {
      faultId: fault.id,
      kind: fault.kind,
      connId: ex.conn.connId,
      streamId: ex.streamId,
      rid: ex.rid,
      ...(fault.ms !== null ? { ms: fault.ms } : {}),
      ...(fault.code !== null ? { code: fault.code } : {}),
    });
  }

  // ------------------------------------------------------------- ws.stand.test

  #serveWebSocket(ex: Exchange): void {
    const text = { "content-type": "text/plain" };
    if (ex.authority !== "ws.stand.test") return ex.respond(404, text, "stand: WebSockets live on ws.stand.test\n");
    if (ex.proto === "h1") {
      if (ex.method !== "GET") return ex.respond(405, text, "stand: WebSocket handshake must be GET\n");
      if (!/\bwebsocket\b/i.test(ex.headers.upgrade ?? "")) return ex.respond(400, text, "stand: unsupported Upgrade\n");
      if (!isValidKey(ex.headers["sec-websocket-key"])) return ex.respond(400, text, "stand: bad Sec-WebSocket-Key\n");
    }
    if (ex.headers["sec-websocket-version"] !== "13") {
      return ex.respond(426, { ...text, "sec-websocket-version": "13" }, "stand: WebSocket version 13 only\n");
    }
    // Echo the first offered subprotocol; extensions are never negotiated.
    const offered = (ex.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const protocol = offered[0] ?? null;
    const wsId = this.#deps.ws.nextId();
    const { duplex, head } = ex.acceptWebSocket(protocol);
    this.#deps.ws.open(duplex, head, {
      wsId,
      connId: ex.conn.connId,
      proto: ex.proto,
      streamId: ex.streamId,
      path: ex.path,
      rid: ex.rid,
      protocol,
    });
  }

  // ------------------------------------------------------------- site.stand.test

  async #serveSite(ex: Exchange): Promise<void> {
    const noStore = { "cache-control": "no-store" };
    if (ex.method !== "GET" && ex.method !== "HEAD") {
      return ex.respond(405, { ...noStore, allow: "GET, HEAD", "content-type": "text/plain" }, "method not allowed\n");
    }
    let rel: string;
    try {
      rel = decodeURIComponent(ex.url.pathname);
    } catch {
      return ex.respond(400, { ...noStore, "content-type": "text/plain" }, "bad path\n");
    }
    if (rel.endsWith("/")) rel += "index.html";
    const root = path.resolve(this.#deps.pagesDir);
    const file = path.resolve(root, "." + rel);
    if (!file.startsWith(root + path.sep)) return ex.respond(404, { ...noStore, "content-type": "text/plain" }, "not found\n");
    let data: Buffer;
    try {
      const stat = await fs.stat(file);
      if (stat.isDirectory()) {
        return ex.respond(301, { ...noStore, location: ex.url.pathname + "/" + ex.url.search }, "");
      }
      data = await fs.readFile(file);
    } catch {
      return ex.respond(404, { ...noStore, "content-type": "text/plain" }, "not found\n");
    }
    const ext = path.extname(file).toLowerCase();
    const headers: OutHeaders = { ...noStore, "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" };
    if (ext === ".js" || ext === ".mjs") headers["service-worker-allowed"] = "/";
    ex.respond(200, headers, data);
  }

  // ------------------------------------------------------------- api.stand.test

  async #serveApi(ex: Exchange): Promise<void> {
    const cors = corsHeaders(ex.headers.origin);
    if (ex.method === "OPTIONS") {
      const headers: OutHeaders = {
        ...cors,
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-max-age": String(this.#deps.config.corsMaxAge),
      };
      const requested = ex.headers["access-control-request-headers"];
      if (requested) headers["access-control-allow-headers"] = requested;
      return ex.respond(204, headers);
    }
    const pathname = ex.url.pathname;
    if (pathname === "/beacon") return ex.respond(204, cors);
    if (pathname !== "/api" && !pathname.startsWith("/api/")) {
      return ex.respond(404, { ...cors, "content-type": "application/json" }, JSON.stringify({ ok: false, error: "not found" }));
    }

    const query = ex.url.searchParams;
    const payload: Record<string, unknown> = {
      ok: true,
      rid: ex.rid,
      method: ex.method,
      path: ex.path,
      connId: ex.conn.connId,
      streamId: ex.streamId,
      proto: ex.proto,
      reused: ex.reused,
      nthOnConn: ex.nthOnConn,
      mono: ex.reqMono,
      seq: ex.reqSeq,
      bodyBytes: await ex.readBody(),
    };
    const size = intParam(query, "size");
    if (size !== null) {
      // Pad so the uncompressed JSON is exactly `size` bytes (when it can be).
      payload.pad = "";
      payload.pad = "x".repeat(Math.max(0, size - Buffer.byteLength(JSON.stringify(payload))));
    }
    let body = Buffer.from(JSON.stringify(payload), "utf8");
    const headers: OutHeaders = { ...cors, "content-type": "application/json" };
    let status = statusParam(query.get("status"));
    // `location`: with status 301/302/307, a redirect to that address.
    const location = query.get("location");
    if (location) headers.location = location;

    const cache = intParam(query, "cache");
    const etagParam = query.get("etag");
    if (etagParam !== null && etagParam !== "") {
      const etag = /^(W\/)?"/.test(etagParam) ? etagParam : `"${etagParam}"`;
      headers.etag = etag;
      headers["cache-control"] = cache !== null ? `max-age=${cache}` : "no-cache";
      if (etagMatches(ex.headers["if-none-match"], etag)) status = 304;
    } else {
      headers["cache-control"] = cache !== null ? `max-age=${cache}` : "no-store";
    }

    const enc = query.get("enc");
    if (status !== 304) {
      if (enc === "gzip") {
        body = zlib.gzipSync(body);
        headers["content-encoding"] = "gzip";
      } else if (enc === "br") {
        body = zlib.brotliCompressSync(body);
        headers["content-encoding"] = "br";
      }
    }

    const delay = intParam(query, "delay");
    if (delay) {
      await sleep(delay);
      if (ex.closed) return;
    }
    const chunked = query.get("chunked") === "1";
    const slow = intParam(query, "slow") ?? 0;
    if (status === 304) return ex.respond(304, headers);
    if (!chunked && slow <= 0) return ex.respond(status, headers, body);
    await streamBody(ex, status, headers, body, chunked, slow);
  }

  // ------------------------------------------------------------- cdn.stand.test

  async #serveCdn(ex: Exchange): Promise<void> {
    const query = ex.url.searchParams;
    const cache = intParam(query, "cache");
    const base: OutHeaders = {
      "access-control-allow-origin": "*",
      "timing-allow-origin": "*",
      "cache-control": cache !== null ? `max-age=${cache}` : "no-store",
    };
    if (ex.method !== "GET" && ex.method !== "HEAD") {
      return ex.respond(405, { ...base, allow: "GET, HEAD", "content-type": "text/plain" }, "method not allowed\n");
    }
    const pathname = ex.url.pathname;
    const size = intParam(query, "size");
    if (/^\/img\/.+\.png$/.test(pathname)) {
      const body = Buffer.alloc(Math.max(PNG_1X1.length, size ?? 0)); // zero bytes after IEND
      PNG_1X1.copy(body);
      return ex.respond(200, { ...base, "content-type": "image/png" }, body);
    }
    if (/^\/video\/.+\.mp4$/.test(pathname)) return serveNoise(ex, base, size ?? DEFAULT_VIDEO_SIZE);
    return ex.respond(404, { ...base, "content-type": "text/plain" }, "not found\n");
  }

  // ------------------------------------------------------------- api.ipify.org

  #serveIpify(ex: Exchange): void {
    const headers: OutHeaders = { "access-control-allow-origin": "*", "cache-control": "no-store" };
    if (ex.url.pathname !== "/") return ex.respond(404, { ...headers, "content-type": "text/plain" }, "not found\n");
    const ip = this.#deps.config.exitIp;
    if (ex.url.searchParams.get("format") === "json") {
      return ex.respond(200, { ...headers, "content-type": "application/json" }, JSON.stringify({ ip }));
    }
    ex.respond(200, { ...headers, "content-type": "text/plain" }, ip);
  }
}

/** CORS for api.stand.test: credentialed, only for https://*.stand.test origins. */
function corsHeaders(origin: string | undefined): OutHeaders {
  const headers: OutHeaders = { vary: "Origin" };
  if (origin && STAND_ORIGIN.test(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-credentials"] = "true";
  }
  return headers;
}

/**
 * Send `body` in pieces: chunked=1 → no Content-Length (HTTP/1.1 chunked
 * transfer-encoding, HTTP/2 DATA frames), 4 pieces 10 ms apart; slow=<ms> →
 * 10 pieces, one every ms/10, so the body completes after ≈ ms.
 */
async function streamBody(ex: Exchange, status: number, headers: OutHeaders, body: Buffer, chunked: boolean, slowMs: number): Promise<void> {
  const out: OutHeaders = { ...headers };
  if (!chunked) out["content-length"] = String(body.length);
  if (ex.method === "HEAD" || status === 204) {
    ex.sendHeaders(status, out, true);
    return;
  }
  ex.sendHeaders(status, out);
  const pieces = slowMs > 0 ? 10 : 4;
  const pause = slowMs > 0 ? slowMs / pieces : 10;
  const pieceSize = Math.ceil(body.length / pieces);
  for (let i = 0; i < pieces; i++) {
    const piece = body.subarray(i * pieceSize, (i + 1) * pieceSize);
    if (piece.length > 0) await ex.write(piece);
    if (ex.closed) return;
    if (slowMs > 0 || i < pieces - 1) await sleep(pause);
    if (ex.closed) return;
  }
  ex.end();
}

/** `size` bytes of the noise pool; a single `Range: bytes=` range gets a 206. */
async function serveNoise(ex: Exchange, base: OutHeaders, total: number): Promise<void> {
  const headers: OutHeaders = { ...base, "content-type": "video/mp4", "accept-ranges": "bytes" };
  const range = parseRange(ex.headers.range, total);
  if (range === "unsatisfiable") return ex.respond(416, { ...headers, "content-range": `bytes */${total}` });
  let status = 200;
  let start = 0;
  let end = total - 1;
  if (range !== null) {
    status = 206;
    ({ start, end } = range);
    headers["content-range"] = `bytes ${start}-${end}/${total}`;
  }
  const length = Math.max(0, end - start + 1);
  headers["content-length"] = String(length);
  if (ex.method === "HEAD" || length === 0) {
    ex.sendHeaders(status, headers, true);
    return;
  }
  ex.sendHeaders(status, headers);
  for (let pos = start; pos <= end && !ex.closed; ) {
    const offset = pos % NOISE.length;
    const n = Math.min(NOISE.length - offset, end - pos + 1, 64 * 1024);
    await ex.write(NOISE.subarray(offset, offset + n));
    pos += n;
  }
  ex.end();
}

/** One `bytes=a-b` / `bytes=a-` / `bytes=-n` range; anything else is ignored (null). */
function parseRange(header: string | undefined, total: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(m[1]);
    if (start >= total) return "unsatisfiable";
    end = m[2] === "" ? total - 1 : Number(m[2]);
    if (end < start) return null; // syntactically invalid: ignore the header
    end = Math.min(end, total - 1);
  }
  if (start >= total) return "unsatisfiable";
  return { start, end };
}

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const weakless = (tag: string): string => tag.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || weakless(tag) === weakless(etag));
}

/** A non-negative integer query parameter, or null when absent/invalid. */
function intParam(query: URLSearchParams, name: string): number | null {
  const raw = query.get(name);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function statusParam(raw: string | null): number {
  const value = Number(raw);
  return raw !== null && Number.isInteger(value) && value >= 200 && value <= 599 ? value : 200;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
