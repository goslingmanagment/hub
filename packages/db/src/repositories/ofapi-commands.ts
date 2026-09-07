import {
  and,
  asc,
  eq,
  gte,
  inArray,
  lte,
  lt,
  sql,
} from "drizzle-orm";

import type { Database } from "../client.ts";
import { ofapiCommands, type OfapiCommandKind, type OfapiCommandPayload } from "../schema.ts";

export type OfapiCommandRow = typeof ofapiCommands.$inferSelect;
export type OfapiCommandState = OfapiCommandRow["state"];

export interface CreateOfapiCommandInput {
  id: string;
  clientCommandId: string;
  pageId: number;
  chatterUserId: number;
  ofapiAccountId: string;
  conversationId: string;
  kind: OfapiCommandKind;
  payload: OfapiCommandPayload;
  payloadHash: string;
  retryOfCommandId?: string | null;
}

/**
 * Inserts one durable command. A concurrent/exact duplicate loses the unique
 * race and reads the existing row; the service compares canonical fields before
 * deciding whether it is a valid dedupe or a client-id conflict.
 */
export async function createOrGetOfapiCommand(
  db: Database,
  input: CreateOfapiCommandInput,
): Promise<{ row: OfapiCommandRow; inserted: boolean }> {
  const [created] = await db
    .insert(ofapiCommands)
    .values({
      id: input.id,
      clientCommandId: input.clientCommandId,
      pageId: input.pageId,
      chatterUserId: input.chatterUserId,
      ofapiAccountId: input.ofapiAccountId,
      bindingGeneration: sql`(select ofapi_binding_generation from pages where id = ${input.pageId})`,
      conversationId: input.conversationId,
      kind: input.kind,
      payload: input.payload,
      payloadHash: input.payloadHash,
      retryOfCommandId: input.retryOfCommandId ?? null,
      // Typing is an ephemeral, lossy hint. Keep just enough custody for an
      // ambiguous intake retry, then let the sweep delete the terminal row.
      // Business commands retain the long idempotency horizon unchanged.
      dedupeExpiresAt: input.kind === "typing_active_v1"
        ? sql`now() + interval '2 minutes'`
        : sql`now() + interval '400 days'`,
    })
    .onConflictDoNothing({
      target: [
        ofapiCommands.pageId,
        ofapiCommands.chatterUserId,
        ofapiCommands.clientCommandId,
      ],
    })
    .returning();

  if (created) {
    return { row: created, inserted: true };
  }

  const existing = await db.query.ofapiCommands.findFirst({
    where: and(
      eq(ofapiCommands.pageId, input.pageId),
      eq(ofapiCommands.chatterUserId, input.chatterUserId),
      eq(ofapiCommands.clientCommandId, input.clientCommandId),
    ),
  });
  if (!existing) {
    throw new Error("OFAPI command dedupe row vanished after unique conflict");
  }
  return { row: existing, inserted: false };
}

export async function getOfapiCommandByIdForUser(
  db: Database,
  input: { commandId: string; chatterUserId: number },
) {
  return await db.query.ofapiCommands.findFirst({
    where: and(
      eq(ofapiCommands.id, input.commandId),
      eq(ofapiCommands.chatterUserId, input.chatterUserId),
    ),
  }) ?? null;
}

export async function getOfapiCommandById(
  db: Database,
  input: { commandId: string },
) {
  return await db.query.ofapiCommands.findFirst({
    where: eq(ofapiCommands.id, input.commandId),
  }) ?? null;
}

export async function cancelQueuedOfapiCommand(
  db: Database,
  input: { commandId: string; chatterUserId: number; now: Date },
) {
  const [updated] = await db
    .update(ofapiCommands)
    .set({
      state: "cancelled",
      updatedAt: input.now,
    })
    .where(and(
      eq(ofapiCommands.id, input.commandId),
      eq(ofapiCommands.chatterUserId, input.chatterUserId),
      eq(ofapiCommands.state, "queued"),
    ))
    .returning();

  return updated ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if ("code" in error && error.code === "23505") {
    return true;
  }
  return "cause" in error && isUniqueViolation(error.cause);
}

/**
 * Claims one queued row for its only vendor attempt. The partial unique lane
 * index is the final concurrency authority; a competing lane claim returns null.
 * W3.2 (A4, decision #125): `minCreatedAt` is the claim-side TTL belt — a row
 * older than the queued TTL is unclaimable even if it races the sweep's
 * expiry, so a stale send can never fire.
 */
