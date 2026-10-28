import { createHash } from "node:crypto";

import { anthropicKeyPoolEntries, type AnthropicAdminKeyEntry } from "@agency_hub_core/shared";
import {
  listAiProviderAccounts,
  recordAiProviderKeyMappings,
  recordAiProviderReportAttempt,
  recordAiProviderReportFailure,
  saveAiProviderReports,
  setAiProviderAccountOrg,
  type AiProviderReportApiKey,
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

/** "sk-ant-api03-R2D...igAA" → its visible start and end. */
export function parseKeyHint(hint: string | null) {
  const match = hint?.match(/^(.+?)(?:\.{3}|…)(.+)$/);
  return match ? { prefix: match[1]!, suffix: match[2]! } : null;
}

/** The listed keys whose hint (start…end) fits exactly one of the accounts'
 * configured keys: key id → label. */
export function hintMatches(
  labels: ReadonlyArray<{ label: string; apiKey: string | null }>,
  listedKeys: readonly AiProviderReportApiKey[],
): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const key of listedKeys) {
    const hint = parseKeyHint(key.hint);
    if (!hint) continue;
    const fits = labels.filter(({ apiKey }) =>
      apiKey !== null
      && apiKey.length > hint.prefix.length + hint.suffix.length
      && apiKey.startsWith(hint.prefix)
      && apiKey.endsWith(hint.suffix));
    if (fits.length === 1) {
      mapped.set(key.id, fits[0]!.label);
    }
  }
  return mapped;
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
      // What the hints prove now is kept: once the key rotates, its history
      // stays its account's.
      const accounts = await listAiProviderAccounts(app.db, "anthropic");
      const configured = anthropicKeyPoolEntries(app.config);
      const hinted = hintMatches(
        group.labels.map((label) => ({ label, apiKey: configured.find((entry) => entry.label === label)?.apiKey ?? null })),
        apiKeys,
      );
      await recordAiProviderKeyMappings(app.db, {
        orgId: org.id,
        mappings: [...hinted].flatMap(([apiKeyId, label]) => {
          const accountId = accounts.find((account) => account.label === label)?.id;
          const listed = apiKeys.find((key) => key.id === apiKeyId);
          return accountId === undefined ? [] : [{
            apiKeyId, accountId, source: "hint" as const, keyName: listed?.name ?? null, keyHint: listed?.hint ?? null,
          }];
        }),
        at: now,
      });
      for (const label of group.labels) {
        const account = accounts.find((row) => row.label === label);
        if (account) await setAiProviderAccountOrg(app.db, { accountId: account.id, orgId: org.id, at: now });
      }
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
