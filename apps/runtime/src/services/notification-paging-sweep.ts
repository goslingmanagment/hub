import {
  enqueueNotificationDeliveryOutbox,
  hasManualIncidentResolveSince,
  listNotificationPagingCandidates,
  markNotificationIncidentCyclesPaged,
  recordNotificationIncidentCycle,
  settleNotificationIncidentCycle,
  summarizeNotificationIncidentCycles,
  upsertNotificationIncidentPaging,
  type Database,
  type NotificationPagingCandidate,
  type SyncStream,
} from "@agency_hub_core/db";
import type { PgBoss, Queue } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import {
  openMessageForIncident,
  parseIncidentSubKey,
  resolveMessageForIncident,
} from "./notification-incidents.ts";
import {
  NOTIFICATION_PAGING_EXCLUDED_KINDS,
  decideNotificationPaging,
  formatDurationShort,
  notificationPagingPolicyFor,
  type NotificationPagingDecision,
  type NotificationPagingPolicy,
} from "./notification-paging-policy.ts";
import {
  ensureQueueCreated,
  type QueueCreationClient,
  type SyncQueueLifecycleClient,
} from "./sync-queue.ts";

// Decision 381: the minutely sweep that turns latch state into pages. The
// producers only flip latches now; nothing reaches Telegram except through
// this sweep and the durable outbox it enqueues into. One place decides, one
// place delivers, and both are idempotent on the incident's own timestamps.

export const NOTIFICATION_PAGING_SWEEP_QUEUE = "notifications.paging.sweep";
/** Episodes that resolved earlier than this were either recorded by an
 * earlier sweep or are older than anything the digest reports. */
const RESOLVED_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;

const notificationPagingSweepQueueOptions = {
  policy: "exclusive",
  expireInSeconds: 300,
  heartbeatSeconds: 30,
  retryLimit: 0,
} satisfies Omit<Queue, "name">;

export async function ensureNotificationPagingSweepQueue(
  boss: SyncQueueLifecycleClient,
  createdQueues?: Set<string>,
): Promise<void> {
  await ensureQueueCreated(
    boss,
    NOTIFICATION_PAGING_SWEEP_QUEUE,
    notificationPagingSweepQueueOptions,
    createdQueues,
  );
}

export async function ensureNotificationPagingSweepSchedule(
  boss: QueueCreationClient,
): Promise<void> {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(NOTIFICATION_PAGING_SWEEP_QUEUE, "* * * * *", null, {
    tz: "UTC",
  });
}

export interface NotificationPagingSweepResult {
  examined: number;
  episodesRecorded: number;
  paged: number;
  resolved: number;
  silentlyResolved: number;
  failed: number;
}

type SweepApp = Pick<AppContext, "db" | "logger">;

function toMs(value: Date | string): number {
  return (value instanceof Date ? value : new Date(value)).getTime();
}

function subKeyOf(candidate: NotificationPagingCandidate): string | null {
  return parseIncidentSubKey({
    incidentKey: candidate.incidentKey,
    kind: candidate.kind,
    stream: candidate.stream,
  });
}

/** Exported for the message tests: the open page plus the one line that says
 * why it is worth reading now. */
export function renderPagingOpenMessage(input: {
  candidate: NotificationPagingCandidate;
  decision: Extract<NotificationPagingDecision, { action: "page" }>;
  policy: NotificationPagingPolicy;
  episodesInWindow: number;
  now: Date;
}): string {
  const { candidate, decision, policy, now } = input;
  const base = openMessageForIncident({
    kind: candidate.kind,
    pageLabel: candidate.pageLabel,
    platform: candidate.platform,
    stream: candidate.stream as SyncStream | null,
    subKey: subKeyOf(candidate),
    errorSummary: candidate.errorSummary,
  });
  if (decision.mode === "sustained") {
    const openFor = formatDurationShort(now.getTime() - candidate.openedAt.getTime());
    const episodes = policy.flap && input.episodesInWindow > 1
      ? ` · ${input.episodesInWindow} episodes in the last ${formatDurationShort(policy.flap.windowMs)}`
      : "";
    return `${base}\nOpen for ${openFor}${episodes}`;
  }
  if (decision.mode === "flapping" && policy.flap) {
    return `${base}\nFlapping: ${input.episodesInWindow} episodes in the last `
      + `${formatDurationShort(policy.flap.windowMs)}, each healing before the `
      + `${formatDurationShort(policy.openHoldMs)} hold`;
  }
  return base;
}

