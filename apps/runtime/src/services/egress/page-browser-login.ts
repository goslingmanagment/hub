import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as tcpConnect } from "node:net";
import type { Duplex } from "node:stream";

import { Agent, WebSocket, type MessageEvent } from "undici";

import { PAGE_BROWSER_RPC_PORT } from "./page-browser-link.ts";
import { decodeBodyFrame, parseLoginReply, type LoginReply, type LoginScreen } from "./page-browser-protocol.ts";

// The API's side of a page browser (Project Browser plan §4.8, §4.13; spec
// §6.1 `login.*`; stage 3 PR 15). Its network lives here, in services/egress
// (the repository's ESLint wall):
//
// - The login form's calls: one WebSocket per call to the operator's /rpc on
//   pb-control, the API's own token in the call (never the engine's), the
//   answer read strictly; a screenshot's JPEG reassembled from its body
//   frames and checked (size, sha256) before it is handed over. The call —
//   the login, the password, the code — exists only in this function's
//   arguments and the frame on the wire: never in a log line, an error, a
//   result. What fails says why without it.
// - The owner's screen (KasmVNC, plan §4.8 «Экран KasmVNC»): HTTP and the
//   WebSocket of its web client passed to the page's container on
//   `:6901`, with the page's own screen password from Hub's secrets put in
//   as KasmVNC's basic authorization — the owner never needs it. The owner's
//   Hub cookie and authorization never go there; the screen's own
//   authorization challenge never comes back (no browser prompt).

/** KasmVNC's port on pb-control (plan §3.1). */
export const PAGE_BROWSER_SCREEN_PORT = 6901;
/** KasmVNC's user of the page's screen (apps/page-browser/s6 xvnc/run). */
export const PAGE_BROWSER_SCREEN_USER = "owner";
/** A screenshot is never larger than this. */
export const LOGIN_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

/** Where the API reaches a page's browser. Tests point it at fakes. */
export interface PageBrowserEndpoints {
  rpcUrl(container: string): string;
  screen(container: string): { host: string; port: number };
}

export const PAGE_BROWSER_ENDPOINTS: PageBrowserEndpoints = {
  rpcUrl: (container) => `ws://${container}:${PAGE_BROWSER_RPC_PORT}/rpc`,
  screen: (container) => ({ host: container, port: PAGE_BROWSER_SCREEN_PORT }),
};

export type LoginCall =
  | { type: "login.state" }
  | { type: "login.screenshot" }
  | { type: "login.submit"; login: string; password: string }
  | { type: "login.code"; code: string };

export type LoginAnswer =
  /** `codeFrom` "email": the code asked for is the one Fansly e-mailed for a
   *  login from a new device (absent: the 2FA code). */
  | { kind: "state"; screen: LoginScreen; screenVersion: string; fields: Array<"login" | "password" | "code">; siteError: string | null; codeFrom?: "email" }
  | { kind: "screenshot"; jpeg: Buffer }
  | { kind: "refused"; reason: Extract<LoginReply, { type: "login.refused" }>["reason"] }
  /** No answer: the browser cannot be reached, or it broke the protocol. */
  | { kind: "unreachable"; why: string };

/** One call of the login form to the page's operator. Never throws. */
export function callPageBrowserLogin(input: { url: string; token: string; call: LoginCall; timeoutMs: number }): Promise<LoginAnswer> {
  const callId = randomUUID();
  return new Promise<LoginAnswer>((resolve) => {
    const agent = new Agent({ connect: { timeout: Math.min(input.timeoutMs, 5_000) } });
    let socket: WebSocket | null = null;
    let settled = false;
    const parts = new Map<string, Buffer[]>();
    const done = (answer: LoginAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // closing a socket that never opened
      }
      void agent.close().catch(() => undefined);
      resolve(answer);
    };
    const timer = setTimeout(() => done({ kind: "unreachable", why: `no answer within ${input.timeoutMs} ms` }), input.timeoutMs);
    timer.unref?.();
    // An operator's /rpc on pb-control, never anything else (never Fansly).
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      done({ kind: "unreachable", why: "the browser's address does not read" });
      return;
    }
    if (url.protocol !== "ws:" || url.pathname !== "/rpc" || url.username !== "" || url.password !== "") {
      done({ kind: "unreachable", why: "not a page browser's address" });
      return;
    }
    try {
      socket = new WebSocket(url, { dispatcher: agent });
    } catch {
      done({ kind: "unreachable", why: "the browser's address does not open" });
      return;
    }
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      // The one place the call is written: the frame to the operator.
      socket!.send(JSON.stringify({ ...input.call, callId, token: input.token }));
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      if (data instanceof ArrayBuffer) {
        let frame;
        try {
          frame = decodeBodyFrame(Buffer.from(data));
        } catch {
          return done({ kind: "unreachable", why: "a broken body frame" });
        }
        const list = frame.part === 0 ? [] : (parts.get(frame.bodyId) ?? []);
        if (frame.abandoned) {
          parts.set(frame.bodyId, []);
          return;
        }
        list.push(frame.data);
        if (list.reduce((sum, part) => sum + part.length, 0) > LOGIN_SCREENSHOT_MAX_BYTES) return done({ kind: "unreachable", why: "a screenshot over its limit" });
        parts.set(frame.bodyId, list);
        return;
      }
      if (typeof data !== "string") return done({ kind: "unreachable", why: "a frame of an unknown kind" });
      const parsed = parseLoginReply(data);
      if (!parsed.ok) return done({ kind: "unreachable", why: `the answer does not read: ${parsed.error}` });
      const reply = parsed.reply;
      // A refusal of the token may come before the call was read: no id then.
      if (reply.callId !== callId && !(reply.type === "login.refused" && reply.reason === "token")) return;
      switch (reply.type) {
        case "login.refused":
          return done({ kind: "refused", reason: reply.reason });
        case "login.stateResult":
          return done({ kind: "state", screen: reply.screen, screenVersion: reply.screenVersion, fields: reply.fields, siteError: reply.siteError, ...(reply.codeFrom === "email" ? { codeFrom: "email" as const } : {}) });
        case "login.screenshotResult": {
          const jpeg = Buffer.concat(parts.get(reply.jpeg.bodyId) ?? []);
          if (jpeg.length !== reply.jpeg.decodedBytes || createHash("sha256").update(jpeg).digest("hex") !== reply.jpeg.sha256) {
            return done({ kind: "unreachable", why: "the screenshot did not arrive whole" });
          }
          return done({ kind: "screenshot", jpeg });
        }
      }
    });
    socket.addEventListener("close", () => done({ kind: "unreachable", why: "the browser closed the connection" }));
    socket.addEventListener("error", () => done({ kind: "unreachable", why: "the browser cannot be reached" }));
  });
}

