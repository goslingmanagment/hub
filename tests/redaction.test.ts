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

  it("redacts vendor, bearer, and labelled secret shapes", () => {
    const input = [
      "anthropic=sk-ant-api03-AbCdEfGhIjKlMnOpQrSt",
      "elevenlabs=sk_0123456789abcdef0123456789abcdef",
      "ofapi=ofapi_AbCdEf0123456789ghij",
      "Authorization: Bearer abcdef0123456789.payload",
      "ELEVENLABS_API_KEY=plainlabelledsecret123",
      "\"apiKey\":\"anotherlabelledsecret456\"",
    ].join(" ");
    const redacted = redactSensitiveText(input);

    expect(redacted).not.toContain("AbCdEfGh");
    expect(redacted).not.toContain("0123456789abcdef");
    expect(redacted).not.toContain("abcdef0123456789");
    expect(redacted).not.toContain("plainlabelledsecret123");
    expect(redacted).not.toContain("anotherlabelledsecret456");
    expect(redacted).toContain("[REDACTED]");
  });

  it("preserves ordinary non-secret text", () => {
    const text = "The token budget is 1200 and the proxy check completed normally.";
    expect(redactSensitiveText(text)).toBe(text);
  });
});
