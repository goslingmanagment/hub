import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { telegramSettings, telegramDeliveryAttempts } from "../schema.ts";

export type TelegramSettingsRow = typeof telegramSettings.$inferSelect;
export type TelegramDeliveryAttemptRow = typeof telegramDeliveryAttempts.$inferSelect;
export type TelegramDeliveryKind =
  | "test"
  | "daily_report_scheduled"
  | "daily_report_manual"
  | "incident_opened"
  | "incident_resolved"
  | "incident_manually_resolved";
export type TelegramDeliveryStatus = "sent" | "failed" | "skipped";

export async function getTelegramSettings(
  db: Database,
  input?: {
    defaultReportHourUtc?: number;
  },
): Promise<TelegramSettingsRow> {
  const row = await db.query.telegramSettings.findFirst();
  if (row) return row;

  const [inserted] = await db
    .insert(telegramSettings)
    .values({
      id: 1,
      reportHourUtc: input?.defaultReportHourUtc ?? 9,
    })
    .onConflictDoNothing()
    .returning();

  return inserted ?? (await db.query.telegramSettings.findFirst())!;
}

export async function updateTelegramSettings(
  db: Database,
  patch: {
    enabled?: boolean;
    dailyReportEnabled?: boolean;
    syncFailureAlertsEnabled?: boolean;
    reportHourUtc?: number;
    encryptedBotToken?: string | null;
    chatId?: string | null;
  },
): Promise<TelegramSettingsRow> {
  // Bump the credential watermark only when the token/chat id actually appear in
  // the patch — a flag or report-hour edit must not reset the verified status.
  const credentialsChanged = patch.encryptedBotToken !== undefined || patch.chatId !== undefined;
  const now = new Date();
  const [updated] = await db
    .update(telegramSettings)
    .set({
      ...patch,
      updatedAt: now,
      ...(credentialsChanged ? { credentialsUpdatedAt: now } : {}),
    })
    .where(eq(telegramSettings.id, 1))
    .returning();

  return updated;
}

export async function insertDeliveryAttempt(
  db: Database,
  input: {
    kind: TelegramDeliveryKind;
    status: TelegramDeliveryStatus;
    notificationIncidentId?: number | null;
    reportDate?: string | null;
    messageId?: number | null;
    error?: string | null;
  },
): Promise<TelegramDeliveryAttemptRow> {
  const [row] = await db
    .insert(telegramDeliveryAttempts)
    .values({
      kind: input.kind,
      status: input.status,
      notificationIncidentId: input.notificationIncidentId ?? null,
      reportDate: input.reportDate ?? null,
      messageId: input.messageId ?? null,
      error: input.error ?? null,
    })
    .returning();

  return row;
}

export async function listDeliveryAttempts(
  db: Database,
  input?: {
    kind?: TelegramDeliveryKind[];
    limit?: number;
  },
): Promise<TelegramDeliveryAttemptRow[]> {
  const clauses = [];

  if (input?.kind && input.kind.length > 0) {
    clauses.push(inArray(telegramDeliveryAttempts.kind, input.kind));
  }

  return db.query.telegramDeliveryAttempts.findMany({
    where: clauses.length > 0 ? and(...clauses) : undefined,
    orderBy: [desc(telegramDeliveryAttempts.createdAt)],
    limit: input?.limit ?? 50,
  });
}

export async function getLatestDeliveryAttempt(
  db: Database,
): Promise<TelegramDeliveryAttemptRow | null> {
  const row = await db.query.telegramDeliveryAttempts.findFirst({
    orderBy: [desc(telegramDeliveryAttempts.createdAt)],
  });

  return row ?? null;
}

/**
 * Latest delivery that actually hit Telegram (sent or failed), ignoring
 * `skipped` attempts (unconfigured/disabled) which represent no real send. Used
 * to derive the connection status.
 */
export async function getLatestRealDeliveryAttempt(
  db: Database,
): Promise<TelegramDeliveryAttemptRow | null> {
  const row = await db.query.telegramDeliveryAttempts.findFirst({
    where: inArray(telegramDeliveryAttempts.status, ["sent", "failed"]),
    orderBy: [desc(telegramDeliveryAttempts.createdAt)],
  });

  return row ?? null;
}

export async function hasScheduledReportForDate(
  db: Database,
  reportDate: string,
): Promise<boolean> {
  const row = await db.query.telegramDeliveryAttempts.findFirst({
    where: and(
      eq(telegramDeliveryAttempts.kind, "daily_report_scheduled"),
      eq(telegramDeliveryAttempts.status, "sent"),
      eq(telegramDeliveryAttempts.reportDate, reportDate),
    ),
  });

  return !!row;
}

export async function getLatestScheduledReportDateOnOrBefore(
  db: Database,
  reportDate: string,
): Promise<string | null> {
  const row = await db.query.telegramDeliveryAttempts.findFirst({
    columns: {
      reportDate: true,
    },
    where: and(
      eq(telegramDeliveryAttempts.kind, "daily_report_scheduled"),
      eq(telegramDeliveryAttempts.status, "sent"),
      lte(telegramDeliveryAttempts.reportDate, reportDate),
    ),
    orderBy: [
      desc(telegramDeliveryAttempts.reportDate),
      desc(telegramDeliveryAttempts.createdAt),
    ],
  });

  return row?.reportDate ?? null;
}
