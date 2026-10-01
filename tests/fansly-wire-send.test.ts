import { getEventListeners } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildFanslyWireRequest,
  createOneShotSendCheck,
  FANSLY_WIRE_MAX_BODY_BYTES,
  FanslyAdapter,
  FanslySendRefusedError,
  sendFanslyWireRequest,
  type FanslySendCheck,
} from "@agency_hub_core/fansly";
import { createProxyRequestDispatcher } from "@agency_hub_core/shared";

import { createTestFanslySendGuard } from "./helpers/fansly-send-guard.ts";
import { startFakeFanslyNetwork, type FakeFanslyNetwork } from "./helpers/fansly-send-guard-network.ts";

// The engine's wire send on the real transport: the production proxy
// dispatcher (`createProxyRequestDispatcher`, undici ProxyAgent), a real HTTP
// CONNECT proxy and a fake Fansly origin on loopback. One call is one physical
// request — [A1]: `Dispatcher.request` reaches the send check at
// `onRequestStart`, follows no redirect and has no hidden 421 re-send, so the
// origin sees exactly one request whatever it answers.

type Dispatcher = ReturnType<typeof createProxyRequestDispatcher>;

let network: FakeFanslyNetwork | null = null;
let dispatcher: Dispatcher | null = null;
const extraServers: Array<{ close(callback: () => void): void }> = [];

afterEach(async () => {
  await dispatcher?.close();
  await network?.close();
  await Promise.all(extraServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  dispatcher = null;
  network = null;
});

async function open(options: Parameters<typeof startFakeFanslyNetwork>[0] = {}) {
  network = await startFakeFanslyNetwork(options);
  dispatcher = createProxyRequestDispatcher({ url: network.proxyUrl });
  return { network, dispatcher };
}

function accountMe(baseUrl: string, timeoutMs = 2_000) {
  return buildFanslyWireRequest("account.me", {}, {
    baseUrl,
    session: { authorization: "synthetic" },
    timeoutMs,
  });
}

/** A check that lets the request go and records when undici asked. */
function recordingCheck(verdict: () => FanslySendRefusedError | null = () => null) {
  const calls: number[] = [];
  const check: FanslySendCheck = () => {
    calls.push(performance.now());
    return verdict();
  };
  return { calls, hooks: { check } };
}

const live = () => new AbortController().signal;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("[A1] one admission is one physical request", () => {
  it("asks the check once, after the tunnel and before the origin sees the request", async () => {
    const { network, dispatcher } = await open({ tunnelDelayMs: () => 200 });
    const { calls, hooks } = recordingCheck();
    const signal = live();
    const startedAt = performance.now();
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl), hooks, signal);

    expect(outcome).toMatchObject({ kind: "response", status: 200, sendMark: "request_start" });
    expect(network.arrivals.map((arrival) => arrival.path)).toEqual(["/account/me?ngsw-bypass=true"]);
    // The caller's long-lived signal keeps no listener of a settled request.
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(network.tunnels).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toBeGreaterThanOrEqual(startedAt + 190);
    expect(calls[0]!).toBeLessThanOrEqual(network.arrivals[0]!.monotonicMs);
    if (outcome.kind !== "response") throw new Error("unreachable");
    expect(JSON.parse(outcome.bodyText)).toMatchObject({ success: true, response: { account: { id: "acct-guard" } } });
    expect(outcome.bodyBytes).toBe(Buffer.byteLength(outcome.bodyText));
  });

  it("answers a 302 itself: no hop, one origin hit", async () => {
    const { network, dispatcher } = await open({
      respond: (_request, response) => {
        response.writeHead(302, { location: "/account/elsewhere" });
        response.end();
      },
    });
    const { calls, hooks } = recordingCheck();
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl), hooks, live());

    expect(outcome).toMatchObject({ kind: "response", status: 302, headers: { location: "/account/elsewhere" } });
    await sleep(100);
    expect(network.arrivals.map((arrival) => arrival.path.split("?")[0])).toEqual(["/account/me"]);
    expect(calls).toHaveLength(1);
  });

  it("answers a 421 itself: no hidden re-send on a new connection", async () => {
    const { network, dispatcher } = await open({
      respond: (_request, response) => {
        response.writeHead(421);
        response.end("misdirected");
      },
    });
    const { calls, hooks } = recordingCheck();
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl), hooks, live());

    expect(outcome).toMatchObject({ kind: "response", status: 421, bodyText: "misdirected" });
    await sleep(100);
    expect(network.arrivals).toHaveLength(1);
    expect(network.tunnels).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("writes nothing for a refused admission", async () => {
    const { network, dispatcher } = await open({ tunnelDelayMs: () => 50 });
    const { calls, hooks } = recordingCheck(() => new FanslySendRefusedError("pace"));
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl), hooks, live());

    expect(outcome).toEqual({ kind: "aborted_before_send", refusal: "pace" });
    await sleep(100);
    expect(calls).toHaveLength(1);
    // The tunnel came up (the check runs only once the transport is ready),
    // and still no request reached the origin.
    expect(network.tunnels).toBe(1);
    expect(network.arrivals).toHaveLength(0);
  });

  it("refuses every dispatch after the first without asking the admission again", () => {
    let asked = 0;
    const gate = createOneShotSendCheck(() => {
      asked += 1;
      return null;
    });
    expect(gate.asked).toBe(false);
    expect(gate.check()).toBeNull();
    expect(gate.asked).toBe(true);
    expect(gate.sent).toBe(true);
    expect(gate.check()?.reason).toBe("lease_used");
    expect(asked).toBe(1);

    const refused = createOneShotSendCheck(() => new FanslySendRefusedError("takeover_floor"));
    expect(refused.check()?.reason).toBe("takeover_floor");
    expect(refused.asked).toBe(true);
    expect(refused.sent).toBe(false);
    expect(refused.refusal?.reason).toBe("takeover_floor");
  });
});

