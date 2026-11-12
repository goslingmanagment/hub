import {
  AgentKeyConstraintError,
  AgentKeyLifetimeError,
  findAgentKeyIntrospection,
  findPageSummaryByLabel,
  findPersonRowByCode,
  getAgentKeyById,
  insertAgentKey,
  insertPersonAgentKey,
  listAgentKeyLastCalls,
  listAgentKeyPeople,
  listAgentKeys,
  listPagesByIds,
  revokeAgentKey,
  setAgentKeyCapabilities,
  setAgentKeyPages,
  type AgentKeyPersonRow,
  type AgentKeyRow,
} from "@agency_hub_core/db";
import {
  AGENT_CAPABILITIES,
  AGENT_KEY_INTROSPECT_CACHE_SECONDS,
  AGENT_KEY_INTROSPECT_STALE_SECONDS,
  isServiceKeyCapabilities,
  type AgentCapability,
  type AgentKeyCreateBody,
  type AgentKeyIntrospectResponse,
  type AgentKeyItem,
} from "@agency_hub_core/contracts";
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
 * 3. **The page grant is explicit page ids, resolved from labels at issuance.**
 *    A page created tomorrow is granted by nothing, and a key's pages are widened
 *    only by an explicit owner act (a new key, or `updateAgentKeyPages`). Labels
 *    are resolved through the same `findPageSummaryByLabel` the rest of the admin
 *    surface uses, so an unknown or inactive label is a 404 rather than a silently
 *    narrower key. CAPABILITIES change in place (owner, 2026-10-24):
 *    the whole new set replaces the old one, the change and its audit row (before
 *    and after) commit together, and the key sees it on its next request because
 *    the authenticator reads the row on every request and caches nothing. PAGES
 *    change in place the same way, from the CLI only (owner, 2026-11-12): named
 *    pages added or removed, never a key left with none.
 * 4. **A key belongs to an agent** (ecosystem plan §3.3): issuance names the
 *    agent person (kind agent, not gone) and links it in the same transaction
 *    as the key and its audit. Only a service's own key (sign-in and «who is
 *    this key» alone) may have none. A key issued before the registry is linked
 *    on the person's card, never re-issued.
 */

/** How much of the token body is shown in listings (api-key precedent). */
const AGENT_KEY_DISPLAY_LENGTH = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

interface AgentKeyAudit {
  source: string;
  actorUserId?: number | null;
  actorAgentKeyId?: number | null;
}

/** Deduplicated, in the matrix's own order, so "before" and "after" compare as
 *  sets and a listing reads the same whichever order the set was ticked in. */
export function canonicalCapabilities(capabilities: readonly string[]): AgentCapability[] {
  const wanted = new Set(capabilities);
  return AGENT_CAPABILITIES.filter((capability) => wanted.has(capability));
}

/**
 * The wire shape of one key. `pageLabels` is resolved from the stored ids; the
 * digest has no representation here at all.
 */
interface AgentKeyExtras {
  agent: AgentKeyPersonRow | null;
  lastCall: { at: Date; operation: string } | null;
}

function agentKeyItem(row: AgentKeyRow, labelById: ReadonlyMap<number, string>, extras: AgentKeyExtras): AgentKeyItem {
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
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    isActive: row.revokedAt === null && row.expiresAt.getTime() > now,
    agent: extras.agent === null ? null : { code: extras.agent.code, displayName: extras.agent.displayName, state: extras.agent.state },
    lastCall: extras.lastCall === null ? null : { at: extras.lastCall.at.toISOString(), operation: extras.lastCall.operation },
  };
}

async function keyExtras(app: AppContext, rows: readonly AgentKeyRow[]) {
  const [people, lastCalls] = await Promise.all([
    listAgentKeyPeople(app.db),
    listAgentKeyLastCalls(app.db, rows.map((row) => row.id)),
  ]);
  return (row: AgentKeyRow): AgentKeyExtras => ({ agent: people.get(row.id) ?? null, lastCall: lastCalls.get(row.id) ?? null });
}

/**
 * The agent a new key belongs to: a person of kind agent, not gone. None only
 * for a service's own key (`AGENT_KEY_SERVICE_CAPABILITIES` alone).
 */
