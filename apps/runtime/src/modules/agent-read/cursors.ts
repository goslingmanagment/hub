import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { AgentCursorInvalidError } from "./errors.ts";

/**
 * Opaque, signed, self-describing pagination cursors.
 *
 * Modelled on the bounded-OFAPI `stateCursor` (same domain-separated HMAC, same
 * canonical round-trip), with three plane-specific requirements:
 *
 * 1. **The cursor CARRIES the normalized request, verbatim.** The contract
 *    forbids re-sending `from`/`to`/filters alongside a cursor, so page 2's query
 *    has to come from somewhere; an irreversible hash cannot reconstruct it. The
 *    payload therefore holds the normalized parameters AND a digest of them, and
 *    the digest is what a tamper check compares.
 * 2. **It carries the resolved page ids.** The grant is intersected in SQL, and a
 *    traversal must not silently widen or narrow when the key's grant changes
 *    between pages: a mismatch is a 400, never a quietly reshaped snapshot.
 * 3. **It carries `archiveGeneration` and the source high-waters.** The rebuild
 *    swap can rename `message_archive` under a reader; a cursor minted before the
 *    swap would resume a keyset in a different table, skip rows, and report a
 *    FALSE `snapshotExhausted` — "I read everything" about a table it never read.
 *
 * EVERY failure — bad base64, failed round-trip, failed Zod, failed MAC, unknown
 * key version, foreign key id, changed grant, changed generation, changed request
 * — produces the SAME 400. The differences are oracles of somebody else's scope.
 */

const CURSOR_HMAC_DOMAIN = "agency-hub:agent-read-cursor:v1";

const cursorPayloadSchema = z.object({
  version: z.literal(1),
  /** Which operation minted it: a threads cursor is not a transcript cursor. */
  operation: z.string().min(1).max(64),
  /** The agent key that minted it. A foreign cursor is refused. */
  keyId: z.number().int().positive(),
  /** Already resolved and intersected with the grant at mint time. */
  pageIds: z.array(z.number().int().positive()),
  /** The normalized request, verbatim. Page 2 is served from THIS, not from the
   *  caller re-describing the query. */
  params: z.record(z.string(), z.unknown()),
  /** sha256 of the canonical JSON of `params`; the tamper check compares it. */
  paramsHash: z.string().length(64).regex(/^[0-9a-f]{64}$/),
  archiveGeneration: z.number().int().nonnegative(),
  /** Frozen per-source membership maxima. `snapshotExhausted` derives from these,
   *  not from the generation alone. */
  sourceHighWaters: z.record(z.string(), z.string()),
  /** `account_seq` is gapless PER ACCOUNT, so this is a map, never a scalar. */
  seqHighWater: z.record(z.string(), z.number().int().nonnegative()),
  keyset: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  issuedAt: z.string().min(1),
}).strict();

const signedCursorSchema = z.object({
  format: z.literal(1),
  keyVersion: z.number().int().positive(),
  payload: cursorPayloadSchema,
  mac: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export type AgentCursorPayload = z.infer<typeof cursorPayloadSchema>;

/** Canonical JSON: keys sorted at every depth, so the digest of one request is
 *  stable across property order. */
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

export function agentParamsHash(params: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(params), "utf8").digest("hex");
}

function encodePayload(payload: AgentCursorPayload): string {
  return Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
}

function cursorMac(payload: AgentCursorPayload, keyVersion: number, key: Buffer): string {
  return createHmac("sha256", key)
    .update(CURSOR_HMAC_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(String(keyVersion), "utf8")
    .update("\0", "utf8")
    .update(encodePayload(payload), "utf8")
    .digest("base64url");
}

function encodeSigned(signed: z.infer<typeof signedCursorSchema>): string {
  return Buffer.from(canonicalJson(signed), "utf8").toString("base64url");
}

export interface AgentCursorSigning {
  key: Buffer;
  keyVersion: number;
  keysByVersion: ReadonlyMap<number, Buffer>;
}

export function encodeAgentCursor(
  payload: Omit<AgentCursorPayload, "paramsHash" | "version" | "issuedAt"> & {
    issuedAt?: string;
  },
  signing: AgentCursorSigning,
): string {
  const canonical = cursorPayloadSchema.parse({
    ...payload,
    version: 1,
    paramsHash: agentParamsHash(payload.params),
    issuedAt: payload.issuedAt ?? new Date().toISOString(),
  } satisfies AgentCursorPayload);
  return encodeSigned(signedCursorSchema.parse({
    format: 1,
    keyVersion: signing.keyVersion,
    payload: canonical,
    mac: cursorMac(canonical, signing.keyVersion, signing.key),
  }));
}

export interface AgentCursorExpectation {
  operation: string;
  keyId: number;
  pageIds: readonly number[];
  archiveGeneration: number;
}

/**
 * Decodes and VALIDATES a cursor, or throws the single static 400.
 *
 * Note what is deliberately absent: a TTL. A cursor is valid while its key
 * version is in the ring and its archive generation still matches; adding a clock
 * would expire a legitimate long traversal without making anything safer.
 */
export function decodeAgentCursor(
  text: string,
  expectation: AgentCursorExpectation,
  signing: AgentCursorSigning,
): AgentCursorPayload {
  if (text.length === 0 || text.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new AgentCursorInvalidError();
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(text, "base64url").toString("utf8");
    // Node's base64url decoder is permissive; the round-trip rejects padding,
    // ignored characters and alternate encodings before anything is trusted.
    if (Buffer.from(json, "utf8").toString("base64url") !== text) {
      throw new AgentCursorInvalidError();
    }
    parsed = JSON.parse(json);
  } catch {
    throw new AgentCursorInvalidError();
  }

  const result = signedCursorSchema.safeParse(parsed);
  if (!result.success || encodeSigned(result.data) !== text) {
    throw new AgentCursorInvalidError();
  }
  const key = signing.keysByVersion.get(result.data.keyVersion);
  if (!key) {
    throw new AgentCursorInvalidError();
  }
  const expected = Buffer.from(cursorMac(result.data.payload, result.data.keyVersion, key), "base64url");
  const provided = Buffer.from(result.data.mac, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new AgentCursorInvalidError();
  }

  const payload = result.data.payload;
  if (payload.operation !== expectation.operation) {
    throw new AgentCursorInvalidError();
  }
  if (payload.keyId !== expectation.keyId) {
    throw new AgentCursorInvalidError();
  }
  if (payload.archiveGeneration !== expectation.archiveGeneration) {
    throw new AgentCursorInvalidError();
  }
  if (agentParamsHash(payload.params) !== payload.paramsHash) {
    throw new AgentCursorInvalidError();
  }
  const mintedPages = [...payload.pageIds].sort((a, b) => a - b).join(",");
  const currentPages = [...expectation.pageIds].sort((a, b) => a - b).join(",");
  if (mintedPages !== currentPages) {
    // An empty 200 here would silently reshape the snapshot when a grant changes
    // mid-traversal; a 400 makes the caller start over with an honest scope.
    throw new AgentCursorInvalidError();
  }
  return payload;
}
