
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PausedRequest } from "../apps/page-browser/src/cdp/paused.ts";
import type { GroupItem } from "../apps/page-browser/src/buffer/buffer.ts";
import {
  OBSERVED_KEPT,
  OBSERVED_RESEND_MS,
  SiteObserver,
} from "../apps/page-browser/src/intercept/observe.ts";
import type { RequestLine } from "../apps/page-browser/src/logs/journal.ts";
import type { OperatorToEngine } from "../apps/page-browser/src/rpc/protocol.ts";
import { monoMs } from "../apps/page-browser/src/shared/util.ts";
import { FakeCdpPort } from "./helpers/page-browser-fakes.ts";

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

function world(options: { hub?: Set<string>; up?: boolean; probes?: Map<string, string>; confirms?: boolean } = {}) {
  const cdp = new FakeCdpPort();
  const sent: OperatorToEngine[] = [];
  const notes: PausedRequest[] = [];
  const groups: GroupItem[][] = [];
  const journal: RequestLine[] = [];
  const written: Buffer[] = [];
  const reads: Array<{ route: string; status: number | null; sent: boolean; session: string | null }> = [];
  const link = { up: options.up ?? true, accepts: Infinity, confirms: options.confirms ?? false };
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  let fingerprint: string | null = null;
  cdp.handlers.set("Network.getResponseBody", () => ({ body: Buffer.from('{"success":true,"response":{"account":{"id":"1"}}}').toString("base64"), base64Encoded: true }));
  const observer = new SiteObserver({
    cdp,
    isApiHost: (host) => host === "apiv3.fansly.com",
    isHubRequest: (id) => options.hub?.has(id) === true,
    probeOf: (id) => options.probes?.get(id) ?? null,
    mode: () => "automation",
    link: { send: (message) => {
      if (!link.up || link.accepts <= 0) return false;
      link.accepts -= 1;
      sent.push(message);
      return true;
    }, confirms: () => link.confirms },
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
    log: (event, fields) => logs.push({ event, ...(fields === undefined ? {} : { fields }) }),
  });
  return { cdp, observer, sent, notes, groups, journal, reads, link, logs };
}

function left(w: ReturnType<typeof world>, id: string, path = "/api/v1/account/me") {
  request(w, id, path);
  w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: id, headers: {} }, "S1");
}

function request(w: ReturnType<typeof world>, id: string, path: string, method = "GET") {
  w.cdp.emit("Network.requestWillBeSent", { requestId: id, frameId: "F1", type: "XHR", request: { url: `${API}${path}`, method } }, "S1");
}