// ── the owner's screen (KasmVNC) ───────────────────────────────────────────

/** Headers of the owner's request that never go to the container: the
 *  owner's Hub session, any authorization, hop-by-hop ones. */
const DROPPED_REQUEST_HEADERS = new Set([
  "cookie", "authorization", "proxy-authorization", "host", "connection", "keep-alive", "te", "trailer", "transfer-encoding",
  "upgrade", "proxy-connection", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "origin", "referer",
]);
/** Headers of the screen's answer that never come back to the owner. */
const DROPPED_RESPONSE_HEADERS = new Set(["www-authenticate", "set-cookie", "connection", "keep-alive", "transfer-encoding", "proxy-authenticate"]);

function basic(password: string): string {
  return `Basic ${Buffer.from(`${PAGE_BROWSER_SCREEN_USER}:${password}`, "utf8").toString("base64")}`;
}

function forwardedHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/** An HTTP request of the owner's screen, passed to the page's KasmVNC at
 *  `path` (with its query) with the screen's password. The answer is
 *  streamed back; a container that cannot be reached is a 502. */
export function proxyScreenRequest(input: { req: IncomingMessage; res: ServerResponse; target: { host: string; port: number }; path: string; password: string; timeoutMs?: number }): void {
  const { req, res } = input;
  const upstream = httpRequest({
    host: input.target.host,
    port: input.target.port,
    method: req.method ?? "GET",
    path: input.path,
    headers: { ...forwardedHeaders(req.headers), host: `${input.target.host}:${input.target.port}`, authorization: basic(input.password) },
    timeout: input.timeoutMs ?? 15_000,
  }, (answer) => {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(answer.headers)) {
      if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
    headers["cache-control"] = "private, no-store";
    // The screen's own pages are framed by nobody but the dashboard's tab.
    headers["x-frame-options"] = "SAMEORIGIN";
    res.writeHead(answer.statusCode === 401 ? 502 : (answer.statusCode ?? 502), headers);
    answer.pipe(res);
    answer.on("error", () => res.destroy());
  });
  upstream.on("timeout", () => upstream.destroy(new Error("the screen did not answer")));
  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("The page's screen cannot be reached.");
  });
  req.pipe(upstream);
}

/** The screen's WebSocket (an upgrade of the owner's request), passed to
 *  the page's KasmVNC as a TCP stream once the request line and its headers
 *  — the screen's password in, the owner's cookie out — went ahead. KasmVNC
 *  refuses a WebSocket with no `Origin` (404, "missing Sec-WebSocket-Origin
 *  header"): it gets the screen's own origin, never the owner's. */
export function proxyScreenUpgrade(input: { req: IncomingMessage; socket: Duplex; head: Buffer; target: { host: string; port: number }; path: string; password: string; onClose?: () => void }): { close(): void } {
  const { req, socket } = input;
  socket.on("error", () => undefined);
  const upstream = tcpConnect({ host: input.target.host, port: input.target.port }, () => {
    const headers: Record<string, string | string[]> = { ...forwardedHeaders(req.headers), host: `${input.target.host}:${input.target.port}`, authorization: basic(input.password), origin: `http://${input.target.host}:${input.target.port}`, connection: "Upgrade", upgrade: String(req.headers.upgrade ?? "websocket") };
    const lines = [`GET ${input.path} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (input.head.length > 0) upstream.write(input.head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.setTimeout(15_000, () => upstream.destroy());
  upstream.on("connect", () => upstream.setTimeout(0));
  let connected = false;
  upstream.on("connect", () => (connected = true));
  upstream.on("error", () => {
    if (!connected) socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  // Either side's end is the stream's: both go (an HTTP server's socket
  // stays half-open after its peer's end, and would never close).
  let closed = false;
  const both = () => {
    upstream.destroy();
    socket.destroy();
    if (closed) return;
    closed = true;
    input.onClose?.();
  };
  upstream.on("close", both);
  upstream.on("end", both);
  socket.on("close", both);
  socket.on("end", both);
  return { close: both };
}
