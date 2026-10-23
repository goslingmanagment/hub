// The resource-timing check (Project Browser, variant Б): does the site's
// page see Hub's requests? A Hub API request is an XMLHttpRequest from the
// isolated world `pb-hub` of the site's own tab (hub-requests/page.ts),
// started from its placeholder address `<host>.pb-hold.invalid…#hub-N` and
// released in Fetch to the real one. Chrome 155 keeps it out of the main
// world's resource timeline and away from the site's service worker (the
// stage note of 2026-10-17, resource-timing-check.md in the plan's folder).
// CDP promises none of it: a new Chrome could start showing the page every
// placeholder address. So this runs on every Chrome the image moves to:
// stand/chrome-update.sh runs it on the new image, and the image test holds
// PASSED_ON to the Dockerfile's Chrome. Run by stand/resource-timing-check.sh
// — in the image, headed on its X server — or by hand:
//
//   node --no-warnings resource-timing-check.ts --chrome <path> [--display :99] [--no-sandbox] [--verbose]
//
// What runs: a real Chrome (a throwaway profile; on the X server --display
// names, else headless=new) and two HTTP servers of this script's, a site
// `www.toy.test` and its API `api.toy.test` — one site, two origins, as
// fansly.com and apiv3.fansly.com are; Chrome resolves those two names to
// 127.0.0.1 and no other name at all. The site's page has what a site or a
// RUM library would have: a service worker that reports every fetch event
// to the page, a buffered PerformanceObserver of resources, and hooks on
// XMLHttpRequest, fetch, Image, media and createElement in the main world.
// CDP goes the operator's way: Fetch.enable on the browser target with the
// operator's own patterns (cdp/control.ts), the tab opened after it, the
// isolated world by the operator's name, ISSUE called in it with the
// placeholder address (issuedUrl), and at the pause Fetch.continueRequest
// with the real address (realUrl) and interceptResponse; a preflight's
// answer handed on with Fetch.fulfillRequest, as hub.ts does.
//
// It asserts, on that Chrome:
//   - the Hub API request went: it paused at its placeholder with its
//     `#hub-N`, reached the API at the real host, and ended in the page;
//   - it left no entry in the main world's resource timeline (the entries
//     and the observer), no fetch event in the site's service worker and
//     nothing in the main world's hooks;
//   - the controls: the main world's own XMLHttpRequest, Image and <video>
//     each leave an entry; its XMLHttpRequest a fetch event in the service
//     worker, which controls the page, and a call in the hooks — so
//     "nothing" means hidden, not a timeline, worker or hook that sees
//     nothing at all.
// And reports without judging: Hub's Image and <video> from the same world
// (no media go through the browser today; how they would is the owner's
// decision). On 155.0.8059.39, .84 and 156.0.8078.47 the video is in the
// timeline under its placeholder name, and the service worker sees both
// placeholders.
//
// What it does not run: the operator (no holder, gate, buffer, engine,
// session or rules extension: the release here is the operator's CDP call,
// not its decision), Fansly (plain HTTP, the site treated as a secure
// origin by a flag; no TLS, no proxy), the image's policies (masked in the
// image).
//
// Prints one line per assertion (ok / FAIL) and per report (info); exits 0
// when all held, 1 when any did not, 2 when it could not run.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FETCH_PATTERNS } from "../src/cdp/control.ts";
import { attemptOf, ISSUE, issuedUrl, PLACEHOLDER_SUFFIX, realUrl, WORLD } from "../src/hub-requests/page.ts";

/** The image's Chrome this check last passed on. The image test holds it to
 *  the Dockerfile's CHROME_VERSION: a new Chrome there fails until this
 *  check passed on it and this line names it. */
const PASSED_ON = "156.0.8078.47";

