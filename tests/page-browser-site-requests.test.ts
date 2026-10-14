import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventBuffer } from "../apps/page-browser/src/buffer/buffer.ts";
import { PausedRequests } from "../apps/page-browser/src/cdp/paused.ts";
import { ApiGate } from "../apps/page-browser/src/egress/gate.ts";
import { fanslyClientCheck, sessionFingerprint, SiteSession } from "../apps/page-browser/src/hub-requests/session.ts";
import { NO_SESSION, SiteRequests, type SiteTimings } from "../apps/page-browser/src/intercept/site.ts";
import type { RequestLine } from "../apps/page-browser/src/logs/journal.ts";
import type { OperatorMode } from "../apps/page-browser/src/policy/operations.ts";
import type { BufferEvent, SiteAdmitResult, SiteDone } from "../apps/page-browser/src/rpc/protocol.ts";
import { forgetSecrets } from "../apps/page-browser/src/shared/secrets.ts";
import { makeLog, monoMs, setLogSink } from "../apps/page-browser/src/shared/util.ts";
import { FakeCdpPort, quiet, tempDir, until } from "./helpers/page-browser-fakes.ts";
import { SiteChrome, type SiteScript } from "./helpers/page-browser-site.ts";

// The site's own requests (Project Browser plan §4.3; spec §2, §3, §6.1,
// §9; owner decisions №1, №2, №3): every request of the site stops in
// Fetch; the map decides it; a request to the API waits for the engine's
// `siteAdmit` and goes only through the gate's window before its deadline;
// the answers with platform data go whole into the buffer — or as a mark —
// and the end goes to the engine as `siteDone` once durable. A scripted
// Chrome (SiteChrome) shows what CDP would, and its `wire` is what
// physically left: what the gate let up.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setLogSink(null);
  forgetSecrets();
});

const TOKEN = "fansly-token-SiTe0123456789xyz";
const CLIENT_ID = "720167541418230001";
const FINGERPRINT = sessionFingerprint(TOKEN, CLIENT_ID);
const API = "https://apiv3.fansly.com/api/v1";

function siteHeaders(path: string, token = TOKEN): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    authorization: token,
    "fansly-client-check": fanslyClientCheck(path, CLIENT_ID),
    "fansly-client-id": CLIENT_ID,
    "fansly-client-ts": "1791800000000",
    "fansly-session-id": "720167541418239999",
  };
}

/** The engine's side: what the operator asks and tells it, and its answer
 *  to each `siteAdmit` — an admission for 15 s by default, or whatever
 *  `answer` says (null: none). */
