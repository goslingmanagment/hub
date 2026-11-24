import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { PotDistributionLineRow, PotFormulaRow } from "./pots.ts";

// The pot distributions feed (0443, Contract K2): every posted or reversed distribution change in `pot_distributions`,
// placed once committed under an advisory lock so late commits land after the cursor. Test-realm rows are filtered in
// SQL by `is_test` BEFORE `held`, `limit`, or `next`, so test rows never leak into live reads, held lists, or cursors.
// Mirrors `sale-home-feed.ts` (0441) and `sale-decision-feed.ts` (0409).

type Row = Record<string, unknown>;
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;
const num = (value: unknown) => Number(value);

function numArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "{}" || trimmed === "") return [];
    return trimmed.slice(1, -1).split(",").filter((s) => s !== "").map(Number);
  }
  return [];
}

function jsonOf<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

export type PotDistributionChangeKind = "posted" | "reversed";

export interface PotDistributionChangeRow {
  id: number;
  seq: number;
  distributionId: number;
  isTest: boolean;
  change: PotDistributionChangeKind;
  at: Date;
}

export interface PotDistributionHydratedRow {
  id: number;
  potId: number;
  potCode: string;
  potName: string;
  modelSlug: string;
  potPageIds: number[];
  reversedAt: Date | null;
  day: string;
  formula: PotFormulaRow;
  baseMills: number;
  lines: PotDistributionLineRow[];
  inflows: Array<{ transactionId: number; pageId: number; pageLabel: string; baseMills: number }>;
  /** Union of `pots.page_ids` and every part's `page_id`, sorted. */
  allPageIds: number[];
}

const CHANGE_COLUMNS = sql`c.id, c.seq, c.distribution_id, c.is_test, c.change, c.at`;

function changeOf(row: Row): PotDistributionChangeRow {
  return {
    id: num(row.id),
    seq: num(row.seq),
    distributionId: num(row.distribution_id),
    isTest: Boolean(row.is_test),
    change: String(row.change) as PotDistributionChangeKind,
    at: new Date(String(row.at)),
  };
}

/** Places every committed `pot_distribution_changes` row not placed yet, after every place given before, in id order. */
export async function placePotDistributionChanges(db: Database): Promise<number> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('pot_distribution_changes', 0))`);
    const placed = await tx.execute(sql`
      update pot_distribution_changes c set seq = placed.seq
      from (
        select id, (select last_seq from feed_positions where feed = 'pot_distribution_changes') + row_number() over (order by id) as seq
        from pot_distribution_changes where seq is null
      ) placed
      where c.id = placed.id`);
    return Number((placed as { rowCount?: number | null }).rowCount ?? 0);
  });
}

/**
 * Releases held changes whose distribution's pages (`pots.page_ids` union `pot_distribution_parts.page_id`) are ALL now
 * inside `pageIds` (and match `isTest`): moves them to a NEW place at the end of the feed under the placement advisory
 * lock and removes them from `pot_distribution_feed_held`.
 */
export async function releasePotDistributionChangesHeld(
  db: Database,
  input: { agentKeyId: number; pageIds: readonly number[]; isTest: boolean },
): Promise<number> {
  if (input.pageIds.length === 0) return 0;
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('pot_distribution_changes', 0))`);
    // A reversal supersedes its post even when the reversal has not been placed yet.
    await tx.execute(sql`
      delete from pot_distribution_feed_held k using pot_distribution_changes old
      where k.change_id = old.id and k.agent_key_id = ${input.agentKeyId} and old.is_test = ${input.isTest}
        and exists (select 1 from pot_distribution_changes newer
          where newer.distribution_id = old.distribution_id and newer.id > old.id)`);
    const moved = await tx.execute<Row>(sql`
      update pot_distribution_changes c set seq = ready.seq
      from (
        select old.id, (select last_seq from feed_positions where feed = 'pot_distribution_changes') + row_number() over (order by old.seq, old.id) as seq
        from pot_distribution_feed_held k
        join pot_distribution_changes old on old.id = k.change_id
        join pot_distributions d on d.id = old.distribution_id
        join pots p on p.id = d.pot_id
        where k.agent_key_id = ${input.agentKeyId}
          and old.is_test = ${input.isTest}
          and not exists (
            select 1
            from (
              select unnest(p.page_ids) as page_id
              union
              select pp.page_id from pot_distribution_parts pp where pp.distribution_id = d.id
            ) req
            where not (req.page_id = any(${ids(input.pageIds)}))
          )
      ) ready
      where c.id = ready.id
      returning c.id`);
    const changeIds = moved.rows.map((row) => num(row.id));
    if (changeIds.length > 0) {
      await tx.execute(sql`
        delete from pot_distribution_feed_held
        where agent_key_id = ${input.agentKeyId} and change_id = any(${ids(changeIds)})`);
    }
    return changeIds.length;
  });
}

