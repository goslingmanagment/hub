// H2 (INC-001) — the one-off PPV PURCHASE backfill for rows that existed
// before purchases reached every hub store.
//
// Until H2 a purchase landed only in page_dm_messages.purchased_at: the
// event-fed message_archive treated message.ppv_unlocked as a no-op and the OF
// material head (dm_message_archive.is_opened) never heard of it, so both
// archives — and every reader overlaying them (the desktop snapshot serves the
// dm_message_archive row in preference to the hot one) — kept showing bought
// PPVs as unbought. New purchases now reach all three stores live
// (ofapi-dm-projection.ts, message-archive projection); this command heals the
// history.
//
// A purchase FACT is (page, OnlyFans message id) named by either
//   * a non-superseded message.ppv_unlocked event with a message ref, or
//   * a hot row with purchased_at set.
// For each fact: the hot row gets purchased_at (from the earliest event) when
// it lacks one; message_archive and dm_message_archive get is_opened = TRUE.
// Every write is monotonic (only ever toward "bought") and conditional on the
// row not already saying so, so a re-run changes nothing and reports zeros.
// Nothing is inserted: a fact whose message no store holds stays a fact in the
// ledger/journal only. OnlyFans pages only — Fansly unlocks carry no message
// ref (order identity) and have no dm_message_archive.
//
// Dry-run is the DEFAULT and is provably read-only: it runs inside a READ ONLY
// transaction, so any write attempt would fail rather than happen. No OFAPI
// call anywhere — this reads the hub's own tables.

import { sql, type SQL } from "drizzle-orm";