async function agentForIssuance(app: AppContext, input: AgentKeyCreateBody) {
  if (input.agentCode === undefined) {
    if (isServiceKeyCapabilities(input.capabilities)) return null;
    throw new BadRequestError("Name the agent the key belongs to (`agentCode`): only a service's own key may have none");
  }
  const person = await findPersonRowByCode(app.db, input.agentCode);
  if (!person) throw new NotFoundError(`No person «${input.agentCode}»`);
  if (person.kind !== "agent") throw new BadRequestError(`«${input.agentCode}» is not an agent: a key belongs to an agent`);
  if (person.state === "left") throw new BadRequestError(`The agent «${input.agentCode}» is gone`);
  return person;
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

  const agent = await agentForIssuance(app, input);

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
        expiresAt: new Date(createdAt.getTime() + input.expiresInDays * DAY_MS),
        createdBy: audit.actorUserId ?? null,
        createdAt,
      });
      if (agent !== null) {
        await insertPersonAgentKey(dbTx, { personId: agent.id, agentKeyId: created.id, linkedByUserId: audit.actorUserId ?? null });
      }

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
          expiresAt: created.expiresAt.toISOString(),
          agentCode: agent?.code ?? null,
        },
      });

      return created;
    });
  } catch (error) {
    rethrowAsHttp(error);
  }

  const agentRow = agent === null ? null : { agentKeyId: row.id, personId: agent.id, code: agent.code, displayName: agent.displayName, state: agent.state };
  return { token, key: agentKeyItem(row, labelById, { agent: agentRow, lastCall: null }) };
}

export async function listAgentKeysDetailed(app: AppContext): Promise<AgentKeyItem[]> {
  const rows = await listAgentKeys(app.db);
  const [labelById, extras] = await Promise.all([resolvePageLabels(app, rows), keyExtras(app, rows)]);
  return rows.map((row) => agentKeyItem(row, labelById, extras(row)));
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

/**
 * Replaces a live key's capabilities with `input.capabilities` (the whole new
 * set). The dashboard sends the ticked set; the CLI computes it from --add and
 * --remove against the current row and calls this with the result.
 *
 * The row is locked for the transaction, so "before" in the audit row is the set
 * this change actually replaced. A revoked or expired key is a 409: changing a
 * dead key would only make its listing lie about what it could do. A set equal
 * to the current one writes nothing and audits nothing, like a second revoke.
 */
export async function updateAgentKeyCapabilities(
  app: AppContext,
  input: { id: number; capabilities: readonly AgentCapability[]; note?: string },
  audit: AgentKeyAudit,
): Promise<AgentKeyItem> {
  const after = canonicalCapabilities(input.capabilities);

  const row = await withAuditTransaction(app, async (dbTx) => {
    const existing = await getAgentKeyById(dbTx, input.id, { forUpdate: true });
    if (!existing) {
      throw new NotFoundError(`Agent key ${input.id} not found`);
    }
    if (existing.revokedAt !== null) {
      throw new ConflictError(`Agent key "${existing.name}" is revoked; issue a new key instead`);
    }
    const now = new Date();
    if (existing.expiresAt.getTime() <= now.getTime()) {
      throw new ConflictError(`Agent key "${existing.name}" has expired; issue a new key instead`);
    }

    const before = canonicalCapabilities(existing.capabilities);
    if (before.length === after.length && before.every((capability, index) => capability === after[index])) {
      return existing;
    }

    let updated: AgentKeyRow | null;
    try {
      updated = await setAgentKeyCapabilities(dbTx, { id: existing.id, capabilities: [...after], now });
    } catch (error) {
      rethrowAsHttp(error);
    }
    if (!updated) {
      // The lock makes this unreachable short of a clock edge at the expiry.
      throw new ConflictError(`Agent key "${existing.name}" is no longer active`);
    }

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "agent_key.capabilities_updated",
      metadata: {
        agentKeyId: existing.id,
        name: existing.name,
        before,
        after,
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    });
    return updated;
  });

  const [labelById, extras] = await Promise.all([resolvePageLabels(app, [row]), keyExtras(app, [row])]);
  return agentKeyItem(row, labelById, extras(row));
}

/**
 * «Кто этот ключ» for another service (`agentKeyIntrospect`): by the sha256 a
 * service computed of the key an agent showed it. Active only for a live key
 * (not revoked, not expired) of an agent person who is not gone; anything else
 * — unknown, revoked, expired, a key no agent holds — is the same bare
 * `active: false`, so the answer tells a digest's holder nothing it could not
 * already tell. Reads only: the presented key's `last_used_at` and expiry stay
 * as they are, since the agent did not call Hub.
 */
