import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventBuffer } from "../apps/page-browser/src/buffer/buffer.ts";
import { PausedRequests, type PausedDecision } from "../apps/page-browser/src/cdp/paused.ts";
import { ApiGate } from "../apps/page-browser/src/egress/gate.ts";
import { classifyFanslyHost } from "../apps/page-browser/src/egress/hosts.ts";
import { API_BODY_LIMIT, engineHeaders, HubRequests, MEDIA_BODY_LIMIT, type HubTimings } from "../apps/page-browser/src/hub-requests/hub.ts";
import { attemptOf, issuedUrl, PLACEHOLDER_SUFFIX, realUrl } from "../apps/page-browser/src/hub-requests/page.ts";
import { cyrb53, fanslyClientCheck, sessionFingerprint, SiteSession } from "../apps/page-browser/src/hub-requests/session.ts";
import type { Result, Send } from "../apps/page-browser/src/rpc/protocol.ts";
import { forgetSecrets } from "../apps/page-browser/src/shared/secrets.ts";
import { makeLog, monoMs, setLogSink } from "../apps/page-browser/src/shared/util.ts";
import { FakeCdpPort, FakeHubEngine, HubChrome, quiet, tempDir, until, type HubScript } from "./helpers/page-browser-fakes.ts";

// Hub's requests through the page's browser (Project Browser plan §4.2,
// §4.7; spec §6.1, §9; stage 1, §3–§5): the engine's `send` runs in the
// site's tab, stops in Fetch, waits for the engine's `check`, and goes only
// through the gate's window before its deadline — one physical request (and
// its preflight) per admission. A scripted Chrome (HubChrome) shows what
// CDP would, and its `wire` is what physically left: what the gate let up.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setLogSink(null);
  forgetSecrets();
});

const TOKEN = "fansly-token-AbCdEf0123456789xyz";
const CLIENT_ID = "720167541418237953";
const SESSION_ID = "720167541418237999";
const FINGERPRINT = sessionFingerprint(TOKEN, CLIENT_ID);
const ME = "/api/v1/account/me";

function siteHeaders(token = TOKEN, path = ME): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    authorization: token,
    "fansly-client-check": fanslyClientCheck(path, CLIENT_ID),
    "fansly-client-id": CLIENT_ID,
    "fansly-client-ts": "1791800000000",
    "fansly-session-id": SESSION_ID,
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)",
    Referer: "https://fansly.com/",
    "sec-ch-ua-platform": '"Linux"',
  };
}

interface Stored {
  result: Result;
  /** The outcome was in the buffer's file when the operator was told. */
  storedAtCommit: boolean;
  bodyId: string | null;
}

interface World {
  dir: string;
  cdp: FakeCdpPort;
  chrome: HubChrome;
  gate: ApiGate;
  engine: FakeHubEngine;
  hub: HubRequests;
  buffer: EventBuffer;
  outcomes: Map<number, Stored>;
  alarms: Array<{ kind: string; detail: Record<string, unknown> }>;
  lines: string[];
  exit: { open: boolean };
  ready: { why: string | null };
}

async function world(options: { timings?: Partial<HubTimings>; gateNoResponseMs?: number; slotLimitMs?: number; capBytes?: number; noSession?: boolean; dir?: string; passive?: boolean } = {}): Promise<World> {
  let dir = options.dir;
  if (dir === undefined) {
    const temp = tempDir("pb-hub-");
    cleanups.push(temp.remove);
    dir = temp.dir;
  }
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const cdp = new FakeCdpPort();
  const gate = new ApiGate({ ...(options.gateNoResponseMs ? { noResponseMs: options.gateNoResponseMs } : {}), ...(options.slotLimitMs ? { slotLimitMs: options.slotLimitMs } : {}), ...(options.passive ? { passive: true } : {}) });
  const chrome = new HubChrome(cdp, gate);
  gate.cut = () => chrome.cut("api");
  gate.cutHeld = () => 0;
  cleanups.push(() => gate.reset());
  const engine = new FakeHubEngine();
  const outcomes = new Map<number, Stored>();
  const alarms: World["alarms"] = [];
  const exit = { open: true };
  const ready = { why: null as string | null };
  const buffer: EventBuffer = new EventBuffer({
    dir: join(dir, "buffer"),
    idFile: join(dir, "buffer-id"),
    batchMs: 5,
    log: quiet,
    ...(options.capBytes ? { caps: { bytes: options.capBytes } } : {}),
    onCommitted: ({ outcomes: committed }) => {
      for (const outcome of committed) outcomes.set(outcome.attemptId, { result: JSON.parse(outcome.json) as Result, storedAtCommit: buffer.outcomes([outcome.attemptId]).length === 1, bodyId: outcome.bodyId });
    },
  });
  buffer.start();
  cleanups.push(() => buffer.close());
  let hub: HubRequests | null = null;
  const fail = (why: string): PausedDecision => ({ action: "fail", reason: "BlockedByClient", why });
  const paused = new PausedRequests(cdp, {
    log: quiet,
    decide: (request) => {
      const decided = hub!.decide(request);
      if (decided) return decided;
      if (request.stage === "response") return fail("a response stage nobody asked for");
      if (classifyFanslyHost(new URL(request.url).hostname) === "api") hub!.noteSiteRequest(request);
      return fail("no admission");
    },
  });
  const created = new HubRequests({
    cdp,
    resolve: (request, decision) => paused.resolve(request, decision),
    gate,
    classify: classifyFanslyHost,
    exitOpen: () => exit.open,
    buffer,
    site: { notReady: () => ready.why, tabSession: () => chrome.session, world: async () => 7 },
    link: engine.link(),
    alarm: (kind, detail) => alarms.push({ kind, detail }),
    timings: { pauseWaitMs: 1000, checkWaitMs: 1000, opLimitMs: 2000, mainWaitMs: 1000, ...options.timings },
    log: makeLog("hub"),
  });
  hub = created;
  engine.deliver = (result) => created.onCheckResult(result);
  // As the operator wires it: the send as the gate saw it.
  gate.onEvent = (event) => created.onGateEvent(event);
  cleanups.push(() => created.endAll("the test ends"));
  if (!options.noSession) {
    chrome.siteRequest(ME, siteHeaders());
    await until(() => created.session.fingerprint !== null, 2000, "the live session");
  }
  return { dir, cdp, chrome, gate, engine, hub: created, buffer, outcomes, alarms, lines, exit, ready };
}

let nextId = 1000;

