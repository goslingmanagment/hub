import { describe, expect, it } from "vitest";

import { sanitizeLoneSurrogatesDeep, truncateUtf16Safe } from "@agency_hub_core/shared";

// 2026-07-11 deploy-night find: a reply-preview slice cut an emoji in half;
// the lone high surrogate made Postgres reject the derived sync_event jsonb
// ("Unicode low surrogate must follow a high surrogate") and webhook event
// 152584 sat pending for 7 days of silent minutely retries.

describe("truncateUtf16Safe", () => {
  it("never splits a surrogate pair at the boundary", () => {
    const base = "x".repeat(119);
    const text = `${base}😊 tail`; // emoji spans code units 120-121
    const preview = truncateUtf16Safe(text, 120);
    expect(preview).toBe(base); // dangling high surrogate dropped
    expect(preview.length).toBe(119);
    // Round-trips through JSON + is well-formed for Postgres jsonb.
    expect(() => JSON.parse(JSON.stringify({ preview }))).not.toThrow();
  });

  it("keeps whole pairs when the cut lands after them and short strings verbatim", () => {
    expect(truncateUtf16Safe("hi 😊", 5)).toBe("hi 😊");
    expect(truncateUtf16Safe("hi 😊", 50)).toBe("hi 😊");
    expect(truncateUtf16Safe("plain", 3)).toBe("pla");
  });
});

describe("sanitizeLoneSurrogatesDeep", () => {
  it("replaces unpaired surrogates in nested strings, preserves real emoji", () => {
    const wedged = {
      message: {
        text: "<p>Have u already prepared everything? 🥰</p>",
        replyTo: { textPreview: "Only one week before vacation. \ud83d" },
        list: ["ok", "broken \udfff low"],
      },
    };
    const clean = sanitizeLoneSurrogatesDeep(wedged);
    expect(clean.message.text).toBe("<p>Have u already prepared everything? 🥰</p>");
    expect(clean.message.replyTo.textPreview).toBe("Only one week before vacation. �");
    expect(clean.message.list[1]).toBe("broken � low");
    // The whole tree is jsonb-safe now.
    expect(JSON.stringify(clean)).not.toMatch(/\\ud83d(?!\\ud)/i);
  });

  it("passes primitives and null through untouched", () => {
    expect(sanitizeLoneSurrogatesDeep(5)).toBe(5);
    expect(sanitizeLoneSurrogatesDeep(null)).toBeNull();
    expect(sanitizeLoneSurrogatesDeep(true)).toBe(true);
  });
});
