import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { encodeBodyAbandon, encodeBodyFrame, type EventsRefused, type Result } from "../apps/page-browser/src/rpc/protocol.ts";
import { acceptWebSocket } from "../apps/page-browser/src/shared/ws.ts";
import {
  linkSettingsDigest,
  MAX_PENDING_BODIES,
  PageBrowserLinkError,
  PageBrowserRpcClient,
  systemMonoBridge,
  type DeliveredEvents,
  type DeliveredResult,
  type LinkStatus,
  type PageBrowserRpcTiming,
} from "../apps/runtime/src/services/egress/page-browser-rpc.ts";
import { FakeOperator, linkSettings, OPERATOR_TOKEN, SESSION_A, sendBody } from "./helpers/page-browser-operator.ts";
import { until } from "./helpers/page-browser-fakes.ts";

// The engine's RPC client to a page's operator (Project Browser plan §4.13;
// spec §6; stage 3 PR 12), against the operator's own RPC server: hello with
// the token and the owner generation, ping/pong and link loss, reconnects, a
// newer generation superseding an older one, the routing of a Hub request's
// check (refused by default), sent and result, bodies reassembled from their
// frames (part 0 restarting a body, the abandon frame, a body asked for
// again), recover, resultAck, state, alarm and quiesced.

const TIMING: Partial<PageBrowserRpcTiming> = { pingMs: 100, linkLossMs: 700, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 400 };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function operator(options: Parameters<typeof FakeOperator.start>[0] = {}): Promise<FakeOperator> {
  const fake = await FakeOperator.start(options);
  cleanups.push(() => fake.close());
  return fake;
}

function client(url: string, generation = 1n, overrides: Partial<ConstructorParameters<typeof PageBrowserRpcClient>[0]> = {}): PageBrowserRpcClient {
  const made = new PageBrowserRpcClient({ url, ownerGeneration: generation, settings: async () => linkSettings(), timing: TIMING, ...overrides });
  cleanups.push(() => made.close());
  return made;
}

async function up(made: PageBrowserRpcClient): Promise<void> {
  made.start();
  await until(() => made.up, 5_000, "the link");
}

