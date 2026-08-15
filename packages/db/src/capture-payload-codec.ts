// Frozen canonical codec for content-addressed capture payloads (G5).
//
// This module is PURE: no database, no clock, no config. It is the only place
// that decides what "the same content" means, and its output feeds the digest
// that the payload catalog is addressed by.
//
// FROZEN means frozen. The v1 rules below may never be edited — an object
// written under v1 must still canonicalize to the same octets years later, or
// the catalog's dedup silently stops recognising its own rows. A change is a
// NEW version constant plus a new branch; codec_version is part of the object
// identity tuple, so v1 and v2 objects simply never coalesce.
//
// Why not JSON.stringify: key order follows insertion order (so two wire
// responses with the same fields hash differently), and Buffer.from(s,"utf8")
// silently replaces lone surrogates with U+FFFD (so two different payloads can
// hash the same). Both are disqualifying for a content-addressed store.

import { createHash } from "node:crypto";

export const CAPTURE_PAYLOAD_REPRESENTATIONS = ["canonical_json", "exact_bytes"] as const;
export type CapturePayloadRepresentation = (typeof CAPTURE_PAYLOAD_REPRESENTATIONS)[number];

/**
 * Canonical JSON, version 1. See `canonicalizeCaptureJson` for the frozen
 * rules this number pins.
 */
export const CAPTURE_JSON_CODEC_VERSION = 1;

/**
 * `exact_bytes` applies no transform at all — the wire octets ARE the content
 * (webhook raw bodies are hashed as received, never JSON-reserialized). Version
 * 0 records "identity codec" rather than pretending a transform happened.
 */
export const CAPTURE_EXACT_BYTES_CODEC_VERSION = 0;

/**
 * Domain-separation tag mixed into the digest preimage. Two representations of
 * byte-identical content must never produce the same digest — the identity
 * tuple already separates them, and this makes the separation true at the hash
 * level too.
 */
const REPRESENTATION_TAG: Record<CapturePayloadRepresentation, number> = {
  canonical_json: 1,
  exact_bytes: 2,
};

export class CapturePayloadCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapturePayloadCodecError";
  }
}

export function capturePayloadCodecVersionFor(representation: CapturePayloadRepresentation): number {
  return representation === "canonical_json"
    ? CAPTURE_JSON_CODEC_VERSION
    : CAPTURE_EXACT_BYTES_CODEC_VERSION;
}

/**
 * Canonical JSON v1 — the frozen rule set:
 *
 * 1. Object keys are emitted in ascending UTF-16 code-unit order (plain `<`
 *    comparison on the JS string). Insertion order is never observable.
 * 2. Keys whose value is `undefined` are dropped (JSON semantics); `undefined`
 *    inside an array becomes `null` (JSON semantics).
 * 3. Numbers must be finite. `-0` is emitted as `0`. Otherwise the shortest
 *    round-trip form (`String(n)`) is used.
 * 4. Strings are emitted with the JSON escapes for `"`, `\` and C0 controls,
 *    and — the part that matters — LONE SURROGATES are escaped as `\uXXXX`
 *    instead of being encoded, so they survive the digest instead of collapsing
 *    into U+FFFD.
 * 5. The result is encoded as UTF-8 explicitly.
 * 6. Anything that cannot round-trip through JSON is a loud error, never a
 *    silent coercion: `bigint`, `symbol`, functions, and every non-plain object
 *    (Date, Map, Set, class instances, Buffers). `toJSON` is deliberately NOT
 *    honoured — a capture payload is parsed wire JSON, and a value that needs
 *    a hook to become JSON is a bug at the call site, not something to guess at.
 * 7. Cycles are a loud error.
 *
 * Note what this codec does NOT promise: that Postgres can store the result in
 * `jsonb`. `jsonb` rejects a NUL escape and unpaired surrogates outright. That
 * insert failing loudly is the correct outcome — such a payload belongs in the
 * `exact_bytes` representation.
 */
export function canonicalizeCaptureJson(value: unknown): Buffer {
  const parts: string[] = [];
  writeValue(value, parts, new Set<object>());
  return Buffer.from(parts.join(""), "utf8");
}

