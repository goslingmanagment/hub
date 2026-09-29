// J7 — the one-off repair for `platform_notifications` rows frozen at their
// first look (`fansly:notifications-replay-read-state`).
//
// Until J7 the head guard compared the provider instant alone. The platform
// serves a notification unread and then read at the SAME `createdAt`, so the
// read look never won: the canonicalizer appended it to the ledger (the ack is
// part of its hash and dedup key), and the projector consumed it and threw it
// away — `acknowledged_at` stayed NULL. The guard now lets the later look win
// the tie, but only for looks projected from then on: a row first seen unread
// and never looked at again keeps its stale head, although the read look sits
// in the ledger below the projector's watermark (2,593 rows on six pages in
// production on 2026-09-28).
//
// This replays exactly those looks: `notification.observed` events at or below
// the page's `fansly_engagement` watermark, observed at or after the head's
// latest look, that are not the head's own event, through the SAME parser and
// the SAME guarded upsert the projector uses. The guard decides; nothing here
// writes a column itself. Events above the watermark are the live projector's.
//
// NOT `projection:rebuild fansly_engagement`: a rebuild replays every event
// type, so it re-applies every historical `media.purchase_notification_observed`
// and marks purchased media due in `subject_refresh_state` — media_stats
// traffic for a fix that only concerns read state. This touches
// `platform_notifications` and nothing else.
//
// Owner-run, never scheduled: dry-run is the DEFAULT and is provably read-only
// (one READ ONLY transaction); `--execute` opts in; a re-run reports zeros. It
// makes no platform call.

import { sql } from "drizzle-orm";

import {
  isPlatformNotificationErasureFenced,
  upsertPlatformNotification,
  type Database,
  type EngagementPlatform,
  type UpsertPlatformNotificationInput,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  FANSLY_ENGAGEMENT_PROJECTION,
  platformNotificationInputFromEvent,
} from "./projections/fansly-engagement.ts";

export interface NotificationReadStateReplayOptions {
  /** Default true: count what WOULD change, write nothing. */
  dryRun?: boolean;
  /** Restrict to one internal page id. */
  accountId?: number | null;
}

export interface NotificationReadStatePageCount {
  pageId: number;
  /** Later looks replayed (dry-run: that would be). */
  events: number;
  /** Rows whose head moves to a later look. */
  heads: number;
  /** Of those, rows whose `acknowledged_at` goes from NULL to the read instant. */
  acknowledged: number;
  /** Of those, rows whose `acknowledged_at` goes back to NULL (the platform
   *  served the later look unread). */
  unacknowledged: number;
}

export interface NotificationReadStateReplayResult {
  dryRun: boolean;
  /** Pages with at least one event to replay; others are absent. */
  pages: NotificationReadStatePageCount[];
  events: number;
  heads: number;
  acknowledged: number;
  unacknowledged: number;
  /** Upserts the erasure writer fence deferred (an erasure is running):
   *  re-run. Execute only. */
  deferred: number;
  /** Upserts the erasure scope fence refused (dry-run: would refuse) —
   *  correct, and final. */
  erasureFenced: number;
}

interface HeadState {
  occurredAt: Date;
  lastObservedAt: Date;
  acknowledgedAt: Date | null;
  sourceEventId: number;
}

interface Candidate {
  notificationRef: string;
  head: HeadState;
  input: UpsertPlatformNotificationInput;
}

interface ReplayPage {
  pageId: number;
  platform: EngagementPlatform;
  throughSeq: number;
}

