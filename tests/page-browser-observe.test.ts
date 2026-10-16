import { describe, expect, it } from "vitest";

import type { PausedRequest } from "../apps/page-browser/src/cdp/paused.ts";
import type { GroupItem } from "../apps/page-browser/src/buffer/buffer.ts";
import { ApiGate } from "../apps/page-browser/src/egress/gate.ts";
import { SiteObserver } from "../apps/page-browser/src/intercept/observe.ts";
import type { RequestLine } from "../apps/page-browser/src/logs/journal.ts";
import type { OperatorToEngine } from "../apps/page-browser/src/rpc/protocol.ts";
import { FakeCdpPort } from "./helpers/page-browser-fakes.ts";

// Variant Б (plan-b-browser-host §4.1.2, §4.1.8; Б-2a): the site's own API
// traffic is observed, never paused — what left and how it ended goes to
// the engine, the session is learned from the site's own GET as it left,
// the body of platform data goes to the buffer as the site's (attempt 0);
// the gate on the shared connections holds and cuts nothing.

const SESSION = "s".repeat(64);
const API = "https://apiv3.fansly.com";

function world(options: { hub?: Set<string> } = {}) {
  const cdp = new FakeCdpPort();
  const sent: OperatorToEngine[] = [];
  const notes: PausedRequest[] = [];
  const groups: GroupItem[][] = [];
  const journal: RequestLine[] = [];
  const written: Buffer[] = [];
  let fingerprint: string | null = null;
  cdp.handlers.set("Network.getResponseBody", () => ({ body: Buffer.from('{"success":true,"response":{"account":{"id":"1"}}}').toString("base64"), base64Encoded: true }));
  const observer = new SiteObserver({
    cdp,
    isApiHost: (host) => host === "apiv3.fansly.com",
    isHubRequest: (id) => options.hub?.has(id) === true,
    mode: () => "automation",
    link: { send: (message) => { sent.push(message); return true; } },
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
    log: () => undefined,
  });
  return { cdp, observer, sent, notes, groups, journal };
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
