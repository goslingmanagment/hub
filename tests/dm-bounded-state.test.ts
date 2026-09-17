import { describe, expect, it } from "vitest";
import { advanceDmBoundedStop, dmFullSweepCompletedAt, dmFullSweepDue, dmFullSweepFreshnessSlaSeconds,
  parseDmBoundedSweepState, resolveDmBoundedPolicy,
  type DmBoundedSweepState } from "../apps/runtime/src/services/sync/dm-bounded-state.ts";
import { parseDmConversationSweepState } from "../apps/runtime/src/services/sync/cursor-state.ts";

const proof = { startedAt: "2026-09-15T00:00:00.000Z", completedAt: "2026-09-15T00:12:00.000Z", anchorSlot: 100 };
const schedule = { anchorSlot: 100, slotOffsetSeconds: 0, lastCertifiedFull: proof };
const bounded: DmBoundedSweepState = {
  kind: "bounded", version: 2, mode: "bounded", generation: 7,
  completedAt: null, offset: 200, pageCount: 2, observedCount: 200,
  unchangedPageStreak: 2, providerTotalMode: "present", providerReportedTotal: 500,
  fullSweepStartedAt: "2026-09-15T00:30:00.000Z", lastFullSweepCompletedAt: proof.completedAt,
  polling: schedule, previousTimestampMs: null, stopInvalidated: false,
};
const item = { unchanged: true, listMessageId: "1", embeddedMessageId: "1", timestampMs: Date.parse("2026-09-14T23:58:00Z") };

describe("A1 bounded contract", () => {
  it("leaves full30 at every old slot and anchors longer intervals to start, not completion", () => {
    const base = { schedule, cadenceSeconds: 1800, slotOffsetSeconds: 0 };
    expect(dmFullSweepDue({ ...base, currentSlot: 101, policy: { fullIntervalMinutes: 30 } })).toBe(true);
    expect(dmFullSweepDue({ ...base, currentSlot: 101, policy: { fullIntervalMinutes: 60 } })).toBe(false);
    expect(dmFullSweepDue({ ...base, currentSlot: 102, policy: { fullIntervalMinutes: 60 } })).toBe(true);
    expect(dmFullSweepDue({ ...base, currentSlot: 101, slotOffsetSeconds: 900, policy: { fullIntervalMinutes: 60 } })).toBe(true);
  });

  it("derives the full-list freshness target from the accepted interval plus one slot", () => {
    expect(dmFullSweepFreshnessSlaSeconds(null, 3600)).toBe(3600);
    expect(dmFullSweepFreshnessSlaSeconds({ fullIntervalMinutes: 30 }, 3600)).toBe(3600);
    expect(dmFullSweepFreshnessSlaSeconds({ fullIntervalMinutes: 60 }, 3600)).toBe(5400);
    expect(dmFullSweepFreshnessSlaSeconds({ fullIntervalMinutes: 180 }, 3600)).toBe(12600);
    expect(dmFullSweepFreshnessSlaSeconds({ fullIntervalMinutes: 360 }, 3600)).toBe(23400);
    expect(dmFullSweepFreshnessSlaSeconds(null, null)).toBeNull();
  });

  it("does not hide a 00:10 change behind a full that finished at 00:12", () => {
    expect(advanceDmBoundedStop(bounded, [{ ...item, timestampMs: Date.parse("2026-09-15T00:10:00Z") }]).unchangedPageStreak).toBe(0);
    expect(advanceDmBoundedStop(bounded, [item]).unchangedPageStreak).toBe(3);
  });

  it.each([
    { ...item, unchanged: false }, { ...item, embeddedMessageId: "2" },
    { ...item, timestampMs: null }, { ...item, listMessageId: null },
  ])("continues on changed state or an uncertain raw marker", (changed) => {
    expect(advanceDmBoundedStop(bounded, [changed]).unchangedPageStreak).toBe(0);
  });

  it("retains order violations through resume and does not stop on split timestamp ties", () => {
    const tied = { ...bounded, previousTimestampMs: item.timestampMs };
    expect(advanceDmBoundedStop(tied, [item]).unchangedPageStreak).toBe(0);
    const violation = advanceDmBoundedStop({ ...bounded, previousTimestampMs: item.timestampMs! - 1 }, [item]);
    expect(violation.stopInvalidated).toBe(true);
    expect(advanceDmBoundedStop({ ...bounded, ...violation }, [{ ...item, timestampMs: item.timestampMs! - 2 }]).unchangedPageStreak).toBe(0);
  });

  it("roundtrips bounded continuation while the old full parser refuses it", () => {
    expect(parseDmBoundedSweepState(JSON.parse(JSON.stringify(bounded)))).toEqual(bounded);
    expect(parseDmConversationSweepState(bounded)).toBeNull();
    expect(parseDmBoundedSweepState({ ...bounded, polling: undefined })).toBeNull();
  });

  it("uses only certified full completion for freshness, never bounded completion", () => {
    const now = new Date("2026-09-15T02:00:00Z");
    expect(dmFullSweepCompletedAt({ ...bounded, completedAt: now.toISOString() }, now)).toBe(proof.completedAt);
    expect(dmFullSweepCompletedAt({ ...bounded, lastFullSweepCompletedAt: now.toISOString() }, now)).toBeNull();
    expect(dmFullSweepCompletedAt({ version: 2, mode: "full_scan" }, now)).toBeUndefined();
  });

  it("requires explicit enabled page and a valid per-page policy", () => {
    const config = { fanslyDmBoundedEnabled: true, fanslyDmBoundedPageAllowlist: "lilly-1", fanslyDmBoundedPolicies: '{"lilly-1":{"fullIntervalMinutes":60}}' };
    expect(resolveDmBoundedPolicy(config, "lilly-1")).toEqual({ fullIntervalMinutes: 60 });
    expect(resolveDmBoundedPolicy({}, "lilly-1")).toBeNull();
    expect(resolveDmBoundedPolicy({ ...config, fanslyDmBoundedEnabled: false }, "lilly-1")).toBeNull();
    expect(resolveDmBoundedPolicy({ ...config, fanslyDmBoundedPageAllowlist: "" }, "lilly-1")).toBeNull();
    expect(resolveDmBoundedPolicy({ ...config, fanslyDmBoundedPolicies: "{" }, "lilly-1")).toBeNull();
    expect(resolveDmBoundedPolicy({ ...config, fanslyDmBoundedPolicies: '{"lilly-1":{"fullIntervalMinutes":90}}' }, "lilly-1")).toBeNull();
  });
});
