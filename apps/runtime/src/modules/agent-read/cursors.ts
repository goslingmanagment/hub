import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  openCursorEnvelope,
  sealCursorEnvelope,
  type SignedCursorKeyRing,
} from "../../services/signed-cursor.ts";
import { AgentCursorInvalidError } from "./errors.ts";

export { canonicalJson };

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
 *
 * The envelope (encoding, canonical round-trip, domain-separated HMAC,
 * constant-time compare) is the shared core in `services/signed-cursor.ts`; this
 * file keeps the agent's payload, its expectations and its error. The wire is
 * unchanged: `tests/signed-cursor.test.ts` pins an agent cursor byte for byte.
 */

const CURSOR_HMAC_DOMAIN = "agency-hub:agent-read-cursor:v1";

const cursorPayloadSchema = z.object({
  version: z.literal(1),
  /** Which operation minted it: a threads cursor is not a transcript cursor. */
  operation: z.string().min(1).max(64),
  /**
   * The RESOURCE the traversal is walking, when the operation addresses one by
   * path: `conversation:<pageId>:<ref>` for a transcript, `dataset:<name>` for a
   * dataset query.
   *
   * Without it the operation name alone let a cursor minted for one conversation
   * resume against another, and a dataset cursor replay against a different
   * dataset whose keyset happens to parse — the response then presents a
   * different population as a continuation of the first page.
   */
  resource: z.string().min(1).max(200),
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

export type AgentCursorPayload = z.infer<typeof cursorPayloadSchema>;

export function agentParamsHash(params: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(params), "utf8").digest("hex");
}

export type AgentCursorSigning = SignedCursorKeyRing;

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
  return sealCursorEnvelope(CURSOR_HMAC_DOMAIN, canonical, signing);
}

export interface AgentCursorExpectation {
  operation: string;
  /** `"global"` for the operations that address no path resource. */
  resource: string;
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
  // Envelope: length, alphabet, canonical round-trip, key version, MAC.
  const opened = openCursorEnvelope(CURSOR_HMAC_DOMAIN, text, signing);
  if (!opened.ok) {
    throw new AgentCursorInvalidError();
  }
  const result = cursorPayloadSchema.safeParse(opened.payload);
  // The envelope already proved the bytes canonical; a parse that rewrote the
  // payload would serve something the cursor never carried.
  if (!result.success || canonicalJson(result.data) !== canonicalJson(opened.payload)) {
    throw new AgentCursorInvalidError();
  }

  const payload = result.data;
  if (payload.operation !== expectation.operation) {
    throw new AgentCursorInvalidError();
  }
  if (payload.resource !== expectation.resource) {
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
