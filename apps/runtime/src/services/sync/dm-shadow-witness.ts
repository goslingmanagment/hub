import { createHash } from "node:crypto";
import { canonicalizeCaptureJson } from "@agency_hub_core/db";
import { z } from "zod";

export const DM_SHADOW_WITNESS_LIMIT = 20;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// Only pointers into existing capture, never copied fan IDs or message material.
// Changed/erased bodies invalidate the pointer; retained shared raw stays resolvable.
export const dmShadowWitnessSchema = z.object({
  codecVersion: z.literal(1),
  observationId: integer.positive(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  itemIndex: integer,
  pageNumber: integer.positive(),
  readStartedAtMs: integer,
  readFinishedAtMs: integer,
  state: z.enum(["missing", "deleted", "content_pending", "unknown"]),
  source: z.enum(["message_archive", "dm_message_archive", "hot"]).nullable(),
  liveHotCopy: z.boolean().nullable(),
}).refine(value => value.readFinishedAtMs >= value.readStartedAtMs);
export type DmShadowWitness = z.infer<typeof dmShadowWitnessSchema>;
export type DmShadowWitnessPointer = Pick<DmShadowWitness,
  "codecVersion" | "observationId" | "payloadSha256" | "itemIndex" | "readStartedAtMs" | "readFinishedAtMs">;

type CapturedList = { data: Array<{ groupId: string; lastMessageId: string | null }> };

export function dmShadowPayloadSha256(payload: unknown): string {
  return createHash("sha256").update(canonicalizeCaptureJson(payload)).digest("hex");
}

/** Bind the mapped item to its unique position in the actual retained body.
 * Trim/mapping may filter or reorder rows; a mapped index is not evidence. */
export function createDmShadowWitnessPointers(input: {
  observationId: number | null;
  payload: CapturedList;
  readStartedAtMs: number;
  readFinishedAtMs: number;
}): (groupId: string, messageId: string | null) => DmShadowWitnessPointer | null {
  if (input.observationId === null || input.readFinishedAtMs < input.readStartedAtMs) return () => null;
  const observationId = input.observationId;
  let payloadSha256: string;
  try { payloadSha256 = dmShadowPayloadSha256(input.payload); }
  catch { return () => null; } // A diagnostic cannot interrupt capture or apply.
  return (groupId, messageId) => {
    const matches = input.payload.data.flatMap((item, index) =>
      item.groupId === groupId && item.lastMessageId === messageId ? [index] : []);
    if (matches.length !== 1) return null;
    return { codecVersion: 1, observationId, payloadSha256, itemIndex: matches[0]!,
      readStartedAtMs: input.readStartedAtMs, readFinishedAtMs: input.readFinishedAtMs };
  };
}

/** Offline resolution only. JSONB key ordering is harmless; a wrong envelope
 * or an erased/replaced body fails closed. This never fetches missing material. */
export function resolveDmShadowWitness(witness: DmShadowWitness, pageId: number, observation: {
  id: number; accountId: number; platform: string; kind: string; payload: unknown;
}): {
  conversationRef: string; messageId: string;
} | null {
  try {
    if (!dmShadowWitnessSchema.safeParse(witness).success) return null;
    if (observation.id !== witness.observationId || observation.accountId !== pageId ||
      observation.platform !== "fansly" || observation.kind !== "dm_conversations") return null;
    const payload = observation.payload;
    if (dmShadowPayloadSha256(payload) !== witness.payloadSha256) return null;
    const parsed = z.object({ data: z.array(z.object({
      groupId: z.string(), lastMessageId: z.string().nullable(),
    })) }).safeParse(payload);
    const item = parsed.success ? parsed.data.data[witness.itemIndex] : undefined;
    return item?.lastMessageId ? { conversationRef: item.groupId, messageId: item.lastMessageId } : null;
  } catch { return null; }
}
