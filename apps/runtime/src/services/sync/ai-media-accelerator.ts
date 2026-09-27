import {
  admitAiMediaAcceleratorRead,
  assertOwnedPageSyncLease,
  claimAiMediaAcceleratorRead,
  finishAiMediaAcceleratorRead,
  getPageSyncExecutionContext,
  listPageDmConversationsByPlatformConversationIds,
  tryAcquireDmArchiveWriterFenceLock,
  withOwnedPageSyncTransaction,
  type Database,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { isFanslyDmMessageSyncExcluded, type HttpRequestObserver } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  aiMediaNotesPolicyForPage,
  isAiMediaDescribeWindowOpen,
} from "../ai-media-describe/policy.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import type { ResolvedFanslyPageContext } from "../page-context.ts";
import type { ExecutorRequestContext } from "./executor-types.ts";
import { fetchAndJournalFanslyDmMessagePage } from "./fansly-dm-messages.ts";
import { createPageRateLimitWaiter } from "./rate-limiter.ts";

// AI media describer — Fansly freshness accelerator (plan §4, OFF by default:
// AI_MEDIA_DESCRIBE_FANSLY_ACCELERATOR_ENABLED). When a WS frame says a fan
// sent media on a describer page, ONE head read of that conversation
// (`before` null) journals the fresh DM page, the canonicalizer emits its
// attachments and the candidates projector makes the image due — usually
// before the chatter's first reply. The read rides the ordinary DM chunk: the
// page lease, the page proxy and the per-proxy DM spacing. Its budget is its
// own (agency-wide per rolling 24 h, at most one read per conversation per 2
// minutes); the B1 hint budget is untouched. The page is journaled only: no
// page_dm_messages upsert, no cursor, no coverage claim — ordinary polling
// still owns those, so a partial head can never hide a gap.

class AcceleratorDeferred extends Error {}

const PER_CONVERSATION_GAP_MS = 2 * 60 * 1000;
const STALE_AFTER_MS = 30 * 60 * 1000;

export async function runAiMediaAcceleratorStep(
  app: AppContext,
  input: ExecutorRequestContext & { syncRunId: number; pageContext: ResolvedFanslyPageContext },
): Promise<void> {
  const pageId = input.pageContext.page.id;
  const label = input.pageContext.page.label;
  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.aiMediaDescribeFanslyAcceleratorEnabled !== true) return;
  const policy = aiMediaNotesPolicyForPage(effective, label);
  const limit24h = Math.max(0, effective.aiMediaDescribeFanslyAcceleratorDailyLimit ?? 60);
  if (!policy || !isAiMediaDescribeWindowOpen(policy, new Date()) || limit24h === 0) return;
  if (input.budget.maxRequests < 2 || !input.budget.hasRequestCapacity(2) || !input.budget.hasWallClockCapacity()) return;
  const execution = getPageSyncExecutionContext();
  if (!execution || execution.pageId !== pageId || execution.stream !== "dm_messages") {
    throw new Error("ai_media_accelerator_page_lease_required");
  }
  // Called only from the Fansly DM chunk (which asserts the platform).
  if (!input.pageContext.page.platformAccountId) return;

  const owned = <T>(run: (db: Database) => Promise<T>) => withOwnedPageSyncTransaction(app.db, async (db) => {
    await assertOwnedPageSyncLease(db, { lock: true });
    if (!await tryAcquireDmArchiveWriterFenceLock(db, pageId)) throw new AcceleratorDeferred("erasure_busy");
    return run(db);
  });

  let claim: Awaited<ReturnType<typeof claimAiMediaAcceleratorRead>>;
  try {
    claim = await owned((db) => claimAiMediaAcceleratorRead(db, {
      pageId, now: new Date(), perConversationGapMs: PER_CONVERSATION_GAP_MS, staleAfterMs: STALE_AFTER_MS,
    }));
  } catch (error) {
    if (error instanceof AcceleratorDeferred) return;
    throw error;
  }
  if (!claim) return;
  const startedAt = new Date();
  const finish = (status: "done" | "skipped" | "failed", outcome: string) => owned((db) => finishAiMediaAcceleratorRead(db, {
    id: claim!.id, pageId, groupRef: claim!.groupRef, status, outcome, now: new Date(), startedAt,
  }));

  const [conversation] = await listPageDmConversationsByPlatformConversationIds(app.db, {
    platformAccountId: pageId, platformConversationIds: [claim.groupRef],
  });
  if (!conversation || !conversation.isVisible || conversation.fanId === null || isFanslyDmMessageSyncExcluded(conversation.metadata)) {
    // A brand-new chat is not in the roster yet; the ordinary sweep binds it.
    await finish("skipped", "conversation_ineligible");
    return;
  }

  let admitted = 0;
  let transportFailure: string | null = null;
  const observer: HttpRequestObserver = {
    async onRequestEvent(event) {
      if (event.state === "started") {
        if (admitted >= 1 || !input.budget.hasRequestCapacity(2) || !input.budget.hasWallClockCapacity()) {
          throw new AcceleratorDeferred("capacity");
        }
        // Counted at admission, before dispatch: a lost attempt still spends.
        const ok = await owned((db) => admitAiMediaAcceleratorRead(db, {
          id: claim!.id, requestId: event.requestId, limit24h, now: new Date(),
        }));
        if (!ok) throw new AcceleratorDeferred("budget_exhausted");
        admitted += 1;
        await input.budget.onRequestEvent(event);
      }
      await input.telemetry.getRequestObserver().onRequestEvent(event);
      if (event.state === "failed" && (event.failureKind === "transport" || event.failureKind === "timeout")) {
        transportFailure = event.failureKind;
      }
    },
  };
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: observer,
    remainingAttempts: () => Math.max(0, 1 - admitted),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  try {
    await fetchAndJournalFanslyDmMessagePage(app, {
      requestContext,
      telemetry: input.telemetry,
      syncRunId: input.syncRunId,
      platformAccountId: pageId,
      platform: input.pageContext.platform,
      pageAccountId: input.pageContext.page.platformAccountId,
      conversation,
      before: null,
    });
    await finish("done", "head_read");
  } catch (error) {
    if (error instanceof AcceleratorDeferred) {
      // No chunk capacity left: the request stays pending for the next chunk.
      if (error.message !== "capacity") await finish("skipped", error.message);
      return;
    }
    if (error instanceof FanslyApiError) {
      // Provider answers never retry here: the ordinary sync owns recovery.
      await finish("failed", `fansly_${error.status ?? "error"}`);
      return;
    }
    if (transportFailure) {
      await finish("failed", `fansly_${transportFailure}`);
      return;
    }
    // Lost lease, storage failure: propagate like the ordinary chunk.
    throw error;
  }
}
