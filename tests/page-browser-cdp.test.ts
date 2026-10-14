import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Cdp, CdpError, CdpUnanswered } from "../apps/page-browser/src/cdp/client.ts";
import { BrowserControl } from "../apps/page-browser/src/cdp/control.ts";
import { PausedRequests, type PausedRequest } from "../apps/page-browser/src/cdp/paused.ts";

const POSITION = { latitude: 48.137, longitude: 11.575, accuracyM: 25 };
import { BrowserModel, FakeChrome, HolderUnderS6, quiet, tempDir, until } from "./helpers/page-browser-fakes.ts";

// The operator's CDP client through the holder (Project Browser plan §4.1,
// step 4; stage 3, PR 4): a paused request is acknowledged only once Chrome
// answered its resolution, a restarted operator learns about the requests
// still paused from the holder's replay and fails them, and the control's
// setup lets no web target run without it — the page's position (PR 5)
// included.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setUp() {
  const temp = tempDir();
  cleanups.push(temp.remove);
  const chrome = new FakeChrome();
  await chrome.boot();
  cleanups.push(() => chrome.shutdown());
  const holder = new HolderUnderS6(join(temp.dir, "holder.sock"), chrome);
  await holder.start();
  cleanups.push(() => holder.stop());
  await until(() => chrome.live !== undefined, 3000, "the holder's DevTools connection");
  const operator = (decide: (request: PausedRequest) => ReturnType<ConstructorParameters<typeof PausedRequests>[1]["decide"]> = () => ({ action: "fail", reason: "BlockedByClient", why: "test" })) => {
    const cdp = new Cdp({ socketPath: holder.socketPath, commandTimeoutMs: 500, log: quiet });
    const decided: Array<[PausedRequest, string]> = [];
    const indeterminate: string[] = [];
    const resolved: Array<[string, string, string]> = [];
    const paused = new PausedRequests(cdp, {
      decide,
      onDecided: (request, decision) => decided.push([request, decision.action]),
      onResolved: (request, decision, resolution) => resolved.push([request.requestId, decision.action, resolution]),
      onIndeterminate: (request) => indeterminate.push(request.requestId),
      log: quiet,
    });
    cleanups.push(() => cdp.close());
    return { cdp, paused, decided, indeterminate, resolved };
  };
  return { chrome, holder, operator };
}

