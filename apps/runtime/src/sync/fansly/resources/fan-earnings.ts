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

import { parseFanslyEarningsObservation } from "../../../services/canonicalize/fansly-earnings.ts";
import { buildFanEarningsReceipt } from "../../../services/sync/fan-earnings-receipt.ts";
import { BLOCKED_PROBE_EVERY_MS, SUBJECT_BLOCK_AFTER, SUBJECT_BREAKER_LADDER_MS } from "../../engine/errors.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  ReplayContext,
  ReplayObservation,
  ReplayVerdict,
  RequestPlan,
  ResourceModule,
  ShadowResult,
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
//
// Shadow writes nothing: no claim, no receipt. A shadow pass walks the due
// subjects once in (fan, window) order through a keyset in its cursor; a full
// pass at most once a day, an incremental one over the subjects marked dirty
// since the previous pass (the legacy writer keeps marking them).

export const FAN_EARNINGS_ROSTER_KEY = "fan-earnings.roster";

const HOUR_MS = 3_600_000;
/** The roster age (registry parameter; the production owner setting
 *  `fanslyFanEarningsRosterMaxAgeHours` = 156): a spender is read again this
 *  long after its last read. */
export const FAN_EARNINGS_ROSTER_MAX_AGE_MS = 156 * HOUR_MS;
/** A full shadow pass over the due roster at most this often (the entry's
 *  cadence). */
export const FAN_EARNINGS_SHADOW_PASS_EVERY_MS = 24 * HOUR_MS;

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

