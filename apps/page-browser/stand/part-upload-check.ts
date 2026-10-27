// The part-upload check (wall posts PR 8; 0323): does an upload's part go
// out whole and leave Chrome's messages small? A part is a PUT the operator
// starts in the isolated world `pb-hub` of the site's tab (hub-requests/
// page.ts `ISSUE`) from its placeholder `<storage>.pb-hold.invalid…#hub-N`,
// and at its pause hands Chrome the part's own bytes (Fetch's `postData`)
// with the real address (hub.ts). Everything Chrome tells the operator goes
// through the holder, which keeps it until the operator acknowledges it, up
// to 128 MB (holder/main.ts `PB_HOLDER_MAX_BYTES`), and kills Chrome past it.
// On 2026-10-27 a 20 MiB part on ari-1 did that twice: the page held the
// part's length in zero bytes, and Chrome echoed them, base64, in the part's
// pauses; the pause of its response echoes the bytes handed at the release
// too, as text and as base64. Now the page holds no body, and the holder
// keeps a large echoed body as its length only (holder.ts
// `trimPausedPostData`). Run by stand/part-upload-check.sh — in the image,
// headed on its X server — or by hand:
//
//   node --no-warnings part-upload-check.ts --chrome <path> [--display :99] [--bytes N] [--no-sandbox] [--verbose]
//
// What runs: a real Chrome (a throwaway profile), a site `www.toy.test` and a
// storage `storage.toy.test` of this script's — the storage as S3 answers a
// part: its preflight lets `ngsw-bypass` and `PUT` in and exposes `ETag`, its
// PUT answers 200 with the MD5 of what arrived as the ETag. CDP goes the
// operator's way: Fetch.enable on the browser target with its patterns
// (cdp/control.ts), Network.enable in the tab with its buffers
// (rpc/protocol.ts defaults), the isolated world by its name, ISSUE called
// there with the placeholder address, the preflight's answer handed on with
// Fetch.fulfillRequest, the PUT released with the real address and the
// part's bytes. Every message Chrome sends goes through the holder's
// `trimPausedPostData`, as the holder keeps it.
//
// It asserts, on that Chrome:
//   - the storage got exactly the part: its PUT, its length, its MD5, the
//     Content-Length of its length;
//   - the part ended in the page (its XMLHttpRequest let go of its entry);
//   - the part's pause at its request carries no body (hub.ts refuses a
//     part with one), and the pause of its response, as the holder keeps
//     it, the part's length;
//   - no message the holder keeps while the part goes is larger than 1 MiB,
//     and all of them together under 8 MiB. What Chrome itself sent, the
//     largest, is printed (info): Chrome's own send buffer is 256 MB.
//
// What it does not run: the operator itself (no holder, gate, engine, rules
// extension), TLS, a proxy, Fansly.
//
// Prints one line per assertion (ok / FAIL) and per report (info); exits 0
// when all held, 1 when any did not, 2 when it could not run.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { connect as tcpConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FETCH_PATTERNS } from "../src/cdp/control.ts";
import { CDP_MAX_MESSAGE, trimPausedPostData } from "../src/holder/holder.ts";
import { clientHandshake, type WsConnection } from "../src/shared/ws.ts";
import { ISSUE, issuedUrl, PLACEHOLDER_SUFFIX, realUrl, WORLD } from "../src/hub-requests/page.ts";
import { DEFAULT_PARAMS } from "../src/rpc/protocol.ts";

