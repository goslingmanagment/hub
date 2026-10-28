import { createHash } from "node:crypto";

import type { AnthropicAdminKeyEntry } from "@agency_hub_core/shared";
import {
  recordAiProviderReportAttempt,
  recordAiProviderReportFailure,
  saveAiProviderReports,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { createAnthropicAdminClient, type AnthropicAdminClient } from "./anthropic-admin-api.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

// The hourly read of Anthropic's own reports (Admin API) for each
// organization of ANTHROPIC_ADMIN_KEYS: the last 8 UTC days, upserted, so a
// day's numbers settle as the provider settles them. One organization's
// failure is recorded on its row and never stops the others.

export const AI_PROVIDER_REPORTS_QUEUE = "ai.provider-reports.sync";
export const AI_PROVIDER_REPORTS_DAYS = 8;
const DAY_MS = 86_400_000;

export async function ensureAiProviderReportsQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, AI_PROVIDER_REPORTS_QUEUE, { policy: "exclusive" }, createdQueues);
}

/** Hourly, off the hour's top (other lanes start there). */
export async function ensureAiProviderReportsSchedule(boss: QueueCreationClient) {
  await boss.schedule?.(AI_PROVIDER_REPORTS_QUEUE, "17 * * * *", null, { tz: "UTC" });
}

/** The admin key's name in the database: never the key. */
export function adminKeyFingerprint(adminKey: string) {
  return createHash("sha256").update(adminKey).digest("hex").slice(0, 16);
}

export interface AdminKeyGroup {
  fingerprint: string;
  adminKey: string;
  labels: string[];
}

/** One read per distinct admin key, whatever the number of labels on it. */
export function groupAdminKeys(entries: readonly AnthropicAdminKeyEntry[]): AdminKeyGroup[] {
  const groups = new Map<string, AdminKeyGroup>();
  for (const entry of entries) {
    const fingerprint = adminKeyFingerprint(entry.adminKey);
    const group = groups.get(fingerprint) ?? { fingerprint, adminKey: entry.adminKey, labels: [] };
    group.labels.push(entry.label);
    groups.set(fingerprint, group);
  }
  return [...groups.values()];
}

export function utcDayStart(at: Date) {
  return new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS);
}

export interface AiProviderReportsSyncResult {
  labels: string[];
  orgId: string | null;
  days: number;
  costLines: number;
  usageLines: number;
  error: string | null;
}

type SyncApp = Pick<AppContext, "db" | "config" | "logger">;

export async function syncAiProviderReports(
  app: SyncApp,
  options: {
    days?: number;
    now?: Date;
    clientFor?: (adminKey: string) => AnthropicAdminClient;
  } = {},
): Promise<AiProviderReportsSyncResult[]> {
  const now = options.now ?? new Date();
  const requested = Number.isFinite(options.days) ? Math.trunc(options.days!) : AI_PROVIDER_REPORTS_DAYS;
  const days = Math.min(Math.max(requested, 1), 31);
  const startingAt = new Date(utcDayStart(now).getTime() - (days - 1) * DAY_MS);
  const firstDay = startingAt.toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const clientFor = options.clientFor ?? ((adminKey: string) => createAnthropicAdminClient({ adminKey }));
  const results: AiProviderReportsSyncResult[] = [];
  const orgsRead = new Map<string, AiProviderReportsSyncResult>();

  for (const group of groupAdminKeys(app.config.anthropicAdminKeys ?? [])) {
    const result: AiProviderReportsSyncResult = {
      labels: group.labels, orgId: null, days: 0, costLines: 0, usageLines: 0, error: null,
    };
    results.push(result);
    try {
      await recordAiProviderReportAttempt(app.db, { fingerprint: group.fingerprint, at: now });
      const client = clientFor(group.adminKey);
      const org = await client.organization();
      result.orgId = org.id;
      const apiKeys = await client.apiKeys();
      // Two admin keys of one organization: its reports are read once a run;
      // the second key's row still learns its organization and its keys.
      const already = orgsRead.get(org.id);
      const [cost, usage] = already
        ? [{ days: [], lines: [] }, { days: [], lines: [] }]
        : await Promise.all([client.costReport(startingAt), client.usageReport(startingAt)]);
      const readDays = [...new Set([...cost.days, ...usage.days])]
        .filter((day) => day >= firstDay && day <= today)
        .sort();
      await saveAiProviderReports(app.db, {
        fingerprint: group.fingerprint,
        orgId: org.id,
        orgName: org.name,
        apiKeys,
        days: readDays,
        costLines: cost.lines.filter((line) => readDays.includes(line.day)),
        usageLines: usage.lines.filter((line) => readDays.includes(line.day)),
        fetchedAt: now,
      });
      result.days = already?.days ?? readDays.length;
      result.costLines = already?.costLines ?? cost.lines.length;
      result.usageLines = already?.usageLines ?? usage.lines.length;
      orgsRead.set(org.id, result);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      app.logger.warn(
        { labels: group.labels, err: { name: error instanceof Error ? error.name : "Error", message: result.error } },
        "Anthropic Admin API reports read failed",
      );
      try {
        await recordAiProviderReportFailure(app.db, { fingerprint: group.fingerprint, at: now, error: result.error });
      } catch (recordError) {
        app.logger.warn({ err: recordError }, "Recording the Anthropic reports failure failed");
      }
    }
  }
  return results;
}
