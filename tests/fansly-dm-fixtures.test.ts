import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeDmTipAmountCents,
  normalizeFanslyTimestamp,
  trimFanslyMessagingGroupsPayload,
} from "../apps/runtime/src/services/sync/shared.ts";
import { FanslyAdapter } from "../packages/fansly/src/adapter.ts";

async function loadResponseFixture<T>(name: string) {
  const file = path.resolve("reference/responses", name);
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
    vi.spyOn(adapter as never, "request").mockResolvedValue({
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
      groupId: "878739490577862656",
      partnerAccountId: "622205078341689346",
    });
    expect(result.groups[0]).toMatchObject({
      id: "878739490577862656",
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
    vi.spyOn(adapter as never, "request").mockResolvedValue({
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
    vi.spyOn(adapter as never, "request").mockResolvedValue({
      parsed: fixture.response,
      raw: fixture.response,
    });

    const result = await adapter.getGroupDetail({
      session: {
        authorization: "token",
      },
    }, "878739490577862656");

    expect(result.parsed).toMatchObject({
      id: "878739490577862656",
      users: expect.arrayContaining([
        expect.objectContaining({ userId: "622205078341689346" }),
        expect.objectContaining({ userId: "772956494390898689" }),
      ]),
    });
    expect(result.parsed.lastMessage).toMatchObject({
      id: "885511997599272960",
      senderId: "772956494390898689",
      createdAt: 1772616871,
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
    vi.spyOn(adapter as never, "request").mockResolvedValue({
      parsed: fixture.response,
      raw: fixture.response,
    });

    const result = await adapter.getMessagesPage({
      session: {
        authorization: "token",
      },
    }, {
      groupId: "878739490577862656",
      limit: 25,
    });

    expect(result.groupId).toBe("878739490577862656");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      id: "885512029928960000",
      senderId: "772956494390898689",
    });
    expect(result.items[1]).toMatchObject({
      id: "885511997599272960",
      inReplyTo: "885512029928960000",
      totalTipAmount: 250,
    });
  });

  it("normalizes Fansly timestamps from seconds and milliseconds at the anomaly boundary", () => {
    expect(normalizeFanslyTimestamp(1_772_616_871).toISOString()).toBe("2026-03-04T09:34:31.000Z");
    expect(normalizeFanslyTimestamp(1_772_616_871_000).toISOString()).toBe("2026-03-04T09:34:31.000Z");
    expect(normalizeFanslyTimestamp(1_000_000_000_000).toISOString()).toBe("2001-09-09T01:46:40.000Z");
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
