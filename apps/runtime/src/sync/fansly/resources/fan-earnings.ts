import { sql } from "drizzle-orm";

import {
  claimFanEarningsRotation,
  fanEarningsPlane,
  renewFanEarningsClaim,
  settleFanEarningsReceipt,
  type Database,
  type FanEarningsClaim,
  type FanEarningsRefreshWindow,
} from "@agency_hub_core/db";

import { buildFanEarningsReceipt } from "../lib/fan-earnings-receipt.ts";
import { BLOCKED_PROBE_EVERY_MS, SUBJECT_BLOCK_AFTER, SUBJECT_BREAKER_LADDER_MS } from "../../engine/errors.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  RequestPlan,
  ResourceModule,
  StepPlan,
} from "../../engine/resource.ts";

// `fan-earnings.roster` (plan §5, design §5.8): the per-fan earnings of the
// page's spenders, one endpoint for one fan per step —
// `/account/wallets/earnings/stats/accounts` (lifetime, journaled as
// `fan_earnings_stats`) or `…/monthlystats/accounts` (monthly,
// `fan_earnings_monthly`), with `correlationAccountId=<fan>&after=0&before=now`.
//
// The subjects are the `subject_refresh_state` rows of the two earnings planes
// (design §4.3, D2): the receipt model of the legacy lane is unchanged —
// the claim at admission (`claimFanEarningsRotation`, so the revision a read
// answers is the one before it was sent), the receipt in the apply
// (`buildFanEarningsReceipt` → `settleFanEarningsReceipt`), and the canonical
// `fan.earnings_observed` events from the journaled observation. A subject is
// due when
//   - a dirty mark or a retry made it due (`next_due_at`, written by the
//     transactions writer and by the receipts), or
//   - it is a spender of the page (`page_fans` net > 0) never read, or not
//     read within the roster age (today's 156 h).
// One walk row per page steps through the due subjects (dirty first, then
// never read, then the oldest read) and closes when none is left; the
// transactions apply asks for a new one whenever a subject is due again.
//
// The subject's breaker lives on its queue row: a 5xx (or a 2xx the receipt
// cannot vouch for) climbs 1 m → 10 m → 1 h → 6 h → 24 h, then
// `blocked_by_vendor` with a daily probe; a 400/404/410 is the subject's final
// answer for now — a `rejected` receipt, read again on the next dirty mark or
// at the roster age. Retired: the daily target cap, the target attempt
// journal, the recovery roster (its debt stays readable as
// `countFanEarningsRecoveryDebt`).

export const FAN_EARNINGS_ROSTER_KEY = "fan-earnings.roster";

const HOUR_MS = 3_600_000;
/** The roster age (registry parameter; the production owner setting
 *  `fanslyFanEarningsRosterMaxAgeHours` = 156): a spender is read again this
 *  long after its last read. */
export const FAN_EARNINGS_ROSTER_MAX_AGE_MS = 156 * HOUR_MS;

export type FanEarningsWindow = FanEarningsRefreshWindow;

export interface FanEarningsSubject {
  fanRef: string;
  window: FanEarningsWindow;
}