describe("the request budget is total", () => {
  it("times out a drip-fed body that never trips undici's inactivity timers", async () => {
    let drip: ReturnType<typeof setInterval> | null = null;
    const { network, dispatcher } = await open({
      respond: (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{\"success\":true,\"response\":");
        drip = setInterval(() => response.write(" "), 100);
        response.on("close", () => clearInterval(drip!));
      },
    });
    const startedAt = performance.now();
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl, 700), recordingCheck().hooks, live());
    const elapsed = performance.now() - startedAt;
    clearInterval(drip!);

    expect(outcome).toMatchObject({ kind: "timeout", sent: true });
    expect(elapsed).toBeGreaterThanOrEqual(650);
    expect(elapsed).toBeLessThan(1_500);
    expect(network.arrivals).toHaveLength(1);
  });

  it("times out an origin that never answers", async () => {
    const { network, dispatcher } = await open({ respond: () => undefined });
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl, 400), recordingCheck().hooks, live());
    expect(outcome).toMatchObject({ kind: "timeout", sent: true });
  });

  it("settles on a cancel before the transport is ready, and the late tunnel carries nothing", async () => {
    const { network, dispatcher } = await open({ tunnelDelayMs: () => 1_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const { calls, hooks } = recordingCheck();
    const startedAt = performance.now();
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl, 20_000), hooks, controller.signal);
    const elapsed = performance.now() - startedAt;

    // Stopping, not a network failure; settled at the cancel, not when the
    // tunnel came up.
    expect(outcome).toEqual({ kind: "aborted_before_send", refusal: "lease_inactive" });
    expect(elapsed).toBeLessThan(600);
    // undici still reaches onRequestStart once the tunnel is up and aborts
    // there: the admission is never asked and the origin sees nothing.
    await sleep(1_300);
    expect(network.tunnels).toBe(1);
    expect(calls).toHaveLength(0);
    expect(network.arrivals).toHaveLength(0);
  });

  it("times out within its budget before the transport is ready, and the late tunnel carries nothing", async () => {
    const { network, dispatcher } = await open({ tunnelDelayMs: () => 1_000 });
    const { calls, hooks } = recordingCheck();
    const signal = live();
    const startedAt = performance.now();
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl, 150), hooks, signal);
    const elapsed = performance.now() - startedAt;

    expect(outcome).toMatchObject({ kind: "timeout", sent: false });
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(600);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    await sleep(1_300);
    expect(network.tunnels).toBe(1);
    expect(calls).toHaveLength(0);
    expect(network.arrivals).toHaveLength(0);
  });

  it("dispatches nothing for a call cancelled before it started", async () => {
    const { network, dispatcher } = await open();
    const controller = new AbortController();
    controller.abort();
    const { calls, hooks } = recordingCheck();
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl), hooks, controller.signal);

    expect(outcome).toEqual({ kind: "aborted_before_send", refusal: "lease_inactive" });
    await sleep(100);
    expect(network.tunnels).toBe(0);
    expect(calls).toHaveLength(0);
  });

  describe("a proxy that accepts TCP and never answers CONNECT", () => {
    // undici bounds that CONNECT only by the proxy client's own 300 s headers
    // timeout; the call's budget and its cancel must not wait for it.
    async function openHungProxy() {
      const sockets = new Set<Socket>();
      const hung = createNetServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => undefined);
      });
      await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", () => resolve()));
      extraServers.push({
        close(callback) {
          for (const socket of sockets) socket.destroy();
          hung.close(() => callback());
        },
      });
      const hungDispatcher = createProxyRequestDispatcher({
        url: `http://127.0.0.1:${(hung.address() as AddressInfo).port}`,
      });
      return { sockets, hungDispatcher };
    }

    afterEach(async () => {
      // `close()` would wait for the pending CONNECT; destroy fails it now.
      await dispatcher?.destroy();
      dispatcher = null;
    });

    it("times out at its budget", async () => {
      const { sockets, hungDispatcher } = await openHungProxy();
      dispatcher = hungDispatcher;
      const { calls, hooks } = recordingCheck();
      const startedAt = performance.now();
      const outcome = await sendFanslyWireRequest(hungDispatcher, accountMe("http://127.0.0.1:9", 300), hooks, live());
      const elapsed = performance.now() - startedAt;

      expect(outcome).toMatchObject({ kind: "timeout", sent: false });
      expect(elapsed).toBeGreaterThanOrEqual(290);
      expect(elapsed).toBeLessThan(1_000);
      expect(sockets.size).toBe(1);
      expect(calls).toHaveLength(0);
    });

    it("settles at the caller's cancel", async () => {
      const { hungDispatcher } = await openHungProxy();
      dispatcher = hungDispatcher;
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("shutdown")), 100);
      const { calls, hooks } = recordingCheck();
      const startedAt = performance.now();
      const outcome = await sendFanslyWireRequest(
        hungDispatcher,
        accountMe("http://127.0.0.1:9", 20_000),
        hooks,
        controller.signal,
      );
      const elapsed = performance.now() - startedAt;

      expect(outcome).toEqual({ kind: "aborted_before_send", refusal: "lease_inactive" });
      expect(elapsed).toBeLessThan(600);
      expect(calls).toHaveLength(0);
    });
  });

  it("reports a cancel in flight as a transport error of a sent request", async () => {
    const { network, dispatcher } = await open({ respond: () => undefined });
    const controller = new AbortController();
    const { calls, hooks } = recordingCheck(() => {
      setTimeout(() => controller.abort(), 50);
      return null;
    });
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl), hooks, controller.signal);

    expect(outcome).toMatchObject({ kind: "transport_error", sent: true });
    if (outcome.kind !== "transport_error") throw new Error("unreachable");
    expect(outcome.message).toMatch(/^cancelled: /);
    expect(calls).toHaveLength(1);
    expect(network.arrivals).toHaveLength(1);
  });

  it("reports an unreachable proxy as unsent", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    dispatcher = createProxyRequestDispatcher({ url: `http://127.0.0.1:${port}` });
    const { calls, hooks } = recordingCheck();
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe("http://127.0.0.1:9"), hooks, live());

    expect(outcome).toMatchObject({ kind: "transport_error", sent: false });
    expect(calls).toHaveLength(0);
  });
});