async function listReplayPages(db: Database, accountId: number | null): Promise<ReplayPage[]> {
  const result = await db.execute<{ account_id: string; high_seq: string; platform: string }>(sql`
    select w.account_id::text as account_id, w.high_seq::text as high_seq, p.platform
    from projection_seq_watermarks w
    join pages p on p.id = w.account_id
    where w.projection = ${FANSLY_ENGAGEMENT_PROJECTION}
      and p.platform in ('fansly', 'onlyfans')
      ${accountId === null ? sql`` : sql`and w.account_id = ${accountId}`}
    order by w.account_id
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.account_id),
    platform: row.platform as EngagementPlatform,
    throughSeq: Number(row.high_seq),
  }));
}

interface LookRow extends Record<string, unknown> {
  id: string;
  account_seq: string;
  occurred_at: Date | string;
  observation_id: string;
  data: unknown;
  head_occurred_at: Date | string;
  head_last_observed_at: Date | string;
  head_acknowledged_at: Date | string | null;
  head_source_event_id: string;
  head_ref: string;
}

const LOOK_COLUMNS = sql`
  e.id::text as id, e.account_seq::text as account_seq, e.occurred_at,
  e.observation_id::text as observation_id, e.data,
  n.occurred_at as head_occurred_at,
  n.last_observed_at as head_last_observed_at,
  n.acknowledged_at as head_acknowledged_at,
  n.source_event_id::text as head_source_event_id,
  n.notification_ref as head_ref
`;

function parseLook(page: ReplayPage, row: LookRow): Candidate | null {
  const input = platformNotificationInputFromEvent(page.pageId, page.platform, {
    id: Number(row.id),
    accountSeq: Number(row.account_seq),
    occurredAt: new Date(row.occurred_at),
    observationId: Number(row.observation_id),
    data: row.data,
  });
  if (input === null) {
    return null;
  }
  return {
    notificationRef: input.notificationRef,
    head: {
      occurredAt: new Date(row.head_occurred_at),
      lastObservedAt: new Date(row.head_last_observed_at),
      acknowledgedAt: row.head_acknowledged_at === null ? null : new Date(row.head_acknowledged_at),
      sourceEventId: Number(row.head_source_event_id),
    },
    input,
  };
}

/**
 * The looks the old guard discarded, in ledger order. `occurred_at >=
 * last_observed_at` is the tie branch of the guard: the row's last look is the
 * newest look ever projected for it, so only a look at that instant can still
 * win, and only when it is not already the head. The provider-instant half of
 * the guard is left to the upsert (and mirrored by the dry-run).
 *
 * One exclusion keeps a re-run at zero: a look that ties the head's own event
 * exactly (same `createdAt`, same look instant) and precedes it in the ledger
 * already lost to it under the fixed guard too — a projector replay applies
 * the head after it. Replaying it alone would hand it the head, and the next
 * run would hand the head back.
 */
async function listCandidates(db: Database, page: ReplayPage): Promise<Candidate[]> {
  const later = await db.execute<LookRow>(sql`
    select ${LOOK_COLUMNS}
    from domain_events e
    join platform_notifications n
      on n.page_id = e.account_id
     and n.notification_ref = e.data->>'notificationRef'
    where e.account_id = ${page.pageId}
      and e.type = 'notification.observed'
      and e.account_seq <= ${page.throughSeq}
      and e.id <> n.source_event_id
      and e.occurred_at >= n.last_observed_at
    order by e.account_seq
  `);
  if (later.rows.length === 0) {
    return [];
  }
  const refs = [...new Set(later.rows.map((row) => row.head_ref))];
  // The heads' own events, where they sit at the same look instant.
  const heads = await db.execute<LookRow>(sql`
    select ${LOOK_COLUMNS}
    from platform_notifications n
    join domain_events e
      on e.id = n.source_event_id
     and e.account_id = n.page_id
     and e.occurred_at >= n.last_observed_at
    where n.page_id = ${page.pageId}
      and n.notification_ref in (${sql.join(refs.map((ref) => sql`${ref}`), sql`, `)})
  `);
  const headLooks = new Map<string, Candidate>();
  for (const row of heads.rows) {
    const look = parseLook(page, row);
    if (look !== null) {
      headLooks.set(look.notificationRef, look);
    }
  }

  const candidates: Candidate[] = [];
  for (const row of later.rows) {
    const look = parseLook(page, row);
    if (look === null) {
      continue;
    }
    const head = headLooks.get(look.notificationRef);
    if (
      head !== undefined
      && look.input.sourceAccountSeq < head.input.sourceAccountSeq
      && look.input.occurredAt.getTime() === head.input.occurredAt.getTime()
      && look.input.observedAt.getTime() === head.input.observedAt.getTime()
    ) {
      continue;
    }
    candidates.push(look);
  }
  return candidates;
}

/** `upsertPlatformNotificationUnfenced`'s guard, for the dry-run only. The
 *  execute path never consults it — the upsert decides. */
function laterLookWins(head: HeadState, input: UpsertPlatformNotificationInput): boolean {
  const provider = input.occurredAt.getTime();
  const current = head.occurredAt.getTime();
  return provider > current
    || (provider === current && input.observedAt.getTime() >= head.lastObservedAt.getTime());
}

async function simulate(
  db: Database,
  candidates: Candidate[],
  result: NotificationReadStateReplayResult,
): Promise<Map<string, HeadState>> {
  const heads = new Map<string, HeadState>();
  for (const candidate of candidates) {
    const head = heads.get(candidate.notificationRef) ?? { ...candidate.head };
    heads.set(candidate.notificationRef, head);
    if (await isPlatformNotificationErasureFenced(db, candidate.input)) {
      result.erasureFenced += 1;
      continue;
    }
    if (laterLookWins(head, candidate.input)) {
      head.occurredAt = candidate.input.occurredAt;
      head.acknowledgedAt = candidate.input.acknowledgedAt;
      head.sourceEventId = candidate.input.sourceEventId;
    }
    if (candidate.input.observedAt > head.lastObservedAt) {
      head.lastObservedAt = candidate.input.observedAt;
    }
  }
  return heads;
}

async function readHeads(
  db: Database,
  pageId: number,
  refs: string[],
): Promise<Map<string, Pick<HeadState, "acknowledgedAt" | "sourceEventId">>> {
  const result = await db.execute<{
    notification_ref: string;
    acknowledged_at: Date | string | null;
    source_event_id: string;
  }>(sql`
    select notification_ref, acknowledged_at, source_event_id::text as source_event_id
    from platform_notifications
    where page_id = ${pageId}
      and notification_ref in (${sql.join(refs.map((ref) => sql`${ref}`), sql`, `)})
  `);
  return new Map(result.rows.map((row) => [row.notification_ref, {
    acknowledgedAt: row.acknowledged_at === null ? null : new Date(row.acknowledged_at),
    sourceEventId: Number(row.source_event_id),
  }]));
}

async function replayPass(
  db: Database,
  options: { dryRun: boolean; accountId: number | null },
): Promise<NotificationReadStateReplayResult> {
  const result: NotificationReadStateReplayResult = {
    dryRun: options.dryRun,
    pages: [],
    events: 0,
    heads: 0,
    acknowledged: 0,
    unacknowledged: 0,
    deferred: 0,
    erasureFenced: 0,
  };

  for (const page of await listReplayPages(db, options.accountId)) {
    const candidates = await listCandidates(db, page);
    if (candidates.length === 0) {
      continue;
    }
    const before = new Map<string, HeadState>();
    for (const candidate of candidates) {
      if (!before.has(candidate.notificationRef)) {
        before.set(candidate.notificationRef, candidate.head);
      }
    }

    let after: Map<string, Pick<HeadState, "acknowledgedAt" | "sourceEventId">>;
    if (options.dryRun) {
      after = await simulate(db, candidates, result);
    } else {
      // Ledger order, one guarded upsert per event — the projector's own path.
      for (const candidate of candidates) {
        const outcome = await upsertPlatformNotification(db, candidate.input);
        if (outcome.status === "deferred") {
          result.deferred += 1;
        } else if (outcome.status === "erasure_fenced") {
          result.erasureFenced += 1;
        }
      }
      after = await readHeads(db, page.pageId, [...before.keys()]);
    }

    const count: NotificationReadStatePageCount = {
      pageId: page.pageId,
      events: candidates.length,
      heads: 0,
      acknowledged: 0,
      unacknowledged: 0,
    };
    for (const [ref, head] of before) {
      const now = after.get(ref);
      if (now === undefined || now.sourceEventId === head.sourceEventId) {
        continue;
      }
      count.heads += 1;
      if (head.acknowledgedAt === null && now.acknowledgedAt !== null) {
        count.acknowledged += 1;
      } else if (head.acknowledgedAt !== null && now.acknowledgedAt === null) {
        count.unacknowledged += 1;
      }
    }
    result.pages.push(count);
    result.events += count.events;
    result.heads += count.heads;
    result.acknowledged += count.acknowledged;
    result.unacknowledged += count.unacknowledged;
  }
  return result;
}

export async function runNotificationReadStateReplay(
  app: Pick<AppContext, "db" | "logger">,
  options: NotificationReadStateReplayOptions = {},
): Promise<NotificationReadStateReplayResult> {
  const dryRun = options.dryRun !== false;
  const pass = { dryRun, accountId: options.accountId ?? null };
  if (dryRun) {
    return app.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return replayPass(tx as unknown as Database, pass);
    });
  }
  const result = await replayPass(app.db as Database, pass);
  app.logger.info(result, "Fansly notification read state replayed");
  return result;
}
