import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acceptPort,
  portTransport,
  type FrameWindowLike,
  type PortLike,
} from "../apps/workboard/src/screens/report/transport.ts";

// The board in the extension's frame (R-protocol.md): its requests go over a MessagePort, each answered by id. These
// pin the pairing, the extension's refusals and the waits, and the handshake that takes one port from the parent only.

type Listener = (event: { data: unknown }) => void;

function fakePort() {
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Set<Listener>();
  const port: PortLike = {
    postMessage: (message) => sent.push(message as Record<string, unknown>),
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const answer = (data: unknown) => listeners.forEach((listener) => listener({ data }));
  return { port, sent, answer };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the board's requests over the port", () => {
  it("pairs each answer with its request by id, whatever the order", async () => {
    const { port, sent, answer } = fakePort();
    const transport = portTransport(port);
    const first = transport.fetch("/api/v1/shift-reports/7", { method: "GET" });
    const second = transport.fetch("/api/v1/shift-reports/7/submit", { method: "POST", body: "{}" });
    expect(sent).toEqual([
      { t: "fetch", id: 1, method: "GET", path: "/api/v1/shift-reports/7", body: null },
      { t: "fetch", id: 2, method: "POST", path: "/api/v1/shift-reports/7/submit", body: "{}" },
    ]);
    answer({ t: "fetch:result", id: 2, status: 200, body: "{\"second\":true}" });
    answer({ t: "fetch:result", id: 1, status: 200, body: "{\"first\":true}" });
    expect(await (await first).json()).toEqual({ first: true });
    expect(await (await second).json()).toEqual({ second: true });
  });

  it("keeps the query and drops any origin: only the API path crosses", async () => {
    const { port, sent, answer } = fakePort();
    const transport = portTransport(port);
    const done = transport.fetch("https://elsewhere.example/api/v1/shift-reports/current?x=1");
    expect(sent[0]).toMatchObject({ path: "/api/v1/shift-reports/current?x=1", method: "GET" });
    answer({ t: "fetch:result", id: 1, status: 200, body: "{}" });
    await done;
  });

  it("never sends a path outside the API", async () => {
    const { port, sent } = fakePort();
    const transport = portTransport(port);
    await expect(transport.fetch("/workboard/report")).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it("reads the extension's refusal as Hub's 403 and a signed-out extension as a 401", async () => {
    const { port, answer } = fakePort();
    const transport = portTransport(port);
    const refused = transport.fetch("/api/v1/shift-reports/7/confirm", { method: "POST", body: "{}" });
    const signedOut = transport.fetch("/api/v1/shift-reports/7");
    answer({ t: "fetch:result", id: 1, error: "refused" });
    answer({ t: "fetch:result", id: 2, error: "signed_out" });
    expect((await refused).status).toBe(403);
    expect((await signedOut).status).toBe(401);
  });

  it("fails like a network error when the extension cannot reach Hub, or does not answer in time", async () => {
    vi.useFakeTimers();
    const { port, answer } = fakePort();
    const transport = portTransport(port, { timeoutMs: 1_000 });
    const network = transport.fetch("/api/v1/shift-reports/7");
    const silent = transport.fetch("/api/v1/shift-reports/8");
    answer({ t: "fetch:result", id: 1, error: "network" });
    await expect(network).rejects.toThrow(TypeError);
    const caught = expect(silent).rejects.toThrow("did not answer");
    vi.advanceTimersByTime(1_001);
    await caught;
    // A late answer to a request that gave up changes nothing.
    answer({ t: "fetch:result", id: 2, status: 200, body: "{}" });
  });

  it("passes the extension's other messages to the board and asks the clipboard through it", async () => {
    const { port, sent, answer } = fakePort();
    const transport = portTransport(port);
    const seen: unknown[] = [];
    transport.on((message) => seen.push(message));
    answer({ t: "show", transactionId: 42 });
    const copied = transport.copy("пост");
    expect(sent.at(-1)).toEqual({ t: "copy", text: "пост" });
    answer({ t: "copy:result", ok: true });
    expect(await copied).toBe(true);
    expect(seen[0]).toEqual({ t: "show", transactionId: 42 });
  });

  it("rejects what waits when it is closed", async () => {
    const { port } = fakePort();
    const transport = portTransport(port);
    const pending = transport.fetch("/api/v1/shift-reports/7");
    transport.close();
    await expect(pending).rejects.toThrow(TypeError);
  });
});

describe("the handshake", () => {
  type Handler = (event: MessageEvent) => void;
  function frameWindow() {
    const handlers = new Set<Handler>();
    const hellos: unknown[] = [];
    const parent = { postMessage: (message: unknown, target: string) => hellos.push({ message, target }) };
    const win: FrameWindowLike = {
      parent,
      addEventListener: (_type, handler) => handlers.add(handler),
      removeEventListener: (_type, handler) => handlers.delete(handler),
    };
    const deliver = (event: Partial<MessageEvent>) => handlers.forEach((handler) => handler(event as MessageEvent));
    return { win, parent, hellos, deliver, handlers };
  }
  const allowed = (origin: string) => origin === "https://fansly.com";
  const port = (name: string) => ({ name }) as unknown as MessagePort;

  it("says hello to the parent until it holds a port, and takes the first allowed one from the parent only", async () => {
    vi.useFakeTimers();
    const { win, parent, hellos, deliver, handlers } = frameWindow();
    const accepted = acceptPort(win, allowed, { everyMs: 500, times: 20, waitMs: 10_000 });
    expect(hellos).toEqual([{ message: { cg: "report-board/hello", v: 1 }, target: "*" }]);
    vi.advanceTimersByTime(1_000);
    expect(hellos).toHaveLength(3);
    const message = { cg: "report-board/port", v: 1 };
    deliver({ source: {} as MessageEventSource, origin: "https://fansly.com", data: message, ports: [port("not the parent")] });
    deliver({ source: parent as unknown as MessageEventSource, origin: "https://evil.example", data: message, ports: [port("bad origin")] });
    deliver({ source: parent as unknown as MessageEventSource, origin: "https://fansly.com", data: { cg: "report-board/port", v: 2 }, ports: [port("other version")] });
    deliver({ source: parent as unknown as MessageEventSource, origin: "https://fansly.com", data: message, ports: [port("the one")] });
    deliver({ source: parent as unknown as MessageEventSource, origin: "https://fansly.com", data: message, ports: [port("later")] });
    expect(await accepted).toEqual({ name: "the one" });
    expect(handlers.size).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(hellos).toHaveLength(3);
  });

  it("says at most 20 hellos and gives up after 10 seconds", async () => {
    vi.useFakeTimers();
    const { win, hellos } = frameWindow();
    const accepted = acceptPort(win, allowed);
    vi.advanceTimersByTime(10_001);
    expect(await accepted).toBeNull();
    expect(hellos).toHaveLength(20);
  });

  it("answers null at once outside a frame", async () => {
    const handlers = new Set<Handler>();
    const win = { addEventListener: (_type: "message", handler: Handler) => handlers.add(handler), removeEventListener: () => {} } as unknown as FrameWindowLike & { parent: unknown };
    (win as { parent: unknown }).parent = win;
    expect(await acceptPort(win, allowed)).toBeNull();
    expect(handlers.size).toBe(0);
  });
});