describe("the body", () => {
  const body = JSON.stringify({ success: true, response: { account: { id: "acct-encoded" } } });

  it.each([
    ["gzip", gzipSync(body)],
    ["x-gzip", gzipSync(body)],
    ["br", brotliCompressSync(body)],
    ["deflate", deflateSync(body)],
    ["deflate", deflateRawSync(body)],
    ["identity, gzip", gzipSync(body)],
  ])("is decoded from %s as the browser decodes it", async (coding, encoded) => {
    const { network, dispatcher } = await open({
      respond: (_request, response) => {
        response.writeHead(200, { "content-type": "application/json", "content-encoding": coding });
        response.end(encoded);
      },
    });
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl), recordingCheck().hooks, live());
    if (coding.startsWith("identity")) {
      // A coding the browser does not decode leaves the whole body as received.
      expect(outcome).toMatchObject({ kind: "response", bodyBytes: encoded.length });
      return;
    }
    expect(outcome).toMatchObject({ kind: "response", bodyText: body, bodyBytes: encoded.length });
  });

  it("refuses a body larger than the cap after the request went out", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    const { network, dispatcher } = await open({
      respond: (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        const total = Math.ceil(FANSLY_WIRE_MAX_BODY_BYTES / chunk.length) + 1;
        let written = 0;
        const pump = () => {
          while (written < total) {
            written += 1;
            if (!response.write(chunk)) {
              response.once("drain", pump);
              return;
            }
          }
          response.end();
        };
        pump();
      },
    });
    const outcome = await sendFanslyWireRequest(dispatcher, accountMe(network.baseUrl, 10_000), recordingCheck().hooks, live());
    expect(outcome).toMatchObject({ kind: "transport_error", sent: true });
    if (outcome.kind !== "transport_error") throw new Error("unreachable");
    expect(outcome.message).toContain(`exceeds ${FANSLY_WIRE_MAX_BODY_BYTES} bytes`);
  });
});

