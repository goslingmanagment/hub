import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { Platform } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import { configAuditLog, models, pages } from "../schema.ts";

export interface ClientBootstrapPageRow {
  id: number;
  label: string;
  platform: Platform;
  displayName: string | null;
  modelName: string;
  /** `pages.external_page_id`: the platform's own account id. NOT the Sync
   *  Engine's `platformAccountId`, which there names `pages.id`. */
  platformAccountId: string | null;
  ofapiBindingGeneration: number;
}

/**
 * The pages the chat-extension bootstrap lists: active and not tombstoned.
 *
 * `pageIds` is the caller's page scope: `null` = every page (the owner), a list
 * = exactly those pages. An EMPTY list returns no rows: reading "no ids" as "no
 * filter" is how a scope clamp turns into an unfiltered read.
 */
export async function listClientBootstrapPages(
  db: Database,
  pageIds: readonly number[] | null,
): Promise<ClientBootstrapPageRow[]> {
  if (pageIds !== null && pageIds.length === 0) {
    return [];
  }
  const clauses: SQL[] = [eq(pages.status, "active"), isNull(pages.deletedAt)];
  if (pageIds !== null) {
    clauses.push(inArray(pages.id, [...pageIds]));
  }
  return db.select({
    id: pages.id,
    label: pages.label,
    platform: pages.platform,
    displayName: pages.displayName,
    modelName: models.name,
    platformAccountId: pages.platformAccountId,
    ofapiBindingGeneration: pages.ofapiBindingGeneration,
  }).from(pages)
    .innerJoin(models, eq(models.id, pages.modelId))
    .where(and(...clauses))
    .orderBy(models.sortOrder, models.slug, pages.label);
}

/**
 * The bootstrap's `configRevision`: the newest `config_audit_log` id among the
 * given keys, 0 when none was ever changed.
 *
 * An audit id, not `config_settings.version`: clearing an override deletes its
 * row, so the next write starts the version again at 1 and a client would miss
 * the change. Audit ids only grow.
 *
 * A change HINT for the client's cache, not a total order of changes. Ids are
 * taken when a row is inserted, not when its transaction commits: of two
 * concurrent writes the later id can commit first, and the earlier one then
 * lands without moving the maximum. A change made only in the environment
 * writes no audit row at all. Either reaches the client at its cache TTL; the
 * switches themselves are always served in full and enforced on the server.
 * Never decide an action by comparing revisions (a `flags_stale` check, H-7b):
 * read the switch rows under FOR SHARE in the deciding transaction.
 */
export async function getClientConfigRevision(db: Database, keys: readonly string[]): Promise<number> {
  if (keys.length === 0) {
    return 0;
  }
  const [row] = await db.select({
    revision: sql<number>`coalesce(max(${configAuditLog.id}), 0)`.mapWith(Number),
  }).from(configAuditLog)
    .where(inArray(configAuditLog.key, [...keys]));
  return row?.revision ?? 0;
}
