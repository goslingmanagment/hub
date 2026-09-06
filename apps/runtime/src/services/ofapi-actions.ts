import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { decryptJsonWithKeyVersion, encryptJson, OFAPI_MIRROR_BUDGET_DEFAULTS } from "@agency_hub_core/shared";
import { checkOfapiCurrentBinding, findPageById, insertAuditEvent, insertObservation, reserveOfapiDayCredits, settleOfapiDayCreditReservation, isDmArchiveScopeFenced, tryAcquireDmArchiveWriterFenceLock, type Database } from "@agency_hub_core/db";
import { ofapiActionSchema, ofapiActionIntentSchema, type OfapiAction } from "@agency_hub_core/contracts";
import type { AppContext } from "../bootstrap.ts";
import { ConflictError, NotFoundError, ServiceUnavailableError } from "./errors.ts";
import { assertOfapiConfiguredAccess } from "./ofapi-vendor-usage.ts";
import { createOfapiCreditSpendSink, isOfapiCreditLedgerEnabled } from "./ofapi-credits.ts";
import { parseResponseMeta, OfapiGovernedRequestError } from "./ofapi.ts";
import { ofapiActionRequest } from "./ofapi-actions-registry.ts";
import { ofapiCollectionResultConfirmed } from "./ofapi-actions-collections.ts";
import type { OfapiActionRequest } from "./ofapi-actions-types.ts";
import { loadObservationPayload } from "./payload-reader.ts";
import { asRecord } from "./ofapi-payloads.ts";
import { ofapiActionResponseSubjectRefs } from "./ofapi-action-subjects.ts";

export const OFAPI_ACTION_RESPONSE_KIND = "ofapi.action_response.v1";
type Frozen = { command: OfapiAction; accountId: string; generation: number; credential: string; pageLabel: string };
type Captured = { frozen: Frozen; bodyBase64: string; headers: Record<string, string>; actorUserId: number };
type Row = { id: string; page_id: string; actor_user_id: string; action: string; body_hash: string; body_encrypted: string;
  state: string; estimated_credits: number; actual_credits: number | null; reserved_day: string | Date | null; reservation_settled: boolean; ledger_enabled: boolean; subject_refs: string[];
  response_observation_id: string | null; result_encrypted: string | null; remote_id: string | null; error_code: string | null;
  accounting_state: string; created_at: Date };
const fingerprint = (app: AppContext) => createHash("sha256").update(app.config.ofapiApiKey ?? "").digest("hex");
const operation = (action: string) => `ofapi_command_action_${action}`;
/** Owner actions are infrequent and serialize their physical dispatch. Try-locks
 * release pool slots immediately instead of accumulating blocked transactions. */
