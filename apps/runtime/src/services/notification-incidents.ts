import {
  clearPageSyncAuthBlock,
  getIncidentOpenedDeliveryState,
  getTelegramSettings,
  hasRecentTerminalProxyFailure,
  insertDeliveryAttempt,
  openNotificationIncidentWithRecoveryGuard,
  recoverAndResolveNotificationIncident,
  type NotificationIncidentRow,
  type NotificationIncidentKind,
  type SyncStream,
} from "@agency_hub_core/db";
import { sanitizeError, type SanitizeErrorOptions } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { sendTelegramMessage, type TelegramSendResult } from "./telegram.ts";

const STREAM_FAILURE_THRESHOLD = 3;
const INCIDENT_ERROR_OPTIONS = {
  maxChars: 240,
  truncation: "ellipsis",
  trim: true,
} satisfies SanitizeErrorOptions;
// W3.3 (D3-N1): total incident_opened attempts allowed per incident before
// the re-send loop gives up. Pacing comes free from the monitor cadence.
const MAX_OPEN_DELIVERY_ATTEMPTS = 5;
type CriticalIncidentApp = Pick<AppContext, "db"> & {
  logger: Pick<AppContext["logger"], "warn">;
};
type DirectIncidentApp = Pick<AppContext, "db" | "logger" | "config">;
type IncidentApp = CriticalIncidentApp | DirectIncidentApp;

function isDirectIncidentApp(app: IncidentApp): app is DirectIncidentApp {
  return "config" in app;
}

export function incidentKey(
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    stream?: SyncStream | null;
    subKey?: string | null;
  },
) {
  if (input.platformAccountId === null) {
    // Account-global OFAPI incidents (low credit, webhook silence).
    // W5.1 (A25): an optional subKey splits the latch per condition —
    // golden_signal_lag:global:<metric> — so a standing breach on one
    // signal can no longer mask every other signal behind one shared key.
    return input.subKey
      ? `${input.kind}:global:${input.subKey}`
      : `${input.kind}:global`;
  }
  const pageKey = input.kind === "stream_failed_threshold" && input.stream
    ? `${input.kind}:${input.platformAccountId}:${input.stream}`
    : `${input.kind}:${input.platformAccountId}`;
  // No pre-Stage-1A caller combined a page id with subKey, so adding the
  // suffix fixes the silently-colliding shape without changing an existing
  // latch identity. Stream keeps its historical position before the suffix.
  return input.subKey ? `${pageKey}:${input.subKey}` : pageKey;
}

function openTitleForIncident(kind: NotificationIncidentKind) {
  switch (kind) {
    case "auth_blocked":
      return "🚨 Auth failed";
    case "proxy_failed":
      return "🚨 Proxy failed";
    case "proxy_missing":
      return "🚨 Fansly proxy missing — sync refused (fail-closed)";
    case "stream_failed_threshold":
      return "🚨 Stream failed 3x in a row";
    case "ofapi_auth":
      return "🚨 OFAPI account auth needs attention";
    case "ofapi_low_credit":
      return "🚨 OFAPI credit balance low";
    case "ofapi_webhook_silence":
      return "🚨 OFAPI webhooks silent";
    case "ofapi_burn_rate":
      return "🚨 OFAPI credit burn rate high";
    case "db_disk_usage":
      return "🚨 Server disk usage high";
    case "observations_partitions":
      return "🚨 Observations partition lead too short";
    case "wrong_transactions_writer":
      return "🚨 Wrong transactions writer refused";
    case "read_gateway_capture":
      return "🚨 Read-gateway capture tee dropping";
    case "golden_signal_lag":
      return "🚨 Golden-signal lag over threshold";
    case "scheduler_silent":
      return "🚨 Scheduler heartbeat silent — cron is not firing";
    case "ops_sampler_silent":
      return "🚨 Golden-signal sampler silent — ops telemetry is blind";
    case "ofapi_chargebacks_reconcile_failed":
      return "🚨 OFAPI chargebacks reconcile failed";
    case "ofapi_link_stats_reconcile_failed":
      return "🚨 OFAPI link-stats reconcile failed";
    case "ai_provider_billing":
      return "🚨 AI provider billing needs attention";
    case "ai_provider_failed":
      return "🚨 AI provider generation failed";
  }
}

function openMessageForIncident(
  input: {
    kind: NotificationIncidentKind;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
    errorSummary: string | null;
  },
) {
  return [
    openTitleForIncident(input.kind),
    ...(input.pageLabel ? [`Page: ${input.pageLabel}${input.platform ? ` (${input.platform})` : ""}`] : []),
    ...(input.stream ? [`Stream: ${input.stream}`] : []),
    `Error: ${sanitizeError(
      input.errorSummary || "Unknown error",
      INCIDENT_ERROR_OPTIONS,
    ).message}`,
  ].join("\n");
}

