import type { OfapiWebhookDeliveryHistoryResponse } from "@agency_hub_core/contracts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  captureWebhookDeliveryPage, claimWebhookCollectionApply, claimWebhookDeliveryScan,
  createWebhookDeliveryScan, finishWebhookDeliveryScanTick, getOfapiWebhookConfig,
  getWebhookCollectionPolicy, getWebhookDeliveryHistoryCoverage, getWebhookDeliveryScan, insertAuditEvent,
  saveWebhookCollectionPolicy, settleWebhookCollectionApply, normalizeWebhookDeliveryScan,
  type Database, type WebhookDeliveryAttempt, type WebhookDeliveryScan,
} from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from "./errors.ts";
import { notifyOfapiGlobalIncident, resolveOfapiGlobalIncident } from "./notification-incidents.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";
import { OFAPI_OPTIONAL_WEBHOOK_GROUPS, lifecycleTimestamp } from "./ofapi-lifecycle-contract.ts";
import { OfapiApiError, OfapiHistoryRequestError, ofapiSafeErrorDiagnostics, type OfapiClient } from "./ofapi.ts";
import { buildOfapiWebhookEventSet, registerOfapiWebhook, resolveOfapiClient } from "./ofapi-webhooks.ts";
import { runCanonicalization } from "./canonicalize-driver.ts";
import { processOfapiWebhookEvent } from "./ofapi-events.ts";

const PAGE_SIZE = 100;
const DAY_MS = 86_400_000;
// Delivery timestamps are reported at second precision. Keep the complete
// boundary seconds; do not infer subsecond exclusion from a JS Date window.
const historySecond = (date: Date) => Math.floor(date.getTime() / 1000) * 1000;
const groupIds = Object.keys(OFAPI_OPTIONAL_WEBHOOK_GROUPS);
type Group = keyof typeof OFAPI_OPTIONAL_WEBHOOK_GROUPS;

function errorCode(error: unknown) {
  if (error instanceof OfapiApiError && error.status !== null) {
    return error.status === 409 ? "webhook_paused_or_disabled" : `vendor_http_${error.status}`;
  }
  return "provider_outcome_unknown";
}
function scanResult(scan: WebhookDeliveryScan) {
  return { id: scan.id, webhookId: scan.webhook_id, state: scan.state, from: scan.window_start.toISOString(),
    to: scan.window_end.toISOString(), nextOffset: scan.next_offset, capturedAttempts: scan.captured_attempts,
    errorCode: scan.error_code, coverageScope: "credential-visible" as const,
    completedAt: scan.completed_at?.toISOString() ?? null };
}

export function parseWebhookDeliveryPage(body: unknown) {
  const root = asRecord(body);
  if (!Array.isArray(root?.data)) throw new Error("OFAPI delivery history omitted data array");
  if (root.data.length > PAGE_SIZE) throw new Error("OFAPI delivery history exceeded the bounded page size");
  const attempts = root.data.map((value): WebhookDeliveryAttempt => {
    const row = asRecord(value);
    const createdAt = lifecycleTimestamp(row?.created_at);
    const attemptId = row?.id;
    if (!row || !Number.isSafeInteger(attemptId) || Number(attemptId) <= 0 || !createdAt ||
        typeof row.delivery_uuid !== "string" || !row.delivery_uuid ||
        typeof row.event !== "string" || !row.event || typeof row.succeeded !== "boolean" ||
        !Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1) throw new Error("OFAPI delivery attempt identity is invalid");
    const envelope = asRecord(row.payload);
    const nested = asRecord(envelope?.payload);
    const accountId = idToString(envelope?.account_id);
    const accountRefs = [...new Set(accountId ? [accountId] : Array.isArray(nested?.account_ids)
      ? nested.account_ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [])];
    return { attemptId: Number(attemptId), deliveryUuid: row.delivery_uuid, eventType: row.event,
      attemptNumber: Number(row.attempt), succeeded: row.succeeded,
      statusCode: Number.isSafeInteger(row.status_code) ? Number(row.status_code) : null,
      // Error messages can echo credential URLs. The summary retains only the machine class.
      errorType: typeof row.error_type === "string" && /^[A-Za-z0-9_\\.:-]{1,200}$/.test(row.error_type) ? row.error_type : null,
      idempotencyKey: typeof row.idempotency_key === "string" && row.idempotency_key.length <= 255 ? row.idempotency_key : null,
      accountId, accountRefs, redeliveredFrom: idToString(row.redelivered_from), createdAt };
  });
  const pagination = asRecord(root._pagination);
  // A full page without pagination proof continues to one further bounded read.
  const complete = pagination && Object.hasOwn(pagination, "next_page")
    ? pagination.next_page === null : attempts.length < PAGE_SIZE;
  if (!complete && attempts.length === 0) throw new Error("OFAPI empty delivery page has a continuation");
  return { attempts, complete };
}

