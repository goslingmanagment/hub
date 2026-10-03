import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";

import type { Platform } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import { models, pages } from "../schema.ts";

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
