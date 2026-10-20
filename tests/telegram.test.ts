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
  resolveTelegramCredentials,
  sendTelegramMessage,
  type TelegramRequestOptions,
} from "../apps/runtime/src/services/telegram.ts";

function fakeDispatcher() {
  return {
    dispatch: vi.fn(),
    close: vi.fn(async () => undefined),
    destroy: vi.fn(),
  } as unknown as TelegramRequestOptions["dispatcher"];
}

function serviceProxyConfig() {
  return {
    serviceEgressProxyUrl: "socks5://proxy.example.internal:1080",
    serviceEgressProxyUsername: "fake-service-user",
    serviceEgressProxyPassword: "fake-service-password",
  };
}

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

  it("redacts Telegram bot tokens from transport failures", async () => {
    const dispatcher = fakeDispatcher();
    sharedMocks.createProxyRequestDispatcher.mockReturnValue(dispatcher);
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
        ...serviceProxyConfig(),
      },
    } as never, {
      text: "hello",
      credentials: {
        botToken: "123:abc",
        chatId: "6065935464",
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: "failed" });
    expect(result.status === "failed" ? result.error : "").toContain(
      "https://api.telegram.org/bot[REDACTED]/sendMessage",
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      method: "sendMessage",
      attemptCount: 3,
      egressKey: "service:socks5://proxy.example.internal:1080",
      durationMs: expect.any(Number),
      observedError: expect.stringContaining(
        "https://api.telegram.org/bot[REDACTED]/sendMessage",
      ),
    }), "Telegram notification failed; continuing");
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).not.toContain("123:abc");
    }
  });

  // Д2: the notification outbox repeats a row after its backoff, so a timed-out
  // request — an indeterminate outcome — is not repeated inside its call.
  it("with retryTimeouts: false a timed-out send is not repeated inside the call; a 5xx still is", async () => {
    sharedMocks.createProxyRequestDispatcher.mockReturnValue(fakeDispatcher());
    const app = {
      db: {},
      logger: { warn: vi.fn() },
      config: {
        encryptionKeysByVersion: new Map([[1, Buffer.alloc(32, 7)]]),
        telegramBotToken: null,
        telegramChatId: null,
        telegramReportHourUtc: 9,
        ...serviceProxyConfig(),
      },
    } as never;
    const credentials = { botToken: "123:abc", chatId: "6065935464" };
    const timeoutError = () => Object.assign(new Error("socket timed out"), { name: "TimeoutError" });
    const sent = () => new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const timedOut = vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError());
    expect(await sendTelegramMessage(app, { text: "hello", credentials, retryTimeouts: false })).toEqual({
      status: "failed",
      error: "Telegram API request timed out through the service proxy.",
    });
    expect(timedOut).toHaveBeenCalledTimes(1);
    timedOut.mockRestore();

    const unavailable = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "Bad Gateway" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(sent());
    expect(await sendTelegramMessage(app, { text: "hello", credentials, retryTimeouts: false }))
      .toMatchObject({ status: "sent", messageId: 42 });
    expect(unavailable).toHaveBeenCalledTimes(2);
    unavailable.mockRestore();

    // The default is unchanged: the digest, the report and the manual resolve
    // still repeat a timeout inside the call.
    const byDefault = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(sent());
    expect(await sendTelegramMessage(app, { text: "hello", credentials })).toMatchObject({ status: "sent" });
    expect(byDefault).toHaveBeenCalledTimes(2);
  });

  it("fails closed without a dedicated or legacy route and performs zero fetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logger = { warn: vi.fn() };
    const result = await sendTelegramMessage({
      db: {},
      logger,
      config: {
        encryptionKeysByVersion: new Map([[1, Buffer.alloc(32, 7)]]),
        telegramBotToken: null,
        telegramChatId: null,
        telegramReportHourUtc: 9,
        telegramProxyPageLabel: null,
        serviceEgressProxyUrl: null,
        serviceEgressProxyUsername: null,
        serviceEgressProxyPassword: null,
      },
    } as never, {
      text: "hello",
      credentials: { botToken: "123:abc", chatId: "6065935464" },
    });

    expect(result.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sharedMocks.createProxyRequestDispatcher).not.toHaveBeenCalled();
  });

  it("does not retry or fall back when the configured service proxy cannot connect", async () => {
    const dispatcher = fakeDispatcher();
    sharedMocks.createProxyRequestDispatcher.mockReturnValue(dispatcher);
    const connectError = Object.assign(new Error("fake proxy auth rejected"), {
      name: "SocksClientError",
      code: "ECONNREFUSED",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(connectError);
    const logger = { warn: vi.fn() };

    const result = await sendTelegramMessage({
      db: {},
      logger,
      config: {
        encryptionKeysByVersion: new Map([[1, Buffer.alloc(32, 7)]]),
        telegramBotToken: null,
        telegramChatId: null,
        telegramReportHourUtc: 9,
        telegramProxyPageLabel: "fake-legacy-page",
        ...serviceProxyConfig(),
      },
    } as never, {
      text: "hello",
      credentials: { botToken: "123:abc", chatId: "6065935464" },
    });

    expect(result.status).toBe("failed");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(dbMocks.findPageByLabel).not.toHaveBeenCalled();
    expect(dispatcher.close).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      method: "sendMessage",
      attemptCount: 1,
      egressKey: "service:socks5://proxy.example.internal:1080",
      failureKind: "connect",
      durationMs: expect.any(Number),
    }), "Telegram notification failed; continuing");
  });
});