class FakeSiteEngine {
  readonly messages: Array<Record<string, unknown>> = [];
  up = true;
  epoch = 1;
  generation = 1;
  #attempt = 5000;
  answer: (ask: Record<string, unknown>) => SiteAdmitResult | null = (ask) => ({ type: "siteAdmitResult", ownerGeneration: this.generation, siteRequestId: String(ask.siteRequestId), admit: true, deadlineMono: monoMs() + 15_000, attemptId: ++this.#attempt });
  deliver: (result: SiteAdmitResult) => void = () => undefined;

  link() {
    return {
      up: () => this.up,
      epoch: () => this.epoch,
      generation: () => this.generation,
      send: (message: object) => {
        if (!this.up) return false;
        const record = message as Record<string, unknown>;
        this.messages.push(record);
        if (record.type === "siteAdmit") {
          const answer = this.answer(record);
          if (answer !== null) setImmediate(() => this.deliver(answer));
        }
        return true;
      },
    };
  }

  of(type: string): Array<Record<string, unknown>> {
    return this.messages.filter((message) => message.type === type);
  }
}

interface World {
  cdp: FakeCdpPort;
  chrome: SiteChrome;
  gate: ApiGate;
  engine: FakeSiteEngine;
  site: SiteRequests;
  buffer: EventBuffer;
  session: SiteSession;
  /** siteDone outcomes as committed (their JSON stored), by attempt. */
  done: Map<number, SiteDone>;
  faults: Array<{ reason: string; note: string }>;
  journal: RequestLine[];
  lines: string[];
  up: { why: string | null };
  refusal: { why: string | null };
  mode: { now: OperatorMode };
  /** What the engine's message order was, with the CDP commands. */
  order: string[];
}

async function world(options: { timings?: Partial<SiteTimings>; capBytes?: number; dir?: string; holdRelease?: Promise<void>; groups?: { refuse: boolean } } = {}): Promise<World> {
  let dir = options.dir;
  if (dir === undefined) {
    const temp = tempDir("pb-site-");
    cleanups.push(temp.remove);
    dir = temp.dir;
  }
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const cdp = new FakeCdpPort();
  const gate = new ApiGate();
  const chrome = new SiteChrome(cdp, gate);
  gate.cut = () => chrome.cut();
  gate.cutHeld = () => 0;
  cleanups.push(() => gate.reset());
  const engine = new FakeSiteEngine();
  const done = new Map<number, SiteDone>();
  const faults: World["faults"] = [];
  const journal: RequestLine[] = [];
  const up = { why: null as string | null };
  const refusal = { why: null as string | null };
  const mode = { now: "automation" as OperatorMode };
  const order: string[] = [];
  const buffer: EventBuffer = new EventBuffer({
    dir: join(dir, "buffer"),
    idFile: join(dir, "buffer-id"),
    batchMs: 5,
    log: quiet,
    ...(options.capBytes ? { caps: { bytes: options.capBytes } } : {}),
    onCommitted: ({ outcomes }) => {
      for (const outcome of outcomes) {
        const parsed = JSON.parse(outcome.json) as SiteDone;
        if (parsed.type === "siteDone") done.set(outcome.attemptId, parsed);
      }
    },
  });
  buffer.start();
  cleanups.push(() => buffer.close());
  const session = new SiteSession();
  let site: SiteRequests | null = null;
  const paused = new PausedRequests(cdp, {
    log: quiet,
    decide: (request) => site!.decide(request) ?? { action: "fail", reason: "BlockedByClient", why: "nobody's" },
  });
  const original = cdp.send.bind(cdp);
  cdp.send = (async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
    order.push(method);
    return original(method, params, sessionId);
  }) as typeof cdp.send;
  const link = engine.link();
  const created = new SiteRequests({
    cdp,
    resolve: (request, decision) => paused.resolve(request, decision),
    gate,
    cutApi: () => chrome.cut(),
    buffer: {
      ...bufferPort(buffer, options.holdRelease),
      appendGroup: (items) => (options.groups?.refuse ? { ok: false, reason: "disk_full" } : buffer.appendGroup(items)),
      refusal: () => refusal.why ?? buffer.refusal(),
    },
    link: {
      ...link,
      send: (message) => {
        order.push(message.type);
        return link.send(message);
      },
    },
    notUp: () => up.why,
    session: { fingerprint: () => session.fingerprint, note: (request) => session.note(request) },
    mode: () => mode.now,
    fault: (reason, note) => faults.push({ reason, note }),
    journal: (line) => journal.push(line),
    timings: { admitWaitMs: 2000, opLimitMs: 2000, requestLimitMs: 1500, mainWaitMs: 500, armWaitMs: 100, retryMs: [50], ...options.timings },
    log: makeLog("site"),
  });
  site = created;
  gate.onEvent = (event) => created.onGateEvent(event);
  engine.deliver = (result) => created.onAdmitResult(result);
  return { cdp, chrome, gate, engine, site: created, buffer, session, done, faults, journal, lines, up, refusal, mode, order };
}

/** The buffer as the site path takes it (its methods bound); `holdRelease`:
 *  an admission's write is durable only once it settles. */
function bufferPort(buffer: EventBuffer, holdRelease?: Promise<void>) {
  return {
    appendGroup: buffer.appendGroup.bind(buffer),
    changeSiteRequest: (change: Parameters<EventBuffer["changeSiteRequest"]>[0]) => {
      const appended = buffer.changeSiteRequest(change);
      if (holdRelease === undefined || !("released" in change) || !appended.ok) return appended;
      return { ok: true as const, durable: appended.durable.then(async (durable) => (await holdRelease, durable)) };
    },
    siteRequests: buffer.siteRequests.bind(buffer),
    beginBody: buffer.beginBody.bind(buffer),
    removeBody: buffer.removeBody.bind(buffer),
    readBody: buffer.readBody.bind(buffer),
  };
}

function events(buffer: EventBuffer): Array<BufferEvent & { bodyId: string | null }> {
  return buffer.readEvents(0, 1000, Number.MAX_SAFE_INTEGER).map((event) => ({ ...(JSON.parse(event.json) as BufferEvent), bodyId: event.bodyId ?? null }));
}

function siteResponses(buffer: EventBuffer): Array<Extract<BufferEvent, { kind: "site.response" }> & { bodyId: string | null }> {
  return events(buffer).filter((event) => event.kind === "site.response") as never;
}

function bodyOf(buffer: EventBuffer, bodyId: string): Buffer {
  return buffer.readBody(bodyId, 0, 64 * 1024 * 1024)!;
}

async function doneOf(w: World, count = 1): Promise<SiteDone[]> {
  await until(() => w.done.size >= count, 5000, `${count} siteDone`);
  return [...w.done.values()];
}

/** One request of the site to its end (the engine admits one at a time:
 *  the gate has one window). */
async function run(w: World, path: string, script: SiteScript): Promise<SiteDone> {
  const before = w.done.size;
  w.chrome.request(`${API}${path}`, { headers: siteHeaders(`/api/v1${path}`), script });
  await until(() => w.done.size > before, 5000, `the end of ${path}`);
  return [...w.done.values()].at(-1)!;
}

const JSON_BODY = Buffer.from(JSON.stringify({ success: true, response: { account: { id: "300000000000000001", username: "lora" } } }));

describe("a read of the API (plan §4.3)", () => {
  it("is asked of the engine with its route and session, its stream armed before the ask, released through the gate's window under the admission, and its answer kept whole before siteDone goes", async () => {
    const w = await world();
    // Chrome's own timing an hour ahead of the operator's clock: another
    // clock's, never reported (Astra's review of PR 15, round 5).
    const request = w.chrome.request(`${API}/account/me?ngsw-bypass=true`, { headers: siteHeaders("/api/v1/account/me"), script: { chunks: [JSON_BODY.subarray(0, 40), JSON_BODY.subarray(40)], timing: { requestTime: (monoMs() + 3_600_000) / 1000, sendStart: 2.5 } } });
    const [done] = await doneOf(w);
    const ask = w.engine.of("siteAdmit")[0]!;
    expect(ask).toEqual({
      type: "siteAdmit",
      siteRequestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      method: "GET",
      host: "apiv3.fansly.com",
      path: "/api/v1/account/me",
      query: "?ngsw-bypass=true",
      resourceType: "XHR",
      route: "account.me",
      operation: "read",
      sessionFingerprint: FINGERPRINT,
      pausedMono: expect.any(Number),
      waitDeadlineMono: (ask.pausedMono as number) + 2000,
    });
    // The stream was armed at the request stage, before the engine was asked.
    expect(request.armedAt).toBe("request");
    expect(w.order.indexOf("Network.streamResourceContent")).toBeLessThan(w.order.indexOf("siteAdmit"));
    expect(w.order.indexOf("siteAdmit")).toBeLessThan(w.order.indexOf("Fetch.continueRequest"));
    // One physical request, through the gate's window; its answer stopped at
    // its headers and went on.
    expect(w.chrome.wire).toEqual([{ role: "main", method: "GET", url: `${API}/account/me?ngsw-bypass=true` }]);
    expect(request.interceptResponse).toBe(true);
    expect(w.cdp.sent("Fetch.continueRequest")[0]!.params).toEqual({ requestId: request.interceptionId, interceptResponse: true });
    expect(w.chrome.pageRead.get(request.networkId)?.equals(JSON_BODY)).toBe(true);
    // The answer: whole in the buffer, its body the page's, named by the event.
    const [response] = siteResponses(w.buffer);
    expect(response).toMatchObject({
      kind: "site.response",
      siteRequestId: ask.siteRequestId,
      attemptId: done!.attemptId,
      route: "account.me",
      method: "GET",
      path: "/api/v1/account/me",
      query: "?ngsw-bypass=true",
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(JSON_BODY.length) },
      body: { decodedBytes: JSON_BODY.length, sha256: createHash("sha256").update(JSON_BODY).digest("hex") },
      complete: true,
      source: "network",
      sessionFingerprint: FINGERPRINT,
    });
    expect(response!.bodyId).toBe(response!.body.bodyId);
    expect(bodyOf(w.buffer, response!.body.bodyId).equals(JSON_BODY)).toBe(true);
    expect(done).toEqual({
      type: "siteDone",
      siteRequestId: ask.siteRequestId,
      attemptId: done!.attemptId,
      sent: true,
      sentMono: expect.any(Number),
      sentWall: expect.any(Number),
      connectionReused: true,
      status: 200,
      retryAfter: null,
      error: null,
      body: "buffered",
    });
    // The gate's first bytes, the operator's own clock — not Chrome's timing.
    expect(done!.sentMono).toBe(w.gate.lastSend!.mono);
    // Its id went with its end: nothing of it is kept.
    await until(() => w.buffer.siteRequests().length === 0, 3000, "its id to go");
    expect(w.journal).toContainEqual(expect.objectContaining({ host: "apiv3.fansly.com", path: "/api/v1/account/me", decision: "ended", status: 200, result: "200, body buffered", admission: `site request ${String(ask.siteRequestId)} (attempt ${done!.attemptId})` }));
    // The session was learned from it.
    expect(w.session.fingerprint).toBe(FINGERPRINT);
    // No secret in the log.
    for (const secret of [TOKEN, CLIENT_ID, "lora"]) expect(w.lines.join("\n"), secret).not.toContain(secret);
  });

  it("one admitted operation of the page at a time: admitted while another operation owns the page's slot, it is not released — failed, journaled, siteDone not sent; once that one ended, the next goes", async () => {
    const w = await world();
    // A Hub request in flight (an engine that overlapped them).
    expect(w.gate.open("hub:7:main", monoMs() + 15_000, 0, "R-hub-7")).toEqual({ ok: true });
    const request = w.chrome.request(`${API}/notifications`, { headers: siteHeaders("/api/v1/notifications") });
    const [done] = await doneOf(w);
    expect(request.outcome).toBe("failed");
    expect(request.failReason).toBe("Failed");
    expect(w.chrome.wire).toEqual([]);
    expect(done).toMatchObject({ sent: false, sentMono: null, status: null, error: { afterSendStart: false, message: expect.stringContaining("another admitted request of the page is unfinished: one at a time (hub:7)") } });
    expect(w.journal).toContainEqual(expect.objectContaining({ path: "/api/v1/notifications", decision: "ended", result: expect.stringContaining("the gate refused the request: another admitted request of the page is unfinished") }));
    expect(w.gate.slotOwner).toBe("hub:7");
    // Its request's end and its path's end: the site's next request goes.
    w.gate.close("hub:7:main");
    w.gate.requestEnded("R-hub-7");
    w.gate.operationEnded("hub:7");
    expect(await run(w, "/notifications", {})).toMatchObject({ sent: true, status: 200 });
  });

  it("its id is in the buffer before its siteAdmit; a buffer that refuses writes admits nothing: failed at once, nothing asked", async () => {
    const w = await world();
    w.engine.answer = () => null;
    w.chrome.request(`${API}/messaging/groups`, { headers: siteHeaders("/api/v1/messaging/groups") });
    await until(() => w.engine.of("siteAdmit").length === 1, 3000, "the ask");
    expect(w.buffer.siteRequests()).toEqual([{ siteRequestId: w.engine.of("siteAdmit")[0]!.siteRequestId, attemptId: null, released: false }]);
    w.refusal.why = "buffer_full";
    const refused = w.chrome.request(`${API}/messaging/groups`, { headers: siteHeaders("/api/v1/messaging/groups") });
    await until(() => refused.outcome === "failed", 3000, "the request to fail");
    expect(refused.failReason).toBe("Failed");
    expect(w.engine.of("siteAdmit")).toHaveLength(1);
    expect(w.chrome.wire).toEqual([]);
  });

  it("a page that is not up (the exit closed) takes none of the site's requests: the API's failed, the page's not passed", async () => {
    const w = await world();
    w.up.why = "the exit is closed";
    const api = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me") });
    const page = w.chrome.request("https://fansly.com/main.js", { resourceType: "Script" });
    await until(() => api.outcome === "failed" && page.outcome === "failed", 3000, "both to fail");
    expect([api.failReason, page.failReason]).toEqual(["Failed", "BlockedByClient"]);
    expect(w.engine.of("siteAdmit")).toEqual([]);
  });

  it("refused by the engine: failed (Failed), nothing leaves, and no siteDone (it had no attempt)", async () => {
    const w = await world();
    w.engine.answer = (ask) => ({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: String(ask.siteRequestId), admit: false, reason: "site_hour_cap" });
    const request = w.chrome.request(`${API}/notifications`, { headers: siteHeaders("/api/v1/notifications") });
    await until(() => request.outcome === "failed", 3000, "the request to fail");
    expect(request.failReason).toBe("Failed");
    expect(w.chrome.wire).toEqual([]);
    await until(() => w.buffer.siteRequests().length === 0, 3000, "its id to go");
    expect(w.done.size).toBe(0);
    expect(w.journal).toContainEqual(expect.objectContaining({ path: "/api/v1/notifications", decision: "ended", result: "refused by the engine: site_hour_cap" }));
  });

  it("no answer within its wait: failed (Failed), the reason journaled; an admission that comes later ends at once, not sent", async () => {
    const w = await world({ timings: { admitWaitMs: 150 } });
    w.engine.answer = () => null;
    const request = w.chrome.request(`${API}/subscribers`, { headers: siteHeaders("/api/v1/subscribers") });
    await until(() => request.outcome === "failed", 3000, "the wait to end");
    expect(request.failReason).toBe("Failed");
    expect(w.journal).toContainEqual(expect.objectContaining({ path: "/api/v1/subscribers", decision: "ended", result: "no admission within 150 ms" }));
    const ask = w.engine.of("siteAdmit")[0]!;
    w.site.onAdmitResult({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: String(ask.siteRequestId), admit: true, deadlineMono: monoMs() + 15_000, attemptId: 77 });
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ attemptId: 77, sent: false, status: null, error: { afterSendStart: false, message: expect.stringContaining("not used") }, body: "not_platform_data" });
    expect(w.chrome.wire).toEqual([]);
  });

  it("without the engine it waits and is asked once a link comes; a link that changes asks again what it had not answered — an answer counts only on its connection", async () => {
    const w = await world();
    w.engine.up = false;
    w.engine.answer = () => null;
    const request = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me") });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(w.engine.of("siteAdmit")).toEqual([]);
    expect(request.outcome).toBe("paused");
    w.engine.up = true;
    w.site.linkChanged(true);
    expect(w.engine.of("siteAdmit")).toHaveLength(1);
    const id = w.engine.of("siteAdmit")[0]!.siteRequestId;
    // A new connection: the same request asked again, by the same id.
    w.engine.epoch = 2;
    w.site.linkChanged(true);
    expect(w.engine.of("siteAdmit").map((ask) => ask.siteRequestId)).toEqual([id, id]);
    // An answer of the old connection would not count — here the new one
    // admits it.
    w.site.onAdmitResult({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: String(id), admit: true, deadlineMono: monoMs() + 15_000, attemptId: 90 });
    await doneOf(w);
    expect(w.chrome.wire).toHaveLength(1);
  });

  it("an admission answered on another connection than it was asked on is not used: siteDone, not sent", async () => {
    const w = await world();
    w.engine.answer = () => null;
    const request = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me") });
    await until(() => w.engine.of("siteAdmit").length === 1, 3000, "the ask");
    const id = String(w.engine.of("siteAdmit")[0]!.siteRequestId);
    w.engine.epoch = 2;
    w.site.onAdmitResult({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: id, admit: true, deadlineMono: monoMs() + 15_000, attemptId: 91 });
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ attemptId: 91, sent: false });
    expect(request.outcome).toBe("paused");
    expect(w.chrome.wire).toEqual([]);
  });
});

