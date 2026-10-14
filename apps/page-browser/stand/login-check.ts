// The login check (Project Browser PR 15; plan §4.8, spec §2.4, §6.1, §7):
// the login form's input path on a real Chrome, local. Run by
// stand/login-check.sh — on this machine's Chrome, or in the image with its
// Chrome — or by hand:
//
//   node --no-warnings login-check.ts --chrome <path> [--no-sandbox] [--verbose]
//
// What runs: a real Chrome (headless=new, a throwaway profile) behind the
// operator's real proxy and API gate (egress/), its real interception
// (cdp/paused.ts) and site path (intercept/site.ts) in the manual login,
// the real buffer (buffer/) and the real login desk (login/desk.ts) — its
// probe and locator in an isolated world, DOM.focus, Input.insertText,
// DOM.getBoxModel and Input.dispatchMouseEvent at the button's centre,
// Page.captureScreenshot — against one local TLS server that plays
// fansly.com (a login page of this script's: the login form, the code form,
// the site's error, the success) and apiv3.fansly.com (its `POST /login` and
// `POST /login/twofa`, with their CORS preflights), reached through a SOCKS5
// listener of this script's that connects only to that server. An engine of
// this script's admits the site's requests one at a time. Markers stand for
// what the owner types: no credential anywhere.
//
// What it proves:
//   - the screens are recognized on a real DOM: the login, the error with
//     its text, the code, the success; a captcha frame makes the screen
//     unknown, and nothing is typed or pressed there;
//   - what the desk typed is what the site's own request carried, byte for
//     byte (the login and the password of `POST /login`, the code of
//     `POST /login/twofa`): the focus, the insertion and the press reach the
//     page as a person's would, and the site sends them itself;
//   - those requests went only under an admission each, as login
//     operations, with their preflights — none in the automation mode;
//   - the site's read after the login (its interface's, PR 15) under an
//     admission of its own too, its answer to the buffer; the account
//     loaded under the new session is a success;
//   - an act is checked at its moment: an overlay that comes with the
//     pointer onto the button stops the press, a field that gave its focus
//     away gets nothing typed, a call that may act no more stops at its
//     next input step;
//   - the screenshot is a JPEG of the page;
//   - no marker in the log or the journal, nor in the buffer's files.
//
// What it does not prove: no holder, no rules extension, no nftables, not
// the full Operator (no RPC: the desk is driven here directly, the mode is
// this script's), not Fansly's own login screen — its signs are checked on
// the test account (spec §7) — headless Chrome, no X server.
//
// Prints what it compared, one line each; exits 0 when all held, 1 when any
// did not, 2 when it could not run.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import http2 from "node:http2";
import { connect as tcpConnect, createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBuffer } from "../src/buffer/buffer.ts";
import { CdpError, type CdpEvent, type CdpPort, type EventHandler } from "../src/cdp/client.ts";
import { PausedRequests } from "../src/cdp/paused.ts";
import { classifyFanslyHost } from "../src/egress/hosts.ts";
import { Egress } from "../src/egress/proxy.ts";
import { SiteSession } from "../src/hub-requests/session.ts";
import { SiteRequests } from "../src/intercept/site.ts";
import { LoginDesk, type LoginGuard, type LoginOutcome } from "../src/login/desk.ts";
import type { RequestLine } from "../src/logs/journal.ts";
import type { OperatorMode } from "../src/policy/operations.ts";
import type { SiteAdmit, SiteDone } from "../src/rpc/protocol.ts";
import { monoMs, setLogSink } from "../src/shared/util.ts";

