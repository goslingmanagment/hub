import { describe, expect, it } from "vitest";
import { resolveFanslyWsHintPolicy, FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";
import { canonicalizeFanslyWsObservation } from "../apps/runtime/src/services/canonicalize/fansly-ws.ts";

const generation = "a".repeat(64);
const config = {
  fanslyWsCaptureEnabled: true, fanslyWsCapturePageAllowlist: "lilly-1",
  fanslyWsHintsEnabled: true, fanslyWsHintsPageAllowlist: "lilly-1",
  fanslyWsHintsTypeAllowlist: "message_created",
  fanslyWsHintsPolicies: JSON.stringify({ "lilly-1": {
    generation, activationAt: "2026-09-15T00:00:00Z", baselineAttempts24h: 203,
    baselineReference: "test-baseline", } }),
};

describe("B1 activation policy", () => {
  it("grants no requests by default, to an adjacent page, or to a wildcard", () => {
    expect(resolveFanslyWsHintPolicy({}, "lilly-1")).toBeNull();
    expect(resolveFanslyWsHintPolicy(config, "lilly-10")).toBeNull();
    expect(resolveFanslyWsHintPolicy({ ...config, fanslyWsHintsPageAllowlist: "*" }, "lilly-1")).toBeNull();
  });
  it.each([
    { fanslyWsCaptureEnabled: false }, { fanslyWsHintsEnabled: false },
    { fanslyWsCapturePageAllowlist: "" }, { fanslyWsHintsPageAllowlist: "none" },
    { fanslyWsHintsTypeAllowlist: "delete,typing" }, { fanslyWsHintsPolicies: "{}" },
    { fanslyWsHintsPolicies: "not-json" },
    { fanslyWsHintsPolicies: JSON.stringify({ "lilly-1": { baselineAttempts24h: 1000 } }) },
  ])("fails closed for an incomplete or disabled policy %j", (change) => {
    expect(resolveFanslyWsHintPolicy({ ...config, ...change }, "lilly-1")).toBeNull();
  });
  it("rounds down the fixed five-percent budget and enables types separately", () => {
    const policy = resolveFanslyWsHintPolicy(config, "lilly-1");
    expect(policy?.maxAttempts24h).toBe(10);
    expect([...policy!.enabledTypes]).toEqual(["message_created"]);
  });
});

describe("B1 canonical signal material", () => {
  const observation = {
    id: 42, accountId: 4, platform: "fansly", source: "fansly_ws", producer: "fansly:b0",
    kind: FANSLY_WS_CAPTURE_KIND, observedAt: null, receivedAt: new Date("2026-09-15T01:00:00Z"),
    payload: { codec: FANSLY_WS_CAPTURE_KIND, generation, frame: JSON.stringify({ t: 10000, d: {
      serviceId: 5, event: { type: 1, message: { id: "200", groupId: "100", text: "private-body", token: "secret" } },
    } }) },
  };
  it("retains only routing metadata and receipt time, with stable per-observation dedup", () => {
    const events = canonicalizeFanslyWsObservation(observation);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ conversationRef: "100", messageRef: "200", occurredAt: observation.receivedAt,
      data: { generation, outcome: "hint" } });
    expect(JSON.stringify(events)).not.toMatch(/private-body|secret/);
    expect(canonicalizeFanslyWsObservation(observation)).toEqual(events);
    expect(canonicalizeFanslyWsObservation({ ...observation, id: 43 })[0]?.dedupKey).not.toBe(events[0]?.dedupKey);
  });
  it("does not invent a generation for old B0 material", () => {
    const { generation: _generation, ...payload } = observation.payload;
    expect(canonicalizeFanslyWsObservation({ ...observation, payload })[0]?.data.generation).toBeNull();
    expect(canonicalizeFanslyWsObservation({ ...observation, source: "pull" })).toEqual([]);
  });
});