import {
  applyDmMessagePurchaseFact,
  domainEventNotSupersededSql,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

export interface PpvPurchaseBackfillOptions {
  /** Default true: count what WOULD change, write nothing. */
  dryRun?: boolean;
  /** Restrict to one internal page id. */
  accountId?: number | null;
}

export interface PpvPurchaseBackfillResult {
  dryRun: boolean;
  /** Distinct (page, message) purchase facts in scope. */
  facts: number;
  /** Hot rows whose purchased_at was (or would be) filled from a PPV event. */
  hotPurchasedMarked: number;
  /** message_archive rows moved (or that would move) to is_opened = TRUE. */
  messageArchiveOpened: number;
  /** dm_message_archive rows moved (or that would move) to is_opened = TRUE. */
  dmArchiveOpened: number;
}

/** Earliest non-superseded unlock per (page, message) — the hot purchased_at source. */
function ppvEventsCte(accountId: number | null): SQL {
  const accountFilter = accountId === null ? sql`` : sql`and de.account_id = ${accountId}`;
  return sql`
    ppv as (
      select de.account_id, de.message_ref, min(de.occurred_at) as purchased_at
      from domain_events de
      join pages p on p.id = de.account_id and p.platform = 'onlyfans'
      where de.type = 'message.ppv_unlocked'
        and de.message_ref is not null
        and ${domainEventNotSupersededSql("de")}
        ${accountFilter}
      group by de.account_id, de.message_ref
    )`;
}

/** Every purchase fact: unlock events ∪ hot purchases. */
function factsCte(accountId: number | null): SQL {
  const hotFilter = accountId === null ? sql`` : sql`and m.platform_account_id = ${accountId}`;
  return sql`
    ${ppvEventsCte(accountId)},
    facts as (
      select account_id, message_ref from ppv
      union
      select m.platform_account_id, m.platform_message_id
      from page_dm_messages m
      join pages p on p.id = m.platform_account_id and p.platform = 'onlyfans'
      where m.purchased_at is not null and m.deleted_at is null
        ${hotFilter}
    )`;
}

async function countOf(db: Database, query: SQL): Promise<number> {
  const result = await db.execute<{ n: string }>(query);
  return Number(result.rows[0]?.n ?? 0);
}

interface DmCandidateRow extends Record<string, unknown> {
  ofapi_account_id: string;
  platform_message_id: string;
}

async function listDmArchiveCandidates(
  db: Database,
  accountId: number | null,
): Promise<DmCandidateRow[]> {
  const result = await db.execute<DmCandidateRow>(sql`
    with ${factsCte(accountId)}
    select d.ofapi_account_id, d.platform_message_id
    from dm_message_archive d
    join facts f on f.account_id = d.platform_account_id
      and f.message_ref = d.platform_message_id
    where d.platform = 'onlyfans'
      and d.is_opened is distinct from true
    order by d.id
  `);
  return result.rows;
}

async function countEverything(
  db: Database,
  accountId: number | null,
): Promise<Omit<PpvPurchaseBackfillResult, "dryRun">> {
  return {
    facts: await countOf(db, sql`with ${factsCte(accountId)} select count(*)::text as n from facts`),
    hotPurchasedMarked: await countOf(db, sql`
      with ${ppvEventsCte(accountId)}
      select count(*)::text as n
      from page_dm_messages m
      join ppv on ppv.account_id = m.platform_account_id and ppv.message_ref = m.platform_message_id
      where m.purchased_at is null and m.deleted_at is null
    `),
    messageArchiveOpened: await countOf(db, sql`
      with ${factsCte(accountId)}
      select count(*)::text as n
      from message_archive ma
      join facts f on f.account_id = ma.account_id and f.message_ref = ma.message_ref
      where ma.platform = 'onlyfans' and ma.is_opened is distinct from true
    `),
    dmArchiveOpened: (await listDmArchiveCandidates(db, accountId)).length,
  };
}

export async function runPpvPurchaseBackfill(
  app: Pick<AppContext, "db" | "logger">,
  options: PpvPurchaseBackfillOptions = {},
): Promise<PpvPurchaseBackfillResult> {
  const dryRun = options.dryRun !== false;
  const accountId = options.accountId ?? null;

  if (dryRun) {
    const counts = await app.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return countEverything(tx as unknown as Database, accountId);
    });
    return { dryRun, ...counts };
  }

  const db = app.db as Database;
  // Hot first: its purchased_at is itself a fact source for the archives.
  const hotPurchasedMarked = await countOf(db, sql`
    with ${ppvEventsCte(accountId)},
    marked as (
      update page_dm_messages m set purchased_at = ppv.purchased_at
      from ppv
      where ppv.account_id = m.platform_account_id
        and ppv.message_ref = m.platform_message_id
        and m.purchased_at is null
        and m.deleted_at is null
      returning 1
    )
    select count(*)::text as n from marked
  `);
  const facts = await countOf(db, sql`with ${factsCte(accountId)} select count(*)::text as n from facts`);
  const messageArchiveOpened = await countOf(db, sql`
    with ${factsCte(accountId)},
    opened as (
      update message_archive ma set is_opened = true, updated_at = now()
      from facts f
      where f.account_id = ma.account_id
        and f.message_ref = ma.message_ref
        and ma.platform = 'onlyfans'
        and ma.is_opened is distinct from true
      returning 1
    )
    select count(*)::text as n from opened
  `);
  // The material head goes row by row through the same writer the live
  // projection uses: it owns the fingerprint bookkeeping (no superseding
  // message.* event per healed row — see applyDmMessagePurchaseFact).
  let dmArchiveOpened = 0;
  for (const row of await listDmArchiveCandidates(db, accountId)) {
    const result = await applyDmMessagePurchaseFact(db, {
      platform: "onlyfans",
      ofapiAccountId: row.ofapi_account_id,
      platformMessageId: row.platform_message_id,
    });
    if (result.status === "written") {
      dmArchiveOpened += 1;
    }
  }
  const result = { dryRun, facts, hotPurchasedMarked, messageArchiveOpened, dmArchiveOpened };
  app.logger.info(result, "PPV purchase backfill complete");
  return result;
}
