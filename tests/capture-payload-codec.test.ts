import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

// Imported from the module, not the @agency_hub_core/db barrel: this codec is
// pure and its unit test must not drag the schema (or a database) in with it.
import {
  CAPTURE_EXACT_BYTES_CODEC_VERSION,
  CAPTURE_JSON_CODEC_VERSION,
  CapturePayloadCodecError,
  canonicalizeCaptureJson,
  capturePayloadCodecVersionFor,
  digestCapturePayload,
} from "../packages/db/src/capture-payload-codec.ts";

function canonicalText(value: unknown): string {
  return canonicalizeCaptureJson(value).toString("utf8");
}

function jsonDigest(value: unknown): string {
  return digestCapturePayload({
    representation: "canonical_json",
    codecVersion: CAPTURE_JSON_CODEC_VERSION,
    canonicalBytes: canonicalizeCaptureJson(value),
  }).toString("hex");
}

describe("canonical capture JSON — key order", () => {
  it("emits object keys in the frozen order regardless of insertion order", () => {
    const inserted = { b: 2, a: 1, c: 3 };
    const reordered = { c: 3, a: 1, b: 2 };
    expect(canonicalText(inserted)).toBe('{"a":1,"b":2,"c":3}');
    expect(canonicalText(reordered)).toBe(canonicalText(inserted));
    expect(jsonDigest(reordered)).toBe(jsonDigest(inserted));
  });

  it("sorts nested objects too, and never reorders arrays", () => {
    const value = { outer: { z: [3, 1, 2], a: { y: 1, x: 2 } } };
    expect(canonicalText(value)).toBe('{"outer":{"a":{"x":2,"y":1},"z":[3,1,2]}}');
  });

  it("is stable across a jsonb-style round trip — the dedup comparison depends on it", () => {
    // Postgres hands a jsonb body back with its own key order; the writer
    // re-canonicalizes it and compares octets. That only works if canonicalize
    // is idempotent over JSON.parse.
    const original = canonicalizeCaptureJson({ z: 1, a: { m: [1, { q: 2, b: 3 }] } });
    const reparsed = canonicalizeCaptureJson(JSON.parse(original.toString("utf8")));
    expect(Buffer.compare(reparsed, original)).toBe(0);
  });
});

describe("canonical capture JSON — value rules", () => {
  it("drops undefined object members and nulls undefined array slots", () => {
    expect(canonicalText({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalText([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("normalizes -0 and rejects non-finite numbers", () => {
    expect(canonicalText({ n: -0 })).toBe('{"n":0}');
    expect(() => canonicalizeCaptureJson({ n: Number.NaN })).toThrow(CapturePayloadCodecError);
    expect(() => canonicalizeCaptureJson({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  it("refuses values that cannot round-trip through JSON, loudly", () => {
    expect(() => canonicalizeCaptureJson({ n: 1n })).toThrow(/bigint/);
    expect(() => canonicalizeCaptureJson({ d: new Date(0) })).toThrow(/not a plain JSON object/);
    expect(() => canonicalizeCaptureJson({ m: new Map() })).toThrow(/not a plain JSON object/);
    expect(() => canonicalizeCaptureJson({ b: Buffer.from("x") })).toThrow(/not a plain JSON object/);
    expect(() => canonicalizeCaptureJson(undefined)).toThrow(/undefined/);
  });

  it("rejects cycles instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalizeCaptureJson(cyclic)).toThrow(/cyclic/);
  });

  it("escapes control characters and passes ordinary Unicode through as UTF-8", () => {
    expect(canonicalText({ s: "a\u0001b\n" })).toBe('{"s":"a\\u0001b\\n"}');
    // Explicit UTF-8: the cyrillic string is 4 code points / 8 octets.
    const bytes = canonicalizeCaptureJson("тест");
    expect(bytes.length).toBe(10); // 8 payload octets + 2 quotes
    expect(bytes.toString("utf8")).toBe('"тест"');
  });

  it("keeps lone surrogates distinguishable instead of collapsing them to U+FFFD", () => {
    // Buffer.from(s, "utf8") turns every unpaired surrogate into U+FFFD, so a
    // naive codec would give these two payloads the SAME digest.
    const high = { s: "\ud800" };
    const low = { s: "\udc00" };
    expect(canonicalText(high)).toBe('{"s":"\\ud800"}');
    expect(canonicalText(low)).toBe('{"s":"\\udc00"}');
    expect(jsonDigest(high)).not.toBe(jsonDigest(low));

    // A well-formed pair is left as literal UTF-8, not escaped.
    expect(canonicalText({ s: "😀" })).toBe('{"s":"😀"}');
  });
});

describe("capture payload digest", () => {
  it("is a 32-byte sha256 over [representation tag][codec version][content]", () => {
    const canonicalBytes = canonicalizeCaptureJson({ a: 1 });
    const digest = digestCapturePayload({
      representation: "canonical_json",
      codecVersion: CAPTURE_JSON_CODEC_VERSION,
      canonicalBytes,
    });
    expect(digest).toHaveLength(32);

    const prefix = Buffer.alloc(3);
    prefix.writeUInt8(1, 0);
    prefix.writeUInt16BE(CAPTURE_JSON_CODEC_VERSION, 1);
    const expected = createHash("sha256").update(prefix).update(canonicalBytes).digest();
    expect(Buffer.compare(digest, expected)).toBe(0);
  });

  it("changes when the codec version is bumped, for byte-identical content", () => {
    const canonicalBytes = canonicalizeCaptureJson({ a: 1 });
    const v1 = digestCapturePayload({
      representation: "canonical_json",
      codecVersion: CAPTURE_JSON_CODEC_VERSION,
      canonicalBytes,
    });
    const v2 = digestCapturePayload({
      representation: "canonical_json",
      codecVersion: CAPTURE_JSON_CODEC_VERSION + 1,
      canonicalBytes,
    });
    expect(v1.toString("hex")).not.toBe(v2.toString("hex"));
  });

  it("separates the two representations of identical octets", () => {
    const canonicalBytes = Buffer.from('{"a":1}', "utf8");
    const asJson = digestCapturePayload({
      representation: "canonical_json",
      codecVersion: 0,
      canonicalBytes,
    });
    const asBytes = digestCapturePayload({
      representation: "exact_bytes",
      codecVersion: 0,
      canonicalBytes,
    });
    expect(asJson.toString("hex")).not.toBe(asBytes.toString("hex"));
  });

  it("rejects a codec version that cannot be a smallint", () => {
    const canonicalBytes = canonicalizeCaptureJson(null);
    expect(() => digestCapturePayload({
      representation: "canonical_json",
      codecVersion: -1,
      canonicalBytes,
    })).toThrow(CapturePayloadCodecError);
    expect(() => digestCapturePayload({
      representation: "canonical_json",
      codecVersion: 1.5,
      canonicalBytes,
    })).toThrow(/smallint-safe/);
  });

  it("pins the version constants each representation records", () => {
    expect(capturePayloadCodecVersionFor("canonical_json")).toBe(CAPTURE_JSON_CODEC_VERSION);
    expect(capturePayloadCodecVersionFor("exact_bytes")).toBe(CAPTURE_EXACT_BYTES_CODEC_VERSION);
    expect(CAPTURE_JSON_CODEC_VERSION).toBe(1);
    expect(CAPTURE_EXACT_BYTES_CODEC_VERSION).toBe(0);
  });
});