/** Exhaustive over NotificationIncidentKind — a missing case is a compile
 * error, not a fallthrough into another kind's text (review R2-7: the old
 * ternary resolved golden_signal_lag as "OFAPI webhooks delivering again"). */
function resolveDetailForIncident(
  input: { kind: NotificationIncidentKind; stream?: SyncStream | null },
): string {
  switch (input.kind) {
    case "auth_blocked":
      return "Auth failed";
    case "proxy_failed":
      return "Proxy failed";
    case "proxy_missing":
      return "Proxy assigned; Fansly egress restored";
    case "stream_failed_threshold":
      return `Stream ${input.stream ?? "unknown"} recovered`;
    case "ofapi_auth":
      return "OFAPI account auth recovered";
    case "ofapi_low_credit":
      return "OFAPI credit balance recovered";
    case "ofapi_burn_rate":
      return "OFAPI credit burn rate back to normal";
    case "db_disk_usage":
      return "Server disk usage back under the threshold";
    case "observations_partitions":
      return "Observations partition lead restored";
    case "ofapi_webhook_silence":
      return "OFAPI webhooks delivering again";
    case "wrong_transactions_writer":
      return "Transactions writer conflict cleared";
    case "read_gateway_capture":
      return "Read-gateway capture tee healthy again";
    case "golden_signal_lag":
      return "Golden-signal lag back under threshold";
    case "scheduler_silent":
      return "Scheduler heartbeat back; cron firing again";
    case "ops_sampler_silent":
      return "Golden-signal sampler emitting again";
    case "ofapi_chargebacks_reconcile_failed":
      return "OFAPI chargebacks reconcile recovered";
    case "ofapi_link_stats_reconcile_failed":
      return "OFAPI link-stats reconcile recovered";
    case "ai_provider_billing":
      return "AI provider billing recovered";
    case "ai_provider_failed":
      return "AI provider generation recovered";
  }
}

/** Exported for tests (the resolve-text regression pins the per-kind lines). */
export function resolveMessageForIncident(
  input: {
    kind: NotificationIncidentKind;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
  },
) {
  const detail = resolveDetailForIncident(input);

  return [
    "✅ Resolved",
    input.pageLabel
      ? `${detail}: ${input.pageLabel}${input.platform ? ` (${input.platform})` : ""}`
      : detail,
  ].join("\n");
}

function deliveryAttemptFields(delivery: TelegramSendResult) {
  return {
    status: delivery.status,
    messageId: delivery.status === "sent" ? delivery.messageId : null,
    error: delivery.status === "failed"
      ? delivery.error
      : delivery.status === "skipped"
        ? delivery.reason
        : null,
  };
}

