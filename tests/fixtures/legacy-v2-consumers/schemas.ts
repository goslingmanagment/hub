// FROZEN — do not edit to match newer contracts. The decoders the CURRENT
// production consumers of the v2 lane run, copied so Core changes are proven
// against them rather than against the live schemas they are replacing:
//
// * ChatGoose Desktop 0.1.56 parses stream frames, 409 bodies and the v2
//   snapshot with its OWN schemas — of-desktop tag v0.1.56,
//   packages/shared/src/protocol/index.ts (only quotes and names changed).
// * Its vendored @kernel/sdk (core 579b0e34), fansly-ext 2.4.6's (core
//   82571f3c) and Core 4c237123 (pre-H3) share the contract schemas below —
//   byte-identical at all three commits (packages/contracts/src/routes.ts).
//
// All are non-strict zod objects: unknown keys are stripped, not rejected.
// A consumer generation that needs a new copy gets a new file, not an edit.

import { z } from "zod";

// --- ChatGoose Desktop 0.1.56 (packages/shared/src/protocol/index.ts) ---

export const desktop0156DomainEventFrameSchema = z.object({
  accountId: z.number().int(),
  accountSeq: z.number().int(),
  type: z.string().min(1),
  occurredAt: z.string(),
  data: z.unknown(),
  fanRef: z.string().nullable().optional(),
  conversationRef: z.string().nullable().optional(),
  messageRef: z.string().nullable().optional(),
  accountRef: z.string().nullable().optional(),
  payload: z.unknown().optional(),
});

export const desktop0156DomainSnapshotRequiredSchema = z.object({
  error: z.literal("sync_snapshot_required"),
  statusCode: z.literal(409),
  version: z.literal(2),
  accounts: z.array(z.object({
    accountId: z.number().int(),
    requestedSeq: z.number().int().nonnegative(),
    oldestAvailableSeq: z.number().int().nullable(),
    currentSeq: z.number().int().nonnegative(),
  })),
  snapshotPath: z.string(),
});

export const desktop0156DomainSnapshotResponseSchema = z.object({
  cursor: z.string().min(1),
  accounts: z.array(z.object({
    accountId: z.number().int(),
    accountRef: z.string().min(1).nullable(),
    currentSeq: z.number().int().nonnegative(),
  })),
});

// --- @kernel/sdk contract schemas, core 579b0e34 = 82571f3c = 4c237123 ---

export const sdkPreH3DomainEventFrameSchema = z.object({
  accountId: z.number().int().positive(),
  accountSeq: z.number().int().positive(),
  type: z.string().min(1),
  occurredAt: z.string(),
  data: z.unknown(),
  fanRef: z.string().nullable().optional(),
  conversationRef: z.string().nullable().optional(),
  messageRef: z.string().nullable().optional(),
  accountRef: z.string().nullable().optional(),
  payload: z.unknown().optional(),
});

export const sdkPreH3DomainEventsSnapshotRequiredResponseSchema = z.object({
  error: z.literal("sync_snapshot_required"),
  message: z.string(),
  statusCode: z.literal(409),
  version: z.literal(2),
  accounts: z.array(z.object({
    accountId: z.number().int().positive(),
    requestedSeq: z.number().int().nonnegative(),
    oldestAvailableSeq: z.number().int().positive().nullable(),
    currentSeq: z.number().int().nonnegative(),
  })),
  snapshotPath: z.literal("/api/v1/events/v2/snapshot"),
});

export const sdkPreH3DomainEventsSnapshotResponseSchema = z.object({
  cursor: z.string(),
  accounts: z.array(z.object({
    accountId: z.number().int().positive(),
    accountRef: z.string().min(1).nullable(),
    currentSeq: z.number().int().nonnegative(),
  })),
});

/** The pre-H3 frame keys: what a 0.1.56 client keeps after parsing. */
export const PRE_H3_FRAME_KEYS = [
  "accountId",
  "accountSeq",
  "type",
  "occurredAt",
  "data",
  "fanRef",
  "conversationRef",
  "messageRef",
  "accountRef",
  "payload",
] as const;