export async function syncOfapiWebhookDeliveries(app: AppContext, input: {
  id: string; from: string; to: string; maxPages?: number; actorUserId?: number;
}) {
  const from = new Date(input.from); const to = new Date(input.to); const now = Date.now();
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to ||
      to.getTime() - from.getTime() > 7 * DAY_MS || from.getTime() < now - 7 * DAY_MS - 60_000 || to.getTime() > now + 60_000) {
    throw new BadRequestError("Delivery history requires a closed window within the last seven days");
  }
  const client = resolveOfapiClient(app);
  const proof = await client.getCredentialPreflight?.();
  if (proof?.status !== "verified" || !proof.observedTeam || !client.listWebhookDeliveries) throw new ServiceUnavailableError("Verified OFAPI delivery-history access is unavailable");
  const config = await getOfapiWebhookConfig(app.db);
  if (!config?.externalWebhookId) throw new ConflictError("Register the OFAPI webhook first");
  const existing = await createWebhookDeliveryScan(app.db, {
    id: input.id, webhookId: config.externalWebhookId, credentialFingerprint: proof.credentialFingerprint,
    observedTeam: proof.observedTeam, from: new Date(historySecond(from)), to: new Date(historySecond(to) + 999),
  });
  if (!existing) throw new Error("Delivery scan creation failed");
  if (existing.webhook_id !== config.externalWebhookId || historySecond(existing.window_start) !== historySecond(from) ||
      historySecond(existing.window_end) !== historySecond(to) || existing.credential_fingerprint !== proof.credentialFingerprint) {
    throw new ConflictError("The scan identity belongs to a different window or credential scope");
  }
  if (existing.state === "complete") return scanResult(existing);
  let scan = await claimWebhookDeliveryScan(app.db, input.id);
  if (!scan) return scanResult(existing);
  if (input.actorUserId) await insertAuditEvent(app.db, { actorUserId: input.actorUserId, source: "api",
    eventType: "admin.ofapi_delivery_history_requested", metadata: { scanId: input.id, from: input.from, to: input.to } });
  let stage: "request" | "capture_missing" | "parse" | "window" | "persistence" = "request";
  try {
    for (let page = 0; page < Math.min(20, Math.max(1, input.maxPages ?? 20)); page += 1) {
      stage = "request";
      const response = await client.listWebhookDeliveries(scan.webhook_id, {
        // A legacy scan may already have a fractional-second window and a
        // nonzero offset. Its wire query MUST remain frozen across continuation.
        from: scan.window_start.toISOString(), to: scan.window_end.toISOString(), limit: PAGE_SIZE, offset: scan.next_offset,
      });
      stage = "capture_missing";
      if (!response.capture) throw new Error("Delivery history response has no durable observation");
      stage = "parse";
      const parsed = parseWebhookDeliveryPage(response.body);
      stage = "window";
      const windowStartMs = historySecond(scan.window_start);
      const windowEndExclusiveMs = historySecond(scan.window_end) + 1000;
      if (parsed.attempts.some(attempt => attempt.createdAt.getTime() < windowStartMs ||
        attempt.createdAt.getTime() >= windowEndExclusiveMs)) {
        throw new Error("Delivery response escaped the requested window");
      }
      stage = "persistence";
      await captureWebhookDeliveryPage(app.db, { scan, ...parsed,
        observationId: response.capture.observationId, observationReceivedAt: response.capture.receivedAt });
      scan = (await getWebhookDeliveryScan(app.db, input.id))!;
      if (scan.state === "complete") break;
    }
    stage = "persistence";
    await finishWebhookDeliveryScanTick(app.db, scan);
  } catch (error) {
    const diagnostics = error instanceof OfapiHistoryRequestError
      ? error.diagnostics : { stage, ...ofapiSafeErrorDiagnostics(error) };
    const code = error instanceof OfapiApiError && error.status !== null && error.status >= 300
      ? errorCode(error) : `history_${diagnostics.stage}_failed`;
    // Emit before a recovery UPDATE: its failure must not hide the original phase.
    // No error object, vendor body, headers, endpoint or account IDs cross this boundary.
    app.logger.warn({ scanId: input.id, operation: "ofapi_webhook_deliveries", code, ...diagnostics }, "OFAPI delivery history scan paused");
    await finishWebhookDeliveryScanTick(app.db, scan, code);
  }
  return scanResult((await getWebhookDeliveryScan(app.db, input.id))!);
}