function argument(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

const CHROME = argument("--chrome");
const verbose = process.argv.includes("--verbose");
if (CHROME === null || !existsSync(CHROME)) {
  console.error(`login-check: no Chrome at ${CHROME ?? "(none given: --chrome <path>)"}`);
  process.exit(2);
}

const logLines: string[] = [];
setLogSink((line) => {
  logLines.push(line);
  if (verbose) console.log(line);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const work = mkdtempSync(join(tmpdir(), "pb-login-check-"));

// Markers for what the owner types; never anyone's.
const LOGIN = "stand-login-marker-7f21";
const PASSWORD = "stand-password-marker-c94e0d";
const WRONG = "stand-wrong-marker-11aa";
const CODE = "482913";
const ISSUED_TOKEN = "stand-issued-token-not-a-secret-5e";

// ── the certificate ───────────────────────────────────────────────────────

const KEY = join(work, "key.pem");
const CERT = join(work, "cert.pem");
const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=fansly.com", "-addext", "subjectAltName=DNS:fansly.com,DNS:*.fansly.com", "-keyout", KEY, "-out", CERT], { stdio: "pipe" });
if (made.status !== 0) {
  console.error(`login-check: openssl made no certificate: ${String(made.stderr)}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

// ── the server: fansly.com's login page, apiv3.fansly.com's login ────────

interface Arrival {
  method: string;
  host: string;
  path: string;
}
const arrivals: Arrival[] = [];
const loginBodies: Array<Record<string, unknown>> = [];

// The page: Angular-like forms, the site's own XHR to the API, its error
// under the form, the code form after the login, no form once logged in.
const PAGE = String.raw`<!doctype html><html><head><title>stand login</title>
<style>body{font:16px sans-serif;margin:40px} form{width:360px;padding:20px;border:1px solid #ccc} input{display:block;width:320px;margin:8px 0;padding:6px} button{padding:8px 24px} .error{color:#b00}</style>
</head><body><div id="app"></div><script>
const API = "https://apiv3.fansly.com/api/v1";
const app = document.getElementById("app");
let twofaToken = null;
function post(path, body) {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("POST", API + path);
    x.setRequestHeader("content-type", "application/json");
    x.onload = () => resolve(JSON.parse(x.responseText));
    x.onerror = () => resolve({ success: false, error: { details: "network" } });
    x.send(JSON.stringify(body));
  });
}
function loginForm(error) {
  app.innerHTML = '<form id="login"><h3>Log in</h3>' +
    '<input type="text" name="username" autocomplete="username" placeholder="Username or Email">' +
    '<input type="password" name="password" autocomplete="current-password" placeholder="Password">' +
    (error ? '<div class="error">' + error + '</div>' : '') +
    '<button type="submit">Log In</button></form>';
  document.getElementById("login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const answer = await post("/login", { username: form.username.value, password: form.password.value, deviceId: "stand-device-1" });
    if (!answer.success) return loginForm(answer.error.details);
    twofaToken = answer.response.twofa.token;
    codeForm(null);
  });
}
function codeForm(error) {
  app.innerHTML = '<form id="code"><h3>Two Factor Authentication</h3>' +
    '<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Code">' +
    (error ? '<div class="error">' + error + '</div>' : '') +
    '<button type="submit">Submit</button></form>';
  document.getElementById("code").addEventListener("submit", async (event) => {
    event.preventDefault();
    const answer = await post("/login/twofa", { token: twofaToken, code: event.target.code.value });
    if (!answer.success) return codeForm(answer.error.details);
    app.innerHTML = '<h3>Home</h3><p>Logged in.</p>';
    // The site's own read under its new session.
    const x = new XMLHttpRequest();
    x.open("GET", API + "/account/me?ngsw-bypass=true");
    x.setRequestHeader("authorization", answer.response.token);
    x.setRequestHeader("fansly-client-id", "720000000000000009");
    x.send();
  });
}
if (location.search.includes("hover")) {
  // An overlay that comes with the pointer onto the button.
  loginForm(null);
  document.querySelector("#login button").addEventListener("mouseover", () => {
    const veil = document.createElement("div");
    veil.style.cssText = "position:fixed;inset:0;z-index:9;background:rgba(0,0,0,.3)";
    document.body.appendChild(veil);
  });
} else if (location.search.includes("steal")) {
  // The password field gives its focus away at once.
  loginForm(null);
  const decoy = document.createElement("div");
  decoy.tabIndex = -1;
  decoy.textContent = "help";
  document.body.appendChild(decoy);
  document.querySelector("#login input[type=password]").addEventListener("focus", () => decoy.focus());
} else if (location.search.includes("captcha")) {
  loginForm(null);
  const frame = document.createElement("iframe");
  frame.src = "https://www.google.com/recaptcha/api2/anchor?k=stand";
  frame.style.cssText = "width:300px;height:80px;border:1px solid #999";
  document.body.appendChild(frame);
} else loginForm(null);
</script></body></html>`;

const server = http2.createSecureServer({ key: readFileSync(KEY), cert: readFileSync(CERT), allowHTTP1: true });
server.on("request", (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  const host = String(req.headers[":authority"] ?? req.headers.host ?? "").replace(/:\d+$/, "");
  const url = new URL(req.url, `https://${host}`);
  const method = req.method;
  arrivals.push({ method, host, path: url.pathname });
  const cors = { "access-control-allow-origin": "https://fansly.com", "access-control-allow-headers": "content-type,authorization,fansly-client-id", "access-control-allow-methods": "GET,POST", "access-control-max-age": "0" };
  if (host === "fansly.com") {
    if (url.pathname === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    return void res.writeHead(404).end();
  }
  if (host !== "apiv3.fansly.com") return void res.writeHead(404).end();
  if (method === "OPTIONS") return void res.writeHead(204, cors).end();
  const json = (body: unknown) => void res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify(body));
  if (method === "POST") {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
      loginBodies.push({ path: url.pathname, ...body });
      if (url.pathname === "/api/v1/login") {
        if (body.username === LOGIN && body.password === PASSWORD) return json({ success: true, response: { twofa: { token: "stand-twofa-token" } } });
        return json({ success: false, error: { details: "Invalid username or password" } });
      }
      if (url.pathname === "/api/v1/login/twofa") {
        if (body.code === CODE && body.token === "stand-twofa-token") return json({ success: true, response: { token: ISSUED_TOKEN } });
        return json({ success: false, error: { details: "Invalid code" } });
      }
      json({ success: false });
    });
    return;
  }
  json({ success: true, response: {} });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const serverPort = (server.address() as { port: number }).port;

// ── the page's SOCKS5 (RFC 1929), the server only ─────────────────────────

const SOCKS_USER = "stand-user";
const SOCKS_PASSWORD = "stand-password";
const SERVED = new Set(["fansly.com:443", "apiv3.fansly.com:443"]);
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
      const nameLength = buffered[4];
      if (nameLength === undefined || buffered.length < 7 + nameLength) return;
      const target = `${buffered.subarray(5, 5 + nameLength).toString()}:${buffered.readUInt16BE(5 + nameLength)}`;
      buffered = buffered.subarray(7 + nameLength);
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

const egress = new Egress({ classify: classifyFanslyHost });
egress.setSocks({ ip: "127.0.0.1", port: socksPort, username: SOCKS_USER, password: SOCKS_PASSWORD });
const proxyPort = await egress.listen(0, "127.0.0.1");
egress.openExit();

// ── Chrome, and CDP straight to it ────────────────────────────────────────

const profile = join(work, "profile");
const chrome: ChildProcess = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  `--proxy-server=http://127.0.0.1:${proxyPort}`,
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
  "--ignore-certificate-errors",
  "--window-size=1280,800",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  ...(process.argv.includes("--no-sandbox") ? ["--no-sandbox"] : []),
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const chromeErr: string[] = [];
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
  await egress.close().catch(() => undefined);
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Chrome's last writes.
  }
}

