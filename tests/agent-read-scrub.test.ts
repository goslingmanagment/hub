import { describe, expect, it } from "vitest";

import {
  AGENT_CONCURRENCY_LIMIT,
  AGENT_OBSERVATION_PAYLOAD_ALLOWLIST,
  AGENT_OBSERVATION_PAYLOAD_SESSION_CAP,
  acquireAgentSlot,
  agentConcurrencyInUse,
  agentObservationPayloadAllowed,
  assertWithinAgentBudget,
  releaseAgentSlot,
  resetAgentConcurrencyForTests,
  scrubObservationPayload,
  toSafeNumber,
} from "../apps/runtime/src/modules/agent-read/index.ts";
import { AppError } from "../apps/runtime/src/services/errors.ts";

// Operation 9b's disclosure controls, and the plane's budget/concurrency gauges.

describe("agent read plane: the 9b payload allowlist is fail-closed", () => {
  it("admits exactly the reviewed list", () => {
    expect([...AGENT_OBSERVATION_PAYLOAD_ALLOWLIST].sort()).toEqual([
      "dm_conversations",
      "dm_messages",
      "earnings_transactions",
      "fan_earnings_monthly",
      "fan_earnings_stats",
      "purchase_history",
      "subscribers",
    ]);
  });

  it("refuses the kinds named as forbidden, and everything unknown", () => {
    // A denylist could not work here: the repository's own restricted set is
    // exactly ["desktop.guard_audit"], contains neither of these, and is
    // consulted only on the tiering path rather than on serving.
    for (const kind of [
      "account_me",
      "account_lookup",
      "group_detail",
      "followers",
      "earnings_accounts",
      "some.kind.invented.next.year",
      "desktop.guard_audit",
    ]) {
      expect(agentObservationPayloadAllowed(kind), kind).toBe(false);
    }
  });

  it("refuses every error body, whatever the endpoint", () => {
    expect(agentObservationPayloadAllowed("dm_messages:failed")).toBe(false);
    expect(agentObservationPayloadAllowed("subscribers:failed")).toBe(false);
  });

  it("caps payload reads per owner session", () => {
    expect(AGENT_OBSERVATION_PAYLOAD_SESSION_CAP).toBe(25);
  });
});

describe("agent read plane: the signed-URL scrub", () => {
  it("removes a CloudFront-signed media address whole", () => {
    // Half a signed URL still leaks the policy document, and a stripped one is a
    // broken string pretending to be data. It goes entirely.
    const result = scrubObservationPayload({
      accountMedia: [{
        id: "m1",
        mimetype: "video/mp4",
        locations: [{
          locationId: "loc-1",
          location: "https://cdn.fansly.com/media/m1.mp4?Policy=abc&Signature=def&Key-Pair-Id=K1",
        }],
      }],
    });
    const media = result.payload.accountMedia as Array<Record<string, unknown>>;
    const locations = media[0]?.locations as Array<Record<string, unknown>>;
    expect(locations[0]?.location).toBeNull();
    expect(locations[0]?.locationId).toBe("loc-1");
    expect(result.signedUrlsRemoved).toBe(1);
    expect(result.pathsRemoved).toContain("accountMedia[0].locations[0].location");
  });

  it("removes AWS SigV4 and SAS addresses too", () => {
    const result = scrubObservationPayload({
      a: "https://s3.example.com/x?X-Amz-Signature=aa&X-Amz-Credential=bb",
      b: "https://blob.example.com/x?sv=2020&sig=zz&se=2026",
    });
    expect(result.payload.a).toBeNull();
    expect(result.payload.b).toBeNull();
    expect(result.signedUrlsRemoved).toBe(2);
  });

  it("preserves ordinary non-secret text and unsigned links", () => {
    const result = scrubObservationPayload({
      messages: [{ id: "1", content: "did you get the custom? https://fansly.com/lora" }],
      total: 3,
      ok: true,
    });
    const messages = result.payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toBe("did you get the custom? https://fansly.com/lora");
    expect(result.payload.total).toBe(3);
    expect(result.payload.ok).toBe(true);
    expect(result.signedUrlsRemoved).toBe(0);
  });

  it("redacts secret-shaped keys by NAME, whatever the value looks like", () => {
    const result = scrubObservationPayload({
      authorization: "Bearer abc",
      checkoutKey: "ck_live_123",
      session: { token: "t" },
      username: "rick",
    });
    expect(result.payload.authorization).toBeNull();
    expect(result.payload.checkoutKey).toBeNull();
    expect(result.payload.session).toBeNull();
    expect(result.payload.username).toBe("rick");
    expect(result.secretsRedacted).toBe(3);
  });

  it("fails CLOSED on structure it does not understand", () => {
    // "Unknown shape, must be fine" is how a scrubber quietly stops scrubbing
    // when a vendor adds a field.
    let deep: Record<string, unknown> = { leaf: "https://cdn.example.com/x?Signature=1" };
    for (let depth = 0; depth < 40; depth += 1) {
      deep = { nested: deep };
    }
    const result = scrubObservationPayload(deep);
    expect(result.pathsRemoved.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.payload)).not.toContain("Signature");
  });

  it("a non-object payload becomes an empty object rather than leaking through", () => {
    expect(scrubObservationPayload("https://cdn.example.com/x?Signature=1").payload).toEqual({});
    expect(scrubObservationPayload(null).payload).toEqual({});
  });
});

