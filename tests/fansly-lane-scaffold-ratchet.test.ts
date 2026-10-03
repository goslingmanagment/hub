import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PageSyncLeaseLostError } from "@agency_hub_core/db";
import { FanslyApiError, FanslyProxyMissingError } from "@agency_hub_core/fansly";
import { describe, expect, it } from "vitest";

import {
  createDurableFanslyAttemptBudget,
  FanslyDailyAttemptBudgetExhaustedError,
  isSubjectScopedFanslyFailure,
} from "../apps/runtime/src/services/sync/fansly-lane.ts";

const ROOT = join(__dirname, "..");
const LANE_FILES = [
  "fansly-stats.ts",
  "fansly-media-stats.ts",
  "fansly-notifications.ts",
  "fansly-catalog.ts",
  "fansly-post-replies.ts",
  "fansly-payouts.ts",
] as const;
const FORBIDDEN_PRIVATE_MACHINERY = [
  "AttemptCounter",
  "upsertCaptureCoverage",
  "upsertCheckpointProgress",
  "persistRawPayload",
] as const;

function syncSource(file: string) {
  return readFileSync(
    join(ROOT, "apps/runtime/src/services/sync", file),
    "utf8",
  );
}

/** The response classifiers both Fansly engines share live in the Sync
 *  Engine's lib; the legacy lanes import them from there. */
function engineLibSource(file: string) {
  return readFileSync(
    join(ROOT, "apps/runtime/src/sync/fansly/lib", file),
    "utf8",
  );
}

