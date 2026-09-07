import { afterEach, describe, expect, it, vi } from "vitest";

import { OfapiCollectionPolicyError } from "@agency_hub_core/db";
import type { HttpRequestEvent } from "@agency_hub_core/shared";

import { OfapiCollectionRefusedError } from "../apps/runtime/src/services/errors.ts";
import { ofapiCollectionRefusal } from "../apps/runtime/src/services/ofapi-read-gateway.ts";
import {
  createOfapiClient,
  OfapiApiError,
  OfapiGovernedRequestError,
} from "../apps/runtime/src/services/ofapi.ts";

const ACCOUNT = "acct_01000000000000000000000000000000";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OFAPI collection-policy refusals (review #136)", () => {
  it("maps a time-bound cap to 429 with the reset advice and a policy state to 409", () => {
    const now = new Date("2026-09-07T22:00:00.000Z");
    const capped = new OfapiCollectionRefusedError("daily_limit", {
      retryAt: new Date("2026-09-08T00:00:00.000Z"),
      now,
    });
    expect(capped).toMatchObject({
      statusCode: 429,
      code: "ofapi_collection_refused",
      reason: "daily_limit",
      retryAfterMs: 2 * 3600 * 1000,
    });
    expect(new OfapiCollectionRefusedError("interval_limit", { retryAt: new Date(now.getTime() - 1), now }).retryAfterMs).toBe(0);

    for (const reason of ["background_paused", "collection_off", "on_demand_only", "detail_disabled", "job_limit", "unregistered_operation"]) {
      const refused = new OfapiCollectionRefusedError(reason);
      expect(refused, reason).toMatchObject({ statusCode: 409, code: "ofapi_collection_refused", reason, retryAfterMs: null });
    }
    // Static messages: the reason is a machine field, never interpolated prose.
    expect(new OfapiCollectionRefusedError("collection_off").message).not.toContain("collection_off");
  });

  it("recognises the repository refusal raw and as a governed pre-dispatch cause, nothing else", () => {
    const resetAt = new Date("2026-09-08T00:00:00.000Z");
    const policy = new OfapiCollectionPolicyError("daily_limit", { retryAt: resetAt });
    expect(policy.code).toBe("ofapi_collection_daily_limit");

    const raw = ofapiCollectionRefusal(policy);
    expect(raw).toBeInstanceOf(OfapiCollectionRefusedError);
    expect(raw).toMatchObject({ statusCode: 429, reason: "daily_limit" });
    expect(raw!.retryAfterMs).toBeGreaterThan(0);

    const governed = ofapiCollectionRefusal(new OfapiGovernedRequestError(
      "OFAPI collection policy refused dispatch",
      "pre_dispatch",
      "cancelled",
      { cause: new OfapiCollectionPolicyError("collection_off") },
    ));
    expect(governed).toMatchObject({ statusCode: 409, reason: "collection_off", retryAfterMs: null });

    expect(ofapiCollectionRefusal(new OfapiApiError("upstream", null, null))).toBeNull();
    expect(ofapiCollectionRefusal(new OfapiGovernedRequestError("lost fence", "pre_dispatch", "cancelled"))).toBeNull();
    expect(ofapiCollectionRefusal(new OfapiGovernedRequestError(
      "transport", "post_dispatch", "transport", { cause: new OfapiCollectionPolicyError("collection_off") },
    ))).toBeNull();
  });

  it("journals an observed sync read refused before the fetch as failure kind policy, once, unchanged", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const resetAt = new Date("2026-09-08T00:00:00.000Z");
    const refusal = new OfapiCollectionPolicyError("daily_limit", { retryAt: resetAt });
    const events: HttpRequestEvent[] = [];
    const client = createOfapiClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key",
      restDelayMs: 0,
      beforeCollectionRequest: async () => { throw refusal; },
    });

    await expect(client.listTransactions!({
      pageId: 42,
      requestObserver: { onRequestEvent: async (event) => { events.push(event); } },
    }, ACCOUNT, { limit: 100, pageIndex: 1 })).rejects.toBe(refusal);

    // No vendor call, no transport retry: exactly one attempt, journaled under
    // its own kind so the sync ledger never shows a local cap as an outage.
    expect(fetch).not.toHaveBeenCalled();
    expect(events.map((event) => event.state)).toEqual(["started", "failed"]);
    expect(events[1]).toMatchObject({
      state: "failed",
      failureKind: "policy",
      errorMessage: "OFAPI collection policy refused ofapi_transactions: daily_limit",
    });
    expect((events[1] as { httpStatus?: number | null }).httpStatus ?? null).toBeNull();
  });
});
