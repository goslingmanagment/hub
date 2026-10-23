import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GenerationStore } from "../apps/page-browser/src/rpc/generation.ts";
import type { CommandOutcome } from "../apps/page-browser/src/rpc/ledger.ts";
import { type BufferMessage, type Command, type Hello, type HubMessage, type State } from "../apps/page-browser/src/rpc/protocol.ts";
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

async function setUp(options: { storePath?: string; execute?: (command: Command) => Promise<CommandOutcome>; quiesceGate?: Promise<void> } = {}) {
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
        if (options.quiesceGate !== undefined) await options.quiesceGate;
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
    expect(result).toMatchObject({ ok: true, protocol: { major: 1, minor: 8 }, bufferId: "00000000-0000-4000-8000-000000000000", state: { type: "state", step: "exit_closed" } });
    expect(hellos).toHaveLength(1);
    expect(hellos[0]?.socks5.password).toBe("S0cks-Pa55-9c1e2d");
    expect(links).toEqual([[true, "hello"]]);
    expect(server.linkUp).toBe(true);
    expect(server.generation).toBe(1);
  });

  it("says it takes writes (minor 8) only to an engine that knows them: an older Hub is answered as before", async () => {
    const { engine } = await setUp();
    const older = await engine(1);
    older.send(hello({ protocol: { majors: [1], minor: 7 } }));
    expect(await older.waitFor("helloResult")).not.toHaveProperty("writes");
    const newer = await engine(2);
    newer.send(hello({ ownerGeneration: 2, protocol: { majors: [1], minor: 8 } }));
    expect(await newer.waitFor("helloResult")).toMatchObject({ ok: true, protocol: { minor: 8 }, writes: { fingerprint: "fansly-write.v1" } });
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
});