/**
 * sha256 over `[representation tag u8][codec version u16be][canonical bytes]`.
 *
 * The version is INSIDE the preimage, not merely alongside it: bumping the
 * codec must change the digest of identical content, otherwise a v2 object and
 * a v1 object could arrive at the same digest and invite a reader to treat
 * bytes canonicalized under different rules as interchangeable.
 */
export interface CapturePayloadDigestInput {
  representation: CapturePayloadRepresentation;
  codecVersion: number;
  canonicalBytes: Buffer;
}

export function digestCapturePayload(input: CapturePayloadDigestInput): Buffer {
  const tag = REPRESENTATION_TAG[input.representation];
  if (tag === undefined) {
    throw new CapturePayloadCodecError(`unknown capture payload representation "${input.representation}"`);
  }
  if (!Number.isInteger(input.codecVersion) || input.codecVersion < 0 || input.codecVersion > 0xffff) {
    throw new CapturePayloadCodecError(
      `capture payload codec version must be a smallint-safe integer, got ${String(input.codecVersion)}`,
    );
  }
  const prefix = Buffer.alloc(3);
  prefix.writeUInt8(tag, 0);
  prefix.writeUInt16BE(input.codecVersion, 1);
  return createHash("sha256").update(prefix).update(input.canonicalBytes).digest();
}

function writeValue(value: unknown, parts: string[], ancestors: Set<object>): void {
  if (value === null) {
    parts.push("null");
    return;
  }

  switch (typeof value) {
    case "boolean":
      parts.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new CapturePayloadCodecError(
          `non-finite number ${String(value)} cannot be canonicalized (it has no JSON form)`,
        );
      }
      parts.push(Object.is(value, -0) ? "0" : String(value));
      return;
    case "string":
      parts.push(encodeString(value));
      return;
    case "bigint":
      throw new CapturePayloadCodecError(
        "bigint cannot be canonicalized: JSON.parse never produces one, so the value would not survive a round trip",
      );
    case "undefined":
      throw new CapturePayloadCodecError("undefined has no JSON form and cannot be a canonical payload");
    case "function":
    case "symbol":
      throw new CapturePayloadCodecError(`${typeof value} has no JSON form and cannot be canonicalized`);
    default:
      break;
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw new CapturePayloadCodecError("cyclic value cannot be canonicalized");
  }
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      writeArray(object, parts, ancestors);
      return;
    }
    writeObject(object, parts, ancestors);
  } finally {
    ancestors.delete(object);
  }
}

function writeArray(value: unknown[], parts: string[], ancestors: Set<object>): void {
  parts.push("[");
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) {
      parts.push(",");
    }
    const item = value[index];
    if (item === undefined) {
      parts.push("null");
      continue;
    }
    writeValue(item, parts, ancestors);
  }
  parts.push("]");
}

function writeObject(value: object, parts: string[], ancestors: Set<object>): void {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== null && prototype !== Object.prototype) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
    throw new CapturePayloadCodecError(
      `${name} is not a plain JSON object; canonicalize the wire value, not a runtime wrapper`,
    );
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCanonicalKeys);

  parts.push("{");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      continue;
    }
    if (index > 0) {
      parts.push(",");
    }
    parts.push(encodeString(key), ":");
    writeValue(record[key], parts, ancestors);
  }
  parts.push("}");
}

/** Frozen ordering rule: ascending UTF-16 code unit, i.e. plain `<` on strings. */
function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function encodeString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    switch (code) {
      case 0x22:
        out += '\\"';
        continue;
      case 0x5c:
        out += "\\\\";
        continue;
      case 0x08:
        out += "\\b";
        continue;
      case 0x09:
        out += "\\t";
        continue;
      case 0x0a:
        out += "\\n";
        continue;
      case 0x0c:
        out += "\\f";
        continue;
      case 0x0d:
        out += "\\r";
        continue;
      default:
        break;
    }
    if (code < 0x20) {
      out += unicodeEscape(code);
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += String.fromCharCode(code, next);
        index += 1;
        continue;
      }
      // Unpaired high surrogate: escape it rather than let UTF-8 encoding
      // replace it with U+FFFD (which would make two payloads share a digest).
      out += unicodeEscape(code);
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += unicodeEscape(code);
      continue;
    }
    out += String.fromCharCode(code);
  }
  return `${out}"`;
}

function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}