describe("Fansly lane scaffold ratchet", () => {
  it("keeps budget, journal, checkpoint, coverage and continuation machinery shared", () => {
    for (const file of LANE_FILES) {
      const source = syncSource(file);
      expect(source, `${file} must use the shared lane scaffold`)
        .toContain('from "./fansly-lane.ts"');
      expect(source, `${file} must reserve attempts durably`)
        .toContain("createFanslyLaneRuntime");
      expect(source, `${file} must journal through the ordered helper`)
        .toContain("createFanslyLaneJournal");
      expect(source, `${file} must spread continuations through the shared helper`)
        .toContain("spreadFanslyContinuation");
      for (const forbidden of FORBIDDEN_PRIVATE_MACHINERY) {
        expect(source, `${file} reintroduced private ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("keeps every response family on the shared three-way classifier", () => {
    expect(engineLibSource("stats-rules.ts")).toContain("classifyFanslyResponse");
    expect(engineLibSource("media-stats-rules.ts")).toContain("classifyStatsWindow");
    for (const file of [
      "notifications-rules.ts",
      "catalog-rules.ts",
      "post-replies-rules.ts",
      "payouts-rules.ts",
      "purchase-history.ts",
    ]) {
      expect(engineLibSource(file), `${file} must use the shared response classifier`)
        .toContain("classifyFanslyResponse");
    }
  });

  it("keeps purchase-history journal and checkpoint work on the same scaffold", () => {
    const handlers = syncSource("executor-handlers.ts");
    const start = handlers.indexOf("export async function executePurchaseHistoryChunk");
    const end = handlers.indexOf("\nexport async function", start + 1);
    const purchaseHistory = handlers.slice(start, end < 0 ? undefined : end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(purchaseHistory).toContain("createFanslyLaneRuntime");
    expect(purchaseHistory).toContain("saveProgress: savePurchaseHistoryProgress");
    expect(purchaseHistory).toContain("complete(input.syncRunId");
    expect(purchaseHistory).toContain("createFanslyLaneJournal");
    expect(purchaseHistory).not.toContain("upsertCheckpointProgress");
    expect(purchaseHistory).not.toContain("persistRawPayload");
  });
});

describe("Fansly lane failure scope", () => {
  const retryAfterAt = new Date("2026-09-20T00:10:00.000Z");

  it("scopes only an answer ABOUT the subject to that subject", () => {
    for (
      const error of [
        new FanslyApiError("gone", 404),
        new FanslyApiError("gone", 410),
        new FanslyApiError("bad request", 400),
        // A 4xx carries no deadline the executor reads; re-raised it would park
        // the whole stream as provider_bad_data.
        new FanslyApiError("bad request", 400, undefined, undefined, retryAfterAt),
        new FanslyApiError("Fansly request failed (500)", 500, 500, "error getting media offer"),
        new FanslyApiError("Fansly request failed (502)", 502),
        new FanslyApiError("Fansly response envelope was unsuccessful", 200),
      ]
    ) {
      expect(isSubjectScopedFanslyFailure(error), `${error.message} ${error.status}`).toBe(true);
    }
  });

  it("leaves the session, the provider's pace, the wire and the lease to the executor", () => {
    const transport = new TypeError("fetch failed", {
      cause: new Error("Socks5 proxy rejected connection - NotAllowed"),
    });
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    for (
      const error of [
        new FanslyApiError("unauthorized", 401),
        new FanslyApiError("forbidden", 403),
        new FanslyApiError("Fansly request failed (429)", 429),
        new FanslyApiError("Fansly request failed (429)", 429, undefined, undefined, retryAfterAt),
        new FanslyApiError("Fansly request failed (503)", 503, undefined, undefined, retryAfterAt),
        new FanslyApiError("Fansly session verification returned an invalid account"),
        transport,
        timeout,
        new Error("Socks5 Authentication failed"),
        new FanslyProxyMissingError(),
        new PageSyncLeaseLostError(),
        new FanslyDailyAttemptBudgetExhaustedError(300),
        "not even an error",
      ]
    ) {
      expect(isSubjectScopedFanslyFailure(error), String(error)).toBe(false);
    }
  });

  it("keeps the per-subject lanes on the shared predicate", () => {
    for (const file of ["fansly-media-stats.ts", "fansly-post-replies.ts"]) {
      const source = syncSource(file);
      expect(source, `${file} must scope failures through the shared predicate`)
        .toContain("isSubjectScopedFanslyFailure(error)");
      expect(source, `${file} reintroduced an auth-only rethrow`)
        .not.toContain("isAuthFailure");
    }
  });
});

describe("Fansly lane attempt budget", () => {
  const started = (attemptNumber: number) => ({
    requestId: "account_stats:1",
    state: "started" as const,
    operation: "account_stats",
    endpointTemplate: "/api/v1/it/amoie/stats",
    method: "GET",
    attemptNumber,
    timestamp: new Date("2026-08-20T05:01:00.000Z"),
  });

  it("keeps attempts held back out of a request's retry allowance and its admission", async () => {
    let state = { utcDay: "2026-08-20", callsToday: 1 };
    const budget = createDurableFanslyAttemptBudget({
      dailyCap: 3,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      saveProgress: async () => {},
    });
    const holding = budget.holdingBack(1);

    // Two attempts left today, one of them held for a later request: this one
    // may make one attempt, so the adapter allows it no retry.
    expect(budget.remainingAttempts()).toBe(2);
    expect(holding.remainingAttempts()).toBe(1);
    expect(holding.hasCapacity()).toBe(true);
    await holding.observer.onRequestEvent(started(1));
    expect(state.callsToday).toBe(2);

    // An adapter that retries past its allowance is refused before the wire.
    expect(holding.remainingAttempts()).toBe(0);
    expect(holding.hasCapacity()).toBe(false);
    await expect(holding.observer.onRequestEvent(started(2)))
      .rejects.toBeInstanceOf(FanslyDailyAttemptBudgetExhaustedError);
    expect(state.callsToday).toBe(2);

    // The held attempt is still there for the request it was held for.
    expect(budget.hasCapacity()).toBe(true);
    await budget.observer.onRequestEvent(started(1));
    expect(state.callsToday).toBe(3);
    expect(budget.holdingBack(0).remainingAttempts()).toBe(0);
  });
});