function send(w: World, overrides: Partial<Send> = {}, script?: HubScript): Send {
  const now = monoMs();
  const message: Send = {
    type: "send",
    ownerGeneration: w.engine.generation,
    attemptId: ++nextId,
    route: "account.me",
    credentialsGeneration: "c".repeat(64),
    sessionFingerprint: FINGERPRINT,
    method: "GET",
    url: `https://apiv3.fansly.com${ME}?ngsw-bypass=true`,
    headers: {},
    kind: "api",
    maxBodyBytes: API_BODY_LIMIT,
    sendDeadlineMono: now + 15_000,
    requestDeadlineMono: now + 20_000,
    ...overrides,
  };
  if (script) w.chrome.scripts.set(message.attemptId, script);
  w.hub.onSend(message);
  return message;
}

async function outcomeOf(w: World, attemptId: number, timeoutMs = 5000): Promise<Result["outcome"]> {
  await until(() => w.outcomes.has(attemptId), timeoutMs, `attempt ${attemptId}'s outcome`);
  return w.outcomes.get(attemptId)!.result.outcome;
}

function bodyOf(w: World, attemptId: number): Buffer {
  const stored = w.outcomes.get(attemptId)!;
  return readFileSync(join(w.dir, "buffer", "bodies", stored.bodyId!));
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("a Hub request (plan §4.2)", () => {
  it("is one physical request per admission: asked about at its pause, released with its real address, its body kept, then told", async () => {
    const w = await world();
    const body = Buffer.from(JSON.stringify({ success: true, response: { account: { id: "1", username: "page" } } }));
    const message = send(w, {}, { chunks: [body.subarray(0, 10), body.subarray(10)], headers: [{ name: "Content-Type", value: "application/json" }, { name: "Set-Cookie", value: "a=b" }, { name: "X-Dup", value: "1" }, { name: "x-dup", value: "2" }], timing: { requestTime: (monoMs() + 60_000) / 1000, sendStart: 3.5 } });
    const outcome = await outcomeOf(w, message.attemptId);
    // Started in the page from its placeholder address, with the live
    // session's headers in the site's order, its own time and check.
    expect(w.chrome.issued).toHaveLength(1);
    const issued = w.chrome.issued[0]!;
    expect(new URL(issued.url).hostname).toBe(`apiv3.fansly.com${PLACEHOLDER_SUFFIX}`);
    expect(new URL(issued.url).hash).toBe(`#hub-${message.attemptId}`);
    expect(issued.kind).toBe("api");
    expect(issued.headers.map(([name]) => name)).toEqual(["Accept", "authorization", "fansly-client-check", "fansly-client-id", "fansly-client-ts", "fansly-session-id"]);
    const headers = Object.fromEntries(issued.headers);
    expect(headers.authorization).toBe(TOKEN);
    expect(headers["fansly-client-check"]).toBe(fanslyClientCheck(ME, CLIENT_ID));
    expect(Math.abs(Number(headers["fansly-client-ts"]) - Date.now())).toBeLessThanOrEqual(5100);
    // Asked about at the pause with the live fingerprint; one check.
    expect(w.engine.of("check")).toEqual([{ type: "check", attemptId: message.attemptId, pausedMono: expect.any(Number), liveSessionFingerprint: FINGERPRINT }]);
    // Released once, with its real address and the response stopped at its headers.
    const continued = w.cdp.sent("Fetch.continueRequest");
    expect(continued).toHaveLength(1);
    expect(continued[0]!.params).toMatchObject({ url: `https://apiv3.fansly.com${ME}?ngsw-bypass=true`, interceptResponse: true });
    expect(w.chrome.wire).toEqual([{ attemptId: message.attemptId, role: "main", method: "GET", url: `https://apiv3.fansly.com${ME}?ngsw-bypass=true` }]);
    // The stream was armed before the response went on.
    const order = w.cdp.commands.map((command) => command.method);
    expect(order.indexOf("Network.streamResourceContent")).toBeLessThan(order.indexOf("Fetch.continueResponse"));
    // `sent`: the gate saw the first bytes, on a warm connection.
    expect(w.engine.of("sent")).toEqual([{ type: "sent", attemptId: message.attemptId, sentMono: expect.any(Number), sentWall: expect.any(Number), connectionReused: true }]);
    // The answer: status, headers as the engine has them, the body kept whole.
    expect(outcome).toEqual({
      kind: "response",
      status: 200,
      headers: { "content-type": "application/json", "x-dup": "1, 2", "content-length": String(body.length) },
      body: { bodyId: w.outcomes.get(message.attemptId)!.bodyId, decodedBytes: body.length, sha256: sha256(body) },
      encodedBytes: body.length + 200,
      source: "network",
      // The gate's moment, as `sent` said — not Chrome's timing (a minute
      // ahead here: another clock's, round 5 of Astra's review of PR 15).
      sentMono: w.engine.of("sent")[0]!.sentMono,
      sendMark: "transport_reported",
    });
    expect(bodyOf(w, message.attemptId).equals(body)).toBe(true);
    // Durable before the operator was told; never sent around the buffer.
    expect(w.outcomes.get(message.attemptId)!.storedAtCommit).toBe(true);
    expect(w.engine.of("result")).toEqual([]);
    // The page's hold on it is let go.
    await until(() => w.chrome.releasedInPage.includes(message.attemptId), 2000, "the release in the page");
    expect(w.hub.live).toBe(0);
  });

  it("takes its CORS preflight into the same operation: one admission, two windows, the preflight's answer handed on", async () => {
    const w = await world();
    const message = send(w, {}, { preflight: 204, newTunnel: true, timing: null });
    const outcome = await outcomeOf(w, message.attemptId);
    expect(w.engine.of("check")).toHaveLength(1);
    expect(w.chrome.wire.map((request) => `${request.role} ${request.method}`)).toEqual(["preflight OPTIONS", "main GET"]);
    // The preflight's answer goes on by fulfillRequest (Chrome 155 kills its
    // network service otherwise), the request's by continueResponse.
    expect(w.cdp.sent("Fetch.fulfillRequest")).toHaveLength(1);
    expect(w.cdp.sent("Fetch.fulfillRequest")[0]!.params).toMatchObject({ responseCode: 204 });
    expect(w.cdp.sent("Fetch.continueRequest")).toHaveLength(2);
    // `sent` once, at the operation's first bytes, on the new connection.
    expect(w.engine.of("sent")).toEqual([expect.objectContaining({ attemptId: message.attemptId, connectionReused: false })]);
    // Without Chrome's timing, the gate's moment of the first bytes.
    expect(outcome).toMatchObject({ kind: "response", status: 200, sendMark: "transport_reported", sentMono: w.engine.of("sent")[0]!.sentMono });
  });

  it("refused by the engine's check, or with no answer: failed at its pause, never released", async () => {
    const w = await world();
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: 1, attemptId: check.attemptId, admit: false, reason: "pace" });
    const refused = send(w);
    expect(await outcomeOf(w, refused.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "pace" });
    w.engine.answer = () => null;
    const unanswered = send(w, {}, {});
    expect(await outcomeOf(w, unanswered.attemptId, 3000)).toEqual({ kind: "transport_error", sent: false, message: "no answer to the check in time" });
    expect(w.cdp.sent("Fetch.continueRequest")).toEqual([]);
    // Each failed once (the site's own request, in the world's set-up, too).
    expect(w.cdp.sent("Fetch.failRequest").map((command) => command.params.errorReason)).toEqual(["BlockedByClient", "Aborted", "Aborted"]);
    expect(w.chrome.wire).toEqual([]);
  });

  it("is released only with its admission's deadline ahead", async () => {
    const w = await world();
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: 1, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() - 1 });
    const late = send(w);
    expect(await outcomeOf(w, late.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "send_deadline_passed" });
    // A send whose own deadline is gone is not even started.
    const gone = send(w, { sendDeadlineMono: monoMs() - 1 });
    expect(await outcomeOf(w, gone.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "send_deadline_passed" });
    expect(w.chrome.issued.map((request) => request.attemptId)).toEqual([late.attemptId]);
    expect(w.cdp.sent("Fetch.continueRequest")).toEqual([]);
    expect(w.chrome.wire).toEqual([]);
  });

  it("does not leave after its deadline: released, but not written before it, the gate holds it and cuts the API's tunnels", async () => {
    const w = await world();
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: 1, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 150 });
    const message = send(w, {}, { sendDelayMs: 400 });
    expect(await outcomeOf(w, message.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "send_deadline_passed" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(w.cdp.sent("Fetch.continueRequest")).toHaveLength(1);
    expect(w.chrome.wire).toEqual([]);
  });

  it("one admitted request of the page at a time: a second admission while the first is unfinished — its admission ran out unsent, Chrome still holds it — is not released (not sent, \"pace\"); nothing goes late; once the first ended, the next goes", async () => {
    const w = await world();
    let deadlineMs = 150;
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: 1, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + deadlineMs });
    // The first: released, its records written only after its deadline.
    const first = send(w, {}, { sendDelayMs: 400 });
    await until(() => w.cdp.sent("Fetch.continueRequest").length === 1, 3000, "the first released");
    // An engine that admits the next one meanwhile.
    deadlineMs = 15_000;
    const second = send(w);
    expect(await outcomeOf(w, second.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "pace" });
    expect(w.cdp.sent("Fetch.continueRequest")).toHaveLength(1);
    // Failed in its pause with the gate's reason (the journal's line), not
    // as an attempt that merely ended.
    expect(w.cdp.sent("Fetch.failRequest").at(-1)?.params.errorReason).toBe("Failed");
    // The first never goes: not in its window, not in another's.
    expect(await outcomeOf(w, first.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "send_deadline_passed" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(w.chrome.wire).toEqual([]);
    // Its end known, the next one goes.
    const third = send(w);
    expect(await outcomeOf(w, third.attemptId)).toMatchObject({ kind: "response", status: 200 });
    expect(w.chrome.wire.map((request) => request.attemptId)).toEqual([third.attemptId]);
  });

  it("its request cancelled before its release while its preflight is released and held: the attempt ends, the slot does not — the next admission is refused, the preflight never goes; past the slot's bound, a fault (Astra's 1)", async () => {
    const w = await world({ slotLimitMs: 400 });
    const unended: string[] = [];
    w.gate.onUnended = (operation) => unended.push(operation);
    let deadlineMs = 300;
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: 1, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + deadlineMs });
    // The preflight released; its connection comes only after the deadline.
    const first = send(w, {}, { preflight: 204, sendDelayMs: 700 });
    await until(() => w.cdp.sent("Fetch.continueRequest").length === 1, 3000, "the preflight released");
    const main = w.chrome.requestsOf(first.attemptId).find((request) => request.role === "main")!;
    // The page cancels the request while its preflight is in flight.
    w.cdp.emit("Network.loadingFailed", { requestId: main.networkId, errorText: "net::ERR_ABORTED", canceled: true }, w.chrome.session);
    expect((await outcomeOf(w, first.attemptId)).kind).not.toBe("response");
    expect(w.gate.slotOwner).toBe(`hub:${first.attemptId}`);
    // An engine that admits the next one meanwhile: refused, not sent.
    deadlineMs = 15_000;
    const second = send(w);
    expect(await outcomeOf(w, second.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "pace" });
    // The preflight's connection comes after its deadline: nothing goes.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(w.chrome.wire).toEqual([]);
    // Past the bound with its end unknown: a fault; the slot stays until Chrome is gone.
    await until(() => unended.length === 1, 3000, "the slot's bound");
    expect(unended).toEqual([`hub:${first.attemptId}`]);
    expect(w.gate.slotOwner).toBe(`hub:${first.attemptId}`);
    w.gate.browserGone();
    const third = send(w);
    expect(await outcomeOf(w, third.attemptId)).toMatchObject({ kind: "response", status: 200 });
    expect(w.chrome.wire.map((request) => request.attemptId)).toEqual([third.attemptId]);
  });

  // Astra's review of PR 15, round 5: every instant the operator reports is
  // its own clock's; Chrome's timing (another clock: fixed, ahead, behind)
  // never crosses the protocol — in `sent`, in the result, in `quiesced`.
  it("takes its send moment from the gate's first bytes alone, whatever Chrome's own timing says; media from the operator's clock when answered, none from a cache", async () => {
    const w = await world();
    const timings = [
      { requestTime: 777.125, sendStart: 1.5 },
      { requestTime: (monoMs() + 3_600_000) / 1000, sendStart: 0.75 },
      { requestTime: Math.max(0, monoMs() - 3_600_000) / 1000, sendStart: 0 },
      // Chrome wrote it into the local socket 5 s before the operator let it go (Astra's review of PR 9, 1).
      { requestTime: (monoMs() - 5000) / 1000, sendStart: 0 },
    ];
    for (const timing of timings) {
      const before = monoMs();
      const timed = send(w, {}, { timing });
      const outcome = await outcomeOf(w, timed.attemptId);
      const gate = w.engine.of("sent").find((sent) => sent.attemptId === timed.attemptId)!.sentMono as number;
      expect(outcome, JSON.stringify(timing)).toMatchObject({ sentMono: gate, sendMark: "transport_reported" });
      expect(gate, JSON.stringify(timing)).toBeGreaterThanOrEqual(before);
      expect(gate, JSON.stringify(timing)).toBeLessThanOrEqual(monoMs());
    }
    // With a preflight: its own request's moments, the first of the two.
    const preflighted = send(w, {}, { preflight: 204, timing: { requestTime: (monoMs() + 3_600_000) / 1000, sendStart: 0 } });
    const both = await outcomeOf(w, preflighted.attemptId);
    expect(both).toMatchObject({ sentMono: w.engine.of("sent").find((sent) => sent.attemptId === preflighted.attemptId)!.sentMono });
    // Media (no gate on the CDN): sent by the time Chrome said it was
    // answered, on the operator's clock — `sent`, the result and the last
    // media send alike, Chrome's timing an hour ahead.
    const before = monoMs();
    const answered = send(w, { kind: "image", url: "https://cdn3.fansly.com/abc/2.jpg?Policy=p&Signature=s&Key-Pair-Id=k", maxBodyBytes: MEDIA_BODY_LIMIT }, { timing: { requestTime: (monoMs() + 3_600_000) / 1000, sendStart: 0 } });
    const image = await outcomeOf(w, answered.attemptId);
    const mediaSent = w.engine.of("sent").find((sent) => sent.attemptId === answered.attemptId)!.sentMono as number;
    expect(image).toMatchObject({ kind: "response", sentMono: mediaSent, sendMark: "transport_reported" });
    expect(mediaSent).toBeGreaterThanOrEqual(before);
    expect(mediaSent).toBeLessThanOrEqual(monoMs());
    expect(w.hub.lastMediaSend?.mono).toBe(mediaSent);
    // Media Chrome never said was answered: none — the completion.
    const media = send(w, { kind: "image", url: "https://cdn3.fansly.com/abc/1.jpg?Policy=p&Signature=s&Key-Pair-Id=k", maxBodyBytes: MEDIA_BODY_LIMIT }, { timing: null, noResponseReceived: true });
    expect(await outcomeOf(w, media.attemptId)).toMatchObject({ kind: "response", sentMono: null, sendMark: "completion_fallback", source: "cache_unconfirmed" });
  });

  it("is cut before its body when its declared size is over the limit, and while it comes when it has none", async () => {
    const w = await world();
    const declared = send(w, { maxBodyBytes: 1000 }, { contentLength: 5000, chunks: [Buffer.alloc(5000, 1)] });
    expect(await outcomeOf(w, declared.attemptId)).toEqual({ kind: "transport_error", sent: true, message: "the response body is over 1000 bytes (declared 5000 bytes)" });
    // Failed at the response stage, its body never asked for.
    expect(w.cdp.sent("Network.streamResourceContent")).toEqual([]);
    expect(w.cdp.sent("Fetch.continueResponse")).toEqual([]);
    const chunked = send(w, { maxBodyBytes: 1000 }, { chunked: true, chunks: [Buffer.alloc(600, 1), Buffer.alloc(600, 2), Buffer.alloc(600, 3)] });
    expect(await outcomeOf(w, chunked.attemptId)).toEqual({ kind: "transport_error", sent: true, message: "the response body is over 1000 bytes (1200 bytes received)" });
    // Cancelled in the page — never by its tunnels, which the site's own
    // requests share (variant Б); no body kept.
    await until(() => w.chrome.requestsOf(chunked.attemptId).every((request) => request.ended), 2000, "the cancel");
    expect(w.chrome.abortedInPage).toEqual([chunked.attemptId]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readdirSync(join(w.dir, "buffer", "bodies"))).toEqual([]);
    // Media over 5 MiB: the old bodyOverflow, an answer with no body.
    const media = send(w, { kind: "image", url: "https://cdn3.fansly.com/big.jpg", maxBodyBytes: 100 }, { chunked: true, chunks: [Buffer.alloc(80), Buffer.alloc(80)] });
    expect(await outcomeOf(w, media.attemptId)).toMatchObject({ kind: "response", status: 200, bodyOverflow: true, body: { decodedBytes: 0 } });
  });

  it("is whole only when it ended with loadingFinished and every chunk was there as long as it said", async () => {
    const w = await world();
    const broken = send(w, {}, { brokenChunk: true, chunks: [Buffer.from("abcdef"), Buffer.from("ghij")] });
    expect(await outcomeOf(w, broken.attemptId)).toEqual({ kind: "transport_error", sent: true, message: "the body did not arrive whole: a chunk of 5 bytes said 6" });
    const unstreamed = send(w, {}, { unstreamed: true });
    expect(await outcomeOf(w, unstreamed.attemptId)).toEqual({ kind: "transport_error", sent: true, message: "the body did not arrive whole: a chunk came without its data" });
    const interrupted = send(w, {}, { then: "body_fails", chunks: [Buffer.from("abc")] });
    expect(await outcomeOf(w, interrupted.attemptId)).toEqual({ kind: "transport_error", sent: true, message: "the body did not arrive whole: net::ERR_CONNECTION_CLOSED" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readdirSync(join(w.dir, "buffer", "bodies"))).toEqual([]);
  });

  it("returns a redirect as it is, with its Location, and the page gets it as final; a next hop is refused", async () => {
    const w = await world();
    const message = send(w, {}, { status: 302, headers: [{ name: "Location", value: "https://apiv3.fansly.com/api/v1/elsewhere" }], chunks: [Buffer.alloc(0)] });
    const outcome = await outcomeOf(w, message.attemptId);
    expect(outcome).toMatchObject({ kind: "response", status: 302, headers: { location: "https://apiv3.fansly.com/api/v1/elsewhere" }, body: { decodedBytes: 0, sha256: sha256(Buffer.alloc(0)) } });
    const fulfilled = w.cdp.sent("Fetch.fulfillRequest");
    expect(fulfilled).toHaveLength(1);
    expect((fulfilled[0]!.params.responseHeaders as Array<{ name: string }>).map((header) => header.name.toLowerCase())).not.toContain("location");
    // A hop Chrome would make of it stops in Fetch: refused.
    const interception = w.chrome.requestsOf(message.attemptId)[0]!.interceptionId;
    w.cdp.emit("Fetch.requestPaused", { requestId: "I-hop", networkId: "R-hop", redirectedRequestId: interception, request: { url: "https://apiv3.fansly.com/api/v1/elsewhere", method: "GET", headers: {} }, resourceType: "XHR" });
    await until(() => w.cdp.sent("Fetch.failRequest").some((command) => command.params.requestId === "I-hop"));
    expect(w.chrome.wire).toHaveLength(1);
  });

  it("says whether it was sent when the network fails it: not before its first bytes, yes after", async () => {
    const w = await world();
    const before = send(w, {}, { then: "fail_before_send" });
    expect(await outcomeOf(w, before.attemptId)).toEqual({ kind: "transport_error", sent: false, message: "net::ERR_TUNNEL_CONNECTION_FAILED" });
    const after = send(w, {}, { then: "fail_after_send" });
    expect(await outcomeOf(w, after.attemptId)).toEqual({ kind: "transport_error", sent: true, message: "net::ERR_CONNECTION_RESET" });
  });

  it("knows where its answer came from: the network, a 304 revalidation, the service worker, an unconfirmed cache", async () => {
    const w = await world();
    const cases: Array<[HubScript, string]> = [
      [{}, "network"],
      [{ wireStatus: 304 }, "revalidated_304"],
      [{ fromServiceWorker: true }, "service_worker"],
      [{ fromDiskCache: true }, "cache_unconfirmed"],
      [{ noResponseReceived: true }, "cache_unconfirmed"],
    ];
    for (const [script, source] of cases) {
      const message = send(w, {}, script);
      expect(await outcomeOf(w, message.attemptId), source).toMatchObject({ kind: "response", source });
    }
  });

  it("holds Chrome's own repeat on the same connection: one request reaches the server, the gate cuts it 20 s (here less) after the send", async () => {
    const w = await world({ gateNoResponseMs: 300, timings: { opLimitMs: 5000 } });
    const held: string[] = [];
    w.gate.onEvent = (event) => {
      held.push(event.kind);
      w.hub.onGateEvent(event);
    };
    const message = send(w, {}, { then: "retry" });
    expect(await outcomeOf(w, message.attemptId)).toEqual({ kind: "timeout", sent: true, message: "no answer 20 s after the send" });
    expect(w.chrome.wire).toHaveLength(1);
    expect(held).toContain("held");
    expect(held).toContain("no_response");
  });
});