function argument(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

const CHROME = argument("--chrome");
const DISPLAY = argument("--display");
const verbose = process.argv.includes("--verbose");
if (CHROME === null || !existsSync(CHROME)) {
  console.error(`resource-timing-check: no Chrome at ${CHROME ?? "(none given: --chrome <path>)"}`);
  process.exit(2);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const work = mkdtempSync(join(tmpdir(), "pb-resource-timing-"));

// ── the site and its API ────────────────────────────────────────────────

const SITE_HOST = "www.toy.test";
const API_HOST = "api.toy.test";
// No port in the addresses, as Fansly's have none: the operator's Fetch
// pattern is `*://*.pb-hold.invalid/*`. Chrome's resolver maps each name to
// its server's port.
const SITE = `http://${SITE_HOST}`;
const API = `http://${API_HOST}`;
// A stand-in, never anyone's.
const TOKEN = "stand-token-not-a-secret";
const HUB_HEADERS: Array<[string, string]> = [
  ["authorization", TOKEN],
  ["fansly-client-id", "100000000000000001"],
  ["fansly-client-ts", "1760000000000"],
  ["fansly-client-check", "stand"],
];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
// Not a playable video: what counts is that the element fetched it.
const VIDEO = Buffer.alloc(4096, 7);

// In the site's main world, as a site or a RUM library would have it.
const PAGE = `<!doctype html><meta charset=utf-8><title>site</title><body>site
<script>
window.__seen = { observer: [], sw: [], hooks: [] };
new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__seen.observer.push(e.name); })
  .observe({ type: "resource", buffered: true });
navigator.serviceWorker.addEventListener("message", (m) => window.__seen.sw.push(m.data.url));
navigator.serviceWorker.startMessages();
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (m, u) { window.__seen.hooks.push("xhr.open " + u); return open.apply(this, arguments); };
const fetch0 = window.fetch;
window.fetch = function (u) { window.__seen.hooks.push("fetch " + u); return fetch0.apply(this, arguments); };
const img = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
Object.defineProperty(HTMLImageElement.prototype, "src", { ...img, set(v) { window.__seen.hooks.push("img.src " + v); return img.set.call(this, v); } });
const media = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
Object.defineProperty(HTMLMediaElement.prototype, "src", { ...media, set(v) { window.__seen.hooks.push("media.src " + v); return media.set.call(this, v); } });
const create = Document.prototype.createElement;
Document.prototype.createElement = function (t) { window.__seen.hooks.push("createElement " + t); return create.apply(this, arguments); };
window.__swReady = navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready);
window.__controls = async () => {
  const xhr = await new Promise((done) => {
    const x = new XMLHttpRequest();
    x.open("GET", "${API}/api/v1/account/me?ngsw-bypass=true&k=main-xhr", true);
    x.withCredentials = true;
    x.setRequestHeader("authorization", "site-token");
    x.onloadend = () => done(x.status);
    x.send();
  });
  const image = await new Promise((done) => {
    const i = new Image();
    i.onload = () => done("load");
    i.onerror = () => done("error");
    i.src = "${API}/media/a.png?ngsw-bypass=true&k=main-image";
  });
  const video = await new Promise((done) => {
    const v = document.createElement("video");
    window.__keep = v;
    v.muted = true;
    v.preload = "auto";
    v.onloadeddata = () => done("loadeddata");
    v.onerror = () => done("error");
    setTimeout(() => done("waited"), 5000);
    v.src = "${API}/media/v.mp4?ngsw-bypass=true&k=main-video";
  });
  return { xhr, image, video };
};
</script>`;

// The site's service worker: every fetch event reported to the page, none
// answered (ngsw lets a request with ngsw-bypass go by).
const WORKER = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then((clients) => clients.forEach((client) => client.postMessage({ url }))));
});`;

interface Arrival {
  method: string;
  host: string;
  path: string;
  k: string | null;
}
const arrivals: Arrival[] = [];
// What paused in Fetch, and how it was let go.
interface Paused {
  stage: "request" | "response";
  method: string;
  url: string;
  attempt: number | null;
  released: string | null;
}
const paused: Paused[] = [];
const pauseErrors: string[] = [];

const site = http.createServer((req, res) => {
  if ((req.url ?? "").startsWith("/sw.js")) {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    res.end(WORKER);
    return;
  }
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end(PAGE);
});
const api = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", API);
  arrivals.push({ method: req.method ?? "", host: req.headers.host ?? "", path: url.pathname, k: url.searchParams.get("k") });
  const cors = {
    "access-control-allow-origin": SITE,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization,fansly-client-id,fansly-client-ts,fansly-client-check",
    "cache-control": "no-store",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
  } else if (url.pathname.endsWith(".png")) {
    res.writeHead(200, { ...cors, "content-type": "image/png" });
    res.end(PNG);
  } else if (url.pathname.endsWith(".mp4")) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), VIDEO.length - 1) : VIDEO.length - 1;
      res.writeHead(206, { ...cors, "content-type": "video/mp4", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${VIDEO.length}`, "content-length": end - start + 1 });
      res.end(VIDEO.subarray(start, end + 1));
    } else {
      res.writeHead(200, { ...cors, "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": VIDEO.length });
      res.end(VIDEO);
    }
  } else {
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, response: { k: url.searchParams.get("k") } }));
  }
});
const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const sitePort = await listen(site);
const apiPort = await listen(api);

