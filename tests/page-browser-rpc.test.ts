import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GenerationStore } from "../apps/page-browser/src/rpc/generation.ts";
import type { CommandOutcome } from "../apps/page-browser/src/rpc/ledger.ts";
import { parseEngineMessage, type Command, type Hello, type State } from "../apps/page-browser/src/rpc/protocol.ts";
import { RpcServer, tokenMatches } from "../apps/page-browser/src/rpc/server.ts";
import { monoMs } from "../apps/page-browser/src/shared/util.ts";
import { FakeEngine, hello, quiet, RPC_TOKEN, tempDir, until } from "./helpers/page-browser-fakes.ts";

// The operator's RPC for the engine (Project Browser plan §4.13; spec §6):
// hello with the page's token first (constant time), the owner generation (a
// lower one refused, a higher one supersedes and gets `quiesced`), ping/pong
// with link loss after 5 s, and commands executed once per id.

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
  return { server, port, hellos, links, executed, quiesced, engine, storeDir: temp.dir };
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

  it("of a later PR's message type close the connection as a protocol error", async () => {
    const { engine } = await setUp();
    const fake = await engine();
    fake.send(hello());
    await fake.waitFor("helloResult");
    fake.send({ type: "send", ownerGeneration: 1, attemptId: 1 });
    await until(() => fake.closed !== null);
  });
});

describe("the protocol's messages", () => {
  it("parses the commands this operator knows, and only them", () => {
    expect(parseEngineMessage(JSON.stringify(command(1, "c", "stopPage")))).toMatchObject({ ok: true, message: { command: { kind: "stopPage" } } });
    expect(parseEngineMessage(JSON.stringify({ ...command(1, "c", "setMode"), command: { kind: "setMode", mode: "manual_login" } }))).toMatchObject({ ok: true });
    expect(parseEngineMessage(JSON.stringify(command(1, "c", "launchMissiles")))).toMatchObject({ ok: false });
    expect(parseEngineMessage(JSON.stringify(command(1, "", "stopPage")))).toMatchObject({ ok: false });
    expect(parseEngineMessage("{")).toEqual({ ok: false, error: "not JSON" });
    expect(parseEngineMessage(JSON.stringify({ type: "wsAdmitResult" }))).toEqual({ ok: false, error: "wsAdmitResult is not supported by this operator yet" });
  });
});