export async function introspectAgentKey(
  app: Pick<AppContext, "db">,
  keyDigest: string,
  now = new Date(),
): Promise<AgentKeyIntrospectResponse & { subjectKeyId: number | null }> {
  const cache = { cacheSeconds: AGENT_KEY_INTROSPECT_CACHE_SECONDS, staleSeconds: AGENT_KEY_INTROSPECT_STALE_SECONDS } as const;
  const row = await findAgentKeyIntrospection(app.db, keyDigest);
  if (
    row === null || row.revokedAt !== null || row.expiresAt.getTime() <= now.getTime()
    || row.person === null || row.person.kind !== "agent" || row.person.state === "left"
  ) {
    return { active: false, ...cache, subjectKeyId: row?.agentKeyId ?? null };
  }
  return {
    active: true,
    agent: { code: row.person.code, displayName: row.person.displayName },
    expiresAt: row.expiresAt.toISOString(),
    ...cache,
    subjectKeyId: row.agentKeyId,
  };
}

/**
 * Adds and removes pages of a live key, by label. The same rules as
 * `updateAgentKeyCapabilities`: the row is locked, so "before" in the audit row
 * is the grant this change replaced; a revoked or expired key is a 409; a change
 * that leaves the grant as it was writes nothing and audits nothing.
 *
 * An added label resolves the way issuance resolves it (`findPageSummaryByLabel`:
 * an unknown or inactive page is a 404). A removed label must be one of the key's
 * current pages, so a typo is refused rather than silently removing nothing. A
 * key is never left with no page: that is a key that reads nothing, and closing a
 * key is `revokeAgentKeyById`'s job.
 */
export async function updateAgentKeyPages(
  app: AppContext,
  input: { id: number; add: readonly string[]; remove: readonly string[]; note?: string },
  audit: AgentKeyAudit,
): Promise<AgentKeyItem> {
  const both = input.add.filter((label) => input.remove.includes(label));
  if (both.length > 0) {
    throw new BadRequestError(`Both added and removed: ${both.join(", ")}`);
  }
  const added: { id: number; label: string }[] = [];
  for (const label of input.add) {
    const page = await findPageSummaryByLabel(app.db, label);
    if (!page) {
      throw new NotFoundError(`Page "${label}" not found`);
    }
    added.push({ id: page.id, label: page.label });
  }

  const row = await withAuditTransaction(app, async (dbTx) => {
    const existing = await getAgentKeyById(dbTx, input.id, { forUpdate: true });
    if (!existing) {
      throw new NotFoundError(`Agent key ${input.id} not found`);
    }
    if (existing.revokedAt !== null) {
      throw new ConflictError(`Agent key "${existing.name}" is revoked; issue a new key instead`);
    }
    const now = new Date();
    if (existing.expiresAt.getTime() <= now.getTime()) {
      throw new ConflictError(`Agent key "${existing.name}" has expired; issue a new key instead`);
    }

    const current = existing.pageIds.length === 0 ? [] : await listPagesByIds(dbTx, existing.pageIds);
    const labelById = new Map(current.map((page) => [page.id, page.label]));
    const label = (pageId: number) => labelById.get(pageId) ?? `#${pageId}`;
    const removedIds = new Set<number>();
    for (const wanted of input.remove) {
      const pageId = existing.pageIds.find((id) => label(id) === wanted);
      if (pageId === undefined) {
        throw new BadRequestError(`Agent key "${existing.name}" has no page "${wanted}"`);
      }
      removedIds.add(pageId);
    }

    const afterIds = existing.pageIds.filter((pageId) => !removedIds.has(pageId));
    for (const page of added) {
      labelById.set(page.id, page.label);
      if (!afterIds.includes(page.id)) afterIds.push(page.id);
    }
    if (afterIds.length === 0) {
      throw new BadRequestError(
        `Agent key "${existing.name}" would be left with no page; revoke it instead`,
      );
    }

    const before = existing.pageIds.map(label);
    const after = afterIds.map(label);
    if (before.length === after.length && before.every((pageLabel, index) => pageLabel === after[index])) {
      return existing;
    }

    let updated: AgentKeyRow | null;
    try {
      updated = await setAgentKeyPages(dbTx, { id: existing.id, pageIds: afterIds, now });
    } catch (error) {
      rethrowAsHttp(error);
    }
    if (!updated) {
      throw new ConflictError(`Agent key "${existing.name}" is no longer active`);
    }

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "agent_key.pages_updated",
      metadata: {
        agentKeyId: existing.id,
        name: existing.name,
        before,
        after,
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    });
    return updated;
  });

  const [labelById, extras] = await Promise.all([resolvePageLabels(app, [row]), keyExtras(app, [row])]);
  return agentKeyItem(row, labelById, extras(row));
}
