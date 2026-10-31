// What OnlyFans itself tells a page: its "OnlyFans" notifications tab (media
// taken down, a co-creator's consent withdrawn, rule reminders). From
// 2026-11-01 OnlyFans may hold a page's earnings on a mere suspicion of a
// breach, for anything it thinks harms its reputation, and when a request for
// information is not answered promptly. So every new notice pages the owner.
//
// The daily profile_notifications run reads the tab (catalog read
// `notifications_platform`); the observation and its snapshot are committed
// before this runs. A notice already latched — open or closed by the owner —
// never pages again, and one older than NEW_NOTICE_WINDOW_MS when first read
// is history: the first run finds months of them.

import { findPageById, getNotificationIncidentByKey } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  incidentKey,
  notifyOfapiPlatformNoticeIncident,
  ofapiPlatformNoticeSubKey,
} from "./notification-incidents.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";

export const OFAPI_PLATFORM_NOTICES_OPERATION = "ofapi_read_notifications_platform";
// Long enough that a page whose daily read failed for a few days still pages
// what it missed once the read works again.
const NEW_NOTICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface OfapiPlatformNotice {
  id: string;
  createdAt: Date;
  subType: string | null;
  reason: string | null;
  text: string;
}

function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** The vendor body: `{ data: { list, hasMore } }`; a bare `data` array too. */
export function parseOfapiPlatformNotices(body: unknown): OfapiPlatformNotice[] {
  const data = asRecord(body)?.data;
  const list = Array.isArray(data) ? data : asRecord(data)?.list;
  if (!Array.isArray(list)) return [];
  const notices: OfapiPlatformNotice[] = [];
  for (const raw of list) {
    const row = asRecord(raw);
    const id = row ? idToString(row.id) : null;
    const createdAt = typeof row?.createdAt === "string" ? new Date(row.createdAt) : null;
    if (!row || !id || !createdAt || Number.isNaN(createdAt.getTime())) continue;
    const subType = typeof row.subType === "string" && row.subType ? row.subType
      : typeof row.type === "string" && row.type ? row.type : null;
    notices.push({
      id,
      createdAt,
      subType,
      reason: plainText(asRecord(row.entity)?.reasonText) || null,
      text: plainText(row.text),
    });
  }
  return notices;
}

/** The incident's one line (cut to 240 characters by the incident text). */
export function ofapiPlatformNoticeSummary(notice: OfapiPlatformNotice): string {
  const at = `${notice.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return [at, notice.subType, notice.reason, notice.text].filter(Boolean).join(" · ");
}

export async function materializeOfapiPlatformNotices(
  app: AppContext,
  input: { pageId: number; body: unknown; now?: Date },
): Promise<{ paged: string[] }> {
  const now = input.now ?? new Date();
  const fresh = parseOfapiPlatformNotices(input.body)
    .filter((notice) => now.getTime() - notice.createdAt.getTime() <= NEW_NOTICE_WINDOW_MS);
  const paged: string[] = [];
  if (!fresh.length) return { paged };
  const stored = await findPageById(app.db, input.pageId);
  const pageLabel = stored?.page.label || stored?.page.username || String(input.pageId);
  for (const notice of fresh.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const key = incidentKey({
      kind: "ofapi_platform_notice",
      platformAccountId: input.pageId,
      subKey: ofapiPlatformNoticeSubKey(notice.id),
    });
    try {
      // Closed by the owner still counts: a notice pages once.
      if (await getNotificationIncidentByKey(app.db, key)) continue;
      const opened = await notifyOfapiPlatformNoticeIncident(app, {
        pageId: input.pageId,
        pageLabel,
        noticeId: notice.id,
        subType: notice.subType,
        summary: ofapiPlatformNoticeSummary(notice),
        // When Hub learned of it; the notice's own time is in the summary.
        occurredAt: now,
      });
      if (opened) paged.push(notice.id);
    } catch (error) {
      // The read is already journaled; tomorrow's read pages it again while it
      // is inside the window.
      app.logger.warn({ pageId: input.pageId, noticeId: notice.id, err: error }, "OnlyFans notice incident failed; next read retries");
    }
  }
  return { paged };
}
