import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import { isDmArchiveScopeFenced, tryAcquireDmArchiveWriterFenceLock } from "./erasure-fence.ts";

export interface WebhookDeliveryAttempt {
  attemptId: number;
  deliveryUuid: string;
  eventType: string;
  attemptNumber: number;
  succeeded: boolean;
  statusCode: number | null;
  errorType: string | null;
  idempotencyKey: string | null;
  accountId: string | null;
  accountRefs: string[];
  redeliveredFrom: string | null;
  createdAt: Date;
}

export interface WebhookDeliveryScan extends Record<string, unknown> {
  id: string; webhook_id: string; credential_fingerprint: string; observed_team: string;
  window_start: Date; window_end: Date; state: string; next_offset: number; captured_attempts: number;
  lease_token: string | null; error_code: string | null; created_at: Date; updated_at: Date; completed_at: Date | null;
}

export function normalizeWebhookDeliveryScan(row: WebhookDeliveryScan): WebhookDeliveryScan {
  return { ...row, window_start: new Date(row.window_start), window_end: new Date(row.window_end),
    created_at: new Date(row.created_at), updated_at: new Date(row.updated_at),
    completed_at: row.completed_at ? new Date(row.completed_at) : null };
}

export async function createWebhookDeliveryScan(db: Database, input: {
  id: string; webhookId: string; credentialFingerprint: string; observedTeam: string;
  from: Date; to: Date;
}) {
  await db.execute(sql`insert into ofapi_webhook_delivery_scans
    (id,webhook_id,credential_fingerprint,observed_team,window_start,window_end,state)
    values (${input.id},${input.webhookId},${input.credentialFingerprint},${input.observedTeam},${input.from},${input.to},'pending')
    on conflict(id) do nothing`);
  return getWebhookDeliveryScan(db, input.id);
}

export async function getWebhookDeliveryScan(db: Database, id: string) {
  const row = (await db.execute<WebhookDeliveryScan>(sql`select * from ofapi_webhook_delivery_scans where id=${id}`)).rows[0];
  return row ? normalizeWebhookDeliveryScan(row) : null;
}

export async function claimWebhookDeliveryScan(db: Database, id: string) {
  const token = randomUUID();
  const row = (await db.execute<WebhookDeliveryScan>(sql`update ofapi_webhook_delivery_scans
    set state='running',lease_token=${token},lease_until=now()+interval '2 minutes',error_code=null,updated_at=now()
    where id=${id} and (state in ('pending','failed') or (state='running' and lease_until<now())) returning *`)).rows[0];
  return row ? normalizeWebhookDeliveryScan(row) : null;
}

export async function captureWebhookDeliveryPage(db: Database, input: {
  scan: WebhookDeliveryScan; attempts: WebhookDeliveryAttempt[]; observationId: number;
  observationReceivedAt: Date; complete: boolean;
}) {
  return db.transaction(async tx => {
    const locked = await tx.execute(sql`select id from ofapi_webhook_delivery_scans
      where id=${input.scan.id} and state='running' and lease_token=${input.scan.lease_token}
        and next_offset=${input.scan.next_offset} for update`);
    if (!locked.rows.length) throw new Error("OFAPI delivery scan lease changed");
    let inserted = 0;
    for (const attempt of input.attempts) {
      const pageRows = attempt.accountRefs.length ? (await tx.execute<{ page_id: number }>(sql`
        select distinct page_id from ofapi_account_bindings where account_id in ${attempt.accountRefs}
        union select id as page_id from pages where ofapi_account_id in ${attempt.accountRefs}`)).rows : [];
      let fenced = false;
      for (const page of pageRows.sort((a, b) => Number(a.page_id) - Number(b.page_id))) {
        if (!await tryAcquireDmArchiveWriterFenceLock(tx, Number(page.page_id))) throw new Error("Erasure is in progress");
        if (await isDmArchiveScopeFenced(tx, { pageId: Number(page.page_id), refs: [], materialAt: attempt.createdAt })) fenced = true;
      }
      if (fenced) continue;
      const result = await tx.execute(sql`insert into ofapi_webhook_delivery_attempts
        (webhook_id,attempt_id,delivery_uuid,event_type,attempt_number,succeeded,status_code,error_type,
         idempotency_key,ofapi_account_id,account_refs,redelivered_from,source_created_at,observation_id,observation_received_at)
        values (${input.scan.webhook_id},${attempt.attemptId},${attempt.deliveryUuid},${attempt.eventType},
          ${attempt.attemptNumber},${attempt.succeeded},${attempt.statusCode},${attempt.errorType},
          ${attempt.idempotencyKey},${attempt.accountId},${JSON.stringify(attempt.accountRefs)}::jsonb,${attempt.redeliveredFrom},${attempt.createdAt},
          ${input.observationId},${input.observationReceivedAt}) on conflict(webhook_id,attempt_id) do nothing returning attempt_id`);
      inserted += result.rows.length;
    }
    await tx.execute(sql`update ofapi_webhook_delivery_scans set
      next_offset=next_offset+${input.attempts.length},captured_attempts=captured_attempts+${inserted},
      state=${input.complete ? "complete" : "running"},
      completed_at=${input.complete ? new Date() : null},lease_until=now()+interval '2 minutes',updated_at=now()
      where id=${input.scan.id} and lease_token=${input.scan.lease_token}`);
    return inserted;
  });
}

