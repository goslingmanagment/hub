import { createHash, randomBytes } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { insertAuditEvent, isUniqueViolation } from "./auth.ts";
import {
  CLIENT_PREVIEW_SEND_RATE_LIMIT,
  CLIENT_PREVIEW_SEND_RATE_WINDOW_MS,
  custodyViewState,
  decideClaimTransition,
  deriveClientClaimView,
  viewGroup,
  type ClientClaimGroup,
  type ClientClaimRejectionCode,
  type ClientClaimRequest,
  type ClientClaimWrite,
  type ClientCustodyRow,
  type ClientCustodyViewState,
  type ClientFanClaimSnapshot,
  type ClientFanClaimView,
  type ClientGreetingRow,
  type ClientLeaseRow,
  type DesktopFollowerOutreach,
} from "./client-claim-transition.ts";

// chat-extension greeting lease and send custody (hub-pr-plan H-7a): raw SQL
// over 0241, like follower-outreach.ts. Every action runs in one transaction
// under pg_advisory_xact_lock('client-fan:<page>:<fan>'); a dispatch first
// takes 'client-user-send:<user>' (always user, then fan) so its rate count
// cannot race the user's dispatch to another fan. The rules themselves are
// the pure decideClaimTransition (client-claim-transition.ts). H-7b serves the
// action, the status and the manual resolve (apps/runtime services/client-claim.ts
// maps the view to its wire shape); H-7c reads the list's claim column from the
// same tables.

/**
 * The predicate of `ofapi_commands_follower_outreach_uniq` (0195, schema.ts),
 * verbatim: a desktop new-follower command holds the fan unless it was
 * cancelled before any attempt or the executor proved a local refusal.
 * `tests/client-claim.integration.test.ts` checks it row for row against the
 * index's own predicate.
 */
export function ofapiFollowerOutreachHoldSql(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new TypeError(`invalid SQL alias: ${alias}`);
  const c = sql.raw(alias);
  return sql`(${c}.outreach_purpose = 'new-follower' and case
    when ${c}.state = 'cancelled' and ${c}.attempt_count = 0 then false
    when ${c}.state in ('failed_retryable', 'failed_terminal')
      and coalesce(${c}.verifier_result->>'source', '') in ('local_precondition', 'auth_gate') then false
    else true end)`;
}

/**
 * Desktop greetings of these fans (OnlyFans chat id = fan id): a holding
 * command that OnlyFans confirmed greeted the fan (`confirmed`); any other
 * holding command may have (`held`). The index allows one per fan.
 */
export async function readDesktopFollowerOutreach(
  db: Database,
  pageId: number,
  fanRefs: readonly string[],
): Promise<Map<string, DesktopFollowerOutreach>> {
  if (fanRefs.length === 0) return new Map();
  const result = await db.execute<{
    conversation_id: string; id: string; state: string; platform_message_id: string | null; at: Date;
  }>(sql`
    select distinct on (c.conversation_id) c.conversation_id, c.id, c.state, c.platform_message_id,
      coalesce(c.attempt_finished_at, c.updated_at) as at
    from ofapi_commands c
    where c.page_id = ${pageId} and c.conversation_id = any(${sql.param([...fanRefs])}::text[])
      and ${ofapiFollowerOutreachHoldSql("c")}
    order by c.conversation_id, (c.state = 'confirmed') desc, c.created_at`);
  return new Map(result.rows.map((row) => [row.conversation_id, {
    commandId: row.id,
    state: row.state === "confirmed" ? "confirmed" : "held",
    at: new Date(row.at),
    messageRef: row.platform_message_id,
  }]));
}

type WithoutHash<T> = T extends { requestHash: string } ? Omit<T, "requestHash"> : T;
/** One action of the claim route; the repository hashes the request itself. */
export type ClientClaimActionInput = Exclude<WithoutHash<ClientClaimRequest>, { action: "resolve" }>;

export type ClientClaimResult =
  | { ok: true; view: ClientFanClaimView }
  | { ok: false; code: ClientClaimRejectionCode; view: ClientFanClaimView };