describe("a CORS preflight (owner decision №1)", () => {
  it("is part of its request: one admission asked at the preflight with the request's method, the preflight handed on by fulfill, the request under the same admission", async () => {
    const w = await world();
    const request = w.chrome.request(`${API}/message?groupId=1`, { headers: siteHeaders("/api/v1/message"), script: { preflight: 204, chunks: [JSON_BODY] } });
    const [done] = await doneOf(w);
    expect(w.engine.of("siteAdmit")).toHaveLength(1);
    expect(w.engine.of("siteAdmit")[0]).toMatchObject({ method: "GET", resourceType: "XHR", route: "messages.page", sessionFingerprint: null });
    expect(w.chrome.wire.map((entry) => entry.role)).toEqual(["preflight", "main"]);
    expect(w.chrome.preflightOf(request)!.outcome).toBe("fulfilled");
    expect(done).toMatchObject({ sent: true, status: 200, body: "buffered" });
    // Armed at the request's own pause, before it went on.
    expect(request.armedAt).toBe("request");
    expect(siteResponses(w.buffer)[0]).toMatchObject({ route: "messages.page", complete: true, sessionFingerprint: FINGERPRINT });
  });

  it("a non-2xx answer to the preflight is its operation's answer: the request never left", async () => {
    const w = await world();
    w.chrome.request(`${API}/message?groupId=1`, { headers: siteHeaders("/api/v1/message"), script: { preflight: 429, headers: [{ name: "retry-after", value: "30" }] } });
    const [done] = await doneOf(w);
    expect(w.chrome.wire.map((entry) => entry.role)).toEqual(["preflight"]);
    expect(done).toMatchObject({ sent: true, status: 429, retryAfter: "30", body: "not_platform_data", error: null });
    expect(siteResponses(w.buffer)).toEqual([]);
  });

  it("the page aborts a request that waits for its admission, its preflight still paused: ended at once, the preflight failed in Chrome and never released, a late admission not used", async () => {
    const w = await world();
    w.engine.answer = () => null;
    const request = w.chrome.request(`${API}/message?groupId=1`, { headers: siteHeaders("/api/v1/message"), script: { preflight: 204 } });
    const preflight = w.chrome.preflightOf(request)!;
    await until(() => w.engine.of("siteAdmit").length === 1, 3000, "the ask");
    w.chrome.abort(request);
    await until(() => preflight.outcome === "failed", 3000, "the paused preflight to be failed");
    expect(w.site.live).toBe(0);
    expect(w.journal).toContainEqual(expect.objectContaining({ decision: "ended", result: "the request ended before it was released: net::ERR_ABORTED" }));
    w.site.onAdmitResult({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: String(w.engine.of("siteAdmit")[0]!.siteRequestId), admit: true, deadlineMono: monoMs() + 15_000, attemptId: 73 });
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ attemptId: 73, sent: false });
    expect(w.chrome.wire).toEqual([]);
    expect(w.faults).toEqual([]);
  });

  it("Chrome names a preflight's request after the preflight paused (the sessions' order is not guaranteed): the request's abort still ends its operation", async () => {
    const w = await world();
    w.engine.answer = () => null;
    const request = w.chrome.request(`${API}/message?groupId=1`, { headers: siteHeaders("/api/v1/message"), script: { preflight: 204, willBeSentDelayMs: 60 } });
    const preflight = w.chrome.preflightOf(request)!;
    await until(() => w.engine.of("siteAdmit").length === 1, 3000, "the ask");
    await new Promise((resolve) => setTimeout(resolve, 120));
    w.chrome.abort(request);
    // At once — not when its wait for an admission is over.
    await until(() => preflight.outcome === "failed", 500, "the paused preflight to be failed");
    expect(w.site.live).toBe(0);
    expect(w.journal).toContainEqual(expect.objectContaining({ decision: "ended", result: "the request ended before it was released: net::ERR_ABORTED" }));
    expect(w.chrome.wire).toEqual([]);
  });

  it("the page aborts a request whose preflight is in flight: the operation ends with the preflight's answer — the sender's word — and never hangs", async () => {
    const w = await world({ timings: { mainWaitMs: 5000, opLimitMs: 5000 } });
    const request = w.chrome.request(`${API}/message?groupId=1`, { headers: siteHeaders("/api/v1/message"), script: { preflight: 204, preflightDelayMs: 150 } });
    await until(() => w.chrome.wire.length === 1, 3000, "the preflight on the wire");
    w.chrome.abort(request);
    const [done] = await doneOf(w);
    expect(w.chrome.preflightOf(request)!.outcome).toBe("fulfilled");
    expect(done).toMatchObject({ sent: true, status: null, error: { afterSendStart: true, message: "the request ended before it was released: net::ERR_ABORTED" }, body: "not_platform_data" });
    expect(w.chrome.wire.map((entry) => entry.role)).toEqual(["preflight"]);
    expect(w.faults).toEqual([]);
    expect(w.site.live).toBe(0);
  });

  it("a request that never follows its passed preflight, of which Chrome tells nothing, holds its operation to the operation's limit: then the page stops (request_unended) — one admission, one end", async () => {
    const w = await world({ timings: { mainWaitMs: 150, opLimitMs: 400, requestLimitMs: 5000 } });
    const request = w.chrome.request(`${API}/message?groupId=1`, { headers: siteHeaders("/api/v1/message"), script: { preflight: 204 } });
    // The request is gone without a word (its document went).
    request.ended = true;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(w.done.size).toBe(0);
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ sent: true, status: null, error: { message: expect.stringContaining("no answer and no end") } });
    expect(w.faults.map((fault) => fault.reason)).toEqual(["request_unended"]);
    expect(w.engine.of("siteAdmit")).toHaveLength(1);
  });

  it("a request that pauses long after its passed preflight goes under the same admission: one operation, one siteAdmit, one siteDone (Astra's review of PR 7)", async () => {
    const w = await world({ timings: { mainWaitMs: 150 } });
    const request = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { preflight: 204, mainDelayMs: 600 } });
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ attemptId: 5001, sent: true, status: 200, body: "buffered" });
    expect(request.outcome).toBe("continued");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(w.engine.of("siteAdmit")).toHaveLength(1);
    expect(w.done.size).toBe(1);
    expect(w.chrome.wire).toEqual([
      { role: "preflight", method: "OPTIONS", url: `${API}/account/me` },
      { role: "main", method: "GET", url: `${API}/account/me` },
    ]);
  });

  it("between a passed preflight and its request the operation keeps the page's slot: another admitted meanwhile is refused, and the request goes under its own admission (Astra's 3)", async () => {
    const w = await world();
    const first = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { preflight: 204, mainDelayMs: 600 } });
    // Its preflight went and was handed on; its request is still to come.
    await until(() => w.cdp.sent("Fetch.fulfillRequest").length === 1, 3000, "the preflight handed on");
    const owner = w.gate.slotOwner;
    expect(owner).toMatch(/^site:/);
    expect(w.gate.slotPending).toEqual([]);
    // An engine that admits another one meanwhile.
    const second = w.chrome.request(`${API}/notifications`, { headers: siteHeaders("/api/v1/notifications") });
    await until(() => second.outcome === "failed", 3000, "the second refused");
    const done = await doneOf(w, 2);
    expect(done.find((entry) => entry.status === null)).toMatchObject({ sent: false, error: { message: expect.stringContaining(`one at a time (${owner})`) } });
    expect(done.find((entry) => entry.status !== null)).toMatchObject({ sent: true, status: 200 });
    expect(first.outcome).toBe("continued");
    expect(w.chrome.wire).toEqual([
      { role: "preflight", method: "OPTIONS", url: `${API}/account/me` },
      { role: "main", method: "GET", url: `${API}/account/me` },
    ]);
    await until(() => w.gate.slotOwner === null, 3000, "the slot free");
  });

  it("a request whose passed preflight's operation ended before it paused is failed, never asked as an operation of its own (Astra's review of PR 7)", async () => {
    const w = await world({ timings: { opLimitMs: 300, requestLimitMs: 5000 } });
    const request = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { preflight: 204, mainDelayMs: 700 } });
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ sent: true, status: null, error: { message: expect.stringContaining("no answer and no end") } });
    expect(w.faults.map((fault) => fault.reason)).toEqual(["request_unended"]);
    await until(() => request.outcome === "failed", 3000, "the late request to fail");
    expect(request.failReason).toBe("Failed");
    expect(w.engine.of("siteAdmit")).toHaveLength(1);
    expect(w.chrome.wire).toEqual([{ role: "preflight", method: "OPTIONS", url: `${API}/account/me` }]);
  });

  it("a request taken by its method and URL while Chrome had named no request of the preflight: the request Chrome names later is an operation of its own, and keeps its own end (Astra's review of PR 7)", async () => {
    const w = await world();
    const admit = w.engine.answer;
    w.engine.answer = (ask) => (w.engine.of("siteAdmit").length === 1 ? admit(ask) : null);
    // Chrome tells of the preflight's request only later (the sessions'
    // order is not guaranteed); a read without platform data keeps no body.
    w.chrome.request(`${API}/device/id`, { headers: siteHeaders("/api/v1/device/id"), script: { preflight: 204, preflightDelayMs: 100, willBeSentDelayMs: 300 } });
    await until(() => w.chrome.wire.length === 1, 3000, "the preflight in flight");
    // Another request of the same method and URL, slow to answer: taken for it.
    const taken = w.chrome.request(`${API}/device/id`, { headers: siteHeaders("/api/v1/device/id"), script: { chunkDelayMs: 600 } });
    await until(() => w.engine.of("siteAdmit").length === 2, 3000, "the preflight's own request asked on its own");
    expect(taken.outcome).toBe("continued");
    // Chrome names the preflight's request now: not the operation's any more.
    const [first] = await doneOf(w);
    expect(first).toMatchObject({ attemptId: 5001, sent: true, status: 200 });
    const ask = w.engine.of("siteAdmit")[1]!;
    w.site.onAdmitResult({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: String(ask.siteRequestId), admit: true, deadlineMono: monoMs() + 15_000, attemptId: 89 });
    await doneOf(w, 2);
    expect(w.done.get(89)).toMatchObject({ sent: true, status: 200 });
    expect(w.faults).toEqual([]);
  });

  it("a request of the same method and URL while another's preflight is in flight, Chrome having named that preflight's request: an operation of its own, asked on its own, never released under the other's admission (Astra's review of PR 7)", async () => {
    const w = await world();
    const admit = w.engine.answer;
    w.engine.answer = (ask) => (w.engine.of("siteAdmit").length === 1 ? admit(ask) : null);
    const first = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { preflight: 204, preflightDelayMs: 150 } });
    await until(() => w.chrome.wire.length === 1, 3000, "the first one's preflight in flight");
    const second = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me") });
    await until(() => w.engine.of("siteAdmit").length === 2, 3000, "the second one asked on its own");
    expect(second.outcome).toBe("paused");
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ attemptId: 5001, sent: true, status: 200 });
    expect(first.outcome).toBe("continued");
    expect(w.chrome.wire).toEqual([
      { role: "preflight", method: "OPTIONS", url: `${API}/account/me` },
      { role: "main", method: "GET", url: `${API}/account/me` },
    ]);
    expect(w.chrome.wire.length).toBe(2);
    // Its own admission: it goes, and ends on its own.
    const ask = w.engine.of("siteAdmit")[1]!;
    w.site.onAdmitResult({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: String(ask.siteRequestId), admit: true, deadlineMono: monoMs() + 15_000, attemptId: 88 });
    await doneOf(w, 2);
    expect(w.done.get(88)).toMatchObject({ sent: true, status: 200 });
    expect(second.outcome).toBe("continued");
  });

  it("a request whose session is not the one its admission was asked under is not released: the session changed between the preflight and the request", async () => {
    const w = await world();
    // The live session when the preflight asks.
    w.session.note({ method: "GET", url: `${API}/account/me`, headers: siteHeaders("/api/v1/account/me") });
    const request = w.chrome.request(`${API}/message?groupId=1`, { headers: siteHeaders("/api/v1/message", "fansly-token-AnotherLogin000111222"), script: { preflight: 204 } });
    const [done] = await doneOf(w);
    expect(w.engine.of("siteAdmit")[0]).toMatchObject({ sessionFingerprint: FINGERPRINT });
    expect(w.chrome.wire.map((entry) => entry.role)).toEqual(["preflight"]);
    expect(request.outcome).toBe("failed");
    expect(done).toMatchObject({ sent: true, status: null, error: { afterSendStart: true, message: "its request did not go: the session changed between the admission and the request" } });
  });
});

