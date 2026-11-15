import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acceptPort,
  portTransport,
  takeFrameKey,
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

describe("the handshake (version 2)", () => {
  type Handler = (event: MessageEvent) => void;
  const KEY = "0123456789abcdef0123456789abcdef";
  function frameWindow(hash = `#k=${KEY}&v=2`) {
    const handlers = new Set<Handler>();
    const told: unknown[] = [];
    const parent = { postMessage: (message: unknown) => told.push(message) };
    const replaced: string[] = [];
    const win: FrameWindowLike = {
      parent,
      location: { hash, pathname: "/workboard/frame/report", search: "?shift=7" },
      history: { replaceState: (_data, _unused, url) => replaced.push(url ?? "") },
      addEventListener: (_type, handler) => handlers.add(handler),
      removeEventListener: (_type, handler) => handlers.delete(handler),
    };
    const deliver = (event: Partial<MessageEvent>) => handlers.forEach((handler) => handler(event as MessageEvent));
    return { win, parent, told, replaced, deliver, handlers };
  }
  function port(name: string) {
    const said: unknown[] = [];
    return { name, said, postMessage: (message: unknown) => said.push(message) } as unknown as MessagePort & { said: unknown[]; name: string };
  }

  it("reads the key once from its own address and removes it", () => {
    const { win, replaced } = frameWindow();
    expect(takeFrameKey(win)).toEqual({ key: KEY, v: 2 });
    expect(replaced).toEqual(["/workboard/frame/report?shift=7"]);
    expect(takeFrameKey(frameWindow("").win)).toBeNull();
    expect(takeFrameKey(frameWindow("#v=2").win)).toBeNull();
  });

  it("takes the first port from the parent with its key, answers ready on it, and says nothing to the parent", async () => {
    vi.useFakeTimers();
    const { win, parent, told, deliver, handlers } = frameWindow();
    const accepted = acceptPort(win, takeFrameKey(win));
    vi.advanceTimersByTime(3_000);
    const wrongSource = port("not the parent");
    const wrongKey = port("a page script's guess");
    const right = port("the one");
    const later = port("later");
    const message = (key: string) => ({ cg: "report-board/port", v: 2, key });
    deliver({ source: {} as MessageEventSource, data: message(KEY), ports: [wrongSource] });
    deliver({ source: parent as unknown as MessageEventSource, data: message("ffffffffffffffffffffffffffffffff"), ports: [wrongKey] });
    deliver({ source: parent as unknown as MessageEventSource, data: { cg: "report-board/port", v: 2 }, ports: [port("no key")] });
    deliver({ source: parent as unknown as MessageEventSource, data: message(KEY), ports: [right] });
    deliver({ source: parent as unknown as MessageEventSource, data: message(KEY), ports: [later] });
    const result = await accepted;
    expect(result.kind).toBe("port");
    expect(result.kind === "port" && (result.port as unknown as { name: string }).name).toBe("the one");
    expect(right.said).toEqual([{ t: "ready", v: 2 }]);
    expect(wrongKey.said).toEqual([]);
    expect(later.said).toEqual([]);
    expect(told).toEqual([]);
    expect(handlers.size).toBe(0);
  });

  it("knows an extension of another version by the right key, or by its own address", async () => {
    const { win, parent, deliver } = frameWindow();
    const accepted = acceptPort(win, takeFrameKey(win));
    const old = port("old extension");
    deliver({ source: parent as unknown as MessageEventSource, data: { cg: "report-board/port", v: 1, key: KEY }, ports: [old] });
    expect(await accepted).toEqual({ kind: "version", port: old });
    const newer = frameWindow(`#k=${KEY}&v=3`);
    expect(await acceptPort(newer.win, takeFrameKey(newer.win))).toEqual({ kind: "version", port: null });
  });

  it("gives up after 10 seconds, at once without a key or outside a frame", async () => {
    vi.useFakeTimers();
    const { win } = frameWindow();
    const accepted = acceptPort(win, takeFrameKey(win));
    vi.advanceTimersByTime(10_001);
    expect(await accepted).toEqual({ kind: "none" });
    const keyless = frameWindow("");
    expect(await acceptPort(keyless.win, takeFrameKey(keyless.win))).toEqual({ kind: "none" });
    const top = frameWindow();
    (top.win as { parent: unknown }).parent = top.win;
    expect(await acceptPort(top.win, takeFrameKey(top.win))).toEqual({ kind: "none" });
  });
});
