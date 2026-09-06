import type { OfapiWebhookDeliveryHistoryResponse } from "@agency_hub_core/contracts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  captureWebhookDeliveryPage, claimWebhookCollectionApply, claimWebhookDeliveryScan,
  createWebhookDeliveryScan, finishWebhookDeliveryScanTick, getOfapiWebhookConfig,
  getWebhookCollectionPolicy, getWebhookDeliveryScan, insertAuditEvent,
  saveWebhookCollectionPolicy, settleWebhookCollectionApply, normalizeWebhookDeliveryScan,
  type WebhookDeliveryAttempt, type WebhookDeliveryScan,
} from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from "./errors.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";
import { OFAPI_OPTIONAL_WEBHOOK_GROUPS, lifecycleTimestamp } from "./ofapi-lifecycle-contract.ts";
import { OfapiApiError } from "./ofapi.ts";
import { buildOfapiWebhookEventSet, registerOfapiWebhook, resolveOfapiClient } from "./ofapi-webhooks.ts";
import { runCanonicalization } from "./canonicalize-driver.ts";
import { processOfapiWebhookEvent } from "./ofapi-events.ts";

const PAGE_SIZE = 100;
const DAY_MS = 86_400_000;
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
    observedTeam: proof.observedTeam, from, to,
  });
  if (!existing) throw new Error("Delivery scan creation failed");
  if (existing.webhook_id !== config.externalWebhookId || existing.window_start.getTime() !== from.getTime() ||
      existing.window_end.getTime() !== to.getTime() || existing.credential_fingerprint !== proof.credentialFingerprint) {
    throw new ConflictError("The scan identity belongs to a different window or credential scope");
  }
  if (existing.state === "complete") return scanResult(existing);
  let scan = await claimWebhookDeliveryScan(app.db, input.id);
  if (!scan) return scanResult(existing);
  if (input.actorUserId) await insertAuditEvent(app.db, { actorUserId: input.actorUserId, source: "api",
    eventType: "admin.ofapi_delivery_history_requested", metadata: { scanId: input.id, from: input.from, to: input.to } });
  try {
    for (let page = 0; page < Math.min(20, Math.max(1, input.maxPages ?? 20)); page += 1) {
      const response = await client.listWebhookDeliveries(scan.webhook_id, {
        from: input.from, to: input.to, limit: PAGE_SIZE, offset: scan.next_offset,
      });
      if (!response.capture) throw new Error("Delivery history response has no durable observation");
      const parsed = parseWebhookDeliveryPage(response.body);
      if (parsed.attempts.some(attempt => attempt.createdAt < from || attempt.createdAt > to)) throw new Error("Delivery response escaped the requested window");
      await captureWebhookDeliveryPage(app.db, { scan, ...parsed,
        observationId: response.capture.observationId, observationReceivedAt: response.capture.receivedAt });
      scan = (await getWebhookDeliveryScan(app.db, input.id))!;
      if (scan.state === "complete") break;
    }
    await finishWebhookDeliveryScanTick(app.db, scan);
  } catch (error) {
    await finishWebhookDeliveryScanTick(app.db, scan, errorCode(error));
    app.logger.warn({ scanId: input.id, code: errorCode(error) }, "OFAPI delivery history scan paused");
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

export async function redeliverOfapiWebhook(app: AppContext, input: { id: string; attemptId: number; actorUserId: number; dryRun: boolean }) {
  const config = await getOfapiWebhookConfig(app.db);
  if (!config?.externalWebhookId) throw new ConflictError("Register the OFAPI webhook first");
  const webhookId = config.externalWebhookId;
  const attempt = (await app.db.execute<{ idempotency_key: string | null; source_created_at: Date }>(sql`
    select idempotency_key,source_created_at from ofapi_webhook_delivery_attempts
    where webhook_id=${webhookId} and attempt_id=${input.attemptId}`)).rows[0];
  if (!attempt) throw new NotFoundError("Capture this delivery attempt before requesting redelivery");
  // A process lost after dispatch has an unknown outcome, never a fresh send.
  await app.db.execute(sql`update ofapi_webhook_redelivery_intents set state='indeterminate',error_code='dispatch_interrupted'
    where state='dispatching' and created_at<now()-interval '2 minutes'`);
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
    // One global reservation also caps intentional remote replay at 20/day.
    await tx.execute(sql`select pg_advisory_xact_lock(9003018)`);
    const prior = await tx.execute(sql`select id from ofapi_webhook_redelivery_intents
      where webhook_id=${webhookId} and attempt_id=${input.attemptId} and state in ('dispatching','accepted','indeterminate')`);
    if (prior.rows.length) throw new ConflictError("An earlier redelivery for this attempt already owns the outcome; inspect its delivery chain");
    const count = (await tx.execute<{ n: number }>(sql`select count(*)::int n from ofapi_webhook_redelivery_intents where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'`)).rows[0]?.n ?? 0;
    if (count >= 20) throw new ConflictError("Daily manual redelivery limit reached (20)");
    const row = await tx.execute(sql`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,actor_user_id,state)
      values(${input.id},${webhookId},${input.attemptId},${input.actorUserId},'dispatching') on conflict(id) do nothing returning id`);
    if (row.rows.length) await insertAuditEvent(tx, { actorUserId: input.actorUserId, source: "api", eventType: "admin.ofapi_webhook_redelivery_requested",
      metadata: { id: input.id, webhookId, attemptId: input.attemptId, webhookEventCreditsEstimated: 0.01 } });
    return row.rows.length > 0;
  });
  if (!claimed) return { id: input.id, state: "dispatching", redeliveryUuid: null, errorCode: null, projected: false };
  let state = "indeterminate"; let uuid: string | null = null; let code: string | null = null;
  try {
    const response = await client.redeliverWebhookDelivery(webhookId, input.attemptId);
    const data = asRecord(asRecord(response.body)?.data);
    if (!response.capture || data?.webhook_id !== webhookId || data.delivery_id !== input.attemptId ||
        typeof data.redelivery_id !== "string" || !data.redelivery_id) throw new Error("OFAPI redelivery acknowledgement could not be verified");
    uuid = data.redelivery_id; state = "accepted";
  } catch (error) {
    code = errorCode(error);
    if (error instanceof OfapiApiError && error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 408) state = "rejected";
  }
  await app.db.execute(sql`update ofapi_webhook_redelivery_intents set state=${state},redelivery_uuid=${uuid},error_code=${code},settled_at=now()
    where id=${input.id} and state='dispatching'`);
  return { id: input.id, state, redeliveryUuid: uuid, errorCode: code, projected: false };
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