function bodyRef(body: Buffer, bodyId = randomUUID()) {
  return { bodyId, decodedBytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
}

function response(attemptId: number, body: Buffer, bodyId = randomUUID()): Result {
  return {
    type: "result",
    attemptId,
    sessionFingerprint: SESSION_A,
    outcome: { kind: "response", status: 200, headers: { "content-type": "application/json" }, body: bodyRef(body, bodyId), encodedBytes: body.length, source: "network", sentMono: 1_000, sendMark: "transport_reported" },
  };
}

function recordResults(made: PageBrowserRpcClient, attemptId: number): DeliveredResult[] {
  const results: DeliveredResult[] = [];
  made.register(attemptId, { onCheck: () => ({ admit: false, reason: "lease_inactive" }), onSent: () => undefined, onResult: (delivered) => results.push(delivered) });
  return results;
}

describe("the link", () => {
  it("says hello with the page's token, the owner generation and the settings, and takes the operator's state", async () => {
    const fake = await operator();
    const made = client(fake.url, 3n);
    await up(made);
    expect(fake.hellos).toHaveLength(1);
    const hello = fake.hellos[0]!;
    expect(hello).toMatchObject({ ownerGeneration: 3, token: OPERATOR_TOKEN, pageId: 7, expectedAccountId: "300000000000000001", protocol: { majors: [1], minor: 3 } });
    expect(hello.socks5).toEqual({ ip: "127.0.0.1", port: 1080, username: "pb-user", password: "pb-pass" });
    expect(made.status).toMatchObject({ kind: "up", bufferId: "00000000-0000-4000-8000-000000000001", protocol: { major: 1, minor: 3 } });
    expect(made.state).toMatchObject({ step: "exit_open", sessionFingerprint: SESSION_A });
    expect(made.helloDigest).toBe(linkSettingsDigest(linkSettings()));
    expect(fake.server.generation).toBe(3);
  });

  it.each([1, 2, 3])("sends credentials distinctly to minor %i, with a held fallback only for legacy operators", async (minor) => {
    const answers: Array<Record<string, unknown>> = [];
    const server = createServer();
    server.on("upgrade", (req, socket, head) => {
      const ws = acceptWebSocket(req, socket, head, 1024 * 1024);
      if (!ws) return;
      cleanups.push(() => ws.close(1000));
      ws.onText = (payload) => {
        const message = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
        if (message.type === "hello") ws.sendText(JSON.stringify({ type: "helloResult", ok: true, protocol: { major: 1, minor }, bufferId: "b", state: new FakeOperatorState().state }));
        else if (message.type === "ping") ws.sendText(JSON.stringify({ type: "pong", n: message.n }));
        else if (message.type === "siteAdmitResult" || message.type === "wsAdmitResult") answers.push(message);
      };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const port = (server.address() as { port: number }).port;
    const made = client(`ws://127.0.0.1:${port}/rpc`);
    await up(made);
    expect(made.answerSiteAdmit(made.epoch + 1, { siteRequestId: "stale", admit: false, reason: "credentials" })).toBe(false);
    expect(made.answerSiteAdmit(made.epoch, { siteRequestId: "http", admit: false, reason: "credentials" })).toBe(true);
    expect(made.answerWsAdmit(made.epoch, { connectionId: "ws", admit: false, reason: "credentials", retryNotBeforeWall: null })).toBe(true);
    await until(() => answers.length === 2, 3_000, "both refusal messages");
    expect(answers.map((answer) => answer.reason)).toEqual([minor < 3 ? "held" : "credentials", minor < 3 ? "held" : "credentials"]);
  });

  it("pings the operator and answers its pings: the link stays up on both sides", async () => {
    const fake = await operator({ pingMs: 100, linkLossMs: 600 });
    const made = client(fake.url);
    await up(made);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(made.up).toBe(true);
    expect(fake.server.linkUp).toBe(true);
    expect(fake.hellos).toHaveLength(1);
  });

  it("an operator that goes silent is a lost link: the client says hello again on a new connection", async () => {
    // A server that answers the hello, then never says anything again.
    const hellos: unknown[] = [];
    const server: Server = createServer();
    server.on("upgrade", (req, socket, head) => {
      const ws = acceptWebSocket(req, socket, head, 1024 * 1024);
      if (!ws) return;
      ws.onText = (payload) => {
        const message = JSON.parse(payload.toString("utf8")) as { type: string };
        if (message.type !== "hello") return;
        hellos.push(message);
        ws.sendText(JSON.stringify({ type: "helloResult", ok: true, protocol: { major: 1, minor: 1 }, bufferId: "b", state: new FakeOperatorState().state }));
      };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const port = (server.address() as { port: number }).port;
    const made = client(`ws://127.0.0.1:${port}/rpc`);
    const statuses: LinkStatus["kind"][] = [];
    made.onLink((status) => statuses.push(status.kind));
    await up(made);
    await until(() => hellos.length >= 2, 5_000, "a second hello");
    expect(statuses).toContain("down");
  });

  it("an operator of protocol minor 0 (no halt held on its volume) is refused at its hello: no work goes through it, the hello is tried again after the refusal's wait (Astra PR 17 round 4)", async () => {
    const hellos: unknown[] = [];
    const server: Server = createServer();
    server.on("upgrade", (req, socket, head) => {
      const ws = acceptWebSocket(req, socket, head, 1024 * 1024);
      if (!ws) return;
      ws.onText = (payload) => {
        const message = JSON.parse(payload.toString("utf8")) as { type: string };
        if (message.type !== "hello") return;
        hellos.push(message);
        ws.sendText(JSON.stringify({ type: "helloResult", ok: true, protocol: { major: 1, minor: 0 }, bufferId: "b", state: new FakeOperatorState().state }));
      };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const port = (server.address() as { port: number }).port;
    const made = client(`ws://127.0.0.1:${port}/rpc`);
    const statuses: LinkStatus[] = [];
    made.onLink((status) => statuses.push(status));
    made.start();
    await until(() => statuses.some((status) => status.kind === "refused"), 5_000, "the refusal");
    expect(statuses.find((status) => status.kind === "refused")).toMatchObject({ reason: "protocol_minor" });
    expect(made.up).toBe(false);
    expect(made.state).toBeNull();
    expect(hellos).toHaveLength(1);
  });

  it("an operator that drops the connection: the client connects and says hello again", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    fake.server.protocolError("a test drops the engine");
    await until(() => fake.hellos.length === 2 && made.up, 5_000, "the second hello");
  });

  it("a newer owner supersedes: the older client's next hello is refused and it stops for good", async () => {
    const fake = await operator();
    const older = client(fake.url, 1n);
    await up(older);
    const newer = client(fake.url, 2n);
    await up(newer);
    await until(() => older.status.kind === "superseded", 5_000, "the older client superseded");
    const hellosThen = fake.hellos.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fake.hellos.length).toBe(hellosThen);
    expect(older.up).toBe(false);
    expect(newer.up).toBe(true);
    // The newer owner hears that the older one's work is over (plan §4.7).
    await until(() => newer.quiesced !== null, 5_000, "quiesced");
    expect(newer.quiesced).toMatchObject({ previousGeneration: 1 });
    expect(fake.server.generation).toBe(2);
  });

  it("a refused token keeps the link down and is tried again only after its wait", async () => {
    const fake = await operator({ token: "another-token" });
    const made = client(fake.url);
    made.start();
    await until(() => made.status.kind === "refused", 5_000, "the refusal");
    expect(made.status).toMatchObject({ kind: "refused", reason: "token", supportedMajors: [1] });
    expect(made.up).toBe(false);
    expect(fake.hellos).toEqual([]);
  });

  it("a page's settings that changed: reconnect says hello again with the new ones", async () => {
    const fake = await operator();
    let port = 1080;
    const made = client(fake.url, 1n, { settings: async () => linkSettings({ socks5: { ip: "127.0.0.1", port, username: "pb-user", password: "pb-pass" } }) });
    await up(made);
    port = 1081;
    expect(await made.settingsDigestNow()).not.toBe(made.helloDigest);
    made.reconnect("a test changed the proxy");
    await until(() => fake.hellos.length === 2 && made.up, 5_000, "the new hello");
    expect(fake.hellos[1]!.socks5.port).toBe(1081);
    expect(await made.settingsDigestNow()).toBe(made.helloDigest);
  });

  it("state and alarm messages reach their listeners", async () => {
    const fake = await operator();
    const made = client(fake.url);
    const states: string[] = [];
    const alarms: string[] = [];
    made.onState((state) => states.push(state.step));
    made.onAlarm((alarm) => alarms.push(alarm.kind));
    await up(made);
    fake.pushState({ step: "ready" });
    fake.server.send({ type: "alarm", atWall: Date.now(), kind: "header_mismatch", detail: { path: "/api/v1/account/me" } });
    await until(() => states.includes("ready") && alarms.length === 1, 5_000, "the state and the alarm");
    expect(made.state?.step).toBe("ready");
    expect(alarms).toEqual(["header_mismatch"]);
  });
});

describe("a Hub request", () => {
  it("a check of an attempt nothing waits for is refused: nothing is admitted by default", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    fake.server.send({ type: "check", attemptId: 41, pausedMono: 1, liveSessionFingerprint: SESSION_A });
    await until(() => fake.checkResults.length === 1, 5_000, "the answer");
    expect(fake.checkResults[0]).toEqual({ type: "checkResult", ownerGeneration: 1, attemptId: 41, admit: false, reason: "lease_inactive" });
  });

  it("a check goes to its attempt's handler, answered with the admission's absolute deadline; sent and result follow", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    const sents: number[] = [];
    const results: DeliveredResult[] = [];
    made.register(42, {
      onCheck: (check) => {
        expect(check.liveSessionFingerprint).toBe(SESSION_A);
        return { admit: true, deadlineMono: 123_456.5 };
      },
      onSent: (sent) => sents.push(sent.sentMono),
      onResult: (delivered) => results.push(delivered),
    });
    fake.server.send({ type: "check", attemptId: 42, pausedMono: 1, liveSessionFingerprint: SESSION_A });
    await until(() => fake.checkResults.length === 1, 5_000, "the answer");
    expect(fake.checkResults[0]).toEqual({ type: "checkResult", ownerGeneration: 1, attemptId: 42, admit: true, deadlineMono: 123_456.5 });
    fake.server.send({ type: "sent", attemptId: 42, sentMono: 999, sentWall: Date.now(), connectionReused: true });
    const body = Buffer.from('{"success":true,"response":[]}');
    const result = response(42, body);
    sendBody(fake.server, result.outcome.kind === "response" ? result.outcome.body.bodyId : "", body);
    fake.server.send(result);
    await until(() => results.length === 1, 5_000, "the result");
    expect(sents).toEqual([999]);
    expect(results[0]!.bodyProblem).toBeNull();
    expect(results[0]!.body?.equals(body)).toBe(true);
  });

  it("an answer that takes time is written when it settles — never on a connection the check did not come on", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    let release: (reply: { admit: true; deadlineMono: number }) => void = () => undefined;
    made.register(48, { onCheck: () => new Promise((resolve) => (release = resolve)), onSent: () => undefined, onResult: () => undefined });
    fake.server.send({ type: "check", attemptId: 48, pausedMono: 1, liveSessionFingerprint: SESSION_A });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.checkResults).toEqual([]);
    release({ admit: true, deadlineMono: 777 });
    await until(() => fake.checkResults.length === 1, 5_000, "the answer");
    expect(fake.checkResults[0]).toMatchObject({ attemptId: 48, admit: true, deadlineMono: 777 });

    // The same, but the link changes before the answer: it is not written.
    made.register(49, { onCheck: () => new Promise((resolve) => (release = resolve)), onSent: () => undefined, onResult: () => undefined });
    fake.server.send({ type: "check", attemptId: 49, pausedMono: 1, liveSessionFingerprint: SESSION_A });
    await new Promise((resolve) => setTimeout(resolve, 100));
    fake.server.protocolError("a test drops the engine");
    await until(() => fake.hellos.length === 2 && made.up, 5_000, "the new connection");
    release({ admit: true, deadlineMono: 778 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.checkResults.filter((result) => result.attemptId === 49)).toEqual([]);
  });

  it("a handler may write its answer at once, inside its own critical section — once only, and never on another connection (PR 16)", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    let finishSection: () => void = () => undefined;
    made.register(50, {
      onCheck: async (_check, answerNow) => {
        // Written now, while the handler's section is still open …
        expect(answerNow({ admit: true, deadlineMono: 901 })).toBe(true);
        expect(answerNow({ admit: false, reason: "lease_used" })).toBe(false);
        await new Promise<void>((resolve) => (finishSection = resolve));
        // … and the settled answer is not written again.
        return { admit: false, reason: "lease_inactive" };
      },
      onSent: () => undefined,
      onResult: () => undefined,
    });
    fake.server.send({ type: "check", attemptId: 50, pausedMono: 1, liveSessionFingerprint: SESSION_A });
    await until(() => fake.checkResults.length === 1, 5_000, "the answer written inside the section");
    expect(fake.checkResults[0]).toMatchObject({ attemptId: 50, admit: true, deadlineMono: 901 });
    finishSection();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.checkResults.filter((result) => result.attemptId === 50)).toHaveLength(1);
    // The link changes inside the section: nothing is written.
    let answer: (reply: { admit: true; deadlineMono: number }) => boolean = () => false;
    made.register(51, { onCheck: (_check, answerNow) => new Promise(() => (answer = answerNow)), onSent: () => undefined, onResult: () => undefined });
    fake.server.send({ type: "check", attemptId: 51, pausedMono: 1, liveSessionFingerprint: SESSION_A });
    await new Promise((resolve) => setTimeout(resolve, 100));
    fake.server.protocolError("a test drops the engine");
    await until(() => fake.hellos.length === 2 && made.up, 5_000, "the new connection");
    expect(answer({ admit: true, deadlineMono: 902 })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.checkResults.filter((result) => result.attemptId === 51)).toEqual([]);
  });

  it("a body of several parts is reassembled before its JSON; an empty body is one last frame", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    const results = recordResults(made, 43);
    const big = Buffer.alloc(2 * 1024 * 1024 + 4321, 7);
    big.write("start", 0);
    const first = response(43, big);
    sendBody(fake.server, first.outcome.kind === "response" ? first.outcome.body.bodyId : "", big);
    fake.server.send(first);
    await until(() => results.length === 1, 5_000, "the big result");
    expect(results[0]!.body?.equals(big)).toBe(true);
    const results44 = recordResults(made, 44);
    const empty = response(44, Buffer.alloc(0));
    sendBody(fake.server, empty.outcome.kind === "response" ? empty.outcome.body.bodyId : "", Buffer.alloc(0));
    fake.server.send(empty);
    await until(() => results44.length === 1, 5_000, "the empty result");
    expect(results44[0]!.body?.length).toBe(0);
    expect(results44[0]!.bodyProblem).toBeNull();
  });

  it("part 0 starts a body anew; the abandon frame voids the parts before it", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    const results = recordResults(made, 45);
    const bodyId = randomUUID();
    const good = Buffer.from("the whole body, sent again");
    // A first delivery torn by a read failure: its parts are void.
    fake.server.sendBinary(encodeBodyFrame(bodyId, 0, false, Buffer.from("stale part 0")));
    fake.server.sendBinary(encodeBodyFrame(bodyId, 1, false, Buffer.from("stale part 1")));
    fake.server.sendBinary(encodeBodyAbandon(bodyId, 2));
    // A delivery that starts over without an abandon: part 0 restarts it.
    fake.server.sendBinary(encodeBodyFrame(bodyId, 0, false, Buffer.from("restarted")));
    fake.server.sendBinary(encodeBodyFrame(bodyId, 0, true, good));
    fake.server.send(response(45, good, bodyId));
    await until(() => results.length === 1, 5_000, "the result");
    expect(results[0]!.bodyProblem).toBeNull();
    expect(results[0]!.body?.toString()).toBe("the whole body, sent again");
    expect(made.up).toBe(true);
  });

  it("a result whose body did not arrive whole is asked for again (recover), and the resent one is handed over", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    const results = recordResults(made, 46);
    const body = Buffer.from('{"success":true,"response":{"n":1}}');
    const result = response(46, body);
    // The operator holds the outcome whole; this delivery lost its body.
    fake.held.set(46, { result: result as never, body });
    fake.server.send(result);
    await until(() => results.length === 1, 5_000, "the result asked for again");
    expect(fake.recovers).toEqual([[46]]);
    expect(results[0]!.bodyProblem).toBeNull();
    expect(results[0]!.body?.equals(body)).toBe(true);
  });

  it("a body that does not verify is told as such when asking again does not help", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    const results = recordResults(made, 47);
    const body = Buffer.from("the body");
    const result = response(47, body);
    if (result.outcome.kind === "response") result.outcome.body.sha256 = "0".repeat(64);
    fake.held.set(47, { result: result as never, body });
    sendBody(fake.server, result.outcome.kind === "response" ? result.outcome.body.bodyId : "", body);
    fake.server.send(result);
    await until(() => results.length === 1, 5_000, "the result");
    expect(fake.recovers).toEqual([[47]]);
    expect(results[0]!.body).toBeNull();
    expect(results[0]!.bodyProblem).toContain("sha256");
  });

  it("a part out of order breaks the protocol: the connection closes and the client says hello again", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    fake.server.sendBinary(encodeBodyFrame(randomUUID(), 3, true, Buffer.from("x")));
    await until(() => fake.hellos.length === 2 && made.up, 5_000, "the new connection");
  });

  it("more bodies in the air than a delivery has breaks the protocol", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    for (let i = 0; i <= MAX_PENDING_BODIES; i++) fake.server.sendBinary(encodeBodyFrame(randomUUID(), 0, false, Buffer.from("x")));
    await until(() => fake.hellos.length === 2 && made.up, 5_000, "the new connection");
  });

  it("recover: the outcomes the operator holds are resent on the way, then the state of each", async () => {
    const fake = await operator();
    fake.recoverState = (attemptId) => (attemptId === 52 ? "not_sent" : "unknown");
    const made = client(fake.url);
    await up(made);
    const body = Buffer.from("kept");
    fake.held.set(51, { result: response(51, body) as never, body });
    const answer = await made.recover([51, 52, 53]);
    expect(Object.fromEntries(answer.states)).toEqual({ 51: "outcome_resent", 52: "not_sent", 53: "unknown" });
    expect(answer.results.get(51)?.body?.equals(body)).toBe(true);
    expect(answer.results.has(52)).toBe(false);
  });

  it("a recover whose link goes before its answer is rejected", async () => {
    const fake = await operator();
    const made = client(fake.url);
    await up(made);
    const recovering = made.recover([60]);
    // The operator's answer would come after the hello; the link goes first.
    fake.server.protocolError("a test drops the engine");
    await expect(recovering).rejects.toBeInstanceOf(PageBrowserLinkError);
  });

  it("resultAck reaches the operator with the generation", async () => {
    const fake = await operator();
    const made = client(fake.url, 4n);
    await up(made);
    fake.held.set(70, { result: response(70, Buffer.from("x")) as never, body: Buffer.from("x") });
    expect(made.resultAck(70)).toBe(true);
    await until(() => fake.acks.includes(70), 5_000, "the ack");
    expect(fake.held.has(70)).toBe(false);
  });

  it("outcomes the operator holds come again to every new connection; a result no attempt waits for is left unacknowledged", async () => {
    const fake = await operator();
    const body = Buffer.from("replayed");
    fake.held.set(80, { result: response(80, body) as never, body });
    const made = client(fake.url);
    const unclaimed: number[] = [];
    made.onUnclaimedResult((delivered) => unclaimed.push(delivered.result.attemptId));
    await up(made);
    await until(() => unclaimed.length === 1, 5_000, "the replayed outcome");
    fake.server.protocolError("a test drops the engine");
    await until(() => unclaimed.length === 2, 5_000, "the outcome replayed again");
    expect(fake.acks).toEqual([]);
  });
});

