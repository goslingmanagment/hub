import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { AppError } from "../apps/runtime/src/services/errors.ts";
import {
  agentParamsHash,
  canonicalJson,
  decodeAgentCursor,
  encodeAgentCursor,
  type AgentCursorSigning,
} from "../apps/runtime/src/modules/agent-read/index.ts";

// Agent Read Plane cursors. Every refusal below produces the SAME 400 with the
// SAME message: `paramsHash` and `pageIds` mismatches are oracles of somebody
// else's scope, and an empty 200 instead would silently reshape the snapshot when
// a grant changes mid-traversal.

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

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
  it("round-trips and carries the normalized request VERBATIM", () => {
    const token = encodeAgentCursor(payload, signing);
    const decoded = decodeAgentCursor(token, expectation, signing);
    // The contract forbids re-sending filters alongside a cursor, so page 2's
    // query has to come from the cursor itself: an irreversible hash could not
    // reconstruct it.
    expect(decoded.params).toEqual(params);
    expect(decoded.keyset).toEqual(payload.keyset);
    expect(decoded.paramsHash).toBe(agentParamsHash(params));
  });

  it("is opaque on the wire and matches the contract's cursor primitive", () => {
    const token = encodeAgentCursor(payload, signing);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(2048);
    expect(token).not.toContain("agentThreads");
  });

  it("refuses a forged MAC", () => {
    const token = encodeAgentCursor(payload, signing);
    const forged = encodeAgentCursor(payload, {
      key: OTHER_KEY,
      keyVersion: 1,
      keysByVersion: new Map([[1, OTHER_KEY]]),
    });
    expect(forged).not.toBe(token);
    expectRefused(() => decodeAgentCursor(forged, expectation, signing));
  });

  it("refuses a tampered payload", () => {
    const token = encodeAgentCursor(payload, signing);
    const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    decoded.payload.pageIds = [4, 5, 6];
    const tampered = Buffer.from(canonicalJson(decoded), "utf8").toString("base64url");
    expectRefused(() => decodeAgentCursor(tampered, expectation, signing));
  });

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

  it("refuses a cursor minted under a different archive generation", () => {
    // The rebuild swap can rename `message_archive` between two pages of one
    // traversal; a resumed keyset would skip rows and report a FALSE
    // "snapshot exhausted", which reads as "I read everything".
    const token = encodeAgentCursor(payload, signing);
    expectRefused(() =>
      decodeAgentCursor(token, { ...expectation, archiveGeneration: 4 }, signing));
  });

  it("refuses a cursor whose page grant no longer matches", () => {
    const token = encodeAgentCursor(payload, signing);
    expectRefused(() => decodeAgentCursor(token, { ...expectation, pageIds: [4] }, signing));
    expectRefused(() => decodeAgentCursor(token, { ...expectation, pageIds: [4, 5, 6] }, signing));
  });

  it("accepts the same grant in a different order", () => {
    const token = encodeAgentCursor(payload, signing);
    expect(decodeAgentCursor(token, { ...expectation, pageIds: [5, 4] }, signing).keyId).toBe(42);
  });

  it("refuses an unknown key version", () => {
    const token = encodeAgentCursor(payload, signing);
    expectRefused(() => decodeAgentCursor(token, expectation, {
      key: KEY,
      keyVersion: 2,
      keysByVersion: new Map([[2, KEY]]),
    }));
  });

  it("refuses garbage, empty and oversized input", () => {
    expectRefused(() => decodeAgentCursor("", expectation, signing));
    expectRefused(() => decodeAgentCursor("not base64!!", expectation, signing));
    expectRefused(() => decodeAgentCursor("a".repeat(2049), expectation, signing));
    expectRefused(() => decodeAgentCursor(
      Buffer.from("{\"nope\":1}", "utf8").toString("base64url"),
      expectation,
      signing,
    ));
  });

  it("refuses a re-encoded but non-canonical body", () => {
    // Node's base64url decoder is permissive; a payload that does not round-trip
    // byte for byte is rejected before anything in it is trusted.
    const token = encodeAgentCursor(payload, signing);
    expectRefused(() => decodeAgentCursor(`${token}=`, expectation, signing));
  });

  it("canonical JSON sorts keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(agentParamsHash({ b: 1, a: 2 })).toBe(agentParamsHash({ a: 2, b: 1 }));
  });
});
