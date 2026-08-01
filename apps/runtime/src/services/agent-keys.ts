import {
  AgentKeyConstraintError,
  AgentKeyLifetimeError,
  findPageSummaryByLabel,
  getAgentKeyById,
  insertAgentKey,
  listAgentKeys,
  listPagesByIds,
  revokeAgentKey,
  type AgentKeyRow,
} from "@agency_hub_core/db";
import type { AgentKeyCreateBody, AgentKeyItem } from "@agency_hub_core/contracts";
import { randomToken, sha256Hex } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, recordAudit, withAuditTransaction } from "./auth.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

/**
 * Issuance, listing and revocation of Agent Read Plane keys — the owner-session
 * half of the plane.
 *
 * THREE PROPERTIES THIS FILE EXISTS TO HOLD:
 *
 * 1. **The raw token leaves exactly once.** It is minted here, hashed here, and
 *    returned to the one caller that asked for it. Nothing persists it, no route
 *    reads it back, and `agentKeyItemSchema` cannot express it.
 * 2. **Neither the capability matrix nor the lifetime ceiling is re-implemented.**
 *    The contract enum derives from `AGENT_CAPABILITIES`; the ceiling lives in
 *    `insertAgentKey` and in the table CHECK. This file only TRANSLATES the two
 *    typed errors those layers throw into clean 4xx responses, so there is still
 *    exactly one place where each rule is decided.
 * 3. **The grant is explicit page ids, resolved from labels at issuance.** A page
 *    created tomorrow is granted by nothing; a key is widened only by issuing a
 *    new one. Labels are resolved through the same `findPageSummaryByLabel` the
 *    rest of the admin surface uses, so an unknown or inactive label is a 404
 *    rather than a silently narrower key.
 */

/** How much of the token body is shown in listings (api-key precedent). */
const AGENT_KEY_DISPLAY_LENGTH = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

interface AgentKeyAudit {
  source: string;
  actorUserId?: number | null;
  actorAgentKeyId?: number | null;
}

/**
 * The wire shape of one key. `pageLabels` is resolved from the stored ids; the
 * digest has no representation here at all.
 */
function agentKeyItem(row: AgentKeyRow, labelById: ReadonlyMap<number, string>): AgentKeyItem {
  const now = Date.now();
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    // The column is `text[]`; the CHECK constraint is what keeps it inside the
    // closed matrix, so the cast states a fact the database already enforces.
    capabilities: row.capabilities as AgentKeyItem["capabilities"],
    // An id whose page row vanished would silently shrink the displayed grant, so
    // it falls back to a visible marker instead of disappearing.
    pageLabels: row.pageIds.map((pageId) => labelById.get(pageId) ?? `#${pageId}`),
    dailyRequestBudget: row.dailyRequestBudget,
    dailyRowBudget: row.dailyRowBudget,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    isActive: row.revokedAt === null && row.expiresAt.getTime() > now,
  };
}

async function resolvePageLabels(app: AppContext, rows: readonly AgentKeyRow[]) {
  const ids = [...new Set(rows.flatMap((row) => row.pageIds))];
  if (ids.length === 0) {
    return new Map<number, string>();
  }
  const pages = await listPagesByIds(app.db, ids);
  return new Map(pages.map((page) => [page.id, page.label]));
}

/**
 * Turns the repository's typed refusals into HTTP, and REPLACES everything else.
 *
 * The two typed errors carry a rule and no statement, so they pass through. An
 * untyped driver error does NOT: `DrizzleQueryError`'s message embeds the SQL
 * together with its bound parameters, and for this table those parameters include
 * the key digest. The global error boundary logs whatever it is handed, so an
 * unexpected failure here would put a credential digest in the logs, which
 * `docs/error-handling.md:339-344` forbids outright. The original is dropped
 * rather than chained: `cause` is serialized by the logger too.
 */
function rethrowAsHttp(error: unknown): never {
  if (error instanceof AgentKeyLifetimeError) {
    throw new BadRequestError(error.message);
  }
  if (error instanceof AgentKeyConstraintError) {
    if (error.constraint === "agent_keys_name_key") {
      throw new ConflictError(error.message);
    }
    throw new BadRequestError(error.message);
  }
  throw new Error(
    "agent key write failed; driver detail suppressed because it embeds the bound "
    + `parameters, including the key digest (${error instanceof Error ? error.name : typeof error})`,
  );
}

