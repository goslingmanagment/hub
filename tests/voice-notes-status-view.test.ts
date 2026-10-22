import { describe, expect, it } from "vitest";

import type { VoiceNoteState } from "@agency_hub_core/db";

import { toStatusView } from "../apps/runtime/src/services/voice-notes.ts";

// What a client is told about the charge. Each row is shaped the way the
// writers in packages/db/src/repositories/voice-notes.ts leave it; the status
// read and the create replay both render through toStatusView. `billed=false`
// is a verdict on some rows and only the nightly release fence on others (the
// `billed` column in packages/db/src/schema.ts): a client must never read the
// fence as «not charged».

const LEASE = new Date("2026-10-20T12:02:00.000Z");

function billedSeen(row: { state: VoiceNoteState; billed: boolean | null; leaseUntil: Date | null }) {
  return toStatusView({
    id: 1,
    scriptChars: 120,
    audioSha256: null,
    audioBytesLen: null,
    createdAt: new Date("2026-10-20T12:00:00.000Z"),
    ...row,
  }).billed;
}

describe("voice note status view: billed", () => {
  it("an abandoned queued row never reached ElevenLabs: not billed", () => {
    // The queued sweep: indeterminate + billed=false, and no dispatch lease.
    expect(billedSeen({ state: "indeterminate", billed: false, leaseUntil: null })).toBe(false);
  });

  it("a released indeterminate row is unknown, not «not billed»", () => {
    // The lease sweep left billed NULL; the nightly release stamped its fence.
    expect(billedSeen({ state: "indeterminate", billed: false, leaseUntil: LEASE })).toBeNull();
    expect(billedSeen({ state: "indeterminate", billed: null, leaseUntil: LEASE })).toBeNull();
  });

  it("a settled unbilled failure is not billed", () => {
    expect(billedSeen({ state: "failed_definite", billed: false, leaseUntil: LEASE })).toBe(false);
  });

  it("a completed take is billed", () => {
    expect(billedSeen({ state: "completed", billed: true, leaseUntil: LEASE })).toBe(true);
  });

  it("a failure after dispatch stays unknown", () => {
    expect(billedSeen({ state: "failed_after_dispatch", billed: null, leaseUntil: LEASE })).toBeNull();
  });
});
