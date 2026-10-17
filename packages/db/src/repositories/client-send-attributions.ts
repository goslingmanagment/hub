import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Who sent each outgoing message (send-attribution-v1, 0286): raw SQL over
// client_send_attributions, like the other client_* repositories. The route
// (apps/runtime services/client-send-attributions.ts) decides who may report
// and for which page; this file only records, first report wins.

/** The clients that observe a send and report it; the table's CHECK lists the same. */
export const CLIENT_SEND_ATTRIBUTION_STORED_SOURCES = ["chatspace-extension"] as const;
export type ClientSendAttributionStoredSource = (typeof CLIENT_SEND_ATTRIBUTION_STORED_SOURCES)[number];

export interface ClientSendAttributionFactInput {
  platformMessageId: string;
  fanRef: string;
  /** A platform whose chats have ids of their own (Fansly's group); null where the chat is the fan. */
  conversationRef: string | null;
  observedAt: Date;
  priced: boolean;
  withMedia: boolean;
}

export interface ClientSendAttributionInput {
  platform: string;
  pageId: number;
  /** The hub's user of the token that reported, never a client's field. */
  userId: number;
  source: ClientSendAttributionStoredSource;
  clientVersion: string | null;
  facts: readonly ClientSendAttributionFactInput[];
}

/**
 * - `recorded`: this report wrote the row.
 * - `duplicate`: the row was there already, with this user and this fan: a repeat.
 * - `conflict`: the row was there already, with another user or another fan.
 *   The first report stands; nothing changed.
 */
export type ClientSendAttributionRecordOutcome = "recorded" | "duplicate" | "conflict";

export interface ClientSendAttributionRecordResult {
  platformMessageId: string;
  outcome: ClientSendAttributionRecordOutcome;
}

/**
 * Records one batch of facts of one page under one user, in one transaction,
 * and answers each fact in the order given. A message id named twice in the
 * batch is recorded once: its first fact is the report, the later ones read
 * as a repeat of it or a conflict with it.
 */
export async function recordClientSendAttributions(
  db: Database,
  input: ClientSendAttributionInput,
): Promise<ClientSendAttributionRecordResult[]> {
  if (input.facts.length === 0) return [];
  const first = new Map<string, ClientSendAttributionFactInput>();
  for (const fact of input.facts) {
    if (!first.has(fact.platformMessageId)) first.set(fact.platformMessageId, fact);
  }
  const unique = [...first.values()];

  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const inserted = await tx.execute<{ platform_message_id: string }>(sql`
      insert into client_send_attributions (
        platform, page_id, platform_message_id, fan_ref, conversation_ref, user_id, source,
        priced, with_media, observed_at, client_version
      )
      select ${input.platform}, ${input.pageId}, f.platform_message_id, f.fan_ref, f.conversation_ref,
        ${input.userId}, ${input.source}, f.priced, f.with_media, f.observed_at, ${input.clientVersion}
      from unnest(
        ${sql.param(unique.map((fact) => fact.platformMessageId))}::text[],
        ${sql.param(unique.map((fact) => fact.fanRef))}::text[],
        ${sql.param(unique.map((fact) => fact.conversationRef))}::text[],
        ${sql.param(unique.map((fact) => fact.priced))}::boolean[],
        ${sql.param(unique.map((fact) => fact.withMedia))}::boolean[],
        ${sql.param(unique.map((fact) => fact.observedAt.toISOString()))}::timestamptz[]
      ) with ordinality as f(platform_message_id, fan_ref, conversation_ref, priced, with_media, observed_at, ord)
      order by f.ord
      on conflict (platform, page_id, platform_message_id) do nothing
      returning platform_message_id`);
    const written = new Set(inserted.rows.map((row) => row.platform_message_id));

    const stored = await tx.execute<{ platform_message_id: string; user_id: string | number; fan_ref: string; conversation_ref: string | null }>(sql`
      select platform_message_id, user_id, fan_ref, conversation_ref
      from client_send_attributions
      where platform = ${input.platform} and page_id = ${input.pageId}
        and platform_message_id = any(${sql.param(unique.map((fact) => fact.platformMessageId))}::text[])`);
    const rows = new Map(stored.rows.map((row) => [row.platform_message_id, row]));

    const answered = new Set<string>();
    return input.facts.map((fact): ClientSendAttributionRecordResult => {
      const id = fact.platformMessageId;
      const firstTime = !answered.has(id);
      answered.add(id);
      if (firstTime && written.has(id)) return { platformMessageId: id, outcome: "recorded" };
      const row = rows.get(id);
      const same = row !== undefined
        && Number(row.user_id) === input.userId
        && row.fan_ref === fact.fanRef
        && row.conversation_ref === fact.conversationRef;
      return { platformMessageId: id, outcome: same ? "duplicate" : "conflict" };
    });
  });
}
