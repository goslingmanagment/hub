import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GenerationStore } from "../apps/page-browser/src/rpc/generation.ts";
import type { CommandOutcome } from "../apps/page-browser/src/rpc/ledger.ts";
import { decodeBodyFrame, encodeBodyAbandon, encodeBodyFrame, parseEngineMessage, type BufferMessage, type Command, type Hello, type HubMessage, type State } from "../apps/page-browser/src/rpc/protocol.ts";
import { RpcServer, tokenMatches } from "../apps/page-browser/src/rpc/server.ts";
import { monoMs } from "../apps/page-browser/src/shared/util.ts";
import { FakeEngine, hello, quiet, RPC_TOKEN, tempDir, until } from "./helpers/page-browser-fakes.ts";

// The operator's RPC for the engine (Project Browser plan §4.13; spec §6):
// hello with the page's token first (constant time), the owner generation (a
// lower one refused, a higher one supersedes and gets `quiesced`), ping/pong
// with link loss after 5 s, commands executed once per id, and the buffer's
// messages (PR 11) handed to the operator.

const STATE: State = {
  type: "state",
  step: "exit_closed",
  stopReason: null,
  retryAtWall: null,
  exitOpen: false,
  mode: "automation",
  sessionFingerprint: null,
  accountId: null,
  exitIp: null,
  chromeVersion: "",
  operatorVersion: "test",
  buffer: { bytes: 0, oldestAgeMs: 0 },
  selfTest: null,
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setUp(options: { storePath?: string; execute?: (command: Command) => Promise<CommandOutcome> } = {}) {
  const hellos: Hello[] = [];
  const links: Array<[boolean, string]> = [];
  const executed: Command[] = [];
  const quiesced: number[] = [];
  const buffered: BufferMessage[] = [];
  const hubbed: HubMessage[] = [];
  const temp = tempDir();
  cleanups.push(temp.remove);
  const server = new RpcServer({
    token: RPC_TOKEN,
    generations: new GenerationStore(options.storePath ?? join(temp.dir, "owner-generation"), quiet),
    pingMs: 50,
    linkLossMs: 400,
    helloTimeoutMs: 1000,
    log: quiet,
    handlers: {
      onHello: (message) => {
        hellos.push(message);
        return { bufferId: "00000000-0000-4000-8000-000000000000", state: STATE };
      },
      quiesce: async (previous) => {
        quiesced.push(previous);
        return { lastSendMono: null, lastSendWall: null };
      },
      onCommand: async (command) => {
        executed.push(command);
        return options.execute ? options.execute(command) : { ok: true, detail: command.command.kind };
      },
      onBuffer: (message) => buffered.push(message),
      onHub: (message) => hubbed.push(message),
      onLink: (up, reason) => links.push([up, reason]),
    },
  });
  const port = await server.listen(0, "127.0.0.1");
  cleanups.push(() => server.close());
  const engines: FakeEngine[] = [];
  const engine = async (generation = 1) => {
    const fake = new FakeEngine();
    fake.generation = generation;
    await fake.connect(port);
    engines.push(fake);
    cleanups.push(() => fake.close());
    return fake;
  };
  return { server, port, hellos, links, executed, quiesced, buffered, hubbed, engine, storeDir: temp.dir };
}

const command = (generation: number, commandId: string, kind: string, notAfterMono = monoMs() + 10_000) => ({ type: "command", ownerGeneration: generation, commandId, notAfterMono, command: { kind } });

describe("hello", () => {
  it("accepts the page's token and answers the version, the buffer id and the state", async () => {
    const { engine, hellos, links, server } = await setUp();
    const fake = await engine();
    fake.send(hello());
    const result = await fake.waitFor("helloResult");
    expect(result).toMatchObject({ ok: true, protocol: { major: 1, minor: 0 }, bufferId: "00000000-0000-4000-8000-000000000000", state: { type: "state", step: "exit_closed" } });
    expect(hellos).toHaveLength(1);
    expect(hellos[0]?.socks5.password).toBe("S0cks-Pa55-9c1e2d");
    expect(links).toEqual([[true, "hello"]]);
    expect(server.linkUp).toBe(true);
    expect(server.generation).toBe(1);
  });

  it("refuses a wrong token first, before anything else of the message is looked at", async () => {
    const { engine, hellos } = await setUp();
    const fake = await engine();
    // Malformed otherwise too: the answer is about the token only.
    fake.send({ type: "hello", token: "not-the-token", protocol: "garbage" });
    const result = await fake.waitFor("helloResult");
    expect(result).toEqual({ type: "helloResult", ok: false, reason: "token", supportedMajors: [1] });
    await until(() => fake.closed !== null);
    expect(hellos).toEqual([]);
  });

  it("compares the token in constant time, whatever its length", () => {
    expect(tokenMatches(RPC_TOKEN, RPC_TOKEN)).toBe(true);
    expect(tokenMatches(`${RPC_TOKEN}x`, RPC_TOKEN)).toBe(false);
    expect(tokenMatches("", RPC_TOKEN)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });

  it("refuses an engine without a common major", async () => {
    const { engine } = await setUp();
    const fake = await engine();
    fake.send(hello({ protocol: { majors: [2, 3], minor: 0 } }));
    expect(await fake.waitFor("helloResult")).toEqual({ type: "helloResult", ok: false, reason: "protocol_major", supportedMajors: [1] });
  });

  it("closes the connection when the first message is not hello, or hello is malformed", async () => {
    const { engine } = await setUp();
    const first = await engine();
    first.send({ type: "ping", n: 1, ownerGeneration: 1 });
    await until(() => first.closed !== null);
    const second = await engine();
    second.send(hello({ pinnedExitIp: "not an ip" }));
    await until(() => second.closed !== null);
    expect(second.of("helloResult")).toEqual([]);
  });
});

describe("the owner generation", () => {
  it("refuses a lower one, and remembers the highest across a restart", async () => {
    const first = await setUp();
    const engine5 = await first.engine(5);
    engine5.send(hello({ ownerGeneration: 5 }));
    await engine5.waitFor("helloResult");
    const engine4 = await first.engine(4);
    engine4.send(hello({ ownerGeneration: 4 }));
    expect(await engine4.waitFor("helloResult")).toMatchObject({ ok: false, reason: "generation_stale" });
    // A restarted operator reads the generation from the buffer volume.
    const second = await setUp({ storePath: join(first.storeDir, "owner-generation") });
    const late = await second.engine(4);
    late.send(hello({ ownerGeneration: 4 }));
    expect(await late.waitFor("helloResult")).toMatchObject({ ok: false, reason: "generation_stale" });
  });

  it("counts within one page: a profile moved to another page takes that page's generations", async () => {
    const first = await setUp();
    const engine9 = await first.engine(9);
    engine9.send(hello({ ownerGeneration: 9 }));
    await engine9.waitFor("helloResult");
    // The volume goes to page 8 with the profile; its engine is at 2.
    const second = await setUp({ storePath: join(first.storeDir, "owner-generation") });
    const other = await second.engine(2);
    other.send(hello({ pageId: 8, ownerGeneration: 2 }));
    expect(await other.waitFor("helloResult")).toMatchObject({ ok: true });
    // And from then on page 8's own rule holds, across a restart too —
    // and page 7's floor is still there: going 7 → 8 → 7 does not reset it.
    const third = await setUp({ storePath: join(first.storeDir, "owner-generation") });
    const stale = await third.engine(1);
    stale.send(hello({ pageId: 8, ownerGeneration: 1 }));
    expect(await stale.waitFor("helloResult")).toMatchObject({ ok: false, reason: "generation_stale" });
    const back = await third.engine(1);
    back.send(hello({ pageId: 7, ownerGeneration: 1 }));
    expect(await back.waitFor("helloResult")).toMatchObject({ ok: false, reason: "generation_stale" });
  });

  it("lets a higher one supersede the current connection, and tells it the previous one is quiesced", async () => {
    const { engine, quiesced, executed } = await setUp();
    const old = await engine(1);
    old.send(hello());
    await old.waitFor("helloResult");
    const fresh = await engine(2);
    fresh.send(hello({ ownerGeneration: 2 }));
    await fresh.waitFor("helloResult", (message) => message.ok === true);
    expect(await fresh.waitFor("quiesced")).toEqual({ type: "quiesced", previousGeneration: 1, lastSendMono: null, lastSendWall: null });
    expect(quiesced).toEqual([0, 1]);
    await until(() => old.closed !== null);
    // The superseded engine's commands go nowhere.
    old.send(command(1, "c-old", "closeExit"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(executed).toEqual([]);
  });

  it("lets the same owner reconnect without a quiesced", async () => {
    const { engine, quiesced } = await setUp();
    const first = await engine(3);
    first.send(hello({ ownerGeneration: 3 }));
    await first.waitFor("helloResult");
    const again = await engine(3);
    again.send(hello({ ownerGeneration: 3 }));
    await again.waitFor("helloResult");
    await until(() => first.closed !== null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(quiesced).toEqual([0]);
    expect(again.of("quiesced")).toEqual([]);
  });

  it("refuses a command of a lower generation and closes on a higher one without hello", async () => {
    const { engine, executed } = await setUp();
    const fake = await engine(2);
    fake.send(hello({ ownerGeneration: 2 }));
    await fake.waitFor("helloResult");
    fake.send(command(1, "c1", "closeExit"));
    expect(await fake.waitFor("commandResult")).toEqual({ type: "commandResult", commandId: "c1", ok: false, detail: "generation_stale" });
    expect(executed).toEqual([]);
    fake.send(command(3, "c2", "closeExit"));
    await until(() => fake.closed !== null);
    expect(executed).toEqual([]);
  });
});

describe("ping and the link", () => {
  it("answers the engine's ping, pings it, and loses the link after 5 s (here 400 ms) without a word", async () => {
    const { engine, links, server } = await setUp();
    const fake = await engine();
    fake.send(hello());
    await fake.waitFor("helloResult");
    fake.send({ type: "ping", n: 41, ownerGeneration: 1 });
    expect(await fake.waitFor("pong")).toEqual({ type: "pong", n: 41 });
    await fake.waitFor("ping");
    // The engine keeps answering: the link holds past the loss time.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(server.linkUp).toBe(true);
    // The engine falls silent.
    fake.answerPings = false;
    await until(() => !server.linkUp, 2000, "the link loss");
    await until(() => links.length === 2 && fake.closed !== null);
    expect(links[1]?.[0]).toBe(false);
    expect(links[1]?.[1]).toMatch(/nothing from the engine/);
  });
});

describe("commands", () => {
  it("are executed once per id; a repeat gets the first one's result", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { engine, executed } = await setUp({
      execute: async () => {
        await gate;
        return { ok: true, detail: "done once" };
      },
    });
    const fake = await engine();
    fake.send(hello());
    await fake.waitFor("helloResult");
    fake.send(command(1, "c-1", "restartBrowser"));
    fake.send(command(1, "c-1", "restartBrowser"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await until(() => fake.of("commandResult").length === 2);
    expect(executed).toHaveLength(1);
    expect(fake.of("commandResult")).toEqual([
      { type: "commandResult", commandId: "c-1", ok: true, detail: "done once" },
      { type: "commandResult", commandId: "c-1", ok: true, detail: "done once" },
    ]);
    // Also across a reconnect of the same engine.
    const again = await engine();
    again.send(hello());
    await again.waitFor("helloResult");
    again.send(command(1, "c-1", "restartBrowser"));
    await again.waitFor("commandResult");
    expect(executed).toHaveLength(1);
  });

  it("past notAfterMono are not executed", async () => {
    const { engine, executed } = await setUp();
    const fake = await engine();
    fake.send(hello());
    await fake.waitFor("helloResult");
    fake.send(command(1, "c-late", "openExit", monoMs() - 1));
    expect(await fake.waitFor("commandResult")).toEqual({ type: "commandResult", commandId: "c-late", ok: false, detail: "expired" });
    expect(executed).toEqual([]);
  });

  it("of an unknown type, or a site admission that is not the protocol's, close the connection as a protocol error", async () => {
    const { engine } = await setUp();
    const fake = await engine();
    fake.send(hello());
    await fake.waitFor("helloResult");
    // A site request's id is a UUID (spec §6.1).
    fake.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: "s", admit: false, reason: "paused" });
    await until(() => fake.closed !== null);
    const other = await engine();
    other.send(hello());
    await other.waitFor("helloResult");
    other.send({ type: "teleport", ownerGeneration: 1 });
    await until(() => other.closed !== null);
  });
});

describe("the buffer's messages (PR 11)", () => {
  it("go to the operator, of this connection's generation only, and count as the engine heard", async () => {
    const { engine, buffered } = await setUp();
    const fake = await engine(2);
    fake.send(hello({ ownerGeneration: 2 }));
    await fake.waitFor("helloResult");
    const bufferId = "00000000-0000-4000-8000-000000000000";
    fake.send({ type: "events.subscribe", ownerGeneration: 2, bufferId, afterSeq: 0 });
    fake.send({ type: "ack", ownerGeneration: 2, bufferId, uptoSeq: 0 });
    fake.send({ type: "resultAck", ownerGeneration: 2, attemptId: 5 });
    fake.send({ type: "recover", ownerGeneration: 2, attemptIds: [5, 6] });
    // An older owner's ack is dropped: it acknowledges nothing.
    fake.send({ type: "ack", ownerGeneration: 1, bufferId, uptoSeq: 9 });
    fake.send({ type: "ping", n: 1, ownerGeneration: 2 });
    await fake.waitFor("pong");
    expect(buffered).toEqual([
      { type: "events.subscribe", ownerGeneration: 2, bufferId, afterSeq: 0 },
      { type: "ack", ownerGeneration: 2, bufferId, uptoSeq: 0 },
      { type: "resultAck", ownerGeneration: 2, attemptId: 5 },
      { type: "recover", ownerGeneration: 2, attemptIds: [5, 6] },
    ]);
    expect(fake.closed).toBeNull();
  });

  it("malformed close the connection as a protocol error", async () => {
    const { engine, buffered } = await setUp();
    const fake = await engine();
    fake.send(hello());
    await fake.waitFor("helloResult");
    fake.send({ type: "ack", ownerGeneration: 1, bufferId: "b", uptoSeq: -1 });
    await until(() => fake.closed !== null);
    expect(buffered).toEqual([]);
  });

  it("an event batch goes out as the buffer stored it, to the connected engine only", async () => {
    const { engine, server } = await setUp();
    expect(server.sendRaw('{"type":"events","bufferId":"b","events":[]}')).toBe(false);
    const fake = await engine();
    fake.send(hello());
    await fake.waitFor("helloResult");
    expect(server.sendRaw('{"type":"events","bufferId":"b","events":[{"seq":1,"atMono":1.5,"atWall":2,"kind":"ws.in","connectionId":"c","frame":"x"}]}')).toBe(true);
    expect(await fake.waitFor("events")).toEqual({ type: "events", bufferId: "b", events: [{ seq: 1, atMono: 1.5, atWall: 2, kind: "ws.in", connectionId: "c", frame: "x" }] });
  });
});

describe("the protocol's messages", () => {
  it("parses the commands this operator knows, and only them", () => {
    expect(parseEngineMessage(JSON.stringify(command(1, "c", "stopPage")))).toMatchObject({ ok: true, message: { command: { kind: "stopPage" } } });
    expect(parseEngineMessage(JSON.stringify({ ...command(1, "c", "setMode"), command: { kind: "setMode", mode: "manual_login" } }))).toMatchObject({ ok: true });
    expect(parseEngineMessage(JSON.stringify(command(1, "c", "launchMissiles")))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify(command(1, "", "stopPage")))).toMatchObject({ ok: false });
    expect(parseEngineMessage("{")).toEqual({ ok: false, error: "not JSON" });
    // The engine's answer to a site request (PR 14): strict, by the spec's refusals.
    const siteRequestId = "0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(parseEngineMessage(JSON.stringify({ type: "siteAdmitResult", ownerGeneration: 2, siteRequestId, admit: true, deadlineMono: 5.5, attemptId: 3 })))
      .toEqual({ ok: true, message: { type: "siteAdmitResult", ownerGeneration: 2, siteRequestId, admit: true, deadlineMono: 5.5, attemptId: 3 } });
    expect(parseEngineMessage(JSON.stringify({ type: "siteAdmitResult", ownerGeneration: 2, siteRequestId, admit: false, reason: "wait_expired" }))).toMatchObject({ ok: true });
    expect(parseEngineMessage(JSON.stringify({ type: "siteAdmitResult", ownerGeneration: 2, siteRequestId, admit: false, reason: "because" }))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify({ type: "siteAdmitResult", ownerGeneration: 2, siteRequestId: "s", admit: false, reason: "paused" }))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify({ type: "siteAdmitResult" }))).toMatchObject({ ok: false });
  });

  it("parses a socket's admission strictly (PR 10)", () => {
    const connectionId = "0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(parseEngineMessage(JSON.stringify({ type: "wsAdmitResult", ownerGeneration: 2, connectionId, admit: true, deadlineMono: 1234.5, attemptId: 77 }))).toEqual({
      ok: true,
      message: { type: "wsAdmitResult", ownerGeneration: 2, connectionId, admit: true, deadlineMono: 1234.5, attemptId: 77 },
    });
    expect(parseEngineMessage(JSON.stringify({ type: "wsAdmitResult", ownerGeneration: 2, connectionId, admit: false, reason: "pace", retryNotBeforeWall: null }))).toEqual({
      ok: true,
      message: { type: "wsAdmitResult", ownerGeneration: 2, connectionId, admit: false, reason: "pace", retryNotBeforeWall: null },
    });
    expect(parseEngineMessage(JSON.stringify({ type: "wsAdmitResult", ownerGeneration: 2, connectionId, admit: false, reason: "route_hold", retryNotBeforeWall: 1_791_800_000_000 }))).toMatchObject({ ok: true });
    // An admission without its attempt or deadline, a refusal without its
    // retry, an id that is not a UUID: protocol errors.
    expect(parseEngineMessage(JSON.stringify({ type: "wsAdmitResult", ownerGeneration: 2, connectionId, admit: true, deadlineMono: 1 }))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify({ type: "wsAdmitResult", ownerGeneration: 2, connectionId, admit: true, attemptId: 77 }))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify({ type: "wsAdmitResult", ownerGeneration: 2, connectionId, admit: false, reason: "pace" }))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify({ type: "wsAdmitResult", ownerGeneration: 2, connectionId: "conn-1", admit: false, reason: "pace", retryNotBeforeWall: null }))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify({ type: "wsAdmitResult", ownerGeneration: 2, connectionId, admit: "yes" }))).toMatchObject({ ok: false });
  });

  it("parses the buffer's messages strictly", () => {
    expect(parseEngineMessage(JSON.stringify({ type: "events.subscribe", ownerGeneration: 1, bufferId: "b", afterSeq: 12 }))).toEqual({ ok: true, message: { type: "events.subscribe", ownerGeneration: 1, bufferId: "b", afterSeq: 12 } });
    expect(parseEngineMessage(JSON.stringify({ type: "ack", ownerGeneration: 1, bufferId: "b", uptoSeq: 1.5 }))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify({ type: "ack", ownerGeneration: 1, uptoSeq: 1 }))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify({ type: "events.subscribe", ownerGeneration: 1, bufferId: "x".repeat(65), afterSeq: 0 }))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify({ type: "resultAck", ownerGeneration: 1, attemptId: "7" }))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify({ type: "recover", ownerGeneration: 1, attemptIds: [1, 2] }))).toMatchObject({ ok: true });
    expect(parseEngineMessage(JSON.stringify({ type: "recover", ownerGeneration: 1, attemptIds: Array.from({ length: 10_001 }, (_, n) => n) }))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify({ type: "recover", attemptIds: [] }))).toMatchObject({ ok: false });
  });
});

