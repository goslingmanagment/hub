// The site check: the site's own requests (Project Browser PR 7; plan §4.3,
// spec §2, §6, §9) on a real Chrome, local. Run by stand/site-check.sh — on
// this machine's Chrome, or in the image with its Chrome — or by hand:
//
//   node --no-warnings site-check.ts --chrome <path> [--no-sandbox] [--verbose]
//
// What runs: a real Chrome (headless=new, a throwaway profile) behind the
// operator's real proxy and API gate (egress/), its real interception
// (cdp/paused.ts), the real site path (intercept/site.ts) and the real
// buffer (buffer/), against one local TLS server that plays fansly.com,
// apiv3.fansly.com and a third-party host (a self-signed certificate made
// here with openssl; Chrome told to take it), reached through a SOCKS5
// listener of this script's that connects only to that server. Chrome
// resolves no name itself (--host-resolver-rules) and goes only through the
// proxy. A page of the server's makes the site's requests; an engine of this
// script's admits them one at a time, 120 ms after each ask. No credential
// is used anywhere: the token and ids the page sends are local stand-ins.
//
// What it proves, comparing what the server physically got with what was
// admitted and the bodies kept with the bodies sent:
//   - every API request and preflight that reached the server did so inside
//     an admission of its path, at most one request and one preflight per
//     admission (owner decision №1); nothing the map closes (the ack, a
//     write, a closed read) reached it, nor a preflight of it;
//   - the page's files and a third-party host pass, a third-party preflight
//     is handed on and Chrome's network service lives after it;
//   - two requests of one method and URL at once, each with its preflight,
//     are two operations under two admissions;
//   - a request the page aborts while it waits, and one of a document the
//     site replaced, never leave, and a late admission of them is not used;
//     a request nobody admits fails at the end of its wait;
//   - the login: closed in the automation mode, one operation in the manual
//     login (its body whole on the wire, its answer not kept);
//   - the answers kept are byte for byte the server's — gzip, chunked, slow,
//     40 MiB and eight of 15 MiB in a row (past Chrome's own buffers); the
//     body of a request the site's service worker passes on is a mark, never
//     an empty fact; a worker's request is admitted; a 429 carries its
//     Retry-After to siteDone; a redirect is not followed; the device id's
//     answer is not kept;
//   - the page's cancel of a released request before its answer stops the
//     page (request_unended);
//   - no password, token or session in the log or the journal.
//
// What it does not prove:
//   - no holder: CDP goes straight to Chrome (no event replay, no batched
//     acknowledgements, no reconnects);
//   - no rules extension: its rules are not loaded (in the image the
//     managed policies are masked), so what it cancels is never tried here;
//   - no nftables: the kernel rules that keep Chrome to the proxy's port are
//     not in place — in the image the container has no network at all; on
//     a workstation only the proxy flag and the resolver rule keep Chrome in;
//   - not the full Operator: no engine link (RPC), no start steps 1–10 and
//     no reload of the work tab, no Hub requests, no sockets, no self-test,
//     no pacing or budgets — the engine here is a stand-in;
//   - not Fansly: the server plays its hosts; the real site's scripts, CORS
//     answers and service worker differ;
//   - headless Chrome, no X server and no screen.
//
// Prints what it compared, one line each; exits 0 when all held, 1 when any
// did not, 2 when it could not run.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http2 from "node:http2";
import { connect as tcpConnect, createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

import { EventBuffer } from "../src/buffer/buffer.ts";
import { CdpError, type CdpEvent, type CdpPort, type EventHandler } from "../src/cdp/client.ts";
import { PausedRequests } from "../src/cdp/paused.ts";
import { classifyFanslyHost } from "../src/egress/hosts.ts";
import { Egress } from "../src/egress/proxy.ts";
import { SiteSession } from "../src/hub-requests/session.ts";
import { SiteRequests } from "../src/intercept/site.ts";
import type { RequestLine } from "../src/logs/journal.ts";
import type { OperatorMode } from "../src/policy/operations.ts";
import type { SiteAdmit, SiteDone } from "../src/rpc/protocol.ts";
import { monoMs, setLogSink } from "../src/shared/util.ts";

// ── arguments ───────────────────────────────────────────────────────────

function argument(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

const CHROME = argument("--chrome");
const verbose = process.argv.includes("--verbose");
if (CHROME === null || !existsSync(CHROME)) {
  console.error(`site-check: no Chrome at ${CHROME ?? "(none given: --chrome <path>)"}`);
  process.exit(2);
}

const logLines: string[] = [];
setLogSink((line) => {
  logLines.push(line);
  if (verbose) console.log(line);
});

const sha = (data: Buffer | Uint8Array) => createHash("sha256").update(data).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const work = mkdtempSync(join(tmpdir(), "pb-site-check-"));

// Throwaway stand-ins, never anyone's: what the page sends and logs in with.
const PAGE_TOKEN = "stand-token-not-a-secret-0123456789";
const PAGE_PASSWORD = "stand-password-not-a-secret";
const ISSUED_TOKEN = "stand-issued-token-not-a-secret";

// ── the certificate: self-signed, made here, for the server's hosts ───────

const KEY = join(work, "key.pem");
const CERT = join(work, "cert.pem");
const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=fansly.com", "-addext", "subjectAltName=DNS:fansly.com,DNS:*.fansly.com,DNS:widget.thirdparty.net", "-keyout", KEY, "-out", CERT], { stdio: "pipe" });
if (made.status !== 0) {
  console.error(`site-check: openssl made no certificate: ${String(made.stderr)}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

// ── the server: fansly.com, apiv3.fansly.com, widget.thirdparty.net ───────

const BIG = Buffer.from(JSON.stringify({ success: true, response: Array.from({ length: 40_000 }, (_, i) => ({ id: String(i), text: `message ${i} ${"x".repeat(40)}` })) }));
const HUGE = Buffer.alloc(40 * 1024 * 1024, "h");
const LARGE = Buffer.alloc(15 * 1024 * 1024, "l");
const ME = Buffer.from(JSON.stringify({ success: true, response: { account: { id: "300000000000000001", username: "stand" } } }));
const SMALL = (name: string) => Buffer.from(JSON.stringify({ success: true, response: { name, items: [1, 2, 3] } }));
interface Arrival {
  mono: number;
  method: string;
  host: string;
  path: string;
  headers: string[];
}
const arrivals: Arrival[] = [];
/** The decoded body the server sent, by "METHOD path". */
const sentBodies = new Map<string, Buffer>();
const loginBodies: string[] = [];

const PAGE = `<!doctype html><title>stand</title><script src="/main.js"></script><script src="https://widget.thirdparty.net/widget.js"></script>`;
const SCRIPT = `
window.results = {};
const API = "https://apiv3.fansly.com/api/v1";
const H = { authorization: ${JSON.stringify(PAGE_TOKEN)}, "fansly-client-id": "720000000000000001", "fansly-client-ts": String(Date.now()), "fansly-session-id": "720000000000000002", "fansly-client-check": "abc123" };
async function digest(buffer) { const d = await crypto.subtle.digest("SHA-256", buffer); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function xhr(name, method, path, body) {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open(method, API + path);
    x.responseType = "arraybuffer";
    for (const [k, v] of Object.entries(H)) x.setRequestHeader(k, v);
    if (body) x.setRequestHeader("content-type", "application/json");
    x.onload = async () => { window.results[name] = { status: x.status, bytes: x.response.byteLength, sha: await digest(x.response) }; resolve(); };
    x.onerror = () => { window.results[name] = { error: "network" }; resolve(); };
    x.send(body ?? null);
  });
}
async function streamed(name, path) {
  try {
    const r = await fetch(API + path, { headers: H });
    const reader = r.body.getReader();
    const parts = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); }
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    window.results[name] = { status: r.status, bytes: all.length, sha: await digest(all.buffer) };
  } catch (e) { window.results[name] = { error: String(e) }; }
}
window.xhr = xhr; window.streamed = streamed; window.H = H; window.API = API;
if (location.search === "") (async () => {
  // A burst as the site's load makes, then one by one.
  await Promise.all([
    xhr("me", "GET", "/account/me?ngsw-bypass=true"),
    xhr("groups", "GET", "/messaging/groups?limit=1000"),
    xhr("other", "GET", "/some/unknown/path?x=1"),
    xhr("ack", "POST", "/message/ack", JSON.stringify({ messageIds: ["1"], type: 2 })),
    xhr("write", "POST", "/message", JSON.stringify({ content: "never" })),
    xhr("unsubscribe", "GET", "/emails/unsubscribe"),
  ]);
  await xhr("limited", "GET", "/notifications");
  await streamed("stream", "/subscribers?limit=50");
  await streamed("streamGzip", "/timelinenew/123?before=0");
  await xhr("redirect", "GET", "/post?ids=1");
  await xhr("device", "GET", "/device/id");
  await xhr("meAgain", "GET", "/account/me?ngsw-bypass=true");
  await xhr("cachedPreflight", "GET", "/polls?x=1");
  await xhr("cachedPreflight2", "GET", "/polls?x=1");
  window.done = true;
})();
`;

const server = http2.createSecureServer({ key: readFileSync(KEY), cert: readFileSync(CERT), allowHTTP1: true });
server.on("request", (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  const host = String(req.headers[":authority"] ?? req.headers.host ?? "").replace(/:\d+$/, "");
  const url = new URL(req.url, `https://${host}`);
  const method = req.method;
  arrivals.push({ mono: monoMs(), method, host, path: url.pathname, headers: Object.keys(req.headers).filter((name) => !name.startsWith(":")) });
  const cors = { "access-control-allow-origin": "https://fansly.com", "access-control-allow-headers": "authorization,fansly-client-id,fansly-client-ts,fansly-session-id,fansly-client-check,content-type,if-none-match", "access-control-allow-methods": "GET,POST", "access-control-expose-headers": "retry-after" };
  const send = (status: number, body: Buffer, headers: Record<string, string> = {}, how: { gzip?: boolean; chunked?: boolean; slow?: boolean } = {}) => {
    sentBodies.set(`${method} ${url.pathname}`, body);
    const wire = how.gzip ? zlib.gzipSync(body) : body;
    res.writeHead(status, { "content-type": "application/json", ...(host === "apiv3.fansly.com" ? cors : {}), ...(how.gzip ? { "content-encoding": "gzip" } : {}), ...(how.chunked ? {} : { "content-length": String(wire.length) }), ...headers });
    if (!how.slow) return void res.end(wire);
    let offset = 0;
    const step = Math.max(1, Math.ceil(wire.length / 20));
    const tick = () => {
      if (offset >= wire.length) return void res.end();
      res.write(wire.subarray(offset, offset + step));
      offset += step;
      setTimeout(tick, 5);
    };
    tick();
  };
  if (host === "fansly.com") {
    if (url.pathname === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    if (url.pathname === "/main.js") return void res.writeHead(200, { "content-type": "application/javascript" }).end(SCRIPT);
    if (url.pathname === "/sw.js") return void res.writeHead(200, { "content-type": "application/javascript" }).end(`self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim())); self.addEventListener("fetch", (e) => { if (e.request.url.includes("viasw=1")) e.respondWith(fetch(e.request)); });`);
    if (url.pathname === "/worker.js") return void res.writeHead(200, { "content-type": "application/javascript" }).end(`onmessage = async (m) => { try { const r = await fetch(m.data.url, { headers: m.data.headers }); const b = await r.arrayBuffer(); postMessage({ status: r.status, bytes: b.byteLength }); } catch (e) { postMessage({ error: String(e) }); } };`);
    return void res.writeHead(404).end();
  }
  if (host === "widget.thirdparty.net") {
    const open = { "access-control-allow-origin": "https://fansly.com", "access-control-allow-headers": "content-type,x-widget", "access-control-allow-methods": "POST", "access-control-max-age": "0" };
    if (method === "OPTIONS") return void res.writeHead(204, open).end();
    if (method === "POST") return void res.writeHead(200, { ...open, "content-type": "application/json" }).end('{"ok":true}');
    return void res.writeHead(200, { "content-type": "application/javascript" }).end("window.widget = 1;");
  }
  if (host !== "apiv3.fansly.com") return void res.writeHead(404).end();
  if (method === "POST" && url.pathname === "/api/v1/login") {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      loginBodies.push(Buffer.concat(parts).toString());
      send(200, Buffer.from(JSON.stringify({ success: true, response: { session: { token: ISSUED_TOKEN } } })));
    });
    return;
  }
  // /polls keeps its preflight; the rest ask every time.
  if (method === "OPTIONS") return void res.writeHead(204, { ...cors, "access-control-max-age": url.pathname.endsWith("/polls") ? "600" : "0" }).end();
  const path = url.pathname.replace("/api/v1", "");
  switch (path) {
    case "/account/me":
      return send(200, ME);
    case "/messaging/groups":
      return send(200, BIG, {}, { gzip: true, chunked: true, slow: true });
    case "/notifications":
      return send(429, Buffer.from('{"success":false,"error":"rate"}'), { "retry-after": "7" });
    case "/subscribers":
      return send(200, SMALL("subscribers"), {}, { slow: true });
    case "/timelinenew/123":
      return send(200, BIG, {}, { gzip: true, chunked: true, slow: true });
    case "/post":
      sentBodies.set(`${method} ${url.pathname}`, Buffer.alloc(0));
      return void res.writeHead(302, { ...cors, location: "https://apiv3.fansly.com/api/v1/elsewhere", "content-length": "0" }).end();
    case "/lists/account":
      if (req.headers["if-none-match"] === '"v1"') return void res.writeHead(304, { ...cors, etag: '"v1"', "cache-control": "no-cache" }).end();
      return send(200, SMALL("lists"), { etag: '"v1"', "cache-control": "no-cache" });
    case "/media/vaultnew":
      return send(200, HUGE, {}, { slow: true });
    case "/vault/albumsnew2":
      return send(200, LARGE, {}, { chunked: true });
    case "/vault/albumsnew":
      return void setTimeout(() => send(200, SMALL("slow")), 3000);
    case "/device/id":
      return send(200, Buffer.from('{"success":true,"response":"device-1"}'));
    default:
      return send(200, SMALL(path));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const serverPort = (server.address() as { port: number }).port;

// ── the page's SOCKS5: user and password (RFC 1929), the server only ──────

const SOCKS_USER = "stand-user";
const SOCKS_PASSWORD = "stand-password";
const SERVED = new Set(["fansly.com:443", "apiv3.fansly.com:443", "widget.thirdparty.net:443"]);
const socksConnects: string[] = [];
const socksSockets = new Set<Socket>();
const socks = createTcpServer((socket) => {
  socksSockets.add(socket);
  socket.on("close", () => socksSockets.delete(socket));
  socket.on("error", () => undefined);
  let buffered = Buffer.alloc(0);
  let step: "greeting" | "auth" | "connect" = "greeting";
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (step === "greeting") {
      const count = buffered[1];
      if (count === undefined || buffered.length < 2 + count) return;
      const methods = [...buffered.subarray(2, 2 + count)];
      buffered = buffered.subarray(2 + count);
      if (!methods.includes(2)) return void socket.end(Buffer.from([5, 0xff]));
      socket.write(Buffer.from([5, 2]));
      step = "auth";
    }
    if (step === "auth") {
      const userLength = buffered[1];
      if (userLength === undefined) return;
      const passLength = buffered[2 + userLength];
      if (passLength === undefined || buffered.length < 3 + userLength + passLength) return;
      const username = buffered.subarray(2, 2 + userLength).toString();
      const password = buffered.subarray(3 + userLength, 3 + userLength + passLength).toString();
      buffered = buffered.subarray(3 + userLength + passLength);
      if (username !== SOCKS_USER || password !== SOCKS_PASSWORD) return void socket.end(Buffer.from([1, 1]));
      socket.write(Buffer.from([1, 0]));
      step = "connect";
    }
    if (step === "connect") {
      // A domain name only (ATYP 3): the proxy never resolves.
      const nameLength = buffered[4];
      if (nameLength === undefined || buffered.length < 7 + nameLength) return;
      const target = `${buffered.subarray(5, 5 + nameLength).toString()}:${buffered.readUInt16BE(5 + nameLength)}`;
      buffered = buffered.subarray(7 + nameLength);
      socksConnects.push(target);
      const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
      if (!SERVED.has(target)) return void socket.end(reply(2));
      socket.off("data", onData);
      socket.pause();
      const upstream = tcpConnect({ host: "127.0.0.1", port: serverPort }, () => {
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
});
await new Promise<void>((resolve) => socks.listen(0, "127.0.0.1", () => resolve()));
const socksPort = (socks.address() as { port: number }).port;

// ── the operator's proxy and gate ─────────────────────────────────────────

const tunnels: Array<{ host: string; result: string; refused: boolean; held: number }> = [];
const egress = new Egress({ classify: classifyFanslyHost, onRecord: (record) => tunnels.push({ host: record.host, result: record.result, refused: record.refused, held: record.held }) });
egress.setSocks({ ip: "127.0.0.1", port: socksPort, username: SOCKS_USER, password: SOCKS_PASSWORD });
const proxyPort = await egress.listen(0, "127.0.0.1");
egress.openExit();

// ── Chrome, and CDP straight to it (no holder here) ───────────────────────

const profile = join(work, "profile");
const chromeArgs = [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  `--proxy-server=http://127.0.0.1:${proxyPort}`,
  // No name is resolved by Chrome itself: through the proxy, or not at all.
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
  "--ignore-certificate-errors",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  ...(process.argv.includes("--no-sandbox") ? ["--no-sandbox"] : []),
  "about:blank",
];
const chromeErr: string[] = [];
const chrome: ChildProcess = spawn(CHROME, chromeArgs, { stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr?.on("data", (part: Buffer) => {
  chromeErr.push(part.toString());
  if (chromeErr.length > 200) chromeErr.shift();
});

async function shutdown(): Promise<void> {
  chrome.kill();
  if (chrome.exitCode === null && chrome.signalCode === null) await new Promise((resolve) => chrome.once("exit", resolve));
  for (const socket of socksSockets) socket.destroy();
  await new Promise<void>((resolve) => socks.close(() => resolve()));
  server.close();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Chrome's last writes.
  }
}

async function cannotRun(why: string): Promise<never> {
  console.error(`site-check: ${why}`);
  if (chromeErr.length > 0) console.error(chromeErr.join("").split("\n").slice(-20).join("\n"));
  await shutdown();
  process.exit(2);
}

// Chrome writes its port and browser path to DevToolsActivePort.
let wsUrl = "";
for (let i = 0; i < 150 && wsUrl === ""; i++) {
  if (chrome.exitCode !== null) break;
  try {
    const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
    if (port && path) wsUrl = `ws://127.0.0.1:${port}${path}`;
  } catch {
    await sleep(100);
  }
}
if (wsUrl === "") await cannotRun("Chrome did not start (no DevToolsActivePort)");

/** CDP over Chrome's own WebSocket, in the shape cdp/client.ts gives. */
class DirectCdp implements CdpPort {
  readonly #ws: WebSocket;
  #nextId = 0;
  #seq = 0;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string; timer: NodeJS.Timeout | null }>();
  readonly #handlers = new Map<string, EventHandler[]>();

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (message) => this.#onMessage(String(message.data));
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.#nextId;
      const timer = timeoutMs === undefined ? null : setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method, timer });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, handler: EventHandler): void {
    this.#handlers.set(method, [...(this.#handlers.get(method) ?? []), handler]);
  }

  ack(): void {}

  holdAcks(): void {}

  #onMessage(text: string): void {
    const data = JSON.parse(text) as { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    if (data.id !== undefined) {
      const waiter = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      if (!waiter) return;
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      if (data.error) waiter.reject(new CdpError(waiter.method, data.error.code, data.error.message));
      else waiter.resolve(data.result ?? {});
      return;
    }
    if (data.method === undefined) return;
    const event: CdpEvent = { method: data.method, params: data.params ?? {}, ...(data.sessionId ? { sessionId: data.sessionId } : {}), seq: ++this.#seq, replayed: false };
    for (const handler of this.#handlers.get(event.method) ?? []) handler(event);
  }
}

const ws = new WebSocket(wsUrl);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("CDP's WebSocket failed"));
}).catch((error: unknown) => cannotRun(String(error)));
const cdp = new DirectCdp(ws);

// ── the buffer, the interception, the site path, an engine ────────────────

interface Admission {
  id: string;
  attemptId: number;
  mono: number;
  route: string;
  method: string;
  path: string;
  endedMono: number | null;
}
const committed: SiteDone[] = [];
const admissions: Admission[] = [];
const asks: SiteAdmit[] = [];
const faults: string[] = [];
const journal: RequestLine[] = [];
let mode: OperatorMode = "automation";

/** The engine's stand-in: one admission at a time, each 120 ms after its
 *  ask (the pacer's pause, shortened); `hold` keeps them back. */
const engine = {
  queue: [] as SiteAdmit[],
  inFlight: null as string | null,
  attempt: 1000,
  hold: false,
  asked(ask: SiteAdmit): void {
    this.queue.push(ask);
    this.next();
  },
  next(): void {
    if (this.inFlight !== null || this.hold) return;
    const ask = this.queue.shift();
    if (!ask) return;
    this.inFlight = ask.siteRequestId;
    setTimeout(() => {
      const attemptId = ++this.attempt;
      admissions.push({ id: ask.siteRequestId, attemptId, mono: monoMs(), route: ask.route, method: ask.method, path: ask.path, endedMono: null });
      site.onAdmitResult({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: ask.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId });
    }, 120);
  },
  ended(done: SiteDone): void {
    const admission = admissions.find((entry) => entry.attemptId === done.attemptId);
    if (admission) admission.endedMono = monoMs();
    if (this.inFlight === done.siteRequestId) this.inFlight = null;
    this.next();
  },
};

const buffer = new EventBuffer({
  dir: join(work, "buffer"),
  idFile: join(work, "buffer-id"),
  batchMs: 5,
  minFreeBytes: 0,
  log: () => undefined,
  onCommitted: ({ outcomes }) => {
    for (const outcome of outcomes) {
      const done = JSON.parse(outcome.json) as SiteDone;
      committed.push(done);
      engine.ended(done);
    }
  },
});
buffer.start();
const session = new SiteSession();
const paused = new PausedRequests(cdp, { decide: (request) => site.decide(request) ?? { action: "fail", reason: "BlockedByClient", why: "nobody's" }, log: () => undefined });
const site: SiteRequests = new SiteRequests({
  cdp,
  resolve: (request, decision) => paused.resolve(request, decision),
  gate: egress.gate,
  cutApi: (reason) => egress.cutClass("api", reason),
  buffer,
  link: {
    up: () => true,
    epoch: () => 1,
    generation: () => 1,
    send: (message) => {
      if (message.type === "siteAdmit") {
        asks.push(message);
        engine.asked(message);
      }
      return true;
    },
  },
  notUp: () => null,
  session: { fingerprint: () => session.fingerprint, note: (request) => session.note(request) },
  mode: () => mode,
  fault: (reason, note) => faults.push(`${reason}: ${note}`),
  journal: (line) => journal.push(line),
  timings: { opLimitMs: 6000 },
});
egress.gate.onEvent = (event) => site.onGateEvent(event);

const ends: string[] = [];
const urlOf = new Map<string, string>();
cdp.on("Network.requestWillBeSent", (event) => {
  const params = event.params as { requestId: string; request: { url: string; method: string } };
  urlOf.set(params.requestId, `${params.request.method} ${new URL(params.request.url).pathname}`);
});
cdp.on("Network.loadingFailed", (event) => {
  const params = event.params as { requestId: string; errorText: string; canceled?: boolean };
  ends.push(`${urlOf.get(params.requestId) ?? "?"}: failed ${params.errorText}${params.canceled ? " (canceled)" : ""}`);
});

// ── the targets, as cdp/control.ts sets a browser up ──────────────────────

const sessionOfTarget = new Map<string, string>();
cdp.on("Target.attachedToTarget", (event) => {
  const params = event.params as { sessionId: string; targetInfo: { targetId: string; type: string }; waitingForDebugger: boolean };
  const target = params.sessionId;
  const type = params.targetInfo.type;
  sessionOfTarget.set(params.targetInfo.targetId, target);
  void (async () => {
    try {
      if (["page", "iframe", "worker", "shared_worker", "service_worker"].includes(type)) await cdp.send("Network.enable", { maxTotalBufferSize: 100 * 1024 * 1024, maxResourceBufferSize: 20 * 1024 * 1024 }, target);
      if (type === "page" || type === "iframe") await cdp.send("Page.enable", {}, target);
      if (type !== "browser") await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "service_worker", exclude: true }, {}] }, target).catch(() => undefined);
      if (params.waitingForDebugger) await cdp.send("Runtime.runIfWaitingForDebugger", {}, target);
    } catch (error) {
      console.log(`site-check: a ${type} target was not set up: ${String(error)}`);
    }
  })();
});
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
const created = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
for (let i = 0; i < 100 && !sessionOfTarget.has(created.targetId); i++) await sleep(20);
const tab = sessionOfTarget.get(created.targetId) ?? "";
if (tab === "") await cannotRun("the work tab was not attached");
await sleep(300);