export async function listOfapiWebhookDeliveryHistory(app: AppContext, input: { limit: number; offset: number; failedOnly?: boolean }) {
  const config = await getOfapiWebhookConfig(app.db);
  const webhookId = config?.externalWebhookId ?? null;
  if (!webhookId) return { webhookId: null, attempts: [], latestScan: null };
  const result = await app.db.execute<Omit<OfapiWebhookDeliveryHistoryResponse["attempts"][number], "createdAt"> & { createdAt: Date }>(sql`
    select a.attempt_id::float8 as "attemptId",a.delivery_uuid as "deliveryUuid",a.event_type as "eventType",
      a.attempt_number as "attemptNumber",a.succeeded,a.status_code as "statusCode",a.error_type as "errorType",
      a.redelivered_from as "redeliveredFrom",a.source_created_at as "createdAt",
      exists(select 1 from ofapi_webhook_delivery_attempts r where r.webhook_id=a.webhook_id
        and r.delivery_uuid=a.delivery_uuid and r.succeeded) as "deliveryRecovered",
      w.id::float8 as "localEventId",w.capture_state as "captureState",w.status as "localStatus",
      w.projection_status as "projectionStatus",o.parse_version as "canonicalVersion"
      ,i.state as "redeliveryState",i.redelivery_uuid as "redeliveryUuid",
      (select bool_or(r.succeeded) from ofapi_webhook_delivery_attempts r
        where r.webhook_id=a.webhook_id and r.delivery_uuid=i.redelivery_uuid) as "redeliverySucceeded"
    from ofapi_webhook_delivery_attempts a
    left join ofapi_webhook_events w on w.idempotency_key=a.idempotency_key
    left join observation_keys k on k.source='webhook' and k.idempotency_key=a.idempotency_key
    left join observations o on o.id=k.observation_id and o.received_at=k.received_at
    left join lateral(select state,redelivery_uuid from ofapi_webhook_redelivery_intents i
      where i.webhook_id=a.webhook_id and i.attempt_id=a.attempt_id order by created_at desc limit 1) i on true
    where a.webhook_id=${webhookId} ${input.failedOnly ? sql`and a.succeeded=false` : sql``}
    order by a.source_created_at desc,a.attempt_id desc limit ${input.limit} offset ${input.offset}
  `);
  const scan = (await app.db.execute<WebhookDeliveryScan>(sql`select * from ofapi_webhook_delivery_scans
    where webhook_id=${webhookId} order by created_at desc limit 1`)).rows[0];
  return { webhookId, attempts: result.rows.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })),
    latestScan: scan ? scanResult(normalizeWebhookDeliveryScan(scan)) : null };
}

// Provider business facts whose loss the hub and its desktops would notice.
// Presence, typing, account lifecycle and async-job hooks are either ephemeral
// or observed again by their own reconcilers; they are never redelivered
// automatically (H2, amends #265).
export const OFAPI_AUTO_REDELIVERY_EVENT_TYPES = [
  "messages.received", "messages.sent", "messages.deleted", "messages.ppv.unlocked", "tips.received",
  "transactions.new", "subscriptions.new", "subscriptions.renewed", "subscriptions.expired",
] as const;
const MANUAL_REDELIVERY_DAILY_LIMIT = 20;
const AUTO_REDELIVERY_DEFAULT_DAILY_CAP = 1000;
// The provider retries a failed delivery on its own for roughly a quarter of
// an hour (2026-09-23: four attempts per key over 18 minutes). Ten quiet
// minutes after the newest captured attempt leaves that chain alone.
const AUTO_REDELIVERY_QUIET_MS = 10 * 60_000;
const AUTO_REDELIVERY_MAX_PER_TICK = 25;
// One global reservation serializes manual and automatic intent creation.
const REDELIVERY_LOCK = 9003018;
export const OFAPI_AUTO_REDELIVERY_CAP_INCIDENT = { kind: "ofapi_burn_rate", subKey: "auto_redelivery_cap" } as const;
type RedeliveryOrigin = "manual" | "auto";

