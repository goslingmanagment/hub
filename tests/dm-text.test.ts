import { describe, expect, it } from "vitest";

import { normalizeDmMessageText } from "@agency_hub_core/shared";

// The text normalizer every message store's `text_plain` goes through, and
// every item of a client's fresh text (chat-extension H-4c). It runs on input
// the hub does not control, so it has no input it fails on.

describe("normalizeDmMessageText", () => {
  it("turns a platform message into plain text", () => {
    expect(normalizeDmMessageText("<p>look &amp; tell me</p><p>ok?<br>see <a href=\"https://x.example/a\">this</a></p>"))
      .toBe("look & tell me\nok?\nsee this");
    expect(normalizeDmMessageText("caf&#233; &#x1F48B; &#X41;&nbsp;b")).toBe("café 💋 A b");
    expect(normalizeDmMessageText(null)).toBe("");
    expect(normalizeDmMessageText(undefined)).toBe("");
  });

  it("keeps a numeric reference that names no character as the text it was", () => {
    // One past Unicode's last code point, decimal and hex: String.fromCodePoint throws on both.
    expect(normalizeDmMessageText("lol &#1114112; ok")).toBe("lol &#1114112; ok");
    expect(normalizeDmMessageText("lol &#x110000; ok")).toBe("lol &#x110000; ok");
    // A run of digits long enough to stop being an integer.
    expect(normalizeDmMessageText(`a &#${"9".repeat(40)}; b`)).toBe(`a &#${"9".repeat(40)}; b`);
    expect(normalizeDmMessageText(`a &#x${"f".repeat(400)}; b`)).toBe(`a &#x${"f".repeat(400)}; b`);
    // The last code point itself is one, and so is the first.
    expect(normalizeDmMessageText("&#1114111;")).toBe(String.fromCodePoint(0x10ffff));
    expect(normalizeDmMessageText("&#x10FFFF;")).toBe(String.fromCodePoint(0x10ffff));
    // A name it does not know was always kept.
    expect(normalizeDmMessageText("fish &chips; now")).toBe("fish &chips; now");
  });

  it("has no text it throws on", () => {
    const hostile = [
      "&#1114112;", "&#x110000;", "&#0;", "&#xD800;", "&#xDFFF;", "&#4294967296;", "&#x;", "&#;", "&;",
      `&#${"1".repeat(5000)};`, "<".repeat(5000), "&".repeat(5000), "<p".repeat(2500), "\u0000\ud800",
    ];
    for (const text of hostile) {
      expect(() => normalizeDmMessageText(text), text.slice(0, 20)).not.toThrow();
    }
  });
});