describe("agent read plane: concurrency and budget", () => {
  it("admits two in flight per key and refuses the third", () => {
    resetAgentConcurrencyForTests();
    const keyId = 1001;
    acquireAgentSlot(keyId);
    acquireAgentSlot(keyId);
    expect(agentConcurrencyInUse(keyId)).toBe(AGENT_CONCURRENCY_LIMIT);
    expect(() => acquireAgentSlot(keyId)).toThrow(AppError);
    try {
      acquireAgentSlot(keyId);
    } catch (error) {
      // A real AppError, not a duck-typed literal: the plugin boundary turns
      // anything else into a static 500.
      expect((error as AppError).statusCode).toBe(429);
      expect((error as AppError).code).toBe("rate_limit_exceeded");
    }
    releaseAgentSlot(keyId);
    expect(() => acquireAgentSlot(keyId)).not.toThrow();
    releaseAgentSlot(keyId);
    releaseAgentSlot(keyId);
  });

  it("a double release cannot hand out a third slot", () => {
    resetAgentConcurrencyForTests();
    const keyId = 1002;
    acquireAgentSlot(keyId);
    releaseAgentSlot(keyId);
    releaseAgentSlot(keyId);
    expect(agentConcurrencyInUse(keyId)).toBe(0);
    acquireAgentSlot(keyId);
    acquireAgentSlot(keyId);
    expect(() => acquireAgentSlot(keyId)).toThrow(AppError);
    releaseAgentSlot(keyId);
    releaseAgentSlot(keyId);
  });

  it("an exhausted budget throws the plane's own 429 code", () => {
    expect(() => assertWithinAgentBudget({
      withinBudget: false,
      requests: 5001,
      dailyRequestBudget: 5000,
      rowsReturned: 0,
      dailyRowBudget: 500_000,
    })).toThrowError(/request budget/);
    try {
      assertWithinAgentBudget({
        withinBudget: false,
        requests: 1,
        dailyRequestBudget: 5000,
        rowsReturned: 500_001,
        dailyRowBudget: 500_000,
      });
    } catch (error) {
      expect((error as AppError).statusCode).toBe(429);
      expect((error as AppError).code).toBe("agent_budget_exhausted");
    }
    expect(() => assertWithinAgentBudget({
      withinBudget: true,
      requests: 1,
      dailyRequestBudget: 5000,
      rowsReturned: 1,
      dailyRowBudget: 500_000,
    })).not.toThrow();
  });
});

describe("agent read plane: the BigInt-to-JSON guard", () => {
  it("converts within the safe range and REFUSES beyond it", () => {
    // The pool parses OID 20 as a BigInt and JSON.stringify throws on one, so a
    // conversion is mandatory. Doing it silently is not acceptable on money:
    // above 2^53 a number stops counting.
    expect(toSafeNumber(123n)).toBe(123);
    expect(toSafeNumber("456")).toBe(456);
    expect(toSafeNumber(null)).toBeNull();
    expect(toSafeNumber(undefined)).toBeNull();
    expect(toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 10n)).toThrow(AppError);
    try {
      toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 10n);
    } catch (error) {
      expect((error as AppError).statusCode).toBe(500);
    }
  });
});