export function renderPagingResolvedMessage(input: {
  candidate: NotificationPagingCandidate;
  pagedOpenedAt: Date | null;
  pagedMode: "immediate" | "sustained" | "flapping" | null;
  resolvedAt: Date;
  now: Date;
}): string {
  const { candidate } = input;
  const base = resolveMessageForIncident({
    kind: candidate.kind,
    pageLabel: candidate.pageLabel,
    platform: candidate.platform,
    stream: candidate.stream as SyncStream | null,
    subKey: subKeyOf(candidate),
  });
  const quiet = formatDurationShort(input.now.getTime() - input.resolvedAt.getTime());
  if (!input.pagedOpenedAt) {
    return `${base}\nQuiet for ${quiet}`;
  }
  const span = formatDurationShort(input.resolvedAt.getTime() - input.pagedOpenedAt.getTime());
  const verb = input.pagedMode === "flapping" ? "flapped for" : "was open";
  return `${base}\nQuiet for ${quiet} · ${verb} ${span}`;
}

async function evaluateCandidate(
  app: SweepApp,
  candidate: NotificationPagingCandidate,
  now: Date,
  result: NotificationPagingSweepResult,
): Promise<void> {
  const paging = candidate.paging;
  const standing = paging?.pagedAt !== null && paging?.pagedAt !== undefined
    && paging.pagedResolvedAt === null;

  // 1. Episode bookkeeping. The latch rewrites opened_at on every reopen, so
  //    an opened_at past the last one we saw is a new episode — even when the
  //    whole episode began and ended between two sweeps. An episode that
  //    starts under a standing page is covered by that page, not "quiet".
  const newEpisode = !paging || candidate.openedAt.getTime() > toMs(paging.observedOpenedAt);
  if (newEpisode) {
    await recordNotificationIncidentCycle(app.db, {
      notificationIncidentId: candidate.incidentId,
      incidentKey: candidate.incidentKey,
      kind: candidate.kind,
      platformAccountId: candidate.platformAccountId,
      openedAt: candidate.openedAt,
      resolvedAt: candidate.status === "resolved" ? candidate.resolvedAt : null,
      paged: standing,
      now,
    });
    result.episodesRecorded += 1;
  }
  if (candidate.status === "resolved" && candidate.resolvedAt) {
    await settleNotificationIncidentCycle(app.db, {
      notificationIncidentId: candidate.incidentId,
      openedAt: candidate.openedAt,
      resolvedAt: candidate.resolvedAt,
    });
  }

  // 2. Decide.
  const policy = notificationPagingPolicyFor(candidate.kind, subKeyOf(candidate));
  const window = policy.flap
    ? await summarizeNotificationIncidentCycles(app.db, {
      notificationIncidentId: candidate.incidentId,
      since: new Date(now.getTime() - policy.flap.windowMs),
    })
    : { count: 0, earliestOpenedAt: null };
  const manuallyResolvedSincePage = standing && candidate.status === "resolved" && paging?.pagedAt
    ? await hasManualIncidentResolveSince(app.db, {
      notificationIncidentId: candidate.incidentId,
      since: paging.pagedAt,
    })
    : false;
  const decision = decideNotificationPaging({
    status: candidate.status,
    openedAt: candidate.openedAt,
    resolvedAt: candidate.resolvedAt,
    paging: paging
      ? {
        pagedAt: paging.pagedAt,
        pagedOpenedAt: paging.pagedOpenedAt,
        pagedMode: paging.pagedMode,
        pagedResolvedAt: paging.pagedResolvedAt,
      }
      : null,
    episodesInWindow: window.count,
    earliestEpisodeInWindowAt: window.earliestOpenedAt,
    manuallyResolvedSincePage,
  }, policy, now);

  // 3. Apply. The outbox row and the paging state commit together: a page
  //    that was enqueued is a page the state knows about, and vice versa.
  if (decision.action === "none") {
    if (newEpisode || paging?.observedStatus !== candidate.status) {
      await upsertNotificationIncidentPaging(app.db, {
        notificationIncidentId: candidate.incidentId,
        observedOpenedAt: candidate.openedAt,
        observedStatus: candidate.status,
        now,
      });
    }
    return;
  }

  if (decision.action === "page") {
    const messageText = renderPagingOpenMessage({
      candidate,
      decision,
      policy,
      episodesInWindow: window.count,
      now,
    });
    await app.db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      await enqueueNotificationDeliveryOutbox(txDb, {
        notificationIncidentId: candidate.incidentId,
        transition: decision.transition,
        transitionAt: decision.transitionAt,
        request: {
          channel: "telegram",
          messageText,
          pagingPolicy: "sync_failure",
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
        },
        now,
      });
      await upsertNotificationIncidentPaging(txDb, {
        notificationIncidentId: candidate.incidentId,
        observedOpenedAt: candidate.openedAt,
        observedStatus: candidate.status,
        pagedOpenedAt: decision.coveredOpenedAt,
        pagedAt: now,
        pagedMode: decision.mode,
        pagedResolvedAt: null,
        now,
      });
      await markNotificationIncidentCyclesPaged(txDb, {
        notificationIncidentId: candidate.incidentId,
        since: decision.coveredOpenedAt,
      });
    });
    result.paged += 1;
    return;
  }

  const messageText = decision.silent
    ? null
    : renderPagingResolvedMessage({
      candidate,
      pagedOpenedAt: paging?.pagedOpenedAt ?? null,
      pagedMode: paging?.pagedMode ?? null,
      resolvedAt: decision.transitionAt,
      now,
    });
  await app.db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    if (messageText !== null) {
      await enqueueNotificationDeliveryOutbox(txDb, {
        notificationIncidentId: candidate.incidentId,
        transition: "resolved",
        transitionAt: decision.transitionAt,
        request: {
          channel: "telegram",
          messageText,
          pagingPolicy: "sync_failure",
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
        },
        now,
      });
    }
    await upsertNotificationIncidentPaging(txDb, {
      notificationIncidentId: candidate.incidentId,
      observedOpenedAt: candidate.openedAt,
      observedStatus: candidate.status,
      pagedResolvedAt: now,
      now,
    });
  });
  if (decision.silent) {
    result.silentlyResolved += 1;
  } else {
    result.resolved += 1;
  }
}

