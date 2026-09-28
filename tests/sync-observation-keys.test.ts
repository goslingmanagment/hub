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
    updatePageMetadata: vi.fn(async () => undefined),
    recordSyncHttpAttemptResponseBodyBytes: vi.fn(async () => true),
  };
});

const {
  recordSyncHttpAttemptResponseBodyBytes,
  runWithPageSyncExecutionContext,
} = await import("@agency_hub_core/db");
const { persistRawPayload, refreshPageMetadata, retentionDate } = await import(
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
  // the fetch counter, so followers_reconcile's sweep-start account_me and its
  // terminal verification account_me (a later chunk) both keyed
  // `7:followers_reconcile:norun:42.1` and the second was silently dropped.
  it("keys account_me by run so continuation chunks of one request both journal", async () => {
    captured.observations.length = 0;
    captured.raws.length = 0;
    vi.mocked(recordSyncHttpAttemptResponseBodyBytes).mockClear();
    const app = (followCount: number) => ({
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: {
        getAccountMe: vi.fn(async () => ({
          raw: { account: { id: "a1", followCount } },
          parsed: {
            account: {
              id: "a1",
              username: "u",
              displayName: "d",
              followCount,
              subscriberCount: 1,
              createdAt: 0,
            },
          },
        })),
      },
    }) as never;
    const pageContext = {
      page: { id: 7, metadata: {} },
      session: {},
      proxy: {},
      egressKey: "e",
    } as never;
    const telemetry = (runId: number) => ({
      metadata: { runId },
      getRequestObserver: () => null,
    }) as never;
    const chunk = { pageId: 7, stream: "followers_reconcile" as const, requestSeq: 42, leaseToken: "t" };

    await runWithPageSyncExecutionContext(
      { ...chunk },
      () => refreshPageMetadata(app(100), pageContext, undefined, telemetry(11)),
    );
    await runWithPageSyncExecutionContext(
      { ...chunk },
      () => refreshPageMetadata(app(99), pageContext, undefined, telemetry(12)),
    );

    expect(captured.observations.map((o) => o.idempotencyKey)).toEqual([
      "7:followers_reconcile:11:42.1",
      "7:followers_reconcile:12:42.1",
    ]);
    expect(captured.raws).toEqual([
      { endpoint: "account_me", syncRunId: 11 },
      { endpoint: "account_me", syncRunId: 12 },
    ]);
    // The body size now lands on account_me's own attempt, not the next one.
    expect(vi.mocked(recordSyncHttpAttemptResponseBodyBytes).mock.calls.map(([, input]) => input))
      .toEqual([
        expect.objectContaining({ syncRunId: 11, stream: "followers_reconcile" }),
        expect.objectContaining({ syncRunId: 12, stream: "followers_reconcile" }),
      ]);
  });

  it("leaves account_me run-less outside the executor (CLI and catalog callers)", async () => {
    captured.observations.length = 0;
    captured.raws.length = 0;
    const app = {
      db: {},
      config: { syncSharedRateLimitEnabled: false },
      adapter: {
        getAccountMe: vi.fn(async () => ({
          raw: { account: { id: "a1" } },
          parsed: {
            account: { id: "a1", username: "u", displayName: "d", followCount: 1, subscriberCount: 1 },
          },
        })),
      },
    } as never;
    const pageContext = { page: { id: 7, metadata: {} }, session: {}, proxy: {}, egressKey: "e" } as never;

    await refreshPageMetadata(app, pageContext, "light");

    expect(captured.raws).toEqual([{ endpoint: "account_me", syncRunId: null }]);
    expect(captured.observations[0]?.idempotencyKey).toMatch(/^7:account_me:norun:[0-9a-f-]{36}$/);
  });
});
