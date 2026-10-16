import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PausedRequest } from "../apps/page-browser/src/cdp/paused.ts";
import type { GroupItem } from "../apps/page-browser/src/buffer/buffer.ts";
import { ApiGate } from "../apps/page-browser/src/egress/gate.ts";
import { SiteSession } from "../apps/page-browser/src/hub-requests/session.ts";
import { OBSERVED_EARLY_MS, OBSERVED_KEPT, OBSERVED_OUTBOX_MAX, SiteObserver } from "../apps/page-browser/src/intercept/observe.ts";
import type { RequestLine } from "../apps/page-browser/src/logs/journal.ts";
import { Operator } from "../apps/page-browser/src/operator/operator.ts";
import type { OperatorToEngine } from "../apps/page-browser/src/rpc/protocol.ts";
import { setLogSink } from "../apps/page-browser/src/shared/util.ts";
import { FakeCdpPort, FakeChrome, FakeChromeControl, FakeEngine, hello, quiet, RPC_TOKEN, tempDir } from "./helpers/page-browser-fakes.ts";

// Variant Б (plan-b-browser-host §4.1.2, §4.1.8; Б-2a): the site's own API
// traffic is observed, never paused — what left and how it ended goes to
// the engine, the session is learned from the site's own GET as it left,
// the body of platform data goes to the buffer as the site's (attempt 0);
// the gate on the shared connections holds and cuts nothing.

const SESSION = "s".repeat(64);
const API = "https://apiv3.fansly.com";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function world(options: { hub?: Set<string>; up?: boolean } = {}) {
  const cdp = new FakeCdpPort();
  const sent: OperatorToEngine[] = [];
  const notes: PausedRequest[] = [];
  const groups: GroupItem[][] = [];
  const journal: RequestLine[] = [];
  const written: Buffer[] = [];
  const reads: Array<{ route: string; status: number | null; sent: boolean; session: string | null }> = [];
  const link = { up: options.up ?? true, accepts: Infinity };
  let fingerprint: string | null = null;
  cdp.handlers.set("Network.getResponseBody", () => ({ body: Buffer.from('{"success":true,"response":{"account":{"id":"1"}}}').toString("base64"), base64Encoded: true }));
  const observer = new SiteObserver({
    cdp,
    isApiHost: (host) => host === "apiv3.fansly.com",
    isHubRequest: (id) => options.hub?.has(id) === true,
    mode: () => "automation",
    link: { send: (message) => {
      if (!link.up || link.accepts <= 0) return false;
      link.accepts -= 1;
      sent.push(message);
      return true;
    } },
    session: {
      note: (request) => {
        notes.push(request);
        if (request.headers.authorization !== undefined) fingerprint = SESSION;
      },
      fingerprint: () => fingerprint,
    },
    buffer: {
      beginBody: () => ({
        write: (chunk: Buffer) => { written.push(chunk); return true; },
        seal: () => ({ bodyId: "b1", bytes: written.reduce((n, c) => n + c.length, 0), sha256: "f".repeat(64) }),
        abandon: () => undefined,
      }) as never,
      appendGroup: (items) => { groups.push(items); return { ok: true }; },
      removeBody: () => undefined,
    },
    journal: (line) => journal.push(line),
    readEnded: (end) => reads.push(end),
    log: () => undefined,
  });
  return { cdp, observer, sent, notes, groups, journal, reads, link };
}

function request(w: ReturnType<typeof world>, id: string, path: string, method = "GET") {
  w.cdp.emit("Network.requestWillBeSent", { requestId: id, frameId: "F1", type: "XHR", request: { url: `${API}${path}`, method } }, "S1");
}