async function cannotRun(why: string): Promise<never> {
  console.error(`login-check: ${why}`);
  if (chromeErr.length > 0) console.error(chromeErr.join("").split("\n").slice(-20).join("\n"));
  await shutdown();
  process.exit(2);
}

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
  readonly sent: string[] = [];

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (message) => this.#onMessage(String(message.data));
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number): Promise<T> {
    this.sent.push(method);
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

const asks: SiteAdmit[] = [];
const admitted: Array<{ id: string; route: string; operation: string; method: string; path: string }> = [];
const committed: SiteDone[] = [];
const readsEnded: Array<{ route: string; status: number | null; sent: boolean; session: string | null }> = [];
const journal: RequestLine[] = [];
let mode: OperatorMode = "manual_login";

const buffer = new EventBuffer({
  dir: join(work, "buffer"),
  idFile: join(work, "buffer-id"),
  batchMs: 5,
  minFreeBytes: 0,
  log: () => undefined,
  onCommitted: ({ outcomes }) => {
    for (const outcome of outcomes) committed.push(JSON.parse(outcome.json) as SiteDone);
  },
});
buffer.start();
const session = new SiteSession();
const paused = new PausedRequests(cdp, { decide: (request) => site.decide(request) ?? { action: "fail", reason: "BlockedByClient", why: "nobody's" }, log: () => undefined });
let attempt = 2000;
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
      if (message.type !== "siteAdmit") return true;
      asks.push(message);
      // The engine's stand-in: each admitted 100 ms after its ask.
      setTimeout(() => {
        admitted.push({ id: message.siteRequestId, route: message.route, operation: message.operation, method: message.method, path: message.path });
        site.onAdmitResult({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: message.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: ++attempt });
      }, 100);
      return true;
    },
  },
  notUp: () => null,
  session: { fingerprint: () => session.fingerprint, note: (request) => session.note(request) },
  mode: () => mode,
  fault: () => undefined,
  journal: (line) => journal.push(line),
  loginEnded: (end) => desk.loginEnded(end),
  readEnded: (end) => {
    readsEnded.push(end);
    desk.readEnded(end);
  },
});
egress.gate.onEvent = (event) => site.onGateEvent(event);

