import { describe, expect, it } from "vitest";

import { FANSLY_DELETE_CONFIRM_WAIT_MS, fanslyDeleteConclusion } from "../apps/runtime/src/services/publications-fansly-delete.ts";

// The owner's deletion of a published Fansly post (the contract §5): one
// request, and its outcome only from a read by the post's id asked for after
// Fansly answered — "Снят" only when that read lists nothing.

const NOW = new Date("2026-10-25T12:00:00Z");
const answeredAt = new Date(NOW.getTime() - 60_000);
const command = (state: string, extra: { stateReason?: string | null; settledAt?: Date | null } = {}) => ({ state, stateReason: null, settledAt: answeredAt, ...extra });
const read = (createdAt: Date, found: { id: string } | null, closed = true) => ({
  id: 5, createdAt, closedAt: closed ? NOW : null,
  result: { v: 1, publicationId: 1, mode: "deleted", byId: { ref: "970", found: found === null ? null : { ...found, atMs: null, text: "", attachmentIds: [] }, answered: found === null ? 0 : 1 } },
});
const conclude = (input: Partial<Parameters<typeof fanslyDeleteConclusion>[0]>) =>
  fanslyDeleteConclusion({ command: command("answered"), postRef: "970", work: null, now: NOW, ...input });

describe("the outcome of a deletion of a published Fansly post", () => {
  it("waits while the request is queued or on the wire; a lost answer is unknown, never sent again", () => {
    expect(conclude({ command: command("queued", { settledAt: null }) })).toEqual({ kind: "wait", askRead: false });
    expect(conclude({ command: command("sending", { settledAt: null }) })).toEqual({ kind: "wait", askRead: false });
    expect(conclude({ command: command("unknown", { stateReason: "no_answer:timeout" }) })).toMatchObject({ kind: "settle", to: "unknown", reason: "delete_no_answer:timeout" });
  });

  it("answered: asks for a read after the answer; nothing listed by id is deleted, the post still listed unknown", () => {
    expect(conclude({})).toEqual({ kind: "wait", askRead: true });
    // A read taken before the answer says nothing of it.
    expect(conclude({ work: read(new Date(answeredAt.getTime() - 1), null) })).toEqual({ kind: "wait", askRead: true });
    const after = new Date(answeredAt.getTime() + 1);
    expect(conclude({ work: read(after, null, false) })).toEqual({ kind: "wait", askRead: false });
    expect(conclude({ work: read(after, null) })).toMatchObject({ kind: "settle", to: "withdrawn", reason: "deleted_after_publish" });
    expect(conclude({ work: read(after, { id: "970" }) })).toMatchObject({ kind: "settle", to: "unknown", reason: "delete_still_listed" });
  });

  it("no proof within its wait is unknown, never deleted", () => {
    const late = new Date(answeredAt.getTime() + FANSLY_DELETE_CONFIRM_WAIT_MS + 1);
    expect(conclude({ now: late })).toMatchObject({ kind: "settle", to: "unknown", reason: "delete_unconfirmed_read_failed" });
    expect(conclude({ now: late, work: read(new Date(answeredAt.getTime() + 1), null, false) })).toMatchObject({ kind: "settle", to: "unknown" });
  });
});
