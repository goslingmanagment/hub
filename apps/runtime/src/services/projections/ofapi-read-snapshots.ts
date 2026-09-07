import {
  findDomainEventByDedupKey,
  getProjectionWatermark,
  listEventAccounts,
  listEventsSince,
  saveOfapiReadSnapshot,
  setProjectionWatermark,
  type Database,
  type DomainEventRow,
} from "@agency_hub_core/db";
import { findOfapiReadDefinition } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";
import type { AppContext } from "../../bootstrap.ts";
import { ofapiReadSnapshotEventKey } from "../canonicalize/ofapi-read-collections.ts";
export const OFAPI_READ_SNAPSHOT_PROJECTION = "ofapi_read_snapshots";

async function applySnapshotEvent(
  app: Pick<AppContext, "db">,
  accountId: number,
  event: DomainEventRow,
) {
  if (event.type !== "ofapi.read_snapshot_observed") return false;
  const data = event.data as Record<string, unknown>;
  const def = findOfapiReadDefinition(String(data.operation));
  if (
    !def ||
    event.accountId !== accountId ||
    data.pageId !== accountId ||
    !Array.isArray(data.items) ||
    typeof data.observedAt !== "string" ||
    !Number.isFinite(Date.parse(data.observedAt))
  )
    throw new Error("Invalid OFAPI snapshot event");
  await saveOfapiReadSnapshot(app.db, {
    pageId: accountId,
    category: def.category,
    operation: def.operation,
    pathname: String(data.pathname),
    query: data.query as Record<string, string>,
    observedAt: new Date(data.observedAt),
    observationId: event.observationId,
    observationReceivedAt: new Date(data.observedAt),
    eventId: event.id,
    granularity: String(data.granularity),
    coverage: data.coverage,
    items: data.items,
  });
  return true;
}

/** Materialize one canonical fact without consuming or skipping the replay watermark. */
export async function projectOfapiReadSnapshotObservation(
  app: Pick<AppContext, "db">,
  input: { accountId: number; observationId: number },
) {
  const event = await findDomainEventByDedupKey(app.db, {
    accountId: input.accountId,
    dedupKey: ofapiReadSnapshotEventKey(input.observationId),
  });
  if (!event) return false;
  if (event.observationId !== input.observationId)
    throw new Error("OFAPI snapshot event observation mismatch");
  return applySnapshotEvent(app, input.accountId, event);
}

export async function runOfapiReadSnapshotProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
) {
  const accounts =
    input?.accountId != null
      ? [input.accountId]
      : await listEventAccounts(app.db);
  const result = { accounts: accounts.length, eventsSeen: 0, applied: 0 };
  for (const accountId of accounts) {
    let watermark = await getProjectionWatermark(
      app.db,
      OFAPI_READ_SNAPSHOT_PROJECTION,
      accountId,
    );
    for (let page = 0; page < 20; page++) {
      const events = await listEventsSince(app.db, {
        accountId,
        afterSeq: watermark,
        limit: 500,
      });
      if (!events.length) break;
      for (const event of events) {
        result.eventsSeen++;
        if (await applySnapshotEvent(app, accountId, event)) result.applied++;
      }
      watermark = events.at(-1)!.accountSeq;
      await setProjectionWatermark(
        app.db,
        OFAPI_READ_SNAPSHOT_PROJECTION,
        accountId,
        watermark,
      );
      if (events.length < 500) break;
    }
  }
  return result;
}
/** Owner-invoked reset affects only reconstructible rows, never raw captures, policy or jobs. */
export async function rebuildOfapiReadSnapshotProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
) {
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await db.execute(
      sql`delete from ofapi_read_snapshots ${input?.accountId == null ? sql`` : sql`where page_id=${input.accountId}`}`,
    );
    await db.execute(
      sql`delete from projection_seq_watermarks where projection=${OFAPI_READ_SNAPSHOT_PROJECTION} ${input?.accountId == null ? sql`` : sql`and account_id=${input.accountId}`}`,
    );
  });
  // The normal runner is bounded. Rebuild drains until all accounts' event tails are consumed.
  let totals = { accounts: 0, eventsSeen: 0, applied: 0 };
  for (;;) {
    const batch = await runOfapiReadSnapshotProjection(app, input);
    totals = {
      accounts: batch.accounts,
      eventsSeen: totals.eventsSeen + batch.eventsSeen,
      applied: totals.applied + batch.applied,
    };
    if (batch.eventsSeen === 0) return totals;
  }
}