async function openIncidentAndNotify(
  app: IncidentApp,
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
    subKey?: string | null;
    errorCode?: string | null;
    errorSummary?: string | null;
    occurredAt?: Date;
    deliveryMode?: "direct" | "critical_outbox";
  },
): Promise<boolean> {
  // Returns whether an incident row exists for this condition (opened now or
  // already open). False = the open itself failed — callers with their own
  // once-only latches (read-gateway capture) re-arm on false; this function
  // never throws, so a rejected promise can't carry that signal.
  try {
    const occurredAt = input.occurredAt ?? new Date();
    const outboxMessage = input.deliveryMode === "critical_outbox"
      ? openMessageForIncident({
        ...input,
        errorSummary: input.errorSummary ?? null,
      })
      : null;
    const result = await openNotificationIncidentWithRecoveryGuard(app.db, {
      incidentKey: incidentKey(input),
      kind: input.kind,
      platformAccountId: input.platformAccountId,
      stream: input.stream ?? null,
      errorCode: input.errorCode ?? null,
      errorSummary: sanitizeError(
        input.errorSummary || "Unknown error",
        INCIDENT_ERROR_OPTIONS,
      ).message,
      metadata: {
        pageLabel: input.pageLabel,
        platform: input.platform,
        stream: input.stream ?? null,
      },
      occurredAt,
      ...(outboxMessage
        ? {
          outbox: {
            channel: "telegram" as const,
            messageText: outboxMessage,
            pagingPolicy: "ai_critical" as const,
            maxAttempts: MAX_OPEN_DELIVERY_ATTEMPTS,
          },
        }
        : {}),
    });

    if (result.transition === "existing" || result.transition === "suppressed" || !result.incident) {
      // W3.3 (D3-N1): "existing" used to return BEFORE the Telegram send, so
      // one transient send failure at open time lost that incident's page
      // permanently — every later monitor pass on the standing condition
      // re-hit this branch. If the open notification never reached Telegram,
      // re-send here (capped; delivery is at-least-once — a process death
      // between the Telegram accept and the attempt insert can page twice,
      // preferable to permanent pager loss).
      if (
        input.deliveryMode !== "critical_outbox"
        && result.transition === "existing"
        && result.incident
        && result.incident.status === "open"
      ) {
        if (!isDirectIncidentApp(app)) {
          throw new Error("Direct notification incident delivery requires runtime config");
        }
        await retryUndeliveredOpenNotification(app, input, result.incident);
      }
      return true;
    }
    if (input.deliveryMode === "critical_outbox") {
      return true;
    }
    if (!isDirectIncidentApp(app)) {
      throw new Error("Direct notification incident delivery requires runtime config");
    }

    const settings = await getTelegramSettings(app.db, {
      defaultReportHourUtc: app.config.telegramReportHourUtc,
    });
    if (!settings.enabled || !settings.syncFailureAlertsEnabled) {
      return true;
    }

    const delivery = await sendTelegramMessage(app, {
      text: openMessageForIncident({
        ...input,
        errorSummary: input.errorSummary ?? null,
      }),
    });

    await insertDeliveryAttempt(app.db, {
      kind: "incident_opened",
      notificationIncidentId: result.incident.id,
      ...deliveryAttemptFields(delivery),
    });
    return true;
  } catch (error) {
    app.logger.warn({
      platformAccountId: input.platformAccountId,
      incidentKind: input.kind,
      err: error,
    }, "Notification incident open failed; continuing");
    return false;
  }
}

/**
 * W3.3 (D3-N1): re-send an incident's open notification when no attempt has
 * ever reached Telegram. totalCount === 0 means alerts were disabled when the
 * incident opened (no attempt was recorded) — that stays silent on purpose;
 * a later re-enable must not page for every incident opened while off.
 */
async function retryUndeliveredOpenNotification(
  app: Pick<AppContext, "db" | "logger" | "config">,
  input: {
    kind: NotificationIncidentKind;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
    errorSummary?: string | null;
  },
  incident: NotificationIncidentRow,
) {
  const state = await getIncidentOpenedDeliveryState(app.db, incident.id);
  if (
    state.sentCount > 0
    || state.totalCount === 0
    || state.totalCount >= MAX_OPEN_DELIVERY_ATTEMPTS
  ) {
    return;
  }

  const settings = await getTelegramSettings(app.db, {
    defaultReportHourUtc: app.config.telegramReportHourUtc,
  });
  if (!settings.enabled || !settings.syncFailureAlertsEnabled) {
    return;
  }

  const delivery = await sendTelegramMessage(app, {
    text: openMessageForIncident({
      ...input,
      errorSummary: input.errorSummary ?? null,
    }),
  });

  await insertDeliveryAttempt(app.db, {
    kind: "incident_opened",
    notificationIncidentId: incident.id,
    ...deliveryAttemptFields(delivery),
  });
}

/**
 * Stage 13 single-writer gate: a write path attempted transactions for a page
 * whose registered writer is someone else (or unassigned). Opens immediately —
 * no failure-streak threshold; a refused write is a config/ops defect, not a
 * transient. Deduped by the incident key (kind + page) until recovery.
 */
export async function notifyWrongTransactionsWriterIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    attemptedWriter: string;
    assignedWriter: string | null;
  },
) {
  await openIncidentAndNotify(app, {
    kind: "wrong_transactions_writer",
    platformAccountId: input.platformAccountId,
    pageLabel: input.pageLabel,
    platform: input.platform,
    errorCode: "wrong_transactions_writer",
    errorSummary: `'${input.attemptedWriter}' attempted to write transactions for a page whose writer is ${
      input.assignedWriter ? `'${input.assignedWriter}'` : "unassigned"
    }`,
  });
}

