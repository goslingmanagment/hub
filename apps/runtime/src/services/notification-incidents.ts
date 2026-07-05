import {
  clearPageSyncAuthBlock,
  getTelegramSettings,
  hasRecentTerminalProxyFailure,
  insertDeliveryAttempt,
  openNotificationIncidentWithRecoveryGuard,
  recordNotificationIncidentRecovery,
  resolveNotificationIncident,
  type NotificationIncidentKind,
  type SyncStream,
} from "@agency_hub_core/db";
import { redactSensitiveText } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { sendTelegramMessage, type TelegramSendResult } from "./telegram.ts";

const STREAM_FAILURE_THRESHOLD = 3;

function incidentKey(
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    stream?: SyncStream | null;
  },
) {
  if (input.platformAccountId === null) {
    // Account-global OFAPI incidents (low credit, webhook silence).
    return `${input.kind}:global`;
  }
  return input.kind === "stream_failed_threshold" && input.stream
    ? `${input.kind}:${input.platformAccountId}:${input.stream}`
    : `${input.kind}:${input.platformAccountId}`;
}

function summarizeError(errorSummary: string | null | undefined) {
  if (!errorSummary) {
    return "Unknown error";
  }

  const sanitized = redactSensitiveText(errorSummary).trim();
  return sanitized.length <= 240 ? sanitized : `${sanitized.slice(0, 237)}...`;
}

function openTitleForIncident(kind: NotificationIncidentKind) {
  switch (kind) {
    case "auth_blocked":
      return "🚨 Auth failed";
    case "proxy_failed":
      return "🚨 Proxy failed";
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
    `Error: ${summarizeError(input.errorSummary)}`,
  ].join("\n");
}

function resolveMessageForIncident(
  input: {
    kind: NotificationIncidentKind;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
  },
) {
  const detail = input.kind === "auth_blocked"
    ? "Auth failed"
    : input.kind === "proxy_failed"
      ? "Proxy failed"
      : input.kind === "stream_failed_threshold"
        ? `Stream ${input.stream ?? "unknown"} recovered`
        : input.kind === "ofapi_auth"
          ? "OFAPI account auth recovered"
          : input.kind === "ofapi_low_credit"
            ? "OFAPI credit balance recovered"
            : input.kind === "ofapi_burn_rate"
              ? "OFAPI credit burn rate back to normal"
              : input.kind === "db_disk_usage"
                ? "Server disk usage back under the threshold"
                : input.kind === "observations_partitions"
                  ? "Observations partition lead restored"
                  : "OFAPI webhooks delivering again";

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
  app: Pick<AppContext, "db" | "logger" | "config">,
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    stream?: SyncStream | null;
    errorCode?: string | null;
    errorSummary?: string | null;
    occurredAt?: Date;
  },
) {
  try {
    const occurredAt = input.occurredAt ?? new Date();
    const result = await openNotificationIncidentWithRecoveryGuard(app.db, {
      incidentKey: incidentKey(input),
      kind: input.kind,
      platformAccountId: input.platformAccountId,
      stream: input.stream ?? null,
      errorCode: input.errorCode ?? null,
      errorSummary: summarizeError(input.errorSummary),
      metadata: {
        pageLabel: input.pageLabel,
        platform: input.platform,
        stream: input.stream ?? null,
      },
      occurredAt,
    });

    if (result.transition === "existing" || result.transition === "suppressed" || !result.incident) {
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
      notificationIncidentId: result.incident.id,
      ...deliveryAttemptFields(delivery),
    });
  } catch (error) {
    app.logger.warn({
      platformAccountId: input.platformAccountId,
      incidentKind: input.kind,
      err: error,
    }, "Notification incident open failed; continuing");
  }
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
  app: Pick<AppContext, "db" | "logger" | "config">,
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    pageLabel: string | null;
    platform: "fansly" | "onlyfans" | null;
    recoveredAt?: Date;
    stream?: SyncStream | null;
  },
) {
  const recoveredAt = input.recoveredAt ?? new Date();
  const metadata = {
    pageLabel: input.pageLabel,
    platform: input.platform,
    stream: input.stream ?? null,
  };
  try {
    await recordNotificationIncidentRecovery(app.db, {
      incidentKey: incidentKey(input),
      recoveredAt,
      metadata,
      now: recoveredAt,
    });
    const resolved = await resolveNotificationIncident(app.db, {
      incidentKey: incidentKey(input),
      maxLastSeenAt: recoveredAt,
      now: recoveredAt,
      metadata,
    });

    if (!resolved) {
      return;
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

    if ((input.previousConsecutiveFailures + 1) !== STREAM_FAILURE_THRESHOLD) {
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
  await resolveIncidentAndNotify(app, {
    ...input,
    kind: "stream_failed_threshold",
    recoveredAt,
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

/** Process-global conditions (low credit balance, webhook silence, burn rate, disk usage, partition lead). */
export async function notifyOfapiGlobalIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    kind: "ofapi_low_credit" | "ofapi_webhook_silence" | "ofapi_burn_rate" | "db_disk_usage" | "observations_partitions" | "read_gateway_capture";
    errorSummary: string;
    occurredAt?: Date;
  },
) {
  await openIncidentAndNotify(app, {
    kind: input.kind,
    platformAccountId: null,
    pageLabel: null,
    platform: null,
    errorSummary: input.errorSummary,
    occurredAt: input.occurredAt,
  });
}

export async function resolveOfapiGlobalIncident(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    kind: "ofapi_low_credit" | "ofapi_webhook_silence" | "ofapi_burn_rate" | "db_disk_usage" | "observations_partitions" | "read_gateway_capture";
    recoveredAt?: Date;
  },
) {
  await resolveIncidentAndNotify(app, {
    kind: input.kind,
    platformAccountId: null,
    pageLabel: null,
    platform: null,
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
) {
  const recoveredAt = input.recoveredAt ?? new Date();
  try {
    await clearPageSyncAuthBlock(app.db, input.platformAccountId, {
      maxFailureAt: recoveredAt,
      now: recoveredAt,
    });
  } catch (error) {
    app.logger.warn({
      platformAccountId: input.platformAccountId,
      err: error,
    }, "Failed to clear auth_blocked during page verification recovery");
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
}