async function withActionLock<T>(db: Database, run: (tx: Database) => Promise<T>, pageId?: number) {
  return db.transaction(async tx => {
    const database = tx as unknown as Database;
    const global = (await database.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(9003011, 1) as acquired`)).rows[0];
    if (!global?.acquired) throw new ConflictError("Another owner action is being processed; refresh its status before continuing");
    if (pageId !== undefined) {
      const binding = (await database.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(9003010, ${pageId}::integer) as acquired`)).rows[0];
      if (!binding?.acquired) throw new ConflictError("This account is currently executing a command or changing its binding");
    }
    return run(database);
  });
}
function actionObservationKey(id: string) { return `ofapi-action:${id}`; }
export function actionSubjectRefs(command: OfapiAction): string[] {
  const value = command as unknown as Record<string, unknown>;
  const refs = [value.userId, value.fanId, ...(Array.isArray(value.userIds) ? value.userIds : []),
    ...(command.action === "user_list_add_users" && Array.isArray(value.ids) ? value.ids : [])];
  return [...new Set(refs.filter((ref): ref is string => typeof ref === "string" && /^[1-9]\d*$/.test(ref)))].sort();
}
async function erasureGuard(db: Database, command: OfapiAction, at: Date, refs = actionSubjectRefs(command)) {
  if (!await tryAcquireDmArchiveWriterFenceLock(db, command.pageId)) throw new ConflictError("An erasure is currently active for this page");
  if (await isDmArchiveScopeFenced(db, { pageId: command.pageId, refs, materialAt: at })) throw new ConflictError("This action predates an erasure");
}
function safeId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : null;
}
const encrypted = (app: AppContext, value: unknown) => JSON.stringify(encryptJson(value, app.config.encryptionKey, app.config.encryptionKeyVersion));
function decrypt<T>(app: AppContext, value: string): T { return decryptJsonWithKeyVersion<T>(JSON.parse(value), app.config.encryptionKeysByVersion); }
async function rowById(app: AppContext, id: string) {
  const row = (await app.db.execute<Row>(sql`select * from ofapi_action_intents where id=${id}`)).rows[0];
  if (!row) throw new NotFoundError("OFAPI action was not found");
  return row;
}
function dto(app: AppContext, row: Row) {
  const frozen = decrypt<Frozen>(app, row.body_encrypted);
  const result = row.result_encrypted ? decrypt<{ data: unknown; meta: unknown }>(app, row.result_encrypted) : null;
  return ofapiActionIntentSchema.parse({ id: row.id, pageId: Number(row.page_id), pageLabel: frozen.pageLabel,
    accountId: frozen.accountId, command: frozen.command, action: row.action, state: row.state,
    estimatedCredits: row.estimated_credits, actualCredits: row.actual_credits, remoteId: row.remote_id,
    responseData: result?.data ?? null, responseMeta: result?.meta ?? null, errorCode: row.error_code,
    responseObservationId: row.response_observation_id ? Number(row.response_observation_id) : null,
    accountingState: row.accounting_state, createdAt: new Date(row.created_at).toISOString() });
}
async function authority(app: AppContext, command: OfapiAction, frozen?: Frozen, db = app.db) {
  const page = await findPageById(db, command.pageId);
  const accountId = page?.page.ofapiAccountId;
  if (!page || !accountId) throw new ConflictError("This page needs an OFAPI account binding");
  if (frozen && (frozen.accountId !== accountId || frozen.credential !== fingerprint(app))) throw new ConflictError("Account binding or credential changed since preparation");
  const generation = await checkOfapiCurrentBinding(db, command.pageId, accountId, frozen?.generation);
  const request = ofapiActionRequest(command, accountId);
  await assertOfapiConfiguredAccess(app.db, fingerprint(app), { operation: operation(command.action), method: request.method, accountId });
  return { page, accountId, generation, request };
}

export async function prepareOfapiAction(app: AppContext, input: { id: string; command: OfapiAction }, actorUserId: number) {
  const command = ofapiActionSchema.parse(input.command);
  const hash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  // Existing identity is resolved before changing authority/time validation.
  const previous = (await app.db.execute<Row>(sql`select * from ofapi_action_intents where id=${input.id}`)).rows[0];
  if (previous) {
    if (previous.body_hash !== hash || Number(previous.actor_user_id) !== actorUserId) throw new ConflictError("Action ID already belongs to another request");
    return dto(app, previous);
  }
  const { page, accountId, generation, request } = await authority(app, command);
  const frozen: Frozen = { command, accountId, generation, credential: fingerprint(app), pageLabel: page.page.label };
  await app.db.transaction(async tx => {
    await erasureGuard(tx as unknown as Database, command, new Date());
    const identity = await tx.execute(sql`insert into ofapi_action_identities(id) values(${input.id}) on conflict do nothing returning id`);
    if (!identity.rows.length) {
      const existing = (await tx.execute<Row>(sql`select * from ofapi_action_intents where id=${input.id}`)).rows[0];
      if (!existing) throw new ConflictError("This action identity has already been used and its retained details are no longer available");
      if (existing.body_hash !== hash || Number(existing.actor_user_id) !== actorUserId) throw new ConflictError("Action ID already belongs to another request");
      return;
    }
    await tx.execute(sql`insert into ofapi_action_intents(id,page_id,actor_user_id,action,body_hash,body_encrypted,subject_refs,state,estimated_credits)
      values(${input.id},${command.pageId},${actorUserId},${command.action},${hash},${encrypted(app, frozen)},ARRAY[${sql.join(actionSubjectRefs(command).map(ref => sql`${ref}`), sql`, `)}]::text[],'prepared',${request.estimatedCredits}) on conflict do nothing`);
    const stored = (await tx.execute<Row>(sql`select * from ofapi_action_intents where id=${input.id}`)).rows[0]!;
    if (stored.body_hash !== hash || Number(stored.actor_user_id) !== actorUserId) throw new ConflictError("Action ID already belongs to another request");
    await insertAuditEvent(tx, { actorUserId, source: "api", eventType: "admin.ofapi_action_prepared", metadata: { id: input.id, pageId: command.pageId, action: command.action } });
  });
  return dto(app, await rowById(app, input.id));
}

