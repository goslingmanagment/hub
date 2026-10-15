import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { encodeMessage, MessageReader } from "../apps/page-browser/src/shared/frames.ts";
import { Holder } from "../apps/page-browser/src/holder/holder.ts";
import { FakeChrome, quiet, tempDir, until } from "./helpers/page-browser-fakes.ts";

// The CDP holder (Project Browser plan §4.1; stage 3, PR 4): it numbers
// every Chrome message, keeps it until the operator acknowledges it, replays
// what is unacknowledged to a restarted operator, reads Chrome while the
// operator does not, and on overflow kills Chrome before it lets go of CDP.

interface Operator {
  socket: Socket;
  messages: Array<Record<string, unknown>>;
  send: (message: Record<string, unknown>) => void;
}

function connectOperator(path: string): Promise<Operator> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const reader = new MessageReader();
    const messages: Array<Record<string, unknown>> = [];
    socket.on("data", (chunk: Buffer) => reader.push(chunk, (json) => messages.push(JSON.parse(json) as Record<string, unknown>)));
    socket.once("connect", () => resolve({ socket, messages, send: (message) => socket.write(encodeMessage(JSON.stringify(message))) }));
    socket.once("error", reject);
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setUp(maxBytes = 128 * 1024 * 1024, options: { stopGraceMs?: number; failedKills?: number } = {}) {
  const temp = tempDir();
  cleanups.push(temp.remove);
  const chrome = new FakeChrome();
  await chrome.boot();
  cleanups.push(() => chrome.close());
  const exits: number[] = [];
  let kills = 0;
  const holder = new Holder({
    cdpHost: "127.0.0.1",
    cdpPort: chrome.port,
    socketPath: join(temp.dir, "holder.sock"),
    maxBytes,
    killChrome: async () => {
      kills += 1;
      if (kills <= (options.failedKills ?? 0)) throw new Error("s6-svc failed");
      await chrome.shutdown();
    },
    overflowGraceMs: options.failedKills ? 200 : 2000,
    ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
    pollMs: 20,
    onExit: (code) => exits.push(code),
    log: quiet,
  });
  await holder.start();
  cleanups.push(() => holder.close());
  await until(() => chrome.live !== undefined, 3000, "the holder's DevTools connection");
  return { chrome, holder, exits, socketPath: join(temp.dir, "holder.sock"), kills: () => kills };
}

const chromeMessages = (operator: Operator) => operator.messages.filter((message) => message.t === "m");

