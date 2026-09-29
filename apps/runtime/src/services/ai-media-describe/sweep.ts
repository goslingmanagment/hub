import type { AppContext } from "../../bootstrap.ts";
import { ensureQueueCreated, type QueueCreationClient } from "../sync-queue.ts";
import {
  createPageProxyMediaDescribeClientFactory,
  type MediaDescribeClientFactory,
} from "./describer.ts";
import {
  runAiMediaDescribeSweep,
  type AiMediaDescribeDeps,
  type AiMediaSource,
} from "./worker.ts";
import type { AiMediaPlatform } from "@agency_hub_core/db";
import { fanslyAiMediaSource } from "./fansly-source.ts";
import { onlyfansAiMediaSource } from "./onlyfans-source.ts";

// Minutely AI media describer sweep (docs/runbooks/ai-media-describe.md).
// The worker consumes; the scheduler role owns the cron. A disabled lane is a
// single effective-config read per minute.

export const AI_MEDIA_DESCRIBE_SWEEP_QUEUE = "ai.media.describe.sweep";

export async function ensureAiMediaDescribeSweepQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, AI_MEDIA_DESCRIBE_SWEEP_QUEUE, {
    policy: "exclusive",
  }, createdQueues);
}

export async function ensureAiMediaDescribeSweepSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(AI_MEDIA_DESCRIBE_SWEEP_QUEUE, "*/1 * * * *", null, { tz: "UTC" });
}

/** Platform source adapters (Fansly capture; OnlyFans free locators in H4). */
export const AI_MEDIA_SOURCES = new Map<AiMediaPlatform, AiMediaSource>([
  ["fansly", fanslyAiMediaSource],
  ["onlyfans", onlyfansAiMediaSource],
]);

/** The separate describer key when set, else the main Anthropic key. */
export function resolveAiMediaDescribeClientFactory(
  config: Pick<AppContext["config"], "anthropicApiKey" | "anthropicMediaApiKey">,
): MediaDescribeClientFactory | null {
  const key = config.anthropicMediaApiKey ?? config.anthropicApiKey ?? null;
  return key ? createPageProxyMediaDescribeClientFactory(key) : null;
}

// One describe slot per process: the minutely job and the seconds loop share
// it, so libvips and the provider still see at most one image at a time.
let describeSlot: Promise<unknown> = Promise.resolve();

function withDescribeSlot<T>(run: () => Promise<T>): Promise<T> {
  const next = describeSlot.then(run, run);
  describeSlot = next.catch(() => undefined);
  return next;
}

export async function runAiMediaDescribeSweepJob(
  app: AppContext,
  overrides: Partial<AiMediaDescribeDeps> = {},
  options: { limit?: number; shouldContinue?: () => boolean } = {},
) {
  return withDescribeSlot(() => runAiMediaDescribeSweep(app, {
    sources: AI_MEDIA_SOURCES,
    clientFactory: resolveAiMediaDescribeClientFactory(app.config),
    ...overrides,
  }, options));
}
