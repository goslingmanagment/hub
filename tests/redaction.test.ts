import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "@agency_hub_core/shared";

describe("redactSensitiveText", () => {
  it("redacts proxy URLs with inline credentials", () => {
    expect(
      redactSensitiveText("proxy failed: http://user:pass@proxy.example:8080."),
    ).toBe("proxy failed: http://proxy.example:8080 (auth).");
  });

  it("redacts credential-bearing database URLs", () => {
    expect(
      redactSensitiveText("connect ECONNREFUSED postgres://postgres:secret@db.example:5432/app?sslmode=require"),
    ).toBe("connect ECONNREFUSED postgres://db.example:5432/app?sslmode=require (auth)");
  });

  it("redacts Telegram bot tokens in URL paths", () => {
    expect(
      redactSensitiveText("request to https://api.telegram.org/bot123:abc/sendMessage failed"),
    ).toBe("request to https://api.telegram.org/bot[REDACTED]/sendMessage failed");
  });
});
