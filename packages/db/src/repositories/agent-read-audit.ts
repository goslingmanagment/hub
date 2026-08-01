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

/** The semantic shapes a summary value may take. */
export type AgentReadAuditSummaryShape = "sha256" | "count" | "identifier" | "flag" | "instant";

/**
 * Every key a request summary may carry, WITH the shape its value must take.
 *
 * A key allowlist alone is not enough: `{qSha256: "did rick pay for the custom"}`
 * satisfies any name check while smuggling the very text the digest exists to
 * avoid, and `{qLength: "secret"}` does the same through a numeric-sounding name.
 * So each key declares its shape and the value is validated against THAT — a
 * digest is 64 lowercase hex characters, a count is a non-negative integer.
 *
 * Widening this map is a deliberate review step: the value must be a digest, a
 * count, an instant, a flag or a closed identifier — never something a human
 * wrote.
 */
export const AGENT_READ_AUDIT_SUMMARY_SHAPES = {
  /** sha256 of the search string; proves repetition without storing the string. */
  qSha256: "sha256",
  qLength: "count",
  /** sha256 of a hydration request's free-text reason, plus its length. */
  reasonSha256: "sha256",
  reasonLength: "count",
  /** Bounded request/response shape facts. */
  limit: "count",
  returned: "count",
  cappedBy: "identifier",
  cursorConsumed: "flag",
  windowFrom: "instant",
  windowTo: "instant",
  /** Closed identifiers from our own vocabularies. */
  datasetRef: "identifier",
  observationKind: "identifier",
  platform: "identifier",
  planeMode: "identifier",
  /** Decision #201: an auto-approved hydration names its author, the policy
   *  version that authorized it, the calls it RESERVED and the UTC budget day
   *  it drew them from — the four facts needed to audit a delegated spend. */
  decisionSource: "identifier",
  policyVersion: "count",
  maxCalls: "count",
  budgetDate: "instant",
} as const satisfies Record<string, AgentReadAuditSummaryShape>;

export type AgentReadAuditSummaryKey = keyof typeof AGENT_READ_AUDIT_SUMMARY_SHAPES;

/** Derived. Anything that needs "which keys are allowed" reads THIS. */
export const AGENT_READ_AUDIT_SUMMARY_KEYS = Object.keys(
  AGENT_READ_AUDIT_SUMMARY_SHAPES,
) as readonly AgentReadAuditSummaryKey[];

export type AgentReadAuditSummary = Partial<
  Record<AgentReadAuditSummaryKey, AgentReadAuditSummaryValue>
>;

const SHAPE_BY_KEY: ReadonlyMap<string, AgentReadAuditSummaryShape> = new Map(
  Object.entries(AGENT_READ_AUDIT_SUMMARY_SHAPES as Record<string, AgentReadAuditSummaryShape>),
);

/** Lowercase hex sha256 and nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/**
 * A closed identifier: no whitespace, bounded length. Free-form prose cannot pass
 * this even when aimed at an identifier-shaped key.
 */
const IDENTIFIER = /^[A-Za-z0-9_:.-]{1,64}$/;
/** ISO-8601 instant, as produced by `Date#toISOString`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

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
    const shape = SHAPE_BY_KEY.get(key);
    if (shape === undefined) {
      throw new AgentReadAuditSummaryError(
        `agent_read_audit.request_summary does not allow the key "${key}"`,
      );
    }
    // `null` means "not applicable to this request" for every shape.
    if (value === null) {
      continue;
    }
    assertSummaryValueShape(key, shape, value);
  }
}

function assertSummaryValueShape(key: string, shape: AgentReadAuditSummaryShape, value: unknown) {
  const reject = (expected: string): never => {
    throw new AgentReadAuditSummaryError(
      `agent_read_audit.request_summary."${key}" must be ${expected}; free-form text never`
        + " crosses this boundary",
    );
  };

  switch (shape) {
    case "sha256":
      if (typeof value !== "string" || !SHA256_HEX.test(value)) {
        return reject("a lowercase hex sha256 digest (64 characters)");
      }
      return;
    case "count":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        return reject("a non-negative integer");
      }
      return;
    case "flag":
      if (typeof value !== "boolean") {
        return reject("a boolean");
      }
      return;
    case "instant":
      if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
        return reject("an ISO-8601 instant");
      }
      return;
    case "identifier":
      if (typeof value !== "string" || !IDENTIFIER.test(value)) {
        return reject("a bounded identifier (no whitespace, at most 64 characters)");
      }
      return;
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

  // EXACTLY ONE principal (the table CHECK says the same). Both set would claim a
  // machine and a human authored one read: it inflates the #9b per-session count
  // and attributes an agent's read to a person.
  const agentKeyId = input.agentKeyId ?? null;
  const sessionUserId = input.sessionUserId ?? null;
  if (agentKeyId === null && sessionUserId === null) {
    throw new AgentReadAuditSummaryError(
      "agent_read_audit needs a principal: an agent key or a session user",
    );
  }
  if (agentKeyId !== null && sessionUserId !== null) {
    throw new AgentReadAuditSummaryError(
      "agent_read_audit takes exactly one principal: an agent key or a session user, never both",
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
