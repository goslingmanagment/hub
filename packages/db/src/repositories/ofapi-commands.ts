import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { ofapiCommands } from "../schema.ts";

export type OfapiCommandRow = typeof ofapiCommands.$inferSelect;
export type OfapiCommandState = OfapiCommandRow["state"];

export interface CreateOfapiCommandInput {
  id: string;
  clientCommandId: string;
  pageId: number;
  chatterUserId: number;
  ofapiAccountId: string;
  conversationId: string;
  kind: "send_text_message_v1";
  payload: { text: string };
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
      conversationId: input.conversationId,
      kind: input.kind,
      payload: input.payload,
      payloadHash: input.payloadHash,
      retryOfCommandId: input.retryOfCommandId ?? null,
      dedupeExpiresAt: sql`now() + interval '400 days'`,
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