export async function sweepOfapiWebhookDeliveryHistory(app: AppContext) {
  try {
  const policy = await getWebhookCollectionPolicy(app.db);
  if (!policy.history_enabled) return;
  const config = await getOfapiWebhookConfig(app.db);
  if (!config?.externalWebhookId) return;
  const raw = (await app.db.execute<WebhookDeliveryScan>(sql`select * from ofapi_webhook_delivery_scans where webhook_id=${config.externalWebhookId} order by created_at desc limit 1`)).rows[0];
  const last = raw ? normalizeWebhookDeliveryScan(raw) : null;
  if (last && Date.now() - last.updated_at.getTime() < 5 * 60_000) return;
  const proof = await resolveOfapiClient(app).getCredentialPreflight?.();
  if (proof?.status !== "verified") return;
  const sameScope = last?.credential_fingerprint === proof.credentialFingerprint;
  const continuation = last && sameScope && ["pending", "failed", "running"].includes(last.state) && last.window_start.getTime() > Date.now() - 7 * DAY_MS;
  const to = continuation ? last.window_end : new Date();
  const from = continuation ? last.window_start : new Date(Math.max(Date.now() - 7 * DAY_MS + 60_000, ((sameScope ? last?.window_end.getTime() : null) ?? Date.now() - DAY_MS) - 60 * 60_000));
    await syncOfapiWebhookDeliveries(app, { id: continuation ? last.id : randomUUID(), from: from.toISOString(), to: to.toISOString(), maxPages: 1 });
  } catch (error) {
    app.logger.warn({ code: errorCode(error) }, "OFAPI delivery history collector could not advance");
  }
}