/**
 * One pass over every latch the policy owns. Failures are per incident: a
 * broken row is logged and the rest of the pass continues, and nothing here
 * throws back into pg-boss (there is nothing to retry — the next minute
 * re-evaluates from the same durable state).
 */
export async function runNotificationPagingSweep(
  app: SweepApp,
  input?: { now?: Date },
): Promise<NotificationPagingSweepResult> {
  const now = input?.now ?? new Date();
  const result: NotificationPagingSweepResult = {
    examined: 0,
    episodesRecorded: 0,
    paged: 0,
    resolved: 0,
    silentlyResolved: 0,
    failed: 0,
  };
  const candidates = await listNotificationPagingCandidates(app.db, {
    resolvedSince: new Date(now.getTime() - RESOLVED_LOOKBACK_MS),
    excludeKinds: NOTIFICATION_PAGING_EXCLUDED_KINDS,
  });
  result.examined = candidates.length;
  for (const candidate of candidates) {
    try {
      await evaluateCandidate(app, candidate, now, result);
    } catch (error) {
      result.failed += 1;
      app.logger.warn({
        incidentKey: candidate.incidentKey,
        err: error,
      }, "Notification paging evaluation failed; continuing with the next incident");
    }
  }
  return result;
}

export function startNotificationPagingSweepWorker(
  app: Pick<AppContext, "db" | "logger">,
  boss: Pick<PgBoss, "work">,
): Promise<string> {
  return boss.work(NOTIFICATION_PAGING_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    const result = await runNotificationPagingSweep(app);
    if (result.paged > 0 || result.resolved > 0 || result.failed > 0) {
      app.logger.info(result, "Notification paging sweep complete");
    }
  });
}