// A process lost after dispatch has an unknown outcome, never a fresh send.
async function settleInterruptedRedeliveries(db: Database) {
  await db.execute(sql`update ofapi_webhook_redelivery_intents set state='indeterminate',error_code='dispatch_interrupted'
    where state='dispatching' and created_at<now()-interval '2 minutes'`);
}
async function redeliveriesToday(db: Database, origin: RedeliveryOrigin) {
  return (await db.execute<{ n: number }>(sql`select count(*)::int n from ofapi_webhook_redelivery_intents
    where origin=${origin} and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'`)).rows[0]?.n ?? 0;
}
// Exactly one POST per committed intent. Only a verified acknowledgement is
// accepted and only a definite 4xx is rejected; anything else stays
// indeterminate and is never sent again for that intent.
async function dispatchRedeliveryIntent(app: AppContext, client: OfapiClient, input: { id: string; webhookId: string; attemptId: number }) {
  let state = "indeterminate"; let uuid: string | null = null; let code: string | null = null;
  try {
    const response = await client.redeliverWebhookDelivery!(input.webhookId, input.attemptId);
    const data = asRecord(asRecord(response.body)?.data);
    if (!response.capture || data?.webhook_id !== input.webhookId || data.delivery_id !== input.attemptId ||
        typeof data.redelivery_id !== "string" || !data.redelivery_id) throw new Error("OFAPI redelivery acknowledgement could not be verified");
    uuid = data.redelivery_id; state = "accepted";
  } catch (error) {
    code = errorCode(error);
    if (error instanceof OfapiApiError && error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 408) state = "rejected";
  }
  await app.db.execute(sql`update ofapi_webhook_redelivery_intents set state=${state},redelivery_uuid=${uuid},error_code=${code},settled_at=now()
    where id=${input.id} and state='dispatching'`);
  return { state, redeliveryUuid: uuid, errorCode: code };
}

