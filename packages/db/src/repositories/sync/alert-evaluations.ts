import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { textArrayParam, timestampParam, toDate } from "./values.ts";

// Fansly Sync Engine, bug hunt Д11: the alert evaluator's proof of work
// (`sync_alert_evaluations`, 0262). One row per handover/live page and rule:
// when the rule was last judged in full, and the failure that keeps it from
// being judged now. The evaluator (`apps/runtime/src/sync/engine/alerts.ts`)
// writes every rule of a page once a pass; the api watchdog
// (`apps/runtime/src/services/ops-watchdog.ts`) reads the pairs that went
// unjudged. Nothing here deletes: the rows of a page go with its erasure, and
// a rule the vocabulary dropped is never read again.

/** The evaluator's rules: the page alerts 1–4, the route incidents and the
 *  pace backstop. The one vocabulary of the evaluator (it writes exactly these)
 *  and of the watchdog (it reads exactly these). */
export const SYNC_ALERT_EVALUATION_RULES = [
  "page_stopped",
  "live_degraded",
  "freshness",
  "stuck",
  "route_limited",
  "pace_audit",
] as const;
export type SyncAlertEvaluationRule = (typeof SYNC_ALERT_EVALUATION_RULES)[number];

/** One rule of one pass: null when it was judged in full, else why not. */
export interface SyncAlertEvaluationOutcome {
  rule: SyncAlertEvaluationRule;
  failure: string | null;
}

/**
 * The evaluator's pass over one page: one row per rule, written at `at` (the
 * pass's database clock). A judged rule moves `evaluated_at` to `at` and clears
 * its failure; a rule that was not keeps its `evaluated_at` and its failure
 * streak's start.
 */
export async function recordSyncAlertEvaluation(
  db: Database,
  input: { pageId: number; at: Date; outcomes: readonly SyncAlertEvaluationOutcome[] },
): Promise<void> {
  if (input.outcomes.length === 0) return;
  const at = timestampParam(input.at);
  await db.execute(sql`
    insert into sync_alert_evaluations as e (page_id, rule, attempted_at, evaluated_at, failure, failed_since)
    select ${input.pageId}, o.rule, ${at},
           case when o.failure is null then ${at} end,
           o.failure,
           case when o.failure is not null then ${at} end
      from unnest(${textArrayParam(input.outcomes.map((outcome) => outcome.rule))},
                  ${sql.param(input.outcomes.map((outcome) => outcome.failure))}::text[]) as o(rule, failure)
    on conflict (page_id, rule) do update
       set attempted_at = excluded.attempted_at,
           evaluated_at = coalesce(excluded.evaluated_at, e.evaluated_at),
           failure = excluded.failure,
           failed_since = case when excluded.failure is null then null
                               else coalesce(e.failed_since, excluded.failed_since) end
  `);
}

/** A pass that could not even read its frame (the pages, the open latches):
 *  every row is attempted now and fails with `failure` (best effort). */
export async function markSyncAlertEvaluationPassFailed(db: Database, input: { failure: string }): Promise<void> {
  await db.execute(sql`
    update sync_alert_evaluations
       set attempted_at = clock_timestamp(),
           failure = ${input.failure},
           failed_since = coalesce(failed_since, clock_timestamp())
  `);
}

/** A page × rule the evaluator has not judged in full for too long. */
export interface SyncUnevaluatedAlertRule {
  pageId: number;
  pageLabel: string | null;
  rule: SyncAlertEvaluationRule;
  evaluatedAt: Date | null;
  attemptedAt: Date | null;
  failure: string | null;
  failedSince: Date | null;
  /** The evaluator has written a row for the pair. */
  recorded: boolean;
}

/**
 * Every handover/live page × rule of the vocabulary whose last full judgement
 * — or the page's last mode change, whichever is later — lies more than
 * `staleAfterMs` before now (the database clock; a pair without a row counts
 * from the mode change). The api watchdog's read.
 */
export async function readUnevaluatedSyncAlertRules(
  db: Database,
  input: { staleAfterMs: number },
): Promise<SyncUnevaluatedAlertRule[]> {
  const result = await db.execute<{
    pageId: number | string;
    pageLabel: string | null;
    rule: SyncAlertEvaluationRule;
    evaluatedAt: Date | string | null;
    attemptedAt: Date | string | null;
    failure: string | null;
    failedSince: Date | string | null;
    recorded: boolean;
  }>(sql`
    select sp.page_id as "pageId", p.label as "pageLabel", r.rule,
           e.evaluated_at as "evaluatedAt", e.attempted_at as "attemptedAt",
           e.failure, e.failed_since as "failedSince", e.page_id is not null as recorded
      from sync_pages sp
      join pages p on p.id = sp.page_id
     cross join unnest(${textArrayParam(SYNC_ALERT_EVALUATION_RULES)}) with ordinality as r(rule, ord)
      left join sync_alert_evaluations e on e.page_id = sp.page_id and e.rule = r.rule
     where sp.mode in ('handover', 'live')
       and greatest(e.evaluated_at, sp.mode_changed_at) < now() - ${input.staleAfterMs}::double precision * interval '1 millisecond'
     order by p.label, sp.page_id, r.ord
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.pageId),
    pageLabel: row.pageLabel,
    rule: row.rule,
    evaluatedAt: toDate(row.evaluatedAt),
    attemptedAt: toDate(row.attemptedAt),
    failure: row.failure,
    failedSince: toDate(row.failedSince),
    recorded: row.recorded === true,
  }));
}