export async function finishWebhookDeliveryScanTick(db: Database, scan: WebhookDeliveryScan, errorCode?: string) {
  await db.execute(sql`update ofapi_webhook_delivery_scans set state=${errorCode ? "failed" : "pending"},
    lease_token=null,lease_until=null,error_code=${errorCode ?? null},updated_at=now()
    where id=${scan.id} and lease_token=${scan.lease_token} and state='running'`);
}

export interface WebhookCollectionPolicy extends Record<string, unknown> {
  version: number; desired_groups: string[]; applied_groups: string[]; history_enabled: boolean;
  apply_state: string; applied_at: Date | null; error_code: string | null;
}
export async function getWebhookCollectionPolicy(db: Database) {
  const row = (await db.execute<WebhookCollectionPolicy>(sql`select * from ofapi_webhook_collection_policy where id=true`)).rows[0];
  if (!row) throw new Error("OFAPI webhook collection policy is missing");
  return { ...row, version: Number(row.version), applied_at: row.applied_at ? new Date(row.applied_at) : null };
}
export async function saveWebhookCollectionPolicy(db: Database, input: { expectedVersion: number; groups: string[]; historyEnabled: boolean }) {
  const result = await db.execute(sql`update ofapi_webhook_collection_policy set version=version+1,
    desired_groups=${JSON.stringify(input.groups)}::jsonb,history_enabled=${input.historyEnabled},
    apply_state='pending',error_code=null,updated_at=now()
    where id=true and version=${input.expectedVersion} and
      (apply_state<>'applying' or apply_started_at<now()-interval '5 minutes') returning version`);
  return result.rows.length > 0;
}
export async function claimWebhookCollectionApply(db: Database, version: number) {
  const token = randomUUID();
  const result = await db.execute(sql`update ofapi_webhook_collection_policy set apply_state='applying',
    apply_token=${token},apply_started_at=now(),error_code=null,updated_at=now()
    where id=true and version=${version} and
      (apply_state<>'applying' or apply_started_at<now()-interval '5 minutes') returning version`);
  return result.rows.length ? token : null;
}
export async function settleWebhookCollectionApply(db: Database, input: { version: number; token: string; groups: string[]; errorCode?: string }) {
  await db.execute(sql`update ofapi_webhook_collection_policy set
    apply_state=${input.errorCode ? "failed" : "applied"},error_code=${input.errorCode ?? null},
    applied_groups=case when ${Boolean(input.errorCode)} then applied_groups else ${JSON.stringify(input.groups)}::jsonb end,
    applied_at=case when ${Boolean(input.errorCode)} then applied_at else now() end,
    apply_token=null,updated_at=now() where id=true and version=${input.version} and apply_token=${input.token}`);
}
