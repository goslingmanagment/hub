import { hasDueAiMediaDescriptions } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { runAiMediaDescribeSweepJob } from "./sweep.ts";
import { listActiveAiMediaDescribePageIds, type AiMediaDescribeDeps } from "./worker.ts";

// Describe within seconds (docs/runbooks/ai-media-describe.md): the worker
// looks for due rows every second (one select on the partial due index) and
// drains them through the same sweep and slot as the minutely job. Whatever
// makes a row due — the projector, a generation, a fresh source — is picked
// up here without waiting for the next minute. The minutely job stays as the
// fallback. Off (AI_MEDIA_DESCRIBE_LOOP_ENABLED) the loop costs one config
// read per refresh.

export const AI_MEDIA_DESCRIBE_LOOP_INTERVAL_MS = 1_000;
/** How often the switch and the page list are re-read. */
export const AI_MEDIA_DESCRIBE_LOOP_REFRESH_MS = 15_000;
/** Rows drained per wake before the loop looks again. */
export const AI_MEDIA_DESCRIBE_LOOP_DRAIN_LIMIT = 10;
/** A lane that cannot progress (stopped, breaker, no key) is not polled harder. */
export const AI_MEDIA_DESCRIBE_LOOP_BACKOFF_MS = 60_000;

export interface AiMediaDescribeLoopState {
  enabled: boolean;
  pageIds: number[];
  refreshedAt: number;
  backoffUntil: number;
}

export function createAiMediaDescribeLoopState(): AiMediaDescribeLoopState {
  return { enabled: false, pageIds: [], refreshedAt: 0, backoffUntil: 0 };
}

/** One loop step; returns how many rows it claimed. */
export async function runAiMediaDescribeLoopTick(
  app: AppContext,
  state: AiMediaDescribeLoopState,
  overrides: Partial<AiMediaDescribeDeps> = {},
): Promise<number> {
  const clock = overrides.now ?? (() => new Date());
  const at = clock().getTime();
  if (at - state.refreshedAt >= AI_MEDIA_DESCRIBE_LOOP_REFRESH_MS) {
    const effective = await loadEffectiveConfig(app.db, app.config);
    state.enabled = effective.aiMediaDescribeEnabled === true && effective.aiMediaDescribeLoopEnabled === true;
    state.pageIds = state.enabled
      ? await listActiveAiMediaDescribePageIds(app, effective.aiMediaDescribePagePolicies, clock())
      : [];
    state.refreshedAt = at;
  }
  if (!state.enabled || state.pageIds.length === 0 || at < state.backoffUntil) {
    return 0;
  }
  if (!(await hasDueAiMediaDescriptions(app.db, { pageIds: state.pageIds, now: clock() }))) {
    return 0;
  }
  const result = await runAiMediaDescribeSweepJob(app, overrides, { limit: AI_MEDIA_DESCRIBE_LOOP_DRAIN_LIMIT });
  if (result.skipped || result.claimed === 0) {
    // Due rows it cannot take now (a stop, a breaker, another worker's lease):
    // look again after a pause instead of every second.
    state.backoffUntil = at + AI_MEDIA_DESCRIBE_LOOP_BACKOFF_MS;
  }
  if (result.claimed > 0) {
    app.logger.info(result, "AI media describe loop drained");
  }
  return result.claimed;
}

export function startAiMediaDescribeLoop(app: AppContext) {
  const state = createAiMediaDescribeLoopState();
  let stopped = false;
  let running: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (stopped || running) {
      return;
    }
    running = runAiMediaDescribeLoopTick(app, state)
      .then(() => undefined)
      .catch((error: unknown) => {
        state.backoffUntil = Date.now() + AI_MEDIA_DESCRIBE_LOOP_BACKOFF_MS;
        app.logger.warn({ err: error instanceof Error ? error.name : "error" }, "AI media describe loop tick failed");
      })
      .finally(() => {
        running = null;
      });
  }, AI_MEDIA_DESCRIBE_LOOP_INTERVAL_MS);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
