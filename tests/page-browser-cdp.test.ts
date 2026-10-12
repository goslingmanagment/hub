import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Cdp, CdpError, CdpUnanswered } from "../apps/page-browser/src/cdp/client.ts";
import { BrowserControl } from "../apps/page-browser/src/cdp/control.ts";
import { PausedRequests, type PausedRequest } from "../apps/page-browser/src/cdp/paused.ts";
import { BrowserModel, FakeChrome, HolderUnderS6, quiet, tempDir, until } from "./helpers/page-browser-fakes.ts";

// The operator's CDP client through the holder (Project Browser plan §4.1,
// step 4; stage 3, PR 4): a paused request is acknowledged only once Chrome
// answered its resolution, a restarted operator learns about the requests
// still paused from the holder's replay and fails them, and the control's
// setup lets no web target run without it.

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
    const cdp = new Cdp({ socketPath: holder.socketPath, commandTimeoutMs: 2000, log: quiet });
    const decided: Array<[PausedRequest, string]> = [];
    const paused = new PausedRequests(cdp, { decide, onDecided: (request, decision) => decided.push([request, decision.action]), log: quiet });
    cleanups.push(() => cdp.close());
    return { cdp, paused, decided };
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
    const { cdp, decided } = operator();
    await cdp.connect();
    chrome.event("Fetch.requestPaused", { requestId: "interception-1", networkId: "R1", request: { url: "https://fansly.com/", method: "GET" }, resourceType: "Document" });
    await until(() => chrome.sent("Fetch.failRequest").length === 1);
    expect(chrome.sent("Fetch.failRequest")[0]?.params).toEqual({ requestId: "interception-1", errorReason: "BlockedByClient" });
    expect(decided[0]?.[0]).toMatchObject({ requestId: "interception-1", networkId: "R1", replayed: false, stage: "request", method: "GET" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(holder.holder?.stats.stored).toBe(1);
    answer!();
    await until(() => holder.holder?.stats.stored === 0, 2000, "the acknowledgement");
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
    const tab = await control.attach(3000);
    expect(tab).toMatchObject({ targetId: "T1", sessionId: "S1", type: "page" });
    const order = chrome.commands.map((command) => `${command.method}${command.sessionId ? `@${command.sessionId}` : ""}`);
    expect(order.indexOf("Fetch.enable")).toBe(0);
    expect(chrome.commands[0]?.params).toEqual({ patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    expect(order.indexOf("Fetch.enable")).toBeLessThan(order.indexOf("Target.createTarget"));
    expect(chrome.sent("Target.setAutoAttach")[0]?.params).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    // The work tab: set up, then let run.
    const tabCommands = order.filter((entry) => entry.endsWith("@S1"));
    expect(tabCommands).toEqual(["Network.enable@S1", "Page.enable@S1", "Target.setAutoAttach@S1", "Runtime.runIfWaitingForDebugger@S1"]);
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
    await expect(control.attach(1000)).rejects.toThrow(/not set up/);
    expect(failures).toEqual(["page"]);
    expect(chrome.sent("Runtime.runIfWaitingForDebugger").filter((command) => command.sessionId === "S1")).toEqual([]);
  });
});