describe("the answer's body (plan §4.2 step 7, §4.3; stage 1, amendment 8)", () => {
  const whole = (script: SiteScript) => script;

  it("not armed at the request stage (its session not known yet): armed at the response stage, before a byte reaches the page, and kept whole", async () => {
    const w = await world();
    // Chrome tells of the request (its session) only after the arming's
    // wait at the request stage is over; the engine answers later still.
    const admit = w.engine.answer;
    w.engine.answer = () => null;
    const request = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: whole({ willBeSentDelayMs: 200, chunks: [JSON_BODY] }) });
    await until(() => w.engine.of("siteAdmit").length === 1, 3000, "the ask");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(request.armedAt).toBeNull();
    w.site.onAdmitResult(admit(w.engine.of("siteAdmit")[0]!)!);
    const [done] = await doneOf(w);
    expect(request.armedAt).toBe("response");
    expect(done).toMatchObject({ status: 200, body: "buffered" });
    expect(siteResponses(w.buffer)[0]).toMatchObject({ complete: true });
  });

  it("read as a stream (a cancel after the answer): whole by its declared length, or by its JSON shape; a truncated one is a mark, its body not kept", async () => {
    const w = await world();
    const done = [
      await run(w, "/account/me", { then: "cancel_after_answer", chunks: [JSON_BODY] }),
      await run(w, "/notifications", { then: "cancel_after_answer", chunked: true, chunks: [JSON_BODY.subarray(0, 30), JSON_BODY.subarray(30)] }),
      await run(w, "/subscribers", { then: "cancel_after_answer", chunked: true, chunks: [JSON_BODY.subarray(0, 30)] }),
      // Declared longer than what came: not whole, whatever its shape.
      await run(w, "/polls", { then: "cancel_after_answer", contentLength: JSON_BODY.length + 5, chunks: [JSON_BODY] }),
    ];
    expect(done.map((entry) => entry.body)).toEqual(["buffered", "buffered", "incomplete", "incomplete"]);
    expect(w.faults).toEqual([]);
    const responses = siteResponses(w.buffer);
    expect(responses.map((response) => [response.route, response.complete])).toEqual(
      expect.arrayContaining([
        ["account.me", true],
        ["notifications.page", true],
        ["subscribers.page", false],
        ["polls", false],
      ]),
    );
    const mark = responses.find((response) => response.route === "subscribers.page")!;
    expect(mark.bodyId).toBeNull();
    expect(mark.body).toMatchObject({ decodedBytes: 0 });
  });

  it("a chunk without its data, a short chunk, a body that broke off: never kept as a fact — a mark, siteDone says incomplete", async () => {
    const w = await world();
    const done = [
      await run(w, "/account/me", { unstreamed: true, chunks: [JSON_BODY] }),
      await run(w, "/notifications", { brokenChunk: true, chunks: [JSON_BODY] }),
      await run(w, "/subscribers", { then: "body_fails", chunks: [JSON_BODY] }),
    ];
    expect(done.map((entry) => [entry.status, entry.body])).toEqual([
      [200, "incomplete"],
      [200, "incomplete"],
      [200, "incomplete"],
    ]);
    expect(siteResponses(w.buffer).map((response) => [response.complete, response.bodyId])).toEqual([
      [false, null],
      [false, null],
      [false, null],
    ]);
  });

  it("a stream that delivers nothing though the answer has a body (the site's service worker passing it on) is a mark, never an empty fact; an answer without a body is whole", async () => {
    const w = await world();
    const done = [
      // Its length declared: none of it came.
      await run(w, "/account/me", { deliversNothing: true, chunks: [JSON_BODY] }),
      // Nothing declared, nothing came: not known to be empty.
      await run(w, "/notifications", { deliversNothing: true, chunked: true, chunks: [JSON_BODY] }),
      // No body by its status, and one declared empty.
      await run(w, "/subscribers", { status: 204, chunked: true, chunks: [] }),
      await run(w, "/polls", { chunks: [] }),
    ];
    expect(done.map((entry) => [entry.status, entry.body])).toEqual([
      [200, "incomplete"],
      [200, "incomplete"],
      [204, "buffered"],
      [200, "buffered"],
    ]);
    expect(siteResponses(w.buffer).map((response) => [response.complete, response.body.decodedBytes, response.bodyId === null])).toEqual([
      [false, 0, true],
      [false, 0, true],
      [true, 0, false],
      [true, 0, false],
    ]);
  });

  it("from the browser's cache, revalidated by the server, through the site's service worker: the source says which", async () => {
    const w = await world();
    w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { wireStatus: 304 } });
    await doneOf(w, 1);
    w.chrome.request(`${API}/notifications`, { headers: siteHeaders("/api/v1/notifications"), script: { fromServiceWorker: true } });
    await doneOf(w, 2);
    expect(siteResponses(w.buffer).map((response) => response.source)).toEqual(["revalidated_304", "service_worker"]);
  });

  it("a redirect is answered as final, without its Location, and kept as the answer (an empty body)", async () => {
    const w = await world();
    w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { status: 302, headers: [{ name: "location", value: "https://elsewhere.example/x" }], chunks: [Buffer.alloc(0)] } });
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ status: 302, body: "buffered" });
    const fulfill = w.cdp.sent("Fetch.fulfillRequest").at(-1)!;
    expect(fulfill.params.responseCode).toBe(302);
    expect((fulfill.params.responseHeaders as Array<{ name: string }>).map((entry) => entry.name.toLowerCase())).not.toContain("location");
    expect(siteResponses(w.buffer)[0]).toMatchObject({ status: 302, complete: true, body: { decodedBytes: 0 }, source: "network" });
  });

  it("a request without a session (the login screens' reads) is asked with none; its answer names the empty session", async () => {
    const w = await world();
    w.chrome.request(`${API}/versioning`, { headers: { Accept: "application/json" } });
    await doneOf(w);
    expect(w.engine.of("siteAdmit")[0]).toMatchObject({ route: "site.other", sessionFingerprint: null });
    expect(siteResponses(w.buffer)[0]).toMatchObject({ route: "site.other", complete: true, sessionFingerprint: NO_SESSION });
  });

  it("a body that grows past the buffer's cap is not written past it: the buffer is full while it grows, the answer a mark (Astra's review of PR 7)", async () => {
    const w = await world({ capBytes: 4096 });
    const body = Buffer.alloc(16 * 1024, 0x61);
    const chunks = Array.from({ length: 16 }, (_, i) => body.subarray(i * 1024, (i + 1) * 1024));
    w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { chunkDelayMs: 30, chunks } });
    await until(() => w.buffer.refusal() === "buffer_full", 5000, "the cap reached while the body grows");
    expect(w.buffer.stats().bytes).toBeGreaterThan(0);
    const bodies = join(w.buffer.dir, "bodies");
    for (const name of readdirSync(bodies)) expect(statSync(join(bodies, name)).size, name).toBeLessThanOrEqual(4096);
    // Admissions stop with it.
    const refused = w.chrome.request(`${API}/notifications`, { headers: siteHeaders("/api/v1/notifications") });
    await until(() => refused.outcome === "failed", 3000, "no admission");
    await until(() => w.engine.of("siteDone").length === 1, 5000, "its end, told from memory");
    expect(w.engine.of("siteDone")[0]).toMatchObject({ sent: true, status: 200, body: "incomplete" });
    expect(w.engine.of("siteAdmit")).toHaveLength(1);
  });

  it("a 429 with Retry-After: the status and the header go to the engine, the answer is kept as it came", async () => {
    const w = await world();
    const done = await run(w, "/messaging/groups", { status: 429, headers: [{ name: "Retry-After", value: "17" }, { name: "content-type", value: "application/json" }], chunks: [Buffer.from('{"success":false}')] });
    expect(done).toMatchObject({ sent: true, status: 429, retryAfter: "17", error: null, body: "buffered" });
    expect(siteResponses(w.buffer)[0]).toMatchObject({ route: "messaging.groups", status: 429, complete: true, headers: { "retry-after": "17" } });
  });

  it("a route without platform data (the device id) is admitted, its answer not kept", async () => {
    const w = await world();
    w.chrome.request(`${API}/device/id`, { headers: siteHeaders("/api/v1/device/id") });
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ status: 200, body: "not_platform_data" });
    expect(siteResponses(w.buffer)).toEqual([]);
    expect(w.cdp.sent("Network.streamResourceContent")).toEqual([]);
  });
});