const evaluate = async (expression: string, awaitPromise = false): Promise<unknown> => {
  const reply = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, tab);
  return reply.result?.value;
};
const mark = () => ({ arrivals: arrivals.length, admissions: admissions.length, done: committed.length, asks: asks.length });
const endsOf = (from: number) => committed.slice(from).map((done) => ({ sent: done.sent, status: done.status, body: done.body, error: done.error?.message ?? null }));

// ── phase 1: the site's load, a burst and then one by one ─────────────────

type PageResult = { status?: number; bytes?: number; sha?: string; error?: string };
const navigated = await cdp.send<{ errorText?: string }>("Page.navigate", { url: "https://fansly.com/" }, tab);
if (navigated.errorText) await cannotRun(`the site did not load: ${navigated.errorText}`);
const deadline = Date.now() + 90_000;
let results: Record<string, PageResult>;
for (;;) {
  const state = JSON.parse(String(await evaluate("JSON.stringify({ done: window.done === true, results: window.results ?? {} })"))) as { done?: boolean; results?: Record<string, PageResult> };
  results = state.results ?? {};
  if (state.done || Date.now() > deadline) break;
  await sleep(250);
}
await sleep(500);
await buffer.flush();
const phase1Done = committed.length;

// ── phase 2: what the site does to its own requests ───────────────────────

