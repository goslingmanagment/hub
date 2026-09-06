import { sql } from "drizzle-orm";
import { appendProjectionOnlyDomainEventsInTransaction, getProjectionWatermark, hashOfapiCaptureValue, insertOfapiTypedExportRow, listEventAccounts, listEventsSince, setProjectionWatermark, upsertOfapiProfileVisitorsDaily, type Database, type OfapiVisitorMetrics } from "@agency_hub_core/db";
import type { OfapiTypedExportProfile } from "@agency_hub_core/shared";
import type { AppContext } from "../../bootstrap.ts";
export const OFAPI_TYPED_EXPORT_PROJECTION = "ofapi_typed_exports";
export const OFAPI_TYPED_EXPORT_EVENT = "ofapi.typed_snapshot_observed";
export interface OfapiTypedFact {
  row: { jobId: string; profile: OfapiTypedExportProfile; rowKey: string; data: Record<string, string | null> } | null;
  metrics: OfapiVisitorMetrics | null;
  source: "export" | "rest_total" | "rest_users" | "rest_guests";
  observationId: number; observationReceivedAt: string;
}
async function applyFact(db: Database, pageId: number, fact: OfapiTypedFact) {
  const observationReceivedAt = new Date(fact.observationReceivedAt);
  if (fact.row) await insertOfapiTypedExportRow(db, { ...fact.row, pageId, observationId: fact.observationId, observationReceivedAt });
  if (fact.metrics) await upsertOfapiProfileVisitorsDaily(db, { ...fact.metrics, pageId, source: fact.source, ...(fact.row ? { exportJobId: fact.row.jobId } : {}), observationId: fact.observationId, observationReceivedAt, observedAt: observationReceivedAt });
}
/** Facts and their immediate serving projection commit in the same transaction. */
export async function recordOfapiTypedFacts(db: Database, pageId: number, facts: OfapiTypedFact[], observationId: number, observedAt: Date) {
  await db.transaction(async tx => {
    const database = tx as unknown as Database;
    await appendProjectionOnlyDomainEventsInTransaction(database, pageId, facts.map(fact => ({ type: OFAPI_TYPED_EXPORT_EVENT, occurredAt: observedAt, observationId,
      ...(fact.row?.profile === "fans" ? { fanIdentityRef: fact.row.rowKey } : {}), data: fact, schemaVersion: 1, dedupKey: `typed-snapshot:${observationId}:${hashOfapiCaptureValue(fact)}` })),
    { occurredAt: observedAt, observationId, dedupKey: `typed-checkpoint:${observationId}:${hashOfapiCaptureValue(facts)}` });
    for (const fact of facts) await applyFact(database, pageId, fact);
  });
}
export async function runOfapiTypedExportsProjection(app: Pick<AppContext, "db" | "logger">, input?: { accountId?: number | null }) {
  let applied = 0; let eventsSeen = 0;
  const accounts = input?.accountId != null ? [input.accountId] : await listEventAccounts(app.db);
  for (const accountId of accounts) {
    let watermark = await getProjectionWatermark(app.db, OFAPI_TYPED_EXPORT_PROJECTION, accountId);
    for (;;) {
      const events = await listEventsSince(app.db, { accountId, afterSeq: watermark, limit: 500 });
      if (!events.length) break; eventsSeen += events.length;
      await app.db.transaction(async tx => {
        const database = tx as unknown as Database;
        for (const event of events) if (event.type === OFAPI_TYPED_EXPORT_EVENT) { await applyFact(database, accountId, event.data as OfapiTypedFact); applied += 1; }
        watermark = events[events.length - 1]!.accountSeq;
        await setProjectionWatermark(database, OFAPI_TYPED_EXPORT_PROJECTION, accountId, watermark);
      });
      if (events.length < 500) break;
    }
  }
  return { applied, eventsSeen };
}
/** Only derived tables are reset. Captured artifacts, jobs, budgets and approval fences survive. */
export async function rebuildOfapiTypedExportsProjection(app: Pick<AppContext, "db" | "logger">, input?: { accountId?: number | null }) {
  await app.db.transaction(async tx => {
    await tx.execute(sql`delete from ofapi_typed_export_rows ${input?.accountId == null ? sql`` : sql`where page_id=${input.accountId}`}`);
    await tx.execute(sql`delete from ofapi_profile_visitors_daily ${input?.accountId == null ? sql`` : sql`where page_id=${input.accountId}`}`);
    await tx.execute(sql`delete from projection_seq_watermarks where projection=${OFAPI_TYPED_EXPORT_PROJECTION} ${input?.accountId == null ? sql`` : sql`and account_id=${input.accountId}`}`);
  });
  return runOfapiTypedExportsProjection(app, input);
}