/** Placed changes in the caller's realm (`is_test = isTest`) after `afterSeq`, in feed order, up to `limit` places. */
export async function listPotDistributionChangesAfter(
  db: Database,
  input: { afterSeq: number; limit: number; isTest: boolean },
): Promise<{ changes: PotDistributionChangeRow[]; more: boolean }> {
  const result = await db.execute<Row>(sql`
    select ${CHANGE_COLUMNS}
    from pot_distribution_changes c
    where c.seq > ${input.afterSeq} and c.is_test = ${input.isTest}
    order by c.seq
    limit ${input.limit + 1}`);
  return {
    changes: result.rows.slice(0, input.limit).map(changeOf),
    more: result.rows.length > input.limit,
  };
}

/** Keeps changes held back for an agent key until its grant covers every page of the distribution. */
export async function holdPotDistributionChanges(db: Database, input: { agentKeyId: number; changeIds: readonly number[] }): Promise<void> {
  if (input.changeIds.length === 0) return;
  await db.execute(sql`
    insert into pot_distribution_feed_held (agent_key_id, change_id)
    select ${input.agentKeyId}, unnest(${ids(input.changeIds)})
    on conflict do nothing`);
}

/** The changes currently held back for an agent key in its realm, in feed order. */
export async function listPotDistributionChangesHeld(
  db: Database,
  input: { agentKeyId: number; isTest: boolean },
): Promise<PotDistributionChangeRow[]> {
  const result = await db.execute<Row>(sql`
    select ${CHANGE_COLUMNS}
    from pot_distribution_feed_held h
    join pot_distribution_changes c on c.id = h.change_id
    where h.agent_key_id = ${input.agentKeyId} and c.is_test = ${input.isTest}
    order by c.seq`);
  return result.rows.map(changeOf);
}

/** Hydrates distributions by id with pot metadata, model slug, lines, and inflow parts (with page labels). */
export async function listPotDistributionsForFeed(
  db: Database,
  distributionIds: readonly number[],
): Promise<Map<number, PotDistributionHydratedRow>> {
  const unique = [...new Set(distributionIds.filter(Number.isSafeInteger))];
  if (unique.length === 0) return new Map();

  const distResult = await db.execute<Row>(sql`
    select d.id, d.pot_id, p.code as pot_code, p.name as pot_name, m.slug as model_slug, p.page_ids as pot_page_ids,
      to_char(d.day, 'YYYY-MM-DD') as day, d.formula, d.base_mills, d.lines, d.reversed_at
    from pot_distributions d
    join pots p on p.id = d.pot_id
    join models m on m.id = p.model_id
    where d.id = any(${ids(unique)})`);

  const partsResult = await db.execute<Row>(sql`
    select pp.distribution_id, pp.transaction_id, pp.page_id, coalesce(pg.label, '#' || pp.page_id::text) as page_label, pp.base_mills
    from pot_distribution_parts pp
    left join pages pg on pg.id = pp.page_id
    where pp.distribution_id = any(${ids(unique)})
    order by pp.distribution_id, pp.transaction_id`);

  const partsByDist = new Map<number, Array<{ transactionId: number; pageId: number; pageLabel: string; baseMills: number }>>();
  for (const row of partsResult.rows) {
    const distributionId = num(row.distribution_id);
    const list = partsByDist.get(distributionId) ?? [];
    list.push({
      transactionId: num(row.transaction_id),
      pageId: num(row.page_id),
      pageLabel: String(row.page_label),
      baseMills: num(row.base_mills),
    });
    partsByDist.set(distributionId, list);
  }

  const out = new Map<number, PotDistributionHydratedRow>();
  for (const row of distResult.rows) {
    const id = num(row.id);
    const potPageIds = numArray(row.pot_page_ids);
    const inflows = partsByDist.get(id) ?? [];
    const allPageIds = [...new Set([...potPageIds, ...inflows.map((inflow) => inflow.pageId)])].sort((a, b) => a - b);
    const formula = jsonOf<PotFormulaRow>(row.formula, { kind: "equal", params: {} });
    out.set(id, {
      id,
      potId: num(row.pot_id),
      potCode: String(row.pot_code),
      potName: String(row.pot_name),
      modelSlug: String(row.model_slug),
      potPageIds,
      reversedAt: row.reversed_at == null ? null : new Date(String(row.reversed_at)),
      day: String(row.day),
      formula: {
        kind: formula.kind,
        params: formula.params && typeof formula.params === "object" && !Array.isArray(formula.params) ? formula.params : {},
      },
      baseMills: num(row.base_mills),
      lines: jsonOf<PotDistributionLineRow[]>(row.lines, []),
      inflows,
      allPageIds,
    });
  }
  return out;
}