const phase2: Record<string, unknown> = {};
// a. The page aborts a request that still waits for its admission.
let before = mark();
engine.hold = true;
await evaluate(`(() => { const x = new XMLHttpRequest(); x.open("GET", API + "/account/me?abort=1"); for (const [k, v] of Object.entries(H)) x.setRequestHeader(k, v); x.send(); setTimeout(() => x.abort(), 400); return true; })()`);
await sleep(900);
const abortWaiting = { asked: asks.length - before.asks, live: site.live, arrived: arrivals.length - before.arrivals };
engine.hold = false;
engine.next();
await sleep(600);
const abortWaitingAfter = { admissions: admissions.length - before.admissions, done: endsOf(before.done), arrived: arrivals.slice(before.arrivals).map((arrival) => `${arrival.method} ${arrival.path}`), live: site.live };
// b. The site replaces its document while a request of the old one waits.
before = mark();
engine.hold = true;
await evaluate(`(() => { void xhr("old", "GET", "/subscribers?old=1"); return true; })()`);
await sleep(400);
await cdp.send("Page.navigate", { url: "https://fansly.com/?idle=1" }, tab);
await sleep(600);
const replaced = { asked: asks.length - before.asks, live: site.live };
engine.hold = false;
engine.next();
await sleep(1000);
const replacedAfter = { done: endsOf(before.done), arrived: arrivals.slice(before.arrivals).filter((arrival) => arrival.host === "apiv3.fansly.com").map((arrival) => `${arrival.method} ${arrival.path}`), live: site.live };
// The new document's own request goes as any.
await evaluate(`xhr("fresh", "GET", "/account/me?fresh=1")`, true);
phase2.fresh = await evaluate("JSON.stringify(window.results.fresh)");
// c. A third-party request with a preflight: passed, its preflight handed on.
before = mark();
phase2.thirdParty = await evaluate(`fetch("https://widget.thirdparty.net/collect", { method: "POST", headers: { "content-type": "application/json", "x-widget": "1" }, body: "{}" }).then((r) => r.status, (e) => String(e))`, true);
phase2.thirdPartyArrived = arrivals.slice(before.arrivals).map((arrival) => `${arrival.method} ${arrival.host}${arrival.path}`);
await evaluate(`xhr("afterThird", "GET", "/account/me?after=1")`, true);
phase2.afterThird = await evaluate("JSON.stringify(window.results.afterThird)");
// d. Two requests of one method and URL at once, each with its preflight:
// each is its own operation, under its own admission (Astra's review of PR 7).
before = mark();
await evaluate(`Promise.all([xhr("twinA", "GET", "/account/me?twin=1"), xhr("twinB", "GET", "/account/me?twin=1")])`, true);
await sleep(300);
const twins = {
  asked: asks.length - before.asks,
  admissions: admissions.length - before.admissions,
  arrived: arrivals.slice(before.arrivals).map((arrival) => arrival.method),
  done: committed.filter((done) => admissions.slice(before.admissions).some((admission) => admission.attemptId === done.attemptId)).map((done) => ({ sent: done.sent, status: done.status, body: done.body })),
  page: [String(await evaluate("JSON.stringify(window.results.twinA)")), String(await evaluate("JSON.stringify(window.results.twinB)"))],
};
// e. The page cancels a released request before its answer: the strict rule stops the page.
before = mark();
await evaluate(`(() => { const x = new XMLHttpRequest(); x.open("GET", API + "/vault/albumsnew"); for (const [k, v] of Object.entries(H)) x.setRequestHeader(k, v); x.send(); window.slowXhr = x; return true; })()`);
for (let i = 0; i < 100 && !arrivals.slice(before.arrivals).some((arrival) => arrival.method === "GET" && arrival.path === "/api/v1/vault/albumsnew"); i++) await sleep(50);
await evaluate("(() => { window.slowXhr.abort(); return true; })()");
await sleep(1500);
const cancelReleased = { faults: [...faults], done: endsOf(before.done) };
const faultsBeforeCancel = faults.filter((fault) => !fault.includes("cancelled a released request"));

