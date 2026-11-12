import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// A fan's account state on a page (0374, `fan-account-state-v1`): what the
// Spenders list and the chat header's fan marks say of a fan's account on ONE
// page, and the two things that keep that answer fresh.
//
//   - The state is one pure function (`fanAccountState`) over the page's own
//     answer (`page_fans.account_probe_*`), when its «not seen» streak began
//     (`account_miss_since`, kept by a trigger), the session-less public check
//     (`fans.public_*`) and, on OnlyFans, the page's contactability.
//   - A chatter's browser reads `GET /account?ids=` through the page's own
//     session and says whether each fan came back (clientFanBadges
//     `accountSeen`). Only a report that DISAGREES with the page's stored
//     answer is kept, on the page link (`account_client_seen*`): a signal,
//     never the page's answer — `account_probe_*` removes a fan from the fan
//     queues and the outreach audiences, so only the page's own read writes it.
//   - The page's periodic re-check (`fan-profiles.recheck`) asks the page
//     about the fans whose answer is due (`listFanslyAccountRecheckDue`).
//
// The chats Fansly stopped serving keep their own cause
// (`chatUnavailabilityCause`, fansly-public-lookup.ts): its wire enum is the
// dashboard's and the agent CLI's, and is not this one.

export const FAN_ACCOUNT_STATES = ["seen", "deleted", "blocked", "unchecked"] as const;
export type FanAccountStateName = (typeof FAN_ACCOUNT_STATES)[number];

/** A fan's account on one page, as the wire carries it (`accountState`). */
export interface FanAccountState {
  /**
   * - `seen`: the page's latest answer returned the account (OnlyFans: any
   *   answer but a gone or blocked account);
   * - `deleted`: the page does not see him, and the public check made after
   *   the streak began found no account (OnlyFans: the account is gone);
   * - `blocked`: the page does not see him, but the account exists — he
   *   blocked the page (OnlyFans: blocked from the page);
   * - `unchecked`: the page does not see him, and no usable public check says
   *   why yet.
   */
  state: FanAccountStateName;
  /** When the page stopped seeing him (the streak's first miss); null when
   *  he is seen or the start is unknown (a streak older than 0374). */
  since: string | null;
  /** When the page's latest answer arrived. */
  checkedAt: string;
}

type Instant = Date | string | null;

/** What the state is read from: the page's link to the fan and the fan row. */
export interface FanAccountStateFacts {
  platform: string;
  accountProbeResolved: boolean | null;
  accountProbeAt: Instant;
  accountMissSince: Instant;
  publicFound: boolean | null;
  publicCheckedAt: Instant;
  accountContactability: string | null;
}

