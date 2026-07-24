// A dead page proxy must be NAMED on the AI feature lane (2026-07-15: lora-2's
// SOCKS proxy died and every generation surfaced as a generic stream failure,
// 31s each — three SDK connect attempts nobody asked for). These tests pin the
// classifier that turns connect-level failures into provider_proxy_unreachable
// and the sticky-fail fetch that stops the SDK from re-dialing a dead proxy.

import { describe, expect, it, vi } from "vitest";

import {
  classifyProviderStreamFailure,
  createStickyConnectFailureFetch,
  normalizeProviderStreamFailure,
} from "@agency_hub_core/shared";

function connectTimeoutError() {
  const error = new Error("Connect Timeout Error");
  error.name = "ConnectTimeoutError";
  (error as Error & { code?: string }).code = "UND_ERR_CONNECT_TIMEOUT";
  return error;
}

function socksError(message: string) {
  const error = new Error(message);
  error.name = "SocksClientError";
  return error;
}

describe("classifyProviderStreamFailure", () => {
  it("names an undici connect timeout as proxy-unreachable", () => {
    const wrapped = new Error("Connection error.");
    wrapped.cause = connectTimeoutError();
    expect(classifyProviderStreamFailure(wrapped)).toBe("provider_proxy_unreachable");
    expect(normalizeProviderStreamFailure(wrapped)).toMatchObject({
      code: "provider_proxy_unreachable",
      failurePhase: "connect",
    });
  });

  it("names a SOCKS handshake failure as proxy-unreachable", () => {
    const wrapped = new Error("Connection error.");
    wrapped.cause = socksError("Proxy connection timed out");
    expect(classifyProviderStreamFailure(wrapped)).toBe("provider_proxy_unreachable");
    expect(normalizeProviderStreamFailure(wrapped)).toMatchObject({
      code: "provider_proxy_unreachable",
      failurePhase: "connect",
    });
  });

  it("names a refused proxy TCP connection as proxy-unreachable", () => {
    const refused = new Error("connect ECONNREFUSED 64.72.204.203:12324");
    (refused as Error & { code?: string }).code = "ECONNREFUSED";
    const wrapped = new Error("Connection error.");
    wrapped.cause = refused;
    expect(classifyProviderStreamFailure(wrapped)).toBe("provider_proxy_unreachable");
    expect(normalizeProviderStreamFailure(wrapped)).toMatchObject({
      code: "provider_proxy_unreachable",
      failurePhase: "connect",
    });
  });

  it("keeps mid-stream provider failures as the generic stream failure", () => {
    expect(normalizeProviderStreamFailure(new Error("terminated"))).toMatchObject({
      code: "provider_stream_failed",
      failurePhase: "stream",
    });
    const reset = new Error("other side closed");
    (reset as Error & { code?: string }).code = "UND_ERR_SOCKET";
    expect(normalizeProviderStreamFailure(reset)).toMatchObject({
      code: "provider_stream_failed",
      failurePhase: "stream",
    });
  });

  it("does not broaden proxy detection to every SDK connection error", () => {
    const sdkConnection = new Error("Connection error.");
    sdkConnection.name = "APIConnectionError";

    expect(classifyProviderStreamFailure(sdkConnection, {
      provider: "anthropic",
      failurePhase: "provider_response",
    })).toBe("provider_stream_failed");
    expect(normalizeProviderStreamFailure(sdkConnection, {
      provider: "anthropic",
      failurePhase: "provider_response",
    })).toMatchObject({
      code: "provider_stream_failed",
      failurePhase: "provider_response",
    });
  });
});

describe("createStickyConnectFailureFetch", () => {
  it("re-throws a connect failure instantly instead of re-dialing a dead proxy", async () => {
    const inner = vi.fn(async () => {
      throw connectTimeoutError();
    });
    const sticky = createStickyConnectFailureFetch(inner as unknown as typeof fetch);

    await expect(sticky("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      "Connect Timeout Error",
    );
    await expect(sticky("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      "Connect Timeout Error",
    );
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does not stick non-connect failures — the SDK retry policy stays in charge", async () => {
    const inner = vi.fn(async () => {
      throw new Error("terminated");
    });
    const sticky = createStickyConnectFailureFetch(inner as unknown as typeof fetch);

    await expect(sticky("https://api.anthropic.com/v1/messages")).rejects.toThrow("terminated");
    await expect(sticky("https://api.anthropic.com/v1/messages")).rejects.toThrow("terminated");
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("passes successful responses through untouched", async () => {
    const response = new Response("{}", { status: 200 });
    const inner = vi.fn(async () => response);
    const sticky = createStickyConnectFailureFetch(inner as unknown as typeof fetch);

    await expect(sticky("https://api.anthropic.com/v1/messages")).resolves.toBe(response);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