// ── Chrome ──────────────────────────────────────────────────────────────

const profile = join(work, "profile");
const chromeArgs = [
  ...(DISPLAY === null ? ["--headless=new"] : []),
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  // The two names are this script's servers; no other name resolves.
  `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1:${sitePort}, MAP ${API_HOST} 127.0.0.1:${apiPort}, MAP * ~NOTFOUND`,
  // A service worker needs a secure origin; the site is plain HTTP here.
  `--unsafely-treat-insecure-origin-as-secure=${SITE}`,
  // The page's own (s6 chrome/run).
  "--window-size=1920,1080",
  "--no-first-run",
  "--disable-features=OptimizationHints",
  "--ignore-gpu-blocklist",
  "--no-default-browser-check",
  ...(process.argv.includes("--no-sandbox") ? ["--no-sandbox"] : []),
  "about:blank",
];
const chromeErr: string[] = [];
const chrome: ChildProcess = spawn(CHROME, chromeArgs, { stdio: ["ignore", "ignore", "pipe"], env: DISPLAY === null ? process.env : { ...process.env, DISPLAY } });
chrome.stderr?.on("data", (part: Buffer) => {
  chromeErr.push(part.toString());
  if (chromeErr.length > 200) chromeErr.shift();
});

async function shutdown(): Promise<void> {
  chrome.kill();
  if (chrome.exitCode === null && chrome.signalCode === null) await new Promise((resolve) => chrome.once("exit", resolve));
  site.close();
  api.close();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Chrome's last writes.
  }
}

async function cannotRun(why: string): Promise<never> {
  console.error(`resource-timing-check: ${why}`);
  if (verbose) console.error(JSON.stringify({ paused, pauseErrors, arrivals }, null, 1));
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

// ── CDP, straight to Chrome ──────────────────────────────────────────────

type Params = Record<string, unknown>;
class Cdp {
  readonly #ws: WebSocket;
  #id = 0;
  readonly #pending = new Map<number, { resolve: (value: Params) => void; reject: (error: Error) => void; method: string }>();
  readonly #handlers = new Map<string, Array<(params: Params, sessionId: string | undefined) => void>>();

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (message) => {
      const data = JSON.parse(String(message.data)) as { id?: number; result?: Params; error?: { message: string }; method?: string; params?: Params; sessionId?: string };
      if (data.id !== undefined) {
        const waiter = this.#pending.get(data.id);
        this.#pending.delete(data.id);
        if (data.error) waiter?.reject(new Error(`${waiter.method}: ${data.error.message}`));
        else waiter?.resolve(data.result ?? {});
      } else if (data.method !== undefined) {
        for (const handler of this.#handlers.get(data.method) ?? []) handler(data.params ?? {}, data.sessionId);
      }
    };
  }

  send<T = Params>(method: string, params: Params = {}, sessionId?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.#id;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no answer in 10 s`));
      }, 10_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        method,
      });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, handler: (params: Params, sessionId: string | undefined) => void): void {
    this.#handlers.set(method, [...(this.#handlers.get(method) ?? []), handler]);
  }

  /** The next `method` of `sessionId`, or null after `ms`. */
  next(method: string, sessionId: string, ms: number): Promise<Params | null> {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        resolve(null);
      }, ms);
      this.on(method, (params, from) => {
        if (done || from !== sessionId) return;
        done = true;
        clearTimeout(timer);
        resolve(params);
      });
    });
  }

  close(): void {
    this.#ws.close();
  }
}

const ws = new WebSocket(wsUrl);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("CDP's WebSocket failed"));
}).catch((error: unknown) => cannotRun(String(error)));
const cdp = new Cdp(ws);

// ── the operator's interception: its patterns, the release to the real host

