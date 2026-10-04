import { describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

// Stage 7 producer 2 regression (review R1-3): requestSeq is chunk-constant,
// so every observation after the first in a multi-fetch chunk shared its
// idempotency key and was silently dropped by the (source, key) claim. The
// key must be unique per fetch within a chunk.

const captured = vi.hoisted(() => ({
  observations: [] as Array<{ idempotencyKey: string; kind: string; payload: unknown }>,
  raws: [] as Array<{ endpoint: string; syncRunId: number | null | undefined }>,
}));

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    // Both doubles return the REAL receipt shape. Since decision #222 the
    // repositories report whether the catalog object a supplied reference
    // addressed was still there when the row was written, and the seam reads
    // that flag to count the erasure race — a double that returns less than the
    // contract makes the seam look broken when it is the double that is stale.
    insertRawPayload: vi.fn(async (
      _db: unknown,
      input: { endpoint: string; syncRunId?: number | null },
    ) => {
      captured.raws.push({ endpoint: input.endpoint, syncRunId: input.syncRunId });
      return {
        id: 1,
        capturedAt: new Date(0),
        payloadRefVanished: false,
      };
    }),
    insertObservation: vi.fn(async (
      _db: unknown,
      input: { idempotencyKey: string; kind: string; payload: unknown },
    ) => {
      captured.observations.push(input);
      return { inserted: true, payloadRefVanished: false };
    }),
    recordSyncHttpAttemptResponseBodyBytes: vi.fn(async () => true),
  };
});

const {
  recordSyncHttpAttemptResponseBodyBytes,
  runWithPageSyncExecutionContext,
} = await import("@agency_hub_core/db");
const { persistRawPayload, retentionDate } = await import(
  "../apps/runtime/src/services/sync/shared.ts"
);

function payload(endpoint: string) {
  return {
    platformAccountId: 7,
    syncRunId: 11,
    endpoint,
    requestParams: {},
    responsePayload: { page: endpoint },
    mapperVersion: "test-v1",
    payloadKind: "mapping_critical" as const,
    retainUntil: retentionDate(),
  };
}

describe("persistRawPayload observation keys", () => {
  it("gives every fetch in one chunk its own key (multi-page loops journal fully)", async () => {
    captured.observations.length = 0;
    await runWithPageSyncExecutionContext(
      { pageId: 7, stream: "fan_earnings", requestSeq: 42, leaseToken: "t" },
      async () => {
        await persistRawPayload({} as never, payload("fan_earnings_stats"), { platform: "fansly" });
        await persistRawPayload({} as never, payload("fan_earnings_monthly"), { platform: "fansly" });
      },
    );
    const keys = captured.observations.map((o) => o.idempotencyKey);
    expect(keys).toEqual(["7:fan_earnings:11:42.1", "7:fan_earnings:11:42.2"]);
  });

  it("falls back to unique random keys outside an executor context", async () => {
    captured.observations.length = 0;
    await persistRawPayload({} as never, payload("fan_earnings_stats"), { platform: "fansly" });
    await persistRawPayload({} as never, payload("fan_earnings_stats"), { platform: "fansly" });
    const keys = captured.observations.map((o) => o.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("keeps the endpoint kind while journaling an explicit quarantine envelope", async () => {
    captured.observations.length = 0;
    const envelope = {
      quarantine: "fansly_post_tips_scope_v1",
      requestedTargetIds: ["post-1"],
      response: [{ id: "tip-1" }],
    };
    await persistRawPayload({} as never, payload("post_tips"), {
      platform: "fansly",
      observationPayload: envelope,
    });
    expect(captured.observations).toEqual([
      expect.objectContaining({ kind: "post_tips", payload: envelope }),
    ]);
  });

  // J4: continuation chunks of one request share requestSeq and each restarts
  // the fetch counter, so a capture a later chunk repeats would key
  // `7:subscribers:norun:42.1` both times and the second would be silently
  // dropped. A caller in a chunk passes its run id, which keys each chunk apart.
  it("keys a capture by run so continuation chunks of one request both journal", async () => {
    captured.observations.length = 0;
    captured.raws.length = 0;
    vi.mocked(recordSyncHttpAttemptResponseBodyBytes).mockClear();
    const chunk = { pageId: 7, stream: "subscribers" as const, requestSeq: 42, leaseToken: "t" };

    await runWithPageSyncExecutionContext(
      { ...chunk },
      () => persistRawPayload({} as never, { ...payload("ofapi_fans_active"), syncRunId: 11 }, { platform: "onlyfans" }),
    );
    await runWithPageSyncExecutionContext(
      { ...chunk },
      () => persistRawPayload({} as never, { ...payload("ofapi_fans_active"), syncRunId: 12 }, { platform: "onlyfans" }),
    );

    expect(captured.observations.map((o) => o.idempotencyKey)).toEqual([
      "7:subscribers:11:42.1",
      "7:subscribers:12:42.1",
    ]);
    expect(captured.raws).toEqual([
      { endpoint: "ofapi_fans_active", syncRunId: 11 },
      { endpoint: "ofapi_fans_active", syncRunId: 12 },
    ]);
    // The body size lands on the capture's own attempt of its own run.
    expect(vi.mocked(recordSyncHttpAttemptResponseBodyBytes).mock.calls.map(([, input]) => input))
      .toEqual([
        expect.objectContaining({ syncRunId: 11, stream: "subscribers" }),
        expect.objectContaining({ syncRunId: 12, stream: "subscribers" }),
      ]);
  });

  it("leaves a capture run-less outside the executor", async () => {
    captured.observations.length = 0;
    captured.raws.length = 0;

    await persistRawPayload({} as never, { ...payload("ofapi_link_stats"), syncRunId: null }, { platform: "onlyfans" });

    expect(captured.raws).toEqual([{ endpoint: "ofapi_link_stats", syncRunId: null }]);
    expect(captured.observations[0]?.idempotencyKey).toMatch(/^7:ofapi_link_stats:norun:[0-9a-f-]{36}$/);
  });
});