export async function redeliverOfapiWebhook(app: AppContext, input: { id: string; attemptId: number; actorUserId: number; dryRun: boolean }) {
  const config = await getOfapiWebhookConfig(app.db);
  if (!config?.externalWebhookId) throw new ConflictError("Register the OFAPI webhook first");
  const webhookId = config.externalWebhookId;
  const attempt = (await app.db.execute<{ idempotency_key: string | null; source_created_at: Date }>(sql`
    select idempotency_key,source_created_at from ofapi_webhook_delivery_attempts
    where webhook_id=${webhookId} and attempt_id=${input.attemptId}`)).rows[0];
  if (!attempt) throw new NotFoundError("Capture this delivery attempt before requesting redelivery");
  await settleInterruptedRedeliveries(app.db);
  const existing = (await app.db.execute<{ webhook_id: string; attempt_id: string; state: string; redelivery_uuid: string | null; error_code: string | null }>(sql`
    select * from ofapi_webhook_redelivery_intents where id=${input.id}`)).rows[0];
  if (existing) {
    if (existing.webhook_id !== webhookId || Number(existing.attempt_id) !== input.attemptId) throw new ConflictError("Redelivery request identity belongs to another attempt");
    return { id: input.id, state: existing.state, redeliveryUuid: existing.redelivery_uuid, errorCode: existing.error_code, projected: false };
  }
  if (new Date(attempt.source_created_at).getTime() < Date.now() - 7 * DAY_MS) throw new ConflictError("Provider delivery retention has expired; use retained local evidence");
  if (attempt.idempotency_key) {
    const local = await app.db.execute(sql`select id from ofapi_webhook_events where idempotency_key=${attempt.idempotency_key}`);
    if (local.rows.length) throw new ConflictError("The receipt is retained locally; use local projection replay");
  }
  if (!attempt.idempotency_key) throw new ConflictError("This delivery has no durable identity for business replay");
  if (input.dryRun) return { id: input.id, state: "preview", redeliveryUuid: null, errorCode: null, projected: false };
  const client = resolveOfapiClient(app);
  const proof = await client.getCredentialPreflight?.();
  if (proof?.status !== "verified" || !client.redeliverWebhookDelivery) throw new ServiceUnavailableError("Verified OFAPI redelivery access is unavailable");
  const claimed = await app.db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REDELIVERY_LOCK})`);
    const prior = await tx.execute(sql`select id from ofapi_webhook_redelivery_intents
      where webhook_id=${webhookId} and attempt_id=${input.attemptId} and state in ('dispatching','accepted','indeterminate')`);
    if (prior.rows.length) throw new ConflictError("An earlier redelivery for this attempt already owns the outcome; inspect its delivery chain");
    // The manual limit has its own counter; automatic requests never consume it.
    if (await redeliveriesToday(tx, "manual") >= MANUAL_REDELIVERY_DAILY_LIMIT) throw new ConflictError(`Daily manual redelivery limit reached (${MANUAL_REDELIVERY_DAILY_LIMIT})`);
    const row = await tx.execute(sql`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,actor_user_id,origin,business_key,state)
      values(${input.id},${webhookId},${input.attemptId},${input.actorUserId},'manual',${attempt.idempotency_key},'dispatching') on conflict(id) do nothing returning id`);
    if (row.rows.length) await insertAuditEvent(tx, { actorUserId: input.actorUserId, source: "api", eventType: "admin.ofapi_webhook_redelivery_requested",
      metadata: { id: input.id, webhookId, attemptId: input.attemptId, webhookEventCreditsEstimated: 0.01 } });
    return row.rows.length > 0;
  });
  if (!claimed) return { id: input.id, state: "dispatching", redeliveryUuid: null, errorCode: null, projected: false };
  const outcome = await dispatchRedeliveryIntent(app, client, { id: input.id, webhookId, attemptId: input.attemptId });
  return { id: input.id, ...outcome, projected: false };
}

interface AutoRedeliveryCandidate { businessKey: string; attemptId: number; eventType: string; lastAttemptAt: Date }

/** Business keys eligible for one automatic redelivery, nearest to provider
 * expiry first. The redelivered attempt is the key's newest captured attempt.
 * Every attempt of the key failed and happened at or after `enabledAt`; the
 * newest is quiet for ten minutes and inside the seven-day retention; there is
 * no local receipt, no active intent of either origin and no automatic intent
 * of any outcome for the key. */
export async function selectOfapiAutoRedeliveryCandidates(db: Database, input: { webhookId: string; enabledAt: Date; limit: number }) {
  const types = sql.join(OFAPI_AUTO_REDELIVERY_EVENT_TYPES.map(type => sql`${type}`), sql`,`);
  const rows = (await db.execute<{ business_key: string; attempt_id: string; event_type: string; source_created_at: Date }>(sql`
    select k.idempotency_key as business_key,l.attempt_id,l.event_type,l.source_created_at
    from (select distinct a.idempotency_key from ofapi_webhook_delivery_attempts a
      where a.webhook_id=${input.webhookId} and a.idempotency_key is not null and not a.succeeded
        and a.event_type in (${types}) and a.source_created_at>=${input.enabledAt}
        and a.source_created_at>=now()-interval '7 days') k
    cross join lateral (select l.attempt_id,l.event_type,l.source_created_at from ofapi_webhook_delivery_attempts l
      where l.webhook_id=${input.webhookId} and l.idempotency_key=k.idempotency_key
      order by l.source_created_at desc,l.attempt_id desc limit 1) l
    where l.source_created_at<now()-make_interval(secs => ${AUTO_REDELIVERY_QUIET_MS / 1000})
      and l.source_created_at>=now()-interval '7 days' and l.event_type in (${types})
      and not exists(select 1 from ofapi_webhook_delivery_attempts e where e.webhook_id=${input.webhookId}
        and e.idempotency_key=k.idempotency_key and (e.succeeded or e.source_created_at<${input.enabledAt}))
      and not exists(select 1 from ofapi_webhook_events w where w.idempotency_key=k.idempotency_key)
      and not exists(select 1 from ofapi_webhook_redelivery_intents i join ofapi_webhook_delivery_attempts ia
        on ia.webhook_id=i.webhook_id and ia.attempt_id=i.attempt_id
        where i.webhook_id=${input.webhookId} and ia.idempotency_key=k.idempotency_key and i.state in ('dispatching','accepted','indeterminate'))
      and not exists(select 1 from ofapi_webhook_redelivery_intents i
        where i.webhook_id=${input.webhookId} and i.origin='auto' and i.business_key=k.idempotency_key)
    order by l.source_created_at asc,l.attempt_id asc limit ${input.limit}`)).rows;
  return rows.map((row): AutoRedeliveryCandidate => ({ businessKey: row.business_key, attemptId: Number(row.attempt_id),
    eventType: row.event_type, lastAttemptAt: new Date(row.source_created_at) }));
}

// The switch is live config; the moment the worker first sees it on is kept
// durably so failures from before it are never redelivered automatically.
// Switching off forgets that moment: a later switch-on starts a new one.
async function autoRedeliveryEnabledAt(app: AppContext, enabled: boolean) {
  if (!enabled) {
    const cleared = await app.db.execute(sql`update ofapi_webhook_auto_redelivery_state set enabled_at=null,updated_at=now()
      where enabled_at is not null returning id`);
    if (cleared.rows.length) {
      await insertAuditEvent(app.db, { source: "worker", eventType: "system.ofapi_webhook_auto_redelivery_disabled", metadata: {} });
      app.logger.info({ operation: "ofapi_webhook_auto_redelivery" }, "OFAPI webhook auto-redelivery switched off");
      // A cap condition cannot outlive the feature.
      await resolveOfapiGlobalIncident(app, OFAPI_AUTO_REDELIVERY_CAP_INCIDENT);
    }
    return null;
  }
  const started = await app.db.execute<{ enabled_at: Date }>(sql`insert into ofapi_webhook_auto_redelivery_state as s(id,enabled_at)
    values(true,now()) on conflict(id) do update set enabled_at=now(),updated_at=now() where s.enabled_at is null returning enabled_at`);
  if (started.rows[0]) {
    const enabledAt = new Date(started.rows[0].enabled_at);
    await insertAuditEvent(app.db, { source: "worker", eventType: "system.ofapi_webhook_auto_redelivery_enabled", metadata: { enabledAt: enabledAt.toISOString() } });
    app.logger.info({ operation: "ofapi_webhook_auto_redelivery", enabledAt: enabledAt.toISOString() }, "OFAPI webhook auto-redelivery switched on");
    return enabledAt;
  }
  const row = (await app.db.execute<{ enabled_at: Date | null }>(sql`select enabled_at from ofapi_webhook_auto_redelivery_state`)).rows[0];
  return row?.enabled_at ? new Date(row.enabled_at) : null;
}

/** Runs after each delivery-history sweep. Commits a durable automatic intent
 * before its single POST, at most once per business key, within the UTC-day
 * cap. Reaching the cap latches the existing burn-rate incident under its own
 * subKey until the day's automatic count is below the cap again. Never throws. */
export async function runOfapiWebhookAutoRedelivery(app: AppContext) {
  const result = { dispatched: 0, capReached: false };
  try {
    const effective = await loadEffectiveConfig(app.db, app.config);
    const enabledAt = await autoRedeliveryEnabledAt(app, effective.ofapiWebhookAutoRedeliveryEnabled === true);
    if (!enabledAt) return result;
    const cap = effective.ofapiWebhookAutoRedeliveryDailyCap ?? AUTO_REDELIVERY_DEFAULT_DAILY_CAP;
    const config = await getOfapiWebhookConfig(app.db);
    if (!config?.externalWebhookId) return result;
    const webhookId = config.externalWebhookId;
    await settleInterruptedRedeliveries(app.db);
    // Resolve verified access only when there is work: the cached preflight
    // must never run inside the reservation transaction.
    let client: OfapiClient | null = null;
    if ((await selectOfapiAutoRedeliveryCandidates(app.db, { webhookId, enabledAt, limit: 1 })).length) {
      const resolved = resolveOfapiClient(app);
      const proof = await resolved.getCredentialPreflight?.();
      if (proof?.status === "verified" && resolved.redeliverWebhookDelivery) client = resolved;
      else app.logger.warn({ operation: "ofapi_webhook_auto_redelivery" }, "OFAPI webhook auto-redelivery waits for verified redelivery access");
    }
    while (client && result.dispatched < AUTO_REDELIVERY_MAX_PER_TICK) {
      const claim = await app.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(${REDELIVERY_LOCK})`);
        const [candidate] = await selectOfapiAutoRedeliveryCandidates(tx, { webhookId, enabledAt, limit: 1 });
        if (!candidate) return { kind: "none" as const };
        const today = await redeliveriesToday(tx, "auto");
        if (today >= cap) return { kind: "cap" as const, today, candidate };
        const id = randomUUID();
        const row = await tx.execute(sql`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,actor_user_id,origin,business_key,state)
          values(${id},${webhookId},${candidate.attemptId},null,'auto',${candidate.businessKey},'dispatching') on conflict do nothing returning id`);
        if (!row.rows.length) return { kind: "conflict" as const, candidate };
        await insertAuditEvent(tx, { source: "worker", eventType: "system.ofapi_webhook_auto_redelivery_requested",
          metadata: { id, webhookId, attemptId: candidate.attemptId, eventType: candidate.eventType, webhookEventCreditsEstimated: 0.01 } });
        return { kind: "claimed" as const, id, candidate };
      });
      if (claim.kind === "none") break;
      if (claim.kind === "conflict") {
        app.logger.warn({ operation: "ofapi_webhook_auto_redelivery", attemptId: claim.candidate.attemptId }, "OFAPI webhook auto-redelivery intent collided; left for the next sweep");
        break;
      }
      if (claim.kind === "cap") {
        result.capReached = true;
        app.logger.warn({ operation: "ofapi_webhook_auto_redelivery", cap, dispatchedToday: claim.today,
          oldestWaitingAttemptId: claim.candidate.attemptId }, "OFAPI webhook auto-redelivery daily cap reached");
        await notifyOfapiGlobalIncident(app, { ...OFAPI_AUTO_REDELIVERY_CAP_INCIDENT,
          errorSummary: `OFAPI webhook auto-redelivery reached its daily cap (${claim.today}/${cap} this UTC day); `
            + "remaining failed business webhooks wait for the next UTC day or a manual redelivery" });
        break;
      }
      const outcome = await dispatchRedeliveryIntent(app, client, { id: claim.id, webhookId, attemptId: claim.candidate.attemptId });
      result.dispatched += 1;
      app.logger.info({ operation: "ofapi_webhook_auto_redelivery", intentId: claim.id, attemptId: claim.candidate.attemptId,
        eventType: claim.candidate.eventType, state: outcome.state, errorCode: outcome.errorCode }, "OFAPI webhook auto-redelivery requested");
    }
    if (!result.capReached && await redeliveriesToday(app.db, "auto") < cap) {
      await resolveOfapiGlobalIncident(app, OFAPI_AUTO_REDELIVERY_CAP_INCIDENT);
    }
  } catch (error) {
    app.logger.warn({ operation: "ofapi_webhook_auto_redelivery", code: errorCode(error), ...ofapiSafeErrorDiagnostics(error) },
      "OFAPI webhook auto-redelivery could not advance");
  }
  return result;
}

