import {
  getProjectionWatermark,
  listEventAccounts,
  listEventsSince,
  setProjectionWatermark,
  saveOfapiChatQueueState,
  type Database,
} from "@agency_hub_core/db";
import { sql } from "drizzle-orm";
import type { AppContext } from "../../bootstrap.ts";
export const OFAPI_CONTENT_PROJECTION = "ofapi_content_events";
export async function runOfapiContentProjection(
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
      OFAPI_CONTENT_PROJECTION,
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
        if (event.type !== "ofapi.chat_queue_observed") continue;
        const data = event.data as Record<string, unknown>;
        if (
          typeof data.queueId !== "string" ||
          typeof data.observedAt !== "string" ||
          !["updated", "finished"].includes(String(data.phase))
        )
          throw new Error("Invalid queue event");
        if (
          await saveOfapiChatQueueState(app.db, {
            pageId: accountId,
            queueId: data.queueId,
            phase: String(data.phase),
            queueDate:
              typeof data.queueDate === "string"
                ? new Date(data.queueDate)
                : null,
            state: data,
            observedAt: new Date(data.observedAt),
            eventId: event.id,
            observationId: event.observationId,
          })
        )
          result.applied++;
      }
      watermark = events.at(-1)!.accountSeq;
      await setProjectionWatermark(
        app.db,
        OFAPI_CONTENT_PROJECTION,
        accountId,
        watermark,
      );
      if (events.length < 500) break;
    }
  }
  return result;
}
export async function rebuildOfapiContentProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
) {
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await db.execute(
      sql`delete from ofapi_chat_queue_state ${input?.accountId == null ? sql`` : sql`where page_id=${input.accountId}`}`,
    );
    await db.execute(
      sql`delete from projection_seq_watermarks where projection=${OFAPI_CONTENT_PROJECTION} ${input?.accountId == null ? sql`` : sql`and account_id=${input.accountId}`}`,
    );
  });
  const result = { accounts: 0, eventsSeen: 0, applied: 0 };
  for (;;) {
    const batch = await runOfapiContentProjection(app, input);
    result.accounts = batch.accounts;
    result.eventsSeen += batch.eventsSeen;
    result.applied += batch.applied;
    if (batch.eventsSeen === 0) return result;
  }
}
