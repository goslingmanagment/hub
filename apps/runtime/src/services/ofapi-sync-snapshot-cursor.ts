import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const cursorPhaseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unresolved"),
    afterRowId: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("archive"),
    threadId: z.number().int().positive(),
    afterRowId: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("hot"),
    threadId: z.number().int().positive(),
    afterRowId: z.number().int().nonnegative(),
  }).strict(),
]);

const cursorPayloadSchema = z.object({
  version: z.literal(1),
  accountId: z.string().min(1),
  afterSeq: z.number().int().nonnegative(),
  snapshotCursor: z.number().int().nonnegative(),
  stateAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  messageLimit: z.number().int().positive(),
  // Optional only for rolling-upgrade compatibility with a walk started by
  // the immediately preceding Core. Newly issued continuations always carry
  // all three signed maxima.
  maxThreadId: z.number().int().nonnegative().optional(),
  maxArchiveId: z.number().int().nonnegative().optional(),
  maxHotMessageId: z.number().int().nonnegative().optional(),
  phase: cursorPhaseSchema,
}).strict();

const signedCursorSchema = z.object({
  format: z.literal(1),
  keyVersion: z.number().int().positive(),
  payload: cursorPayloadSchema,
  mac: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

const CURSOR_HMAC_DOMAIN = "agency-hub:ofapi-sync-snapshot-state-cursor:v1";

export type OfapiSyncSnapshotStateCursor = z.infer<typeof cursorPayloadSchema>;

function encodePayload(payload: OfapiSyncSnapshotStateCursor): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function cursorMac(
  payload: OfapiSyncSnapshotStateCursor,
  keyVersion: number,
  key: Buffer,
) {
  return createHmac("sha256", key)
    .update(CURSOR_HMAC_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(String(keyVersion), "utf8")
    .update("\0", "utf8")
    .update(encodePayload(payload), "utf8")
    .digest("base64url");
}

function encodeSignedCursor(input: z.infer<typeof signedCursorSchema>) {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

export function encodeOfapiSyncSnapshotStateCursor(
  payload: OfapiSyncSnapshotStateCursor,
  signing: {
    key: Buffer;
    keyVersion: number;
  },
): string {
  const canonicalPayload = cursorPayloadSchema.parse(payload);
  return encodeSignedCursor(signedCursorSchema.parse({
    format: 1,
    keyVersion: signing.keyVersion,
    payload: canonicalPayload,
    mac: cursorMac(canonicalPayload, signing.keyVersion, signing.key),
  }));
}

export function decodeOfapiSyncSnapshotStateCursor(
  text: string,
  keysByVersion: ReadonlyMap<number, Buffer>,
): OfapiSyncSnapshotStateCursor | null {
  if (text.length === 0 || text.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(text)) {
    return null;
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(text, "base64url").toString("utf8");
    // Node's decoder is intentionally permissive; round-trip rejects padding,
    // ignored characters, and alternate encodings before JSON validation.
    if (Buffer.from(json, "utf8").toString("base64url") !== text) {
      return null;
    }
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = signedCursorSchema.safeParse(parsed);
  if (!result.success || encodeSignedCursor(result.data) !== text) {
    return null;
  }
  const key = keysByVersion.get(result.data.keyVersion);
  if (!key) {
    return null;
  }
  const expected = Buffer.from(cursorMac(
    result.data.payload,
    result.data.keyVersion,
    key,
  ), "base64url");
  const provided = Buffer.from(result.data.mac, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }
  return result.data.payload;
}