describe("the site's own API traffic, observed (variant Б)", () => {
  it("keeps each route's latest 429 end on the operator's clock, with an inclusive cutoff", () => {
    let now = 1_000;
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => BigInt(now) * 1_000_000n);
    const w = world();
    left(w, "me");
    w.cdp.emit("Network.responseReceived", { requestId: "me", response: { status: 429 } }, "S1");
    expect(w.observer.holdSince("account.me", 0)).toBeNull();
    now = 2_000;
    w.cdp.emit("Network.loadingFinished", { requestId: "me" }, "S1");
    expect(w.observer.holdSince("account.me", 2_000)).toEqual({ status: 429, route: "account.me" });
    expect(w.observer.holdSince("account.me", 2_001)).toBeNull();
    expect(w.observer.holdSince("notifications.page", 0)).toBeNull();
    now = 3_000;
    left(w, "notifications", "/api/v1/notifications");
    w.cdp.emit("Network.responseReceivedExtraInfo", { requestId: "notifications", statusCode: 429 }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "notifications", errorText: "net::ERR_FAILED" }, "S1");
    expect(w.observer.holdSince("notifications.page", 3_000)).toEqual({ status: 429, route: "notifications.page" });
    expect(w.observer.holdSince("account.me", 2_000)).toEqual({ status: 429, route: "account.me" });
    now = 4_000;
    left(w, "me-again");
    w.cdp.emit("Network.responseReceived", { requestId: "me-again", response: { status: 429 } }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "me-again" }, "S1");
    expect(w.observer.holdSince("account.me", 4_000)).toEqual({ status: 429, route: "account.me" });
    expect(w.observer.holdSince("notifications.page", 4_000)).toBeNull();
  });

  it.each([401, 403])("a site's HTTP %s holds every route, and the latest applicable end wins", (status) => {
    let now = 1_000;
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => BigInt(now) * 1_000_000n);
    const w = world();
    left(w, "credentials", "/api/v1/notifications");
    w.cdp.emit("Network.responseReceived", { requestId: "credentials", response: { status } }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "credentials" }, "S1");
    expect(w.observer.holdSince("account.me", 1_000)).toEqual({ status, route: "notifications.page" });
    expect(w.observer.holdSince("ws.upgrade", 1_000)).toEqual({ status, route: "notifications.page" });
    expect(w.observer.holdSince("account.me", 1_001)).toBeNull();
    now = 2_000;
    left(w, "route");
    w.cdp.emit("Network.responseReceived", { requestId: "route", response: { status: 429 } }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "route" }, "S1");
    expect(w.observer.holdSince("account.me", 1_000)).toEqual({ status: 429, route: "account.me" });
    expect(w.observer.holdSince("notifications.page", 1_000)).toEqual({ status, route: "notifications.page" });
    now = 3_000;
    left(w, "credentials-again", "/api/v1/settings");
    w.cdp.emit("Network.responseReceived", { requestId: "credentials-again", response: { status } }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "credentials-again" }, "S1");
    expect(w.observer.holdSince("account.me", 3_000)).toEqual({ status, route: "site.other" });
  });

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

  it("a secret read (PB audit 2026-10-22, P2-3) is told to the engine and journaled, but its body is never read nor kept", async () => {
    const w = world();
    left(w, "managers", "/api/v1/management/managementsessions");
    w.cdp.emit("Network.responseReceived", { requestId: "managers", response: { status: 200, headers: { "Content-Type": "application/json" } } }, "S1");
    w.cdp.emit("Network.loadingFinished", { requestId: "managers", encodedDataLength: 900 }, "S1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.sent.map((message) => message.type)).toEqual(["siteSent", "siteEnded"]);
    expect(w.sent[0]).toMatchObject({ path: "/api/v1/management/managementsessions", route: "site.other" });
    expect(w.sent[1]).toMatchObject({ status: 200, error: null });
    expect(w.journal[0]).toMatchObject({ path: "/api/v1/management/managementsessions", decision: "ended", status: 200 });
    expect(w.cdp.commands.filter((command) => command.method === "Network.getResponseBody")).toEqual([]);
    expect(w.groups).toEqual([]);
  });

  it("the site's delivered mark its check let go is the site's own send — a POST, route site.other, its answer not kept; a read mark refused in Fetch never left", async () => {
    const w = world();
    request(w, "delivered", "/api/v1/message/ack?ngsw-bypass=true", "POST");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "delivered", headers: { authorization: "token-x", "content-type": "application/json" } }, "S1");
    expect(w.sent[0]).toMatchObject({ type: "siteSent", siteRequestId: "delivered", method: "POST", host: "apiv3.fansly.com", path: "/api/v1/message/ack", route: "site.other" });
    expect(w.observer.inFlight).toBe(1);
    w.cdp.emit("Network.responseReceived", { requestId: "delivered", response: { status: 200, headers: { "Content-Type": "application/json" } } }, "S1");
    w.cdp.emit("Network.loadingFinished", { requestId: "delivered", encodedDataLength: 140 }, "S1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.sent[1]).toMatchObject({ type: "siteEnded", siteRequestId: "delivered", status: 200, error: null });
    expect(w.observer.lastSend).not.toBeNull();
    // No platform data: its answer is never read nor kept.
    expect(w.cdp.commands.filter((command) => command.method === "Network.getResponseBody")).toEqual([]);
    expect(w.groups).toEqual([]);
    expect(w.journal[0]).toMatchObject({ method: "POST", path: "/api/v1/message/ack", admission: "observed (the site's own)", decision: "ended", status: 200, bytes: 140 });
    // A read mark the operator failed in Fetch: no send to tell, its end journaled.
    request(w, "read", "/api/v1/message/ack?ngsw-bypass=true", "POST");
    w.cdp.emit("Network.loadingFailed", { requestId: "read", errorText: "net::ERR_BLOCKED_BY_CLIENT" }, "S1");
    expect(w.sent).toHaveLength(2);
    expect(w.journal[1]).toMatchObject({ method: "POST", path: "/api/v1/message/ack", decision: "ended", result: "net::ERR_BLOCKED_BY_CLIENT" });
    expect(w.observer.inFlight).toBe(0);
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

  it("a request followed no further ends as a failed load would: Chrome went, its id came again, too many followed — a redirect's hop ends with its answer", () => {
    const w = world();
    const left = (id: string, path = "/api/v1/settings", method = "GET") => {
      request(w, id, path, method);
      w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: id, headers: {} }, "S1");
    };
    left("hop");
    w.cdp.emit("Network.requestWillBeSent", { requestId: "hop", frameId: "F1", type: "XHR", request: { url: `${API}/api/v1/account/me`, method: "GET" }, redirectResponse: { status: 302 } }, "S1");
    w.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: "hop", headers: {} }, "S1");
    left("again");
    request(w, "again", "/api/v1/settings");
    left("flying-429");
    w.cdp.emit("Network.responseReceivedExtraInfo", { requestId: "flying-429", statusCode: 429, headers: { "Retry-After": "12" } }, "S1");
    left("flying-preflight", "/api/v1/account/1/wallets", "OPTIONS");
    request(w, "never-left", "/api/v1/settings");
    w.reads.length = 0;
    w.observer.reset("control lost: Chrome's network service restarted");
    const gone = "followed no further: control lost: Chrome's network service restarted";
    expect(w.sent.map((m) => m.type === "siteEnded" ? [m.type, m.siteRequestId, m.status, m.error] : [m.type, "siteRequestId" in m ? m.siteRequestId : null])).toEqual([
      ["siteSent", "hop"], ["siteEnded", "hop", 302, null], ["siteSent", "hop"],
      ["siteSent", "again"], ["siteEnded", "again", null, "followed no further: its request id came again"],
      ["siteSent", "flying-429"], ["siteSent", "flying-preflight"],
      ["siteEnded", "hop", null, gone], ["siteEnded", "flying-429", 429, gone], ["siteEnded", "flying-preflight", null, gone],
    ]);
    expect(w.sent[1]).toMatchObject({ retryAfter: null });
    expect(w.sent.at(-2)).toMatchObject({ retryAfter: "12" });
    expect(w.sent[2]).toMatchObject({ path: "/api/v1/account/me", route: "account.me" });
    // Its answer never came whole: no read for the login desk; each is journaled.
    expect(w.reads).toEqual([]);
    expect(w.journal.filter((line) => line.result === gone).map((line) => line.path)).toEqual(["/api/v1/account/me", "/api/v1/settings", "/api/v1/settings", "/api/v1/account/1/wallets", "/api/v1/settings"]);
    expect(w.observer.inFlight).toBe(0);

    w.sent.length = 0;
    for (let n = 0; n <= OBSERVED_KEPT; n++) left(`kept-${n}`);
    expect(w.observer.inFlight).toBe(OBSERVED_KEPT);
    expect(w.sent.filter((m) => m.type === "siteEnded")).toEqual([
      expect.objectContaining({ siteRequestId: "kept-0", status: null, error: "followed no further: too many requests followed" }),
    ]);
  });

  it("keeps each observation until the engine confirms it, tells it again once unconfirmed long enough, and lets a send go with its confirmed end (minor 6)", () => {
    const w = world({ confirms: true });
    left(w, "r1");
    const sent = w.sent[0] as Extract<OperatorToEngine, { type: "siteSent" }>;
    expect(sent).toMatchObject({ type: "siteSent", siteRequestId: "r1", hop: 0, deliverySeq: 1 });
    expect(sent.requestKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(w.observer.outbox).toMatchObject({ unconfirmed: 1, dropped: 0 });
    expect(w.observer.outbox.oldestAtWall).toEqual(expect.any(Number));
    // Not yet due: nothing goes again.
    w.observer.resend(monoMs() + OBSERVED_RESEND_MS - 100);
    expect(w.sent).toHaveLength(1);
    // Unconfirmed past its wait: the same message, the same number.
    w.observer.resend(monoMs() + OBSERVED_RESEND_MS + 1);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]).toEqual(sent);
    w.cdp.emit("Network.responseReceivedExtraInfo", { requestId: "r1", statusCode: 429, headers: { "Retry-After": "30" } }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "r1", errorText: "net::ERR_FAILED" }, "S1");
    // An end goes on its own: its send is still kept.
    expect(w.sent[2]).toMatchObject({ type: "siteEnded", siteRequestId: "r1", status: 429, requestKey: sent.requestKey, hop: 0, deliverySeq: 2 });
    expect(w.observer.outbox.unconfirmed).toBe(2);
    // A number it does not keep is nothing; the end confirmed lets its send go.
    w.observer.confirmed([99]);
    expect(w.observer.outbox.unconfirmed).toBe(2);
    w.observer.confirmed([2]);
    expect(w.observer.outbox).toEqual({ unconfirmed: 0, oldestAtWall: null, dropped: 0 });
    w.observer.resend(monoMs() + 10 * OBSERVED_RESEND_MS);
    expect(w.sent).toHaveLength(3);
  });

  it("a confirmed send goes; its end is kept until confirmed — a new connection gets what is kept in order and is told what still flies (minor 6)", () => {
    const w = world({ confirms: true });
    left(w, "done");
    left(w, "flying");
    w.observer.confirmed([1, 2]);
    w.link.up = false;
    w.observer.linkChanged(false);
    w.cdp.emit("Network.responseReceived", { requestId: "done", response: { status: 200, headers: {} } }, "S1");
    w.cdp.emit("Network.loadingFailed", { requestId: "done", errorText: "net::ERR_ABORTED" }, "S1");
    left(w, "missed");
    w.sent.length = 0;
    w.link.up = true;
    w.observer.linkChanged(true);
    // What is kept, oldest first, then the send still flying it was not told of.
    expect(w.sent.map((m) => [m.type, "siteRequestId" in m ? m.siteRequestId : null, "deliverySeq" in m ? m.deliverySeq : null])).toEqual([
      ["siteEnded", "done", 3], ["siteSent", "missed", 4], ["siteSent", "flying", 5],
    ]);
    // A link that takes nothing more keeps it for the next write.
    w.link.accepts = 0;
    w.observer.resend(monoMs() + OBSERVED_RESEND_MS + 1);
    expect(w.sent).toHaveLength(3);
    w.link.accepts = Infinity;
    w.observer.resend(monoMs() + OBSERVED_RESEND_MS + 1);
    expect(w.sent.slice(3).map((m) => "deliverySeq" in m ? m.deliverySeq : null)).toEqual([3, 4, 5]);
  });
});

