import { and, eq, gte, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { agentReadAudit } from "../schema.ts";

/**
 * The append-only record of what the Agent Read Plane served.
 *
 * This is not decorative: the owner's acceptance of a machine principal reading
 * verbatim transcripts rests on every such read leaving a row. Which is exactly
 * why the row must never become a second copy of the material.
 *
 * **`requestSummary` carries NO free-form text.** The house sink allowlist
 * (`docs/error-handling.md`) admits bounded structured facts only, and a request
 * summary is a sink like any other: a search string enters as `{qSha256, qLength}`,
 * a hydration reason as `{reasonSha256, reasonLength}`. That is enough to prove two
 * requests were the same and to bound their size, and not enough to reconstruct
 * what a person typed. The allowlist below is enforced at WRITE time and throws
 * rather than silently dropping — a summary that quietly lost its field would make
 * the audit trail a lie.
 */

export type AgentReadAuditRow = typeof agentReadAudit.$inferSelect;

export type AgentReadAuditSummaryValue = string | number | boolean | null;

/**
 * Every key a request summary may carry. Widening it is a deliberate review step:
 * add the key here, and make sure the VALUE is a digest, a length, a count or a
 * closed identifier — never something a human wrote.
 */
export const AGENT_READ_AUDIT_SUMMARY_KEYS = [
  /** sha256 of the search string; proves repetition without storing the string. */
  "qSha256",
  "qLength",
  /** sha256 of a hydration request's free-text reason, plus its length. */
  "reasonSha256",
  "reasonLength",
  /** Bounded request/response shape facts. */
  "limit",
  "returned",
  "cappedBy",
  "cursorConsumed",
  "windowFrom",
  "windowTo",
  /** Closed identifiers from our own vocabularies. */
  "datasetRef",
  "observationKind",
  "platform",
  "planeMode",
] as const;

export type AgentReadAuditSummaryKey = (typeof AGENT_READ_AUDIT_SUMMARY_KEYS)[number];

export type AgentReadAuditSummary = Partial<
  Record<AgentReadAuditSummaryKey, AgentReadAuditSummaryValue>
>;

const SUMMARY_KEY_SET: ReadonlySet<string> = new Set(AGENT_READ_AUDIT_SUMMARY_KEYS);

/**
 * A closed identifier / digest / timestamp shape. Deliberately excludes
 * whitespace: free-form prose cannot pass this filter even if a caller sneaks it
 * into an allowlisted key.
 */
const SAFE_STRING = /^[A-Za-z0-9_:.+-]{1,64}$/;

export class AgentReadAuditSummaryError extends Error {}

/**
 * Validates a summary before it reaches the database. Throws (never trims, never
 * drops) so a caller that tried to log user text fails loudly in tests instead of
 * shipping a redaction hole.
 */
export function assertAgentReadAuditSummary(
  summary: Record<string, unknown>,
): asserts summary is AgentReadAuditSummary {
  for (const [key, value] of Object.entries(summary)) {
    if (!SUMMARY_KEY_SET.has(key)) {
      throw new AgentReadAuditSummaryError(
        `agent_read_audit.request_summary does not allow the key "${key}"`,
      );
    }
    if (value === null || typeof value === "boolean") {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new AgentReadAuditSummaryError(
          `agent_read_audit.request_summary."${key}" must be a finite number`,
        );
      }
      continue;
    }
    if (typeof value === "string") {
      if (!SAFE_STRING.test(value)) {
        throw new AgentReadAuditSummaryError(
          `agent_read_audit.request_summary."${key}" must be a bounded identifier or digest,`
            + " never free-form text",
        );
      }
      continue;
    }
    throw new AgentReadAuditSummaryError(
      `agent_read_audit.request_summary."${key}" must be a string, number, boolean or null`,
    );
  }
}

export interface InsertAgentReadAuditInput {
  /** Present for agent-key operations; null for owner-session ones. */
  agentKeyId?: number | null;
  /** Present for owner-session operations (#9b, #13); null for agent-key ones. */
  sessionUserId?: number | null;
  operation: string;
  pageIds: number[];
  /** True when the response carried verbatim fan/model text. */
  verbatimText: boolean;
  requestSummary?: Record<string, unknown>;
  occurredAt?: Date;
}

/** Appends one audit row. Never updates, never deletes — the table is a journal. */
export async function insertAgentReadAudit(
  db: Database,
  input: InsertAgentReadAuditInput,
): Promise<AgentReadAuditRow> {
  const summary = input.requestSummary ?? {};
  assertAgentReadAuditSummary(summary);

  const agentKeyId = input.agentKeyId ?? null;
  const sessionUserId = input.sessionUserId ?? null;
  if (agentKeyId === null && sessionUserId === null) {
    throw new AgentReadAuditSummaryError(
      "agent_read_audit needs a principal: an agent key or a session user",
    );
  }

  const [row] = await db
    .insert(agentReadAudit)
    .values({
      agentKeyId,
      sessionUserId,
      operation: input.operation,
      pageIds: input.pageIds,
      verbatimText: input.verbatimText,
      requestSummary: summary as Record<string, AgentReadAuditSummaryValue>,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    })
    .returning();

  if (!row) {
    throw new Error("insertAgentReadAudit returned no row");
  }
  return row;
}

/**
 * How many times this owner session has run this operation since `since`. The #9b
 * daily cap on observation payload reads is enforced through exactly this count,
 * and it is the reason the table carries the
 * (session_user_id, operation, occurred_at) index.
 */
export async function countAgentReadAuditForSession(
  db: Database,
  input: { sessionUserId: number; operation: string; since: Date },
): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(agentReadAudit)
    .where(
      and(
        eq(agentReadAudit.sessionUserId, input.sessionUserId),
        eq(agentReadAudit.operation, input.operation),
        gte(agentReadAudit.occurredAt, input.since),
      ),
    );
  return Number(row?.count ?? 0);
}