// The event stream (PR 13): the operator's own EventStream behind the fake.
describe("the event stream", () => {
  it("subscribes with the buffer id and the last number, takes batches with their site responses' bodies, and acks", async () => {
    const fake = await operator();
    const made = client(fake.url);
    const batches: DeliveredEvents[] = [];
    made.onEvents((delivered) => batches.push(delivered));
    await up(made);
    fake.append({ kind: "gap", fromSeq: null, fromWall: null, reason: "operator_start" });
    const site = fake.siteResponse({ route: "site.other", path: "/api/v1/versioning", body: "{\"success\":true}" });
    expect(made.subscribe(fake.buffer.id, 0)).toBe(true);
    await until(() => batches.flatMap((batch) => batch.events).length === 2, 5_000, "the events");
    const events = batches.flatMap((batch) => batch.events);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    const delivered = batches.find((batch) => batch.events.some((event) => event.seq === site.seq))!;
    expect(delivered.bufferId).toBe(fake.buffer.id);
    expect(delivered.epoch).toBe(made.epoch);
    const ref = (site as Extract<typeof site, { kind: "site.response" }>).body;
    expect(delivered.bodies.get(ref.bodyId)).toEqual({ body: Buffer.from("{\"success\":true}"), problem: null });
    expect(made.ack(fake.buffer.id, 2)).toBe(true);
    await until(() => fake.buffer.acknowledged === 2, 5_000, "the ack");
    expect(fake.buffer.kept).toEqual([]);
  });

  it("a body broken on the way is handed over with its problem, never as a body", async () => {
    const fake = await operator();
    const made = client(fake.url);
    const batches: DeliveredEvents[] = [];
    made.onEvents((delivered) => batches.push(delivered));
    await up(made);
    fake.corruptNextBody = true;
    const site = fake.siteResponse({ route: "site.other", path: "/api/v1/x", body: "{}" }) as Extract<ReturnType<FakeOperator["append"]>, { kind: "site.response" }>;
    made.subscribe(fake.buffer.id, 0);
    await until(() => batches.length === 1, 5_000, "the batch");
    expect(batches[0]!.bodies.get(site.body.bodyId)).toMatchObject({ body: null, problem: expect.stringMatching(/bytes|sha256/) });
  });

  it("the operator refuses another buffer's subscription and ack, naming its own", async () => {
    const fake = await operator();
    const made = client(fake.url);
    const refusals: EventsRefused[] = [];
    made.onEventsRefused((refused) => refusals.push(refused));
    await up(made);
    const old = randomUUID();
    made.subscribe(old, 5);
    await until(() => refusals.length === 1, 5_000, "the refusal");
    expect(refusals[0]).toMatchObject({ of: "events.subscribe", reason: "foreign_buffer", bufferId: fake.buffer.id, givenBufferId: old, givenSeq: 5 });
    made.subscribe(fake.buffer.id, 0);
    made.ack(old, 3);
    await until(() => refusals.length === 2, 5_000, "the ack's refusal");
    expect(refusals[1]).toMatchObject({ of: "ack", reason: "foreign_buffer", bufferId: fake.buffer.id, givenBufferId: old });
  });

  it("recover collects the site path's ends resent on the way; an end nobody claims goes to the unclaimed listener", async () => {
    const fake = await operator();
    const made = client(fake.url);
    const unclaimed: number[] = [];
    made.onUnclaimedOutcome((end) => unclaimed.push(end.attemptId));
    fake.holdEnd({ type: "siteDone", siteRequestId: randomUUID(), attemptId: 91, sent: true, sentMono: 1_000, sentWall: Date.now(), connectionReused: false, status: 429, retryAfter: "30", error: null, body: "not_platform_data" });
    fake.holdEnd({ type: "wsDone", connectionId: randomUUID(), attemptId: 92, sent: false, sentMono: null, status: null, error: null, fate: "unknown" });
    await up(made);
    // Delivered to the new connection: nobody waits for them.
    await until(() => unclaimed.length === 2, 5_000, "the ends delivered");
    const answer = await made.recover([91, 92, 93]);
    expect(Object.fromEntries(answer.states)).toEqual({ 91: "outcome_resent", 92: "outcome_resent", 93: "unknown" });
    expect(answer.ends.get(91)).toMatchObject({ type: "siteDone", status: 429, retryAfter: "30" });
    expect(answer.ends.get(92)).toMatchObject({ type: "wsDone", fate: "unknown" });
  });
});

describe("the clock bridge", () => {
  it("converts the engine's clock to CLOCK_MONOTONIC and back by one shift", () => {
    const bridge = systemMonoBridge();
    const engine = performance.now();
    const kernel = Number(process.hrtime.bigint()) / 1e6;
    expect(Math.abs(bridge.toKernel(engine) - kernel)).toBeLessThan(5);
    expect(bridge.fromKernel(bridge.toKernel(engine))).toBeCloseTo(engine, 6);
  });
});

/** The operator's state as the fake operator starts with it. */
class FakeOperatorState {
  readonly state = {
    type: "state",
    step: "exit_open",
    stopReason: null,
    retryAtWall: null,
    exitOpen: true,
    mode: "automation",
    sessionFingerprint: SESSION_A,
    accountId: null,
    exitIp: null,
    chromeVersion: "155",
    operatorVersion: "test",
    buffer: { bytes: 0, oldestAgeMs: 0 },
    selfTest: null,
  };
}
