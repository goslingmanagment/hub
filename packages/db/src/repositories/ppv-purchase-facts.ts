// H2 (INC-001): PPV PURCHASE FACTS and the set-based writers that carry them
// into the stores that keep purchase state. One definition of "a purchase",
// three callers:
//   * the one-off history backfill (archive:backfill-ppv-purchases),
//   * the minutely recent-window reconcile inside the message-archive sweep
//     (a purchase that arrived BEFORE its message row — e.g. messages.sent
//     brought back by auto-redelivery after the unlock — is applied once the
//     row exists),
//   * the message-archive shadow rebuild (re-applies purchases after its
//     backfills, so a rebuild never loses is_opened that live has).
//
// A purchase FACT is (page, OnlyFans message id) named by a non-superseded
// message.ppv_unlocked event with a message ref — plus, where the scope says
// so, a hot row with purchased_at set. Every writer here is monotonic (only
// ever toward "bought") and conditional on the row not already saying so, so
// any caller can re-run it. Nothing is inserted. OnlyFans pages only: Fansly
// unlocks carry no message ref.
//
// dm_message_archive is deliberately NOT written here: its rows carry material
// fingerprints, so it goes row by row through applyDmMessagePurchaseFact; this
// module only lists the candidates.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { domainEventNotSupersededSql } from "./domain-event-supersession.ts";
import type { ArchiveTargetTable } from "./message-archive.ts";

export interface PurchaseFactScope {
  /** One internal page id; null/absent = every OnlyFans page. */
  accountId?: number | null;
  /** Only unlocks that occurred at or after this instant (the recent-window
   * reconcile — an index range on (type, occurred_at)); null = all history. */
  since?: Date | null;
  /** Also count hot `purchased_at` as a fact. Unbounded over the account's hot
   * rows, so it is for the history backfill and the per-account rebuild, never
   * for the minutely window. */
  includeHot?: boolean;
}

function archiveTarget(target: ArchiveTargetTable) {
  if (target !== "message_archive" && target !== "message_archive_shadow") {
    throw new Error(`Unknown archive target table: ${String(target)}`);
  }
  return sql.raw(target);
}

/** Earliest non-superseded unlock per (page, message) — the hot purchased_at source. */
function ppvEventsCte(scope: PurchaseFactScope): SQL {
  const accountFilter = scope.accountId == null ? sql`` : sql`and de.account_id = ${scope.accountId}`;
  const sinceFilter = scope.since == null ? sql`` : sql`and de.occurred_at >= ${scope.since}`;
  return sql`
    ppv as (
      select de.account_id, de.message_ref, min(de.occurred_at) as purchased_at
      from domain_events de
      join pages p on p.id = de.account_id and p.platform = 'onlyfans'
      where de.type = 'message.ppv_unlocked'
        and de.message_ref is not null
        and ${domainEventNotSupersededSql("de")}
        ${sinceFilter}
        ${accountFilter}
      group by de.account_id, de.message_ref
    )`;
}

/** Every purchase fact in scope. */
function factsCte(scope: PurchaseFactScope): SQL {
  if (scope.includeHot !== true) {
    return sql`${ppvEventsCte(scope)}, facts as (select account_id, message_ref from ppv)`;
  }
  const hotFilter = scope.accountId == null ? sql`` : sql`and m.platform_account_id = ${scope.accountId}`;
  return sql`
    ${ppvEventsCte(scope)},
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

export async function countPurchaseFacts(db: Database, scope: PurchaseFactScope): Promise<number> {
  return countOf(db, sql`with ${factsCte(scope)} select count(*)::text as n from facts`);
}

/** Hot rows with no purchased_at whose unlock the ledger holds. */
export async function countHotPurchasesToMark(db: Database, scope: PurchaseFactScope): Promise<number> {
  return countOf(db, sql`
    with ${ppvEventsCte(scope)}
    select count(*)::text as n
    from page_dm_messages m
    join ppv on ppv.account_id = m.platform_account_id and ppv.message_ref = m.platform_message_id
    where m.purchased_at is null and m.deleted_at is null
  `);
}

/** Fills hot purchased_at from the earliest unlock. Returns rows marked. */
export async function markHotPurchasesFromLedger(db: Database, scope: PurchaseFactScope): Promise<number> {
  return countOf(db, sql`
    with ${ppvEventsCte(scope)},
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
}

export async function countArchivePurchasesToOpen(
  db: Database,
  scope: PurchaseFactScope,
  target: ArchiveTargetTable = "message_archive",
): Promise<number> {
  const table = archiveTarget(target);
  return countOf(db, sql`
    with ${factsCte(scope)}
    select count(*)::text as n
    from ${table} ma
    join facts f on f.account_id = ma.account_id and f.message_ref = ma.message_ref
    where ma.platform = 'onlyfans' and ma.is_opened is distinct from true
  `);
}

/** message_archive (or its shadow) → is_opened = TRUE for every fact. */
export async function openArchivePurchases(
  db: Database,
  scope: PurchaseFactScope,
  target: ArchiveTargetTable = "message_archive",
): Promise<number> {
  const table = archiveTarget(target);
  return countOf(db, sql`
    with ${factsCte(scope)},
    opened as (
      update ${table} ma set is_opened = true, updated_at = now()
      from facts f
      where f.account_id = ma.account_id
        and f.message_ref = ma.message_ref
        and ma.platform = 'onlyfans'
        and ma.is_opened is distinct from true
      returning 1
    )
    select count(*)::text as n from opened
  `);
}

export interface DmArchivePurchaseCandidate {
  ofapiAccountId: string;
  platformMessageId: string;
}

/** OF material-head rows a fact would open. In the recent window the join
 * also pins the page's CURRENT ofapi account, so the lookup rides the
 * (platform, ofapi_account_id, platform_message_id) unique index; the history
 * scope keeps the page-id join, which also reaches rows filed under an older
 * binding. */
export async function listDmArchivePurchaseCandidates(
  db: Database,
  scope: PurchaseFactScope,
): Promise<DmArchivePurchaseCandidate[]> {
  const indexPin = scope.since == null ? sql`` : sql`and d.ofapi_account_id = p.ofapi_account_id`;
  const result = await db.execute<{ ofapi_account_id: string; platform_message_id: string }>(sql`
    with ${factsCte(scope)}
    select d.ofapi_account_id, d.platform_message_id
    from facts f
    join pages p on p.id = f.account_id
    join dm_message_archive d on d.platform = 'onlyfans'
      and d.platform_account_id = f.account_id
      and d.platform_message_id = f.message_ref
      ${indexPin}
    where d.is_opened is distinct from true
    order by d.id
  `);
  return result.rows.map((row) => ({
    ofapiAccountId: row.ofapi_account_id,
    platformMessageId: row.platform_message_id,
  }));
}
