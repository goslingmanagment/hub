import { afterEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  resolveRetryDelayMs: vi.fn(() => 0),
}));

vi.mock("@agency_hub_core/shared", async () => {
  const actual = await vi.importActual<typeof import("@agency_hub_core/shared")>("@agency_hub_core/shared");
  return {
    ...actual,
    resolveRetryDelayMs: sharedMocks.resolveRetryDelayMs,
  };
});

import { encryptJson } from "@agency_hub_core/shared";

import {
  discoverTelegramChats,
  friendlyTelegramError,
  resolveTelegramCredentials,
  sendTelegramMessage,
} from "../apps/runtime/src/services/telegram.ts";

afterEach(() => {
  vi.restoreAllMocks();
  sharedMocks.resolveRetryDelayMs.mockReset();
  sharedMocks.resolveRetryDelayMs.mockReturnValue(0);
});

describe("telegram service", () => {
  it("decrypts stored Telegram credentials with a historical key from the key ring", () => {
    const historicalKey = Buffer.alloc(32, 3);
    const currentKey = Buffer.alloc(32, 7);

    const resolved = resolveTelegramCredentials({
      config: {
        encryptionKey: currentKey,
        encryptionKeyVersion: 2,
        encryptionKeysByVersion: new Map([
          [1, historicalKey],
          [2, currentKey],
        ]),
        telegramBotToken: null,
        telegramChatId: null,
      },
    } as never, {
      encryptedBotToken: JSON.stringify(encryptJson("123:abc", historicalKey, 1)),
      chatId: "6065935464",
    } as never);

    expect(resolved).toEqual({
      botToken: "123:abc",
      chatId: "6065935464",
    });
  });

  it("applies a stored chatId on top of the env bot token (per-field precedence)", () => {
    // Regression: a DB chatId set without a DB token must not silently fall back
    // to the env chatId at send time while the UI shows the new one.
    const resolved = resolveTelegramCredentials({
      config: {
        encryptionKey: Buffer.alloc(32, 7),
        encryptionKeyVersion: 1,
        encryptionKeysByVersion: new Map([[1, Buffer.alloc(32, 7)]]),
        telegramBotToken: "111:env-token",
        telegramChatId: "env-chat",
      },
    } as never, {
      encryptedBotToken: null,
      chatId: "db-chat",
    } as never);

    expect(resolved).toEqual({ botToken: "111:env-token", chatId: "db-chat" });
  });

  it("returns null when only one credential field is resolvable", () => {
    const resolved = resolveTelegramCredentials({
      config: {
        encryptionKeysByVersion: new Map([[1, Buffer.alloc(32, 7)]]),
        telegramBotToken: null,
        telegramChatId: "env-chat",
      },
    } as never, {
      encryptedBotToken: null,
      chatId: null,
    } as never);

    expect(resolved).toBeNull();
  });

  it("maps common Telegram API errors to operator-friendly text", () => {
    expect(friendlyTelegramError(401, "Unauthorized")).toContain("Invalid bot token");
    expect(friendlyTelegramError(400, "Bad Request: chat not found")).toContain("Chat not found");
    expect(friendlyTelegramError(403, "Forbidden: bot was blocked by the user")).toContain("blocked");
  });

  it("discovers unique chats from getMe + getUpdates", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { username: "mybot" },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: [
          { message: { chat: { id: 111, type: "private", first_name: "Dima" } } },
          { message: { chat: { id: 111, type: "private", first_name: "Dima" } } },
          { my_chat_member: { chat: { id: -1009, type: "channel", title: "Alerts" } } },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await discoverTelegramChats("123:abc");

    expect(result.botUsername).toBe("mybot");
    expect(result.chats).toEqual([
      { id: "111", type: "private", title: "Dima" },
      { id: "-1009", type: "channel", title: "Alerts" },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws a friendly discovery error when the token is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      description: "Unauthorized",
    }), { status: 401, headers: { "content-type": "application/json" } }));

    await expect(discoverTelegramChats("bad-token")).rejects.toThrow(/Invalid bot token/);
  });

  it("redacts Telegram bot tokens from transport failures", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("request to https://api.telegram.org/bot123:abc/sendMessage failed"));
    const logger = {
      warn: vi.fn(),
    };

    const result = await sendTelegramMessage({
      db: {},
      logger,
      config: {
        encryptionKey: Buffer.alloc(32, 7),
        encryptionKeysByVersion: new Map([[1, Buffer.alloc(32, 7)]]),
        telegramBotToken: null,
        telegramChatId: null,
        telegramReportHourUtc: 9,
      },
    } as never, {
      text: "hello",
      credentials: {
        botToken: "123:abc",
        chatId: "6065935464",
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      status: "failed",
      error: "request to https://api.telegram.org/bot[REDACTED]/sendMessage failed",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "6065935464",
      error: "request to https://api.telegram.org/bot[REDACTED]/sendMessage failed",
    }), "Telegram notification failed; continuing");
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).not.toContain("123:abc");
    }
  });

  it("retries transient Telegram failures before succeeding with a bounded timeout signal", async () => {
    const timeoutError = new Error("socket timed out");
    timeoutError.name = "TimeoutError";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 42,
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }));
    const logger = {
      warn: vi.fn(),
    };

    const result = await sendTelegramMessage({
      db: {},
      logger,
      config: {
        encryptionKey: Buffer.alloc(32, 7),
        encryptionKeysByVersion: new Map([[1, Buffer.alloc(32, 7)]]),
        telegramBotToken: null,
        telegramChatId: null,
        telegramReportHourUtc: 9,
      },
    } as never, {
      text: "hello",
      credentials: {
        botToken: "123:abc",
        chatId: "6065935464",
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(result).toEqual({
      status: "sent",
      chatId: "6065935464",
      messageId: 42,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
