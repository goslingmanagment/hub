import { readFile } from "node:fs/promises";
import path from "node:path";

import { fanslyWireSpec, readFanslyWireResponse, type FanslyWireId, type FanslyWireParams } from "@agency_hub_core/fansly";
import { describe, expect, it } from "vitest";

import { trimFanslyMessagingGroupsPayload } from "../apps/runtime/src/sync/fansly/lib/capture-trims.ts";
import { normalizeDmTipAmountCents } from "../apps/runtime/src/sync/fansly/lib/dm-normalize.ts";
import { normalizeFanslyTimestamp } from "../apps/runtime/src/sync/fansly/lib/timestamp.ts";

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

/** The fixture's answer as its wire route reads it: a 200 whose body is the
 *  envelope, through the route's own contract. */
function acceptedBy<I extends FanslyWireId>(id: I, params: FanslyWireParams<I>, envelope: { success: boolean; response: unknown }) {
  const read = readFanslyWireResponse(fanslyWireSpec(id), params, {
    status: 200,
    headers: {},
    bodyText: JSON.stringify(envelope),
  });
  if (read.kind !== "accepted") throw new Error(`${id} did not accept the fixture: ${JSON.stringify(read)}`);
  return read.value;
}

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

    const page = acceptedBy("messaging.groups", { offset: 0 }, fixture);
    const groups = page.aggregationData?.groups ?? [];

    expect(page.aggregationData?.total).toBe(fixture.response.aggregationData?.total);
    expect(page.data.length).toBeGreaterThan(0);
    expect((page.aggregationData?.accounts ?? []).length).toBeGreaterThan(0);
    expect(groups.length).toBeGreaterThan(0);
    expect(page.data[0]).toMatchObject({
      groupId: "group_alpha",
      partnerAccountId: "acct_fan_alpha",
    });
    expect(groups[0]).toMatchObject({
      id: "group_alpha",
    });
    expect(groups.some((group) => (
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

    const page = acceptedBy("messaging.groups", { offset: 0 }, {
      success: fixture.success,
      response: {
        ...fixture.response,
        aggregationData: {
          total: fixture.response.aggregationData?.total,
        },
      },
    });

    expect(page.data.length).toBeGreaterThan(0);
    expect(page.aggregationData?.accounts).toBeUndefined();
    expect(page.aggregationData?.groups).toBeUndefined();
  });

  it("parses group_detail payloads with a last message head", async () => {
    const fixture = await loadResponseFixture<Record<string, unknown>>("group_detail.json");

    const detail = acceptedBy("group.detail", { groupId: "group_alpha" }, fixture);

    expect(detail).toMatchObject({
      id: "group_alpha",
      users: expect.arrayContaining([
        expect.objectContaining({ userId: "acct_fan_alpha" }),
        expect.objectContaining({ userId: "acct_creator" }),
      ]),
    });
    expect(detail.lastMessage).toMatchObject({
      id: "message_head",
      senderId: "acct_creator",
      createdAt: 1767323105,
    });
  });

  it("parses message history payloads and preserves reply/tip fields", async () => {
    const fixture = await loadResponseFixture<{
      messages: Array<Record<string, unknown>>;
    }>("message.json");

    const page = acceptedBy("messages.page", { groupId: "group_alpha", before: null }, fixture);

    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]).toMatchObject({
      id: "message_head",
      senderId: "acct_creator",
    });
    expect(page.messages[1]).toMatchObject({
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