cdp.on("Fetch.requestPaused", (params) => {
  const requestId = String(params.requestId);
  const request = params.request as { url: string; method: string; urlFragment?: string };
  const status = params.responseStatusCode as number | undefined;
  const error = params.responseErrorReason as string | undefined;
  const host = new URL(request.url).hostname;
  const entry: Paused = { stage: status !== undefined || error !== undefined ? "response" : "request", method: request.method, url: request.url, attempt: attemptOf(request.urlFragment ?? ""), released: null };
  paused.push(entry);
  let answer: Promise<unknown>;
  if (entry.stage === "response") {
    if (error !== undefined) answer = cdp.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
    // A preflight's answer is handed on (hub.ts: Chrome 155 kills its
    // network service when a preflight's interception job is continued).
    else if (request.method === "OPTIONS") answer = cdp.send("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: params.responseHeaders ?? [], body: "" });
    else answer = cdp.send("Fetch.continueRequest", { requestId });
  } else if (host.endsWith(PLACEHOLDER_SUFFIX)) {
    entry.released = realUrl(request.url, host.slice(0, -PLACEHOLDER_SUFFIX.length));
    answer = cdp.send("Fetch.continueRequest", { requestId, url: entry.released, interceptResponse: true });
  } else {
    answer = cdp.send("Fetch.continueRequest", { requestId });
  }
  answer.catch((failure: unknown) => pauseErrors.push(`${request.method} ${request.url}: ${String(failure)}`));
});

const k = (key: string) => new RegExp(`[?&]k=${key}(?:[&#\\s]|$)`);
async function until(what: string, ready: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ready()) return;
  await cannotRun(`${what}: not within ${ms} ms`);
}
const arrived = (key: string) => arrivals.some((arrival) => arrival.method === "GET" && arrival.k === key);

// ── the run ─────────────────────────────────────────────────────────────

const HUB_API = 101;
const HUB_IMAGE = 102;
const HUB_VIDEO = 103;
let version = "";
let controlled = false;
let hubApiEnded = false;
let controls: unknown = null;
let tab = "";
let world = 0;

const evaluate = async <T>(expression: string, contextId?: number): Promise<T> => {
  const result = await cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, ...(contextId === undefined ? {} : { contextId }) },
    tab,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value as T;
};
const issue = (id: number, real: string, kind: "api" | "image" | "video", headers: Array<[string, string]>) =>
  cdp.send<{ result: { value?: boolean } }>(
    "Runtime.callFunctionOn",
    { functionDeclaration: ISSUE, executionContextId: world, arguments: [{ value: id }, { value: issuedUrl(new URL(real), id) }, { value: kind }, { value: headers }], returnByValue: true },
    tab,
  );

try {
  version = String((await cdp.send<{ product: string }>("Browser.getVersion")).product);
  // The operator's order: the interception first, then the work tab — a
  // tab Chrome started with is not intercepted (cdp/control.ts).
  await cdp.send("Fetch.enable", { patterns: FETCH_PATTERNS });
  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>("Target.getTargets");
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  for (const other of targetInfos) if (other.type === "page") await cdp.send("Target.closeTarget", { targetId: other.targetId });
  tab = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  await cdp.send("Page.enable", {}, tab);
  await cdp.send("Runtime.enable", {}, tab);
  await cdp.send("Network.enable", {}, tab);

  // The site, then again under its service worker.
  for (const load of [() => cdp.send("Page.navigate", { url: `${SITE}/` }, tab), () => cdp.send("Page.reload", {}, tab)]) {
    const loaded = cdp.next("Page.loadEventFired", tab, 10_000);
    await load();
    if ((await loaded) === null) await cannotRun("the site did not load");
    await evaluate("window.__swReady.then(() => true)");
  }
  controlled = await evaluate<boolean>("navigator.serviceWorker.controller !== null");

  const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, tab);
  world = (await cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false }, tab)).executionContextId;

  // Hub's API request, as hub.ts sends it; it ends in the page when its
  // XMLHttpRequest let go of its entry (ISSUE's onloadend).
  if ((await issue(HUB_API, `${API}/api/v1/account/me?ngsw-bypass=true&k=hub-api`, "api", HUB_HEADERS)).result.value !== true) await cannotRun("ISSUE did not start the Hub request");
  await until("the Hub API request at the API", () => arrived("hub-api"));
  await until("the Hub API request's end in the page", async () => (hubApiEnded = await evaluate<boolean>(`!globalThis.__pbHub.has(${HUB_API})`, world)));
  // Hub's media from the same world: reported, not judged.
  await issue(HUB_IMAGE, `${API}/media/a.png?ngsw-bypass=true&k=hub-image`, "image", []);
  await issue(HUB_VIDEO, `${API}/media/v.mp4?ngsw-bypass=true&k=hub-video`, "video", []);
  await until("Hub's media at the API", () => arrived("hub-image") && arrived("hub-video"));
  // The controls, the site's own, after Hub's: whatever came of Hub's in
  // the worker's messages was on its way before.
  controls = await evaluate("window.__controls()");
  await until("the controls at the API", () => arrived("main-xhr") && arrived("main-image") && arrived("main-video"));
  await until("the control's fetch event", async () => (await evaluate<string[]>("window.__seen.sw")).some((url) => k("main-xhr").test(url)));
  await sleep(1000);
} catch (error) {
  await cannotRun(String(error));
}

