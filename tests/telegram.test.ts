import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as SharedModule from "@agency_hub_core/shared";

const sharedMocks = vi.hoisted(() => ({
  createProxyRequestDispatcher: vi.fn(),
  resolveRetryDelayMs: vi.fn(() => 0),
}));

const dbMocks = vi.hoisted(() => ({
  findPageByLabel: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    findPageByLabel: dbMocks.findPageByLabel,
  };
});

vi.mock("@agency_hub_core/shared", async () => {
  const actual = await vi.importActual<typeof SharedModule>("@agency_hub_core/shared");
  return {
    ...actual,
    createProxyRequestDispatcher: sharedMocks.createProxyRequestDispatcher,
    resolveRetryDelayMs: sharedMocks.resolveRetryDelayMs,
  };
});

import { encryptJson } from "@agency_hub_core/shared";

import {
  deriveTelegramConnectionState,
  discoverTelegramChats,
  friendlyTelegramError,
  resolveTelegramCredentials,
  resolveTelegramCredentialSources,
  sendTelegramMessage,
  sendTelegramPhoto,
} from "../apps/runtime/src/services/telegram.ts";

afterEach(() => {
  vi.restoreAllMocks();
  dbMocks.findPageByLabel.mockReset();
  sharedMocks.createProxyRequestDispatcher.mockReset();
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

  it("reports the bot token source as env when the stored token fails to decrypt", () => {
    const sources = resolveTelegramCredentialSources({
      config: {
        encryptionKeysByVersion: new Map([[1, Buffer.alloc(32, 7)]]),
        telegramBotToken: "111:env-token",
        telegramChatId: null,
      },
    } as never, {
      encryptedBotToken: "this-is-not-valid-encrypted-json",
      chatId: null,
    } as never);

    expect(sources.botTokenSource).toBe("env");
    expect(sources.chatIdSource).toBe("none");
  });

  it("reports both sources as db when stored credentials are usable", () => {
    const key = Buffer.alloc(32, 7);
    const sources = resolveTelegramCredentialSources({
      config: {
        encryptionKeysByVersion: new Map([[1, key]]),
        telegramBotToken: "111:env",
        telegramChatId: "env-chat",
      },
    } as never, {
      encryptedBotToken: JSON.stringify(encryptJson("db-token", key, 1)),
      chatId: "db-chat",
    } as never);

    expect(sources).toEqual({ botTokenSource: "db", chatIdSource: "db" });
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

  it("uses a configured dispatcher for chat discovery requests", async () => {
    const dispatcher = {
      dispatch: vi.fn(),
      close: vi.fn(),
      destroy: vi.fn(),
    } as never;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { username: "mybot" },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: [],
      }), { status: 200, headers: { "content-type": "application/json" } }));

    await discoverTelegramChats("123:abc", { dispatcher });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://api.telegram.org/bot123:abc/getMe",
      expect.objectContaining({ dispatcher }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://api.telegram.org/bot123:abc/getUpdates",
      expect.objectContaining({ dispatcher }),
    );
  });

  it("throws a friendly discovery error when the token is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      description: "Unauthorized",
    }), { status: 401, headers: { "content-type": "application/json" } }));

    await expect(discoverTelegramChats("bad-token")).rejects.toThrow(/Invalid bot token/);
  });

  it("throws a friendly discovery error when Telegram API times out", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(timeoutError);

    await expect(discoverTelegramChats("123:abc")).rejects.toThrow(/Telegram API request timed out/);
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

  it("uses the configured page proxy dispatcher for photo sends and closes it", async () => {
    const dispatcher = {
      dispatch: vi.fn(),
      close: vi.fn(async () => undefined),
      destroy: vi.fn(),
    };
    sharedMocks.createProxyRequestDispatcher.mockReturnValue(dispatcher);
    dbMocks.findPageByLabel.mockResolvedValue({
      page: { id: 7, label: "lilly-1" },
      credentials: null,
      proxy: {
        url: "socks5://proxy.example:1080",
        encryptedAuth: null,
        keyVersion: null,
        rateLimitScopeKey: null,
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      result: {
        message_id: 43,
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

    const result = await sendTelegramPhoto({
      db: {},
      logger,
      config: {
        encryptionKey: Buffer.alloc(32, 7),
        encryptionKeysByVersion: new Map([[1, Buffer.alloc(32, 7)]]),
        telegramBotToken: null,
        telegramChatId: null,
        telegramReportHourUtc: 9,
        telegramProxyPageLabel: "lilly-1",
      },
    } as never, {
      photo: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      caption: "<b>Revenue</b>",
      parseMode: "HTML",
      credentials: {
        botToken: "123:abc",
        chatId: "6065935464",
      },
    });

    expect(result).toEqual({
      status: "sent",
      chatId: "6065935464",
      messageId: 43,
    });
    expect(dbMocks.findPageByLabel).toHaveBeenCalledWith({}, "lilly-1");
    expect(sharedMocks.createProxyRequestDispatcher).toHaveBeenCalledWith({
      url: "socks5://proxy.example:1080",
      username: null,
      password: null,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:abc/sendPhoto",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
        dispatcher,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(dispatcher.close).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("deriveTelegramConnectionState", () => {
  const credentialsUpdatedAt = new Date("2026-01-01T00:00:00Z");
  const after = new Date("2026-01-01T01:00:00Z");
  const before = new Date("2025-12-31T23:00:00Z");

  it("is not_configured when credentials are missing", () => {
    expect(deriveTelegramConnectionState(false, credentialsUpdatedAt, null).status).toBe("not_configured");
  });

  it("is untested when configured but no real delivery has happened", () => {
    expect(deriveTelegramConnectionState(true, credentialsUpdatedAt, null).status).toBe("untested");
  });

  it("is connected for a sent delivery made with the current credentials", () => {
    expect(
      deriveTelegramConnectionState(true, credentialsUpdatedAt, { status: "sent", createdAt: after }).status,
    ).toBe("connected");
  });

  it("is last_message_failed for a recent failed delivery", () => {
    expect(
      deriveTelegramConnectionState(true, credentialsUpdatedAt, { status: "failed", createdAt: after }).status,
    ).toBe("last_message_failed");
  });

  it("never reports a skipped attempt as connected", () => {
    expect(
      deriveTelegramConnectionState(true, credentialsUpdatedAt, { status: "skipped", createdAt: after }).status,
    ).toBe("untested");
  });

  it("treats a success that predates the current credentials as stale (untested)", () => {
    const result = deriveTelegramConnectionState(true, credentialsUpdatedAt, { status: "sent", createdAt: before });
    expect(result.status).toBe("untested");
    expect(result.recentAttempt).toBeNull();
  });
});