function argument(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

const CHROME = argument("--chrome");
const DISPLAY = argument("--display");
const BYTES = Number(argument("--bytes") ?? 20 * 1024 * 1024);
const verbose = process.argv.includes("--verbose");
if (CHROME === null || !existsSync(CHROME)) {
  console.error(`part-upload-check: no Chrome at ${CHROME ?? "(none given: --chrome <path>)"}`);
  process.exit(2);
}
if (!Number.isSafeInteger(BYTES) || BYTES < 1) {
  console.error("part-upload-check: --bytes takes a positive integer");
  process.exit(2);
}

/** A message the holder keeps while the part goes, at most. */
const MESSAGE_MAX = 1024 * 1024;
/** All of them together, at most. */
const MESSAGES_TOTAL_MAX = 8 * 1024 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const work = mkdtempSync(join(tmpdir(), "pb-part-upload-"));
const PART = randomBytes(BYTES);
const PART_MD5 = createHash("md5").update(PART).digest("hex");

// ── the site and the storage ────────────────────────────────────────────

const SITE_HOST = "www.toy.test";
const STORAGE_HOST = "storage.toy.test";
const SITE = `http://${SITE_HOST}`;
const STORAGE = `http://${STORAGE_HOST}`;

interface Arrival { method: string; path: string; bytes: number; md5: string; contentLength: string | null }
const arrivals: Arrival[] = [];
const site = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><meta charset=utf-8><title>site</title><body>site");
});
const storage = http.createServer((req, res) => {
  // As S3 answers a part (the contract §2): the preflight lets `ngsw-bypass`
  // and PUT in, the answer exposes its ETag.
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT",
    "access-control-allow-headers": "ngsw-bypass",
    "access-control-expose-headers": "ETag",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(200, cors);
    res.end();
    return;
  }
  const hash = createHash("md5");
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  req.on("end", () => {
    const md5 = hash.digest("hex");
    arrivals.push({ method: req.method ?? "?", path: req.url ?? "", bytes, md5, contentLength: req.headers["content-length"] ?? null });
    res.writeHead(200, { ...cors, etag: `"${md5}"`, "content-length": "0" });
    res.end();
  });
});
const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const sitePort = await listen(site);
const storagePort = await listen(storage);

// ── Chrome ──────────────────────────────────────────────────────────────

