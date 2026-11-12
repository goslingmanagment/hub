import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { listNotificationPagingCandidates, type NotificationPagingCandidate, type NotificationPagingMode, type SyncStream } from "@agency_hub_core/db";
import { sql } from "drizzle-orm";

import type { AppContext } from "../bootstrap.ts";
import { loadAlertDigestInput, renderAlertDigest } from "./notification-digest.ts";
import { openMessageForIncident, parseIncidentSubKey, resolveMessageForIncident } from "./notification-incidents.ts";
import { NOTIFICATION_PAGING_EXCLUDED_KINDS, notificationPagingPolicyFor } from "./notification-paging-policy.ts";
import { renderPagingOpenMessage, renderPagingResolvedMessage } from "./notification-paging-sweep.ts";
import type { NotificationLanguage } from "./notification-ru.ts";
import {
  buildDailyRevenueReportCaption,
  buildDailyRevenueTelegramReport,
  renderDailyRevenueTelegramReport,
} from "./telegram-report.ts";
import { renderDailyRevenueReportImage } from "./telegram-report-image.ts";

/**
 * `cli telegram compare`: Hub's Telegram messages in both languages from ONE
 * read of the same facts, so the owner can check the Russian says what the
 * English says before `telegramRussian` is switched on. Reads only and sends
 * nothing: it runs against the read-only production viewer's database.
 */

export interface ComparedMessage {
  what: string;
  en: string;
  ru: string;
  /** What Telegram really got for this incident last (English today), when there is one. */
  sent?: string;
}

const LOOKBACK_MS = 30 * 24 * 60 * 60_000;

async function lastSentText(app: Pick<AppContext, "db">, incidentId: number, transition: "opened" | "resolved"): Promise<string | undefined> {
  const transitions = transition === "opened" ? ["opened", "reopened"] : ["resolved"];
  const result = await app.db.execute<{ message_text: string }>(sql`
    select message_text from notification_delivery_outbox
     where notification_incident_id = ${incidentId}
       and transition in (${sql.join(transitions.map((value) => sql`${value}`), sql`, `)})
     order by created_at desc
     limit 1
  `);
  return result.rows[0]?.message_text;
}

function incidentMessages(candidate: NotificationPagingCandidate, now: Date): Array<{ what: string; render: (language: NotificationLanguage) => string; transition: "opened" | "resolved" }> {
  const subKey = parseIncidentSubKey({ incidentKey: candidate.incidentKey, kind: candidate.kind, stream: candidate.stream });
  const about = {
    kind: candidate.kind,
    pageLabel: candidate.pageLabel,
    platform: candidate.platform,
    stream: candidate.stream as SyncStream | null,
    subKey,
  };
  if ((NOTIFICATION_PAGING_EXCLUDED_KINDS as readonly string[]).includes(candidate.kind)) {
    // The AI critical kinds page at the transition itself, without the sweep's lines.
    return [
      { what: `incident ${candidate.incidentId} ${candidate.incidentKey}: opened`, transition: "opened", render: (language) => openMessageForIncident({ ...about, errorSummary: candidate.errorSummary }, language) },
      ...(candidate.status === "resolved"
        ? [{ what: `incident ${candidate.incidentId} ${candidate.incidentKey}: resolved`, transition: "resolved" as const, render: (language: NotificationLanguage) => resolveMessageForIncident({ ...about, resolution: candidate.resolution }, language) }]
        : []),
    ];
  }
  const policy = notificationPagingPolicyFor(candidate.kind, subKey, candidate.errorSummary);
  const mode = (candidate.paging?.pagedMode ?? "immediate") as NotificationPagingMode;
  const coveredOpenedAt = candidate.paging?.pagedOpenedAt ?? candidate.openedAt;
  const messages: Array<{ what: string; render: (language: NotificationLanguage) => string; transition: "opened" | "resolved" }> = [{
    what: `incident ${candidate.incidentId} ${candidate.incidentKey}: opened (${mode})`,
    transition: "opened",
    render: (language) => renderPagingOpenMessage({
      candidate,
      decision: { action: "page", mode, transition: "opened", transitionAt: coveredOpenedAt, coveredOpenedAt },
      policy,
      episodesInWindow: 1,
      // A sustained page goes out once its hold has passed: «Open for» says that hold.
      now: mode === "sustained" && Number.isFinite(policy.openHoldMs) ? new Date(candidate.openedAt.getTime() + policy.openHoldMs) : now,
      language,
    }),
  }];
  if (candidate.status === "resolved" && candidate.resolvedAt) {
    const resolvedAt = candidate.resolvedAt;
    messages.push({
      what: `incident ${candidate.incidentId} ${candidate.incidentKey}: resolved`,
      transition: "resolved",
      render: (language) => renderPagingResolvedMessage({
        candidate,
        pagedOpenedAt: candidate.paging?.pagedOpenedAt ?? candidate.openedAt,
        pagedMode: mode,
        resolvedAt,
        now: new Date(resolvedAt.getTime() + policy.recoveryHoldMs),
        language,
      }),
    });
  }
  return messages;
}

export async function compareNotificationLanguages(
  app: Pick<AppContext, "db" | "logger">,
  input: { now?: Date; incidents?: number; imagesDir?: string | null },
): Promise<ComparedMessage[]> {
  const now = input.now ?? new Date();
  const out: ComparedMessage[] = [];

  // The daily report: one build, both renderings of its data.
  const report = await buildDailyRevenueTelegramReport(app, now, now, "en");
  const { text: _text, parseMode: _parseMode, ...data } = report;
  out.push({ what: `daily report ${report.reportDate}: text`, en: report.text, ru: renderDailyRevenueTelegramReport(data, "ru") });
  out.push({ what: `daily report ${report.reportDate}: caption`, en: buildDailyRevenueReportCaption(report, "en"), ru: buildDailyRevenueReportCaption(report, "ru") });
  if (input.imagesDir) {
    for (const language of ["en", "ru"] as const) {
      try {
        writeFileSync(join(input.imagesDir, `daily-report-${report.reportDate}-${language}.png`), await renderDailyRevenueReportImage(data, language));
      } catch (error) {
        app.logger.warn({ err: error, language }, "Report image did not render (chromium?); the text versions stand");
      }
    }
  }

  // The alert digest: one read, both renderings.
  const digest = await loadAlertDigestInput(app, now);
  out.push({
    what: "alert digest",
    en: renderAlertDigest({ ...digest, language: "en" }) ?? "(nothing to say: no message)",
    ru: renderAlertDigest({ ...digest, language: "ru" }) ?? "(нечего сказать: сообщения нет)",
  });

  // The incidents: the open and the resolved message of the latest ones, beside what Telegram really got.
  const candidates = await listNotificationPagingCandidates(app.db, { resolvedSince: new Date(now.getTime() - LOOKBACK_MS) });
  const latest = [...candidates]
    .sort((a, b) => (b.resolvedAt ?? b.openedAt).getTime() - (a.resolvedAt ?? a.openedAt).getTime())
    .slice(0, input.incidents ?? 20);
  for (const candidate of latest) {
    for (const message of incidentMessages(candidate, now)) {
      const sent = await lastSentText(app, candidate.incidentId, message.transition);
      out.push({ what: message.what, en: message.render("en"), ru: message.render("ru"), ...(sent === undefined ? {} : { sent }) });
    }
  }
  return out;
}