describe("the session (plan §4.7)", () => {
  it("is not released under another session than the expected one", async () => {
    const w = await world();
    // Expected another session: never started.
    const other = send(w, { sessionFingerprint: "e".repeat(64) });
    expect(await outcomeOf(w, other.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "session_mismatch" });
    expect(w.chrome.issued).toEqual([]);
    // The session changes between the start and the pause: failed there.
    const changed = send(w, {}, { then: "answer" });
    w.chrome.siteRequest(ME, siteHeaders("fansly-token-SomebodyElse0123456789"));
    expect(await outcomeOf(w, changed.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "session_mismatch" });
    expect(w.cdp.sent("Fetch.continueRequest")).toEqual([]);
    expect(w.chrome.wire).toEqual([]);
    // And between the admission and the release.
    const w2 = await world();
    w2.engine.answer = (check) => {
      w2.chrome.siteRequest(ME, siteHeaders("fansly-token-ThirdOne0123456789ab"));
      return { type: "checkResult", ownerGeneration: 1, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 15_000 };
    };
    const late = send(w2);
    expect(await outcomeOf(w2, late.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "session_mismatch" });
    expect(w2.chrome.wire).toEqual([]);
  });

  it("is learned from the site's own requests: its headers in order, the browser's left out; the fingerprint is the token and client id", () => {
    const changes: Array<string | null> = [];
    const session = new SiteSession({ now: () => 1_791_800_000_000, random: () => 0.5, onChange: (fingerprint) => changes.push(fingerprint) });
    expect(session.headersFor(ME, {})).toEqual({ ok: false, why: "no live session of the site yet: it made no API request with authorization" });
    session.note({ method: "GET", url: `https://apiv3.fansly.com${ME}?ngsw-bypass=true`, headers: siteHeaders() });
    expect(session.fingerprint).toBe(FINGERPRINT);
    expect(changes).toEqual([FINGERPRINT]);
    expect(session.checkOk).toBe(true);
    const built = session.headersFor("/api/v1/messaging/groups", { "x-route": "1", Accept: "ignored" });
    expect(built).toEqual({
      ok: true,
      fingerprint: FINGERPRINT,
      headers: [
        ["Accept", "application/json, text/plain, */*"],
        ["authorization", TOKEN],
        ["fansly-client-check", fanslyClientCheck("/api/v1/messaging/groups", CLIENT_ID)],
        ["fansly-client-id", CLIENT_ID],
        ["fansly-client-ts", String(1_791_800_000_000)],
        ["fansly-session-id", SESSION_ID],
        ["x-route", "1"],
      ],
    });
    // A POST, a request without authorization: nothing learned from them.
    session.note({ method: "POST", url: `https://apiv3.fansly.com/api/v1/login`, headers: { authorization: "other-token-123456" } });
    session.note({ method: "GET", url: `https://apiv3.fansly.com/api/v1/versioning`, headers: { Accept: "x" } });
    expect(session.fingerprint).toBe(FINGERPRINT);
    session.reset();
    expect(session.fingerprint).toBeNull();
    expect(changes).toEqual([FINGERPRINT, null]);
  });

  it("keeps fansly-client-ts as the site does: its clock ± 5 s, refreshed every 3 s, never going back", () => {
    let now = 1_000_000;
    let random = 0;
    const session = new SiteSession({ now: () => now, random: () => random });
    expect(session.clientTs()).toBe(1_005_000);
    random = 0.99;
    now += 1000;
    expect(session.clientTs()).toBe(1_005_000);
    now += 2000;
    // Would be 1 003 000 - 4 900: never going back.
    expect(session.clientTs()).toBe(1_005_000);
    random = 0;
    now += 3000;
    expect(session.clientTs()).toBe(now + 5000);
  });

  it("computes fansly-client-check with the site's algorithm, and stops Hub requests when the site computes it another way", async () => {
    expect(cyrb53("")).toBe(3_338_908_027_751_811);
    expect(fanslyClientCheck(ME, CLIENT_ID)).toBe(cyrb53(`necvac-govry3-tybkYz_${ME}_${CLIENT_ID}`).toString(16));
    const w = await world({ noSession: true });
    w.chrome.siteRequest(ME, { ...siteHeaders(), "fansly-client-check": "1234abcd" });
    await until(() => w.alarms.length === 1);
    expect(w.alarms[0]).toEqual({ kind: "header_mismatch", detail: expect.objectContaining({ what: "fansly-client-check", path: ME }) });
    const message = send(w);
    expect(await outcomeOf(w, message.attemptId)).toEqual({ kind: "transport_error", sent: false, message: "the site computes fansly-client-check another way than the operator: the transport is not ready" });
    expect(w.chrome.issued).toEqual([]);
  });

  it("compares a Hub request's header names with the site's on the same path: a difference alarms and stops Hub's requests, never the page (plan-b Б6)", async () => {
    const w = await world();
    const site = w.chrome.siteRequest(ME, siteHeaders());
    w.chrome.siteSent(site.networkId, ["accept", "authorization", "fansly-client-check", "fansly-client-id", "fansly-client-ts", "fansly-session-id", "user-agent"]);
    const same = send(w);
    await outcomeOf(w, same.attemptId);
    // The site's next request goes with a header Hub's do not have.
    const next = w.chrome.siteRequest(ME, siteHeaders());
    w.chrome.siteSent(next.networkId, ["accept", "authorization", "fansly-client-check", "fansly-client-id", "fansly-client-ts", "fansly-session-id", "user-agent", "x-new"]);
    await until(() => w.alarms.length === 1);
    expect(w.alarms).toEqual([{ kind: "header_mismatch", detail: expect.objectContaining({ what: "header names", path: `GET ${ME}` }) }]);
    expect(w.exit.open).toBe(true);
    // And no Hub request goes until the browser starts anew.
    const after = send(w);
    expect(await outcomeOf(w, after.attemptId)).toMatchObject({ kind: "transport_error", sent: false, message: "a Hub request's headers differed from the site's: the transport is not ready" });
  });

  it("pilot 2 (2026-10-16): fansly-session-id follows the site's socket, not the parity — the site's own requests to one path with and without it stop nothing", async () => {
    const w = await world();
    const withSocket = ["accept", "authorization", "fansly-client-check", "fansly-client-id", "fansly-client-ts", "fansly-session-id", "user-agent"];
    const site = w.chrome.siteRequest(ME, siteHeaders());
    w.chrome.siteSent(site.networkId, withSocket);
    const same = send(w);
    await outcomeOf(w, same.attemptId);
    const next = w.chrome.siteRequest(ME, siteHeaders());
    w.chrome.siteSent(next.networkId, withSocket.filter((name) => name !== "fansly-session-id"));
    const again = send(w);
    await outcomeOf(w, again.attemptId);
    expect(w.alarms).toEqual([]);
  });

  it("pilot 2 (2026-10-16): the work tab's new document has no socket yet — Hub waits for its first API request and goes with its headers, without the old fansly-session-id", async () => {
    const w = await world();
    w.chrome.navigate("https://fansly.com/");
    // The session goes on; its headers were the old document's.
    expect(w.hub.session.fingerprint).not.toBeNull();
    const early = send(w);
    expect(await outcomeOf(w, early.attemptId)).toMatchObject({ kind: "transport_error", sent: false, message: expect.stringContaining("the site's new document made no API request with authorization yet") });
    expect(w.chrome.issued).toEqual([]);
    const { "fansly-session-id": _socketless, ...fresh } = siteHeaders();
    w.chrome.siteRequest(ME, fresh);
    const message = send(w);
    await outcomeOf(w, message.attemptId);
    expect(w.chrome.issued).toHaveLength(1);
    expect(w.chrome.issued[0]!.headers.map(([name]) => name)).not.toContain("fansly-session-id");
  });
});

