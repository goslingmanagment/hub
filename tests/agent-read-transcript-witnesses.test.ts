import { describe, expect, it } from "vitest";

import { listAgentTranscript } from "@agency_hub_core/db";

// BL-A11. The transcript union scans four stores, but only `message_archive`'s
// capture floor is ever established (the caller's dedicated unbounded query runs
// over that store alone). The bug stamped that one date onto all four witnesses,
// fabricating floors for `dm_message_archive`, `page_dm_messages` and
// `page_dm_threads` that nobody computed — and a fabricated floor is exactly the
// class of confident falsehood the witness type exists to prevent.
//
// The witnesses are minted before any row comes back, so a stub connection that
// returns no rows exercises the real minting path.

const stubDb = {
  execute: async () => ({ rows: [] }),
} as unknown as Parameters<typeof listAgentTranscript>[0];

const FLOOR = new Date("2026-02-21T09:14:03.000Z");

const input: Parameters<typeof listAgentTranscript>[1] = {
  pageId: 1,
  archiveFloor: FLOOR,
  platform: "fansly",
  conversationRef: "810272281019305984",
  from: new Date("2026-01-01T00:00:00Z"),
  to: new Date("2026-02-01T00:00:00Z"),
  sortDir: "asc",
  limit: 10,
  filters: {},
};

describe("BL-A11: transcript witnesses carry their OWN floors", () => {
  it("message_archive carries the dedicated floor; the other three arms report unknown", async () => {
    const { witnesses } = await listAgentTranscript(stubDb, input);
    const byPlane = new Map(witnesses.map((witness) => [witness.plane, witness.captureFloor]));

    expect([...byPlane.keys()].sort()).toEqual([
      "dm_message_archive",
      "message_archive",
      "page_dm_messages",
      "page_dm_threads",
    ]);
    expect(byPlane.get("message_archive")).toEqual({
      at: FLOOR.toISOString(),
      kind: "oldest_stored_row",
    });
    for (const plane of ["dm_message_archive", "page_dm_messages", "page_dm_threads"]) {
      expect(byPlane.get(plane)).toEqual({ at: null, kind: "unknown" });
    }
  });

  it("an unknown archive floor stays unknown on every arm", async () => {
    const { witnesses } = await listAgentTranscript(stubDb, { ...input, archiveFloor: null });
    for (const witness of witnesses) {
      expect(witness.captureFloor).toEqual({ at: null, kind: "unknown" });
    }
  });
});