export interface DueFanEarningsSubject extends FanEarningsSubject {
  /** 0 marked due (dirty, retry), 1 never read, 2 read before the roster age. */
  rank: number;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function windowOf(value: unknown): FanEarningsWindow | null {
  return value === "lifetime" || value === "monthly" ? value : null;
}

/** The fan and window a request reads. */
export function fanEarningsSubjectOfRequest(request: RequestPlan): FanEarningsSubject | null {
  const params = recordOf(request.params);
  const fanRef = typeof params.correlationAccountId === "string" ? params.correlationAccountId : "";
  if (fanRef.length === 0) return null;
  if (request.spec === "earnings.stats_accounts") return { fanRef, window: "lifetime" };
  if (request.spec === "earnings.monthly_accounts") return { fanRef, window: "monthly" };
  return null;
}

/** The request of one subject: the whole history up to now. */
export function fanEarningsRequest(subject: FanEarningsSubject, now: Date): RequestPlan {
  return {
    spec: subject.window === "lifetime" ? "earnings.stats_accounts" : "earnings.monthly_accounts",
    params: { correlationAccountId: subject.fanRef, afterMs: 0, beforeMs: now.getTime() },
  };
}

/**
 * The next due subject of the page (read-only): marked due first (by due
 * time), then never read, then the oldest read.
 */
export async function nextDueFanEarningsSubject(
  db: Database,
  input: { pageId: number; now: Date; maxAgeMs?: number },
): Promise<DueFanEarningsSubject | null> {
  const now = input.now;
  const ageCutoff = new Date(now.getTime() - (input.maxAgeMs ?? FAN_EARNINGS_ROSTER_MAX_AGE_MS));
  const result = await db.execute<{ fanRef: string; window: string; rank: number }>(sql`
    with planes(window_name, plane) as (
      values ('lifetime', 'fan_earnings_lifetime'), ('monthly', 'fan_earnings_monthly')
    ), roster as (
      select f.platform_user_id as fan_ref
        from page_fans pf
        join fans f on f.id = pf.fan_id
       where pf.platform_account_id = ${input.pageId}
         and pf.total_creator_net_mills > 0
    ), due as (
      select s.subject_ref as fan_ref, p.window_name, 0 as rank, s.next_due_at as at
        from subject_refresh_state s
        join planes p on p.plane = s.plane
       where s.page_id = ${input.pageId}
         and s.next_due_at <= ${now}
         and (s.claim_token is null or s.claim_expires_at <= ${now})
         and (s.retry_after_at is null or s.retry_after_at <= ${now})
      union all
      select r.fan_ref, p.window_name, case when s.last_visited_at is null then 1 else 2 end, s.last_visited_at
        from roster r
       cross join planes p
        left join subject_refresh_state s
          on s.page_id = ${input.pageId} and s.plane = p.plane and s.subject_ref = r.fan_ref
       where s.subject_ref is null or (
               (s.last_visited_at is null or s.last_visited_at <= ${ageCutoff})
           and (s.claim_token is null or s.claim_expires_at <= ${now})
           and (s.retry_after_at is null or s.retry_after_at <= ${now}))
    ), ranked as (
      select fan_ref, window_name, min(rank) as rank, min(at) as at
        from due
       group by fan_ref, window_name
    )
    select fan_ref as "fanRef", window_name as "window", rank::int as rank
      from ranked
     order by rank, at nulls first, fan_ref, window_name
     limit 1
  `);
  const row = result.rows[0];
  const window = windowOf(row?.window);
  return row === undefined || window === null ? null : { fanRef: row.fanRef, window, rank: Number(row.rank) };
}

/**
 * The roster walk a page needs now (a follow-up of the transactions steps,
 * which run at least every five minutes): one whenever a subject is due.
 */
export async function fanEarningsRosterFollowups(
  db: Database,
  input: { pageId: number; now: Date; reason: string },
): Promise<DemandSignal[]> {
  const due = await nextDueFanEarningsSubject(db, { pageId: input.pageId, now: input.now });
  return due === null ? [] : [{ resource: FAN_EARNINGS_ROSTER_KEY, demand: { reason: input.reason } }];
}

/** The page's open claim of one subject (the actor is its only claimant). */
async function readClaim(db: Database, input: { pageId: number } & FanEarningsSubject): Promise<FanEarningsClaim | null> {
  const result = await db.execute<{ token: string; revision: string }>(sql`
    select claim_token::text as token, claimed_revision::text as revision
      from subject_refresh_state
     where page_id = ${input.pageId} and plane = ${fanEarningsPlane(input.window)} and subject_ref = ${input.fanRef}
       and claim_token is not null and claimed_revision is not null
  `);
  const row = result.rows[0];
  return row === undefined
    ? null
    : { pageId: input.pageId, fanRef: input.fanRef, window: input.window, token: row.token, revision: Number(row.revision) };
}

/** Settle a receipt under the subject's claim (renewed first: an apply may
 *  run after the claim's five minutes). False without a claim. */
async function settleReceipt(
  tx: Database,
  claim: FanEarningsClaim | null,
  receipt: Parameters<typeof settleFanEarningsReceipt>[2],
): Promise<boolean> {
  if (claim === null) return false;
  if (!(await renewFanEarningsClaim(tx, claim, receipt.checkedAt))) return false;
  return settleFanEarningsReceipt(tx, claim, receipt);
}

/**
 * The queue subject's breaker after a receipt that vouches for nothing (design
 * §4.3): `failure` climbs the subject ladder by the row's consecutive failures
 * and blocks it at five (a daily probe); `terminal` ends the subject's due
 * time unless a dirty mark arrived after the claim.
 */
export async function breakFanEarningsSubject(
  tx: Database,
  input: { pageId: number; now: Date; kind: "failure" | "terminal"; claimedRevision: number | null } & FanEarningsSubject,
): Promise<{ failures: number; until: Date | null; blocked: boolean }> {
  const plane = fanEarningsPlane(input.window);
  const current = await tx.execute<{ failures: number; requested: string }>(sql`
    select consecutive_failures as failures, requested_revision::text as requested
      from subject_refresh_state
     where page_id = ${input.pageId} and plane = ${plane} and subject_ref = ${input.fanRef}
     for update
  `);
  const row = current.rows[0];
  if (row === undefined) return { failures: 0, until: null, blocked: false };
  const failures = Math.max(1, Number(row.failures));
  if (input.kind === "terminal") {
    const newerDemand = input.claimedRevision !== null && Number(row.requested) > input.claimedRevision;
    await tx.execute(sql`
      update subject_refresh_state
         set next_due_at = ${newerDemand ? input.now : null}, retry_after_at = null, updated_at = now()
       where page_id = ${input.pageId} and plane = ${plane} and subject_ref = ${input.fanRef}
    `);
    return { failures, until: null, blocked: false };
  }
  const blocked = failures >= SUBJECT_BLOCK_AFTER;
  const step = SUBJECT_BREAKER_LADDER_MS[Math.min(failures, SUBJECT_BREAKER_LADDER_MS.length) - 1]!;
  const until = new Date(input.now.getTime() + (blocked ? Math.max(BLOCKED_PROBE_EVERY_MS, step) : step));
  await tx.execute(sql`
    update subject_refresh_state
       set next_due_at = ${until}, retry_after_at = ${until},
           last_refresh_outcome = case when ${blocked} then 'blocked_by_vendor' else last_refresh_outcome end,
           updated_at = now()
     where page_id = ${input.pageId} and plane = ${plane} and subject_ref = ${input.fanRef}
  `);
  return { failures, until, blocked };
}

interface RosterCursor {
  /** Steps of this walk. */
  steps: number;
}

function parseRosterCursor(value: unknown): RosterCursor {
  const steps = recordOf(value).steps;
  return { steps: typeof steps === "number" && Number.isSafeInteger(steps) && steps >= 0 ? steps : 0 };
}

export const fanEarningsRosterModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const due = await nextDueFanEarningsSubject(ctx.db, { pageId: ctx.pageId, now: ctx.now });
    if (due === null) return { kind: "done", reason: "roster_fresh", cursor: parseRosterCursor(work.cursor) };
    return { kind: "request", request: fanEarningsRequest(due, ctx.now) };
  },

  async onAdmit(tx, work, request) {
    const subject = fanEarningsSubjectOfRequest(request);
    if (subject === null) throw new Error("fan_earnings_request_without_subject");
    // The revision a read answers is the one claimed before it was sent; a
    // dirty mark during the request stays pending (design §5.8).
    const claim = await claimFanEarningsRotation(tx, { pageId: work.pageId, ...subject, now: new Date() });
    if (claim === null) throw new Error("fan_earnings_claim_taken");
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const subject = fanEarningsSubjectOfRequest(input.request);
    if (subject === null) throw new Error("fan_earnings_request_without_subject");
    const claim = await readClaim(tx, { pageId: input.pageId, ...subject });
    const receipt = buildFanEarningsReceipt({
      pageId: input.pageId,
      fanRef: subject.fanRef,
      window: subject.window,
      observationId: input.observation.id,
      payload: input.response,
      checkedAt: input.now,
    });
    const settled = await settleReceipt(tx, claim, receipt);
    let breaker: Awaited<ReturnType<typeof breakFanEarningsSubject>> | null = null;
    if (settled && receipt.outcome !== "observed") {
      breaker = await breakFanEarningsSubject(tx, {
        pageId: input.pageId, now: input.now, kind: "failure", claimedRevision: claim?.revision ?? null, ...subject,
      });
    }
    const cursor = parseRosterCursor(input.work.cursor);
    return {
      work: {
        satisfiesRevision: false,
        nextDueAt: input.now,
        cursor: { steps: cursor.steps + 1 } satisfies RosterCursor,
        result: {
          last: { ...subject, outcome: receipt.outcome, settled, ...(breaker === null ? {} : { breaker }) },
        },
      },
      followups: [],
      counters: settled ? { [`receipt_${receipt.outcome}`]: 1 } : { receipt_unclaimed: 1 },
    };
  },

  async onSubjectOutcome(tx, work, outcome, step) {
    // A breaker reset (an answer after failures) is an `ok`: the apply
    // settles the receipt, never a failed visit.
    if (outcome.kind === "ok") return;
    const subject = fanEarningsSubjectOfRequest(step.request);
    if (subject === null) return;
    const now = new Date();
    const claim = await readClaim(tx, { pageId: work.pageId, ...subject });
    // 400/404/410 is the subject's answer (a durable `rejected` receipt);
    // anything else a failed visit.
    await settleReceipt(tx, claim, {
      outcome: outcome.kind === "terminal" ? "rejected" : "failed",
      observationId: null,
      fingerprint: null,
      checkedAt: now,
    });
    await breakFanEarningsSubject(tx, {
      pageId: work.pageId,
      now,
      kind: outcome.kind === "terminal" ? "terminal" : "failure",
      claimedRevision: claim?.revision ?? null,
      ...subject,
    });
  },
};