describe("paused requests", () => {
  it("are failed and acknowledged only once Chrome answered the resolution", async () => {
    const { chrome, holder, operator } = await setUp();
    let answer: (() => void) | null = null;
    chrome.handlers.set("Fetch.failRequest", (command) => {
      answer = () => chrome.reply(command, {});
      return null;
    });
    const { cdp, decided, resolved } = operator();
    await cdp.connect();
    chrome.event("Fetch.requestPaused", { requestId: "interception-1", networkId: "R1", request: { url: "https://fansly.com/", method: "GET" }, resourceType: "Document" });
    await until(() => chrome.sent("Fetch.failRequest").length === 1);
    expect(chrome.sent("Fetch.failRequest")[0]?.params).toEqual({ requestId: "interception-1", errorReason: "BlockedByClient" });
    expect(decided[0]?.[0]).toMatchObject({ requestId: "interception-1", networkId: "R1", replayed: false, stage: "request", method: "GET" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(holder.holder?.stats.stored).toBe(1);
    // Decided is not resolved: what needs Chrome's answer waits for it.
    expect(resolved).toEqual([]);
    answer!();
    await until(() => holder.holder?.stats.stored === 0, 2000, "the acknowledgement");
    expect(resolved).toEqual([["interception-1", "fail", "answered"]]);
  });

  it("left unresolved by an operator that died are learned from the replay and failed by the next one — never continued", async () => {
    const { chrome, holder, operator } = await setUp();
    // The first operator: linked, but dies before it resolves anything.
    const dead = new Cdp({ socketPath: holder.socketPath, log: quiet });
    await dead.connect();
    chrome.event("Fetch.requestPaused", { requestId: "interception-7", networkId: "R7", request: { url: "https://apiv3.fansly.com/api/v1/account/me", method: "GET" }, resourceType: "XHR" });
    chrome.event("Network.requestWillBeSent", { requestId: "R7", request: { url: "https://apiv3.fansly.com/api/v1/account/me" } });
    await until(() => holder.holder?.stats.lastSeq === 2);
    dead.close();
    // The next operator would continue anything — a replayed pause is failed whatever it decides.
    const { cdp, decided } = operator(() => ({ action: "continue" }));
    const link = await cdp.connect();
    // The event was acknowledged once handled; the pause never was.
    expect(link).toMatchObject({ cdpUp: true, stored: 1, lastSeq: 2 });
    await cdp.replayEnded;
    await until(() => chrome.sent("Fetch.failRequest").length === 1);
    expect(chrome.sent("Fetch.continueRequest")).toEqual([]);
    expect(chrome.sent("Fetch.failRequest")[0]?.params).toEqual({ requestId: "interception-7", errorReason: "BlockedByClient" });
    expect(decided).toHaveLength(1);
    expect(decided[0]?.[0].replayed).toBe(true);
    await until(() => holder.holder?.stats.stored === 0, 2000, "the replay acknowledged");
    // A live pause after the replay is the new operator's to decide.
    chrome.event("Fetch.requestPaused", { requestId: "interception-8", networkId: "R8", request: { url: "https://fansly.com/", method: "GET" }, resourceType: "Document" });
    await until(() => chrome.sent("Fetch.continueRequest").length === 1);
  });

  it("whose resolution Chrome does not answer stay unacknowledged — the request may still be paused — and are reported", async () => {
    const { chrome, holder, operator } = await setUp();
    chrome.handlers.set("Fetch.failRequest", () => null);
    const { cdp, indeterminate, resolved } = operator();
    await cdp.connect();
    chrome.event("Fetch.requestPaused", { requestId: "interception-3", request: { url: "https://fansly.com/", method: "GET" }, resourceType: "Document" });
    await until(() => indeterminate.length === 1, 3000, "the unanswered resolution");
    expect(indeterminate).toEqual(["interception-3"]);
    expect(resolved).toEqual([["interception-3", "fail", "unanswered"]]);
    expect(holder.holder?.stats.stored).toBe(1);
  });

  it("whose resolution Chrome refuses (the pause is gone) are acknowledged", async () => {
    const { chrome, holder, operator } = await setUp();
    chrome.handlers.set("Fetch.failRequest", () => ({ error: { code: -32602, message: "Invalid InterceptionId." } }));
    const { cdp, indeterminate, resolved } = operator();
    await cdp.connect();
    chrome.event("Fetch.requestPaused", { requestId: "interception-4", request: { url: "https://fansly.com/", method: "GET" }, resourceType: "Document" });
    await until(() => resolved.length === 1 && holder.holder?.stats.stored === 0, 2000, "the acknowledgement");
    expect(indeterminate).toEqual([]);
    expect(resolved).toEqual([["interception-4", "fail", "refused"]]);
  });

  it("held by the path that owns them are resolved by it later — the response stage too — and acknowledged only then", async () => {
    const { chrome, holder, operator } = await setUp();
    const held: PausedRequest[] = [];
    const { cdp, paused, decided } = operator((request) => {
      held.push(request);
      return { action: "hold" };
    });
    await cdp.connect();
    chrome.event("Fetch.requestPaused", {
      requestId: "interception-9",
      networkId: "R9",
      request: { url: "https://apiv3.fansly.com.pb-hold.invalid/api/v1/account/me", urlFragment: "#hub-9", method: "GET", headers: { authorization: "t0ken-value", accept: "x" } },
      resourceType: "XHR",
    });
    await until(() => held.length === 1);
    expect(held[0]).toMatchObject({ stage: "request", urlFragment: "#hub-9", headers: { authorization: "t0ken-value", accept: "x" }, response: null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(chrome.sent("Fetch.continueRequest")).toEqual([]);
    expect(decided).toEqual([]);
    expect(holder.holder?.stats.stored).toBe(1);
    expect(await paused.resolve(held[0]!, { action: "continue", params: { url: "https://apiv3.fansly.com/api/v1/account/me", interceptResponse: true } })).toBe("answered");
    expect(chrome.sent("Fetch.continueRequest")[0]?.params).toEqual({ requestId: "interception-9", url: "https://apiv3.fansly.com/api/v1/account/me", interceptResponse: true });
    await until(() => holder.holder?.stats.stored === 0, 2000, "the acknowledgement");
    chrome.event("Fetch.requestPaused", {
      requestId: "interception-9",
      networkId: "R9",
      request: { url: "https://apiv3.fansly.com/api/v1/account/me", method: "GET", headers: {} },
      resourceType: "XHR",
      responseStatusCode: 302,
      responseStatusText: "Found",
      responseHeaders: [{ name: "Location", value: "/elsewhere" }, { name: "Vary", value: "a" }, { name: "Vary", value: "b" }],
    });
    await until(() => held.length === 2);
    expect(held[1]).toMatchObject({ stage: "response", response: { status: 302, statusText: "Found", errorReason: null, headers: [{ name: "Location", value: "/elsewhere" }, { name: "Vary", value: "a" }, { name: "Vary", value: "b" }] } });
    // A request's decision at the response stage is a fail; the response's own goes.
    expect(await paused.resolve(held[1]!, { action: "continueResponse" })).toBe("answered");
    expect(chrome.sent("Fetch.continueResponse")[0]?.params).toEqual({ requestId: "interception-9" });
    expect(await paused.resolve({ ...held[1]!, requestId: "interception-10" }, { action: "continue" })).toBe("answered");
    expect(chrome.sent("Fetch.failRequest").map((command) => command.params.requestId)).toEqual(["interception-10"]);
    expect(decided.map(([, action]) => action)).toEqual(["continue", "continueResponse", "fail"]);
  });

  it("at the response stage, unasked for, are failed", async () => {
    const { chrome, operator } = await setUp();
    const { cdp } = operator(() => ({ action: "continue" }));
    await cdp.connect();
    chrome.event("Fetch.requestPaused", { requestId: "interception-2", request: { url: "https://fansly.com/", method: "GET" }, responseStatusCode: 200, resourceType: "Document" });
    await until(() => chrome.sent("Fetch.failRequest").length === 1);
    expect(chrome.sent("Fetch.continueRequest")).toEqual([]);
  });
});

describe("commands", () => {
  it("resolve with Chrome's answer, reject with its error, and fail when unanswered", async () => {
    const { chrome, operator } = await setUp();
    const { cdp } = operator();
    await cdp.connect();
    chrome.handlers.set("Browser.getVersion", () => ({ product: "Chrome/155" }));
    chrome.handlers.set("Page.navigate", () => ({ error: { code: -32000, message: "nope" } }));
    chrome.handlers.set("Runtime.evaluate", () => null);
    expect(await cdp.send("Browser.getVersion")).toEqual({ product: "Chrome/155" });
    await expect(cdp.send("Page.navigate", { url: "x" })).rejects.toBeInstanceOf(CdpError);
    await expect(cdp.send("Runtime.evaluate", {}, undefined, 100)).rejects.toBeInstanceOf(CdpUnanswered);
    // CDP goes down: what waits is rejected, and nothing new is sent.
    const pending = cdp.send("Runtime.evaluate", {}, undefined, 5000);
    await chrome.shutdown();
    await expect(pending).rejects.toBeInstanceOf(CdpUnanswered);
    await expect(cdp.send("Browser.getVersion")).rejects.toThrow(/down/);
  });

  it("ignore an answer meant for a previous operator instance", async () => {
    const { chrome, holder, operator } = await setUp();
    chrome.handlers.set("Runtime.evaluate", () => null);
    const first = new Cdp({ socketPath: holder.socketPath, log: quiet });
    await first.connect();
    void first.send("Runtime.evaluate", {}, undefined, 5000).catch(() => undefined);
    await until(() => chrome.sent("Runtime.evaluate").length === 1);
    first.close();
    chrome.reply(chrome.sent("Runtime.evaluate")[0]!, { result: { value: "for the old one" } });
    await until(() => holder.holder?.stats.stored === 1);
    const { cdp } = operator();
    await cdp.connect();
    await cdp.replayEnded;
    await until(() => holder.holder?.stats.stored === 0, 2000, "the old answer acknowledged");
  });
});

describe("the control", () => {
  it("enables Fetch on the browser target, opens the work tab after it, sets it up and lets it run, and closes the first tab", async () => {
    const { chrome, operator } = await setUp();
    new BrowserModel(chrome);
    const { cdp } = operator();
    await cdp.connect();
    const failures: string[] = [];
    const control = new BrowserControl(cdp, { networkBuffer: { totalBytes: 100, perResponseBytes: 20 }, onSetupFailed: (target) => failures.push(target.type), log: quiet });
    control.geolocation = POSITION;
    const tab = await control.attach(3000);
    expect(tab).toMatchObject({ targetId: "T1", sessionId: "S1", type: "page" });
    const order = chrome.commands.map((command) => `${command.method}${command.sessionId ? `@${command.sessionId}` : ""}`);
    expect(order.indexOf("Fetch.enable")).toBe(0);
    expect(chrome.commands[0]?.params).toEqual({ patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    expect(order.indexOf("Fetch.enable")).toBeLessThan(order.indexOf("Target.createTarget"));
    expect(chrome.sent("Target.setAutoAttach")[0]?.params).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    // The site may read the page's position (nobody would answer a prompt):
    // granted before any target is attached, let alone let run.
    expect(chrome.sent("Browser.grantPermissions").map((command) => command.params)).toEqual([{ permissions: ["geolocation"], origin: "https://fansly.com" }]);
    expect(order.indexOf("Browser.grantPermissions")).toBeLessThan(order.indexOf("Target.setAutoAttach"));
    // The work tab: set up — its position included —, then let run.
    const tabCommands = order.filter((entry) => entry.endsWith("@S1"));
    expect(tabCommands).toEqual(["Network.enable@S1", "Page.enable@S1", "Emulation.setGeolocationOverride@S1", "Target.setAutoAttach@S1", "Runtime.runIfWaitingForDebugger@S1"]);
    expect(chrome.sent("Emulation.setGeolocationOverride").find((command) => command.sessionId === "S1")?.params).toEqual({ latitude: 48.137, longitude: 11.575, accuracy: 25 });
    expect(chrome.commands.find((command) => command.method === "Network.enable")?.params).toEqual({ maxTotalBufferSize: 100, maxResourceBufferSize: 20 });
    expect(chrome.commands.find((command) => command.method === "Target.setAutoAttach" && command.sessionId === "S1")?.params).toMatchObject({ filter: [{ type: "service_worker", exclude: true }, {}] });
    // The tab Chrome started with is not intercepted: closed.
    expect(chrome.sent("Target.closeTarget").map((command) => command.params.targetId)).toEqual(["T-initial"]);
    expect(failures).toEqual([]);
  });

  it("never lets a web target run whose setup failed", async () => {
    const { chrome, operator } = await setUp();
    new BrowserModel(chrome);
    chrome.handlers.set("Network.enable", (command) => (command.sessionId === "S1" ? { error: { code: -32000, message: "Network.enable failed" } } : {}));
    const { cdp } = operator();
    await cdp.connect();
    const failures: string[] = [];
    const control = new BrowserControl(cdp, { networkBuffer: { totalBytes: 100, perResponseBytes: 20 }, onSetupFailed: (target) => failures.push(target.type), log: quiet });
    control.geolocation = POSITION;
    await expect(control.attach(1000)).rejects.toThrow(/not set up/);
    expect(failures).toEqual(["page"]);
    expect(chrome.sent("Runtime.runIfWaitingForDebugger").filter((command) => command.sessionId === "S1")).toEqual([]);
  });

  it("attaches nothing without the page's position", async () => {
    const { chrome, operator } = await setUp();
    new BrowserModel(chrome);
    const { cdp } = operator();
    await cdp.connect();
    const control = new BrowserControl(cdp, { networkBuffer: { totalBytes: 100, perResponseBytes: 20 }, onSetupFailed: () => undefined, log: quiet });
    await expect(control.attach(1000)).rejects.toThrow(/no position/);
    // Not even the interception: no target is attached, none runs.
    expect(chrome.commands).toEqual([]);
  });

  it("never lets a tab run whose position could not be set", async () => {
    const { chrome, operator } = await setUp();
    new BrowserModel(chrome);
    chrome.handlers.set("Emulation.setGeolocationOverride", (command) => (command.sessionId === "S1" ? { error: { code: -32000, message: "no override" } } : {}));
    const { cdp } = operator();
    await cdp.connect();
    const failures: string[] = [];
    const control = new BrowserControl(cdp, { networkBuffer: { totalBytes: 100, perResponseBytes: 20 }, onSetupFailed: (target) => failures.push(target.type), log: quiet });
    control.geolocation = POSITION;
    await expect(control.attach(1000)).rejects.toThrow(/not set up/);
    expect(failures).toEqual(["page"]);
    expect(chrome.sent("Runtime.runIfWaitingForDebugger").filter((command) => command.sessionId === "S1")).toEqual([]);
  });

  it("sets the position in every tab, never through a frame (whose detach would clear the tab's); a worker, which has no geolocation, only runs", async () => {
    const { chrome, operator } = await setUp();
    new BrowserModel(chrome);
    const { cdp } = operator();
    await cdp.connect();
    const control = new BrowserControl(cdp, { networkBuffer: { totalBytes: 100, perResponseBytes: 20 }, onSetupFailed: () => undefined, log: quiet });
    control.geolocation = POSITION;
    await control.attach(3000);
    // A frame of another site and a worker of the work tab, both waiting.
    chrome.event("Target.attachedToTarget", { sessionId: "S-frame", targetInfo: { targetId: "T-frame", type: "iframe", url: "" }, waitingForDebugger: true }, "S1");
    chrome.event("Target.attachedToTarget", { sessionId: "S-worker", targetInfo: { targetId: "T-worker", type: "worker", url: "https://fansly.com/worker.js" }, waitingForDebugger: true }, "S1");
    await until(() => chrome.sent("Runtime.runIfWaitingForDebugger").filter((command) => command.sessionId === "S-frame" || command.sessionId === "S-worker").length === 2);
    const of = (session: string) => chrome.commands.filter((command) => command.sessionId === session).map((command) => command.method);
    expect(of("S-frame")).toEqual(["Network.enable", "Page.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
    expect(of("S1")).toContain("Emulation.setGeolocationOverride");
    expect(of("S-worker")).toEqual(["Network.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
  });
});