export interface ApplyClientClaimOptions {
  /**
   * Runs inside the dispatch transaction, after the replay check and before
   * the rest (hub-pr-plan H-7b: the owner switch read FOR SHARE, so a switch
   * flip queues behind the send). Throw to refuse; the transaction rolls back.
   */
  beforeDispatch?: (tx: Database) => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OF_ID = /^[1-9][0-9]{0,29}$/;

function assertShape(condition: boolean, what: string): void {
  if (!condition) throw new TypeError(`client claim: invalid ${what}`);
}

function requestHash(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function hashed(input: ClientClaimActionInput): ClientClaimRequest {
  const base = [input.action, input.pageId, input.fanRef, input.userId];
  if (input.action === "dispatch") {
    const { group } = input;
    return {
      ...input,
      requestHash: requestHash([...base, input.instanceId, input.purpose, group.generationRef, group.variant,
        group.partCount, input.partIndex, input.textRevision, input.leaseToken, input.flagRevision]),
    };
  }
  if (input.action === "registerNativeSend") {
    const { group } = input;
    return {
      ...input,
      requestHash: requestHash([...base, input.instanceId, input.purpose, group.generationRef, group.variant,
        group.partCount, input.partIndex, input.platformMessageId]),
    };
  }
  return input;
}

function validate(request: ClientClaimRequest): void {
  assertShape(Number.isSafeInteger(request.pageId) && Number.isSafeInteger(request.userId), "page or user");
  assertShape(OF_ID.test(request.fanRef), "fanRef");
  if ("instanceId" in request) assertShape(UUID.test(request.instanceId), "instanceId");
  if ("leaseToken" in request && request.leaseToken !== null) assertShape(UUID.test(request.leaseToken), "leaseToken");
  if ("attemptId" in request) assertShape(UUID.test(request.attemptId), "attemptId");
  if ("platformMessageId" in request && request.platformMessageId !== null) {
    assertShape(OF_ID.test(request.platformMessageId), "platformMessageId");
  }
  if ("group" in request) {
    const { group } = request;
    assertShape(group.generationRef.length >= 1 && group.generationRef.length <= 100, "generationRef");
    assertShape(Number.isInteger(group.variant) && group.variant >= 0 && group.variant <= 2, "variant");
    assertShape(Number.isInteger(group.partCount) && group.partCount >= 1 && group.partCount <= 10, "partCount");
    assertShape(Number.isInteger(request.partIndex) && request.partIndex >= 0 && request.partIndex <= 9, "partIndex");
  }
  if (request.action === "dispatch") {
    assertShape(Number.isInteger(request.textRevision) && request.textRevision >= 0, "textRevision");
    assertShape(request.flagRevision === null || (Number.isInteger(request.flagRevision) && request.flagRevision >= 0), "flagRevision");
  }
  if (request.action === "resolve") assertShape(request.note.length >= 1 && request.note.length <= 500, "note");
}

const CUSTODY_COLUMNS = sql`attempt_id::text, page_id, fan_ref, user_id, instance_id::text, purpose, origin,
  generation_ref, variant, part_count, part_index, encode(request_hash, 'hex') as request_hash, state,
  ticket_expires_at, platform_message_id, failure_reason, failure_http_status`;

type CustodyDbRow = {
  attempt_id: string; page_id: bigint; fan_ref: string; user_id: bigint; instance_id: string;
  purpose: ClientCustodyRow["purpose"]; origin: ClientCustodyRow["origin"]; generation_ref: string;
  variant: number; part_count: number; part_index: number; request_hash: string; state: ClientCustodyRow["state"];
  ticket_expires_at: Date | null; platform_message_id: string | null;
  failure_reason: ClientCustodyRow["failureReason"]; failure_http_status: number | null;
};

const custodyRow = (row: CustodyDbRow): ClientCustodyRow => ({
  attemptId: row.attempt_id, pageId: Number(row.page_id), fanRef: row.fan_ref, userId: Number(row.user_id),
  instanceId: row.instance_id, purpose: row.purpose, origin: row.origin, generationRef: row.generation_ref,
  variant: Number(row.variant), partCount: Number(row.part_count), partIndex: Number(row.part_index),
  requestHash: row.request_hash, state: row.state,
  ticketExpiresAt: row.ticket_expires_at === null ? null : new Date(row.ticket_expires_at),
  platformMessageId: row.platform_message_id, failureReason: row.failure_reason,
  failureHttpStatus: row.failure_http_status === null ? null : Number(row.failure_http_status),
});

/**
 * The reader's own last send to this fan dispatched from the preview, in whatever state it ended
 * (the status read). The fan's sends are few, and client_send_custody_fan (0246) reads them newest
 * first: the cost is the sends to one fan, not every send of the reader.
 */
function lastOwnDispatchQuery(input: { pageId: number; fanRef: string; userId: number }): SQL {
  return sql`
    select ${CUSTODY_COLUMNS} from client_send_custody
    where page_id = ${input.pageId} and fan_ref = ${input.fanRef}
      and user_id = ${input.userId} and origin = 'preview-send'
    order by created_at desc limit 1`;
}

/** The plan of exactly that statement, for the test that holds it to the fan's index. */
export async function explainClientLastOwnDispatchQuery(
  db: Database,
  input: { pageId: number; fanRef: string; userId: number },
): Promise<string> {
  const result = await db.execute<{ "QUERY PLAN": string }>(sql`explain (format text) ${lastOwnDispatchQuery(input)}`);
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

interface SnapshotRefs {
  leaseToken: string | null;
  attemptId: string | null;
  platformMessageId: string | null;
  requestGroup: ClientClaimGroup | null;
  rateUserId: number | null;
  /** The status read: whose own last dispatched send to report while no send to the fan is open. */
  lastDispatchUserId: number | null;
}

async function loadSnapshot(db: Database, pageId: number, fanRef: string, refs: SnapshotRefs): Promise<ClientFanClaimSnapshot> {
  const now = new Date((await db.execute<{ now: Date }>(sql`select clock_timestamp() as now`)).rows[0]!.now);
  const leases = (await db.execute<{
    lease_id: string; page_id: bigint; fan_ref: string; user_id: bigint; instance_id: string;
    state: ClientLeaseRow["state"]; expires_at: Date;
  }>(sql`
    select lease_id::text, page_id, fan_ref, user_id, instance_id::text, state, expires_at
    from client_fan_leases
    where (page_id = ${pageId} and fan_ref = ${fanRef} and state = 'active') or lease_id = ${refs.leaseToken}::uuid`))
    .rows.map((row): ClientLeaseRow => ({
      leaseId: row.lease_id, pageId: Number(row.page_id), fanRef: row.fan_ref, userId: Number(row.user_id),
      instanceId: row.instance_id, state: row.state, expiresAt: new Date(row.expires_at),
    }));
  const greetingRow = (await db.execute<{
    owner_user_id: bigint | null; generation_ref: string | null; variant: number | null; part_count: number | null;
    confirmed_at: Date; first_message_ref: string | null; first_attempt_id: string | null;
    source: ClientGreetingRow["source"];
  }>(sql`
    select owner_user_id, generation_ref, variant, part_count, confirmed_at, first_message_ref,
      first_attempt_id::text, source
    from client_greetings where page_id = ${pageId} and fan_ref = ${fanRef}`)).rows[0];
  const greeting: ClientGreetingRow | null = greetingRow ? {
    ownerUserId: greetingRow.owner_user_id === null ? null : Number(greetingRow.owner_user_id),
    generationRef: greetingRow.generation_ref,
    variant: greetingRow.variant === null ? null : Number(greetingRow.variant),
    partCount: greetingRow.part_count === null ? null : Number(greetingRow.part_count),
    confirmedAt: new Date(greetingRow.confirmed_at), firstMessageRef: greetingRow.first_message_ref,
    firstAttemptId: greetingRow.first_attempt_id, source: greetingRow.source,
  } : null;
  const desktop = (await readDesktopFollowerOutreach(db, pageId, [fanRef])).get(fanRef) ?? null;
  const custody = (await db.execute<CustodyDbRow>(sql`
    select ${CUSTODY_COLUMNS} from client_send_custody
    where (page_id = ${pageId} and fan_ref = ${fanRef} and state = 'dispatching')
      or attempt_id = ${refs.attemptId}::uuid
      or (page_id = ${pageId} and platform_message_id = ${refs.platformMessageId})`)).rows.map(custodyRow);
  const openCustody = custody.find((row) => row.pageId === pageId && row.fanRef === fanRef && row.state === "dispatching") ?? null;
  const attempt = custody.find((row) => row.attemptId === refs.attemptId) ?? null;
  const messageOwner = refs.platformMessageId === null ? null
    : custody.find((row) => row.pageId === pageId && row.platformMessageId === refs.platformMessageId) ?? null;
  const fanAttempt = attempt && attempt.pageId === pageId && attempt.fanRef === fanRef ? attempt : null;
  const lastOwnDispatch = refs.lastDispatchUserId === null || openCustody !== null ? null
    : (await db.execute<CustodyDbRow>(lastOwnDispatchQuery({ pageId, fanRef, userId: refs.lastDispatchUserId })))
      .rows.map(custodyRow)[0] ?? null;
  const group = viewGroup({ requestGroup: refs.requestGroup, attempt: fanAttempt, greeting, openCustody, lastOwnDispatch });
  // With them, in whatever state, the row of the greeting's first confirmed part: a native send
  // that confirmed the greeting over a held preview send is recorded on that row's id alone.
  const groupParts = group === null ? [] : (await db.execute<CustodyDbRow>(sql`
    select ${CUSTODY_COLUMNS} from client_send_custody
    where page_id = ${pageId} and fan_ref = ${fanRef} and generation_ref = ${group.generationRef}
      and variant = ${group.variant}
      and (state in ('dispatching', 'sent', 'resolved_sent') or attempt_id = ${greeting?.firstAttemptId ?? null}::uuid)`))
    .rows.map(custodyRow);
  const recentPreviewSends = refs.rateUserId === null ? 0 : Number((await db.execute<{ n: number }>(sql`
    select count(*)::int as n from client_send_custody
    where user_id = ${refs.rateUserId} and origin = 'preview-send'
      and created_at > ${new Date(now.getTime() - CLIENT_PREVIEW_SEND_RATE_WINDOW_MS)}`)).rows[0]?.n ?? 0);
  return {
    pageId, fanRef, now,
    activeLease: leases.find((row) => row.pageId === pageId && row.fanRef === fanRef && row.state === "active") ?? null,
    requestedLease: leases.find((row) => row.leaseId === refs.leaseToken) ?? null,
    greeting, desktop, openCustody, attempt, messageOwner, group, groupParts, recentPreviewSends, lastOwnDispatch,
  };
}

function snapshotRefs(request: ClientClaimRequest): SnapshotRefs {
  return {
    leaseToken: "leaseToken" in request ? request.leaseToken : null,
    attemptId: "attemptId" in request ? request.attemptId : null,
    platformMessageId: "platformMessageId" in request ? request.platformMessageId : null,
    requestGroup: "group" in request ? request.group : null,
    rateUserId: request.action === "dispatch" ? request.userId : null,
    lastDispatchUserId: null,
  };
}

async function exactlyOne(db: Database, query: SQL, what: string): Promise<void> {
  const result = await db.execute(query);
  if (result.rowCount !== 1) throw new Error(`client claim: ${what} changed ${result.rowCount ?? 0} rows, expected 1`);
}

/** Applies the decided writes; returns the one-time ticket of a dispatch. */
async function applyWrites(
  db: Database,
  request: ClientClaimRequest,
  now: Date,
  writes: readonly ClientClaimWrite[],
): Promise<string | null> {
  const { pageId, fanRef, userId } = request;
  let ticket: string | null = null;
  for (const write of writes) {
    switch (write.op) {
      case "expireLease":
        await exactlyOne(db, sql`update client_fan_leases set state = 'expired', updated_at = ${now}
          where lease_id = ${write.leaseId}::uuid and state = 'active'`, "lease expiry");
        break;
      case "insertLease":
        await db.execute(sql`insert into client_fan_leases
          (lease_id, page_id, fan_ref, user_id, instance_id, state, expires_at, created_at, updated_at)
          values (${write.leaseId}::uuid, ${pageId}, ${fanRef}, ${userId}, ${write.instanceId}::uuid, 'active',
            ${write.expiresAt}, ${now}, ${now})`);
        break;
      case "renewLease":
        await exactlyOne(db, sql`update client_fan_leases
          set expires_at = ${write.expiresAt}, renew_count = renew_count + 1, updated_at = ${now}
          where lease_id = ${write.leaseId}::uuid and state = 'active'`, "lease renewal");
        break;
      case "releaseLease":
        await exactlyOne(db, sql`update client_fan_leases set state = 'released', updated_at = ${now}
          where lease_id = ${write.leaseId}::uuid and state = 'active'`, "lease release");
        break;
      case "insertDispatch": {
        // The ticket marks the page-world command; only its sha256 is kept.
        ticket = randomBytes(32).toString("base64url");
        const ticketHash = createHash("sha256").update(ticket).digest();
        await db.execute(sql`insert into client_send_custody
          (attempt_id, page_id, fan_ref, user_id, instance_id, purpose, origin, generation_ref, variant, part_count,
            part_index, text_revision, request_hash, lease_id, flag_revision, state, ticket_hash, ticket_expires_at,
            created_at, updated_at)
          values (${write.attemptId}::uuid, ${pageId}, ${fanRef}, ${userId}, ${write.instanceId}::uuid, ${write.purpose},
            'preview-send', ${write.group.generationRef}, ${write.group.variant}, ${write.group.partCount},
            ${write.partIndex}, ${write.textRevision}, decode(${write.requestHash}, 'hex'), ${write.leaseId}::uuid,
            ${write.flagRevision}, 'dispatching', ${ticketHash}, ${write.ticketExpiresAt}, ${now}, ${now})`);
        break;
      }
      case "markSent":
        await exactlyOne(db, sql`update client_send_custody
          set state = 'sent', platform_message_id = ${write.platformMessageId}, updated_at = ${now}
          where attempt_id = ${write.attemptId}::uuid and state = 'dispatching'`, "sent report");
        break;
      case "markFailed":
        await exactlyOne(db, sql`update client_send_custody
          set state = 'failed', failure_reason = ${write.reason}, failure_http_status = ${write.httpStatus}, updated_at = ${now}
          where attempt_id = ${write.attemptId}::uuid and state = 'dispatching'`, "failure report");
        break;
      case "insertNativeSend":
        await db.execute(sql`insert into client_send_custody
          (attempt_id, page_id, fan_ref, user_id, instance_id, purpose, origin, generation_ref, variant, part_count,
            part_index, request_hash, state, platform_message_id, created_at, updated_at)
          values (${write.attemptId}::uuid, ${pageId}, ${fanRef}, ${userId}, ${write.instanceId}::uuid, ${write.purpose},
            'native-register', ${write.group.generationRef}, ${write.group.variant}, ${write.group.partCount},
            ${write.partIndex}, decode(${write.requestHash}, 'hex'), 'sent', ${write.platformMessageId}, ${now}, ${now})`);
        break;
      case "resolve": {
        await exactlyOne(db, sql`update client_send_custody
          set state = ${write.outcome === "sent" ? "resolved_sent" : "resolved_not_sent"},
            platform_message_id = ${write.platformMessageId}, resolved_by_user_id = ${userId}, resolved_at = ${now},
            resolution_note = ${write.note}, updated_at = ${now}
          where attempt_id = ${write.attemptId}::uuid and state = 'dispatching'`, "resolve");
        // Scalars only: the attempt id leads to the row; no fan id in the trail.
        await insertAuditEvent(db, {
          actorUserId: userId, source: "api", eventType: "client.send_custody_resolved", platformAccountId: pageId,
          metadata: {
            attemptId: write.attemptId, outcome: write.outcome, priorState: write.priorState,
            platformMessageIdRecorded: write.platformMessageId !== null,
          },
        });
        break;
      }
      case "confirmGreeting":
        await exactlyOne(db, sql`insert into client_greetings
          (page_id, fan_ref, owner_user_id, generation_ref, variant, part_count, confirmed_at, first_message_ref,
            first_attempt_id, source)
          values (${pageId}, ${fanRef}, ${write.ownerUserId}, ${write.group.generationRef}, ${write.group.variant},
            ${write.group.partCount}, ${now}, ${write.messageRef}, ${write.attemptId}::uuid, ${write.source})`,
          "greeting confirmation");
        break;
    }
  }
  return ticket;
}

async function lockFan(db: Database, pageId: number, fanRef: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`client-fan:${pageId}:${fanRef}`}, 0))`);
}

/**
 * Keys unique beyond one fan: a lease token, an attempt id, a page's message
 * id. The fan lock does not order two fans' requests that reuse one, so both
 * can decide on a snapshot without the other's row, and the later insert
 * meets the earlier row only at its commit, as a unique violation. That
 * transaction rolled back whole (no ticket left it); deciding once more reads
 * the committed row and refuses as designed: claim_expired or claim_busy,
 * attempt_conflict. Every other unique key is per fan, so the lock orders it.
 */
const CROSS_FAN_UNIQUE_KEYS = ["client_fan_leases_pkey", "client_send_custody_pkey", "client_send_custody_message"];

async function runLocked(db: Database, request: ClientClaimRequest, options: ApplyClientClaimOptions): Promise<ClientClaimResult> {
  validate(request);
  try {
    return await runLockedOnce(db, request, options);
  } catch (error) {
    if (!CROSS_FAN_UNIQUE_KEYS.some((key) => isUniqueViolation(error, key))) throw error;
    return runLockedOnce(db, request, options);
  }
}

async function runLockedOnce(
  db: Database,
  request: ClientClaimRequest,
  options: ApplyClientClaimOptions,
): Promise<ClientClaimResult> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    if (request.action === "dispatch") {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`client-user-send:${request.userId}`}, 0))`);
    }
    await lockFan(tx, request.pageId, request.fanRef);
    const refs = snapshotRefs(request);
    let snapshot = await loadSnapshot(tx, request.pageId, request.fanRef, refs);
    if (request.action === "dispatch" && snapshot.attempt === null && options.beforeDispatch) {
      await options.beforeDispatch(tx);
    }
    const decision = decideClaimTransition(snapshot, request);
    const ticket = await applyWrites(tx, request, snapshot.now, decision.writes);
    if (decision.writes.length > 0) snapshot = await loadSnapshot(tx, request.pageId, request.fanRef, refs);
    const view = deriveClientClaimView(snapshot, {
      userId: request.userId,
      instanceId: "instanceId" in request ? request.instanceId : null,
      leaseToken: refs.leaseToken,
      attemptId: refs.attemptId,
    });
    if (ticket !== null && view.custody) view.custody.ticket = ticket;
    return decision.outcome === "applied" ? { ok: true, view } : { ok: false, code: decision.code, view };
  });
}

