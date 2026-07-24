import { describe, expect, it } from "vitest";

import { createLogger } from "@agency_hub_core/shared";

describe("runtime logger redaction", () => {
  it("censors authorization headers, proxy URLs, and bot-token fields", () => {
    const lines: string[] = [];
    const logger = createLogger("info", {
      write(message: string) {
        lines.push(message);
      },
    });

    logger.info({
      headers: { authorization: "Bearer header-secret-0123456789" },
      request: {
        headers: { Authorization: "Bearer nested-header-secret-0123456789" },
      },
      proxyUrl: "socks5://proxy.example.internal:1080",
      config: {
        serviceEgressProxyUrl: "socks5://service-proxy.example.internal:1080",
      },
      botToken: "123456789:telegram-token-abcdefghijklmnopqrstuvwxyz",
      nested: {
        telegramBotToken: "987654321:second-token-abcdefghijklmnopqrstuvwxyz",
      },
      note: "ordinary operational text",
    }, "redaction probe");

    const record = JSON.parse(lines.join("")) as Record<string, unknown>;
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("proxy.example.internal");
    expect(serialized).not.toContain("telegram-token");
    expect(serialized).not.toContain("second-token");
    expect(serialized).toContain("[REDACTED]");
    expect(record.note).toBe("ordinary operational text");
  });
});