export async function issueAgentKey(
  app: AppContext,
  input: AgentKeyCreateBody,
  audit: AgentKeyAudit,
): Promise<{ token: string; key: AgentKeyItem }> {
  const labelById = new Map<number, string>();
  const pageIds: number[] = [];
  for (const label of input.pageLabels) {
    const page = await findPageSummaryByLabel(app.db, label);
    if (!page) {
      throw new NotFoundError(`Page "${label}" not found`);
    }
    if (!labelById.has(page.id)) {
      labelById.set(page.id, page.label);
      pageIds.push(page.id);
    }
  }

  const tokenBody = randomToken(24);
  const token = `${AGENT_KEY_TOKEN_PREFIX}${tokenBody}`;
  const keyPrefix = `${AGENT_KEY_TOKEN_PREFIX}${tokenBody.slice(0, AGENT_KEY_DISPLAY_LENGTH)}`;
  const createdAt = new Date();

  // THE ROW AND ITS AUDIT COMMIT TOGETHER (review round 2). An earlier revision
  // wrote the key first and audited after, reasoning that a failed audit should
  // not destroy a minted credential. That reasoning is backwards: the token
  // reaches the owner only through THIS response, so a failure after the insert
  // leaves a live key nobody holds, unauditable, and blocking its own name with a
  // unique-constraint 409 on the retry. An orphaned credential is worse than a
  // failed issuance, and only one of the two is recoverable.
  let row: AgentKeyRow;
  try {
    row = await withAuditTransaction(app, async (dbTx) => {
      const created = await insertAgentKey(dbTx, {
        name: input.name,
        keyPrefix,
        keyDigest: sha256Hex(token),
        capabilities: [...input.capabilities],
        pageIds,
        dailyRequestBudget: input.dailyRequestBudget,
        dailyRowBudget: input.dailyRowBudget,
        expiresAt: new Date(createdAt.getTime() + input.expiresInDays * DAY_MS),
        createdBy: audit.actorUserId ?? null,
        createdAt,
      });

      // The prefix, not the token: the audit trail is not a second copy of the
      // secret.
      await recordAudit({ db: dbTx }, {
        ...audit,
        eventType: "agent_key.issued",
        metadata: {
          agentKeyId: created.id,
          name: created.name,
          keyPrefix,
          capabilities: created.capabilities,
          pageLabels: input.pageLabels,
          dailyRequestBudget: created.dailyRequestBudget,
          dailyRowBudget: created.dailyRowBudget,
          expiresAt: created.expiresAt.toISOString(),
        },
      });

      return created;
    });
  } catch (error) {
    rethrowAsHttp(error);
  }

  return { token, key: agentKeyItem(row, labelById) };
}

export async function listAgentKeysDetailed(app: AppContext): Promise<AgentKeyItem[]> {
  const rows = await listAgentKeys(app.db);
  const labelById = await resolvePageLabels(app, rows);
  return rows.map((row) => agentKeyItem(row, labelById));
}

export async function revokeAgentKeyById(
  app: AppContext,
  input: { id: number },
  audit: AgentKeyAudit,
) {
  const existing = await getAgentKeyById(app.db, input.id);
  if (!existing) {
    throw new NotFoundError(`Agent key ${input.id} not found`);
  }

  // Idempotent: a second call finds no un-revoked row, reports `revoked: false`
  // and leaves the ORIGINAL timestamp alone. Only a real transition is audited.
  //
  // Transactional for a reason specific to that idempotency: the audit row is
  // written only on the TRANSITION, so a failure between the update and the audit
  // would be unrecoverable rather than merely annoying. The retry would find an
  // already-revoked row, take the no-transition branch, and skip the audit
  // forever, leaving a revocation that no record explains.
  return withAuditTransaction(app, async (dbTx) => {
    const revoked = await revokeAgentKey(dbTx, { id: input.id });
    if (!revoked) {
      return {
        id: existing.id,
        revoked: false,
        revokedAt: existing.revokedAt?.toISOString() ?? null,
      };
    }

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "agent_key.revoked",
      metadata: { agentKeyId: existing.id, name: existing.name, keyPrefix: existing.keyPrefix },
    });

    const after = await getAgentKeyById(dbTx, input.id);
    return {
      id: input.id,
      revoked: true,
      revokedAt: after?.revokedAt?.toISOString() ?? null,
    };
  });
}