function instant(value: Instant): Date | null {
  if (value === null) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The fan's account state on the page, or null when the page never had an
 * answer for him. Pure.
 *
 * Fansly: a returned account is `seen`. A miss takes its cause from the public
 * check only when that check is usable — made at or after the streak began
 * (any check, when the start is unknown): found → `blocked`, not found →
 * `deleted`; otherwise `unchecked`. OnlyFans: `gone` → `deleted`, `blocked` →
 * `blocked`, any other contactability → `seen` (a row without one: `seen`
 * when the answer returned him, else `unchecked`).
 */
export function fanAccountState(facts: FanAccountStateFacts): FanAccountState | null {
  const checkedAt = instant(facts.accountProbeAt);
  if (checkedAt === null || facts.accountProbeResolved === null) return null;
  const missSince = instant(facts.accountMissSince);
  const answer = (state: FanAccountStateName): FanAccountState => ({
    state,
    since: state === "seen" || missSince === null ? null : missSince.toISOString(),
    checkedAt: checkedAt.toISOString(),
  });

  if (facts.platform === "onlyfans") {
    switch (facts.accountContactability) {
      case "gone":
        return answer("deleted");
      case "blocked":
        return answer("blocked");
      case null:
        return answer(facts.accountProbeResolved ? "seen" : "unchecked");
      default:
        return answer("seen");
    }
  }

  if (facts.accountProbeResolved) return answer("seen");
  const publicCheckedAt = instant(facts.publicCheckedAt);
  const usable = publicCheckedAt !== null
    && facts.publicFound !== null
    && (missSince === null || publicCheckedAt.getTime() >= missSince.getTime());
  if (!usable) return answer("unchecked");
  return answer(facts.publicFound ? "blocked" : "deleted");
}

type StateSqlRow = {
  fanId: string;
  platform: string;
  accountProbeResolved: boolean | null;
  accountProbeAt: Date | string | null;
  accountMissSince: Date | string | null;
  accountContactability: string | null;
  publicFound: boolean | null;
  publicCheckedAt: Date | string | null;
};

/** The account state of each fan on the page, by fan id: null for a fan the
 *  page never answered for; a fan with no link to the page is absent. */
export async function readFanPageAccountStates(
  db: Database,
  input: { pageId: number; fanIds: readonly number[] },
): Promise<Map<number, FanAccountState | null>> {
  const ids = [...new Set(input.fanIds)].map(String);
  if (ids.length === 0) return new Map();
  const result = await db.execute<StateSqlRow>(sql`
    select pf.fan_id::text as "fanId", f.platform,
           pf.account_probe_resolved as "accountProbeResolved", pf.account_probe_at as "accountProbeAt",
           pf.account_miss_since as "accountMissSince", pf.account_contactability as "accountContactability",
           f.public_found as "publicFound", f.public_checked_at as "publicCheckedAt"
      from page_fans pf
      join fans f on f.id = pf.fan_id
     where pf.platform_account_id = ${input.pageId}
       and pf.fan_id = any(${sql.param(ids)}::bigint[])
  `);
  return new Map(result.rows.map((row) => [Number(row.fanId), fanAccountState(row)] as const));
}

// ── a chatter's browser: the signal ─────────────────────────────────────────

/** The page's stored answer and signal on a fan's link (`readFanPageAccountAnswers`). */
export interface FanPageAccountAnswer {
  fanId: number;
  platformUserId: string;
  accountProbeResolved: boolean | null;
  accountProbeAt: Date | null;
  accountClientSeen: boolean | null;
  accountClientSeenAt: Date | null;
}

/**
 * The page links of these fans with the page's answer and the stored browser
 * signal. Every fan linked to the page counts, a fan carrying the legacy
 * deleted mark too (`fans.deleted_detected_at`): a browser that sees him again
 * is exactly what must reach the page's re-check. A fan with no link is absent.
 */
export async function readFanPageAccountAnswers(
  db: Database,
  input: { pageId: number; platform: string; platformUserIds: readonly string[] },
): Promise<FanPageAccountAnswer[]> {
  const refs = [...new Set(input.platformUserIds)];
  if (refs.length === 0) return [];
  const result = await db.execute<{
    fanId: string;
    platformUserId: string;
    accountProbeResolved: boolean | null;
    accountProbeAt: Date | string | null;
    accountClientSeen: boolean | null;
    accountClientSeenAt: Date | string | null;
  }>(sql`
    select f.id::text as "fanId", f.platform_user_id as "platformUserId",
           pf.account_probe_resolved as "accountProbeResolved", pf.account_probe_at as "accountProbeAt",
           pf.account_client_seen as "accountClientSeen", pf.account_client_seen_at as "accountClientSeenAt"
      from fans f
      join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = ${input.pageId}
     where f.platform = ${input.platform}
       and f.platform_user_id = any(${sql.param(refs)}::text[])
     order by f.platform_user_id, f.id
  `);
  return result.rows.map((row) => ({
    fanId: Number(row.fanId),
    platformUserId: row.platformUserId,
    accountProbeResolved: row.accountProbeResolved,
    accountProbeAt: instant(row.accountProbeAt),
    accountClientSeen: row.accountClientSeen,
    accountClientSeenAt: instant(row.accountClientSeenAt),
  }));
}

/** Whether a browser's word disagrees with the page's stored answer: not seen
 *  while the page sees him or never asked, seen while the page does not. Pure. */
export function clientAccountSignalDisagrees(seen: boolean, pageAnswer: boolean | null): boolean {
  return seen ? pageAnswer === false : pageAnswer !== false;
}

/**
 * Whether a browser's word is news for the page link: it disagrees with the
 * page's answer, and the link does not already hold the same word waiting for
 * the page's re-check (a signal newer than the page's answer). A repeated
 * report of a pending signal is nothing — every open board reports its fans
 * every few minutes. Pure.
 */
export function clientAccountSignalIsNews(seen: boolean, link: Omit<FanPageAccountAnswer, "fanId" | "platformUserId">): boolean {
  if (!clientAccountSignalDisagrees(seen, link.accountProbeResolved)) return false;
  const pending = link.accountClientSeen === seen
    && link.accountClientSeenAt !== null
    && (link.accountProbeAt === null || link.accountClientSeenAt.getTime() > link.accountProbeAt.getTime());
  return !pending;
}

/**
 * Keeps the browsers' disagreeing words on the page links (the caller's
 * transaction, after the report is journaled): `account_client_seen` and
 * `account_client_seen_at = at` (Hub's clock: the client's is not trusted). A
 * link whose answer agrees by now (the page answered meanwhile) is left as it
 * is. Never writes the page's answer (`account_probe_*`). Returns how many
 * links were written.
 */
export async function recordFanPageClientAccountSignals(
  db: Database,
  input: { pageId: number; at: Date; signals: ReadonlyArray<{ fanId: number; seen: boolean }> },
): Promise<number> {
  if (input.signals.length === 0) return 0;
  const fanIds = input.signals.map((signal) => String(signal.fanId));
  const seen = input.signals.map((signal) => signal.seen);
  const result = await db.execute(sql`
    update page_fans pf
       set account_client_seen = s.seen,
           account_client_seen_at = ${input.at}
      from unnest(${sql.param(fanIds)}::bigint[], ${sql.param(seen)}::boolean[]) as s(fan_id, seen)
     where pf.platform_account_id = ${input.pageId}
       and pf.fan_id = s.fan_id
       and case when s.seen then pf.account_probe_resolved is false
                else pf.account_probe_resolved is distinct from false end
  `);
  return result.rowCount ?? 0;
}

// ── the page's re-check (`fan-profiles.recheck`) ────────────────────────────

/** Why the page's re-check asks about a fan, in the order it asks. */
export const FANSLY_ACCOUNT_RECHECK_REASONS = ["client_signal", "episode_partner", "payer"] as const;
export type FanslyAccountRecheckReason = (typeof FANSLY_ACCOUNT_RECHECK_REASONS)[number];

/** A paying fan's page answer is due again once it is this old. */
export const FANSLY_ACCOUNT_RECHECK_PAYER_AFTER_MS = 72 * 60 * 60_000;

export interface FanslyAccountRecheckCandidate {
  platformUserId: string;
  reason: FanslyAccountRecheckReason;
}

/**
 * The fans whose answer through the page is due, derived from the database at
 * every pass (a restart or a reason that arrives while a request is in flight
 * loses nothing), at most `limit`, each once, in this order, the oldest first
 * within each reason:
 *
 * 1. `client_signal` — a browser's disagreeing word newer than the page's
 *    answer, or with no answer (the oldest word first);
 * 2. `episode_partner` — the partner of an OPEN unavailability episode of the
 *    page's chats (from its first refusal, paying or not) whose page answer is
 *    absent or older than the episode's opening (the oldest episode first).
 *    Only a partner linked to the page: the answer is kept on the link, so one
 *    without it could never be settled and would be asked at every pass;
 * 3. `payer` — a fan who paid the page (`total_creator_net_mills > 0`) whose
 *    page answer is absent or older than 72 hours, a gone one too (never asked
 *    first, then the oldest answer).
 *
 * The answer that settles a fan is the one that arrived after his reason:
 * `account_probe_at` is the answer's arrival. Only Fansly ids (digits). Plain
 * read.
 */
export async function listFanslyAccountRecheckDue(
  db: Database,
  input: { pageId: number; now: Date; limit: number },
): Promise<FanslyAccountRecheckCandidate[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error(`limit must be a positive integer (${input.limit})`);
  const payersBefore = new Date(input.now.getTime() - FANSLY_ACCOUNT_RECHECK_PAYER_AFTER_MS);
  const result = await db.execute<{ platformUserId: string; priority: number }>(sql`
    with due as (
      select f.platform_user_id as id, 0 as priority, pf.account_client_seen_at as since
        from page_fans pf
        join fans f on f.id = pf.fan_id
       where pf.platform_account_id = ${input.pageId}
         and pf.account_client_seen_at is not null
         and (pf.account_probe_at is null or pf.account_client_seen_at > pf.account_probe_at)
      union all
      select f.platform_user_id, 1, e.opened_at
        from page_dm_thread_unavailability e
        join page_dm_threads t on t.id = e.thread_id
        join page_fans pf on pf.platform_account_id = t.platform_account_id and pf.fan_id = t.fan_id
        join fans f on f.id = pf.fan_id
       where t.platform_account_id = ${input.pageId}
         and e.ended_at is null
         and (pf.account_probe_at is null or pf.account_probe_at < e.opened_at)
      union all
      select f.platform_user_id, 2, pf.account_probe_at
        from page_fans pf
        join fans f on f.id = pf.fan_id
       where pf.platform_account_id = ${input.pageId}
         and pf.total_creator_net_mills > 0
         and (pf.account_probe_at is null or pf.account_probe_at < ${payersBefore}::timestamptz)
    ), picked as (
      select d.id, d.priority, d.since,
             row_number() over (partition by d.id order by d.priority, d.since nulls first) as nth
        from due d
       where d.id ~ '^[0-9]{1,30}$'
    )
    select p.id as "platformUserId", p.priority
      from picked p
     where p.nth = 1
     order by p.priority, p.since nulls first, p.id
     limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    platformUserId: row.platformUserId,
    reason: FANSLY_ACCOUNT_RECHECK_REASONS[Number(row.priority)]!,
  }));
}