async function resolveIncidentAndNotify(
  app: IncidentApp,
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    recoveredAt?: Date;
    stream?: SyncStream | null;
    subKey?: string | null;
    deliveryMode?: "direct" | "critical_outbox";
  },
) {
  const recoveredAt = input.recoveredAt ?? new Date();
  const metadata = {
    pageLabel: input.pageLabel,
    platform: input.platform,
    stream: input.stream ?? null,
  };
  try {
    const resolved = await recoverAndResolveNotificationIncident(app.db, {
      incidentKey: incidentKey(input),
      recoveredAt,
      processedAt: recoveredAt,
      metadata,
      ...(input.deliveryMode === "critical_outbox"
        ? {
          outbox: {
            channel: "telegram" as const,
            messageText: resolveMessageForIncident(input),
            pagingPolicy: "ai_critical" as const,
            maxAttempts: MAX_OPEN_DELIVERY_ATTEMPTS,
          },
        }
        : {}),
    });

    if (!resolved) {
      return;
    }
    if (input.deliveryMode === "critical_outbox") {
      return;
    }
    if (!isDirectIncidentApp(app)) {
      throw new Error("Direct notification incident delivery requires runtime config");
    }

    const settings = await getTelegramSettings(app.db, {
      defaultReportHourUtc: app.config.telegramReportHourUtc,
    });
    if (!settings.enabled || !settings.syncFailureAlertsEnabled) {
      return;
    }

    const delivery = await sendTelegramMessage(app, {
      text: resolveMessageForIncident(input),
    });

    await insertDeliveryAttempt(app.db, {
      kind: "incident_resolved",
      notificationIncidentId: resolved.id,
      ...deliveryAttemptFields(delivery),
    });
  } catch (error) {
    app.logger.warn({
      platformAccountId: input.platformAccountId,
      incidentKind: input.kind,
      err: error,
    }, "Notification incident resolve failed; continuing");
  }
}

export type CriticalNotificationIncidentKind =
  | "ai_provider_billing"
  | "ai_provider_failed";

/**
 * Stage 1A infrastructure seam, activated by Stage 1B's AI producers. The
 * incident transition and its durable Telegram outbox row commit atomically.
 * Critical paging is independent from syncFailureAlertsEnabled and defaults
 * to persisted suppression.
 */
export async function openCriticalNotificationIncident(
  app: CriticalIncidentApp,
  input: {
    kind: CriticalNotificationIncidentKind;
    platformAccountId: number | null;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
    subKey?: string | null;
    errorCode?: string | null;
    errorSummary?: string | null;
    occurredAt?: Date;
  },
): Promise<boolean> {
  return openIncidentAndNotify(app, {
    ...input,
    deliveryMode: "critical_outbox",
  });
}

/** Matching durable resolve seam used by Stage 1B success terminals. */
export async function resolveCriticalNotificationIncident(
  app: CriticalIncidentApp,
  input: {
    kind: CriticalNotificationIncidentKind;
    platformAccountId: number | null;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
    subKey?: string | null;
    recoveredAt?: Date;
  },
) {
  await resolveIncidentAndNotify(app, {
    ...input,
    deliveryMode: "critical_outbox",
  });
}

async function hasTerminalProxyFailure(
  app: Pick<AppContext, "db">,
  runId: number,
) {
  return hasRecentTerminalProxyFailure(app.db, {
    runId,
    limit: 2_000,
  });
}

export async function notifyAuthFailedIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    errorCode?: string | null;
    errorSummary: string;
    occurredAt?: Date;
  },
) {
  await openIncidentAndNotify(app, {
    ...input,
    kind: "auth_blocked",
  });
}

export async function notifySyncChunkFailureIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    stream: SyncStream;
    runId: number;
    hasProxy: boolean;
    previousConsecutiveFailures: number;
    forceOpen?: boolean;
    errorCode?: string | null;
    errorSummary: string;
    occurredAt?: Date;
  },
) {
  try {
    if (input.hasProxy && await hasTerminalProxyFailure(app, input.runId)) {
      await openIncidentAndNotify(app, {
        ...input,
        kind: "proxy_failed",
      });
      return;
    }

    // W3.3 (A36): `<`, not exact equality — after a manual resolve mid-streak
    // the count never equals the threshold again, so exact-match meant no
    // re-alert ever. At-or-above keeps hitting the open path: dedupe handles
    // the standing case, the `reopened` transition restores post-resolve
    // alerting, and the D3-N1 retry covers a lost open send.
    if (!input.forceOpen && (input.previousConsecutiveFailures + 1) < STREAM_FAILURE_THRESHOLD) {
      return;
    }

    await openIncidentAndNotify(app, {
      ...input,
      kind: "stream_failed_threshold",
    });
  } catch (error) {
    app.logger.warn({
      platformAccountId: input.platformAccountId,
      stream: input.stream,
      err: error,
    }, "Sync chunk failure notification evaluation failed; continuing");
  }
}