// ── phase 3: a service worker's and a worker's requests, big bodies ───────

const phase3: Record<string, unknown> = {};
await cdp.send("Page.navigate", { url: "https://fansly.com/?idle=2" }, tab);
await sleep(500);
phase3.swReady = await evaluate(`navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(() => new Promise((r) => { if (navigator.serviceWorker.controller) r(true); else navigator.serviceWorker.addEventListener("controllerchange", () => r(true)); setTimeout(() => r(!!navigator.serviceWorker.controller), 3000); }))`, true);
await evaluate(`xhr("viaSw", "GET", "/account/me?viasw=1")`, true);
phase3.viaSw = await evaluate("JSON.stringify(window.results.viaSw)");
before = mark();
phase3.viaWorker = await evaluate(`new Promise((resolve) => { const w = new Worker("/worker.js"); w.onmessage = (m) => resolve(JSON.stringify(m.data)); w.postMessage({ url: API + "/notifications?worker=1", headers: H }); setTimeout(() => resolve("timeout"), 8000); })`, true);
await sleep(300);
phase3.viaWorkerDone = endsOf(before.done);
before = mark();
await evaluate(`xhr("huge", "GET", "/media/vaultnew?huge=1")`, true);
phase3.huge = await evaluate("JSON.stringify(window.results.huge)");
for (let i = 0; i < 8; i++) await evaluate(`xhr("large${i}", "GET", "/vault/albumsnew2?n=${i}")`, true);
await sleep(500);
const bigDone = committed.slice(before.done).map((done) => `${String(done.status)}:${done.body}`);
before = mark();
await evaluate(`xhr("cache1", "GET", "/lists/account?c=1")`, true);
await evaluate(`xhr("cache2", "GET", "/lists/account?c=1")`, true);
await sleep(300);
const cache = { page: [await evaluate("JSON.stringify(window.results.cache1)"), await evaluate("JSON.stringify(window.results.cache2)")], done: endsOf(before.done), arrived: arrivals.slice(before.arrivals).filter((arrival) => arrival.method === "GET").map((arrival) => `${arrival.path} if-none-match=${String(arrival.headers.includes("if-none-match"))}`) };