export async function replayLocalOfapiWebhook(app: AppContext, input: { eventId: number; actorUserId: number; dryRun: boolean }) {
  const row = (await app.db.execute<{ capture_state: string; projection_status: string; event_type: string; observation_id: string | null }>(sql`
    select w.capture_state,w.projection_status,w.event_type,k.observation_id from ofapi_webhook_events w
    left join observation_keys k on k.source='webhook' and k.idempotency_key=w.idempotency_key where w.id=${input.eventId}`)).rows[0];
  if (!row) throw new NotFoundError("OFAPI webhook receipt was not found");
  if (row.capture_state !== "accepted") throw new ConflictError("Quarantine repair requires validating the original signed envelope separately");
  if (input.dryRun) return { eventId: input.eventId, state: "preview" };
  await insertAuditEvent(app.db, { actorUserId: input.actorUserId, source: "api", eventType: "admin.ofapi_webhook_local_replay_requested", metadata: { eventId: input.eventId } });
  // An explicit attempt bypasses the automatic sweep cap without rewriting
  // its attempt count, the fact or the original SSE sequence.
  await processOfapiWebhookEvent(app, input.eventId);
  if (row.observation_id) await runCanonicalization(app, { observationId: Number(row.observation_id), kinds: [row.event_type], pageSize: 1, maxPagesPerFamily: 1 });
  return { eventId: input.eventId, state: "processed_locally" };
}