describe("the site's own API traffic, observed (variant Б)", () => {
  it("what left and how it ended goes to the engine; the session is learned as it left; the body is kept as the site's", async () => {
    const w = world();
    request(w, "r1", "/api/v1/account/me?ngsw-bypass=true");
    expect(w.sent).toEqual([]);
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "r1", headers: { authorization: "token-x", accept: "application/json" } }, "S1");
    expect(w.notes).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ type: "siteSent", siteRequestId: "r1", method: "GET", host: "apiv3.fansly.com", path: "/api/v1/account/me", route: "account.me", sessionFingerprint: SESSION });
    w.cdp.emit("Network.responseReceived", { requestId: "r1", response: { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": "a=b" } } }, "S1");
    w.cdp.emit("Network.loadingFinished", { requestId: "r1", encodedDataLength: 321 }, "S1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.sent[1]).toMatchObject({ type: "siteEnded", siteRequestId: "r1", status: 200, error: null });
    const event = (w.groups[0]![0] as { event: Record<string, unknown> }).event;
    expect(event).toMatchObject({ kind: "site.response", attemptId: 0, route: "account.me", status: 200, complete: true, source: "network", sessionFingerprint: SESSION });
    expect(event.headers).toEqual({ "content-type": "application/json" });
    expect(w.journal[0]).toMatchObject({ method: "GET", path: "/api/v1/account/me", decision: "ended", status: 200, bytes: 321 });
    // Nothing was paused: no Fetch command went.
    expect(w.cdp.commands.filter((command) => command.method.startsWith("Fetch."))).toEqual([]);
  });

  it("Hub's own requests and other hosts are not the site's; an answer that never left (cache, service worker) sends nothing", async () => {
    const w = world({ hub: new Set(["hub-1"]) });
    request(w, "hub-1", "/api/v1/account/me");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "hub-1", headers: { authorization: "t" } }, "S1");
    w.cdp.emit("Network.requestWillBeSent", { requestId: "cdn-1", request: { url: "https://cdn3.fansly.com/x.jpg", method: "GET" } }, "S1");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "cdn-1", headers: {} }, "S1");
    request(w, "cached", "/api/v1/versioning");
    w.cdp.emit("Network.responseReceived", { requestId: "cached", response: { status: 200, headers: {}, fromServiceWorker: true } }, "S1");
    w.cdp.emit("Network.loadingFinished", { requestId: "cached" }, "S1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.sent).toEqual([]);
  });

  it("a request that failed after it left ends with its error; a preflight teaches no session", () => {
    const w = world();
    request(w, "p1", "/api/v1/account/me", "OPTIONS");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "p1", headers: { "access-control-request-method": "GET" } }, "S1");
    expect(w.notes).toEqual([]);
    w.cdp.emit("Network.loadingFailed", { requestId: "p1", errorText: "net::ERR_FAILED" }, "S1");
    expect(w.sent.map((m) => m.type)).toEqual(["siteSent", "siteEnded"]);
    expect(w.sent[1]).toMatchObject({ status: null, error: "net::ERR_FAILED" });
  });

  it("drops every HTTP/2 pseudo-header before noting the session, with the same defence in SiteSession", () => {
    const w = world();
    const headers = { ":authority": "apiv3.fansly.com", ":method": "GET", ":path": "/api/v1/account/me", ":scheme": "https", ":other": "wire-only", authorization: "token-x", accept: "application/json" };
    request(w, "h2", "/api/v1/account/me");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "h2", headers }, "S1");
    expect(w.notes[0]!.headers).toEqual({ authorization: "token-x", accept: "application/json" });

    const session = new SiteSession();
    session.note({ method: "GET", url: `${API}/api/v1/account/me`, headers });
    expect(session.headersFor("/api/v1/account/me", {})).toMatchObject({ ok: true, headers: [["authorization", "token-x"], ["accept", "application/json"]] });
  });

  it.each([
    ["requestExtra", "responseExtra", "request", "response"],
    ["responseExtra", "requestExtra", "request", "response"],
    ["responseExtra", "request", "requestExtra", "response"],
    ["request", "responseExtra", "requestExtra", "response"],
    ["request", "requestExtra", "responseExtra", "response"],
    ["request", "requestExtra", "response", "responseExtra"],
    ["requestExtra", "request", "response", "responseExtra"],
  ])("matches ExtraInfo in any order: %s, %s, %s, %s", (...order) => {
    const w = world();
    let knownRequest = false;
    let knownExtra = false;
    for (const event of order) {
      if (event === "request") {
        request(w, "early", "/api/v1/account/me");
        knownRequest = true;
      } else if (event === "requestExtra") {
        w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "early", headers: { authorization: "token-x" } }, "S1");
        knownExtra = true;
      } else if (event === "responseExtra") {
        w.cdp.emit("Network.responseReceivedExtraInfo", { requestId: "early", statusCode: 429, headers: { "Retry-After": "17" } }, "S1");
      } else {
        // Chrome can report a different status (e.g. cache revalidation).
        w.cdp.emit("Network.responseReceived", { requestId: "early", response: { status: 200, headers: { "retry-after": "1", "Content-Type": "application/json" } } }, "S1");
      }
      expect(w.sent).toHaveLength(knownRequest && knownExtra ? 1 : 0);
    }
    expect(w.notes).toHaveLength(1);
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "early", headers: {} }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "early", errorText: "net::ERR_FAILED" }, "S1");
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]).toMatchObject({ type: "siteEnded", siteRequestId: "early", status: 429, retryAfter: "17", error: "net::ERR_FAILED" });
    expect(w.notes).toHaveLength(1);
  });

  it.each([429, 401, 403])("keeps HTTP %s when loading fails or the page cancels after headers", (status) => {
    for (const canceled of [false, true]) {
      const w = world();
      request(w, "cut", "/api/v1/account/me");
      w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "cut", headers: {} }, "S1");
      w.cdp.emit("Network.responseReceived", { requestId: "cut", response: { status, headers: { "Retry-After": "9" } } }, "S1");
      w.cdp.emit("Network.loadingFailed", { requestId: "cut", canceled, errorText: "net::ERR_CONNECTION_CLOSED" }, "S1");
      expect(w.sent[1]).toMatchObject({ type: "siteEnded", status, retryAfter: "9", error: canceled ? "canceled" : "net::ERR_CONNECTION_CLOSED" });
      expect(w.journal[0]!.status).toBe(status);
      expect(w.reads[0]!.status).toBe(status);
    }
  });

  it.each([true, false])("gets a CORS failure's status only from response ExtraInfo (early: %s)", (early) => {
    const w = world();
    const response = () => w.cdp.emit("Network.responseReceivedExtraInfo", { requestId: "cors", statusCode: 403, headers: { "Retry-After": "20" } }, "S1");
    if (early) response();
    request(w, "cors", "/api/v1/account/me");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "cors", headers: {} }, "S1");
    if (!early) response();
    w.cdp.emit("Network.loadingFailed", { requestId: "cors", errorText: "net::ERR_FAILED", corsErrorStatus: { corsError: "MissingAllowOriginHeader" } }, "S1");
    expect(w.sent[1]).toMatchObject({ type: "siteEnded", status: 403, retryAfter: "20", error: "net::ERR_FAILED" });
  });

  it("expires unmatched ExtraInfo, bounds it by count and forgets it on a Chrome reset", () => {
    vi.useFakeTimers();
    const w = world();
    const extra = (id: string) => {
      w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: id, headers: { authorization: "token-x" } }, "S1");
      w.cdp.emit("Network.responseReceivedExtraInfo", { requestId: id, statusCode: 429, headers: { "Retry-After": "30" } }, "S1");
    };
    extra("expired");
    vi.advanceTimersByTime(OBSERVED_EARLY_MS);
    request(w, "expired", "/api/v1/account/me");
    expect(w.sent).toEqual([]);
    // A fresh send must not inherit the expired response either.
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "expired", headers: {} }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "expired" }, "S1");
    expect(w.sent[1]).toMatchObject({ type: "siteEnded", status: null, retryAfter: null });
    w.sent.length = 0;
    for (let n = 0; n <= OBSERVED_KEPT; n++) extra(`bounded-${n}`);
    request(w, "bounded-0", "/api/v1/account/me");
    expect(w.sent).toEqual([]);
    request(w, `bounded-${OBSERVED_KEPT}`, "/api/v1/account/me");
    expect(w.sent).toHaveLength(1);
    extra("reset");
    w.observer.reset();
    request(w, "reset", "/api/v1/account/me");
    expect(w.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the original send time when ExtraInfo is early, and the latest site send across Chrome resets", () => {
    let now = 1_000;
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => BigInt(now) * 1_000_000n);
    const w = world();
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "early", headers: {} }, "S1");
    now = 2_000;
    request(w, "later", "/api/v1/account/me");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "later", headers: {} }, "S1");
    const latest = w.observer.lastSend;
    now = 3_000;
    request(w, "early", "/api/v1/account/me");
    expect(w.sent[1]).toMatchObject({ type: "siteSent", siteRequestId: "early", sentMono: 1_000 });
    expect(w.observer.lastSend).toEqual(latest);
    expect(latest).toMatchObject({ mono: 2_000 });
    w.observer.reset();
    expect(w.observer.lastSend).toEqual(latest);
  });

  it("flushes missed sends and a 429 in order, then restores requests still in flight without changing their send time", () => {
    const w = world();
    request(w, "flying", "/api/v1/account/me");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "flying", headers: { authorization: "token-x" } }, "S1");
    const flying = w.sent[0];
    w.link.up = false;
    w.observer.linkChanged(false);
    request(w, "held", "/api/v1/account/me");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "held", headers: {} }, "S1");
    w.cdp.emit("Network.responseReceivedExtraInfo", { requestId: "held", statusCode: 429, headers: { "Retry-After": "40" } }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "held", errorText: "net::ERR_FAILED" }, "S1");
    request(w, "new-flight", "/api/v1/account/me");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "new-flight", headers: {} }, "S1");
    request(w, "no-wire-event", "/api/v1/account/me");
    const latest = w.observer.lastSend;
    w.sent.length = 0;
    w.link.up = true;
    w.observer.linkChanged(true);
    expect(w.sent.map((m) => [m.type, "siteRequestId" in m ? m.siteRequestId : null])).toEqual([
      ["siteSent", "held"], ["siteEnded", "held"], ["siteSent", "new-flight"], ["siteSent", "flying"],
    ]);
    expect(w.sent[1]).toMatchObject({ status: 429, retryAfter: "40", error: "net::ERR_FAILED" });
    expect(w.sent[3]).toEqual(flying);
    expect(w.observer.lastSend).toEqual(latest);
  });

  it("replays an end with its route even if its send reached only the previous engine, and survives another failed flush", () => {
    const w = world();
    request(w, "old-flight", "/api/v1/account/me");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "old-flight", headers: { authorization: "token-x" } }, "S1");
    const original = w.sent[0];
    w.link.up = false;
    w.cdp.emit("Network.responseReceivedExtraInfo", { requestId: "old-flight", statusCode: 401 }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "old-flight", canceled: true }, "S1");
    w.observer.reset();
    w.sent.length = 0;
    w.link.up = true;
    w.link.accepts = 1;
    w.observer.linkChanged(true);
    expect(w.sent).toEqual([original]);
    // Yet another engine: the end must retain its send's context.
    w.sent.length = 0;
    w.link.accepts = Infinity;
    w.observer.linkChanged(true);
    expect(w.sent[0]).toEqual(original);
    expect(w.sent[1]).toMatchObject({ type: "siteEnded", siteRequestId: "old-flight", status: 401, error: "canceled" });
    w.observer.linkChanged(true);
    expect(w.sent).toHaveLength(2);
  });

  it("bounds the disconnected outbox and retains the newest observations", () => {
    const w = world({ up: false });
    for (let n = 0; n <= OBSERVED_OUTBOX_MAX; n++) {
      request(w, `outbox-${n}`, "/api/v1/account/me");
      w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: `outbox-${n}`, headers: {} }, "S1");
    }
    w.link.up = true;
    w.observer.linkChanged(true);
    expect(w.sent).toHaveLength(OBSERVED_OUTBOX_MAX);
    expect(w.sent[0]).toMatchObject({ type: "siteSent", siteRequestId: "outbox-1" });
    expect(w.sent.at(-1)).toMatchObject({ type: "siteSent", siteRequestId: `outbox-${OBSERVED_OUTBOX_MAX}` });
  });

  it.each([true, false])("the operator reconnect hook runs and quiesced uses the latest send of either origin (site latest: %s)", async (siteLatest) => {
    const w = world();
    request(w, "floor", "/api/v1/account/me");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "floor", headers: {} }, "S1");
    const site = w.observer.lastSend!;
    const hub = { mono: site.mono + (siteLatest ? -1 : 1), wall: site.wall + (siteLatest ? -1 : 1) };
    const latest = siteLatest ? site : hub;
    const temp = tempDir("pb-observe-");
    const engine = new FakeEngine();
    setLogSink(quiet);
    const operator = new Operator({
      config: {
        holderSock: join(temp.dir, "holder.sock"), proxyHost: "127.0.0.1", proxyPort: 0, rpcHost: "127.0.0.1", rpcPort: 0, rpcToken: RPC_TOKEN,
        netSelftestPath: join(temp.dir, "selftest.json"), chromeEnvPath: join(temp.dir, "chrome-env"), logDir: join(temp.dir, "logs"), stateDir: join(temp.dir, "state"),
        bufferDir: join(temp.dir, "buffer"), extensionDir: join(temp.dir, "extension"), heartbeatPath: null, operatorVersion: "test",
      },
      chrome: new FakeChromeControl(new FakeChrome()), log: quiet,
    });
    try {
      vi.spyOn(operator.observer, "lastSend", "get").mockReturnValue(site);
      vi.spyOn(operator.egress.gate, "lastSend", "get").mockReturnValue(hub);
      const links = vi.spyOn(operator.observer, "linkChanged");
      const port = await operator.rpc.listen(0, "127.0.0.1");
      await engine.connect(port);
      engine.send(hello({ protocol: { majors: [1], minor: 4 } }));
      expect(await engine.waitFor("quiesced")).toMatchObject({ lastSendMono: latest.mono, lastSendWall: latest.wall });
      expect(links).toHaveBeenCalledWith(true);
      engine.close();
      await vi.waitFor(() => expect(links).toHaveBeenCalledWith(false));
    } finally {
      engine.close();
      await operator.stop();
      temp.remove();
      setLogSink(null);
    }
  });
});

