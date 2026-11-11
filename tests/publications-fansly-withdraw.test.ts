import { describe, expect, it } from "vitest";

import type { FanslyPublishFacts } from "@agency_hub_core/fansly";

import { FANSLY_WITHDRAW_CONFIRM_WAIT_MS, fanslyWithdrawConclusion } from "../apps/runtime/src/services/publications-fansly-withdraw.ts";

// Withdrawal of a Fansly post from its schedule (plan PR 9, spec §8.2): it is
// "Снят" only when a read taken after Fansly's answer no longer shows it while
// its time is still ahead, and either the read is complete (the stand confirmed
// the list is the whole schedule) or Fansly's answer to the cancel listed this
// very post as taken off (status 3); anything less is "Неизвестно".

const MIN = 60_000;
const NOW = new Date("2026-10-24T12:00:00Z");
const PUBLISH_AT = new Date(NOW.getTime() + 2 * 60 * MIN);
const SETTLED = new Date(NOW.getTime() - 2 * MIN);
const VERIFIED: FanslyPublishFacts = { scheduleListWhole: true, scheduledPostKeepsId: true, storyListRead: true, immediatePost: false };

const answered = { state: "answered", stateReason: null, settledAt: SETTLED };
const conclusion = (overrides: Partial<Parameters<typeof fanslyWithdrawConclusion>[0]> = {}) => fanslyWithdrawConclusion({
  command: answered, postRef: "p1", publishAt: PUBLISH_AT,
  schedule: { readAt: new Date(SETTLED.getTime() + 1), complete: true, incompleteReasons: [], postRefs: [] }, now: NOW, ...overrides,
});

describe("a Fansly withdrawal's outcome", () => {
  it("a complete read after the answer without the post, its time ahead: withdrawn — once the stand confirmed the list", () => {
    expect(conclusion({ facts: VERIFIED })).toEqual({ kind: "settle", to: "withdrawn", reason: "withdrawn" });
    expect(conclusion()).toEqual({ kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_incomplete" });
    expect(conclusion({ facts: VERIFIED, schedule: { readAt: new Date(SETTLED.getTime() + 1), complete: false, incompleteReasons: ["list_whole_unverified"], postRefs: [] } }))
      .toEqual({ kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_incomplete" });
  });

  it("still shown after Fansly's answer: unknown", () => {
    expect(conclusion({ facts: VERIFIED, schedule: { readAt: new Date(SETTLED.getTime() + 1), complete: true, incompleteReasons: [], postRefs: ["p1"] } }))
      .toEqual({ kind: "settle", to: "unknown", reason: "withdraw_still_in_schedule" });
  });

  it("waits for a read taken after the answer, asking for it; none in 30 minutes: unknown", () => {
    const stale = { readAt: SETTLED, complete: true, incompleteReasons: [], postRefs: [] };
    expect(conclusion({ schedule: stale })).toEqual({ kind: "wait", askRead: true });
    expect(conclusion({ schedule: null })).toEqual({ kind: "wait", askRead: true });
    expect(conclusion({ schedule: stale, now: new Date(SETTLED.getTime() + FANSLY_WITHDRAW_CONFIRM_WAIT_MS + 1) }))
      .toEqual({ kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_read_failed" });
  });

  it("a lost answer is unknown; a refusal or one that never left leaves the post scheduled; one queued asks for its read", () => {
    expect(conclusion({ command: { state: "unknown", stateReason: "no_answer:timeout", settledAt: SETTLED } }))
      .toEqual({ kind: "settle", to: "unknown", reason: "withdraw_no_answer:timeout" });
    expect(conclusion({ command: { state: "rejected", stateReason: "fansly_http_400", settledAt: SETTLED } })).toEqual({ kind: "wait", askRead: false });
    expect(conclusion({ command: { state: "refused", stateReason: "not_in_schedule", settledAt: SETTLED } })).toEqual({ kind: "wait", askRead: false });
    expect(conclusion({ command: { state: "queued", stateReason: null, settledAt: null } })).toEqual({ kind: "wait", askRead: true });
    expect(conclusion({ command: { state: "sending", stateReason: null, settledAt: null } })).toEqual({ kind: "wait", askRead: false });
  });
});

describe("a Fansly withdrawal Fansly acknowledged (its answer listed the post at status 3)", () => {
  // Today's reads: the list's wholeness is unconfirmed, every entry read.
  const read = (postRefs: string[], at = new Date(SETTLED.getTime() + 1)) => ({
    readAt: at, complete: false, incompleteReasons: ["list_whole_unverified"], postRefs,
  });
  const acked = { ...answered, listedStatus: 3 };

  it("acknowledged and absent from the read after, its time ahead: withdrawn — the list's wholeness not claimed", () => {
    expect(conclusion({ command: acked, schedule: read([]) }))
      .toEqual({ kind: "settle", to: "withdrawn", reason: "withdrawn_cancel_acknowledged" });
  });

  it("acknowledged but still listed by the read after: unknown", () => {
    expect(conclusion({ command: acked, schedule: read(["p1"]) }))
      .toEqual({ kind: "settle", to: "unknown", reason: "withdraw_still_in_schedule" });
  });

  it("absent without the acknowledgement (not listed, another status, unread): unknown, as before", () => {
    for (const command of [answered, { ...answered, listedStatus: null }, { ...answered, listedStatus: 1 }]) {
      expect(conclusion({ command, schedule: read([]) }))
        .toEqual({ kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_incomplete" });
    }
  });

  it("acknowledged and absent, but its time passed at the read: unknown", () => {
    expect(conclusion({ command: acked, schedule: read([], new Date(PUBLISH_AT.getTime() + 1)) }))
      .toEqual({ kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_time_passed" });
  });

  it("acknowledged, but the read after left entries unread or has no read after the answer: no proof", () => {
    expect(conclusion({ command: acked, schedule: { ...read([]), incompleteReasons: ["list_whole_unverified", "entries_unreadable:1"] } }))
      .toEqual({ kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_incomplete" });
    expect(conclusion({ command: acked, schedule: read([], SETTLED) })).toEqual({ kind: "wait", askRead: true });
    expect(conclusion({ command: acked, postRef: null, schedule: read([]) }))
      .toEqual({ kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_incomplete" });
  });
});