const sessionOfTarget = new Map<string, string>();
cdp.on("Target.attachedToTarget", (event) => {
  const params = event.params as { sessionId: string; targetInfo: { targetId: string; type: string }; waitingForDebugger: boolean };
  sessionOfTarget.set(params.targetInfo.targetId, params.sessionId);
  void (async () => {
    try {
      if (params.targetInfo.type === "page" || params.targetInfo.type === "iframe") {
        await cdp.send("Network.enable", { maxTotalBufferSize: 100 * 1024 * 1024, maxResourceBufferSize: 20 * 1024 * 1024 }, params.sessionId);
        await cdp.send("Page.enable", {}, params.sessionId);
      }
      if (params.waitingForDebugger) await cdp.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId);
    } catch (error) {
      console.log(`login-check: a target was not set up: ${String(error)}`);
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

/** The operator's isolated world in the tab's current document: made once
 *  a document, as cdp/control.ts keeps it (a new document, a new world). */
let worldId: number | null = null;
cdp.on("Page.frameNavigated", (event) => {
  const frame = (event.params as { frame?: { parentId?: string } }).frame;
  if (event.sessionId === tab && frame !== undefined && frame.parentId === undefined) worldId = null;
});
async function world(): Promise<number> {
  if (worldId !== null) return worldId;
  const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, tab);
  const made = await cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "pb-hub", grantUniveralAccess: false }, tab);
  worldId = made.executionContextId;
  return worldId;
}

const sessionAtStart = session.fingerprint;
const desk = new LoginDesk({ cdp, tab: () => tab, world, session: () => session.fingerprint, timings: { settleMs: 8000, pollMs: 100 } });
desk.begin();
/** The call may act (the operator's guard: its manual login lasts). */
const acting: LoginGuard = () => null;

async function load(url: string): Promise<void> {
  const navigated = await cdp.send<{ errorText?: string }>("Page.navigate", { url }, tab);
  if (navigated.errorText) await cannotRun(`the page did not load: ${navigated.errorText}`);
  for (let i = 0; i < 100; i++) {
    const ready = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: "document.readyState === 'complete' && !!document.querySelector('form')", returnByValue: true }, tab);
    if (ready.result?.value === true) return;
    await sleep(100);
  }
  await cannotRun("the login page did not come up");
}

// ── the run ─────────────────────────────────────────────────────────────────

