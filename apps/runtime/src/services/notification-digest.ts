import {
  getLatestScheduledReportDateOnOrBefore,
  getTelegramSettings,
  insertDeliveryAttempt,
  listNotificationIncidentCyclesSince,
  listNotificationIncidentsWithPages,
  type NotificationIncidentCycleWithPage,
  type NotificationIncidentKind,
  type NotificationIncidentWithPage,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { incidentTitleForKind, parseIncidentSubKey } from "./notification-incidents.ts";
import { formatDurationShort } from "./notification-paging-policy.ts";
import { sendTelegramMessage, type TelegramSendResult } from "./telegram.ts";

// Decision 381: the one daily line about alerting. Standing incidents that
// nobody has looked at, and the episodes that healed before they were worth a
// page, both used to be invisible — the first because a latch pages once and
// then goes silent, the second because the old path paged every one of them
// and the owner stopped reading. The digest rides with the revenue report and
// is skipped entirely when there is nothing to say.

export const ALERT_DIGEST_WINDOW_MS = 24 * 60 * 60_000;
const MAX_OPEN_LINES = 12;
const MAX_QUIET_LINES = 10;

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function subjectLabel(input: {
  kind: NotificationIncidentKind;
  subKey: string | null;
  pageLabel: string | null;
  platform: "fansly" | "onlyfans" | null;
}): string {
  const title = incidentTitleForKind({ kind: input.kind, subKey: input.subKey });
  return input.pageLabel
    ? `${title} — ${input.pageLabel}${input.platform ? ` (${input.platform})` : ""}`
    : title;
}

export interface AlertDigestInput {
  now: Date;
  windowMs?: number;
  open: readonly NotificationIncidentWithPage[];
  cycles: readonly NotificationIncidentCycleWithPage[];
}

/** Null when there is nothing worth a message. Exported for the text tests. */
export function renderAlertDigest(input: AlertDigestInput): string | null {
  const windowMs = input.windowMs ?? ALERT_DIGEST_WINDOW_MS;
  const paged = input.cycles.filter((cycle) => cycle.paged);
  const quiet = input.cycles.filter((cycle) => !cycle.paged);
  if (input.open.length === 0 && input.cycles.length === 0) {
    return null;
  }

  const lines: string[] = [`🩺 <b>Alerts · last ${formatDurationShort(windowMs)}</b>`];

  if (input.open.length > 0) {
    lines.push("", "<b>Open now</b>");
    const sorted = [...input.open].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
    for (const incident of sorted.slice(0, MAX_OPEN_LINES)) {
      const subKey = parseIncidentSubKey({
        incidentKey: incident.incidentKey,
        kind: incident.kind,
        stream: incident.stream,
      });
      const label = subjectLabel({
        kind: incident.kind,
        subKey,
        pageLabel: incident.pageLabel,
        platform: incident.platform,
      });
      const age = formatDurationShort(input.now.getTime() - incident.openedAt.getTime());
      lines.push(`• ${escapeHtml(label)} · ${age}`);
    }
    if (sorted.length > MAX_OPEN_LINES) {
      lines.push(`• … and ${sorted.length - MAX_OPEN_LINES} more`);
    }
  }

  const summary = [
    paged.length > 0 ? `${paged.length} paged` : null,
    quiet.length > 0 ? `${quiet.length} quiet episode${quiet.length === 1 ? "" : "s"} healed before paging` : null,
  ].filter((part): part is string => part !== null);
  if (summary.length > 0) {
    lines.push("", `<b>Window</b>: ${summary.join(" · ")}`);
  }

  if (quiet.length > 0) {
    const groups = new Map<string, { label: string; count: number; longestMs: number }>();
    for (const cycle of quiet) {
      const subKey = parseIncidentSubKey({
        incidentKey: cycle.incidentKey,
        kind: cycle.kind,
        stream: cycle.stream,
      });
      const label = subjectLabel({
        kind: cycle.kind,
        subKey,
        pageLabel: cycle.pageLabel,
        platform: cycle.platform,
      });
      const end = cycle.resolvedAt ?? input.now;
      const durationMs = Math.max(0, end.getTime() - cycle.openedAt.getTime());
      const group = groups.get(label) ?? { label, count: 0, longestMs: 0 };
      group.count += 1;
      group.longestMs = Math.max(group.longestMs, durationMs);
      groups.set(label, group);
    }
    const ordered = [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    for (const group of ordered.slice(0, MAX_QUIET_LINES)) {
      lines.push(
        `• ${escapeHtml(group.label)}: ${group.count} episode${group.count === 1 ? "" : "s"}, `
        + `longest ${formatDurationShort(group.longestMs)}`,
      );
    }
    if (ordered.length > MAX_QUIET_LINES) {
      lines.push(`• … and ${ordered.length - MAX_QUIET_LINES} more`);
    }
  }

  return lines.join("\n");
}

export async function buildAlertDigest(
  app: Pick<AppContext, "db">,
  now = new Date(),
): Promise<string | null> {
  const since = new Date(now.getTime() - ALERT_DIGEST_WINDOW_MS);
  const [open, cycles] = await Promise.all([
    listNotificationIncidentsWithPages(app.db, { status: "open", limit: 200 }),
    listNotificationIncidentCyclesSince(app.db, { since }),
  ]);
  return renderAlertDigest({ now, open: open.items, cycles });
}

export type AlertDigestDelivery =
  | TelegramSendResult
  | { status: "skipped"; reason: "disabled" | "empty" | "already_sent" };

/**
 * Once per report date, idempotent through the `alert_digest_scheduled`
 * attempt row exactly like the revenue report. An empty digest records
 * nothing, so a later run the same day can still send one if something
 * happens — the window is measured from the send instant, not the date.
 */
export async function sendScheduledAlertDigest(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: { reportDate: string; now?: Date },
): Promise<AlertDigestDelivery> {
  const now = input.now ?? new Date();
  const settings = await getTelegramSettings(app.db, {
    defaultReportHourUtc: app.config.telegramReportHourUtc,
  });
  if (!settings.enabled || !settings.syncFailureAlertsEnabled) {
    return { status: "skipped", reason: "disabled" };
  }
  const latest = await getLatestScheduledReportDateOnOrBefore(
    app.db,
    input.reportDate,
    "alert_digest_scheduled",
  );
  if (latest === input.reportDate) {
    return { status: "skipped", reason: "already_sent" };
  }

  const text = await buildAlertDigest(app, now);
  if (text === null) {
    return { status: "skipped", reason: "empty" };
  }

  const delivery = await sendTelegramMessage(app, { text, parseMode: "HTML" });
  await insertDeliveryAttempt(app.db, {
    kind: "alert_digest_scheduled",
    status: delivery.status,
    reportDate: input.reportDate,
    messageId: delivery.status === "sent" ? delivery.messageId : null,
    error: delivery.status === "failed"
      ? delivery.error
      : delivery.status === "skipped"
        ? delivery.reason
        : null,
  });
  return delivery;
}
