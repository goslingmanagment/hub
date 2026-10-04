import { describe, expect, it } from "vitest";

import { OfapiApiError } from "../apps/runtime/src/services/ofapi.ts";
import {
  boundSyncErrorSummary,
  buildNormalizedSyncError,
  SyncPayloadPersistenceError,
} from "../apps/runtime/src/services/sync/errors.ts";

describe("sync error normalization", () => {
  it("truncates generic sync errors to a bounded summary", () => {
    const longMessage = "x".repeat(1500);
    const normalized = buildNormalizedSyncError(new Error(longMessage), {
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
      // Nothing to journal: a plain Error carries no provider response.
      responseSnippet: null,
    });
  });

  it("sanitizes query-style payload persistence errors", () => {
    const drizzleError = new Error(
      "Failed query: insert into sync_raw_payloads values (...) params: [huge serialized payload]",
    );
    drizzleError.name = "DrizzleQueryError";
    (drizzleError as Error & { cause: { code: string } }).cause = { code: "54000" };

    const normalized = buildNormalizedSyncError(
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
        responseSnippet: null,
      },
    });
    expect(normalized.summary).not.toContain("Failed query:");
    expect(normalized.summary).not.toContain("params:");
  });

  // Decision #248: a stream blocked on a provider's 422 whose journaled
  // failure held only the summary could not be diagnosed — the body it came
  // with is the fact that makes the block diagnosable. The legacy executor
  // serves OnlyFans only (step 4), so the provider here is OFAPI.
  it("redacts and bounds an OFAPI response body before journaling it", () => {
    const body = [
      '{"error":"unprocessable","hint":"retry with token=s3cr3tvalue0001",',
      '"authorization":"Bearer abcdef0123456789abcdef",',
      `"detail":"${"z".repeat(2000)}"}`,
    ].join("");
    const normalized = buildNormalizedSyncError(
      new OfapiApiError("OFAPI request failed (422)", 422, body.slice(0, 2000)),
      {
        endpoint: "ofapi_dm",
        action: "running OFAPI DM sync",
      },
    );

    expect(normalized.summary).toBe("OFAPI request failed (422)");
    expect(normalized.error.summary).toBe("OFAPI request failed (422)");

    const snippet = normalized.error.responseSnippet;
    expect(snippet).not.toBeNull();
    expect(snippet!.length).toBeLessThanOrEqual(400);
    expect(snippet).toContain("token=[REDACTED]");
    expect(snippet).not.toContain("s3cr3tvalue0001");
    expect(snippet).not.toContain("abcdef0123456789abcdef");
    // The unredacted head still reaches the journal — that is the diagnostic.
    expect(snippet).toContain('"error":"unprocessable"');
  });

  it("keeps a bodyless OFAPI failure null", () => {
    const normalized = buildNormalizedSyncError(
      new OfapiApiError("OFAPI text command payload is invalid", 422, null),
      {
        endpoint: "ofapi_dm",
        action: "running OFAPI DM sync",
      },
    );

    expect(normalized.error.responseSnippet).toBeNull();
  });

  it("unwraps a persistence error to reach the provider snippet", () => {
    const normalized = buildNormalizedSyncError(
      new SyncPayloadPersistenceError({
        endpoint: "ofapi_dm",
        action: "inserting ofapi_dm raw payload",
        cause: new OfapiApiError("OFAPI request failed (422)", 422, '{"code":4}'),
      }),
      {
        endpoint: "ofapi_dm",
        action: "running OFAPI DM sync",
      },
    );

    expect(normalized.error.responseSnippet).toBe('{"code":4}');
  });

  it("journals no snippet for an error of any other class, whatever it carries", () => {
    const foreign = Object.assign(new Error("request failed (422)"), { status: 422, responseSnippet: '{"code":4}', body: '{"code":4}' });
    const normalized = buildNormalizedSyncError(foreign, {
      endpoint: "subscribers",
      action: "running subscribers sync",
    });

    expect(normalized.summary).toBe("request failed (422)");
    expect(normalized.error.responseSnippet).toBeNull();
  });

  it("bounds arbitrary run summaries before persistence", () => {
    const summary = boundSyncErrorSummary("y".repeat(1500));

    expect(summary).not.toBeNull();
    expect(summary!.length).toBeLessThanOrEqual(1024);
    expect(summary!.endsWith("...")).toBe(true);
  });
});
