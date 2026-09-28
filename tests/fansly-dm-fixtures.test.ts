import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeDmTipAmountCents,
  normalizeFanslyTimestamp,
  trimFanslyMessagingGroupsPayload,
} from "../apps/runtime/src/services/sync/shared.ts";
import { resolveDmConversationCoverageStatus } from "../apps/runtime/src/services/sync/fansly-dm-messages.ts";
import { FanslyAdapter } from "../packages/fansly/src/adapter.ts";

async function loadResponseFixture<T>(name: string) {
  const file = path.resolve("tests/fixtures/fansly", name);
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw) as {
    data: {
      success: boolean;
      response: T;
    };
  };

  return parsed.data;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Fansly DM fixtures", () => {
  it("parses rich messaging_groups payloads with aggregation data", async () => {
    const fixture = await loadResponseFixture<{
      data: Array<Record<string, unknown>>;
      aggregationData?: {
        total?: number;
        accounts?: Array<Record<string, unknown>>;
        groups?: Array<Record<string, unknown>>;
      };
    }>("messaging_groups.json");
    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });
    vi.spyOn(adapter as unknown as { request: () => Promise<unknown> }, "request").mockResolvedValue({
      parsed: fixture.response,
      raw: fixture.response,
    });

    const result = await adapter.getMessagingGroupsPage({
      session: {
        authorization: "token",
      },
    }, {
      offset: 0,
      limit: 100,
      sortOrder: 1,
      flags: 0,
    });

    expect(result.total).toBe(fixture.response.aggregationData?.total);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.accounts.length).toBeGreaterThan(0);
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.items[0]).toMatchObject({
      groupId: "group_alpha",
      partnerAccountId: "acct_fan_alpha",
    });
    expect(result.groups[0]).toMatchObject({
      id: "group_alpha",
    });
    expect(result.groups.some((group) => (
      typeof group.lastMessage?.id === "string" &&
      typeof group.lastMessage?.createdAt === "number"
    ))).toBe(true);
  });

  it("parses thin messaging_groups payloads without aggregated groups or accounts", async () => {
    const fixture = await loadResponseFixture<{
      data: Array<Record<string, unknown>>;
      aggregationData?: {
        total?: number;
      };
    }>("messaging_groups.json");
    const payload = {
      success: fixture.success,
      response: {
        ...fixture.response,
        aggregationData: {
          total: fixture.response.aggregationData?.total,
        },
      },
    };

    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });
    vi.spyOn(adapter as unknown as { request: () => Promise<unknown> }, "request").mockResolvedValue({
      parsed: payload.response,
      raw: payload.response,
    });

    const result = await adapter.getMessagingGroupsPage({
      session: {
        authorization: "token",
      },
    }, {
      offset: 0,
      limit: 100,
      sortOrder: 1,
      flags: 0,
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.accounts).toEqual([]);
    expect(result.groups).toEqual([]);
  });

  it("parses group_detail payloads with a last message head", async () => {
    const fixture = await loadResponseFixture<Record<string, unknown>>("group_detail.json");
    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });
    vi.spyOn(adapter as unknown as { request: () => Promise<unknown> }, "request").mockResolvedValue({
      parsed: fixture.response,
      raw: fixture.response,
    });

    const result = await adapter.getGroupDetail({
      session: {
        authorization: "token",
      },
    }, "group_alpha");

    expect(result.parsed).toMatchObject({
      id: "group_alpha",
      users: expect.arrayContaining([
        expect.objectContaining({ userId: "acct_fan_alpha" }),
        expect.objectContaining({ userId: "acct_creator" }),
      ]),
    });
    expect(result.parsed.lastMessage).toMatchObject({
      id: "message_head",
      senderId: "acct_creator",
      createdAt: 1767323105,
    });
  });

  it("parses message history payloads and preserves reply/tip fields", async () => {
    const fixture = await loadResponseFixture<{
      messages: Array<Record<string, unknown>>;
    }>("message.json");
    const adapter = new FanslyAdapter({
      baseUrl: "https://fansly.example",
      globalDelayMs: 0,
    });
    vi.spyOn(adapter as unknown as { request: () => Promise<unknown> }, "request").mockResolvedValue({
      parsed: fixture.response,
      raw: fixture.response,
    });

    const result = await adapter.getMessagesPage({
      session: {
        authorization: "token",
      },
    }, {
      groupId: "group_alpha",
      limit: 25,
    });

    expect(result.groupId).toBe("group_alpha");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      id: "message_head",
      senderId: "acct_creator",
    });
    expect(result.items[1]).toMatchObject({
      id: "message_reply",
      inReplyTo: "message_head",
      totalTipAmount: 321,
    });
  });

  it("normalizes Fansly timestamps from seconds and milliseconds at the anomaly boundary", () => {
    expect(normalizeFanslyTimestamp(1_772_616_871).toISOString()).toBe("2026-03-04T09:34:31.000Z");
    expect(normalizeFanslyTimestamp(1_772_616_871_000).toISOString()).toBe("2026-03-04T09:34:31.000Z");
    expect(normalizeFanslyTimestamp(1_000_000_000_000).toISOString()).toBe("2001-09-09T01:46:40.000Z");
  });

  it.each([
    // [mode, existing, overlap, exhausted, cap, verdict without debt, verdict with debt]
    ["backfill", "pending_backfill", false, true, false, "complete", "partial_window"],
    ["backfill", "pending_backfill", true, false, false, "complete", "partial_window"],
    ["backfill", "pending_backfill", false, false, true, "partial_window", "partial_window"],
    ["backfill", "pending_backfill", false, false, false, "pending_backfill", "pending_backfill"],
    ["deep_backfill", "partial_window", false, true, false, "complete", "partial_window"],
    ["deep_backfill", "partial_window", false, false, false, "partial_window", "partial_window"],
    ["incremental", "complete", true, false, false, "complete", "partial_window"],
    ["incremental", "partial_window", true, false, false, "partial_window", "partial_window"],
    // Never pending_backfill: that would re-offer the thread at priority 1 forever.
    ["incremental", "pending_backfill", true, false, false, "pending_backfill", "pending_backfill"],
  ] as const)("coverage verdict for %s over %s (overlap %s, exhausted %s, cap %s) never claims complete with normalization debt", (
    currentMode, existingStatus, overlapFound, providerHistoryExhausted, hitWindowCap, clean, withDebt,
  ) => {
    const input = { currentMode, existingStatus, overlapFound, providerHistoryExhausted, hitWindowCap };
    expect(resolveDmConversationCoverageStatus(input)).toBe(clean);
    expect(resolveDmConversationCoverageStatus({ ...input, normalizationDebt: false })).toBe(clean);
    expect(resolveDmConversationCoverageStatus({ ...input, normalizationDebt: true })).toBe(withDebt);
  });

  it("normalizes provider DM tip units into stored cents", () => {
    expect(normalizeDmTipAmountCents("fansly", 20000)).toBe(2000);
    expect(normalizeDmTipAmountCents("fansly", 0)).toBe(0);
    expect(normalizeDmTipAmountCents("onlyfans", 125)).toBe(125);
  });

  it("redacts inbox lastMessage content from retained DM metadata payloads", async () => {
    const fixture = await loadResponseFixture<{
      data: Array<Record<string, unknown>>;
      aggregationData?: {
        total?: number;
        groups?: Array<Record<string, unknown>>;
      };
    }>("messaging_groups.json");

    const redacted = trimFanslyMessagingGroupsPayload(fixture.response);
    const group = (redacted as {
      aggregationData?: {
        groups?: Array<{
          lastMessage?: {
            content?: string;
          };
        }>;
      };
    }).aggregationData?.groups?.[0];

    expect(group?.lastMessage?.content).toBeUndefined();
  });
});