export async function webhookCollectionPolicyStatus(app: AppContext) {
  const policy = await getWebhookCollectionPolicy(app.db);
  return { version: policy.version, desiredGroups: policy.desired_groups, appliedGroups: policy.applied_groups,
    historyEnabled: policy.history_enabled, applyState: policy.apply_state, errorCode: policy.error_code,
    appliedAt: policy.applied_at?.toISOString() ?? null,
    groups: groupIds.map(id => ({ id, events: [...OFAPI_OPTIONAL_WEBHOOK_GROUPS[id as Group]] })) };
}
export async function saveOfapiWebhookCollectionPolicy(app: AppContext, input: { expectedVersion: number; groups: string[]; historyEnabled: boolean; actorUserId: number }) {
  if (input.groups.some(group => !groupIds.includes(group))) throw new BadRequestError("Unknown optional webhook group");
  await app.db.transaction(async tx => {
    if (!await saveWebhookCollectionPolicy(tx, { ...input, groups: [...new Set(input.groups)].sort() })) throw new ConflictError("Webhook policy version changed or application is in progress");
    await insertAuditEvent(tx, { actorUserId: input.actorUserId, source: "api", eventType: "admin.ofapi_webhook_policy_saved",
      metadata: { groups: input.groups, historyEnabled: input.historyEnabled, previousVersion: input.expectedVersion } });
  });
  return webhookCollectionPolicyStatus(app);
}
export async function applyOfapiWebhookCollectionPolicy(app: AppContext, input: { expectedVersion: number; actorUserId: number }) {
  const policy = await getWebhookCollectionPolicy(app.db);
  if (policy.version !== input.expectedVersion) throw new ConflictError("Webhook policy version changed");
  const config = await getOfapiWebhookConfig(app.db);
  if (!config) throw new ConflictError("Register the OFAPI webhook first");
  const token = await claimWebhookCollectionApply(app.db, policy.version);
  if (!token) throw new ConflictError("Webhook policy is already being applied");
  try {
    await insertAuditEvent(app.db, { actorUserId: input.actorUserId, source: "api", eventType: "admin.ofapi_webhook_policy_apply_requested", metadata: { version: policy.version, groups: policy.desired_groups } });
    await registerOfapiWebhook(app, { endpointUrl: config.endpointUrl, optionalWebhookGroups: policy.desired_groups as Group[] });
    const current = await getOfapiWebhookConfig(app.db);
    const client = resolveOfapiClient(app);
    const remote = current?.externalWebhookId ? await client.getWebhook?.(current.externalWebhookId) : null;
    const desired = buildOfapiWebhookEventSet(policy.desired_groups as Group[]).sort();
    if (!remote || !Array.isArray(remote.events) || JSON.stringify([...remote.events].sort()) !== JSON.stringify(desired) ||
        (remote.endpoint_url ?? remote.url) !== config.endpointUrl || remote.account_scope !== "global") {
      throw new Error("OFAPI remote webhook configuration readback did not match");
    }
    await settleWebhookCollectionApply(app.db, { version: policy.version, token, groups: policy.desired_groups });
  } catch (error) {
    await settleWebhookCollectionApply(app.db, { version: policy.version, token, groups: policy.desired_groups, errorCode: errorCode(error) });
  }
  return webhookCollectionPolicyStatus(app);
}

