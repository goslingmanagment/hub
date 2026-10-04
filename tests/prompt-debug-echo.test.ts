import { createServer, type IncomingHttpHeaders } from "node:http";
import { connect, type AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { AI_STREAM_CAPABILITIES } from "@agency_hub_core/contracts";

import {
  hasDebugInputCapability,
  isPromptDebugEchoEnabled,
  parseAiStreamCapabilities,
} from "../apps/runtime/src/modules/ai/index.ts";

describe("AI stream capability header parsing (H-4a)", () => {
  it("keeps only known tokens, trimmed and case-sensitive", () => {
    expect([...parseAiStreamCapabilities("debug-input-v1, context-v1, split-all-v1")])
      .toEqual(["debug-input-v1", "context-v1", "split-all-v1"]);
    expect([...parseAiStreamCapabilities(" split-all-v1 ,future-v9,, context-v1 ,split-all-v1")])
      .toEqual(["split-all-v1", "context-v1"]);
    expect(parseAiStreamCapabilities("Context-V1, CONTEXT-V1, context-v10, x-context-v1").size).toBe(0);
    expect(parseAiStreamCapabilities("context-v1 split-all-v1").size).toBe(0);
    expect(parseAiStreamCapabilities("").size).toBe(0);
  });

  it("reads the header the SDK writes back as the same set", () => {
    const header = AI_STREAM_CAPABILITIES.join(", ");
    expect([...parseAiStreamCapabilities(header)]).toEqual([...AI_STREAM_CAPABILITIES]);
  });

  it("ignores a header longer than 256 chars, an array value and no header", () => {
    const padded = `context-v1,${" ".repeat(256 - "context-v1,".length - "split-all-v1".length)}split-all-v1`;
    expect(padded).toHaveLength(256);
    expect([...parseAiStreamCapabilities(padded)]).toEqual(["context-v1", "split-all-v1"]);
    expect(parseAiStreamCapabilities(`${padded} `).size).toBe(0);
    expect(parseAiStreamCapabilities(["context-v1"]).size).toBe(0);
    expect(parseAiStreamCapabilities(["context-v1", "debug-input-v1"]).size).toBe(0);
    expect(parseAiStreamCapabilities(undefined).size).toBe(0);
  });

  // An array only comes from light-my-request inject. On a real connection
  // Node joins a repeated custom header into one ", "-separated string, so the
  // route sees the union of the lines; the 256-char cap applies to the joined
  // value.
  it("parses a header repeated on the wire as the union of its lines", async () => {
    const headers = await receiveRawHeaders([
      "x-kernel-ai-capabilities: context-v1",
      "X-Kernel-AI-Capabilities: debug-input-v1",
    ]);
    expect(headers["x-kernel-ai-capabilities"]).toBe("context-v1, debug-input-v1");
    expect([...parseAiStreamCapabilities(headers["x-kernel-ai-capabilities"])])
      .toEqual(["context-v1", "debug-input-v1"]);

    const oversized = await receiveRawHeaders([
      "x-kernel-ai-capabilities: context-v1",
      `x-kernel-ai-capabilities: debug-input-v1,${" ".repeat(220)}split-all-v1`,
    ]);
    expect(oversized["x-kernel-ai-capabilities"]?.length).toBeGreaterThan(256);
    expect(parseAiStreamCapabilities(oversized["x-kernel-ai-capabilities"]).size).toBe(0);
  });
});

// Sends one raw HTTP/1.1 request with the given header lines to a local Node
// server and resolves with the headers object Node built from them.
async function receiveRawHeaders(headerLines: readonly string[]): Promise<IncomingHttpHeaders> {
  const server = createServer();
  let fail: (error: Error) => void = () => {};
  const received = new Promise<IncomingHttpHeaders>((resolve, reject) => {
    fail = reject;
    server.once("request", (request, response) => {
      resolve(request.headers);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        ["POST / HTTP/1.1", "Host: localhost", ...headerLines, "Content-Length: 0", "Connection: close", "", ""]
          .join("\r\n"),
      );
    });
    socket.on("error", fail);
    socket.resume();
    return await received;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("prompt debug echo gate", () => {
  it("matches only the exact comma-separated capability token", () => {
    expect(hasDebugInputCapability("debug-input-v1")).toBe(true);
    expect(hasDebugInputCapability("other, debug-input-v1 ,third")).toBe(true);
    expect(hasDebugInputCapability("debug-input-v10")).toBe(false);
    expect(hasDebugInputCapability("prefix-debug-input-v1")).toBe(false);
    expect(hasDebugInputCapability(["debug-input-v1"])).toBe(false);
    expect(hasDebugInputCapability("x".repeat(257))).toBe(false);
    expect(hasDebugInputCapability(undefined)).toBe(false);
  });

  // The kill-switch is a plain boolean (Decision #140 addendum). A missing or
  // non-true effective value fails closed.
  it("is enabled only when the effective flag is exactly true", () => {
    expect(isPromptDebugEchoEnabled(true)).toBe(true);
    expect(isPromptDebugEchoEnabled(false)).toBe(false);
    expect(isPromptDebugEchoEnabled(undefined)).toBe(false);
  });
});