interface Entry {
  name: string;
  initiatorType: string;
}
const entries = await evaluate<Entry[]>("performance.getEntriesByType('resource').map((e) => ({ name: e.name, initiatorType: e.initiatorType }))");
const seen = await evaluate<{ observer: string[]; sw: string[]; hooks: string[] }>("JSON.parse(JSON.stringify(window.__seen))");
const isolatedEntries = await evaluate<number>("performance.getEntriesByType('resource').length", world);
cdp.close();
await shutdown();

// ── the verdict ─────────────────────────────────────────────────────────

const problems: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) problems.push(what);
};
const info = (what: string) => console.log(`info ${what}`);
const inTimeline = (key: string) => [...new Set([...entries.map((entry) => entry.name), ...seen.observer].filter((name) => k(key).test(name)))];
const inWorker = (key: string) => seen.sw.filter((url) => k(key).test(url));
const inHooks = (key: string) => seen.hooks.filter((line) => k(key).test(line));
const typeOf = (key: string) => entries.find((entry) => k(key).test(entry.name))?.initiatorType ?? "?";
const chromeVersion = /([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/.exec(version)?.[1] ?? version;

console.log(`resource-timing-check: ${version}, ${DISPLAY === null ? "headless" : `headed on ${DISPLAY}`}; last passed on ${PASSED_ON}`);
const hubPause = paused.find((entry) => entry.stage === "request" && entry.method === "GET" && k("hub-api").test(entry.url));
check(
  hubPause !== undefined && hubPause.attempt === HUB_API && new URL(hubPause.url).hostname === `${API_HOST}${PLACEHOLDER_SUFFIX}` && hubPause.released !== null && new URL(hubPause.released).hostname === API_HOST,
  `the Hub API request paused at its placeholder with #hub-${HUB_API} and was released to the real host`,
);
check(arrivals.some((arrival) => arrival.method === "GET" && arrival.k === "hub-api" && arrival.host === new URL(API).host), "it reached the API at the real host");
check(hubApiEnded, "it ended in the page");
check(pauseErrors.length === 0, `every paused request was answered${pauseErrors.length ? `: ${pauseErrors.join("; ")}` : ""}`);
check(inTimeline("hub-api").length === 0, `the Hub API request left no entry in the main world's resource timeline${inTimeline("hub-api").length ? `: ${inTimeline("hub-api").join(", ")}` : ""}`);
check(inWorker("hub-api").length === 0, `it raised no fetch event in the site's service worker${inWorker("hub-api").length ? `: ${inWorker("hub-api").join(", ")}` : ""}`);
check(inHooks("hub-api").length === 0, `it showed in none of the main world's hooks${inHooks("hub-api").length ? `: ${inHooks("hub-api").join(", ")}` : ""}`);
check(controlled, "control: the site's service worker controls the page");
check(inTimeline("main-xhr").length > 0, `control: the main world's XMLHttpRequest left an entry (${typeOf("main-xhr")})`);
check(inTimeline("main-image").length > 0, `control: the main world's Image left an entry (${typeOf("main-image")})`);
check(inTimeline("main-video").length > 0, `control: the main world's <video> left an entry (${typeOf("main-video")})`);
check(inWorker("main-xhr").length > 0, "control: the main world's XMLHttpRequest raised a fetch event in the service worker");
check(inHooks("main-xhr").length > 0, "control: the main world's hooks saw its XMLHttpRequest");
for (const [key, what] of [["hub-image", "Image"], ["hub-video", "<video>"]] as const) {
  const names = inTimeline(key);
  const worker = inWorker(key);
  info(`Hub's ${what} from ${WORLD}: ${names.length ? `in the timeline as ${names.join(", ")} (${typeOf(key)})` : "not in the timeline"}; ${worker.length ? `the service worker saw ${worker.join(", ")}` : "not seen by the service worker"}`);
}
if (verbose) console.log(JSON.stringify({ controls, entries, seen, isolatedEntries, paused, arrivals }, null, 1));
if (problems.length === 0 && chromeVersion !== PASSED_ON) info(`a Chrome this check has not passed on before: once it is the image's, PASSED_ON in stand/resource-timing-check.ts names ${chromeVersion}`);
console.log(problems.length === 0 ? "ALL OK" : `${problems.length} FAILED`);
process.exit(problems.length === 0 ? 0 : 1);
