import { describe, expect, it } from "vitest";

import {
  classifyTransportError,
  exponentialRetryDelayMs,
  formatObservedError,
  parseRetryAfterDelayMs,
  resolveRetryDelayMs,
} from "../packages/shared/src/http-client.ts";

describe("shared http client helpers", () => {
  it("formats nested undici causes with socket metadata", () => {
    const socketError = Object.assign(new Error("other side closed"), {
      name: "SocketError",
      code: "UND_ERR_SOCKET",
      socket: {
        remoteAddress: "203.0.113.10",
        remotePort: 443,
      },
    });
    const error = new TypeError("fetch failed", { cause: socketError });

    expect(formatObservedError(error)).toContain("TypeError: fetch failed");
    expect(formatObservedError(error)).toContain("cause(1): SocketError: other side closed");
    expect(formatObservedError(error)).toContain("code=UND_ERR_SOCKET");
    expect(formatObservedError(error)).toContain("socket={remoteAddress=203.0.113.10, remotePort=443}");
  });

  it("detects timeout errors through the nested cause chain", () => {
    const timeoutError = Object.assign(new Error("connect timed out"), {
      name: "ConnectTimeoutError",
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const error = new TypeError("fetch failed", { cause: timeoutError });

    expect(classifyTransportError(error)).toBe("timeout");
  });

  it("parses retry-after seconds and http-date values", () => {
    const now = Date.parse("2026-03-13T00:00:00.000Z");

    expect(parseRetryAfterDelayMs("0.001", now)).toBe(1);
    expect(parseRetryAfterDelayMs("Fri, 13 Mar 2026 00:00:05 GMT", now)).toBe(5_000);
  });

  it("falls back to exponential retry delays when retry-after is absent", () => {
    expect(exponentialRetryDelayMs(1)).toBe(5_000);
    expect(exponentialRetryDelayMs(2)).toBe(10_000);
    expect(resolveRetryDelayMs(null, 3)).toBe(20_000);
  });
});
