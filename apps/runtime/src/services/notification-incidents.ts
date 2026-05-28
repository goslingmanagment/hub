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
import { sendTelegramMessage } from "./telegram.ts";

const STREAM_FAILURE_THRESHOLD = 3;

function incidentKey(
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number;
    stream?: SyncStream | null;
  },
) {
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

function openMessageForIncident(
  input: {
    kind: NotificationIncidentKind;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    stream?: SyncStream | null;
    errorSummary: string | null;
  },
) {
  const title = input.kind === "auth_blocked"
    ? "🚨 Auth failed"
    : input.kind === "proxy_failed"
      ? "🚨 Proxy failed"
      : "🚨 Stream failed 3x in a row";

  return [
    title,
    `Page: ${input.pageLabel} (${input.platform})`,
    ...(input.stream ? [`Stream: ${input.stream}`] : []),
    `Error: ${summarizeError(input.errorSummary)}`,
  ].join("\n");
}

function resolveMessageForIncident(
  input: {
    kind: NotificationIncidentKind;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    stream?: SyncStream | null;
  },
) {
  const detail = input.kind === "auth_blocked"
    ? "Auth failed"
    : input.kind === "proxy_failed"
      ? "Proxy failed"
      : `Stream ${input.stream ?? "unknown"} recovered`;

  return [
    "✅ Resolved",
    `${detail}: ${input.pageLabel} (${input.platform})`,
  ].join("\n");
}

async function openIncidentAndNotify(
  app: Pick<AppContext, "db" | "logger" | "config">,
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
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

    if (delivery.status === "sent" || delivery.status === "failed") {
      await insertDeliveryAttempt(app.db, {
        kind: "incident_opened",
        status: delivery.status,
        notificationIncidentId: result.incident.id,
        messageId: delivery.status === "sent" ? delivery.messageId : null,
        error: delivery.status === "failed" ? delivery.error : null,
      });
    }
  } catch (error) {
    app.logger.warn({
      platformAccountId: input.platformAccountId,
      incidentKind: input.kind,
      err: error,
    }, "Notification incident open failed; continuing");
  }
}

async function resolveIncidentAndNotify(
  app: Pick<AppContext, "db" | "logger" | "config">,
  input: {
    kind: NotificationIncidentKind;
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
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

    if (delivery.status === "sent" || delivery.status === "failed") {
      await insertDeliveryAttempt(app.db, {
        kind: "incident_resolved",
        status: delivery.status,
        notificationIncidentId: resolved.id,
        messageId: delivery.status === "sent" ? delivery.messageId : null,
        error: delivery.status === "failed" ? delivery.error : null,
      });
    }
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
