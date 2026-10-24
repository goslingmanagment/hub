import { describe, expect, it } from "vitest";

import type { FanslyPublishFacts } from "@agency_hub_core/fansly";

import { FANSLY_WITHDRAW_CONFIRM_WAIT_MS, fanslyWithdrawConclusion } from "../apps/runtime/src/services/publications-fansly-withdraw.ts";

// Withdrawal of a Fansly post from its schedule (plan PR 9, spec §8.2): it is
// "Снят" only when a complete read taken after Fansly's answer no longer shows
// it while its time is still ahead; anything less is "Неизвестно" — and until
// the stand confirms the list is the whole schedule, every read is less.

const MIN = 60_000;
const NOW = new Date("2026-10-24T12:00:00Z");
const PUBLISH_AT = new Date(NOW.getTime() + 2 * 60 * MIN);
const SETTLED = new Date(NOW.getTime() - 2 * MIN);
const VERIFIED: FanslyPublishFacts = { scheduleListWhole: true, scheduledPostKeepsId: true, storyListRead: true, immediatePost: false };

const answered = { state: "answered", stateReason: null, settledAt: SETTLED };
const conclusion = (overrides: Partial<Parameters<typeof fanslyWithdrawConclusion>[0]> = {}) => fanslyWithdrawConclusion({
  command: answered, postRef: "p1", publishAt: PUBLISH_AT,
  schedule: { readAt: new Date(SETTLED.getTime() + 1), complete: true, postRefs: [] }, now: NOW, ...overrides,
});

describe("a Fansly withdrawal's outcome", () => {
  it("a complete read after the answer without the post, its time ahead: withdrawn — once the stand confirmed the list", () => {
    expect(conclusion({ facts: VERIFIED })).toEqual({ kind: "settle", to: "withdrawn", reason: "withdrawn" });
    expect(conclusion()).toEqual({ kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_incomplete" });
    expect(conclusion({ facts: VERIFIED, schedule: { readAt: new Date(SETTLED.getTime() + 1), complete: false, postRefs: [] } }))
      .toEqual({ kind: "settle", to: "unknown", reason: "withdraw_unconfirmed_incomplete" });
  });

  it("still shown after Fansly's answer: unknown", () => {
    expect(conclusion({ facts: VERIFIED, schedule: { readAt: new Date(SETTLED.getTime() + 1), complete: true, postRefs: ["p1"] } }))
      .toEqual({ kind: "settle", to: "unknown", reason: "withdraw_still_in_schedule" });
  });

  it("waits for a read taken after the answer, asking for it; none in 30 minutes: unknown", () => {
    const stale = { readAt: SETTLED, complete: true, postRefs: [] };
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