describe("what the map closes, and the modes (plan §4.6; spec §2; owner decision №2)", () => {
  it("a closed write, a write outside the login, a closed read, another host's write: failed (BlockedByClient), nothing asked", async () => {
    const w = await world();
    const requests = [
      w.chrome.request(`${API}/message/ack`, { method: "POST", headers: siteHeaders("/api/v1/message/ack"), postData: '{"messageIds":["1"],"type":2}' }),
      w.chrome.request(`${API}/message`, { method: "POST", headers: siteHeaders("/api/v1/message"), postData: "{}" }),
      w.chrome.request(`${API}/emails/unsubscribe`, { headers: siteHeaders("/api/v1/emails/unsubscribe") }),
      w.chrome.request("https://fansly.com/", { method: "POST", resourceType: "Document", postData: "x" }),
      w.chrome.request("http://169.254.169.254/latest", { resourceType: "Fetch" }),
    ];
    await until(() => requests.every((request) => request.outcome === "failed"), 3000, "all to fail");
    expect(requests.map((request) => request.failReason)).toEqual(["BlockedByClient", "BlockedByClient", "BlockedByClient", "BlockedByClient", "BlockedByClient"]);
    expect(w.engine.of("siteAdmit")).toEqual([]);
    expect(w.chrome.wire).toEqual([]);
  });

  it("the login: refused in the automation mode; in the manual login admitted as an operation, its body counted by the gate, its answer never kept", async () => {
    const w = await world();
    const automation = w.chrome.request(`${API}/login`, { method: "POST", headers: { "content-type": "application/json" }, postData: '{"username":"u","password":"pw-secret-1"}' });
    await until(() => automation.outcome === "failed", 3000, "the login refused");
    expect(automation.failReason).toBe("BlockedByClient");
    w.mode.now = "manual_login";
    w.chrome.request(`${API}/login`, { method: "POST", headers: { "content-type": "application/json" }, postData: '{"username":"u","password":"pw-secret-1"}', script: { chunks: [Buffer.from('{"success":true,"response":{"session":{"token":"tok-secret"}}}')] } });
    const [done] = await doneOf(w);
    expect(w.engine.of("siteAdmit")[0]).toMatchObject({ method: "POST", route: "auth.login", operation: "login" });
    expect(done).toMatchObject({ status: 200, body: "not_platform_data" });
    expect(siteResponses(w.buffer)).toEqual([]);
    expect(w.chrome.wire).toEqual([{ role: "main", method: "POST", url: `${API}/login` }]);
    for (const secret of ["pw-secret-1", "tok-secret"]) expect(w.lines.join("\n"), secret).not.toContain(secret);
  });

  it("the page's own files and third-party hosts pass at once, unpaced, the journal says their size and time at their end", async () => {
    const w = await world();
    const script = w.chrome.request("https://fansly.com/main.js?v=1", { resourceType: "Script" });
    const third = w.chrome.request("https://widget.intercom.io/widget/abc", { resourceType: "Script" });
    await until(() => script.outcome === "continued" && third.outcome === "continued", 3000, "both to pass");
    expect(w.engine.of("siteAdmit")).toEqual([]);
    expect(script.interceptResponse).toBe(false);
    await until(() => w.journal.some((line) => line.host === "fansly.com" && line.decision === "ended"), 3000, "its end");
    expect(w.journal).toContainEqual(expect.objectContaining({ method: "GET", host: "fansly.com", path: "/main.js", resourceType: "Script", decision: "ended", result: "finished", bytes: expect.any(Number), durationMs: expect.any(Number) }));
    expect(w.chrome.wire.map((entry) => new URL(entry.url).hostname)).toEqual(["fansly.com", "widget.intercom.io"]);
  });

  it("a passed request's CORS preflight is handed on by fulfill too, never continued to its end (stage 1, amendment 3)", async () => {
    const w = await world();
    const request = w.chrome.request("https://api-iam.intercom.io/messenger/web/ping", { method: "POST", resourceType: "XHR", postData: "{}", script: { preflight: 200 } });
    await until(() => request.ended, 3000, "the request to end");
    const preflight = w.chrome.preflightOf(request)!;
    expect(preflight.interceptResponse).toBe(true);
    expect(preflight.outcome).toBe("fulfilled");
    expect(w.chrome.unfulfilledPreflights).toBe(0);
    expect(request.outcome).toBe("continued");
    expect(w.chrome.wire.map((entry) => entry.role)).toEqual(["preflight", "main"]);
    expect(w.engine.of("siteAdmit")).toEqual([]);
  });

  it("a request Chrome gives no network id cannot be followed to its end: not admitted", async () => {
    const w = await world();
    w.cdp.emit("Fetch.requestPaused", { requestId: "I-anon", request: { url: `${API}/account/me`, method: "GET", headers: siteHeaders("/api/v1/account/me") }, resourceType: "XHR", frameId: "F1" });
    await until(() => w.cdp.sent("Fetch.failRequest").length === 1, 3000, "the request to fail");
    expect(w.cdp.sent("Fetch.failRequest")[0]!.params).toEqual({ requestId: "I-anon", errorReason: "Failed" });
    expect(w.engine.of("siteAdmit")).toEqual([]);
  });
});

