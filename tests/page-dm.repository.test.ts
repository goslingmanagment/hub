import { describe, expect, it, vi } from "vitest";

import {
  getPageConversationMessages,
  getPageConversationPreview,
  upsertPageDmConversation,
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

// Same queryChunks walk as extractSqlText, but it keeps the interleaved
// column references (rendered by column name) so a generated expression can be
// pinned end to end instead of as text fragments with holes in it.
function renderSqlWithColumns(query: {
  queryChunks?: unknown[];
}): string {
  const chunks = query.queryChunks ?? [];
  return chunks.map((chunk) => {
    if (typeof chunk === "object" && chunk !== null) {
      if ("queryChunks" in chunk && Array.isArray(chunk.queryChunks)) {
        return renderSqlWithColumns(chunk as { queryChunks?: unknown[] });
      }

      if ("value" in chunk && Array.isArray((chunk as { value?: unknown[] }).value)) {
        return (chunk as { value: unknown[] }).value.join("");
      }

      const name = (chunk as { name?: unknown }).name;
      if (typeof name === "string") {
        return name;
      }
    }

    return "";
  }).join("");
}

function normalizeSql(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function captureConflictSet(input?: {
  headForwardOnly?: boolean;
}) {
  const captured: { set: Record<string, unknown> } = { set: {} };
  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
          captured.set = config.set;
          return { returning: () => Promise.resolve([buildConversationRow()]) };
        },
      }),
    }),
  } as never;

  return {
    captured,
    run: () => upsertPageDmConversation(db, {
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
      lastMessageSenderRole: "unknown" as const,
      lastMessagePreview: null,
      isVisible: true,
      lastSeenGeneration: 3,
      metadata: {},
      ...(input?.headForwardOnly === undefined ? {} : { headForwardOnly: input.headForwardOnly }),
    }),
  };
}

// G2: the sweep-membership set is read off last_seen_generation, so the stamp
// must never move backwards under a concurrent upsert.
const MONOTONIC_GENERATION_SQL = normalizeSql(`
  case
    when excluded.last_seen_generation is null then last_seen_generation
    when last_seen_generation is null then excluded.last_seen_generation
    else greatest(last_seen_generation, excluded.last_seen_generation)
  end
`);

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

  describe("generation stamp monotonicity (G2)", () => {
    it("guards last_seen_generation in the conflict set with the monotonic case", async () => {
      const { captured, run } = captureConflictSet();

      await run();

      const guard = captured.set.lastSeenGeneration as { queryChunks?: unknown[] };
      expect(guard).toBeDefined();
      expect(normalizeSql(renderSqlWithColumns(guard))).toBe(MONOTONIC_GENERATION_SQL);
    });

    it("applies the guard on every writer, not just the head-guarded ones", async () => {
      // The four writers share this upsert and only the OFAPI ones set
      // headForwardOnly — the generation guard must be unconditional, so a
      // Fansly sweep write is protected too.
      const headGuarded = captureConflictSet({ headForwardOnly: true });
      await headGuarded.run();
      const unguardedHead = captureConflictSet({ headForwardOnly: false });
      await unguardedHead.run();

      for (const { captured } of [headGuarded, unguardedHead]) {
        const guard = captured.set.lastSeenGeneration as { queryChunks?: unknown[] };
        expect(normalizeSql(renderSqlWithColumns(guard))).toBe(MONOTONIC_GENERATION_SQL);
      }

      // The head guard stays independent of it: it only appears when asked for.
      expect(headGuarded.captured.set.lastMessageId).not.toBe(null);
      expect(unguardedHead.captured.set.lastMessageId).toBe(null);
    });

    it("keeps the raw insert values unguarded so a fresh row takes the incoming stamp", async () => {
      const values: Record<string, unknown>[] = [];
      const db = {
        insert: () => ({
          values: (row: Record<string, unknown>) => {
            values.push(row);
            return {
              onConflictDoUpdate: () => ({
                returning: () => Promise.resolve([buildConversationRow()]),
              }),
            };
          },
        }),
      } as never;

      await upsertPageDmConversation(db, {
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
        isVisible: true,
        lastSeenGeneration: 3,
        metadata: {},
      });

      expect(values[0]?.lastSeenGeneration).toBe(3);
    });
  });
});
