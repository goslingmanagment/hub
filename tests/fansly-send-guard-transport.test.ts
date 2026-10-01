import { afterEach, describe, expect, it } from "vitest";

import { FanslyAdapter, FanslyApiError } from "@agency_hub_core/fansly";

import { createTestFanslySendGuards } from "./helpers/fansly-send-guard.ts";
import { startFakeFanslyNetwork, type FakeFanslyNetwork } from "./helpers/fansly-send-guard-network.ts";

// The send check on the real transport: the real adapter, real undici, a real
// CONNECT proxy and origin on loopback. One capture is one physical request:
// undici's own re-sends and redirect hops are refused before a byte is written,
// and a lease past its send window writes nothing at all.

let network: FakeFanslyNetwork | null = null;
let adapter: FanslyAdapter | null = null;

afterEach(async () => {
  await adapter?.close();
  await network?.close();
  adapter = null;
  network = null;
});

function context(guard: ReturnType<ReturnType<typeof createTestFanslySendGuards>["registry"]["forPage"]>) {
  return {
    session: { authorization: "synthetic" },
    proxy: { url: network!.proxyUrl },
    egressKey: network!.proxyUrl,
    sendGuard: guard,
    remainingAttempts: () => 1,
  };
}

describe("the send check on the real transport", () => {
  it("records the send moment of a request that went through the proxy", async () => {
    network = await startFakeFanslyNetwork({ tunnelDelayMs: () => 200 });
    adapter = new FanslyAdapter({ baseUrl: network.baseUrl });
    const { registry, store } = createTestFanslySendGuards();
    const before = Date.now();
    await adapter.getAccountMe(context(registry.forPage(1, "account_me_cli")));
    expect(network.arrivals).toHaveLength(1);
    const row = store.journal[0]!;
    expect(row.outcome).toBe("response");
    expect(row.httpStatus).toBe(200);
    // The send is after the 200 ms tunnel, and before the origin saw it.
    expect(row.sentAt!.getTime()).toBeGreaterThanOrEqual(before + 190);
    expect(row.sentAt!.getTime()).toBeLessThanOrEqual(network.arrivals[0]!.wallMs + 5);
    expect(row.sendOffsetMs).toBeGreaterThanOrEqual(190);
  });

  it("answers a redirect itself: one capture, one request, no hop", async () => {
    network = await startFakeFanslyNetwork({
      respond: (_request, response) => {
        response.writeHead(302, { location: "/account/elsewhere" });
        response.end();
      },
    });
    adapter = new FanslyAdapter({ baseUrl: network.baseUrl });
    const { registry, store } = createTestFanslySendGuards();
    await expect(adapter.getAccountMe(context(registry.forPage(1, "sync_stream"))))
      .rejects.toBeInstanceOf(FanslyApiError);
    expect(network.arrivals.map((arrival) => arrival.path.split("?")[0])).toEqual(["/account/me"]);
    expect(store.journal.map((row) => [row.outcome, row.httpStatus])).toEqual([["response", 302]]);
  });

  it("refuses undici's hidden re-send after a 421 before a byte is written", async () => {
    network = await startFakeFanslyNetwork({
      respond: (_request, response) => {
        response.writeHead(421);
        response.end("misdirected");
      },
    });
    adapter = new FanslyAdapter({ baseUrl: network.baseUrl });
    const { registry, store } = createTestFanslySendGuards();
    await expect(adapter.getAccountMe(context(registry.forPage(1, "sync_stream")))).rejects.toThrow();
    // Without the guard undici sends this request twice.
    expect(network.arrivals).toHaveLength(1);
    expect(store.journal).toHaveLength(1);
    expect(store.journal[0]).toMatchObject({ outcomeDetail: "lease_used" });
    expect(store.journal[0]!.sentAt).not.toBeNull();
  });

  it("writes nothing for a lease whose send window passed before the transport was ready", async () => {
    network = await startFakeFanslyNetwork({ tunnelDelayMs: () => 300 });
    adapter = new FanslyAdapter({ baseUrl: network.baseUrl });
    // 300 ms between capture and dispatch plus a 300 ms tunnel: the transport
    // is ready 600 ms after the capture, past the 500 ms send window, while the
    // request's own 500 ms timeout (counted from the dispatch) has not fired.
    const { registry, store } = createTestFanslySendGuards({
      hooks: { afterCapture: () => new Promise((resolve) => setTimeout(resolve, 300)) },
    });
    await expect(adapter.getAccountMe({
      ...context(registry.forPage(1, "sync_stream")),
      requestTimeoutMs: 500,
    })).rejects.toMatchObject({ cause: { name: "FanslySendRefusedError", reason: "send_deadline_passed" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(network.arrivals).toHaveLength(0);
    expect(network.tunnels).toBe(1);
    expect(store.journal[0]).toMatchObject({
      outcome: "aborted_before_send",
      outcomeDetail: "send_deadline_passed",
      sentAt: null,
    });
    expect(store.rows.get(1)?.holderToken).toBeNull();
  });
});
