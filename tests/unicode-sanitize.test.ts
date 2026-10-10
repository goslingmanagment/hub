import { describe, expect, it } from "vitest";

import {
  countPostgresUnstorableDeep,
  sanitizeLoneSurrogatesDeep,
  sanitizePostgresText,
  sanitizePostgresTextDeep,
  truncateUtf16Safe,
} from "@agency_hub_core/shared";

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

describe("sanitizePostgresText", () => {
  it("replaces unpaired surrogates and NUL with U+FFFD, keeps pairs and everything else", () => {
    expect(sanitizePostgresText("love you \ud83d")).toBe("love you \uFFFD");
    expect(sanitizePostgresText("\udfff low \u0000 nul")).toBe("\uFFFD low \uFFFD nul");
    expect(sanitizePostgresText("\u0000\u0000")).toBe("\uFFFD\uFFFD");
    const plain = "whole 🥰 pair, tabs\tand\nlines";
    expect(sanitizePostgresText(plain)).toBe(plain);
    // What jsonb refuses: a lone surrogate escape or a NUL escape.
    expect(JSON.stringify(sanitizePostgresText("a\ud83d\u0000b"))).not.toMatch(/\\u(d[89ab]|0000)/i);
  });
});

describe("sanitizePostgresTextDeep and countPostgresUnstorableDeep (bug hunt Д3)", () => {
  it("replace and count unpaired surrogates and NUL in values and keys, keep everything else", () => {
    const body = {
      text: "whole 🥰 pair, tab\there",
      "key\u0000": ["a\u0000b", "lone \ud83d", 5, null, true],
      nested: { deeper: "\u0000\u0000", "\udfffk": "ok" },
    };
    const snapshot = JSON.stringify(body);
    expect(countPostgresUnstorableDeep(body)).toEqual({ loneSurrogates: 2, nul: 4 });
    const clean = sanitizePostgresTextDeep(body);
    expect(clean).toEqual({
      text: "whole 🥰 pair, tab\there",
      "key�": ["a�b", "lone �", 5, null, true],
      nested: { deeper: "��", "�k": "ok" },
    });
    expect(countPostgresUnstorableDeep(clean)).toEqual({ loneSurrogates: 0, nul: 0 });
    expect(JSON.stringify(clean)).not.toMatch(/\\u(d[89ab]|0000)/i);
    // The input is never mutated.
    expect(JSON.stringify(body)).toBe(snapshot);
  });

  it("pass primitives through and keep a parsed __proto__ key as data", () => {
    expect(sanitizePostgresTextDeep(5)).toBe(5);
    expect(sanitizePostgresTextDeep(null)).toBeNull();
    expect(countPostgresUnstorableDeep("plain")).toEqual({ loneSurrogates: 0, nul: 0 });
    expect(countPostgresUnstorableDeep(undefined)).toEqual({ loneSurrogates: 0, nul: 0 });
    const parsed = JSON.parse('{"__proto__":{"a":"x\\u0000"}}') as Record<string, unknown>;
    const clean = sanitizePostgresTextDeep(parsed);
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
    expect(JSON.stringify(clean)).toBe('{"__proto__":{"a":"x�"}}');
  });
});
