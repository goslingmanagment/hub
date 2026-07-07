import { describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

// Stage 7 producer 2 regression (review R1-3): requestSeq is chunk-constant,
// so every observation after the first in a multi-fetch chunk shared its
// idempotency key and was silently dropped by the (source, key) claim. The
// key must be unique per fetch within a chunk.

const captured = vi.hoisted(() => ({
  observations: [] as Array<{ idempotencyKey: string }>,
}));

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    insertRawPayload: vi.fn(async () => {}),
    insertObservation: vi.fn(async (_db: unknown, input: { idempotencyKey: string }) => {
      captured.observations.push(input);
      return { inserted: true };
    }),
  };
});

const { runWithPageSyncExecutionContext } = await import("@agency_hub_core/db");
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
});
