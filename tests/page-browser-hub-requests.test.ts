import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventBuffer } from "../apps/page-browser/src/buffer/buffer.ts";
import { PausedRequests, type PausedDecision } from "../apps/page-browser/src/cdp/paused.ts";
import { ApiGate } from "../apps/page-browser/src/egress/gate.ts";
import { trimPausedPostData } from "../apps/page-browser/src/holder/holder.ts";
import { classifyFanslyHost } from "../apps/page-browser/src/egress/hosts.ts";
import { API_BODY_LIMIT, HubRequests, MEDIA_BODY_LIMIT, type HubDeps, type HubTimings, type PageQuiet } from "../apps/page-browser/src/hub-requests/hub.ts";
import { fanslyClientTs, fanslyClientTsTailMatches } from "../apps/page-browser/src/hub-requests/client-ts.ts";
import { PLACEHOLDER_SUFFIX } from "../apps/page-browser/src/hub-requests/page.ts";
import { fanslyClientCheck, SiteSession, sessionFingerprint } from "../apps/page-browser/src/hub-requests/session.ts";
import { partFingerprint, writeFingerprint } from "../apps/page-browser/src/hub-requests/write.ts";
import type { Result, Send } from "../apps/page-browser/src/rpc/protocol.ts";
import { describeFanslyPart, describeFanslyWrite, fanslyPartFingerprint, fanslyWriteFingerprint, type FanslyWireId } from "../packages/fansly/src/index.ts";
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

/** The site's own headers; its fansly-client-ts as its getNowTs makes it at
 *  `atMs` (now). */
function siteHeaders(token = TOKEN, path = ME, atMs = Date.now()): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    authorization: token,
    "fansly-client-check": fanslyClientCheck(path, CLIENT_ID),
    "fansly-client-id": CLIENT_ID,
    "fansly-client-ts": String(fanslyClientTs(atMs, SESSION_ID)),
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

async function world(options: { timings?: Partial<HubTimings>; gateNoResponseMs?: number; slotLimitMs?: number; capBytes?: number; noSession?: boolean; dir?: string; passive?: boolean; quiet?: () => PageQuiet; siteHold?: HubDeps["siteHold"] } = {}): Promise<World> {
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
  cleanups.push(() => { gate.reset(); gate.browserGone(); });
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
    readsBody: (request) => HubRequests.readsBody(request),
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
    ...(options.quiet ? { quiet: options.quiet } : {}),
    ...(options.siteHold ? { siteHold: options.siteHold } : {}),
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
    // The time as the site's getNowTs has it: the clock's 10 s, the tail
    // from the session's id.
    expect(fanslyClientTsTailMatches(headers["fansly-client-ts"]!, SESSION_ID)).toBe(true);
    expect(Math.abs(Number(headers["fansly-client-ts"]) - Date.now())).toBeLessThan(10_000);
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
    expect(w.engine.of("sent")).toEqual([{ type: "sent", attemptId: message.attemptId, sentMono: expect.any(Number), sentWall: expect.any(Number), connectionReused: true, releasedMono: expect.any(Number) }]);
    expect(w.engine.of("sent")[0]!.releasedMono as number).toBeLessThanOrEqual(w.engine.of("sent")[0]!.sentMono as number);
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
});