describe("the request is the adapter's", () => {
  it("carries the same headers, in the same order, as the adapter's request for the route", async () => {
    const seen: IncomingMessage["rawHeaders"][] = [];
    const answer = JSON.stringify({
      success: true,
      response: { account: { id: "acct-1", username: "u", displayName: null, createdAt: 0, followCount: 0, subscriberCount: 0 } },
    });
    const { network, dispatcher } = await open({
      respond: (request, response) => {
        seen.push(request.rawHeaders);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(answer);
      },
    });
    const session = {
      authorization: "synthetic-token",
      fanslyClientId: "client-1",
      fanslySessionId: "session-1",
      routeChecks: { account: "check-account" },
    };
    const adapter = new FanslyAdapter({ baseUrl: network.baseUrl });
    try {
      await adapter.getAccountsByIdsPage({
        session,
        proxy: { url: network.proxyUrl },
        egressKey: network.proxyUrl,
        sendGuard: createTestFanslySendGuard(),
        remainingAttempts: () => 1,
      }, ["fan-1", "fan-2"]);
    } finally {
      await adapter.close();
    }
    const outcome = await sendFanslyWireRequest(
      dispatcher,
      buildFanslyWireRequest("accounts.by_ids", { ids: ["fan-1", "fan-2"] }, {
        baseUrl: network.baseUrl,
        session,
        timeoutMs: 2_000,
      }),
      recordingCheck().hooks,
      live(),
    );
    expect(outcome).toMatchObject({ kind: "response", status: 200 });

    const pairs = (raw: string[]) => raw.reduce<Array<[string, string]>>((list, value, index) => {
      if (index % 2 === 0) list.push([value.toLowerCase(), raw[index + 1]!]);
      return list;
    }, []);
    const [adapterHeaders, wireHeaders] = seen.map((raw) => pairs(raw));
    const comparable = (headers: Array<[string, string]>) => headers.map(([name, value]) =>
      name === "fansly-client-ts" ? [name, "<ts>"] : [name, value]);
    expect(wireHeaders).toBeDefined();
    expect(comparable(wireHeaders!)).toEqual(comparable(adapterHeaders!));
    expect(network.arrivals.map((arrival) => arrival.path)).toEqual([
      "/account?ngsw-bypass=true&ids=fan-1%2Cfan-2",
      "/account?ngsw-bypass=true&ids=fan-1%2Cfan-2",
    ]);
  });
});
