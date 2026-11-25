import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { AppError } from "../apps/runtime/src/services/errors.ts";
import {
  decodeAgentCursor,
  encodeAgentCursor,
  type AgentCursorSigning,
} from "../apps/runtime/src/modules/agent-read/index.ts";

// Agent Read Plane cursors. Every refusal below produces the SAME 400 with the
// SAME message: `paramsHash` and `pageIds` mismatches are oracles of somebody
// else's scope, and an empty 200 instead would silently reshape the snapshot when
// a grant changes mid-traversal.

const KEY = Buffer.alloc(32, 7);

const signing: AgentCursorSigning = {
  key: KEY,
  keyVersion: 1,
  keysByVersion: new Map([[1, KEY]]),
};

const params = { from: "2026-01-08T00:00:00.000Z", to: "2026-01-20T00:00:00.000Z", limit: 50 };

const payload = {
  operation: "agentThreads",
  resource: "global",
  keyId: 42,
  pageIds: [4, 5],
  params,
  archiveGeneration: 3,
  sourceHighWaters: { page_dm_threads: "912" },
  seqHighWater: { "4": 1200 },
  keyset: { sortValue: "2026-01-19T00:00:00.000Z", threadId: 912 },
};

const expectation = {
  operation: "agentThreads",
  resource: "global",
  keyId: 42,
  pageIds: [4, 5],
  archiveGeneration: 3,
};

function expectRefused(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.statusCode).toBe(400);
    expect(appError.code).toBe("agent_cursor_invalid");
    // The message is CONSTANT: the cause is written only to the internal trail.
    expect(appError.message).toBe("cursor is not valid for this request");
    return;
  }
  throw new Error("expected the cursor to be refused");
}

describe("agent read plane: cursors", () => {
  it("refuses a FOREIGN cursor (another key's traversal)", () => {
    const token = encodeAgentCursor(payload, signing);
    expectRefused(() => decodeAgentCursor(token, { ...expectation, keyId: 43 }, signing));
  });

  it("refuses a cursor from another operation", () => {
    const token = encodeAgentCursor(payload, signing);
    expectRefused(() =>
      decodeAgentCursor(token, { ...expectation, operation: "agentCoverage" }, signing));
  });

  it("refuses a cursor minted for a DIFFERENT resource", () => {
    // A transcript cursor for one conversation used to resume against another,
    // and a dataset cursor against a different dataset, because only the
    // operation name was bound. The path resource is part of the identity now.
    const transcript = encodeAgentCursor({
      ...payload,
      operation: "agentThreadMessages",
      resource: "conversation:4:aaa",
    }, signing);
    const expectTranscript = {
      ...expectation,
      operation: "agentThreadMessages",
      resource: "conversation:4:aaa",
    };
    expect(decodeAgentCursor(transcript, expectTranscript, signing).keyId).toBe(42);
    expectRefused(() => decodeAgentCursor(
      transcript,
      { ...expectTranscript, resource: "conversation:4:bbb" },
      signing,
    ));
  });

  it("refuses a cursor whose page grant no longer matches", () => {
    const token = encodeAgentCursor(payload, signing);
    expectRefused(() => decodeAgentCursor(token, { ...expectation, pageIds: [4] }, signing));
    expectRefused(() => decodeAgentCursor(token, { ...expectation, pageIds: [4, 5, 6] }, signing));
  });

  it("accepts long path resources up to 600 chars (BL-A-5)", () => {
    const longRef = "c".repeat(500);
    const longResource = `conversation:4:${longRef}`;
    const token = encodeAgentCursor({
      ...payload,
      operation: "agentThreadMessages",
      resource: longResource,
      params: { ...params, conversationRef: longRef },
    }, signing);
    const decoded = decodeAgentCursor(token, {
      ...expectation,
      operation: "agentThreadMessages",
      resource: longResource,
    }, signing);
    expect(decoded.resource).toBe(longResource);
    expect(token.length).toBeLessThanOrEqual(2048);
  });

  it("compresses oversized agent cursors under the 2048-char wire limit and refuses tampering (BL-A9)", () => {
    const pageIds = Array.from({ length: 120 }, (_, i) => i + 1);
    const largeParams = {
      ...params,
      q: "searchable phrase ".repeat(30),
      filters: Array.from({ length: 16 }, (_, i) => ({
        field: `metric_${i}`,
        op: "in",
        value: ["alpha", "beta", "gamma", "delta"],
      })),
    };
    const token = encodeAgentCursor({
      ...payload,
      pageIds,
      params: largeParams,
    }, signing);
    expect(token.length).toBeLessThanOrEqual(2048);
    const parsedEnvelope = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { format: number };
    expect(parsedEnvelope.format).toBe(2);

    const decoded = decodeAgentCursor(token, { ...expectation, pageIds }, signing);
    expect(decoded.params).toEqual(largeParams);

    const flipped = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expectRefused(() => decodeAgentCursor(flipped, { ...expectation, pageIds }, signing));
  });

  it("refuses to emit an uncompressible cursor that still exceeds 2048 chars (BL-A9)", () => {
    // Deterministic high-entropy hex string that resists deflate compression.
    let state = 0x12345678;
    const chunks: string[] = [];
    for (let i = 0; i < 1900; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      chunks.push(String.fromCharCode(33 + (state % 90)));
    }
    const incompressible = chunks.join("");
    let thrown: unknown = null;
    try {
      encodeAgentCursor({
        ...payload,
        params: { ...params, q: incompressible },
      }, signing);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(400);
    expect((thrown as AppError).code).toBe("agent_cursor_too_large");
  });

  it("refuses compressible cursor payloads exceeding the 16 KiB decode ceiling at mint time", () => {
    // Highly compressible (>16 KiB uncompressed) payload would fit in 2048 chars compressed,
    // but decode rejects >16 KiB uncompressed — encode must reject upfront instead of minting a dead cursor.
    let thrown: unknown = null;
    try {
      encodeAgentCursor({
        ...payload,
        params: { ...params, q: "a".repeat(20_000) },
      }, signing);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(400);
    expect((thrown as AppError).code).toBe("agent_cursor_too_large");
  });
});
