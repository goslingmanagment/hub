import { describe, expect, it } from "vitest";

import {
  normalizeErrorSummary,
  normalizeSyncError,
  SyncPayloadPersistenceError,
} from "../apps/runtime/src/services/sync/errors.ts";

describe("sync error normalization", () => {
  it("truncates generic sync errors to a bounded summary", () => {
    const longMessage = "x".repeat(1500);
    const normalized = normalizeSyncError(new Error(longMessage), {
      endpoint: "followers",
      action: "running follower sync",
    });

    expect(normalized.summary.length).toBeLessThanOrEqual(1024);
    expect(normalized.summary.endsWith("...")).toBe(true);
    expect(normalized.error).toMatchObject({
      type: "Error",
      endpoint: "followers",
      truncated: true,
      originalMessageLength: 1500,
    });
  });

  it("sanitizes query-style payload persistence errors", () => {
    const drizzleError = new Error(
      "Failed query: insert into raw_payloads values (...) params: [huge serialized payload]",
    );
    drizzleError.name = "DrizzleQueryError";
    (drizzleError as Error & { cause: { code: string } }).cause = { code: "54000" };

    const normalized = normalizeSyncError(
      new SyncPayloadPersistenceError({
        endpoint: "followers",
        action: "inserting followers raw payload",
        cause: drizzleError,
      }),
      {
        endpoint: "followers",
        action: "running follower sync",
      },
    );

    expect(normalized).toEqual({
      summary: "DrizzleQueryError while inserting followers raw payload (54000)",
      error: {
        type: "DrizzleQueryError",
        summary: "DrizzleQueryError while inserting followers raw payload (54000)",
        endpoint: "followers",
        code: "54000",
        truncated: true,
        originalMessageLength: drizzleError.message.length,
      },
    });
    expect(normalized.summary).not.toContain("Failed query:");
    expect(normalized.summary).not.toContain("params:");
  });

  it("bounds arbitrary run summaries before persistence", () => {
    const summary = normalizeErrorSummary("y".repeat(1500));

    expect(summary).not.toBeNull();
    expect(summary!.length).toBeLessThanOrEqual(1024);
    expect(summary!.endsWith("...")).toBe(true);
  });
});
