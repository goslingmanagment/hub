import {
  findPlatformFan,
  findWorkboardPagePlatform,
  type DomainEventRow,
} from "@agency_hub_core/db";
import type { PgBoss } from "pg-boss";

type SendCapableBoss = Pick<PgBoss, "send">;

import type { AppContext } from "../bootstrap.ts";
import { recomputeWorkboardFan } from "../modules/workboard/index.ts";
import { createDomainEventHub } from "./domain-events-stream.ts";
import { WORKBOARD_FAN_RECOMPUTE_QUEUE } from "./sync-queue.ts";

// Kernel Stage 23: event-driven workboard recompute. A worker-side subscriber
// on the domain-event hub turns fan-relevant events into debounced per-fan
// recompute jobs (pg-boss singletonKey + startAfter — bursts collapse into
// one run, the group-serialization precedent). The nightly full sweep stays
// as the RECONCILER; its drift counter should read zero.

const DEBOUNCE_SECONDS = 5;

export interface WorkboardFanRecomputeJob {
  accountId: number;
  fanIdentityRef: string;
}

function isFanRelevant(event: DomainEventRow): boolean {
  if (!event.fanIdentityRef) {
    return false;
  }
  return event.type.startsWith("message.")
    || event.type === "transaction.posted"
    || event.type.startsWith("subscription.")
    || event.type.startsWith("presence.")
    || event.type.startsWith("fan.");
}

export interface WorkboardEventRecomputeHandle {
  stop(): Promise<void>;
}

export function startWorkboardEventRecompute(
  app: AppContext,
  boss: SendCapableBoss,
): WorkboardEventRecomputeHandle {
  const hub = createDomainEventHub(app);
  const unsubscribe = hub.subscribe({
    accountIds: undefined,
    deliver(event) {
      if (!isFanRelevant(event)) {
        return;
      }
      const payload: WorkboardFanRecomputeJob = {
        accountId: event.accountId,
        fanIdentityRef: event.fanIdentityRef!,
      };
      void boss.send(WORKBOARD_FAN_RECOMPUTE_QUEUE, payload as unknown as object, {
        singletonKey: `${event.accountId}:${event.fanIdentityRef}`,
        startAfter: DEBOUNCE_SECONDS,
      }).catch((error) => {
        app.logger.warn({ err: error, accountId: event.accountId },
          "workboard fan-recompute enqueue failed (reconciler will cover)");
      });
    },
  });
  void hub.ready().catch(() => undefined);

  return {
    async stop() {
      unsubscribe();
      await hub.close();
    },
  };
}

/** The job side: resolve the fan and re-evaluate exactly that board row. */
export async function runWorkboardFanRecompute(
  app: AppContext,
  job: WorkboardFanRecomputeJob,
): Promise<{ evaluated: number; changed: boolean } | { skipped: string }> {
  const platform = await findWorkboardPagePlatform(app.db, job.accountId);
  if (!platform) {
    return { skipped: "page_missing" };
  }
  const fan = await findPlatformFan(app.db, platform as "fansly" | "onlyfans", job.fanIdentityRef);
  if (!fan) {
    // The projection may not know this fan yet; the reconciler covers it.
    return { skipped: "fan_unknown" };
  }
  const result = await recomputeWorkboardFan(app.db, {
    platformAccountId: job.accountId,
    fanId: fan.id,
  });
  return { evaluated: result.evaluated, changed: result.changed };
}
