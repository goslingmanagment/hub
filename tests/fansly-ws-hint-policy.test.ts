import { describe, expect, it } from "vitest";
import { resolveFanslyWsHintPolicy, FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";
import { canonicalizeFanslyWsObservation } from "../apps/runtime/src/services/canonicalize/fansly-ws.ts";

const generation = "a".repeat(64);
const config = {
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
  it("no longer asks the retired B0 capture flags: the legacy receiver is gone (step 4, S4-12)", () => {
    const retired = { fanslyWsCaptureEnabled: false, fanslyWsCapturePageAllowlist: "" };
    expect(resolveFanslyWsHintPolicy({ ...config, ...retired }, "lilly-1")).not.toBeNull();
  });
  it.each([
    { fanslyWsHintsEnabled: false }, { fanslyWsHintsPageAllowlist: "none" },
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
  const bounded = (change: Record<string, unknown>) => ({ ...config,
    fanslyWsHintsPolicies: JSON.stringify({ "lilly-1": {
      generation, activationAt: "2026-09-15T00:00:00Z", baselineAttempts24h: 203,
      baselineReference: "test-baseline", ...change,
    } }),
  });
  it("expires at the exact deadline, including when the flag remains enabled", () => {
    const timed = bounded({ expiresAt: "2026-09-15T04:00:00+03:00" });
    expect(resolveFanslyWsHintPolicy(timed, "lilly-1", new Date("2026-09-15T00:59:59.999Z"))).not.toBeNull();
    expect(resolveFanslyWsHintPolicy(timed, "lilly-1", new Date("2026-09-15T01:00:00Z"))).toBeNull();
    expect(resolveFanslyWsHintPolicy(timed, "lilly-1", new Date("2026-09-16T00:00:00Z"))).toBeNull();
  });
  it.each([
    { expiresAt: "invalid" }, { expiresAt: "2026-09-15T00:00:00Z" },
    { expiresAt: "2026-09-14T23:59:59Z" }, { expiresAt: null },
    { attemptLimit24h: 0 }, { attemptLimit24h: -1 }, { attemptLimit24h: 1.5 },
    { attemptLimit24h: "2" }, { attemptLimit24h: null },
  ])("refuses a malformed or nonpositive canary bound %j", change => {
    expect(resolveFanslyWsHintPolicy(bounded(change), "lilly-1", new Date("2026-09-15T00:30:00Z"))).toBeNull();
  });
  it("only tightens the five-percent allowance without changing its measured baseline", () => {
    expect(resolveFanslyWsHintPolicy(bounded({ attemptLimit24h: 2 }), "lilly-1"))
      .toMatchObject({ maxAttempts24h: 2, baselineAttempts24h: 203, baselineReference: "test-baseline" });
    expect(resolveFanslyWsHintPolicy(bounded({ attemptLimit24h: 999 }), "lilly-1")?.maxAttempts24h).toBe(10);
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