describe("a Hub request's messages (PR 9)", () => {
  const send = (overrides: Record<string, unknown> = {}) => ({
    type: "send",
    ownerGeneration: 2,
    attemptId: 41,
    route: "account.me",
    credentialsGeneration: "a".repeat(64),
    sessionFingerprint: "b".repeat(64),
    method: "GET",
    url: "https://apiv3.fansly.com/api/v1/account/me",
    headers: { "x-route": "1" },
    kind: "api",
    maxBodyBytes: 1024,
    sendDeadlineMono: 1000.5,
    requestDeadlineMono: 2000,
    ...overrides,
  });

  it("go to the operator — a send of an earlier owner too, to be refused there; a check's answer of the connection's owner only", async () => {
    const { engine, hubbed } = await setUp();
    const fake = await engine(2);
    fake.send(hello({ ownerGeneration: 2 }));
    await fake.waitFor("helloResult");
    fake.send(send());
    fake.send(send({ ownerGeneration: 1, attemptId: 42 }));
    fake.send({ type: "checkResult", ownerGeneration: 2, attemptId: 41, admit: true, deadlineMono: 1500.25 });
    fake.send({ type: "checkResult", ownerGeneration: 1, attemptId: 42, admit: false, reason: "pace" });
    fake.send({ type: "ping", n: 1, ownerGeneration: 2 });
    await fake.waitFor("pong");
    expect(hubbed).toEqual([
      send(),
      send({ ownerGeneration: 1, attemptId: 42 }),
      { type: "checkResult", ownerGeneration: 2, attemptId: 41, admit: true, deadlineMono: 1500.25 },
    ]);
    expect(fake.closed).toBeNull();
  });

  it("are parsed strictly: a malformed one is a protocol error", () => {
    expect(parseEngineMessage(JSON.stringify(send()))).toEqual({ ok: true, message: send() });
    expect(parseEngineMessage(JSON.stringify({ type: "checkResult", ownerGeneration: 1, attemptId: 3, admit: false, reason: "session_mismatch" }))).toMatchObject({ ok: true });
    for (const bad of [
      send({ method: "POST" }),
      send({ kind: "document" }),
      send({ attemptId: 0 }),
      send({ sessionFingerprint: "B".repeat(64) }),
      send({ credentialsGeneration: "short" }),
      send({ headers: { "bad name": "x" } }),
      send({ headers: { ok: "line\r\nbreak" } }),
      send({ headers: Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`h${n}`, "x"])) }),
      send({ route: "" }),
      send({ maxBodyBytes: -1 }),
      send({ sendDeadlineMono: "soon" }),
      { type: "checkResult", ownerGeneration: 1, attemptId: 3, admit: true },
      { type: "checkResult", ownerGeneration: 1, attemptId: 3, admit: false, reason: "because" },
      { type: "checkResult", ownerGeneration: 1, attemptId: 3, admit: "yes", deadlineMono: 1 },
    ]) {
      expect(parseEngineMessage(JSON.stringify(bad)), JSON.stringify(bad).slice(0, 80)).toMatchObject({ ok: false });
    }
  });

  it("bodies go as binary frames: 16 bytes of id, 4 of part, 1 of last, then the data", async () => {
    const id = "0123abcd-4567-4890-8abc-def012345678";
    const frame = encodeBodyFrame(id, 3, true, Buffer.from("tail"));
    expect(frame.subarray(0, 16).toString("hex")).toBe(id.replaceAll("-", ""));
    expect(frame.readUInt32BE(16)).toBe(3);
    expect(frame[20]).toBe(1);
    expect(decodeBodyFrame(frame)).toEqual({ bodyId: id, part: 3, last: true, abandoned: false, data: Buffer.from("tail") });
    // A body whose transmission failed after 2 parts: void, no data.
    const abandon = encodeBodyAbandon(id, 2);
    expect(abandon.length).toBe(21);
    expect(decodeBodyFrame(abandon)).toEqual({ bodyId: id, part: 2, last: false, abandoned: true, data: Buffer.alloc(0) });
    expect(() => encodeBodyFrame("not-a-uuid", 0, false, Buffer.alloc(0))).toThrow();
    expect(() => encodeBodyFrame(id, 0, false, Buffer.alloc(1024 * 1024 + 1))).toThrow();
    const { engine, server } = await setUp();
    expect(server.sendBinary(frame)).toBe(false);
    const fake = await engine();
    fake.send(hello());
    await fake.waitFor("helloResult");
    expect(server.sendBinary(frame)).toBe(true);
    await until(() => fake.frames.length === 1);
    expect(fake.frames[0]!.equals(frame)).toBe(true);
  });
});