function subjectOf(value: unknown): FanEarningsSubject | null {
  const record = recordOf(value);
  const window = windowOf(record.window);
  return typeof record.fanRef === "string" && record.fanRef.length > 0 && window !== null
    ? { fanRef: record.fanRef, window }
    : null;
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
 * The next due subject of the page (read-only). `priority`: marked due first
 * (by due time), then never read, then the oldest read. `keyset`: (fan,
 * window) order after `after`; with `since`, only the subjects marked due
 * after that instant (a shadow pass over new dirty marks).
 */
export async function nextDueFanEarningsSubject(
  db: Database,
  input: {
    pageId: number;
    now: Date;
    maxAgeMs?: number;
    order: "priority" | "keyset";
    after?: FanEarningsSubject | null;
    since?: Date | null;
  },
): Promise<DueFanEarningsSubject | null> {
  const now = input.now;
  const ageCutoff = new Date(now.getTime() - (input.maxAgeMs ?? FAN_EARNINGS_ROSTER_MAX_AGE_MS));
  const since = input.since ?? null;
  const after = input.after ?? null;
  const keyset = input.order === "keyset" && after !== null
    ? sql`where (fan_ref, window_name) > (${after.fanRef}, ${after.window})`
    : sql``;
  const order = input.order === "priority"
    ? sql`order by rank, at nulls first, fan_ref, window_name`
    : sql`order by fan_ref, window_name`;
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
         and (${since}::timestamptz is null or s.next_due_at > ${since}::timestamptz)
         and (s.claim_token is null or s.claim_expires_at <= ${now})
         and (s.retry_after_at is null or s.retry_after_at <= ${now})
      union all
      select r.fan_ref, p.window_name, case when s.last_visited_at is null then 1 else 2 end, s.last_visited_at
        from roster r
       cross join planes p
        left join subject_refresh_state s
          on s.page_id = ${input.pageId} and s.plane = p.plane and s.subject_ref = r.fan_ref
       where ${since}::timestamptz is null
         and (s.subject_ref is null or (
               (s.last_visited_at is null or s.last_visited_at <= ${ageCutoff})
           and (s.claim_token is null or s.claim_expires_at <= ${now})
           and (s.retry_after_at is null or s.retry_after_at <= ${now})))
    ), ranked as (
      select fan_ref, window_name, min(rank) as rank, min(at) as at
        from due
       group by fan_ref, window_name
    )
    select fan_ref as "fanRef", window_name as "window", rank::int as rank
      from ranked
      ${keyset}
      ${order}
     limit 1
  `);
  const row = result.rows[0];
  const window = windowOf(row?.window);
  return row === undefined || window === null ? null : { fanRef: row.fanRef, window, rank: Number(row.rank) };
}

/** When the newest shadow roster pass of the page closed; `open` when one runs. */
async function lastShadowPass(db: Database, pageId: number): Promise<{ open: boolean; closedAt: Date | null }> {
  const result = await db.execute<{ open: boolean; closedAt: Date | string | null }>(sql`
    select bool_or(closed_at is null) as open, max(closed_at) as "closedAt"
      from sync_work
     where page_id = ${pageId} and shadow and resource = ${FAN_EARNINGS_ROSTER_KEY}
  `);
  const row = result.rows[0];
  return { open: row?.open === true, closedAt: row?.closedAt ? new Date(row.closedAt) : null };
}

/**
 * The roster walk a page needs now (a follow-up of the transactions steps,
 * which run at least every five minutes): live, whenever a subject is due;
 * shadow, a full pass a day, else a pass over the subjects marked dirty since
 * the previous one.
 */
export async function fanEarningsRosterFollowups(
  db: Database,
  input: { pageId: number; now: Date; shadow: boolean; reason: string },
): Promise<DemandSignal[]> {
  if (!input.shadow) {
    const due = await nextDueFanEarningsSubject(db, { pageId: input.pageId, now: input.now, order: "priority" });
    return due === null ? [] : [{ resource: FAN_EARNINGS_ROSTER_KEY, demand: { reason: input.reason } }];
  }
  const pass = await lastShadowPass(db, input.pageId);
  if (pass.open) return [];
  const full = pass.closedAt === null || input.now.getTime() - pass.closedAt.getTime() >= FAN_EARNINGS_SHADOW_PASS_EVERY_MS;
  const since = full ? null : pass.closedAt;
  const due = await nextDueFanEarningsSubject(db, { pageId: input.pageId, now: input.now, order: "keyset", since });
  if (due === null) return [];
  return [{
    resource: FAN_EARNINGS_ROSTER_KEY,
    demand: { reason: input.reason },
    params: { shadowSince: since === null ? null : since.toISOString() },
  }];
}

/**
 * When the transactions steps of the page next ask for a roster walk, the
 * queue as it stands at `at` (read-only; the shadow report, rule
 * A1.floor-queue): the earliest instant `fanEarningsRosterFollowups` finds a
 * subject due — a mark or retry at its `next_due_at`, a spender of the page
 * never read at once, one read before at its last read + the roster age, each
 * no earlier than its open claim or retry hold. Shadow also keeps its pass
 * rhythm: while a pass runs, at once; within a day of the last pass, a mark
 * newer than it at its time and everything else when the day is over. Null:
 * no subject comes due without a new write.
 */
export async function fanEarningsRosterNextDueAt(
  db: Database,
  input: { pageId: number; at: Date; shadow: boolean; maxAgeMs?: number },
): Promise<Date | null> {
  const at = input.at;
  let passClosedAt: Date | null = null;
  if (input.shadow) {
    const pass = await db.execute<{ open: boolean; closedAt: Date | string | null }>(sql`
      select bool_or(closed_at is null or closed_at > ${at}) as open, max(closed_at) filter (where closed_at <= ${at}) as "closedAt"
        from sync_work
       where page_id = ${input.pageId} and shadow and resource = ${FAN_EARNINGS_ROSTER_KEY} and created_at <= ${at}
    `);
    const row = pass.rows[0];
    if (row?.open === true) return at;
    const closedAt = row?.closedAt ? new Date(row.closedAt) : null;
    passClosedAt = closedAt !== null && at.getTime() - closedAt.getTime() < FAN_EARNINGS_SHADOW_PASS_EVERY_MS ? closedAt : null;
  }
  const fullFrom = passClosedAt === null ? null : new Date(passClosedAt.getTime() + FAN_EARNINGS_SHADOW_PASS_EVERY_MS);
  const ageMs = input.maxAgeMs ?? FAN_EARNINGS_ROSTER_MAX_AGE_MS;
  const result = await db.execute<{ dueAt: Date | string | null }>(sql`
    with planes(plane) as (
      values ('fan_earnings_lifetime'), ('fan_earnings_monthly')
    ), roster as (
      select f.platform_user_id as fan_ref
        from page_fans pf
        join fans f on f.id = pf.fan_id
       where pf.platform_account_id = ${input.pageId}
         and pf.total_creator_net_mills > 0
    ), subjects as (
      -- Each spender of the page in both windows (never read: due at once).
      select s.next_due_at as marked,
             coalesce(s.last_visited_at + make_interval(secs => ${ageMs / 1000}), '-infinity'::timestamptz) as aged,
             greatest(case when s.claim_token is not null then s.claim_expires_at end, s.retry_after_at) as held
        from roster r
       cross join planes p
        left join subject_refresh_state s
          on s.page_id = ${input.pageId} and s.plane = p.plane and s.subject_ref = r.fan_ref
      union all
      -- Marks and retries of subjects that are no spender (any more).
      select s.next_due_at, null,
             greatest(case when s.claim_token is not null then s.claim_expires_at end, s.retry_after_at)
        from subject_refresh_state s
        join planes p on p.plane = s.plane
       where s.page_id = ${input.pageId}
         and s.next_due_at is not null
         and not exists (select 1 from roster r where r.fan_ref = s.subject_ref)
    ), due as (
      select case
               when ${fullFrom}::timestamptz is null then greatest(least(marked, aged), held)
               else least(
                 -- the pass over the marks newer than the last pass
                 case when marked > ${passClosedAt}::timestamptz then greatest(marked, held) end,
                 -- the next full pass
                 greatest(least(marked, aged), held, ${fullFrom}::timestamptz))
             end as due_at
        from subjects
    )
    select min(due_at) as "dueAt" from due where due_at is not null
  `);
  const raw = result.rows[0]?.dueAt ?? null;
  if (raw === null) return null;
  const dueAt = raw instanceof Date ? raw : new Date(raw);
  // '-infinity' (a spender never read): due at once.
  return Number.isFinite(dueAt.getTime()) ? dueAt : at;
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
  /** Shadow: the keyset of the subjects already simulated in this pass. */
  shadowAfter: FanEarningsSubject | null;
  /** Steps of this pass. */
  steps: number;
}

function parseRosterCursor(value: unknown): RosterCursor {
  const record = recordOf(value);
  const steps = record.steps;
  return {
    shadowAfter: subjectOf(record.shadowAfter),
    steps: typeof steps === "number" && Number.isSafeInteger(steps) && steps >= 0 ? steps : 0,
  };
}

function shadowSinceOf(params: unknown): Date | null {
  const raw = recordOf(params).shadowSince;
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

export const fanEarningsRosterModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseRosterCursor(work.cursor);
    const due = ctx.shadow
      ? await nextDueFanEarningsSubject(ctx.db, {
        pageId: ctx.pageId,
        now: ctx.now,
        order: "keyset",
        after: cursor.shadowAfter,
        since: shadowSinceOf(work.params),
      })
      : await nextDueFanEarningsSubject(ctx.db, { pageId: ctx.pageId, now: ctx.now, order: "priority" });
    if (due === null) {
      return { kind: "done", reason: ctx.shadow ? "shadow" : "roster_fresh", cursor: { shadowAfter: null, steps: cursor.steps } };
    }
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
        cursor: { ...cursor, steps: cursor.steps + 1 },
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

  async shadow(work, request, ctx): Promise<ShadowResult> {
    const subject = fanEarningsSubjectOfRequest(request);
    const cursor = parseRosterCursor(work.cursor);
    return {
      work: {
        satisfiesRevision: false,
        nextDueAt: ctx.now,
        cursor: { shadowAfter: subject ?? cursor.shadowAfter, steps: cursor.steps + 1 } satisfies RosterCursor,
      },
      followups: [],
    };
  },

  async queueNextDueAt(ctx) {
    return fanEarningsRosterNextDueAt(ctx.db, { pageId: ctx.pageId, at: ctx.now, shadow: true });
  },

  replay: replayFanEarnings,
};

/**
 * Replay of a legacy `fan_earnings_stats` / `fan_earnings_monthly`
 * observation (design §5.8): the receipt the engine would build from it has
 * the fingerprint legacy stored for that observation, or legacy has checked
 * the subject again since.
 */
async function replayFanEarnings(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
  const window: FanEarningsWindow = observation.kind === "fan_earnings_monthly" ? "monthly" : "lifetime";
  const parsed = parseFanslyEarningsObservation({
    id: observation.id,
    source: "pull",
    producer: "sync:fansly:fan_earnings",
    platform: "fansly",
    accountId: ctx.pageId,
    kind: observation.kind,
    payload: observation.payload,
    observedAt: observation.receivedAt,
    receivedAt: observation.receivedAt,
  });
  const fans = [...new Set(parsed.events.map((event) => event.fanIdentityRef).filter((ref): ref is string => typeof ref === "string"))];
  if (fans.length === 0) {
    return { kind: "not_replayable", reason: parsed.rejection === null ? "no_rows" : `rejected:${parsed.rejection.code}` };
  }
  if (fans.length > 1) return { kind: "mismatch", reason: "several_fans", detail: { fans: fans.length } };
  const fanRef = fans[0]!;
  const receipt = buildFanEarningsReceipt({
    pageId: ctx.pageId,
    fanRef,
    window,
    observationId: observation.id,
    payload: observation.payload,
    checkedAt: observation.receivedAt,
  });
  const stored = await ctx.db.execute<{ fingerprint: string | null; checkedObservationId: string | null }>(sql`
    select last_content_fingerprint as fingerprint, last_checked_observation_id::text as "checkedObservationId"
      from subject_refresh_state
     where page_id = ${ctx.pageId} and plane = ${fanEarningsPlane(window)} and subject_ref = ${fanRef}
  `);
  const row = stored.rows[0];
  if (row === undefined || row.checkedObservationId === null) return { kind: "mismatch", reason: "no_receipt", detail: { fanRef } };
  const checked = Number(row.checkedObservationId);
  if (checked > observation.id) return { kind: "match", detail: { laterReceipt: true } };
  if (checked === observation.id && row.fingerprint === receipt.fingerprint) return { kind: "match", detail: { outcome: receipt.outcome } };
  return { kind: "mismatch", reason: checked === observation.id ? "fingerprint_differs" : "receipt_older", detail: { fanRef, outcome: receipt.outcome } };
}