describe("the gate and the end of a request (spec §9; stage 1, amendments 23, 36, 37)", () => {
  it("Chrome's own repeat of a request is held by the gate: one physical request per admission", async () => {
    const w = await world();
    w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { then: "retry" } });
    await until(() => w.chrome.wire.length >= 1, 3000, "the send");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.chrome.wire).toHaveLength(1);
  });

  it("the page cancels a released request before its answer: the page stops (request_unended), the end told as sent", async () => {
    const w = await world();
    w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { then: "cancel_after_send" } });
    const [done] = await doneOf(w);
    expect(w.faults).toEqual([{ reason: "request_unended", note: expect.stringContaining("cancelled a released request before its answer") }]);
    expect(done).toMatchObject({ sent: true, status: null, error: { afterSendStart: true } });
  });

  it("no answer and no end within its limit: the page stops (request_unended)", async () => {
    const w = await world({ timings: { opLimitMs: 200, requestLimitMs: 5000 } });
    w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { then: "hang_after_send" } });
    const [done] = await doneOf(w);
    expect(w.faults.map((fault) => fault.reason)).toEqual(["request_unended"]);
    expect(done).toMatchObject({ sent: true, status: null });
  });

  it("an answer whose body still comes at the request's limit: its tunnels cut, the answer told with its status, its body a mark", async () => {
    const w = await world({ timings: { requestLimitMs: 150, opLimitMs: 5000 } });
    w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { chunkDelayMs: 100, chunks: [JSON_BODY.subarray(0, 10), JSON_BODY.subarray(10, 20), JSON_BODY.subarray(20)] } });
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ sent: true, status: 200, body: "incomplete" });
    expect(w.faults).toEqual([]);
  });

  it("an end the buffer refuses: the engine hears from memory at once, the body gone — incomplete; the end and the answer's mark are written once it takes writes", async () => {
    const groups = { refuse: false };
    const w = await world({ groups });
    const request = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { chunkDelayMs: 30, chunks: [JSON_BODY] } });
    await until(() => request.outcome === "continued", 3000, "the release");
    groups.refuse = true;
    await until(() => w.engine.of("siteDone").length === 1, 3000, "the end told from memory");
    expect(w.engine.of("siteDone")[0]).toMatchObject({ attemptId: 5001, sent: true, status: 200, body: "incomplete" });
    expect(siteResponses(w.buffer)).toEqual([]);
    expect(w.done.size).toBe(0);
    groups.refuse = false;
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ attemptId: 5001, status: 200, body: "incomplete" });
    expect(siteResponses(w.buffer)).toEqual([expect.objectContaining({ route: "account.me", complete: false, bodyId: null, body: expect.objectContaining({ decodedBytes: 0 }) })]);
    await until(() => w.buffer.siteRequests().length === 0, 3000, "its id to go");
  });

  it("the page stops while an answer's body comes: its status and Retry-After kept, its body a mark — site.response complete: false and siteDone incomplete in one commit (Astra's review of PR 7)", async () => {
    const w = await world();
    const request = w.chrome.request(`${API}/notifications`, {
      headers: siteHeaders("/api/v1/notifications"),
      script: { status: 429, headers: [{ name: "content-type", value: "application/json" }, { name: "retry-after", value: "7" }], chunkDelayMs: 150, chunks: [JSON_BODY.subarray(0, 20), JSON_BODY.subarray(20)] },
    });
    await until(() => request.stage === "response", 3000, "the answer");
    await new Promise((resolve) => setTimeout(resolve, 200));
    w.site.endAll("the engine's closeExit", false);
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ sent: true, status: 429, retryAfter: "7", body: "incomplete", error: { afterSendStart: true, message: "the page stopped: the engine's closeExit" } });
    const [response] = siteResponses(w.buffer);
    expect(response).toMatchObject({ siteRequestId: done!.siteRequestId, attemptId: done!.attemptId, status: 429, complete: false, bodyId: null, body: { decodedBytes: 0 } });
    expect(response!.headers).toMatchObject({ "retry-after": "7" });
    expect(readdirSync(join(w.buffer.dir, "bodies"))).toEqual([]);
  });

  it("an admission past its deadline at the release is not used: nothing leaves", async () => {
    const w = await world();
    w.engine.answer = (ask) => ({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: String(ask.siteRequestId), admit: true, deadlineMono: monoMs() - 1, attemptId: 61 });
    const request = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me") });
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ attemptId: 61, sent: false, error: { message: "not used: the admission came expired" } });
    expect(request.outcome).toBe("failed");
    expect(w.chrome.wire).toEqual([]);
  });
});

