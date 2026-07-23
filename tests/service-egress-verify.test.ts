import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as SharedModule from "@agency_hub_core/shared";

const verifyMocks = vi.hoisted(() => ({
  createProxyRequestDispatcher: vi.fn(),
  getTelegramSettings: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    getTelegramSettings: verifyMocks.getTelegramSettings,
  };
});

vi.mock("@agency_hub_core/shared", async () => {
  const actual = await vi.importActual<typeof SharedModule>("@agency_hub_core/shared");
  return {
    ...actual,
    createProxyRequestDispatcher: verifyMocks.createProxyRequestDispatcher,
  };
});

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  verifyServiceEgress,
} from "../apps/runtime/src/services/service-egress-verify.ts";

function fakeDispatcher() {
  return {
    dispatch: vi.fn(),
    close: vi.fn(async () => undefined),
    destroy: vi.fn(),
  };
}

function fakeApp(): AppContext {
  const encryptionKey = Buffer.alloc(32, 7);
  return {
    db: {} as AppContext["db"],
    config: {
      telegramReportHourUtc: 9,
      telegramBotToken: "123:fake-telegram-token",
      telegramChatId: null,
      encryptionKey,
      encryptionKeyVersion: 1,
      encryptionKeysByVersion: new Map([[1, encryptionKey]]),
      elevenLabsApiKey: "fake-elevenlabs-key",
      serviceEgressProxyUrl: "socks5://proxy.example.internal:1080",
      serviceEgressProxyUsername: "fake-service-user",
      serviceEgressProxyPassword: "fake-service-password",
    } as unknown as AppContext["config"],
  } as AppContext;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("service egress verifier", () => {
  it("authenticates both consumers without synthesizing or sending and reports one identity", async () => {
    const firstDispatcher = fakeDispatcher();
    const secondDispatcher = fakeDispatcher();
    verifyMocks.createProxyRequestDispatcher
      .mockReturnValueOnce(firstDispatcher)
      .mockReturnValueOnce(secondDispatcher);
    verifyMocks.getTelegramSettings.mockResolvedValue({
      encryptedBotToken: null,
      chatId: null,
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.ipify.org")) {
        return new Response(JSON.stringify({ ip: "203.0.113.10" }), { status: 200 });
      }
      if (url.endsWith("/v1/user/subscription")) {
        return new Response(JSON.stringify({ tier: "fake" }), { status: 200 });
      }
      if (url.endsWith("/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { username: "fake_bot" } }), {
          status: 200,
        });
      }
      throw new Error(`unexpected verifier URL: ${url}`);
    }) as unknown as typeof fetch;

    const result = await verifyServiceEgress(fakeApp(), "all", fetchImpl);

    expect(result).toEqual([
      {
        consumer: "elevenlabs",
        route: "socks5://proxy.example.internal:1080 (auth)",
        egressKey: "service:socks5://proxy.example.internal:1080",
        exitIp: "203.0.113.10",
      },
      {
        consumer: "telegram",
        route: "socks5://proxy.example.internal:1080 (auth)",
        egressKey: "service:socks5://proxy.example.internal:1080",
        exitIp: "203.0.113.10",
      },
    ]);
    const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]));
    expect(urls).toContain("https://api.elevenlabs.io/v1/user/subscription");
    expect(urls).toContain("https://api.telegram.org/bot123:fake-telegram-token/getMe");
    expect(urls.some((url) => url.includes("text-to-speech"))).toBe(false);
    expect(urls.some((url) => url.includes("sendMessage"))).toBe(false);
    for (const call of (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ dispatcher: expect.anything() }));
    }
    expect(firstDispatcher.close).toHaveBeenCalledTimes(1);
    expect(secondDispatcher.close).toHaveBeenCalledTimes(1);
  });

  it("exits through a bounded error that redacts all known credentials", async () => {
    const dispatcher = fakeDispatcher();
    verifyMocks.createProxyRequestDispatcher.mockReturnValue(dispatcher);
    const fetchImpl = vi.fn(async () => {
      const nested = new Error(
        "fake-elevenlabs-key fake-service-user fake-service-password "
          + "socks5://fake-service-user:fake-service-password@proxy.example.internal:1080",
      );
      throw new TypeError("fetch failed", { cause: nested });
    }) as unknown as typeof fetch;

    const error = await verifyServiceEgress(fakeApp(), "elevenlabs", fetchImpl)
      .catch((caught) => caught);
    const rendered = String(error);
    expect(rendered).toContain("cause(1)");
    expect(rendered.length).toBeLessThan(700);
    expect(rendered).not.toContain("fake-elevenlabs-key");
    expect(rendered).not.toContain("fake-service-user");
    expect(rendered).not.toContain("fake-service-password");
    expect(dispatcher.close).toHaveBeenCalledTimes(1);
  });
});