// ── phase 4: the wait's end, the login ───────────────────────────────────

site.setTimings(700, 20_000);
engine.hold = true;
before = mark();
const waitStarted = Date.now();
await evaluate(`xhr("waited", "GET", "/account/me?wait=1")`, true);
const waited = { result: String(await evaluate("JSON.stringify(window.results.waited)")), afterMs: Date.now() - waitStarted, arrived: arrivals.length - before.arrivals };
engine.hold = false;
engine.next();
await sleep(500);
const waitedLate = endsOf(before.done);
site.setTimings(60_000, 20_000);
// The login: closed in the automation mode, an operation in the manual login.
before = mark();
const login = JSON.stringify({ username: "stand", password: PAGE_PASSWORD });
await evaluate(`xhr("loginAutomation", "POST", "/login", ${JSON.stringify(login)})`, true);
const loginAutomation = { result: String(await evaluate("JSON.stringify(window.results.loginAutomation)")), arrived: arrivals.length - before.arrivals };
mode = "manual_login";
before = mark();
await evaluate(`xhr("login", "POST", "/login", ${JSON.stringify(login)})`, true);
await sleep(300);
const lastAsk = asks.at(-1);
const manualLogin = {
  result: String(await evaluate("JSON.stringify(window.results.login)")),
  arrived: arrivals.slice(before.arrivals).map((arrival) => `${arrival.method} ${arrival.path}`),
  done: endsOf(before.done),
  bodyArrived: loginBodies.length === 1 && loginBodies[0]!.includes(PAGE_PASSWORD),
  ask: lastAsk ? { method: lastAsk.method, route: lastAsk.route, operation: lastAsk.operation } : null,
};
mode = "automation";
if (verbose) console.log(JSON.stringify({ phase2, phase3, cache, waited, waitedLate, loginAutomation, manualLogin }, null, 1));

