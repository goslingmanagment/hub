// Projection-debt repair sweep (decision #135 A2b). The dm_messages executor
// records a debt row instead of dying when ONLY the rebuildable thread-summary
// recompute (finalize + checkpoint) fails — the message facts are already
// committed and the raw payload was journaled at fetch time. This sweep is
// the repair half: re-run the recompute per open row, resolve on success,
// bump attempts on failure. It never talks to the platform.

import {
  finalizePageDmConversationMessageSync,
  getPageDmConversationById,
  listUnresolvedProjectionDebt,
  PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
  recordProjectionDebt,
  resolveProjectionDebt,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { isPageDmPruneAllowed } from "./page-dm-retention.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const PROJECTION_DEBT_SWEEP_QUEUE = "projections.debt.sweep";

const SWEEP_BATCH_LIMIT = 20;
const ERROR_SUMMARY_MAX_LENGTH = 500;

export async function ensureProjectionDebtQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, PROJECTION_DEBT_SWEEP_QUEUE, {
    policy: "exclusive",
  }, createdQueues);
}

export async function ensureProjectionDebtSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(PROJECTION_DEBT_SWEEP_QUEUE, "*/5 * * * *", null, { tz: "UTC" });
}

export function summarizeProjectionDebtError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, ERROR_SUMMARY_MAX_LENGTH);
}

export async function runProjectionDebtSweep(
  app: Pick<AppContext, "config" | "db" | "logger">,
) {
  const rows = await listUnresolvedProjectionDebt(app.db, SWEEP_BATCH_LIMIT);
  let resolved = 0;
  let failed = 0;
  if (rows.length === 0) {
    return { scanned: 0, resolved, failed };
  }

  // Mirrors the executor's finalize call: the retention prune stays behind
  // the exact gate the sync path uses (flag + archive coverage).
  const enforceRetention = await isPageDmPruneAllowed(app);

  for (const row of rows) {
    try {
      if (row.kind !== PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY) {
        throw new Error(`No repair handler for projection debt kind "${row.kind}"`);
      }

      const conversation = await getPageDmConversationById(app.db, row.conversationId);
      if (conversation) {
        // Keep the conversation's CURRENT coverage status: the wedged
        // finalize never wrote its computed status, and the next sync pass
        // of this conversation recomputes it anyway — the sweep's only job
        // is the summary recount (count/newest/oldest/fan-model timestamps).
        // It reads no head, so last_message_sync_at stays as it is.
        await finalizePageDmConversationMessageSync(app.db, {
          conversationId: row.conversationId,
          messageCoverageStatus: conversation.messageCoverageStatus,
          headReadAt: null,
          enforceRetention,
        });
      }
      // A missing conversation has nothing left to repair — resolve either
      // way. finalize is an idempotent recompute, so a crash between it and
      // this resolve just repeats the recompute next sweep.
      await resolveProjectionDebt(app.db, row.id);
      resolved += 1;
    } catch (error) {
      failed += 1;
      await recordProjectionDebt(app.db, {
        kind: row.kind,
        platformAccountId: row.platformAccountId,
        conversationId: row.conversationId,
        errorSummary: summarizeProjectionDebtError(error),
      }).catch((recordError) => {
        app.logger.warn(
          { err: recordError, debtId: row.id, conversationId: row.conversationId },
          "Projection debt attempt bump failed",
        );
      });
    }
  }

  return { scanned: rows.length, resolved, failed };
}