const checks: Array<{ what: string; ok: boolean; detail: string }> = [];
const check = (what: string, ok: boolean, detail: unknown) => checks.push({ what, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
const screenOf = (outcome: LoginOutcome) => (outcome.kind === "state" ? `${outcome.screen} [${outcome.fields.join(",")}]${outcome.siteError ? ` "${outcome.siteError}"` : ""}` : outcome.kind === "refused" ? `refused: ${outcome.reason}` : "screenshot");

// 1. A captcha on the page: unknown, nothing typed, nothing pressed.
await load("https://fansly.com/?captcha=1");
const typedBefore = cdp.sent.filter((method) => method === "Input.insertText" || method === "Input.dispatchMouseEvent").length;
const captchaState = await desk.state();
const captchaSubmit = await desk.submit(LOGIN, PASSWORD, acting);
check("a captcha frame: the screen is unknown and nothing is typed or pressed", screenOf(captchaState).startsWith("unknown") && screenOf(captchaSubmit) === "refused: screen_changed" && cdp.sent.filter((method) => method === "Input.insertText" || method === "Input.dispatchMouseEvent").length === typedBefore, { state: screenOf(captchaState), submit: screenOf(captchaSubmit) });

// 2. The login screen, its screenshot.
await load("https://fansly.com/");
const loginState = await desk.state();
check("the login screen is recognized", screenOf(loginState) === "login [login,password]", screenOf(loginState));
const shot = await desk.screenshot();
const jpeg = shot.kind === "screenshot" ? shot.jpeg : Buffer.alloc(0);
check("the screenshot is a JPEG of the page", jpeg.length > 1000 && jpeg[0] === 0xff && jpeg[1] === 0xd8, { bytes: jpeg.length });

// 3. In the automation the map closes the login: nothing leaves.
mode = "automation";
const arrivedBefore = arrivals.filter((arrival) => arrival.path === "/api/v1/login").length;
const automationSubmit = await desk.submit(LOGIN, WRONG, acting);
await sleep(500);
check("in the automation the site's login is closed: nothing reaches the server", arrivals.filter((arrival) => arrival.path === "/api/v1/login").length === arrivedBefore && !asks.some((ask) => ask.path === "/api/v1/login"), { submit: screenOf(automationSubmit) });
mode = "manual_login";

// 3b. Acts are checked at the moment of the act (Astra's review of PR 15,
// items 3 and 4): an overlay that comes with the pointer onto the button, a
// password field that gives its focus away, a call that may act no more
// after its first field — nothing more is typed, nothing is pressed,
// nothing reaches the server.
const inputs = () => cdp.sent.filter((method) => method === "Input.insertText").length;
const presses = () => cdp.sent.filter((method) => method === "Input.dispatchMouseEvent").length;
const loginArrivals = () => arrivals.filter((arrival) => arrival.path === "/api/v1/login").length;
await load("https://fansly.com/?hover=1");
const hoverBefore = { inputs: inputs(), presses: presses(), logins: loginArrivals() };
const hoverSubmit = await desk.submit(LOGIN, WRONG, acting);
await sleep(300);
check("an overlay that comes with the pointer: not pressed (the pointer's move only), nothing reaches the server", screenOf(hoverSubmit) === "refused: screen_changed" && inputs() === hoverBefore.inputs + 2 && presses() === hoverBefore.presses + 1 && loginArrivals() === hoverBefore.logins, { submit: screenOf(hoverSubmit), inputs: inputs() - hoverBefore.inputs, mouse: presses() - hoverBefore.presses });
await load("https://fansly.com/?steal=1");
const stealBefore = { inputs: inputs(), presses: presses(), logins: loginArrivals() };
const stealSubmit = await desk.submit(LOGIN, WRONG, acting);
await sleep(300);
check("a field that gives its focus away: nothing typed into it, nothing pressed", screenOf(stealSubmit) === "refused: screen_changed" && inputs() === stealBefore.inputs + 1 && presses() === stealBefore.presses && loginArrivals() === stealBefore.logins, { submit: screenOf(stealSubmit), inputs: inputs() - stealBefore.inputs, mouse: presses() - stealBefore.presses });
await load("https://fansly.com/");
const cancelBefore = { inputs: inputs(), presses: presses(), logins: loginArrivals() };
const cancelled: LoginGuard = () => (inputs() > cancelBefore.inputs ? "the manual login is over" : null);
const cancelSubmit = await desk.submit(LOGIN, WRONG, cancelled);
await sleep(300);
check("a call that may act no more after its first field: nothing more typed, nothing pressed", screenOf(cancelSubmit) === "refused: not_manual_login" && inputs() === cancelBefore.inputs + 1 && presses() === cancelBefore.presses && loginArrivals() === cancelBefore.logins, { submit: screenOf(cancelSubmit), inputs: inputs() - cancelBefore.inputs, mouse: presses() - cancelBefore.presses });
await load("https://fansly.com/");

// 4. A wrong password: the site's own error, the fields to try again.
const wrongState = await desk.submit(LOGIN, WRONG, acting);
check("a wrong password: the site's error is shown with the login's fields", screenOf(wrongState) === 'error [login,password] "Invalid username or password"', screenOf(wrongState));

// 5. The login and the password, then the code: the site's own requests carry them.
const afterLogin = await desk.submit(LOGIN, PASSWORD, acting);
check("the login: the code screen follows", screenOf(afterLogin) === "code [code]", screenOf(afterLogin));
const afterCode = await desk.code(CODE, acting);
await sleep(500);
check("the code: the success (the site's code accepted, no form)", screenOf(afterCode) === "success []", { screen: screenOf(afterCode), sessionSeen: session.fingerprint !== sessionAtStart });
// The site's read after it, its interface's, passes in the manual login
// (PR 15): the account loaded under the new session is a success too.
const readAt = Date.now();
while (Date.now() - readAt < 5_000 && !committed.some((done) => asks.some((ask) => ask.path === "/api/v1/account/me" && ask.siteRequestId === done.siteRequestId))) await sleep(50);
const afterRead = await desk.state();
const accountLoaded = readsEnded.some((end) => end.route === "account.me" && end.sent && end.status === 200 && end.session !== null && end.session === session.fingerprint);
check("the account loaded under the site's new session: the success", screenOf(afterRead) === "success []" && session.fingerprint !== sessionAtStart && accountLoaded, { screen: screenOf(afterRead), sessionSeen: session.fingerprint !== sessionAtStart, accountLoaded });
const logins = loginBodies.filter((body) => body.path === "/api/v1/login");
check("what was typed is what the site sent, byte for byte", logins.length === 2 && logins[0]!.username === LOGIN && logins[0]!.password === WRONG && logins[1]!.username === LOGIN && logins[1]!.password === PASSWORD
  && loginBodies.filter((body) => body.path === "/api/v1/login/twofa").map((body) => body.code).join() === CODE, { bodies: loginBodies.map((body) => body.path) });

// 6. Every login request and its preflight under an admission of its own.
await buffer.flush();
const apiArrivals = arrivals.filter((arrival) => arrival.host === "apiv3.fansly.com");
const posts = apiArrivals.filter((arrival) => arrival.method === "POST");
const LOGIN_PATHS = ["/api/v1/login", "/api/v1/login/twofa"];
const preflights = apiArrivals.filter((arrival) => arrival.method === "OPTIONS" && LOGIN_PATHS.includes(arrival.path));
const loginAdmissions = admitted.filter((entry) => entry.operation === "login");
check("each login went under its own admission, with its preflight (owner decision №1)", posts.length === 3 && preflights.length === posts.length && loginAdmissions.length === posts.length
  && loginAdmissions.every((entry) => entry.method === "POST" && (entry.route === "auth.login" || entry.route === "auth.twofa")), { posts: posts.length, preflights: preflights.length, admissions: loginAdmissions.map((entry) => entry.route) });
const readAdmissions = admitted.filter((entry) => entry.path === "/api/v1/account/me");
const readEnds = committed.filter((done) => readAdmissions.some((entry) => entry.id === done.siteRequestId));
check("the site's read after the login went under an admission of its own, with its preflight; its answer to the buffer", readAdmissions.length === 1 && readAdmissions[0]!.route === "account.me" && readAdmissions[0]!.operation === "read"
  && apiArrivals.filter((arrival) => arrival.path === "/api/v1/account/me").map((arrival) => arrival.method).join() === "OPTIONS,GET"
  && readEnds.length === 1 && readEnds[0]!.sent && readEnds[0]!.status === 200 && readEnds[0]!.body === "buffered", { admissions: readAdmissions.map((entry) => entry.route), arrivals: apiArrivals.filter((arrival) => arrival.path === "/api/v1/account/me").map((arrival) => arrival.method), ends: readEnds.map((done) => ({ sent: done.sent, status: done.status, body: done.body })) });
const ends = committed.filter((done) => loginAdmissions.some((entry) => entry.id === done.siteRequestId));
check("the logins' answers are not kept (they carry secrets)", ends.length === 3 && ends.every((done) => done.sent && done.status === 200 && done.body === "not_platform_data"), ends.map((done) => ({ sent: done.sent, status: done.status, body: done.body })));

// 7. No marker anywhere but in the browser and the server.
await buffer.close();
const files = (dir: string): Buffer[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [readFileSync(path)];
});
const written = files(join(work, "buffer"));
const texts = [logLines.join("\n"), JSON.stringify(journal), JSON.stringify(asks), JSON.stringify(committed)];
const leaks = [LOGIN, PASSWORD, WRONG, CODE, ISSUED_TOKEN].filter((marker) => texts.some((text) => text.includes(marker)) || written.some((file) => file.includes(marker)));
check("no marker in the log, the journal, the engine's messages or the buffer's files", leaks.length === 0, { leaks: leaks.length });

await shutdown();
let failed = 0;
for (const entry of checks) {
  if (!entry.ok) failed += 1;
  console.log(`${entry.ok ? "ok  " : "FAIL"} ${entry.what}${entry.ok && !verbose ? "" : `: ${entry.detail}`}`);
}
console.log(failed === 0 ? `login-check: all ${checks.length} held` : `login-check: ${failed} of ${checks.length} did not hold`);
process.exit(failed === 0 ? 0 : 1);
