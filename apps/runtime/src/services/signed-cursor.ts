import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import type { AppConfig } from "@agency_hub_core/shared";
import { z } from "zod";

/**
 * Opaque, signed pagination cursors: the one core every hub cursor is built on.
 *
 * Two layers:
 *
 * 1. **The envelope** (`sealCursorEnvelope` / `openCursorEnvelope`):
 *    `base64url(canonicalJson({format: 1, keyVersion, mac, payload}))`, the MAC
 *    an HMAC-SHA256 over a domain tag, the key version and the canonical
 *    payload. This is the Agent Read Plane's wire format, moved here unchanged
 *    (its cursors still decode byte for byte, `tests/signed-cursor.test.ts`
 *    pins a vector). Decoding refuses anything that does not round-trip:
 *    padding, ignored characters, alternate encodings, non-canonical JSON.
 * 2. **Scoped cursors** (`encodeSignedCursor` / `decodeSignedCursor`), for the
 *    chat-extension routes (the archive feed, the awaiting-reply queue, the
 *    "new subscribers" list). The cursor carries only the traversal state (a
 *    keyset position and the frozen snapshot it walks) and the time it was
 *    issued. What it is BOUND to — page, fan, user, archive generation, the
 *    window — never travels: it is MACed in, so a cursor presented for any
 *    other scope fails the same signature check a forgery fails, and the token
 *    names no internal id. Each domain signs with its own subkey of the key
 *    ring, so one route's cursor is never another route's.
 *
 * The key ring is the deployment's encryption ring (versioned, rotated by the
 * owner, always present); a cursor minted under a retired version stops
 * decoding once that version leaves the ring.
 *
 * Every refusal is the same `SignedCursorInvalidError` with the same message.
 * Its `reason` is for tests and internal logs only: telling a caller WHY its
 * cursor was refused (foreign scope versus tampering) is an oracle of
 * somebody else's scope. The route maps the error to its 400.
 */

/** The contract's cursor primitive (`clientCursorSchema`, the agent cursor) caps the wire at 2048. */
export const SIGNED_CURSOR_MAX_LENGTH = 2048;

const ENVELOPE_FORMAT = 1;
const SCOPED_PAYLOAD_VERSION = 1;
const SUBKEY_DOMAIN = "agency-hub:signed-cursor-subkey:v1";
/** One instance mints and another decodes; their clocks may disagree by this much. */
const ISSUED_AT_SKEW_MS = 5 * 60_000;

export interface SignedCursorKeyRing {
  /** The key new cursors are signed with. */
  key: Buffer;
  keyVersion: number;
  /** Every version a presented cursor may have been signed with. */
  keysByVersion: ReadonlyMap<number, Buffer>;
}

export function signedCursorKeyRing(
  config: Pick<AppConfig, "encryptionKey" | "encryptionKeyVersion" | "encryptionKeysByVersion">,
): SignedCursorKeyRing {
  return {
    key: config.encryptionKey,
    keyVersion: config.encryptionKeyVersion,
    keysByVersion: new Map(config.encryptionKeysByVersion),
  };
}

export type SignedCursorRefusal =
  | "malformed"
  | "unknown_key_version"
  | "signature"
  | "payload"
  | "expired";

export class SignedCursorInvalidError extends Error {
  constructor(readonly reason: SignedCursorRefusal) {
    super("cursor is not valid for this request");
    this.name = "SignedCursorInvalidError";
  }
}

/** Canonical JSON: keys sorted at every depth and `undefined` entries dropped, so
 *  one value has one byte form whatever its property order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) =>
    `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}

const envelopeSchema = z.object({
  format: z.literal(ENVELOPE_FORMAT),
  keyVersion: z.number().int().positive(),
  payload: z.unknown(),
  mac: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

function envelopeMac(
  domain: string,
  keyVersion: number,
  key: Buffer,
  payload: unknown,
  binding: string | undefined,
): string {
  const hmac = createHmac("sha256", key)
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(String(keyVersion), "utf8")
    .update("\0", "utf8")
    .update(Buffer.from(canonicalJson(payload), "utf8").toString("base64url"), "utf8");
  if (binding !== undefined) {
    hmac.update("\0", "utf8").update(binding, "utf8");
  }
  return hmac.digest("base64url");
}

/**
 * Signs `payload` (already validated by the caller) into an envelope. `binding`
 * is MACed but not carried: the decoder must present the same string.
 */
export function sealCursorEnvelope(
  domain: string,
  payload: unknown,
  ring: Pick<SignedCursorKeyRing, "key" | "keyVersion">,
  binding?: string,
): string {
  return Buffer.from(canonicalJson({
    format: ENVELOPE_FORMAT,
    keyVersion: ring.keyVersion,
    payload,
    mac: envelopeMac(domain, ring.keyVersion, ring.key, payload, binding),
  }), "utf8").toString("base64url");
}

/**
 * The authenticated payload of an envelope, still UNTYPED (the caller parses it
 * with its own strict schema), or a refusal. Constant-time MAC compare.
 */