/** HTTP acceptance is distinct from campaign delivery, funds transfer or a full inventory. */
export function classifyOfapiActionResult(command: OfapiAction, request: OfapiActionRequest, status: number, body: unknown) {
  const result = (state: "confirmed" | "partial" | "rejected" | "indeterminate", remoteId: string | null = null, errorCode: string | null = null) => ({ state, remoteId, errorCode });
  if (status >= 500) return result("indeterminate", null, `vendor_http_${status}`);
  if (status < 200 || status >= 300) return result("rejected", null, `vendor_http_${status}`);
  const root = asRecord(body);
  if (!root || !("data" in root)) return result("indeterminate", null, "vendor_result_unconfirmed");
  const data = asRecord(root.data);
  if (root.error || data?.error || data?.success === false) return result("rejected", null, "vendor_action_rejected");
  if (!ofapiCollectionResultConfirmed(command, root.data)) return result("indeterminate", null, request.resultKind === "partial" ? "vendor_partial_result_unconfirmed" : "vendor_result_unconfirmed");
  if (request.resultKind === "partial") return result(Object.keys(asRecord(data?.failed) ?? {}).length ? "partial" : "confirmed");
  const remoteId = safeId(data?.id) ?? (typeof data?.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(data.id) ? data.id : null);
  return result("confirmed", remoteId);
}

/** Local replay uses the encrypted receipt even if the first settlement crashed. */
async function repairActionReceipt(app: AppContext, id: string, fenceDb: Database) {
  const intent = await rowById(app, id);
  const row = intent.response_observation_id ? { id: intent.response_observation_id } : (await app.db.execute<{ id: string }>(sql`select observation_id as id from observation_keys where source='operator' and idempotency_key=${actionObservationKey(id)}`)).rows[0];
  if (!row) return dto(app, intent);
  const observationId = Number(row.id);
  const observation = await loadObservationPayload(app, observationId);
  const payload = asRecord(observation?.payload);
  if (!observation || !payload) return dto(app, intent);
  const source = decryptJsonWithKeyVersion<Captured>(payload.encryptedBody as Parameters<typeof decryptJsonWithKeyVersion>[0], app.config.encryptionKeysByVersion);
  const frozen = decrypt<Frozen>(app, intent.body_encrypted);
  if (JSON.stringify(source.frozen) !== JSON.stringify(frozen)) throw new ConflictError("Captured action identity differs from the prepared request");
  const request = ofapiActionRequest(frozen.command, frozen.accountId);
  let body: unknown = null;
  const text = Buffer.from(source.bodyBase64, "base64").toString("utf8");
  try { body = text.length ? JSON.parse(text) : ""; } catch { /* Malformed bytes remain authoritative evidence. */ }
  const refs = [...new Set([...intent.subject_refs, ...actionSubjectRefs(frozen.command), ...ofapiActionResponseSubjectRefs(frozen.command, asRecord(body)?.data)])].sort();
  await erasureGuard(fenceDb, frozen.command, new Date(intent.created_at), refs);
  const status = Number(payload.status);
  const outcome = classifyOfapiActionResult(frozen.command, request, status, body);
  const meta = parseResponseMeta(body, source.headers);
  const result = { data: asRecord(body)?.data ?? null, meta: asRecord(body)?._pagination ?? null };
  await app.db.execute(sql`update ofapi_action_intents set state=${outcome.state},remote_id=${outcome.remoteId},error_code=${outcome.errorCode},
    subject_refs=ARRAY[${sql.join(refs.map(ref => sql`${ref}`), sql`, `)}]::text[],result_encrypted=${encrypted(app, result)},response_observation_id=${observationId},actual_credits=${meta?.creditsUsed ?? null},settled_at=coalesce(settled_at,now())
    where id=${id} and state not in ('prepared','cancelled')`);
  // Financial receipt processing is independently idempotent. A failure cannot unconfirm the provider result.
  if (intent.accounting_state === "complete") return dto(app, await rowById(app, id));
  const actual = meta?.creditsUsed ?? (status === 402 ? 0 : intent.estimated_credits);
  const sink = createOfapiCreditSpendSink({ ...app, config: { ...app.config, ofapiCreditLedgerEnabled: intent.ledger_enabled } });
  const accounted = await sink({ operation: operation(intent.action), httpStatus: status, credits: actual, estimated: meta?.creditsUsed == null,
    balanceAfter: meta?.creditBalance ?? null, requestId: id, pageId: Number(intent.page_id), actorUserId: source.actorUserId,
    attemptNumber: 1, isCached: meta?.isCached ?? null, receivedAt: observation.receivedAt.toISOString() });
  if (accounted === false) return dto(app, await rowById(app, id));
  await app.db.transaction(async tx => {
    const locked = (await tx.execute<Row>(sql`select * from ofapi_action_intents where id=${id} for update`)).rows[0];
    if (!locked) return;
    if (!locked.reservation_settled && locked.reserved_day) {
      const reservationDay = typeof locked.reserved_day === "string" ? locked.reserved_day.slice(0, 10) : locked.reserved_day.toISOString().slice(0, 10);
      await settleOfapiDayCreditReservation(tx as unknown as Database, { scope: "global",
        receipt: { scope: "global", reservationDay, estimate: locked.estimated_credits },
        creditsDelta: (locked.ledger_enabled ? 0 : actual) - locked.estimated_credits,
        balance: meta?.creditBalance ?? null, now: observation.receivedAt });
    }
    await tx.execute(sql`update ofapi_action_intents set accounting_state='complete',reservation_settled=true where id=${id}`);
  });
  return dto(app, await rowById(app, id));
}