describe("a Hub request whose end is unknown holds the page's slot, and never stops the page (plan-b §4.1.10)", () => {
  it("no answer and no end within the limit: its outcome at once (possibly sent), cancelled in the page; the slot stays held — the next admission is refused (\"pace\") — until Chrome is gone; past the bound, onUnended", async () => {
    const w = await world({ timings: { opLimitMs: 300 }, slotLimitMs: 300 });
    const unended: string[] = [];
    w.gate.onUnended = (operation) => unended.push(operation);
    // The slot's bound: the admission's deadline and the slot's limit.
    let deadlineMs = 400;
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: 1, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + deadlineMs });
    const message = send(w, {}, { then: "hang_after_send" });
    expect(await outcomeOf(w, message.attemptId)).toEqual({ kind: "timeout", sent: true, message: "no answer and no end of the request within its limit: its end is unknown" });
    await until(() => w.chrome.abortedInPage.includes(message.attemptId), 2000, "the cancel");
    // The page's cancel is no end: the slot is still the operation's.
    expect(w.gate.slotOwner).toBe(`hub:${message.attemptId}`);
    expect(w.exit.open).toBe(true);
    deadlineMs = 15_000;
    const next = send(w);
    expect(await outcomeOf(w, next.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "pace" });
    await until(() => unended.length === 1, 5000, "the slot's bound");
    expect(unended).toEqual([`hub:${message.attemptId}`]);
    // Chrome gone (the operator restarts it): the next one goes.
    w.gate.browserGone();
    const after = send(w);
    expect(await outcomeOf(w, after.attemptId)).toMatchObject({ kind: "response", status: 200 });
  });

  it("a released request the page cancels before its answer (an F5): its end is unknown, the slot stays held; the page goes on", async () => {
    const w = await world();
    const message = send(w, {}, { then: "cancel_after_send" });
    expect(await outcomeOf(w, message.attemptId)).toEqual({ kind: "transport_error", sent: true, message: "the page cancelled the request before its answer: its end is unknown" });
    expect(w.gate.slotOwner).toBe(`hub:${message.attemptId}`);
    expect(w.exit.open).toBe(true);
    const next = send(w);
    expect(await outcomeOf(w, next.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "pace" });
    w.gate.browserGone();
    const after = send(w);
    expect(await outcomeOf(w, after.attemptId)).toMatchObject({ kind: "response", status: 200 });
  });

  it("an answer whose body does not finish within the limit ends as a timeout, cancelled in the page; answered, it has ended — the slot is free", async () => {
    const w = await world({ timings: { opLimitMs: 200 } });
    const message = send(w, {}, { chunks: [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")], chunkDelayMs: 150 });
    expect(await outcomeOf(w, message.attemptId)).toEqual({ kind: "timeout", sent: true, message: "the body did not finish within the request's limit" });
    await until(() => w.chrome.abortedInPage.includes(message.attemptId), 2000, "the cancel");
    await until(() => w.gate.slotOwner === null, 2000, "the slot freed");
    const next = send(w);
    expect(await outcomeOf(w, next.attemptId)).toMatchObject({ kind: "response", status: 200 });
  });

  it("a passive gate (variant Б) cannot say a released request did not leave: a network failure after the release is possibly sent", async () => {
    const w = await world({ passive: true });
    const ok = send(w);
    expect(await outcomeOf(w, ok.attemptId)).toMatchObject({ kind: "response", status: 200 });
    const failed = send(w, {}, { then: "fail_before_send" });
    expect(await outcomeOf(w, failed.attemptId)).toEqual({ kind: "transport_error", sent: true, message: "net::ERR_TUNNEL_CONNECTION_FAILED" });
  });

  it("a document replaced while the request waits: failed, never released", async () => {
    const w = await world();
    w.engine.answer = () => null;
    const message = send(w);
    await until(() => w.engine.of("check").length === 1);
    w.chrome.navigate("https://fansly.com/home");
    expect(await outcomeOf(w, message.attemptId)).toEqual({ kind: "transport_error", sent: false, message: "the site's document changed while the request waited" });
    expect(w.cdp.sent("Fetch.continueRequest")).toEqual([]);
  });
});

describe("the engine's link and owners", () => {
  it("a check left without an answer when the link goes: failed, never released", async () => {
    const w = await world();
    w.engine.answer = () => null;
    const message = send(w);
    await until(() => w.engine.of("check").length === 1);
    w.hub.linkLost();
    expect(await outcomeOf(w, message.attemptId)).toEqual({ kind: "transport_error", sent: false, message: "the engine link was lost before the check's answer" });
    // A send while the link is down is refused at its pause.
    w.engine.up = false;
    const down = send(w);
    expect(await outcomeOf(w, down.attemptId)).toEqual({ kind: "transport_error", sent: false, message: "no engine link to ask" });
    expect(w.cdp.sent("Fetch.continueRequest")).toEqual([]);
  });

  it("a new owner: the earlier one's requests not released are refused, the released ones are waited for", async () => {
    const w = await world();
    w.engine.answer = () => null;
    const waiting = send(w);
    await until(() => w.engine.of("check").length === 1);
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: 1, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
    const flying = send(w, {}, { chunks: [Buffer.from("a"), Buffer.from("b")], chunkDelayMs: 100 });
    await until(() => w.chrome.wire.length === 1);
    w.engine.generation = 2;
    let quiesced = false;
    const done = w.hub.quiesce(2).then(() => (quiesced = true));
    expect(await outcomeOf(w, waiting.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "generation_stale" });
    expect(quiesced).toBe(false);
    await done;
    expect(await outcomeOf(w, flying.attemptId)).toMatchObject({ kind: "response", status: 200 });
    // A send of the earlier owner is refused, never started.
    const stale = send(w, { ownerGeneration: 1 });
    expect(await outcomeOf(w, stale.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "generation_stale" });
    expect(w.chrome.issued).toHaveLength(2);
  });
});

describe("ids outlive restarts (plan §4.13)", () => {
  it("a repeated send does nothing twice — while it runs, after its end, and after a restart", async () => {
    const w = await world();
    const message = send(w);
    w.hub.onSend(message);
    await outcomeOf(w, message.attemptId);
    w.hub.onSend(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.chrome.issued).toHaveLength(1);
    expect(w.chrome.wire).toHaveLength(1);
    // The operator starts again on the same buffer.
    await w.buffer.close();
    const again = await world({ dir: w.dir });
    again.hub.onSend(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(again.chrome.issued).toEqual([]);
    // Even once its outcome was acknowledged.
    again.buffer.acknowledgeOutcome(message.attemptId);
    await again.buffer.flush();
    again.hub.onSend(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(again.chrome.issued).toEqual([]);
  });

  it("recover says not_sent only of a request that never left", async () => {
    const w = await world();
    // Never released: a check without an answer.
    w.engine.answer = () => null;
    const waiting = send(w);
    await until(() => w.engine.of("check").length === 1);
    const released = send(w, {}, { then: "hang_after_send" });
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: 1, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
    // (the second check is answered: it was sent after the answer changed)
    await until(() => w.chrome.wire.length === 1);
    expect(w.hub.recoverState(waiting.attemptId)).toBe("not_sent");
    expect(w.hub.recoverState(released.attemptId)).toBe("unknown");
    expect(w.hub.recoverState(999_999)).toBe("unknown");
    // What recover said of it holds: a late admission is not used.
    w.hub.onCheckResult({ type: "checkResult", ownerGeneration: 1, attemptId: waiting.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
    expect(await outcomeOf(w, waiting.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "lease_inactive" });
    expect(w.chrome.wire.map((request) => request.attemptId)).toEqual([released.attemptId]);
    // After a restart, from the buffer's ledger: issued-only is not_sent,
    // released is unknown.
    await w.buffer.flush();
    w.hub.endAll("the test restarts the operator", false);
    await w.buffer.close();
    const again = await world({ dir: w.dir });
    const marked = again.buffer.markAttempt(4242, "issued");
    if (marked.ok) await marked.durable;
    expect(again.hub.recoverState(4242)).toBe("not_sent");
    const markedReleased = again.buffer.markAttempt(4243, "issued");
    again.buffer.markAttempt(4243, "released");
    if (markedReleased.ok) await markedReleased.durable;
    expect(again.hub.recoverState(4243)).toBe("unknown");
    // A repeated send of such an attempt: what is known, never a request.
    again.hub.onSend({ ...waiting, attemptId: 4243, sessionFingerprint: FINGERPRINT });
    expect(await outcomeOf(again, 4243)).toEqual({ kind: "transport_error", sent: true, message: "the operator restarted while the request was in flight: its answer is lost" });
    again.hub.onSend({ ...waiting, attemptId: 4242, sessionFingerprint: FINGERPRINT });
    expect(await outcomeOf(again, 4242)).toEqual({ kind: "transport_error", sent: false, message: "the operator restarted before the request was released" });
    expect(again.chrome.issued).toEqual([]);
  });
});

describe("the outcome", () => {
  it("is durable before the engine hears; a buffer that takes nothing still answers — never with a body", async () => {
    const w = await world({ capBytes: 1024 });
    const message = send(w, {}, { chunks: [Buffer.alloc(4000, 7)] });
    // Over the cap: the body's chunk is not written (it counts while it
    // grows — Astra's review of PR 7), the buffer is full, and the result is
    // said from memory as a transport error.
    await until(() => w.engine.of("result").length === 1, 5000, "the unkept result");
    expect(w.engine.of("result")[0]).toEqual({
      type: "result",
      attemptId: message.attemptId,
      sessionFingerprint: FINGERPRINT,
      outcome: { kind: "transport_error", sent: true, message: "the body did not arrive whole: the body could not be written: the buffer's cap leaves no room for it" },
    });
    expect(w.buffer.refusal()).toBe("buffer_full");
    expect(w.outcomes.has(message.attemptId)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readdirSync(join(w.dir, "buffer", "bodies"))).toEqual([]);
  });

  it("of media: the CDN's host, no session headers, its own limit", async () => {
    const w = await world();
    const image = send(w, { kind: "image", url: "https://cdn3.fansly.com/abc/1.jpg?Policy=p&Signature=s&Key-Pair-Id=k", maxBodyBytes: 50 * 1024 * 1024 }, { chunks: [Buffer.alloc(3000, 9)], headers: [{ name: "Content-Type", value: "image/jpeg" }] });
    const outcome = await outcomeOf(w, image.attemptId);
    expect(outcome).toMatchObject({ kind: "response", status: 200, headers: { "content-type": "image/jpeg" }, body: { decodedBytes: 3000 } });
    expect(w.chrome.issued[0]).toMatchObject({ kind: "image", headers: [] });
    expect(new URL(w.chrome.issued[0]!.url).hostname).toBe(`cdn3.fansly.com${PLACEHOLDER_SUFFIX}`);
    // Not under the gate: Chrome's word for the send.
    expect(w.engine.of("sent")).toEqual([expect.objectContaining({ attemptId: image.attemptId })]);
    expect(bodyOf(w, image.attemptId).equals(Buffer.alloc(3000, 9))).toBe(true);
    // A media request to the API's host, or an API one to the CDN, is refused.
    const wrong = send(w, { kind: "video", url: "https://apiv3.fansly.com/api/v1/account/me" });
    expect(await outcomeOf(w, wrong.attemptId)).toEqual({ kind: "transport_error", sent: false, message: "not a URL of the media CDN host for a video request" });
    const session = send(w, { headers: { Authorization: "nope" } });
    expect(await outcomeOf(w, session.attemptId)).toEqual({ kind: "transport_error", sent: false, message: "the route's headers carry the session's own: they come from the live session" });
  });

  it("is not started while the page is not ready (the site not loaded)", async () => {
    const w = await world();
    w.ready.why = "the site is not loaded in the work tab";
    const message = send(w);
    expect(await outcomeOf(w, message.attemptId)).toEqual({ kind: "transport_error", sent: false, message: "the page is not ready: the site is not loaded in the work tab" });
    expect(w.chrome.issued).toEqual([]);
  });

  it("an attempt the page stopped in the middle of is told as sent only if anything of it may have left", async () => {
    const w = await world();
    w.engine.answer = () => null;
    const waiting = send(w);
    await until(() => w.engine.of("check").length === 1);
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: 1, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
    const flying = send(w, {}, { then: "hang_after_send" });
    await until(() => w.chrome.wire.length === 1);
    w.exit.open = false;
    w.hub.endAll("control lost");
    expect(await outcomeOf(w, waiting.attemptId)).toEqual({ kind: "transport_error", sent: false, message: "the page stopped: control lost" });
    expect(await outcomeOf(w, flying.attemptId)).toEqual({ kind: "transport_error", sent: true, message: "the page stopped: control lost" });
    expect(w.hub.session.fingerprint).toBeNull();
  });
});

describe("the addresses (page.ts) and the headers", () => {
  it("start from the placeholder host with the attempt's fragment, and go with the real one", () => {
    const issued = issuedUrl(new URL("https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true"), 77);
    expect(issued).toBe("https://apiv3.fansly.com.pb-hold.invalid/api/v1/account/me?ngsw-bypass=true#hub-77");
    expect(realUrl("https://apiv3.fansly.com.pb-hold.invalid/api/v1/account/me?ngsw-bypass=true", "apiv3.fansly.com")).toBe("https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true");
    expect(attemptOf("#hub-77")).toBe(77);
    for (const fragment of ["", "#hub-", "#hub-0", "#hub-7x", "#pb-selftest-1"]) expect(attemptOf(fragment)).toBeNull();
    // The placeholder is no host the proxy lets through.
    expect(classifyFanslyHost("apiv3.fansly.com.pb-hold.invalid")).toBe("denied");
  });

  it("of a response are lower-case, repeats joined, cookies left out", () => {
    expect(engineHeaders([{ name: "Content-Type", value: "a" }, { name: "Set-Cookie", value: "s=1" }, { name: "Vary", value: "x" }, { name: "vary", value: "y" }])).toEqual({ "content-type": "a", vary: "x, y" });
  });
});

describe("no secret in a log line", () => {
  it("neither the session's token, ids and check, nor a body, nor a query", async () => {
    const w = await world();
    const marker = "BODY-MARKER-7a6b5c";
    const message = send(w, {}, { chunks: [Buffer.from(JSON.stringify({ response: { email: "owner@example.com", note: marker } }))] });
    await outcomeOf(w, message.attemptId);
    const media = send(w, { kind: "image", url: "https://cdn3.fansly.com/abc/1.jpg?Policy=POLICYSECRET&Signature=SIGSECRET&Key-Pair-Id=KPSECRET", maxBodyBytes: MEDIA_BODY_LIMIT });
    await outcomeOf(w, media.attemptId);
    expect(w.lines.filter((line) => line.includes('"c":"hub"')).length).toBeGreaterThanOrEqual(4);
    const all = w.lines.join("\n");
    for (const secret of [TOKEN, CLIENT_ID, SESSION_ID, fanslyClientCheck(ME, CLIENT_ID), marker, "owner@example.com", "POLICYSECRET", "SIGSECRET", "KPSECRET"]) {
      expect(all, secret).not.toContain(secret);
    }
    // A line that carried one anyway would lose it.
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    makeLog("test")("oops", { authorization: "Bearer abcdefgh12345678", note: `with ${TOKEN} inside`, cookie: "sid=1", "fansly-session-id": "x1" });
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).not.toContain("abcdefgh12345678");
    expect(lines[0]).not.toContain("sid=1");
    expect(JSON.parse(lines[0]!)).toMatchObject({ authorization: "[secret]", cookie: "[secret]", "fansly-session-id": "[secret]", note: "with [secret] inside" });
    expect(existsSync(join(w.dir, "buffer", "bodies"))).toBe(true);
  });
});