describe("the page's quiet before a Hub request (plan-b Б2, Б12)", () => {
  const admitWith = (w: World, pauseMs: number, deadlineMs = 15_000) => {
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: 1, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + deadlineMs, pauseMs });
  };

  it("is released only once the admission's pause passed since the last send the operator saw — the proxy's write the engine did not know of yet — and says when", async () => {
    const seen: PageQuiet = { lastSendMono: null, siteInFlight: false };
    const w = await world({ passive: true, quiet: () => seen });
    admitWith(w, 300);
    // The site wrote to the API a moment ago; the engine granted all the same.
    seen.lastSendMono = monoMs();
    const message = send(w);
    expect(await outcomeOf(w, message.attemptId)).toMatchObject({ kind: "response", status: 200 });
    const sent = w.engine.of("sent")[0]!;
    expect(sent.releasedMono as number).toBeGreaterThanOrEqual(seen.lastSendMono + 300);
    expect(sent.sentMono as number).toBeGreaterThanOrEqual(sent.releasedMono as number);
    expect(w.cdp.sent("Fetch.continueRequest")).toHaveLength(1);
    expect(w.lines.some((line) => line.includes('"release.quiet"'))).toBe(true);
  });

  it("refuses the request after its preflight when a site's hold appeared between them, keeping the operation sent", async () => {
    let held = false;
    const w = await world({ passive: true, siteHold: (route) => held ? { status: 429, route } : null });
    admitWith(w, 100);
    const fulfill = w.cdp.handlers.get("Fetch.fulfillRequest")!;
    w.cdp.handlers.set("Fetch.fulfillRequest", (command) => {
      held = true;
      return fulfill(command);
    });
    const failedBefore = w.cdp.sent("Fetch.failRequest").length;
    const message = send(w, {}, { preflight: 204 });
    expect(await outcomeOf(w, message.attemptId)).toEqual({ kind: "transport_error", sent: true, message: "the site's 429 on account.me holds the Hub request" });
    expect(w.engine.of("check")).toHaveLength(1);
    expect(w.cdp.sent("Fetch.continueRequest")).toHaveLength(1);
    expect(w.chrome.wire.map((request) => request.role)).toEqual(["preflight"]);
    expect(w.cdp.sent("Fetch.failRequest")).toHaveLength(failedBefore + 1);
    expect(w.lines.filter((line) => line.includes('"release.held"'))).toHaveLength(1);
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

  it("gives a Hub request the site's fansly-client-ts: the tail from the template's session id, from the device's without one", async () => {
    const w = await world();
    const first = send(w);
    expect((await outcomeOf(w, first.attemptId)).kind).toBe("response");
    const withSession = Object.fromEntries(w.chrome.issued[0]!.headers)["fansly-client-ts"]!;
    expect(fanslyClientTsTailMatches(withSession, SESSION_ID)).toBe(true);
    // A new document's first request, before its socket: no session id, the
    // device service's time.
    w.chrome.navigate("https://fansly.com/");
    const { "fansly-session-id": _session, ...early } = siteHeaders();
    w.chrome.siteRequest(ME, { ...early, "fansly-client-ts": String(fanslyClientTs(Date.now(), CLIENT_ID)) });
    await until(() => w.hub.session.sendBlock() === null, 2000, "the new document's template");
    const second = send(w);
    expect((await outcomeOf(w, second.attemptId)).kind).toBe("response");
    const issued = Object.fromEntries(w.chrome.issued[1]!.headers);
    expect(issued["fansly-session-id"]).toBeUndefined();
    expect(fanslyClientTsTailMatches(issued["fansly-client-ts"]!, CLIENT_ID)).toBe(true);
    expect(w.alarms).toEqual([]);
  });

  it("a site request whose fansly-client-ts lacks the formula's tail: an alarm once, Hub's requests refused as for fansly-client-check, until the site's next one has it", async () => {
    const w = await world();
    const right = String(fanslyClientTs(Date.now() + 20_000, SESSION_ID));
    const wrong = right.slice(0, -4) + (right.endsWith("0000") ? "1111" : "0000");
    w.chrome.siteRequest(ME, { ...siteHeaders(), "fansly-client-ts": wrong });
    await until(() => w.alarms.length === 1, 2000, "the alarm");
    expect(w.alarms).toEqual([{ kind: "header_mismatch", detail: { what: "fansly-client-ts", path: ME, detail: "the site computes it another way: Hub requests do not go" } }]);
    expect(w.hub.session.sendBlock()).toEqual({ reason: "client_check", sinceWall: expect.any(Number) });
    const refused = send(w);
    expect(await outcomeOf(w, refused.attemptId)).toEqual({ kind: "transport_error", sent: false, message: "the site computes fansly-client-ts another way than the operator: the transport is not ready" });
    expect(w.chrome.issued).toEqual([]);
    // Told once.
    const later = String(fanslyClientTs(Date.now() + 30_000, SESSION_ID));
    w.chrome.siteRequest(ME, { ...siteHeaders(), "fansly-client-ts": later.slice(0, -4) + (later.endsWith("0000") ? "1111" : "0000") });
    // The site's next value with the tail clears it.
    w.chrome.siteRequest(ME, siteHeaders(TOKEN, ME, Date.now() + 40_000));
    await until(() => w.hub.session.sendBlock() === null, 2000, "the block cleared");
    expect(w.alarms).toHaveLength(1);
    const goes = send(w);
    expect((await outcomeOf(w, goes.attemptId)).kind).toBe("response");
  });

  it("a site's fansly-client-ts not above one it sent is its cache's answer (getNowTs never goes back): not judged again", () => {
    const told: string[] = [];
    const session = new SiteSession({ onCheckMismatch: (_path, header) => told.push(header) });
    const at = 1_800_000_129_000;
    const first = String(fanslyClientTs(at, SESSION_ID));
    session.note({ method: "GET", url: `https://apiv3.fansly.com${ME}`, headers: siteHeaders(TOKEN, ME, at) });
    // A new session inside the same 10 s: the site's cache still answers the
    // earlier value, its tail from the earlier id.
    session.note({ method: "GET", url: `https://apiv3.fansly.com${ME}`, headers: { ...siteHeaders(TOKEN, ME, at), "fansly-session-id": "100000000000000734", "fansly-client-ts": first } });
    expect(session.sendBlock()).toBeNull();
    expect(told).toEqual([]);
  });

  it("header names that differ from the site's: an alarm once for each difference, the path learned afresh from the site's next request, Hub's requests go on", async () => {
    const w = await world();
    // As Chrome says Hub's went (the scripted Chrome tells it at the send).
    const hubOrder = ["accept", "authorization", "fansly-client-check", "fansly-client-id", "fansly-client-ts", "user-agent"];
    const siteOrder = ["authorization", "accept", "fansly-client-check", "fansly-client-id", "fansly-client-ts", "user-agent"];
    const hubSent = async () => {
      const message = send(w);
      expect((await outcomeOf(w, message.attemptId)).kind).toBe("response");
    };
    const siteSent = (names: string[]) => w.chrome.siteSent(w.chrome.siteRequest(ME, siteHeaders()).networkId, names);
    siteSent(siteOrder);
    await hubSent();
    expect(w.alarms).toEqual([{ kind: "header_mismatch", detail: { what: "header names", path: `GET ${ME}`, hub: hubOrder.join(","), site: siteOrder.join(",") } }]);
    expect(w.hub.session.sendBlock()).toBeNull();
    // Learned afresh: the Hub request after it has nothing to be compared
    // with until the site's next request to the path, which agrees.
    await hubSent();
    siteSent(hubOrder);
    expect(w.alarms).toHaveLength(1);
    // The same difference again: not told twice; Hub's requests still go.
    siteSent(siteOrder);
    expect(w.alarms).toHaveLength(1);
    await hubSent();
    expect(w.hub.session.sendBlock()).toBeNull();
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
    expect(w.chrome.releasedInPage).not.toContain(message.attemptId);
    expect(w.chrome.requestsOf(message.attemptId).every((request) => request.ended)).toBe(true);
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

  it("a passive gate (variant Б) cannot say a released request did not leave: a network failure after the release is possibly sent", async () => {
    const w = await world({ passive: true });
    const ok = send(w);
    expect(await outcomeOf(w, ok.attemptId)).toMatchObject({ kind: "response", status: 200 });
    const failed = send(w, {}, { then: "fail_before_send" });
    expect(await outcomeOf(w, failed.attemptId)).toEqual({ kind: "transport_error", sent: true, message: "net::ERR_TUNNEL_CONNECTION_FAILED" });
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

// ── Hub's writes (wall posts PR 7) ─────────────────────────────────────────

/** A write as the engine sends it: its route's request (`describeFanslyWrite`)
 *  with the command's fingerprint. */
function writeSend(w: World, route: FanslyWireId, params: Record<string, unknown>, overrides: Partial<Send> = {}, script?: HubScript): Send {
  const write = describeFanslyWrite(route, params as never);
  const host = write.host === "upload" ? "mediav2.fansly.com" : "apiv3.fansly.com";
  return send(w, {
    route,
    method: "POST",
    url: `https://${host}${write.pathAndQuery}`,
    headers: { "content-type": "application/json" },
    body: write.body,
    writeFingerprint: write.fingerprint,
    ...overrides,
  }, script);
}

const POST = { content: "hello", fyp: false, attachments: [{ contentId: "am1", contentType: 1, pos: 0 }], scheduledForMs: 0, expiresAtMs: 0, wallIds: ["w1"], pinWallIds: [], replyLock: [] };
const CANCEL = { postId: "777" };
const UPLOAD = { fileSize: 1234, mimeType: "image/jpeg", fileName: "a.jpg" };

describe("a Hub write (wall posts PR 7)", () => {
  it("computes the engine's fingerprint, the same for every route", () => {
    for (const [route, params] of [["publish.post", POST], ["publish.post_cancel", CANCEL], ["publish.upload_create", UPLOAD]] as const) {
      const write = describeFanslyWrite(route, params as never);
      const host = write.host as "api" | "upload";
      expect(writeFingerprint({ method: write.method, host, pathAndQuery: write.pathAndQuery, body: write.body }), route).toBe(write.fingerprint);
      expect(writeFingerprint({ method: write.method, host, pathAndQuery: write.pathAndQuery, body: Buffer.from(write.body, "utf8") }), route).toBe(fanslyWriteFingerprint(write));
    }
  });

  it("goes under its permission, its body as fingerprinted, its admission naming the fingerprint: one POST, its preflight in the operation", async () => {
    const w = await world();
    w.hub.setPublishing({ create: true, withdraw: false });
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: w.engine.generation, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 15_000, writeFingerprint: sent.writeFingerprint });
    const sent = writeSend(w, "publish.post", POST, {}, { preflight: 204, newTunnel: true });
    const outcome = await outcomeOf(w, sent.attemptId);
    expect(outcome).toMatchObject({ kind: "response", status: 200 });
    // Started in the page as a POST of its body, from its placeholder.
    expect(w.chrome.issued[0]).toMatchObject({ method: "POST", body: sent.body });
    expect(new URL(w.chrome.issued[0]!.url).hostname).toBe(`apiv3.fansly.com${PLACEHOLDER_SUFFIX}`);
    expect(Object.fromEntries(w.chrome.issued[0]!.headers)["content-type"]).toBe("application/json");
    // One check; what left: its preflight, then the POST on its real address.
    expect(w.engine.of("check")).toHaveLength(1);
    expect(w.chrome.wire).toEqual([
      { attemptId: sent.attemptId, role: "preflight", method: "OPTIONS", url: "https://apiv3.fansly.com/api/v1/post?ngsw-bypass=true" },
      { attemptId: sent.attemptId, role: "main", method: "POST", url: "https://apiv3.fansly.com/api/v1/post?ngsw-bypass=true" },
    ]);
  });

  it("is refused before it starts off its open paths, without its permission, of another route, or not the request fingerprinted", async () => {
    const w = await world();
    const refused = async (message: Send) => {
      expect(await outcomeOf(w, message.attemptId), message.url).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
    };
    // Both permissions off (the operator's start, every hello).
    await refused(writeSend(w, "publish.post", POST));
    await refused(writeSend(w, "publish.post_cancel", CANCEL));
    // Create on: a cancel needs withdraw.
    w.hub.setPublishing({ create: true, withdraw: false });
    await refused(writeSend(w, "publish.post_cancel", CANCEL));
    // Withdraw alone: a cancel goes, a post does not.
    w.hub.setPublishing({ create: false, withdraw: true });
    await refused(writeSend(w, "publish.post", POST));
    w.hub.setPublishing({ create: true, withdraw: true });
    // Another path, query or host; a route that is not the path's.
    await refused(writeSend(w, "publish.post", POST, { url: "https://apiv3.fansly.com/api/v1/message?ngsw-bypass=true" }));
    await refused(writeSend(w, "publish.post", POST, { url: "https://apiv3.fansly.com/api/v1/post" }));
    await refused(writeSend(w, "publish.post", POST, { url: "https://apiv3.fansly.com/api/v1/post?ngsw-bypass=true&x=1" }));
    await refused(writeSend(w, "publish.post", POST, { url: "https://fansly.com/api/v1/post?ngsw-bypass=true" }));
    await refused(writeSend(w, "publish.post", POST, { route: "publish.story" }));
    // A body or a fingerprint that do not go together.
    await refused(writeSend(w, "publish.post", POST, { body: JSON.stringify({ ...POST, content: "edited" }) }));
    await refused(writeSend(w, "publish.post", POST, { writeFingerprint: "0".repeat(64) }));
    // Nothing of them started in the page, nothing was asked or left.
    expect(w.chrome.issued).toEqual([]);
    expect(w.engine.of("check")).toEqual([]);
    expect(w.chrome.wire).toEqual([]);
  });

  it("lets nothing go when Chrome holds another body, the admission names no fingerprint or another, or the permission went before the release", async () => {
    const w = await world();
    w.hub.setPublishing({ create: true, withdraw: true });
    const echo = (fingerprint: string | undefined) => (check: Record<string, unknown>) => ({ type: "checkResult", ownerGeneration: w.engine.generation, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 15_000, ...(fingerprint === undefined ? {} : { writeFingerprint: fingerprint }) });
    // An admission of a write that names no fingerprint, or another.
    w.engine.answer = echo(undefined);
    const bare = writeSend(w, "publish.post", POST);
    expect(await outcomeOf(w, bare.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
    w.engine.answer = echo("1".repeat(64));
    const other = writeSend(w, "publish.post", POST);
    expect(await outcomeOf(w, other.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
    // Chrome holds a body other than the page's (at the request's pause,
    // after its preflight): the POST never leaves.
    w.chrome.bodyOverride = (_attemptId, body) => (body === null ? null : body.replace("hello", "HELLO"));
    let current = "";
    w.engine.answer = (check) => echo(current)(check);
    const swapped = writeSend(w, "publish.post", POST, {}, { preflight: 204, newTunnel: true });
    current = swapped.writeFingerprint!;
    expect(await outcomeOf(w, swapped.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
    w.chrome.bodyOverride = null;
    // The permission taken away while the check was answered.
    w.engine.answer = (check) => {
      w.hub.setPublishing({ create: false, withdraw: true });
      return echo(current)(check);
    };
    const revoked = writeSend(w, "publish.post", POST);
    current = revoked.writeFingerprint!;
    expect(await outcomeOf(w, revoked.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
    // Not one POST left; only the swapped one's preflight did.
    expect(w.chrome.wire.filter((request) => request.method === "POST")).toEqual([]);
    expect(w.chrome.wire.map((request) => `${request.attemptId} ${request.method}`)).toEqual([`${swapped.attemptId} OPTIONS`]);
  });

  it("to the upload API: takes the page's slot, no window; the upload host is held only while it does", async () => {
    const w = await world();
    w.hub.setPublishing({ create: true, withdraw: false });
    let during = false;
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: w.engine.generation, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 15_000, writeFingerprint: sent.writeFingerprint });
    w.chrome.bodyOverride = (_attemptId, body) => {
      during = w.hub.holdsUpload();
      return body;
    };
    expect(w.hub.holdsUpload()).toBe(false);
    const sent = writeSend(w, "publish.upload_create", UPLOAD);
    expect(await outcomeOf(w, sent.attemptId)).toMatchObject({ kind: "response", status: 200 });
    expect(new URL(w.chrome.issued[0]!.url).hostname).toBe(`mediav2.fansly.com${PLACEHOLDER_SUFFIX}`);
    expect(w.chrome.wire).toEqual([{ attemptId: sent.attemptId, role: "main", method: "POST", url: "https://mediav2.fansly.com/api/v1/media/upload/create?ngsw-bypass=true" }]);
    // At its pause it was not admitted yet: no tunnel there then.
    expect(during).toBe(false);
    expect(w.hub.holdsUpload()).toBe(false);
    // Released and in flight: held; ended, not any more.
    const hanging = writeSend(w, "publish.upload_create", UPLOAD, {}, { then: "hang_after_send" });
    w.engine.answer = (check) => ({ type: "checkResult", ownerGeneration: w.engine.generation, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 15_000, writeFingerprint: hanging.writeFingerprint });
    await until(() => w.chrome.wire.some((request) => request.attemptId === hanging.attemptId), 2000, "the upload's send");
    expect(w.hub.holdsUpload()).toBe(true);
    w.hub.endAll("the test ends it");
    expect(w.hub.holdsUpload()).toBe(false);
  });
});

describe("the operator's own stop of Hub's writes (spec §8.3; PR 7 part 2)", () => {
  const admitWrite = (w: World) => {
    w.engine.answer = (check) => {
      const sent = sends.get(Number(check.attemptId));
      return { type: "checkResult", ownerGeneration: w.engine.generation, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 15_000, ...(sent === undefined ? {} : { writeFingerprint: sent }) };
    };
  };
  const sends = new Map<number, string>();
  const write = (w: World, script?: HubScript) => {
    const sent = writeSend(w, "publish.post", POST, {}, script);
    if (sent.writeFingerprint !== undefined) sends.set(sent.attemptId, sent.writeFingerprint);
    return sent;
  };

  it("a 401, 403 or 429 to a write stops both permissions at once, held until the engine names the stop; a new hello keeps it", async () => {
    for (const status of [401, 403, 429] as const) {
      const w = await world();
      admitWrite(w);
      w.hub.setPublishing({ create: true, withdraw: true });
      const refused = write(w, { status, chunks: [Buffer.from('{"success":false,"error":{"code":1}}')] });
      expect(await outcomeOf(w, refused.attemptId)).toMatchObject({ kind: "response", status });
      const stop = w.hub.publishing.stop;
      expect(stop, String(status)).toMatchObject({ reason: `http_${status}`, id: expect.any(String) });
      expect(w.hub.publishing).toMatchObject({ create: false, withdraw: false });
      // Nothing more goes: the engine's word without the stop's name, a new
      // hello's reset, another stop's name — none lets it go.
      w.hub.setPublishing({ create: true, withdraw: true });
      w.hub.setPublishing({ create: false, withdraw: false });
      w.hub.setPublishing({ create: true, withdraw: true, clearStop: "another" });
      expect(w.hub.publishing).toMatchObject({ create: false, withdraw: false, stop });
      const next = write(w);
      expect(await outcomeOf(w, next.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
      // Named back by the engine (recorded as the page's autostop): as it sets.
      w.hub.setPublishing({ create: true, withdraw: true, clearStop: stop!.id });
      expect(w.hub.publishing).toEqual({ create: true, withdraw: true, stop: null });
    }
  });

  it("a Fansly check on any answer of Hub's stops them, a read's too; a write's other refusal does not", async () => {
    const w = await world();
    admitWrite(w);
    w.hub.setPublishing({ create: true, withdraw: true });
    const rejected = write(w, { status: 400, chunks: [Buffer.from('{"success":false,"error":{"code":2}}')] });
    expect(await outcomeOf(w, rejected.attemptId)).toMatchObject({ kind: "response", status: 400 });
    expect(w.hub.publishing.stop).toBeNull();
    const read = send(w, {}, { status: 403, headers: [{ name: "content-type", value: "text/html" }, { name: "cf-mitigated", value: "challenge" }] });
    expect(await outcomeOf(w, read.attemptId)).toMatchObject({ kind: "response", status: 403 });
    expect(w.hub.publishing).toMatchObject({ create: false, withdraw: false, stop: { reason: "challenge" } });
    // What the operator tells it (the login lost) keeps the stop it holds.
    const held = w.hub.publishing.stop;
    w.hub.stopPublishing("login_lost", "the test signs out");
    expect(w.hub.publishing.stop).toEqual(held);
  });
});

describe("an upload's part and its status read (wall posts PR 8; minor 9)", () => {
  const STORAGE = "https://uploads.example.net/media/abc/part-1?X-Amz-Signature=s1g&partNumber=1";
  const bytesOf = (n: number, fill = 7) => Buffer.alloc(n, fill);
  const admitAs = (w: World, fingerprint: () => string | undefined, forMs = 15_000) => {
    w.engine.answer = (check) => {
      const named = fingerprint();
      return { type: "checkResult", ownerGeneration: w.engine.generation, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + forMs, ...(named === undefined ? {} : { writeFingerprint: named }) };
    };
  };
  /** A part's send, with the bytes that came before it (null: none whole). */
  const partSend = (w: World, bytes: Buffer | null, overrides: Partial<Send> = {}, script?: HubScript, sha = bytes === null ? "0".repeat(64) : sha256(bytes)): Send => {
    const url = new URL(overrides.url ?? STORAGE);
    const message: Send = {
      type: "send",
      ownerGeneration: w.engine.generation,
      attemptId: ++nextId,
      route: "publish.upload_part",
      credentialsGeneration: "c".repeat(64),
      sessionFingerprint: FINGERPRINT,
      method: "PUT",
      url: url.toString(),
      headers: {},
      kind: "part",
      maxBodyBytes: MEDIA_BODY_LIMIT,
      sendDeadlineMono: monoMs() + 15_000,
      requestDeadlineMono: monoMs() + 120_000,
      writeFingerprint: partFingerprint({ host: url.hostname, path: url.pathname, partSha256: sha }),
      bodyRef: { bodyId: "00000000-0000-4000-8000-0000000000c1", decodedBytes: bytes?.length ?? 5, sha256: sha },
      ...overrides,
    };
    if (script) w.chrome.scripts.set(message.attemptId, script);
    w.hub.onSend(message, bytes);
    return message;
  };

  it("computes the engine's part fingerprint: the storage host, the path, the bytes' sha256 — never the query", () => {
    const params = { uploadCommandId: 9, partIndex: 1, host: "uploads.example.net", path: "/media/abc/part-1", fileId: 3, byteOffset: 5_242_880, byteLength: 4, partSha256: sha256(Buffer.from("abcd")) };
    const described = describeFanslyPart(params);
    expect(described).toMatchObject({ method: "PUT", host: "storage", pathAndQuery: "//uploads.example.net/media/abc/part-1", body: "" });
    expect(partFingerprint({ host: params.host, path: params.path, partSha256: params.partSha256 })).toBe(described.fingerprint);
    expect(fanslyPartFingerprint(params)).toBe(described.fingerprint);
    // Not one of Fansly's role hosts, not the site, not an address.
    for (const host of ["apiv3.fansly.com", "mediav2.fansly.com", "cdn3.fansly.com", "fansly.com", "www.fansly.com", "a.b.fansly.com", "10.0.0.1", "localhost", "Uploads.example.net"]) {
      expect(() => describeFanslyPart({ ...params, host }), host).toThrow(RangeError);
    }
    expect(describeFanslyPart({ ...params, host: "upload.fansly.com" }).host).toBe("storage");
    expect(() => describeFanslyPart({ ...params, path: "/a?x=1" })).toThrow(RangeError);
  });

  it("goes under create with the bytes that came before it: a PUT with no body in the page, Chrome handed the part's own at the release, the slot and no window; the storage's answer with its ETag", async () => {
    const w = await world();
    w.hub.setPublishing({ create: true, withdraw: false });
    let named: string | undefined = undefined;
    admitAs(w, () => named);
    const bytes = bytesOf(300_000);
    const sent = partSend(w, bytes, {}, { preflight: 200, headers: [{ name: "etag", value: '"9b2cf535f27731c974343645a3985328"' }, { name: "content-length", value: "0" }], chunks: [Buffer.alloc(0)] });
    named = sent.writeFingerprint;
    const outcome = await outcomeOf(w, sent.attemptId);
    expect(outcome).toMatchObject({ kind: "response", status: 200, headers: { etag: '"9b2cf535f27731c974343645a3985328"' } });
    expect(w.chrome.issued[0]).toMatchObject({ kind: "part", method: "PUT", body: null });
    expect(new URL(w.chrome.issued[0]!.url).hostname).toBe(`uploads.example.net${PLACEHOLDER_SUFFIX}`);
    // No session of the site rides on it.
    expect(w.chrome.issued[0]!.headers).toEqual([]);
    expect(w.chrome.wire).toEqual([
      { attemptId: sent.attemptId, role: "preflight", method: "OPTIONS", url: STORAGE },
      { attemptId: sent.attemptId, role: "main", method: "PUT", url: STORAGE },
    ]);
    expect(w.chrome.handed.get(sent.attemptId)?.equals(bytes)).toBe(true);
    expect(w.engine.of("check")).toHaveLength(1);
    // The upload host's tunnel is not the part's.
    expect(w.hub.holdsUpload()).toBe(false);
  });

  it("is refused before it starts without create, its bytes whole, as many and of the sha256 named, on a storage host, of the part's route, as fingerprinted", async () => {
    const w = await world();
    const bytes = bytesOf(1000);
    const refused = async (message: Send) => {
      expect(await outcomeOf(w, message.attemptId), `${message.route} ${message.url}`).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
    };
    await refused(partSend(w, bytes));
    w.hub.setPublishing({ create: false, withdraw: true });
    await refused(partSend(w, bytes));
    w.hub.setPublishing({ create: true, withdraw: true });
    await refused(partSend(w, null));
    await refused(partSend(w, bytes, { bodyRef: { bodyId: "00000000-0000-4000-8000-0000000000c1", decodedBytes: 999, sha256: sha256(bytes) } }));
    await refused(partSend(w, bytes, {}, undefined, sha256(bytesOf(1000, 8))));
    await refused(partSend(w, bytes, { writeFingerprint: "1".repeat(64) }));
    await refused(partSend(w, bytes, { route: "publish.upload_create" }));
    for (const url of ["https://apiv3.fansly.com/x", "https://mediav2.fansly.com/x", "https://cdn3.fansly.com/x", "https://fansly.com/x", "http://uploads.example.net/x", "https://uploads.example.net:8443/x", "https://127.0.0.1/x", "https://uploads.example.net.pb-hold.invalid/x"]) {
      await refused(partSend(w, bytes, { url }));
    }
    expect(w.chrome.issued).toEqual([]);
    expect(w.engine.of("check")).toEqual([]);
    expect(w.chrome.wire).toEqual([]);
  });

  it("lets nothing go when the admission names another fingerprint, the page has a body for it, or create went before the release", async () => {
    const w = await world();
    w.hub.setPublishing({ create: true, withdraw: false });
    const bytes = bytesOf(2048);
    admitAs(w, () => "2".repeat(64));
    const other = partSend(w, bytes);
    expect(await outcomeOf(w, other.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
    let named: string | undefined = undefined;
    admitAs(w, () => named);
    for (const told of [2048, null]) {
      w.chrome.partBodyBytes = () => told;
      const bodied = partSend(w, bytes);
      named = bodied.writeFingerprint;
      expect(await outcomeOf(w, bodied.attemptId), String(told)).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
    }
    w.chrome.partBodyBytes = null;
    w.engine.answer = (check) => {
      w.hub.setPublishing({ create: false, withdraw: true });
      return { type: "checkResult", ownerGeneration: w.engine.generation, attemptId: check.attemptId, admit: true, deadlineMono: monoMs() + 15_000, writeFingerprint: named };
    };
    const revoked = partSend(w, bytes);
    named = revoked.writeFingerprint;
    expect(await outcomeOf(w, revoked.attemptId)).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
    expect(w.chrome.wire.filter((request) => request.method === "PUT")).toEqual([]);
    expect(w.chrome.handed.size).toBe(0);
  });

  it("the holder keeps a paused part's echoed body as its length only (ari-1, 2026-10-27)", () => {
    const part = bytesOf(3 * 1024 * 1024, 9);
    const paused = (extra: Record<string, unknown>) => Buffer.from(JSON.stringify({ method: "Fetch.requestPaused", params: { requestId: "I-1", request: { url: STORAGE, method: "PUT", headers: {}, hasPostData: true, ...extra }, responseStatusCode: 200 } }));
    const kept = trimPausedPostData(paused({ postData: part.toString("latin1"), postDataEntries: [{ bytes: part.subarray(0, 1000).toString("base64") }, { bytes: part.subarray(1000).toString("base64") }] }));
    expect(kept.length).toBeLessThan(1024);
    expect(JSON.parse(kept.toString()).params.request).toEqual({ url: STORAGE, method: "PUT", headers: {}, hasPostData: true, pbPostDataBytes: part.length });
    expect(JSON.parse(trimPausedPostData(paused({ postData: part.toString("latin1") })).toString()).params.request.pbPostDataBytes).toBeNull();
    // A small body, another message, a large one with no body: as Chrome sent them.
    for (const message of [paused({ postData: "{}" }), Buffer.from(JSON.stringify({ method: "Network.dataReceived", params: { data: part.toString("base64") } })), paused({ note: part.toString("base64") })]) {
      expect(trimPausedPostData(message)).toBe(message);
    }
  });

  it("a part's limit is its request deadline, not the 21 s of an API request — and so is its slot's bound", async () => {
    const w = await world({ timings: { opLimitMs: 300 }, slotLimitMs: 200 });
    let unended = 0;
    w.gate.onUnended = () => (unended += 1);
    w.hub.setPublishing({ create: true, withdraw: false });
    let named: string | undefined = undefined;
    // Admitted for 300 ms: the slot's bound would pass 500 ms on.
    admitAs(w, () => named, 300);
    const slow = partSend(w, bytesOf(100), { sendDeadlineMono: monoMs() + 300 }, { sendDelayMs: 900 });
    named = slow.writeFingerprint;
    expect(await outcomeOf(w, slow.attemptId)).toMatchObject({ kind: "response", status: 200 });
    expect(unended).toBe(0);
  });

  it("the upload's status read: a GET of the upload API under create, the upload host held while it is; refused without create or as another route", async () => {
    const w = await world();
    const status = (overrides: Partial<Send> = {}, script?: HubScript) => send(w, { route: "publish.upload_status", url: "https://mediav2.fansly.com/api/v1/media/upload/777?ngsw-bypass=true", ...overrides }, script);
    expect(await outcomeOf(w, status().attemptId)).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
    w.hub.setPublishing({ create: true, withdraw: false });
    expect(await outcomeOf(w, status({ route: "polls" }).attemptId)).toEqual({ kind: "aborted_before_send", refusal: "write_refused" });
    // Another path on the upload API is no read of Hub's.
    expect(await outcomeOf(w, status({ url: "https://mediav2.fansly.com/api/v1/media/upload/777" }).attemptId)).toMatchObject({ kind: "transport_error", sent: false });
    const read = status();
    expect(await outcomeOf(w, read.attemptId)).toMatchObject({ kind: "response", status: 200 });
    expect(w.chrome.wire.at(-1)).toEqual({ attemptId: read.attemptId, role: "main", method: "GET", url: "https://mediav2.fansly.com/api/v1/media/upload/777?ngsw-bypass=true" });
    const hanging = status({}, { then: "hang_after_send" });
    await until(() => w.chrome.wire.some((request) => request.attemptId === hanging.attemptId), 2000, "the status read's send");
    expect(w.hub.holdsUpload()).toBe(true);
    w.hub.endAll("the test ends it");
    expect(w.hub.holdsUpload()).toBe(false);
  });
});
