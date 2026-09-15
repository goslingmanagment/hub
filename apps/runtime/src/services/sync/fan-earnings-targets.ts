import {
  admitFanEarningsTargetAttempt, assertOwnedPageSyncLease, claimFanEarningsTarget,
  deferFanEarningsTarget, getPageSyncExecutionContext,
  withOwnedPageSyncTransaction, type Database,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import type { AppConfig, HttpRequestObserver } from "@agency_hub_core/shared";
import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import type { ExecutorRequestContext } from "./executor-types.ts";
import { fanslyNewStreamAllowed, isPageAllowlisted } from "./fansly-stream-gate.ts";
import { captureFanEarningsEndpoint } from "./fan-earnings-capture.ts";
import { createPageRateLimitWaiter } from "./rate-limiter.ts";

class TargetAdmissionDeferred extends Error {}

export function fanEarningsTargetLimit(config: AppConfig, pageLabel: string) {
  const limit = config.fanslyFanEarningsTargetsDailyAttemptLimit;
  return config.fanslyFanEarningsSyncEnabled === true
    && fanslyNewStreamAllowed(config.fanslyNewStreamPageAllowlist, pageLabel)
    && config.fanslyFanEarningsTargetsEnabled === true
    && isPageAllowlisted(config.fanslyFanEarningsTargetsPageAllowlist ?? "", pageLabel)
    && Number.isSafeInteger(limit) && limit! > 0 && limit! <= 1000 ? limit! : 0;
}

/** Additive C2c consumer. One due endpoint, leaving at least one complete
 * two-request fan for daily rotation. No scheduler, cursor or cadence change. */
export async function runFanEarningsTargetStep(app: AppContext, input: ExecutorRequestContext & {
  syncRunId: number;
  pageContext: Extract<ExecutorRequestContext["pageContext"], { platform: "fansly" }>;
}) {
  const { page } = input.pageContext;
  if (!fanEarningsTargetLimit(await loadEffectiveConfig(app.db, app.config), page.label)
    || !input.budget.hasRequestCapacity(3) || !input.budget.hasWallClockCapacity()) return;
  const execution = getPageSyncExecutionContext();
  if (!execution || execution.pageId !== page.id || execution.stream !== "fan_earnings") {
    throw new Error("fan_earnings_target_page_lease_required");
  }
  const owned = <T>(run: (db: Database) => Promise<T>) => withOwnedPageSyncTransaction(app.db, async db => {
    await assertOwnedPageSyncLease(db, { lock: true });
    return run(db);
  });
  const claim = await owned(db => claimFanEarningsTarget(db, page.id, new Date()));
  if (!claim) return;
  let admitted = false;
  const observer: HttpRequestObserver = {
    async onRequestEvent(event) {
      if (event.state === "started") {
        const limit24h = fanEarningsTargetLimit(await loadEffectiveConfig(app.db, app.config), page.label);
        if (!limit24h || admitted || !input.budget.hasRequestCapacity(3) || !input.budget.hasWallClockCapacity()) {
          throw new TargetAdmissionDeferred("fan_earnings_target_disabled");
        }
        const allowed = await owned(async db => {
          return admitFanEarningsTargetAttempt(db, {
            claim, syncRunId: input.syncRunId, requestId: event.requestId,
            attemptNumber: event.attemptNumber, limit24h, now: new Date(),
          });
        });
        if (!allowed) throw new TargetAdmissionDeferred("fan_earnings_target_budget_exhausted");
        admitted = true;
        await input.budget.onRequestEvent(event);
      }
      await input.telemetry.getRequestObserver()?.onRequestEvent(event);
    },
  };
  const context = {
    session: input.pageContext.session, proxy: input.pageContext.proxy, egressKey: input.pageContext.egressKey,
    requestObserver: observer, remainingAttempts: () => admitted ? 0 : 1,
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const window = { after: new Date(0), before: new Date() };
  try {
    await captureFanEarningsEndpoint(app, {
      pageId: page.id, syncRunId: input.syncRunId, fan: { fanId: null, platformUserId: claim.fanRef },
      window: claim.window, ...window, shadow: false, target: { claim, wasAdmitted: () => admitted },
      fetch: () => claim.window === "lifetime"
        ? app.adapter.getEarningsStatsAccountsPage(context, { correlationAccountId: claim.fanRef, ...window })
        : app.adapter.getEarningsMonthlyStatsAccountsPage(context, { correlationAccountId: claim.fanRef, ...window }),
    });
  } catch (error) {
    if (error instanceof TargetAdmissionDeferred) {
      await owned(db => deferFanEarningsTarget(db, claim, new Date(Date.now() + 15 * 60_000)));
      return;
    }
    // A failed addressed fan cannot block unrelated daily work. Each endpoint
    // keeps its own receipt/debt; page auth, cooldown and capture failures keep
    // the ordinary executor policy.
    if (error instanceof FanslyApiError && error.retryAfterAt === null
      && [400, 404, 410].includes(error.status ?? 0)) return;
    throw error;
  }
}
