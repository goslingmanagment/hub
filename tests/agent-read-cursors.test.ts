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
});