/** claim | renew | release | dispatch | sent | failed | registerNativeSend on one fan. */
export function applyClientClaimAction(
  db: Database,
  input: ClientClaimActionInput,
  options: ApplyClientClaimOptions = {},
): Promise<ClientClaimResult> {
  return runLocked(db, hashed(input), options);
}

/**
 * The manual resolve of a held send (owner or team lead; the route checks the
 * role and the page). Audited in the same transaction.
 */
export async function resolveClientSendCustody(db: Database, input: {
  pageId: number;
  attemptId: string;
  resolverUserId: number;
  outcome: "sent" | "not_sent";
  platformMessageId: string | null;
  note: string;
}): Promise<ClientClaimResult | { ok: false; code: "not_found"; view: null }> {
  assertShape(UUID.test(input.attemptId), "attemptId");
  const located = (await db.execute<{ fan_ref: string }>(sql`
    select fan_ref from client_send_custody where attempt_id = ${input.attemptId}::uuid and page_id = ${input.pageId}`)).rows[0];
  if (!located) return { ok: false, code: "not_found", view: null };
  return runLocked(db, {
    action: "resolve", pageId: input.pageId, fanRef: located.fan_ref, userId: input.resolverUserId,
    attemptId: input.attemptId, outcome: input.outcome, platformMessageId: input.platformMessageId, note: input.note,
  }, {});
}