const profile = join(work, "profile");
const chrome: ChildProcess = spawn(CHROME, [
  ...(DISPLAY === null ? ["--headless=new"] : []),
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1:${sitePort}, MAP ${STORAGE_HOST} 127.0.0.1:${storagePort}, MAP * ~NOTFOUND`,
  "--window-size=1920,1080",
  "--no-first-run",
  "--no-default-browser-check",
  ...(process.argv.includes("--no-sandbox") ? ["--no-sandbox"] : []),
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"], env: DISPLAY === null ? process.env : { ...process.env, DISPLAY } });
const chromeErr: string[] = [];
chrome.stderr?.on("data", (part: Buffer) => {
  chromeErr.push(part.toString());
  if (chromeErr.length > 200) chromeErr.shift();
});

async function shutdown(): Promise<void> {
  chrome.kill();
  if (chrome.exitCode === null && chrome.signalCode === null) await new Promise((resolve) => chrome.once("exit", resolve));
  site.close();
  storage.close();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Chrome's last writes.
  }
}

async function cannotRun(why: string): Promise<never> {
  console.error(`part-upload-check: ${why}`);
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

// ── CDP, straight to Chrome over the holder's WebSocket client and its
// message limit; every message Chrome sends is measured ─────────────────

type Params = Record<string, unknown>;
interface Measured { method: string; bytes: number; raw: number }
let measuring = false;
const measured: Measured[] = [];
/** The PUT's pauses as the holder keeps them. */
type KeptRequest = { hasPostData?: boolean; postData?: string; postDataEntries?: unknown[]; pbPostDataBytes?: number | null };
const putPauses: Array<{ stage: "request" | "response"; request: KeptRequest }> = [];
const pending = new Map<number, { resolve: (value: Params) => void; reject: (error: Error) => void; method: string }>();
const handlers = new Map<string, Array<(params: Params, sessionId: string | undefined) => void>>();
let nextId = 0;
function onMessage(raw: Buffer): void {
  const kept = trimPausedPostData(raw);
  const data = JSON.parse(kept.toString("utf8")) as { id?: number; result?: Params; error?: { message: string }; method?: string; params?: Params; sessionId?: string };
  if (measuring) measured.push({ method: data.method ?? `reply ${pending.get(data.id ?? -1)?.method ?? "?"}`, bytes: kept.length, raw: raw.length });
  if (data.method === "Fetch.requestPaused") {
    const request = data.params?.request as KeptRequest & { method?: string };
    if (request.method === "PUT") putPauses.push({ stage: data.params?.responseStatusCode !== undefined ? "response" : "request", request });
  }
  if (data.id !== undefined) {
    const waiter = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) waiter?.reject(new Error(`${waiter.method}: ${data.error.message}`));
    else waiter?.resolve(data.result ?? {});
  } else if (data.method !== undefined) {
    for (const handler of handlers.get(data.method) ?? []) handler(data.params ?? {}, data.sessionId);
  }
}
let ws: WsConnection;
try {
  const cdp = new URL(wsUrl);
  const socket = tcpConnect({ host: cdp.hostname, port: Number(cdp.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  ws = await clientHandshake(socket, cdp.host, cdp.pathname, CDP_MAX_MESSAGE);
} catch (error) {
  ws = await cannotRun(`CDP's WebSocket failed: ${String(error)}`);
}
ws.onText = onMessage;
ws.onClose = (reason) => {
  if (measuring) console.error(`part-upload-check: CDP closed while the part went: ${reason}`);
};
function send<T = Params>(method: string, params: Params = {}, sessionId?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method}: no answer in 60 s`));
    }, 60_000);
    pending.set(id, {
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
    ws.sendText(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
function on(method: string, handler: (params: Params, sessionId: string | undefined) => void): void {
  handlers.set(method, [...(handlers.get(method) ?? []), handler]);
}

// ── the operator's release: the preflight's answer handed on, the PUT with
// the real address and the part's bytes ─────────────────────────────────

const pauseErrors: string[] = [];
let releasedPut = false;
on("Fetch.requestPaused", (params) => {
  if (verbose) {
    const r = params.request as { method: string; url: string } & KeptRequest;
    console.error(`paused ${r.method} ${r.url} ${params.responseStatusCode ?? ""} hasPostData=${r.hasPostData} postData=${r.postData?.length ?? "-"} entries=${r.postDataEntries?.length ?? "-"} kept=${r.pbPostDataBytes ?? "-"}`);
  }
  const requestId = String(params.requestId);
  const request = params.request as { url: string; method: string };
  const response = params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;
  const host = new URL(request.url).hostname;
  let answer: Promise<unknown>;
  if (response) {
    if (params.responseErrorReason !== undefined) answer = send("Fetch.failRequest", { requestId, errorReason: "Failed" });
    else if (request.method === "OPTIONS") answer = send("Fetch.fulfillRequest", { requestId, responseCode: params.responseStatusCode, responseHeaders: params.responseHeaders ?? [], body: "" });
    else answer = send("Fetch.continueRequest", { requestId });
  } else if (host.endsWith(PLACEHOLDER_SUFFIX)) {
    const real = realUrl(request.url, host.slice(0, -PLACEHOLDER_SUFFIX.length));
    const part = request.method === "PUT" ? { postData: PART.toString("base64") } : {};
    if (request.method === "PUT") releasedPut = true;
    answer = send("Fetch.continueRequest", { requestId, url: real, interceptResponse: true, ...part });
  } else {
    answer = send("Fetch.continueRequest", { requestId });
  }
  answer.catch((failure: unknown) => pauseErrors.push(`${request.method} ${request.url}: ${String(failure)}`));
});

// ── the run ─────────────────────────────────────────────────────────────

const PART_ID = 201;
let version = "";
let tab = "";
let world = 0;
let ended = false;
const evaluate = async <T>(expression: string, contextId?: number): Promise<T> => {
  const result = await send<{ result: { value?: T }; exceptionDetails?: { text: string } }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, ...(contextId === undefined ? {} : { contextId }) },
    tab,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value as T;
};
async function until(what: string, ready: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ready()) return;
  await cannotRun(`${what}: not within ${ms} ms`);
}

try {
  version = String((await send<{ product: string }>("Browser.getVersion")).product);
  await send("Fetch.enable", { patterns: FETCH_PATTERNS });
  const { targetInfos } = await send<{ targetInfos: Array<{ targetId: string; type: string }> }>("Target.getTargets");
  const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  for (const other of targetInfos) if (other.type === "page") await send("Target.closeTarget", { targetId: other.targetId });
  tab = (await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  const { totalBytes, perResponseBytes } = DEFAULT_PARAMS.chromeBodyBuffer;
  await send("Network.enable", { maxTotalBufferSize: totalBytes, maxResourceBufferSize: perResponseBytes }, tab);
  await send("Page.enable", {}, tab);
  await send("Runtime.enable", {}, tab);
  const loaded = new Promise<void>((resolve) => on("Page.loadEventFired", () => resolve()));
  await send("Page.navigate", { url: `${SITE}/` }, tab);
  await loaded;
  const { frameTree } = await send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, tab);
  world = (await send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false }, tab)).executionContextId;

  // The part, as hub.ts issues it: no body in the page.
  measuring = true;
  const url = issuedUrl(new URL(`${STORAGE}/acc/upload-1`), PART_ID);
  const started = (await send<{ result: { value?: boolean } }>("Runtime.callFunctionOn", {
    functionDeclaration: ISSUE, executionContextId: world,
    arguments: [{ value: PART_ID }, { value: url }, { value: "part" }, { value: [["ngsw-bypass", "true"]] }, { value: "PUT" }, { value: null }],
    returnByValue: true,
  }, tab)).result.value === true;
  if (!started) await cannotRun("the part did not start");
  if (verbose) console.error("issued");
  await until("the part at the storage", () => arrivals.some((arrival) => arrival.method === "PUT"));
  await until("the part's end in the page", async () => (ended = await evaluate<boolean>(`!globalThis.__pbHub.has(${PART_ID})`, world)));
  await sleep(500);
  measuring = false;
} catch (error) {
  await cannotRun(String(error));
}
ws.close();
await shutdown();

// ── the verdict ─────────────────────────────────────────────────────────

const problems: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) problems.push(what);
};
const put = arrivals.find((arrival) => arrival.method === "PUT");
const largest = measured.reduce<Measured | null>((max, entry) => (max === null || entry.bytes > max.bytes ? entry : max), null);
const largestRaw = measured.reduce<Measured | null>((max, entry) => (max === null || entry.raw > max.raw ? entry : max), null);
const atRequest = putPauses.find((pause) => pause.stage === "request")?.request;
const atResponse = putPauses.find((pause) => pause.stage === "response")?.request;
const total = measured.reduce((sum, entry) => sum + entry.bytes, 0);
const big = measured.filter((entry) => entry.raw > 64 * 1024);
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

console.log(`part-upload-check: ${version}, ${DISPLAY === null ? "headless" : `headed on ${DISPLAY}`}; a part of ${mib(BYTES)}`);
check(releasedPut, "the part paused at its placeholder and was released with the real address and its bytes");
check(put !== undefined && put.bytes === BYTES && put.md5 === PART_MD5, `the storage got exactly the part (${put === undefined ? "nothing" : `${put.bytes} bytes, md5 ${put.md5 === PART_MD5 ? "matches" : "differs"}`})`);
check(put?.contentLength === String(BYTES), `its Content-Length was the part's (${put?.contentLength ?? "none"})`);
check(ended, "the part ended in the page");
check(atRequest !== undefined && atRequest.hasPostData !== true && atRequest.postData === undefined && atRequest.postDataEntries === undefined && atRequest.pbPostDataBytes === undefined, "its pause at the request carried no body");
check(atResponse !== undefined && atResponse.pbPostDataBytes === BYTES && atResponse.postData === undefined && atResponse.postDataEntries === undefined, `its response's pause, as kept, carried the part's length only (${atResponse === undefined ? "no pause" : String(atResponse.pbPostDataBytes)})`);
check(pauseErrors.length === 0, `every paused request was answered${pauseErrors.length ? `: ${pauseErrors.join("; ")}` : ""}`);
check(largest !== null && largest.bytes <= MESSAGE_MAX, `no message the holder keeps was over ${mib(MESSAGE_MAX)} (largest ${largest === null ? "none" : `${mib(largest.bytes)}, ${largest.method}`})`);
check(total <= MESSAGES_TOTAL_MAX, `all it keeps while the part went stayed under ${mib(MESSAGES_TOTAL_MAX)} (${mib(total)} in ${measured.length})`);
console.log(`info the largest message Chrome sent: ${largestRaw === null ? "none" : `${mib(largestRaw.raw)}, ${largestRaw.method}`}`);
for (const entry of big) console.log(`info Chrome sent a message over 64 KiB: ${entry.method}, ${mib(entry.raw)} (kept ${mib(entry.bytes)})`);
if (verbose) console.log(JSON.stringify({ arrivals, measured }, null, 1));
console.log(problems.length === 0 ? "ALL OK" : `${problems.length} FAILED`);
process.exit(problems.length === 0 ? 0 : 1);
