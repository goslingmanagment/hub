// The OFAPI sync-snapshot state cursor codec: an authenticated, key-rotated
// envelope with no database behind it. The snapshot endpoint that issues and
// honours these cursors is ofapi-sync-snapshot.integration.test.ts.

import { describe, expect, it } from "vitest";

import {
  decodeOfapiSyncSnapshotStateCursor,
  encodeOfapiSyncSnapshotStateCursor,
} from "../apps/runtime/src/services/ofapi-sync-snapshot-cursor.ts";

const ACCOUNT_ONE = "acct_01000000000000000000000000000000";

describe("OFAPI sync snapshot", () => {
  it("authenticates bounded cursors through the configured key-rotation ring", () => {
    const oldKey = Buffer.alloc(32, 4);
    const nextKey = Buffer.alloc(32, 5);
    const payload = {
      version: 1 as const,
      accountId: ACCOUNT_ONE,
      afterSeq: 41,
      snapshotCursor: 57,
      stateAt: "2026-07-13T12:00:00.000Z",
      messageLimit: 100,
      phase: { kind: "archive" as const, threadId: 8, afterRowId: 13 },
    };
    const cursor = encodeOfapiSyncSnapshotStateCursor(payload, {
      key: oldKey,
      keyVersion: 7,
    });

    expect(decodeOfapiSyncSnapshotStateCursor(
      cursor,
      new Map([[7, oldKey], [8, nextKey]]),
    )).toEqual(payload);
    expect(decodeOfapiSyncSnapshotStateCursor(
      cursor,
      new Map([[8, nextKey]]),
    )).toBeNull();

    const envelope = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    envelope.payload.snapshotCursor += 1;
    const tampered = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
    expect(decodeOfapiSyncSnapshotStateCursor(
      tampered,
      new Map([[7, oldKey]]),
    )).toBeNull();
  });
});