export async function resolveSyncChunkRecoveryIncidents(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    recoveredAt?: Date;
    stream: SyncStream;
  },
) {
  const recoveredAt = input.recoveredAt ?? new Date();
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "auth_blocked",
    recoveredAt,
  });
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "proxy_failed",
    recoveredAt,
  });
  // W3.1: a successful chunk implies the page context resolved, which the
  // fail-closed guard only allows with a proxy present.
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "proxy_missing",
    recoveredAt,
  });
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "stream_failed_threshold",
    recoveredAt,
  });
}

/**
 * W3.1 (B6+A35, decision #124): the fail-closed egress guard refused to
 * resolve a Fansly page context because no proxy is stored. Opens
 * immediately — a missing proxy is a config/erasure aftermath, not a
 * transient. Deduped by kind+page until a proxy is assigned and the page
 * verifies or syncs again.
 */
export async function notifyProxyMissingIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    errorSummary: string;
    occurredAt?: Date;
  },
) {
  await openIncidentAndNotify(app, {
    kind: "proxy_missing",
    platformAccountId: input.platformAccountId,
    pageLabel: input.pageLabel,
    platform: "fansly",
    errorCode: "proxy_missing",
    errorSummary: input.errorSummary,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
}

/** Debounced alert for OFAPI accounts.* auth states (decision #49, Phase 3). */
export async function notifyOfapiAuthIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    authStatus: string;
    occurredAt?: Date;
  },
) {
  await openIncidentAndNotify(app, {
    kind: "ofapi_auth",
    platformAccountId: input.platformAccountId,
    pageLabel: input.pageLabel,
    platform: input.platform,
    errorCode: input.authStatus,
    errorSummary: `OFAPI reported accounts.${input.authStatus}`,
    occurredAt: input.occurredAt,
  });
}

export async function resolveOfapiAuthIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    recoveredAt?: Date;
  },
) {
  await resolveIncidentAndNotify(app, {
    kind: "ofapi_auth",
    platformAccountId: input.platformAccountId,
    pageLabel: input.pageLabel,
    platform: input.platform,
    recoveredAt: input.recoveredAt,
  });
}

type GlobalIncidentKind =
  | "ofapi_low_credit"
  | "ofapi_webhook_silence"
  | "ofapi_burn_rate"
  | "db_disk_usage"
  | "observations_partitions"
  | "read_gateway_capture"
  | "golden_signal_lag"
  | "scheduler_silent"
  | "ops_sampler_silent"
  | "ofapi_chargebacks_reconcile_failed"
  | "ofapi_link_stats_reconcile_failed";

/** Process-global conditions (low credit balance, webhook silence, burn rate,
 * disk usage, partition lead, watchdog deadmen). W5.1 (A25): `subKey` splits
 * the latch per condition within a kind (golden_signal_lag per metric). */
export async function notifyOfapiGlobalIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    kind: GlobalIncidentKind;
    errorSummary: string;
    subKey?: string | null;
    occurredAt?: Date;
  },
): Promise<boolean> {
  return openIncidentAndNotify(app, {
    kind: input.kind,
    platformAccountId: null,
    pageLabel: null,
    platform: null,
    subKey: input.subKey ?? null,
    errorSummary: input.errorSummary,
    occurredAt: input.occurredAt,
  });
}

export async function resolveOfapiGlobalIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    kind: GlobalIncidentKind;
    subKey?: string | null;
    recoveredAt?: Date;
  },
) {
  await resolveIncidentAndNotify(app, {
    kind: input.kind,
    platformAccountId: null,
    pageLabel: null,
    platform: null,
    subKey: input.subKey ?? null,
    recoveredAt: input.recoveredAt,
  });
}

export async function handleSuccessfulPageVerificationRecovery(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    recoveredAt?: Date;
  },
): Promise<{ syncUnblocked: boolean }> {
  const recoveredAt = input.recoveredAt ?? new Date();
  try {
    await clearPageSyncAuthBlock(app.db, input.platformAccountId, {
      maxFailureAt: recoveredAt,
      now: recoveredAt,
    });
  } catch (error) {
    // W3.3 (D4-N1): the streams are still blocked, so the incidents are
    // still TRUE — resolving them here would report a recovery that did not
    // happen while credential-update kept returning verified:true. The
    // caller surfaces syncUnblocked:false instead.
    app.logger.warn({
      platformAccountId: input.platformAccountId,
      err: error,
    }, "Failed to clear auth_blocked during page verification recovery; incidents stay open");
    return { syncUnblocked: false };
  }

  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "auth_blocked",
    recoveredAt,
  });
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "proxy_failed",
    recoveredAt,
  });
  // W3.1: a successful verification reached Fansly, which the fail-closed
  // dispatcher only allows with a proxy present.
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "proxy_missing",
    recoveredAt,
  });
  return { syncUnblocked: true };
}
