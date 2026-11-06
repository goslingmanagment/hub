import { describe, expect, it } from "vitest";

import { createLogger } from "@agency_hub_core/shared";

import { DrizzleQueryError } from "../packages/db/node_modules/drizzle-orm/index.js";

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

  // `{ error }` used to reach the log as `{}`; it must carry the cause, but never
  // Drizzle's bound SQL params (docs/error-handling.md).
  it("writes an Error under `error` like `err`, without Drizzle's bound params", () => {
    const lines: string[] = [];
    const logger = createLogger("info", {
      write(message: string) {
        lines.push(message);
      },
    });
    const driverError = Object.assign(
      new Error("duplicate key value violates unique constraint \"dm_messages_pkey\""),
      { code: "23505" },
    );
    const queryError = new DrizzleQueryError(
      "insert into dm_messages (body) values ($1)",
      ["private fan chat text"],
      driverError,
    );

    logger.error({ error: new Error("canonicalize exploded") }, "plain");
    logger.error({ error: queryError }, "query");
    logger.error({ error: new Error("family run failed", { cause: queryError }) }, "wrapped");
    logger.error({ error: "via socks5://user:proxy-secret@proxy.example.internal:1080" }, "text");
    logger.error({ error: { name: "Error", code: "x", message: "already sanitized" } }, "object");

    const [plain, query, wrapped, text, object] = lines.map((line) =>
      (JSON.parse(line) as { error: unknown }).error);
    expect(plain).toMatchObject({ type: "Error", message: "canonicalize exploded" });
    expect((plain as { stack: string }).stack).toContain("canonicalize exploded");

    expect(query).toMatchObject({
      type: "DrizzleQueryError",
      query: "insert into dm_messages (body) values ($1)",
      message: expect.stringContaining("dm_messages_pkey"),
    });
    expect((query as { stack: string }).stack).toContain("caused by:");
    expect(query).not.toHaveProperty("params");
    expect((wrapped as { message: string }).message).toContain("family run failed");
    expect(JSON.stringify([query, wrapped])).not.toContain("private fan chat text");

    expect(text).not.toContain("proxy-secret");
    expect(object).toEqual({ name: "Error", code: "x", message: "already sanitized" });
  });
});