describe("documents, owners, restarts (stage 1, amendment 41; plan §4.7, §4.9)", () => {
  it("a request of a document the site replaced is never released: failed at once while it waits, not used once admitted", async () => {
    const w = await world();
    w.engine.answer = () => null;
    const waiting = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), frameId: "F1", loaderId: "L1" });
    await until(() => w.engine.of("siteAdmit").length === 1, 3000, "the ask");
    w.chrome.navigate("F1", "L1");
    w.chrome.navigate("F1", "L2");
    await until(() => waiting.outcome === "failed", 3000, "the old document's request to fail");
    expect(w.journal).toContainEqual(expect.objectContaining({ decision: "ended", result: "its document was replaced while it waited" }));
    // Admitted after its document went: not released, the engine hears.
    const late = w.chrome.request(`${API}/notifications`, { headers: siteHeaders("/api/v1/notifications"), frameId: "F1", loaderId: "L2" });
    await until(() => w.engine.of("siteAdmit").length === 2, 3000, "the second ask");
    const id = String(w.engine.of("siteAdmit")[1]!.siteRequestId);
    w.chrome.navigate("F1", "L3");
    w.site.onAdmitResult({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: id, admit: true, deadlineMono: monoMs() + 15_000, attemptId: 70 });
    expect(late.outcome).toBe("failed");
    expect(w.chrome.wire).toEqual([]);
  });

  it("the work tab loaded anew (plan §4.1, step 9): what failed before is counted, what waits ends under that reason — never counted, never released — and a request that pauses before the next document comes is of the old one", async () => {
    let release: () => void = () => undefined;
    const w = await world({ holdRelease: new Promise<void>((resolve) => (release = resolve)) });
    w.chrome.navigate("F1", "L1");
    const refuse = (ask: Record<string, unknown>): SiteAdmitResult => ({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: String(ask.siteRequestId), admit: false, reason: "mode" });
    const admit = w.engine.answer;
    w.engine.answer = (ask) => (ask.path === "/api/v1/notifications" ? refuse(ask) : ask.path === "/api/v1/subscribers" ? null : admit(ask));
    // Refused by the engine: one that failed, nothing of it sent. What the
    // map closes is not of the count.
    const refused = w.chrome.request(`${API}/notifications`, { headers: siteHeaders("/api/v1/notifications") });
    const closed = w.chrome.request(`${API}/message/ack`, { method: "POST", headers: siteHeaders("/api/v1/message/ack"), postData: "{}" });
    await until(() => refused.outcome === "failed" && closed.outcome === "failed", 3000, "both to fail");
    expect(w.site.failures).toBe(1);
    // Failed at once, never asked: a buffer that takes no writes, no network id.
    w.refusal.why = "buffer_full";
    const unwritten = w.chrome.request(`${API}/notifications`, { headers: siteHeaders("/api/v1/notifications") });
    await until(() => unwritten.outcome === "failed", 3000, "the refusal");
    w.refusal.why = null;
    w.cdp.emit("Fetch.requestPaused", { requestId: "I-anon", request: { url: `${API}/account/me`, method: "GET", headers: siteHeaders("/api/v1/account/me") }, resourceType: "XHR", frameId: "F1" });
    await until(() => w.cdp.sent("Fetch.failRequest").some((command) => command.params.requestId === "I-anon"), 3000, "the anonymous one to fail");
    expect(w.site.failures).toBe(3);
    // One asked and not answered, one admitted whose release is not durable yet.
    const waiting = w.chrome.request(`${API}/subscribers`, { headers: siteHeaders("/api/v1/subscribers") });
    const admitted = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me") });
    await until(() => w.engine.of("siteAdmit").length === 3, 3000, "both asked");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(w.site.released).toBe(0);
    w.site.reloading("F1");
    release();
    await until(() => waiting.outcome === "failed" && admitted.outcome === "failed", 3000, "both to end");
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ attemptId: 5001, sent: false, error: { message: "not used: the work tab is loaded anew" } });
    expect(w.journal).toContainEqual(expect.objectContaining({ path: "/api/v1/subscribers", decision: "ended", result: "the work tab is loaded anew" }));
    expect(w.site.failures).toBe(3);
    // An admission for the one that waited, late: not used.
    const late = String(w.engine.of("siteAdmit")[1]!.siteRequestId);
    w.site.onAdmitResult({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: late, admit: true, deadlineMono: monoMs() + 15_000, attemptId: 71 });
    await doneOf(w, 2);
    expect(w.done.get(71)).toMatchObject({ sent: false });
    // The old document's request that pauses before Chrome commits the next,
    // its loader not told yet: never released, though admitted.
    const stray = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { noWillBeSent: true } });
    await until(() => stray.outcome === "failed", 3000, "the stray to fail");
    expect(w.chrome.wire).toEqual([]);
    // The new document's own: as ever, released, in flight until its end.
    w.chrome.navigate("F1", "L2");
    w.site.resetFailures();
    expect(w.site.failures).toBe(0);
    const fresh = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), loaderId: "L2", script: { chunkDelayMs: 150, chunks: [JSON_BODY.subarray(0, 20), JSON_BODY.subarray(20)] } });
    await until(() => w.site.released === 1, 3000, "the release");
    await until(() => fresh.ended && w.site.released === 0, 3000, "its end");
    expect(w.chrome.wire).toEqual([{ role: "main", method: "GET", url: `${API}/account/me` }]);
  });

  it("a new owner: an earlier owner's admission not released never goes; a released one is waited for", async () => {
    let release: () => void = () => undefined;
    const w = await world({ holdRelease: new Promise<void>((resolve) => (release = resolve)) });
    const request = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me") });
    await until(() => w.engine.of("siteAdmit").length === 1, 3000, "the ask");
    await new Promise((resolve) => setTimeout(resolve, 30));
    w.engine.generation = 2;
    await w.site.quiesce(2);
    release();
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ attemptId: 5001, sent: false, error: { message: "not used: a new owner of the page" } });
    expect(request.outcome).toBe("failed");
    expect(w.chrome.wire).toEqual([]);
  });

  it("recover: not_sent of an admission not released — and it never is; unknown of a released one", async () => {
    let release: () => void = () => undefined;
    const w = await world({ holdRelease: new Promise<void>((resolve) => (release = resolve)) });
    const request = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me") });
    await until(() => w.engine.of("siteAdmit").length === 1, 3000, "the ask");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(w.site.recoverState(5001)).toBe("not_sent");
    expect(w.site.recoverState(9999)).toBeNull();
    release();
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ attemptId: 5001, sent: false, error: { message: "not used: the engine's recover closed it as not sent" } });
    expect(request.outcome).toBe("failed");
    expect(w.chrome.wire).toEqual([]);
    const other = await world();
    other.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me"), script: { then: "hang_after_send" } });
    await until(() => other.chrome.wire.length === 1, 3000, "the send");
    expect(other.site.recoverState(5001)).toBe("unknown");
  });

  it("the page stops (a proxy that failed): what waits is failed, an admission not released ends not sent, nothing is asked again", async () => {
    const w = await world();
    w.engine.answer = () => null;
    const waiting = w.chrome.request(`${API}/account/me`, { headers: siteHeaders("/api/v1/account/me") });
    const admitted = w.chrome.request(`${API}/notifications`, { headers: siteHeaders("/api/v1/notifications"), script: { then: "hang_before_send" } });
    await until(() => w.engine.of("siteAdmit").length === 2, 3000, "both asked");
    const id = String(w.engine.of("siteAdmit")[1]!.siteRequestId);
    w.site.onAdmitResult({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: id, admit: true, deadlineMono: monoMs() + 15_000, attemptId: 80 });
    await until(() => admitted.outcome === "continued", 3000, "the release");
    w.site.endAll("the page's SOCKS5 failed a tunnel");
    await until(() => waiting.outcome === "failed", 3000, "the waiting one to fail");
    const [done] = await doneOf(w);
    expect(done).toMatchObject({ attemptId: 80, sent: false, error: { message: "the page stopped: the page's SOCKS5 failed a tunnel" } });
    expect(w.site.live).toBe(0);
    w.site.linkChanged(true);
    expect(w.engine.of("siteAdmit")).toHaveLength(2);
  });

  it("an operator that starts again ends what the previous one admitted: siteDone sent if it was released, nothing for one never admitted", async () => {
    const temp = tempDir("pb-site-restart-");
    cleanups.push(temp.remove);
    const before = await world({ dir: temp.dir });
    before.buffer.changeSiteRequest({ siteRequestId: "11111111-1111-4111-8111-111111111111", asked: true });
    before.buffer.changeSiteRequest({ siteRequestId: "22222222-2222-4222-8222-222222222222", asked: true });
    before.buffer.changeSiteRequest({ siteRequestId: "22222222-2222-4222-8222-222222222222", released: { attemptId: 42 } });
    await before.buffer.flush();
    await before.buffer.close();
    const after = await world({ dir: temp.dir });
    expect(after.buffer.siteRequests()).toHaveLength(2);
    after.site.afterRestart();
    const [done] = await doneOf(after);
    expect(done).toEqual({
      type: "siteDone",
      siteRequestId: "22222222-2222-4222-8222-222222222222",
      attemptId: 42,
      sent: true,
      sentMono: null,
      sentWall: null,
      connectionReused: null,
      status: null,
      retryAfter: null,
      error: { afterSendStart: true, message: expect.stringContaining("started again after its release") },
      body: "not_platform_data",
    });
    await until(() => after.buffer.siteRequests().length === 0, 3000, "both ids to go");
  });
});
