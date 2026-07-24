import { describe, expect, it } from "vitest";

import { sanitizeError } from "@agency_hub_core/shared";

describe("shared error sanitizer", () => {
  it("formats cause chains with metadata and shape redaction", () => {
    const cause = Object.assign(
      new Error("upstream rejected sk-ant-api03-AbCdEfGhIjKlMnOp"),
      {
        name: "SocketError",
        code: "UND_ERR_SOCKET",
        socket: { remoteAddress: "203.0.113.9", remotePort: 443 },
      },
    );
    const result = sanitizeError(new TypeError("fetch failed", { cause }), {
      format: "chain",
    });

    expect(result.message).toContain("TypeError: fetch failed");
    expect(result.message).toContain("cause(1): SocketError:");
    expect(result.message).toContain("code=UND_ERR_SOCKET");
    expect(result.message).toContain("remoteAddress=203.0.113.9");
    expect(result.message).not.toContain("AbCdEfGh");
    expect(result.code).toBe("UND_ERR_SOCKET");
  });

  it("drops query bodies through a caller-owned projection", () => {
    const queryError = Object.assign(
      new Error("Failed query: insert into voice_notes values ($1) params: AUDIO_BYTES"),
      {
        name: "DrizzleQueryError",
        cause: { code: "22001" },
      },
    );
    const result = sanitizeError(queryError, {
      maxChars: 512,
      truncation: "clip",
      queryStyleMessage: ({ name, code }) => `${name}${code ? ` (${code})` : ""}`,
    });

    expect(result).toMatchObject({
      name: "DrizzleQueryError",
      code: "22001",
      message: "DrizzleQueryError (22001)",
      queryStyle: true,
      truncated: true,
    });
    expect(result.message).not.toContain("AUDIO_BYTES");
  });

  it("supports the existing ellipsis and literal-clip clamps", () => {
    expect(sanitizeError("x".repeat(20), {
      maxChars: 10,
      truncation: "ellipsis",
    }).message).toBe("xxxxxxx...");
    expect(sanitizeError("x".repeat(20), {
      maxChars: 10,
      truncation: "clip",
    }).message).toBe("xxxxxxxxxx");
  });
});