// ── the comparison ───────────────────────────────────────────────────────

const problems: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) problems.push(what);
};
const api = arrivals.filter((arrival) => arrival.host === "apiv3.fansly.com");
const mains = api.filter((arrival) => arrival.method !== "OPTIONS");
const preflights = api.filter((arrival) => arrival.method === "OPTIONS");
console.log(`Chrome ${CHROME}; server: ${arrivals.length} requests, ${mains.length} API requests, ${preflights.length} preflights; ${asks.length} asks, ${admissions.length} admissions`);
// Every API request and preflight that reached the server did so inside an admission of its path.
const within = (admission: Admission, arrival: Arrival) => admission.path === arrival.path && admission.mono <= arrival.mono && (admission.endedMono === null || arrival.mono <= admission.endedMono + 50);
for (const arrival of api) {
  const inside = admissions.find((admission) => within(admission, arrival));
  check(inside !== undefined, `${arrival.method} ${arrival.path} reached the server inside an admission (${inside ? `attempt ${inside.attemptId}, ${Math.round(arrival.mono - inside.mono)} ms after it` : "none"})`);
}
// One admission: at most one request and one preflight.
for (const admission of admissions) {
  const during = api.filter((arrival) => within(admission, arrival));
  check(during.filter((arrival) => arrival.method !== "OPTIONS").length <= 1 && during.filter((arrival) => arrival.method === "OPTIONS").length <= 1, `attempt ${admission.attemptId} (${admission.method} ${admission.path}): ${during.map((arrival) => arrival.method).join("+") || "nothing"} on the wire`);
}
const CLOSED = ["/api/v1/message/ack", "/api/v1/message", "/api/v1/emails/unsubscribe"];
check(mains.every((arrival) => !CLOSED.includes(arrival.path)), "nothing the map closes reached the server (the ack, a write, the closed read)");
check(preflights.every((arrival) => !CLOSED.includes(arrival.path)), "nor their preflights");
check(arrivals.some((arrival) => arrival.host === "widget.thirdparty.net") && arrivals.some((arrival) => arrival.host === "fansly.com" && arrival.path === "/main.js"), "the page's script and the third-party host passed");
// Chrome's own requests (Google's hosts) go through the proxy too; the
// SOCKS5 refuses them, as it refuses anything but the server's hosts.
const elsewhere = [...new Set(socksConnects.filter((target) => !SERVED.has(target)))];
console.log(`Chrome's own hosts, refused by the SOCKS5: ${elsewhere.join(", ") || "none"}`);
check(faultsBeforeCancel.length === 0, `no fault stopped the page before the cancel of a released request (${faultsBeforeCancel.join("; ") || "none"})`);
check(abortWaiting.asked === 1 && abortWaiting.arrived === 0 && abortWaiting.live === 0, `a request the page aborted while it waited: ended at once, nothing sent (${JSON.stringify(abortWaiting)})`);
check(abortWaitingAfter.arrived.length === 0 && abortWaitingAfter.done.every((done) => !done.sent), `its late admission is not used: ${JSON.stringify(abortWaitingAfter)}`);
check(replaced.asked === 1 && replaced.live === 0, `a request of a replaced document: failed when its document went (${JSON.stringify(replaced)})`);
check(replacedAfter.arrived.every((line) => !line.includes("/subscribers")) && replacedAfter.done.every((done) => !done.sent), `and never released: ${JSON.stringify(replacedAfter)}`);
check(String(phase2.fresh).includes('"status":200'), `the new document's request went: ${String(phase2.fresh)}`);
check(phase2.thirdParty === 200 && (phase2.thirdPartyArrived as string[]).join(",") === "OPTIONS widget.thirdparty.net/collect,POST widget.thirdparty.net/collect", `a third-party request with a preflight passed: ${String(phase2.thirdParty)} ${JSON.stringify(phase2.thirdPartyArrived)}`);
check(String(phase2.afterThird).includes('"status":200'), `and Chrome's network service lives after it: ${String(phase2.afterThird)}`);
check(twins.asked === 2 && twins.admissions === 2 && twins.arrived.filter((method) => method === "GET").length === 2 && twins.done.length === 2 && twins.done.every((done) => done.sent && done.status === 200) && twins.page.every((page) => page.includes('"status":200')), `two requests of one URL at once, each with its preflight: two operations, two admissions, each its own request: ${JSON.stringify(twins)}`);
const swDone = committed.find((done) => asks.find((ask) => ask.siteRequestId === done.siteRequestId)?.query === "?viasw=1");
check(phase3.swReady === true && String(phase3.viaSw).includes('"status":200') && swDone?.status === 200 && swDone.body === "incomplete", `a request the site's service worker passes on is admitted; its body, which only the page's own request gets, is a mark, never an empty fact: ${JSON.stringify(swDone ?? null)}`);
check(String(phase3.viaWorker).includes('"status":429') && JSON.stringify(phase3.viaWorkerDone).includes('"status":429,"body":"buffered"'), `a worker's request is admitted and its answer kept: ${String(phase3.viaWorker)} ${JSON.stringify(phase3.viaWorkerDone)}`);
check(String(phase3.huge).includes(`"bytes":${40 * 1024 * 1024}`) && bigDone.join(",") === Array.from({ length: 9 }, () => "200:buffered").join(","), `a 40 MiB answer and eight of 15 MiB in a row (past Chrome's 100 MB of buffers) are kept whole: ${JSON.stringify(bigDone)}`);
check(waited.result.includes("network") && waited.afterMs >= 650 && waited.afterMs < 2500 && waited.arrived === 0, `a request nobody admits fails when its wait is over (${waited.afterMs} ms): ${waited.result}`);
check(JSON.stringify(waitedLate).includes('"sent":false'), `and its late admission is not used: ${JSON.stringify(waitedLate)}`);
check(loginAutomation.result.includes("network") && loginAutomation.arrived === 0, `the login is closed in the automation mode: ${loginAutomation.result}`);
check(manualLogin.result.includes('"status":200') && manualLogin.bodyArrived && JSON.stringify(manualLogin.done).includes('"status":200,"body":"not_platform_data"') && JSON.stringify(manualLogin.ask) === JSON.stringify({ method: "POST", route: "auth.login", operation: "login" }), `the login goes in the manual login, its body whole, its answer not kept: ${JSON.stringify({ ...manualLogin, bodyArrived: manualLogin.bodyArrived })}`);
const said = `${logLines.join("\n")}\n${JSON.stringify(journal)}`;
check([PAGE_PASSWORD, PAGE_TOKEN, ISSUED_TOKEN].every((secret) => !said.includes(secret)), "no password, token or session in the log or the journal");
check(cancelReleased.faults.some((fault) => fault.includes("request_unended") && fault.includes("cancelled a released request")), `the page's cancel of a released request before its answer stops the page: ${JSON.stringify(cancelReleased)}`);
// The page's own results.
const expectPage: Record<string, { status?: number; error?: string }> = {
  me: { status: 200 },
  groups: { status: 200 },
  other: { status: 200 },
  ack: { error: "network" },
  write: { error: "network" },
  unsubscribe: { error: "network" },
  limited: { status: 429 },
  stream: { status: 200 },
  streamGzip: { status: 200 },
  redirect: { status: 302 },
  device: { status: 200 },
  meAgain: { status: 200 },
  cachedPreflight: { status: 200 },
  cachedPreflight2: { status: 200 },
};
for (const [name, expected] of Object.entries(expectPage)) {
  const got = results[name];
  check(got !== undefined && got.status === expected.status && (expected.error === undefined || got.error !== undefined), `the page got ${name}: ${JSON.stringify(got)}`);
}
// The answers kept: whole, the bytes the server sent — or a mark without a body.
const events: Array<Record<string, unknown> & { bodyId: string | null }> = buffer.readEvents(0, 1000, Number.MAX_SAFE_INTEGER).map((event) => ({ ...(JSON.parse(event.json) as Record<string, unknown>), bodyId: event.bodyId ?? null }));
const responses = events.filter((event) => event.kind === "site.response");
console.log(`buffer: ${events.length} events, ${responses.length} site.response; ${committed.length} siteDone`);
for (const response of responses) {
  const body = response.body as { decodedBytes: number; sha256: string };
  const sent = sentBodies.get(`${String(response.method)} ${String(response.path)}`);
  const kept = response.bodyId === null ? null : buffer.readBody(response.bodyId, 0, 256 * 1024 * 1024);
  const same = response.complete === true ? kept !== null && sent !== undefined && sha(kept) === sha(sent) && sha(kept) === body.sha256 && kept.length === body.decodedBytes : response.bodyId === null;
  const pageRead = Object.entries(results).find(([, got]) => got.sha === body.sha256)?.[0] ?? "-";
  check(same, `site.response ${String(response.route)} ${String(response.status)}: ${response.complete === true ? `whole, ${body.decodedBytes} bytes, the server's (the page read it: ${pageRead})` : "a mark, no body"}; source ${String(response.source)}`);
}
check(responses.filter((response) => response.complete === true).length >= 8, "at least 8 answers kept whole");
check(!responses.some((response) => String(response.path).endsWith("/device/id")), "the device id's answer was not kept");
check(responses.every((response) => response.source === "network"), `every answer's source is the network (${[...new Set(responses.map((response) => String(response.source)))].join(", ")})`);
const doneOf = (path: string) => committed.filter((done) => admissions.find((admission) => admission.attemptId === done.attemptId)?.path === path);
check(doneOf("/api/v1/notifications").some((done) => done.status === 429 && done.retryAfter === "7" && done.sent), `siteDone of the 429 carries Retry-After: ${JSON.stringify(doneOf("/api/v1/notifications")[0] ?? null)}`);
check(doneOf("/api/v1/post").some((done) => done.status === 302), "siteDone of the redirect has its status (not followed)");
check(!arrivals.some((arrival) => arrival.path === "/api/v1/elsewhere"), "the redirect's next hop never left");
check(phase1Done > 0 && committed.slice(0, phase1Done).every((done) => done.sent && typeof done.sentMono === "number"), `every siteDone of the site's load says sent, with Chrome's moment (${phase1Done})`);
const armFailed = logLines.filter((line) => line.includes("body.arm_failed")).length;
check(armFailed === 0, `no stream failed to arm (${armFailed})`);
if (verbose) {
  console.log(`cache: ${JSON.stringify(cache)}`);
  console.log(`tunnels: ${tunnels.length}, refused ${tunnels.filter((tunnel) => tunnel.refused).length}, held bytes ${tunnels.reduce((sum, tunnel) => sum + tunnel.held, 0)}`);
  console.log(`API requests Chrome ended as failed: ${ends.filter((line) => line.includes("/api/")).join(" | ") || "none"}`);
}
console.log(problems.length === 0 ? "ALL OK" : `${problems.length} FAILED`);

ws.close();
await buffer.close();
await egress.close();
await shutdown();
process.exit(problems.length === 0 ? 0 : 1);