export async function claimQueuedOfapiCommand(
  db: Database,
  input: { commandId: string; now: Date; minCreatedAt?: Date },
) {
  try {
    const [claimed] = await db
      .update(ofapiCommands)
      .set({
        state: "in_flight",
        attemptCount: 1,
        attemptStartedAt: input.now,
        attemptFinishedAt: null,
        lastErrorCode: null,
        lastErrorClass: null,
        verifierResult: null,
        updatedAt: input.now,
      })
      .where(and(
        eq(ofapiCommands.id, input.commandId),
        eq(ofapiCommands.state, "queued"),
        eq(ofapiCommands.attemptCount, 0),
        ...(input.minCreatedAt ? [gte(ofapiCommands.createdAt, input.minCreatedAt)] : []),
      ))
      .returning();
    return claimed ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * W3.2 (A4, decision #125): expire queued-only rows older than the TTL to
 * `cancelled` — fail closed, reusing the state the desktop already renders
 * and RETRYABLE_SOURCE_STATES already includes (an expired send stays
 * chatter-retryable). Only attempt_count = 0 rows qualify: a row that ever
 * started an attempt belongs to the one-attempt law, never to a TTL. Returns
 * the full rows so the caller journals one observation per expiry.
 */
export async function expireStaleQueuedOfapiCommands(
  db: Database,
  input: { createdBefore: Date; now: Date; kind?: OfapiCommandKind },
) {
  return db
    .update(ofapiCommands)
    .set({
      state: "cancelled",
      lastErrorCode: "expired_queued_ttl",
      updatedAt: input.now,
    })
    .where(and(
      eq(ofapiCommands.state, "queued"),
      eq(ofapiCommands.attemptCount, 0),
      lt(ofapiCommands.createdAt, input.createdBefore),
      ...(input.kind === undefined ? [] : [eq(ofapiCommands.kind, input.kind)]),
    ))
    .returning();
}

/** Terminal typing rows are not business facts. Their short dedupe window is
 * enough to make a lost intake response idempotent; after it closes, retaining
 * one row per three-second UI beacon would be unbounded operational history. */
export async function purgeExpiredTypingCommands(
  db: Database,
  input: { now: Date },
) {
  return db.delete(ofapiCommands).where(and(
    eq(ofapiCommands.kind, "typing_active_v1"),
    inArray(ofapiCommands.state, [
      "confirmed",
      "failed_retryable",
      "failed_terminal",
      "indeterminate",
      "cancelled",
    ]),
    lt(ofapiCommands.dedupeExpiresAt, input.now),
  )).returning({ id: ofapiCommands.id });
}

export async function listQueuedOfapiCommandIds(
  db: Database,
  input: { limit: number },
) {
  return db
    .select({ id: ofapiCommands.id })
    .from(ofapiCommands)
    .where(and(
      eq(ofapiCommands.state, "queued"),
      eq(ofapiCommands.attemptCount, 0),
    ))
    .orderBy(asc(ofapiCommands.createdAt))
    .limit(input.limit);
}

export async function finalizeOfapiCommand(
  db: Database,
  input: {
    commandId: string;
    fromStates: Array<"in_flight" | "indeterminate">;
    state: "confirmed" | "failed_retryable" | "failed_terminal" | "indeterminate";
    now: Date;
    lastErrorCode?: string | null;
    lastErrorClass?: string | null;
    verifierResult?: Record<string, unknown> | null;
    platformMessageId?: string | null;
  },
) {
  const [updated] = await db
    .update(ofapiCommands)
    .set({
      state: input.state,
      attemptFinishedAt: input.now,
      lastErrorCode: input.lastErrorCode ?? null,
      lastErrorClass: input.lastErrorClass ?? null,
      verifierResult: input.verifierResult ?? null,
      platformMessageId: input.platformMessageId ?? null,
      updatedAt: input.now,
    })
    .where(and(
      eq(ofapiCommands.id, input.commandId),
      inArray(ofapiCommands.state, input.fromStates),
    ))
    .returning();

  return updated ?? null;
}

export async function markStaleInFlightOfapiCommandsIndeterminate(
  db: Database,
  input: { startedBefore: Date; now: Date },
) {
  return db
    .update(ofapiCommands)
    .set({
      state: "indeterminate",
      attemptFinishedAt: input.now,
      lastErrorCode: "worker_attempt_stale",
      lastErrorClass: "indeterminate",
      verifierResult: { source: "stale_recovery" },
      updatedAt: input.now,
    })
    .where(and(
      eq(ofapiCommands.state, "in_flight"),
      lt(ofapiCommands.attemptStartedAt, input.startedBefore),
    ))
    .returning({ id: ofapiCommands.id });
}
export async function listOfapiCommandVerificationCandidates(
  db: Database,
  input: {
    ofapiAccountId: string;
    conversationId: string;
    attemptStartedFrom: Date;
    attemptStartedTo: Date;
  },
) {
  return db
    .select()
    .from(ofapiCommands)
    .where(and(
      eq(ofapiCommands.ofapiAccountId, input.ofapiAccountId),
      eq(ofapiCommands.conversationId, input.conversationId),
      inArray(ofapiCommands.state, ["in_flight", "indeterminate"]),
      gte(ofapiCommands.attemptStartedAt, input.attemptStartedFrom),
      lte(ofapiCommands.attemptStartedAt, input.attemptStartedTo),
    ))
    .orderBy(asc(ofapiCommands.attemptStartedAt));
}