async function dispatchCurrentAction(app: AppContext, id: string, actorUserId: number, bindingDb: Database) {
  const intent = await rowById(app, id);
  if (intent.state !== "prepared") return dto(app, intent);
  const frozen = decrypt<Frozen>(app, intent.body_encrypted);
  const command = ofapiActionSchema.parse(frozen.command);
  await erasureGuard(bindingDb, command, new Date(intent.created_at));
  const { request, accountId } = await authority(app, command, frozen, bindingDb);
  const client = app.ofapi;
  if (!client?.dispatchGovernedRaw || (await client.getCredentialPreflight?.())?.status !== "verified") throw new ServiceUnavailableError("Verified OFAPI transport is unavailable");
  let claimed = false;
  try {
    const raw = await client.dispatchGovernedRaw({ pageId: command.pageId, actorUserId }, {
      attemptId: id, operation: operation(command.action), method: request.method, pathname: request.path,
      deferAccountResponse: true,
      ...(request.query ? { query: request.query } : {}),
      ...(request.body !== undefined ? { bodyBytes: Buffer.from(JSON.stringify(request.body)), contentType: "application/json" } : {}),
      priorityClass: "interactive", deadlineAt: new Date(Date.now() + 65000), maxResponseBytes: 2 * 1024 * 1024,
      beforeDispatch: async () => {
        await authority(app, command, frozen, bindingDb);
        return app.db.transaction(async tx => {
          const locked = (await tx.execute<Row>(sql`select * from ofapi_action_intents where id=${id} for update`)).rows[0];
          if (!locked || locked.state !== "prepared") return false;
          const budget = await reserveOfapiDayCredits(tx as unknown as Database, { scope: "global", estimate: request.estimatedCredits,
            budget: app.config.ofapiMirrorGlobalDailyCreditBudget ?? OFAPI_MIRROR_BUDGET_DEFAULTS.globalDailyCreditBudget });
          if (!budget) throw new ServiceUnavailableError("OFAPI daily credit budget exhausted");
          await tx.execute(sql`update ofapi_action_intents set state='dispatching',dispatched_at=now(),reserved_day=${budget.reservationDay}::date,ledger_enabled=${isOfapiCreditLedgerEnabled(app.config)} where id=${id}`);
          return true;
        }).then(value => { claimed = value; return value; });
      },
    });
    const observation = await insertObservation(app.db, { source: "operator", producer: "ofapi:actions", platform: "onlyfans", kind: OFAPI_ACTION_RESPONSE_KIND,
      accountId: command.pageId, nativeAccountRef: accountId, receivedAt: raw.receivedAt, idempotencyKey: actionObservationKey(id),
      payload: { intentId: id, subjectRefs: actionSubjectRefs(command), status: raw.status, encryptedBody: encryptJson({ frozen, bodyBase64: raw.bodyBytes.toString("base64"), headers: raw.headers, actorUserId }, app.config.encryptionKey, app.config.encryptionKeyVersion) },
      payloadHash: createHash("sha256").update(raw.bodyBytes).digest() });
    await app.db.execute(sql`update ofapi_action_intents set response_observation_id=${observation.observationId} where id=${id}`);
    await repairActionReceipt(app, id, bindingDb);
    await insertAuditEvent(app.db, { actorUserId, source: "api", eventType: "admin.ofapi_action_dispatched", metadata: { id, pageId: command.pageId, action: command.action, observationId: observation.observationId } });
  } catch (error) {
    if (claimed) await app.db.execute(sql`update ofapi_action_intents set state='indeterminate',error_code=${error instanceof OfapiGovernedRequestError ? `${error.phase}_${error.reason}` : "local_capture_or_settlement_pending"}
      where id=${id} and state='dispatching'`);
    if ((await rowById(app, id)).state === "prepared") throw new ServiceUnavailableError("The request was not dispatched; the prepared action is retained");
  }
  return dto(app, await rowById(app, id));
}