describe("the CDP holder", () => {
  it("numbers every Chrome message and keeps it until the operator acknowledges it", async () => {
    const { chrome, holder, socketPath } = await setUp();
    const operator = await connectOperator(socketPath);
    await until(() => operator.messages.some((message) => message.t === "hello"));
    expect(operator.messages[0]).toMatchObject({ t: "hello", cdp: "up", stored: 0, lastSeq: 0 });
    chrome.event("Target.attachedToTarget", { sessionId: "S1" });
    chrome.event("Fetch.requestPaused", { requestId: "interception-1" });
    await until(() => chromeMessages(operator).length === 2);
    expect(chromeMessages(operator).map((message) => [message.seq, (message.d as { method: string }).method])).toEqual([
      [1, "Target.attachedToTarget"],
      [2, "Fetch.requestPaused"],
    ]);
    expect(holder.stats).toMatchObject({ stored: 2, lastSeq: 2 });
    operator.send({ t: "ack", seqs: [1] });
    await until(() => holder.stats.stored === 1);
    operator.socket.destroy();
  });

  it("passes the operator's commands to Chrome unchanged", async () => {
    const { chrome, socketPath } = await setUp();
    const operator = await connectOperator(socketPath);
    operator.send({ t: "send", d: { id: 77, method: "Fetch.enable", params: { patterns: [{ urlPattern: "*", requestStage: "Request" }] } } });
    await until(() => chrome.commands.length === 1);
    expect(chrome.commands[0]).toEqual({ id: 77, method: "Fetch.enable", params: { patterns: [{ urlPattern: "*", requestStage: "Request" }] } });
    // Chrome's answer comes back numbered like any message.
    await until(() => chromeMessages(operator).length === 1);
    expect(chromeMessages(operator)[0]).toMatchObject({ seq: 1, d: { id: 77, result: {} } });
    operator.socket.destroy();
  });

  it("replays what is unacknowledged to a restarted operator, then marks the replay's end", async () => {
    const { chrome, holder, socketPath } = await setUp();
    const first = await connectOperator(socketPath);
    chrome.event("Fetch.requestPaused", { requestId: "interception-1" });
    chrome.event("Network.loadingFinished", { requestId: "R1" });
    chrome.event("Fetch.requestPaused", { requestId: "interception-2" });
    await until(() => chromeMessages(first).length === 3);
    first.send({ t: "ack", seqs: [2] });
    await until(() => holder.stats.stored === 2);
    // The operator dies; while it is gone Chrome keeps talking.
    first.socket.destroy();
    chrome.event("Fetch.requestPaused", { requestId: "interception-3" });
    await until(() => holder.stats.lastSeq === 4);
    const second = await connectOperator(socketPath);
    await until(() => second.messages.some((message) => message.t === "replay.end"));
    expect(second.messages[0]).toMatchObject({ t: "hello", cdp: "up", stored: 3, lastSeq: 4 });
    const replayed = second.messages.slice(1, second.messages.findIndex((message) => message.t === "replay.end"));
    expect(replayed.map((message) => message.seq)).toEqual([1, 3, 4]);
    expect(replayed.map((message) => (message.d as { params: { requestId: string } }).params.requestId)).toEqual(["interception-1", "interception-2", "interception-3"]);
    // Live messages follow the replay.
    chrome.event("Network.loadingFinished", { requestId: "R2" });
    await until(() => chromeMessages(second).some((message) => message.seq === 5));
    second.socket.destroy();
  });

  it("reads Chrome continuously while the operator reads nothing", async () => {
    const { chrome, holder, socketPath } = await setUp();
    const operator = await connectOperator(socketPath);
    operator.socket.pause();
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 200; i++) chrome.event("Network.dataReceived", { requestId: "R", data: big });
    await until(() => holder.stats.lastSeq === 200, 10_000, "200 messages read from Chrome");
    expect(holder.stats.storeBytes).toBeGreaterThan(200 * 64 * 1024);
    operator.socket.destroy();
  });

  it("kills Chrome on overflow and lets go of CDP only once Chrome is gone", async () => {
    const { chrome, holder, exits, socketPath, kills } = await setUp(256 * 1024);
    const operator = await connectOperator(socketPath);
    operator.socket.pause();
    const big = "y".repeat(64 * 1024);
    for (let i = 0; i < 8; i++) chrome.event("Network.dataReceived", { requestId: "R", data: big });
    await until(() => exits.length === 1, 5000, "the holder's exit");
    expect(exits).toEqual([3]);
    expect(kills()).toBe(1);
    expect(chrome.running).toBe(false);
    operator.socket.resume();
    await until(() => operator.messages.some((message) => message.t === "overflow"));
    expect(holder.stats.cdpUp).toBe(false);
  });

  it("tells the operator when Chrome's connection closes, and exits", async () => {
    const { chrome, exits, socketPath } = await setUp();
    const operator = await connectOperator(socketPath);
    await until(() => operator.messages.length > 0);
    await chrome.shutdown();
    await until(() => operator.messages.some((message) => message.t === "cdp.down"));
    await until(() => exits.length === 1);
    expect(exits).toEqual([2]);
  });

  it("on a planned stop asks the operator to close the exit before it lets go of CDP", async () => {
    const { holder, exits, socketPath } = await setUp();
    const operator = await connectOperator(socketPath);
    await until(() => operator.messages.length > 0);
    const stopped = holder.stop();
    await until(() => operator.messages.some((message) => message.t === "stopping"));
    expect(exits).toEqual([]);
    operator.send({ t: "exit.closed" });
    await stopped;
    await until(() => exits.length === 1);
    expect(exits).toEqual([0]);
  });

  it("on a planned stop the operator does not confirm in time: Chrome goes before CDP does", async () => {
    const { chrome, holder, exits, socketPath, kills } = await setUp(undefined, { stopGraceMs: 100 });
    const operator = await connectOperator(socketPath);
    await until(() => operator.messages.length > 0);
    await holder.stop();
    expect(operator.messages.some((message) => message.t === "stopping")).toBe(true);
    expect(kills()).toBe(1);
    expect(chrome.running).toBe(false);
    await until(() => exits.length === 1);
    expect(exits).toEqual([0]);
  });

  it("on a planned stop with no operator linked: Chrome goes before CDP does", async () => {
    const { chrome, holder, exits, kills } = await setUp(undefined, { stopGraceMs: 100 });
    await holder.stop();
    expect(kills()).toBe(1);
    expect(chrome.running).toBe(false);
    await until(() => exits.length === 1);
    expect(exits).toEqual([0]);
  });

  it("on overflow tries the kill again until Chrome is gone, and only then lets go of CDP", async () => {
    const { chrome, exits, socketPath, kills } = await setUp(256 * 1024, { failedKills: 2 });
    const operator = await connectOperator(socketPath);
    operator.socket.pause();
    const big = "y".repeat(64 * 1024);
    for (let i = 0; i < 8; i++) chrome.event("Network.dataReceived", { requestId: "R", data: big });
    await until(() => exits.length === 1, 5000, "the holder's exit");
    expect(kills()).toBe(3);
    expect(chrome.running).toBe(false);
    expect(exits).toEqual([3]);
  });

  it("ignores the stand's fault commands unless they are allowed", async () => {
    const { chrome, socketPath } = await setUp();
    const operator = await connectOperator(socketPath);
    operator.send({ t: "test.dropCdp" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(chrome.live?.closed).toBe(false);
    operator.socket.destroy();
  });
});
