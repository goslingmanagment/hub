import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  getProjectionWatermark, listEventAccounts, listEventsSince, setProjectionWatermark, isFanslyWsHintDrainDue,
  lockFanslyWsGeneration, nextFanslyWsHintBudgetAt, routeFanslyWsHintEvent, requestPageSync,
  tryAcquireDmArchiveWriterFenceLock, type Database,
} from "@agency_hub_core/db";
import { FANSLY_WS_HINT_TYPES, resolveFanslyWsHintPolicy } from "@agency_hub_core/shared";
import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { readFanslyPageGeneration } from "../egress/fansly-probe-context.ts";
import { FANSLY_WS_SIGNAL_EVENT } from "../canonicalize/fansly-ws.ts";

const ref = z.string().regex(/^[0-9]{1,32}$/);
const signalSchema = z.object({
  generation: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  receivedAt: z.iso.datetime({ offset: true }),
  path: z.array(z.number().int().nonnegative()).max(9),
  outcome: z.enum(["hint", "mutation_debt", "not_enabled", "unrouted", "invalid", "limit"]),
  hint: z.object({ type: z.enum(FANSLY_WS_HINT_TYPES), groupRef: ref, messageRef: ref.nullable() }).optional(),
  mutation: z.object({ groupRef: ref.nullable(), messageRef: ref, correlationRef: ref.nullable(), bulk: z.boolean().nullable() }).optional(),
});

export const FANSLY_WS_HINT_PROJECTION = "fansly_ws_hints";

/** A spent budget's zero-request wake: at most one per page per interval. */
const DRAIN_WAKE_INTERVAL_MS = 5 * 60_000;

/** Existing minutely projector: events -> operational receipts/dirty queue.
 * No HTTP. One bounded ledger page per account/tick, including when disabled.
 * Minimal diagnostic callers without config are explicitly default-off. */
export async function runFanslyWsHintProjection(
  app: Pick<AppContext, "db" | "logger"> & Partial<Pick<AppContext, "config">>,
  input?: { accountId?: number | null },
) {
  const effective = app.config ? await loadEffectiveConfig(app.db, app.config) : null;
  const accounts = input?.accountId != null ? [input.accountId] : await listEventAccounts(app.db);
  const totals = { accounts: 0, eventsSeen: 0, applied: 0 };
  for (const accountId of accounts) {
    const page = (await app.db.execute<{ label: string }>(sql`
      select label from pages where id = ${accountId} and platform = 'fansly' and deleted_at is null
    `)).rows[0];
    if (!page) continue;
    totals.accounts++;
    const policy = effective ? resolveFanslyWsHintPolicy(effective, page.label) : null;
    const watermark = await getProjectionWatermark(app.db, FANSLY_WS_HINT_PROJECTION, accountId);
    const events = await listEventsSince(app.db, { accountId, afterSeq: watermark, limit: 500 });
    totals.eventsSeen += events.length;
    for (const event of events) {
      if (event.type !== FANSLY_WS_SIGNAL_EVENT || event.observationId == null) continue;
      const parsed = signalSchema.safeParse(event.data);
      if (!parsed.success) throw new Error("fansly_ws_hint_event_invalid");
      const signal = parsed.data;
      const applied = await app.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        await lockFanslyWsGeneration(db, accountId);
        if (!await tryAcquireDmArchiveWriterFenceLock(db, accountId)) throw new Error("fansly_ws_hint_erasure_busy");
        // Erasure may have removed this event after listEventsSince returned.
        const exists = await db.execute(sql`select id from domain_events where account_id = ${accountId}
          and id = ${event.id} and account_seq = ${event.accountSeq}`);
        if (!exists.rows.length) return false;
        const groupRef = signal.hint?.groupRef ?? signal.mutation?.groupRef ?? null;
        const erased = await db.execute(sql`select id from erasure_log e where not e.dry_run
          and e.started_at >= ${new Date(signal.receivedAt)} and (
            (e.scope_type in ('page','model') and e.plan->'resolvedPageIds' @> to_jsonb(${accountId}::bigint))
            or (e.scope_type = 'fan' and e.plan->'resolvedFanGroupIds' ? ${groupRef ?? ""})
          ) limit 1`);
        if (erased.rows.length) return false;
        const currentPolicy = policy && await readFanslyPageGeneration(db, page.label) === policy.generation ? policy : null;
        return routeFanslyWsHintEvent(db, {
          id: event.id, pageId: accountId, observationId: event.observationId!,
          receivedAt: new Date(signal.receivedAt), generation: signal.generation,
          node: { path: signal.path, outcome: signal.outcome,
            ...(signal.hint ? { hint: signal.hint } : {}),
            ...(signal.mutation ? { mutation: signal.mutation } : {}) },
        }, currentPolicy);
      });
      if (applied) totals.applied++;
    }
    if (events.length) await setProjectionWatermark(app.db, FANSLY_WS_HINT_PROJECTION, accountId, events.at(-1)!.accountSeq);
    // Retrying this existing scheduler request after a crash is safe: the
    // subject queue, not the wakeup, owns target/revision custody.
    if (policy) {
      const due = await app.db.execute(sql`select 1 from subject_refresh_state where page_id = ${accountId}
        and plane = 'fansly_ws_dm' and requested_revision > applied_revision and next_due_at <= now()
        and backfill_cursor->>'generation' = ${policy.generation} limit 1`);
      if (due.rows.length) {
        const now = new Date();
        // A wake exists to spend B1's budget. While it is spent, wake only to
        // settle targets ordinary polling already stored: a settle-only run
        // that makes no request, once the queue has gone unserved a while.
        if (!await nextFanslyWsHintBudgetAt(app.db, { pageId: accountId, maxAttempts24h: policy.maxAttempts24h, now })) {
          await requestPageSync(app.db, { pageId: accountId, streams: ["dm_messages"], source: "event" });
        } else if (await isFanslyWsHintDrainDue(app.db, {
          pageId: accountId, policy, now, quietSince: new Date(now.getTime() - DRAIN_WAKE_INTERVAL_MS),
        })) {
          await requestPageSync(app.db, { pageId: accountId, streams: ["dm_messages"], source: "event",
            requestPayloadByStream: { dm_messages: { fanslyWsHintSettleOnly: true } } });
        }
      }
    }
  }
  return totals;
}