export async function dispatchOfapiAction(app: AppContext, id: string, actorUserId: number) {
  const intent = await rowById(app, id);
  if (intent.state !== "prepared") return getOfapiAction(app, id);
  const outcome = await withActionLock(app.db, db => dispatchCurrentAction(app, id, actorUserId, db), Number(intent.page_id));
  // Health callbacks may themselves take the binding lock; apply only after the
  // physical response is captured and that lock is released.
  if (outcome.responseObservationId) {
    try {
      const observation = await loadObservationPayload(app, outcome.responseObservationId);
      const payload = asRecord(observation?.payload);
      if (payload?.status === 404) {
        const source = decryptJsonWithKeyVersion<Captured>(payload.encryptedBody as Parameters<typeof decryptJsonWithKeyVersion>[0], app.config.encryptionKeysByVersion);
        await app.ofapi?.recordGovernedAccountResponse?.(source.frozen.accountId, source.frozen.generation, 404, Buffer.from(source.bodyBase64, "base64").toString("utf8"));
      }
    } catch { /* Provider outcome is already durable; health evidence can be revisited. */ }
  }
  return outcome;
}
export async function repairOfapiAction(app: AppContext, id: string) {
  const intent = await rowById(app, id);
  const frozen = decrypt<Frozen>(app, intent.body_encrypted);
  return withActionLock(app.db, async tx => {
    await erasureGuard(tx, frozen.command, new Date(intent.created_at));
    return repairActionReceipt(app, id, tx);
  });
}

export async function getOfapiAction(app: AppContext, id: string) {
  await app.db.execute(sql`update ofapi_action_intents set state='indeterminate',error_code='dispatch_interrupted' where id=${id} and state='dispatching' and dispatched_at<now()-interval '2 minutes'`);
  const row = await rowById(app, id);
  if (row.state !== "prepared" && row.state !== "cancelled" && (row.state === "indeterminate" || row.accounting_state !== "complete")) {
    try { return await repairOfapiAction(app, id); } catch { /* Local evidence stays available while repair is pending. */ }
  }
  return dto(app, await rowById(app, id));
}
export async function listOfapiActions(app: AppContext, pageId: number) {
  const rows = (await app.db.execute<{ id: string }>(sql`select id from ofapi_action_intents where page_id=${pageId} order by created_at desc limit 50`)).rows;
  const intents = [];
  for (const row of rows) intents.push(await getOfapiAction(app, row.id));
  return { intents };
}
export async function cancelOfapiAction(app: AppContext, id: string, actorUserId: number) {
  const row = await rowById(app, id);
  if (row.state === "cancelled") return dto(app, row);
  const updated = await app.db.execute(sql`update ofapi_action_intents set state='cancelled',settled_at=now() where id=${id} and state='prepared' returning id`);
  if (!updated.rows.length) throw new ConflictError("Only an action that has not been dispatched can be cancelled locally");
  await insertAuditEvent(app.db, { actorUserId, source: "api", eventType: "admin.ofapi_action_cancelled", metadata: { id, pageId: Number(row.page_id), action: row.action } });
  return dto(app, await rowById(app, id));
}
