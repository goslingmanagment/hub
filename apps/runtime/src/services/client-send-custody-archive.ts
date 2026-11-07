import {
  closeHeldSendOnArchiveProof,
  listHeldSendsForArchiveProof,
  type HeldSendArchiveCloseResult,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

// Every 5 minutes Hub closes the Fansly greetings held only because Fansly's
// live channel dropped their echo, when its own archive of the page has that
// very message (owner, 2026-11-07). The rule, the evidence and the close are
// packages/db client-send-custody-archive.ts; this file only schedules and
// counts. Database only: nothing here sends, re-sends or asks Fansly anything.

export const CLIENT_SEND_ARCHIVE_SWEEP_QUEUE = "client.send-custody.archive-sweep";
/** Held sends read per tick, newest first: the held list is a handful (11 on 2026-11-07). */
const ARCHIVE_SWEEP_LIMIT = 100;

export type ClientSendArchiveSweepTally = Record<
  "held" | "closed" | "unchanged" | "unproven" | "refused" | "gone" | "errored",
  number
> & { skipped: Record<string, number> };

export async function runClientSendArchiveSweep(app: Pick<AppContext, "db" | "logger">): Promise<ClientSendArchiveSweepTally> {
  const held = await listHeldSendsForArchiveProof(app.db, { limit: ARCHIVE_SWEEP_LIMIT });
  const tally: ClientSendArchiveSweepTally = {
    held: held.length, closed: 0, unchanged: 0, unproven: 0, refused: 0, gone: 0, errored: 0, skipped: {},
  };
  for (const ref of held) {
    let result: HeldSendArchiveCloseResult;
    try {
      result = await closeHeldSendOnArchiveProof(app.db, ref);
    } catch (error) {
      tally.errored += 1;
      app.logger.error({ err: error, attemptId: ref.attemptId, pageId: ref.pageId }, "send custody archive sweep: close failed");
      continue;
    }
    if (result.outcome === "skipped") {
      tally.skipped[result.reason] = (tally.skipped[result.reason] ?? 0) + 1;
      continue;
    }
    tally[result.outcome] += 1;
    if (result.outcome === "closed") {
      app.logger.info({ attemptId: ref.attemptId, pageId: ref.pageId }, "held greeting closed as sent on the archive's copy");
    } else if (result.outcome === "refused") {
      app.logger.warn(
        { attemptId: ref.attemptId, pageId: ref.pageId, code: result.code },
        "send custody archive sweep: the rules refused the close",
      );
    }
  }
  return tally;
}

export async function ensureClientSendArchiveSweepQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, CLIENT_SEND_ARCHIVE_SWEEP_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureClientSendArchiveSweepSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(CLIENT_SEND_ARCHIVE_SWEEP_QUEUE, "*/5 * * * *", null, { tz: "UTC" });
}
