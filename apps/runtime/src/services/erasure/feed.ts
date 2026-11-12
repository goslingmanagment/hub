import { sql } from "drizzle-orm";

import type { AgentErasuresFeedResponse } from "@agency_hub_core/contracts";

import type { AppContext } from "../../bootstrap.ts";

/**
 * `agentErasuresFeed`: the fan erasures Hub completed, after a cursor, for the ledger to blank its own copies of what
 * Hub served it. What is served is what the tombstone keeps of the scope (`fan:<platform>:<ref>`) and when it
 * completed — nothing the erasure removed, and no list of the fan's sales: Hub's anonymized sales are not tied back to
 * him anywhere, and this feed does not tie them again.
 *
 * The order is the tombstones' ids. Executions hold one global lock from their tombstone's insert to its completion
 * (`withErasureExecutionLock`), so a lower id completes before a higher one is written; one that died mid-flight stays
 * unresolved and is never served — its re-run is a new tombstone, served when it completes. An erasure is served to a
 * key that holds one of the pages it resolved (`plan.resolvedPageIds`); `next` moves past the others too.
 */
export async function readErasuresFeed(
  app: Pick<AppContext, "db">,
  input: { pageIds: readonly number[]; since?: string | undefined; limit: number },
  now: Date = new Date(),
): Promise<AgentErasuresFeedResponse> {
  const afterId = input.since === undefined ? 0 : Number(input.since);
  const granted = input.pageIds.length === 0
    ? sql`false`
    : sql`exists (
        select 1 from jsonb_array_elements_text(case when jsonb_typeof(plan -> 'resolvedPageIds') = 'array'
          then plan -> 'resolvedPageIds' else '[]'::jsonb end) as page(id)
        where page.id ~ '^[0-9]+$' and page.id::bigint in ${[...input.pageIds]})`;
  const result = await app.db.execute<{ id: string | number; scope_ref: string; completed_at: Date | string; granted: boolean }>(sql`
    select id, scope_ref, completed_at, ${granted} as granted
    from erasure_log
    where scope_type = 'fan' and not dry_run and resolution_kind = 'completed' and completed_at is not null and id > ${afterId}
    order by id
    limit ${input.limit}`);
  const erasures: AgentErasuresFeedResponse["erasures"] = [];
  for (const row of result.rows) {
    const scope = /^fan:(onlyfans|fansly):(.+)$/su.exec(row.scope_ref);
    if (!row.granted || scope === null) continue;
    erasures.push({
      id: Number(row.id),
      platform: scope[1] as "onlyfans" | "fansly",
      fanRef: scope[2]!,
      erasedAt: new Date(row.completed_at).toISOString(),
    });
  }
  const last = result.rows.at(-1);
  return { erasures, next: String(last === undefined ? afterId : Number(last.id)), serverNow: now.toISOString() };
}
