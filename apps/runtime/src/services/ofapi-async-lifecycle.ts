import {
  listOfapiWebhookEventsForDmProjection,
  markOfapiWebhookEventProjection,
} from "@agency_hub_core/db";
import { sql } from "drizzle-orm";
import type { AppContext } from "../bootstrap.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";
import { OFAPI_ASYNC_LIFECYCLE_EVENT_TYPES, lifecycleTimestamp } from "./ofapi-lifecycle-contract.ts";

export interface OfapiAsyncLifecycle {
  resourceId: string;
  resourceKind: "media_upload" | "data_export";
  status: string;
  rank: number;
  accountIds: string[];
  sourceAt: Date | null;
  mediaId: string | null;
  mediaReady: boolean | null;
  creditCost: number | null;
}

const ranks: Readonly<Record<string, number>> = {
  calculating_credits: 1, calculating_credits_completed: 2, calculating_credits_failed: 2,
  in_progress: 3, completed: 4, failed: 4, cancelled: 4,
};

/** A webhook is progress evidence, never proof of imported rows or media readiness. */
export function parseOfapiAsyncLifecycle(eventType: string, envelope: Record<string, unknown>): OfapiAsyncLifecycle | null {
  if (!(OFAPI_ASYNC_LIFECYCLE_EVENT_TYPES as readonly string[]).includes(eventType)) return null;
  const payload = asRecord(envelope.payload);
  const resourceId = idToString(payload?.id);
  const status = eventType.slice(eventType.indexOf(".") + 1);
  if (!payload || !resourceId || payload.status !== status) return null;
  const upload = eventType.startsWith("media_uploads.");
  const accountId = idToString(envelope.account_id);
  const accountIds = upload ? (accountId ? [accountId] : []) :
    Array.isArray(payload.account_ids) ? payload.account_ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  if (!accountIds.length || (upload && payload.account_id && payload.account_id !== accountId)) return null;
  const media = asRecord(payload.media);
  const cost = upload ? payload.credits_used : payload.credit_cost;
  return {
    resourceId, resourceKind: upload ? "media_upload" : "data_export", status,
    rank: ranks[status] ?? 0, accountIds: [...new Set(accountIds)],
    // created_at is creation of the job, not this transition; do not fabricate ordering from it.
    sourceAt: lifecycleTimestamp(payload.completed_at) ?? lifecycleTimestamp(payload.failed_at) ?? lifecycleTimestamp(payload.updated_at),
    mediaId: idToString(payload.media_id),
    mediaReady: typeof media?.isReady === "boolean" ? media.isReady : null,
    creditCost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}

interface LifecycleRow {
  id: number;
  eventType: string;
  payload: Record<string, unknown>;
  projectionStatus: string;
}

export async function runOfapiAsyncLifecycleForSettledRow(app: AppContext, row: LifecycleRow) {
  if (!(OFAPI_ASYNC_LIFECYCLE_EVENT_TYPES as readonly string[]).includes(row.eventType) ||
      !["pending", "failed"].includes(row.projectionStatus)) return;
  const parsed = parseOfapiAsyncLifecycle(row.eventType, row.payload);
  try {
    // The journal IS the append-only lifecycle store; this validates the row for
    // consumers. Keeping individual transitions preserves conflict and replay evidence.
    await markOfapiWebhookEventProjection(app.db, {
      id: row.id, status: parsed ? "projected" : "skipped",
      error: parsed ? null : "Lifecycle resource identity, scope or status is invalid",
    });
  } catch (error) {
    app.logger.warn({ err: error, eventId: row.id }, "OFAPI async lifecycle projection failed; sweep will retry");
    await markOfapiWebhookEventProjection(app.db, { id: row.id, status: "failed", error: "lifecycle_projection_failed" }).catch(() => undefined);
  }
}

export async function sweepOfapiAsyncLifecycles(app: AppContext) {
  const rows = await listOfapiWebhookEventsForDmProjection(app.db, {
    eventTypes: OFAPI_ASYNC_LIFECYCLE_EVENT_TYPES, maxAttempts: 5, limit: 200,
  });
  for (const row of rows) await runOfapiAsyncLifecycleForSettledRow(app, row);
  return rows.length;
}

/** DB-only status read for an already-owned resource. Callers enforce principal/page
 * ACL before passing its frozen provider account ID. No URL/token/body escapes. */
export async function getOfapiAsyncLifecycle(app: AppContext, input: {
  resourceKind: OfapiAsyncLifecycle["resourceKind"];
  resourceId: string;
  ofapiAccountId: string;
}) {
  const types = OFAPI_ASYNC_LIFECYCLE_EVENT_TYPES.filter(type =>
    type.startsWith(input.resourceKind === "media_upload" ? "media_uploads." : "data_exports."));
  const result = await app.db.execute<{ id: number; event_type: string; payload: Record<string, unknown>; received_at: Date }>(sql`
    select w.id, w.event_type, w.payload, w.received_at from ofapi_webhook_events w
    where w.capture_state='accepted' and w.projection_status='projected'
      and w.event_type in (${sql.join(types.map(type => sql`${type}`), sql`, `)})
      and w.payload->'payload'->>'id'=${input.resourceId}
      and (w.ofapi_account_id=${input.ofapiAccountId} or w.payload->'payload'->'account_ids' ? ${input.ofapiAccountId})
    order by case w.payload->'payload'->>'status'
      when 'completed' then 4 when 'failed' then 4 when 'cancelled' then 4
      when 'in_progress' then 3 when 'calculating_credits_completed' then 2
      when 'calculating_credits_failed' then 2 else 1 end desc, w.id desc limit 100
  `);
  const candidates = result.rows.flatMap(row => {
    const parsed = parseOfapiAsyncLifecycle(row.event_type, row.payload);
    return parsed && parsed.accountIds.includes(input.ofapiAccountId) ? [{ ...parsed, eventId: Number(row.id), receivedAt: row.received_at }] : [];
  });
  candidates.sort((a, b) => b.rank - a.rank ||
    (b.sourceAt?.getTime() ?? 0) - (a.sourceAt?.getTime() ?? 0) || b.eventId - a.eventId);
  const latest = candidates[0];
  if (!latest) return null;
  const conflictingTerminal = latest.rank === 4 && candidates.some(row => row.rank === 4 && row.status !== latest.status);
  return { ...latest, conflictingTerminal };
}