/**
 * The claim GET: no lock, no writes; a dead lease reads as expired to its
 * holder and as none to others. One read-only snapshot for every table, so a
 * send confirmed between two reads cannot show the fan as free (greeting not
 * yet confirmed, custody already gone).
 *
 * `custody` is the fan's open send, anyone's; while there is none, the
 * reader's own last send to the fan dispatched from the preview, in the state
 * it ended. A read names no attempt, and this is the one way a client that
 * lost track of its send (a restart, a manual resolve) learns the outcome.
 */
export async function readClientFanClaimStatus(db: Database, input: {
  pageId: number;
  fanRef: string;
  userId: number;
  instanceId: string | null;
  leaseToken: string | null;
}): Promise<ClientFanClaimView> {
  assertShape(OF_ID.test(input.fanRef), "fanRef");
  if (input.instanceId !== null) assertShape(UUID.test(input.instanceId), "instanceId");
  if (input.leaseToken !== null) assertShape(UUID.test(input.leaseToken), "leaseToken");
  const snapshot = await db.transaction(
    (transaction) => loadSnapshot(transaction as unknown as Database, input.pageId, input.fanRef, {
      leaseToken: input.leaseToken, attemptId: null, platformMessageId: null, requestGroup: null, rateUserId: null,
      lastDispatchUserId: input.userId,
    }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  return deriveClientClaimView(snapshot, {
    userId: input.userId, instanceId: input.instanceId, leaseToken: input.leaseToken, attemptId: null,
  });
}

/** One send attempt as the cabinet reads it (the manual resolve, H-7b; the held list, H-7e). */
export interface ClientSendCustodyItem {
  attemptId: string;
  fanRef: string;
  userId: number;
  purpose: ClientCustodyRow["purpose"];
  state: ClientCustodyViewState;
  generationRef: string;
  partIndex: number;
  partCount: number;
  createdAt: Date;
  ticketExpiresAt: Date | null;
}

/** The attempt of this page, its state as a viewer reads it now; null when the page has no such attempt. */
export async function findClientSendCustodyItem(
  db: Database,
  input: { pageId: number; attemptId: string },
): Promise<ClientSendCustodyItem | null> {
  assertShape(UUID.test(input.attemptId), "attemptId");
  const row = (await db.execute<{
    attempt_id: string; fan_ref: string; user_id: bigint; purpose: ClientCustodyRow["purpose"];
    state: ClientCustodyRow["state"]; generation_ref: string; part_index: number; part_count: number;
    created_at: Date; ticket_expires_at: Date | null; now: Date;
  }>(sql`
    select attempt_id::text, fan_ref, user_id, purpose, state, generation_ref, part_index, part_count, created_at,
      ticket_expires_at, clock_timestamp() as now
    from client_send_custody where attempt_id = ${input.attemptId}::uuid and page_id = ${input.pageId}`)).rows[0];
  if (!row) return null;
  const ticketExpiresAt = row.ticket_expires_at === null ? null : new Date(row.ticket_expires_at);
  return {
    attemptId: row.attempt_id, fanRef: row.fan_ref, userId: Number(row.user_id), purpose: row.purpose,
    state: custodyViewState({ state: row.state, ticketExpiresAt }, new Date(row.now)),
    generationRef: row.generation_ref, partIndex: Number(row.part_index), partCount: Number(row.part_count),
    createdAt: new Date(row.created_at), ticketExpiresAt,
  };
}

/**
 * How long until the user's preview-send rate window frees a slot: the oldest
 * of the last CLIENT_PREVIEW_SEND_RATE_LIMIT sends leaves the window. 0 when a
 * slot is free already. Advice for a 429, read outside the dispatch's lock:
 * the dispatch itself counts again under the user's lock.
 */
export async function readClientPreviewSendRetryAfterMs(db: Database, userId: number): Promise<number> {
  const row = (await db.execute<{ wait_ms: number }>(sql`
    select greatest(0, ceil(extract(epoch from (
      created_at + make_interval(secs => ${CLIENT_PREVIEW_SEND_RATE_WINDOW_MS / 1000}) - clock_timestamp()
    )) * 1000))::int as wait_ms
    from client_send_custody
    where user_id = ${userId} and origin = 'preview-send'
    order by created_at desc
    offset ${CLIENT_PREVIEW_SEND_RATE_LIMIT - 1} limit 1`)).rows[0];
  return row ? Number(row.wait_ms) : 0;
}
