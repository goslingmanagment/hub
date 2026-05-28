import { describe, expect, it, vi } from "vitest";

import {
  getPageConversationMessages,
  getPageConversationPreview,
} from "../packages/db/src/repositories/page-dm.ts";

function extractQueryParams(query: {
  queryChunks?: unknown[];
}): unknown[] {
  const chunks = query.queryChunks ?? [];
  const values: unknown[] = [];

  for (const chunk of chunks) {
    if (typeof chunk === "object" && chunk !== null) {
      if ("queryChunks" in chunk && Array.isArray(chunk.queryChunks)) {
        values.push(...extractQueryParams(chunk as { queryChunks?: unknown[] }));
        continue;
      }

      if ("value" in chunk) {
        continue;
      }
    }

    values.push(chunk);
  }

  return values;
}

function extractSqlText(query: {
  queryChunks?: Array<{
    value?: string[];
  }>;
}): string {
  const chunks = query.queryChunks ?? [];
  return chunks.flatMap((chunk) => {
    if (typeof chunk === "object" && chunk !== null) {
      if ("queryChunks" in chunk && Array.isArray(chunk.queryChunks)) {
        return extractSqlText(chunk as { queryChunks?: Array<{ value?: string[] }> });
      }

      if ("value" in chunk && Array.isArray(chunk.value)) {
        return chunk.value;
      }
    }

    return [];
  }).join("");
}

function buildConversationRow() {
  const now = new Date("2026-03-24T12:00:00.000Z");

  return {
    id: 42,
    platformAccountId: 55,
    fanId: null,
    platformConversationId: "thread-1",
    partnerPlatformUserId: null,
    partnerUsername: null,
    partnerDisplayName: null,
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: null,
    lastUnreadMessageId: null,
    lastMessageAt: null,
    lastMessageSenderId: null,
    lastMessageSenderRole: "unknown",
    lastMessagePreview: null,
    lastFanMessageAt: null,
    lastModelMessageAt: null,
    storedMessageCount: 0,
    newestStoredMessageId: null,
    oldestStoredMessageId: null,
    messageCoverageStatus: "pending_backfill",
    messageBackfillComplete: false,
    lastMessageSyncAt: null,
    isVisible: true,
    lastSeenGeneration: null,
    firstSeenAt: now,
    lastSeenAt: now,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

describe("page DM repository", () => {
  it("scopes newest-first message reads to the page account", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = {
      query: {
        pageDmConversations: {
          findFirst: vi.fn().mockResolvedValue(buildConversationRow()),
        },
      },
      execute,
    } as never;

    await getPageConversationMessages(db, {
      platformAccountId: 55,
      platformConversationId: "thread-1",
      limit: 10,
    });

    const query = execute.mock.calls[0]?.[0];
    const sqlText = extractSqlText(query);
    const params = extractQueryParams(query);

    expect(sqlText).toContain("where conversation_id = ");
    expect(sqlText).toContain("and platform_account_id = ");
    expect(params).toEqual(expect.arrayContaining([42, 55, 10]));
  });

  it("scopes preview message reads to the page account", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = {
      query: {
        pageDmConversations: {
          findFirst: vi.fn().mockResolvedValue(buildConversationRow()),
        },
      },
      execute,
    } as never;

    await getPageConversationPreview(db, {
      platformAccountId: 55,
      platformConversationId: "thread-1",
      limit: 10,
    });

    const query = execute.mock.calls[0]?.[0];
    const sqlText = extractSqlText(query);
    const params = extractQueryParams(query);

    expect(sqlText).toContain("where conversation_id = ");
    expect(sqlText).toContain("and platform_account_id = ");
    expect(params).toEqual(expect.arrayContaining([42, 55, 10]));
  });
});
