import { afterEach, describe, expect, it } from "vitest";

import {
  captureEvents,
  cleanupAdapterHarness,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";

afterEach(() => {
  cleanupAdapterHarness();
});

describe("OnlyFans chat adapter", () => {
  it("emits observer metadata for OnlyMonster chat message pagination without leaking IDs", async () => {
    const {
      OnlyFansAdapter,
      fetchMock,
    } = await loadAdapters();
    const { events, requestObserver } = captureEvents();

    fetchMock.mockImplementation(async (url) => {
      const urlText = String(url);
      if (urlText.includes("/fans?")) {
        return toJsonResponse({
          fan_ids: ["fan-secret-1", "fan-secret-2"],
        });
      }
      return toJsonResponse({
        items: [{
          id: 123,
          text: "hello",
          from_user: 456,
          is_sent_by_me: false,
          created_at: "2026-05-27T20:00:00.000Z",
          media: [],
          media_count: 0,
          is_opened: false,
          is_new: true,
          price: 0,
          is_free: true,
          can_purchase: false,
          can_purchase_reason: "",
        }],
        has_more: true,
      });
    });

    const adapter = new OnlyFansAdapter({
      baseUrl: "https://onlyfans.example",
      defaultDelayMs: 0,
    });

    await adapter.getRecentChatFanIds({
      auth: {
        token: "om-super-secret-token",
      },
      requestObserver,
    }, 42, {
      limit: 100,
    });
    await adapter.getChatMessagesPage({
      auth: {
        token: "om-super-secret-token",
      },
      requestObserver,
    }, 42, "chat-secret-1", {
      limit: 25,
      messageId: "message-secret-1",
      order: "desc",
      pageIndex: 4,
    });

    expect(events.at(-1)).toMatchObject({
      state: "success",
      operation: "messages",
      endpointTemplate: "/api/v0/accounts/:accountId/chats/:chatId/messages",
      pagination: {
        pageIndex: 4,
        cursorPresent: true,
      },
      requestMetadata: {
        limit: 25,
        hasMessageId: true,
        order: "desc",
      },
      responseMetadata: {
        returnedItems: 1,
        hasMore: true,
      },
    });

    const firstCallUrl = String(fetchMock.mock.calls[0]?.[0]);
    const secondCallUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(firstCallUrl).toBe("https://onlyfans.example/api/v0/accounts/42/fans?limit=100");
    expect(secondCallUrl).toBe(
      "https://onlyfans.example/api/v0/accounts/42/chats/chat-secret-1/messages?limit=25&message_id=message-secret-1&order=desc",
    );

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("fan-secret-1");
    expect(serialized).not.toContain("chat-secret-1");
    expect(serialized).not.toContain("message-secret-1");
    expect(serialized).not.toContain("om-super-secret-token");
    await adapter.close();
  });
});