export function openCursorEnvelope(
  domain: string,
  text: string,
  ring: Pick<SignedCursorKeyRing, "keysByVersion">,
  binding?: string,
): { ok: true; payload: unknown } | { ok: false; reason: SignedCursorRefusal } {
  if (text.length === 0 || text.length > SIGNED_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) {
    return { ok: false, reason: "malformed" };
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(text, "base64url").toString("utf8");
    // Node's base64url decoder is permissive; the round-trip rejects padding,
    // ignored characters and alternate encodings before anything is trusted.
    if (Buffer.from(json, "utf8").toString("base64url") !== text) {
      return { ok: false, reason: "malformed" };
    }
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success || envelope.data.payload === undefined) {
    return { ok: false, reason: "malformed" };
  }
  // Canonical bytes only: one cursor has exactly one valid spelling.
  if (Buffer.from(canonicalJson(envelope.data), "utf8").toString("base64url") !== text) {
    return { ok: false, reason: "malformed" };
  }
  const key = ring.keysByVersion.get(envelope.data.keyVersion);
  if (!key) {
    return { ok: false, reason: "unknown_key_version" };
  }
  const expected = Buffer.from(
    envelopeMac(domain, envelope.data.keyVersion, key, envelope.data.payload, binding),
    "base64url",
  );
  const provided = Buffer.from(envelope.data.mac, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "signature" };
  }
  return { ok: true, payload: envelope.data.payload };
}

/** What a scoped cursor is bound to. Compared by canonical JSON, never carried. */
export type SignedCursorScope = Readonly<Record<string, string | number | boolean | null>>;

export interface SignedCursorSpec<TState> {
  /**
   * Domain tag, versioned: `agency-hub:<route>-cursor:v<N>`. A new state shape
   * is a new domain, so an old cursor fails its signature instead of being
   * parsed as something it is not.
   */
  domain: string;
  /** The traversal state the cursor carries (keyset position, frozen snapshot). Make it strict. */
  state: z.ZodType<TState>;
  /** Lifetime from issue; omitted = no clock (the cursor lives as long as its scope and key). */
  ttlMs?: number;
}

const scopedPayloadSchema = z.object({
  v: z.literal(SCOPED_PAYLOAD_VERSION),
  /** Issue time, epoch milliseconds. */
  iat: z.number().int().nonnegative(),
  st: z.unknown(),
}).strict();

/** A per-domain subkey: the encryption ring's keys never sign a cursor directly. */
function domainKey(rootKey: Buffer, domain: string): Buffer {
  return createHmac("sha256", rootKey)
    .update(SUBKEY_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(domain, "utf8")
    .digest();
}

function scopeBinding(scope: SignedCursorScope): string {
  return canonicalJson(scope);
}

export function encodeSignedCursor<TState>(
  spec: SignedCursorSpec<TState>,
  input: { scope: SignedCursorScope; state: TState; now: Date },
  ring: SignedCursorKeyRing,
): string {
  const state = spec.state.parse(input.state);
  const token = sealCursorEnvelope(
    spec.domain,
    { v: SCOPED_PAYLOAD_VERSION, iat: input.now.getTime(), st: state },
    { key: domainKey(ring.key, spec.domain), keyVersion: ring.keyVersion },
    scopeBinding(input.scope),
  );
  if (token.length > SIGNED_CURSOR_MAX_LENGTH) {
    // A programming error, not a client one: the state outgrew the wire.
    throw new Error(`${spec.domain}: cursor is ${token.length} characters, over ${SIGNED_CURSOR_MAX_LENGTH}`);
  }
  return token;
}

/**
 * The state of a cursor presented for `expected.scope`, or the single refusal:
 * malformed, unknown key version, wrong signature (forged, tampered, minted for
 * another scope or route), unexpected state, issued in the future, or expired.
 */
export function decodeSignedCursor<TState>(
  spec: SignedCursorSpec<TState>,
  text: string,
  expected: { scope: SignedCursorScope; now: Date },
  ring: Pick<SignedCursorKeyRing, "keysByVersion">,
): TState {
  const subkeys = new Map<number, Buffer>();
  for (const [version, key] of ring.keysByVersion) {
    subkeys.set(version, domainKey(key, spec.domain));
  }
  const opened = openCursorEnvelope(spec.domain, text, { keysByVersion: subkeys }, scopeBinding(expected.scope));
  if (!opened.ok) {
    throw new SignedCursorInvalidError(opened.reason);
  }
  const payload = scopedPayloadSchema.safeParse(opened.payload);
  if (!payload.success) {
    throw new SignedCursorInvalidError("payload");
  }
  const state = spec.state.safeParse(payload.data.st);
  // A schema that strips or rewrites anything would serve a state the cursor
  // never carried; only a byte-identical parse is accepted.
  if (!state.success || canonicalJson(state.data) !== canonicalJson(payload.data.st)) {
    throw new SignedCursorInvalidError("payload");
  }
  const nowMs = expected.now.getTime();
  if (payload.data.iat > nowMs + ISSUED_AT_SKEW_MS) {
    throw new SignedCursorInvalidError("payload");
  }
  if (spec.ttlMs !== undefined && nowMs - payload.data.iat > spec.ttlMs) {
    throw new SignedCursorInvalidError("expired");
  }
  return state.data;
}