// Normal cadence is one free 100-row page every five minutes (#265). When the
// newest completed window ends more than 30 minutes ago, a healthy collector
// catches up: it continues every minute with up to five pages per tick, each
// persisted before the next request. A failed page keeps the five-minute pause.
const HISTORY_TICK_MS = 5 * 60_000;
export const OFAPI_DELIVERY_HISTORY_CATCH_UP_LAG_MS = 30 * 60_000;
const HISTORY_CATCH_UP_PAGES = 5;

export async function sweepOfapiWebhookDeliveryHistory(app: AppContext) {
  try {
  const policy = await getWebhookCollectionPolicy(app.db);
  if (!policy.history_enabled) return;
  const config = await getOfapiWebhookConfig(app.db);
  if (!config?.externalWebhookId) return;
  const raw = (await app.db.execute<WebhookDeliveryScan>(sql`select * from ofapi_webhook_delivery_scans where webhook_id=${config.externalWebhookId} order by created_at desc limit 1`)).rows[0];
  const last = raw ? normalizeWebhookDeliveryScan(raw) : null;
  const coverage = await getWebhookDeliveryHistoryCoverage(app.db);
  const lagMs = coverage?.frontier ? Date.now() - coverage.frontier.getTime() : Infinity;
  const catchUp = lagMs > OFAPI_DELIVERY_HISTORY_CATCH_UP_LAG_MS && last?.state !== "failed";
  if (last && !catchUp && Date.now() - last.updated_at.getTime() < HISTORY_TICK_MS) return;
  const proof = await resolveOfapiClient(app).getCredentialPreflight?.();
  if (proof?.status !== "verified") return;
  const sameScope = last?.credential_fingerprint === proof.credentialFingerprint;
  const continuation = last && sameScope && ["pending", "failed", "running"].includes(last.state) && last.window_start.getTime() > Date.now() - 7 * DAY_MS;
  const to = continuation ? last.window_end : new Date();
  const from = continuation ? last.window_start : new Date(Math.max(Date.now() - 7 * DAY_MS + 60_000, ((sameScope ? last?.window_end.getTime() : null) ?? Date.now() - DAY_MS) - 60 * 60_000));
    if (catchUp) app.logger.info({ operation: "ofapi_webhook_deliveries", lagMinutes: Number.isFinite(lagMs) ? Math.round(lagMs / 60_000) : null,
      maxPages: HISTORY_CATCH_UP_PAGES }, "OFAPI delivery history collector catching up");
    await syncOfapiWebhookDeliveries(app, { id: continuation ? last.id : randomUUID(), from: from.toISOString(), to: to.toISOString(), maxPages: catchUp ? HISTORY_CATCH_UP_PAGES : 1 });
  } catch (error) {
    app.logger.warn({ code: errorCode(error) }, "OFAPI delivery history collector could not advance");
  }
}