describe("the gate on connections shared by the site and Hub (variant Б)", () => {
  it("holds, refuses and cuts nothing; a Hub window's first bytes are its first big record; the last API write is known", async () => {
    let now = 1_000;
    const gate = new ApiGate({ now: () => now, passive: true });
    let cuts = 0;
    gate.cut = () => ++cuts;
    gate.cutTunnel = () => { cuts += 1; return true; };
    const events: string[] = [];
    gate.onEvent = (event) => events.push(event.kind);
    expect(gate.admitsTunnel()).toBe(true);
    expect(gate.record(1, true, true, true)).toBe("up");
    expect(gate.lastApiWriteMono).toBe(1_000);
    expect(gate.open("hub:7:main", now + 50, 0)).toEqual({ ok: true });
    expect(gate.admitsTunnel()).toBe(true);
    gate.noteTunnel(2);
    now += 10;
    expect(gate.record(2, true, true, true)).toBe("up");
    expect(gate.record(3, true, true, true)).toBe("up");
    expect(events).toContain("first_bytes");
    // Past the deadline and the window's close: nothing is cut.
    now += 100;
    await new Promise((resolve) => setTimeout(resolve, 80));
    gate.close("hub:7:main");
    expect(cuts).toBe(0);
    // One Hub operation at a time still.
    expect(gate.open("hub:8:main", now + 50, 0)).toMatchObject({ ok: false, inFlight: "hub:7" });
  });
});
