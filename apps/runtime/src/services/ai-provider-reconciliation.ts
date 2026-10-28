import type {
  AdminAiReconciliationResponse,
  AdminAiReconciliationRow,
} from "@agency_hub_core/contracts";
import {
  listAiProviderAccounts,
  listAiProviderReports,
  listAiProviderReportSyncs,
  listHubAnthropicSpendByDay,
  type AiProviderReportApiKey,
  type AiProviderReportSyncRow,
  type AiProviderUsageRow,
  type HubAnthropicSpendRow,
} from "@agency_hub_core/db";
import { anthropicKeyPoolEntries, microUsdFromCents } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { estimateAiGatewayUsageCost } from "./ai-gateway-pricing.ts";
import { adminKeyFingerprint, utcDayStart } from "./ai-provider-reports.ts";

// Hub's ledger (ai_usage_events) against Anthropic's bill (the Admin API
// reports ai-provider-reports.ts keeps), per account and UTC day. The cost
// report knows the organization, not the key: an organization's day is
// split between its keys by their usage priced with Hub's catalog, model by
// model, and what no Hub account's key spent is shown on its own line.

const DAY_MS = 86_400_000;
/** |diff| within 1% of the bill, or under a cent, is a match. */
const TOLERANCE_PERCENT = 1;
const TOLERANCE_FLOOR_MICRO_USD = 10_000;
/** The model of a cost that is no model's tokens (web search, code execution). */
const NO_MODEL = "";

export function utcDay(at: Date) {
  return at.toISOString().slice(0, 10);
}

export function utcDaysBack(now: Date, days: number) {
  const today = utcDayStart(now).getTime();
  return Array.from({ length: days }, (_, index) => utcDay(new Date(today - index * DAY_MS)));
}

// ─── API key → account ──────────────────────────────────────────────────────

/** "sk-ant-api03-R2D...igAA" → its visible start and end. */
export function parseKeyHint(hint: string | null) {
  const match = hint?.match(/^(.+?)(?:\.{3}|…)(.+)$/);
  return match ? { prefix: match[1]!, suffix: match[2]! } : null;
}

/**
 * Which of an organization's API keys are which Hub account's. A listed key
 * whose hint (start and end) fits exactly one account's configured key is
 * that account's. Failing that (personal `sk-ant-usr-…` keys may not be
 * listed at all), an organization only one account lives in, whose usage
 * shows exactly one key that no hint contradicts, is that account's. Every
 * other key is spend outside Hub.
 */
export function mapApiKeysToLabels(input: {
  labels: ReadonlyArray<{ label: string; apiKey: string | null }>;
  listedKeys: readonly AiProviderReportApiKey[];
  usedKeyIds: readonly string[];
}): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const key of input.listedKeys) {
    const hint = parseKeyHint(key.hint);
    if (!hint) continue;
    const fits = input.labels.filter(({ apiKey }) =>
      apiKey !== null
      && apiKey.length > hint.prefix.length + hint.suffix.length
      && apiKey.startsWith(hint.prefix)
      && apiKey.endsWith(hint.suffix));
    if (fits.length === 1) {
      mapped.set(key.id, fits[0]!.label);
    }
  }
  const used = [...new Set(input.usedKeyIds)];
  const only = input.labels.length === 1 ? input.labels[0]! : null;
  if (only && used.length === 1 && ![...mapped.values()].includes(only.label)) {
    const listed = input.listedKeys.find((key) => key.id === used[0]);
    if (!listed || parseKeyHint(listed.hint) === null) {
      mapped.set(used[0]!, only.label);
    }
  }
  return mapped;
}

// ─── An organization's day, split between its keys ──────────────────────────

interface KeyTokens {
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
}

/** A key's usage of one model as Hub's catalog prices it; an unknown model
 * (or usage too small to price) weighs its tokens instead. */
function pricedWeight(model: string, usage: KeyTokens) {
  try {
    return estimateAiGatewayUsageCost(`anthropic:${model}`, {
      inputTokens: usage.uncachedInputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheWriteTokens: usage.cacheWrite5mTokens + usage.cacheWrite1hTokens,
      cacheWrite5mTokens: usage.cacheWrite5mTokens,
      cacheWrite1hTokens: usage.cacheWrite1hTokens,
      outputTokens: usage.outputTokens,
    }).costMicroUsd;
  } catch {
    return null;
  }
}

function tokenWeight(usage: KeyTokens) {
  return usage.uncachedInputTokens + usage.cacheReadInputTokens + usage.cacheWrite5mTokens
    + usage.cacheWrite1hTokens + usage.outputTokens;
}

/** `whole` (integer micro-USD) in proportion to `weights`, largest remainder:
 * the parts always add up to `whole`. */
export function allocateMicroUsd(whole: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((total, weight) => total + weight, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => whole * (weight / sum));
  const parts = exact.map((value) => Math.floor(value));
  let rest = whole - parts.reduce((total, part) => total + part, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (const { index } of order) {
    if (rest <= 0) break;
    parts[index]! += 1;
    rest -= 1;
  }
  return parts;
}

export interface OrgDaySplit {
  /** The organization's bill, the exact sum of its lines rounded once. */
  totalMicroUsd: number;
  /** Per API key ("" = no key: the Console's workbench), per model. */
  keys: Map<string, Map<string, number>>;
  /** Bill no key's usage explains (cost of a model nobody's usage shows). */
  unsplitMicroUsd: number;
  /** More than one key spent: the shares are estimates. */
  shared: boolean;
}

export function splitOrgDay(input: {
  costs: ReadonlyArray<{ model: string | null; amountCents: string }>;
  usage: ReadonlyArray<Pick<AiProviderUsageRow, "apiKeyId" | "model"> & KeyTokens>;
}): OrgDaySplit {
  const totalMicroUsd = microUsdFromCents(input.costs.map((cost) => cost.amountCents));
  const keys = new Map<string, Map<string, number>>();
  const active = input.usage.filter((line) => tokenWeight(line) > 0);
  const add = (keyId: string, model: string, value: number) => {
    const models = keys.get(keyId) ?? new Map<string, number>();
    models.set(model, (models.get(model) ?? 0) + value);
    keys.set(keyId, models);
  };

  let unsplitMicroUsd = 0;
  const byModel = new Map<string, string[]>();
  for (const cost of input.costs) {
    const model = cost.model ?? NO_MODEL;
    byModel.set(model, [...(byModel.get(model) ?? []), cost.amountCents]);
  }
  for (const [model, amounts] of byModel) {
    const modelMicroUsd = microUsdFromCents(amounts);
    const lines = model === NO_MODEL ? active : active.filter((line) => line.model === model);
    const keyIds = [...new Set(lines.map((line) => line.apiKeyId ?? ""))];
    if (keyIds.length === 0) {
      unsplitMicroUsd += modelMicroUsd;
      continue;
    }
    const priced = keyIds.map((keyId) => lines.filter((line) => (line.apiKeyId ?? "") === keyId)
      .reduce<number | null>((total, line) => {
        const weight = pricedWeight(line.model, line);
        return total === null || weight === null ? null : total + weight;
      }, 0));
    const weights = priced.every((weight) => weight !== null) && priced.some((weight) => weight! > 0)
      ? priced.map((weight) => weight!)
      : keyIds.map((keyId) => lines.filter((line) => (line.apiKeyId ?? "") === keyId)
        .reduce((total, line) => total + tokenWeight(line), 0));
    allocateMicroUsd(modelMicroUsd, weights).forEach((part, index) => add(keyIds[index]!, model, part));
  }

  // Each model was rounded on its own; the cents of the whole day are rounded
  // once. The few micro-USD between them go to the largest share.
  const allocated = [...keys.values()].flatMap((models) => [...models.values()])
    .reduce((total, value) => total + value, 0) + unsplitMicroUsd;
  const drift = totalMicroUsd - allocated;
  if (drift !== 0) {
    let largest: { keyId: string; model: string; value: number } | null = null;
    for (const [keyId, models] of keys) {
      for (const [model, value] of models) {
        if (!largest || value > largest.value) largest = { keyId, model, value };
      }
    }
    if (largest) add(largest.keyId, largest.model, drift);
    else unsplitMicroUsd += drift;
  }
  return { totalMicroUsd, keys, unsplitMicroUsd, shared: new Set(active.map((line) => line.apiKeyId ?? "")).size > 1 };
}

// ─── The comparison ─────────────────────────────────────────────────────────

export function reconciliationStatus(input: {
  day: string;
  now: Date;
  hubMicroUsd: number;
  providerMicroUsd: number;
}): "ok" | "mismatch" | "open" {
  if (input.day >= utcDay(new Date(utcDayStart(input.now).getTime() - DAY_MS))) return "open";
  const diff = Math.abs(input.hubMicroUsd - input.providerMicroUsd);
  return diff < TOLERANCE_FLOOR_MICRO_USD || diff * 100 <= Math.abs(input.providerMicroUsd) * TOLERANCE_PERCENT
    ? "ok"
    : "mismatch";
}

/** The sum, or null when any part is unknown. */
function knownSum(values: ReadonlyArray<number | null>) {
  return values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + value!, 0);
}

function diffPercent(hub: number, provider: number) {
  if (provider === 0) return hub === 0 ? 0 : null;
  return Number((((hub - provider) / provider) * 100).toFixed(1));
}

export interface ReconciliationInput {
  now: Date;
  days: readonly string[];
  accounts: ReadonlyArray<{ id: number; label: string }>;
  /** ANTHROPIC_API_KEYS (configured keys, for the hints). */
  apiKeys: ReadonlyArray<{ label: string; apiKey: string }>;
  /** ANTHROPIC_ADMIN_KEYS. */
  adminKeys: ReadonlyArray<{ label: string; adminKey: string }>;
  syncs: readonly AiProviderReportSyncRow[];
  reports: Awaited<ReturnType<typeof listAiProviderReports>>;
  hub: readonly HubAnthropicSpendRow[];
}

/** Every account × day (empty ones too: the balance runway reads them). */
export function buildReconciliation(input: ReconciliationInput): Omit<AdminAiReconciliationResponse, "generatedAt" | "days"> {
  const syncByFingerprint = new Map(input.syncs.map((sync) => [sync.adminKeyFingerprint, sync]));
  const orgOfLabel = new Map<string, string | null>();
  for (const entry of input.adminKeys) {
    orgOfLabel.set(entry.label, syncByFingerprint.get(adminKeyFingerprint(entry.adminKey))?.orgId ?? null);
  }
  const orgIds = [...new Set([...orgOfLabel.values()].filter((id): id is string => id !== null))];
  const orgSync = (orgId: string) => input.syncs
    .filter((sync) => sync.orgId === orgId)
    .sort((a, b) => (b.lastSuccessAt?.getTime() ?? 0) - (a.lastSuccessAt?.getTime() ?? 0))[0];

  // Each organization's keys → accounts, over the whole window.
  const labelOfKey = new Map<string, Map<string, string>>();
  for (const orgId of orgIds) {
    const labels = [...orgOfLabel].filter(([, id]) => id === orgId).map(([label]) => ({
      label,
      apiKey: input.apiKeys.find((entry) => entry.label === label)?.apiKey ?? null,
    }));
    labelOfKey.set(orgId, mapApiKeysToLabels({
      labels,
      listedKeys: orgSync(orgId)?.apiKeys ?? [],
      usedKeyIds: input.reports.usage
        .filter((line) => line.orgId === orgId && line.apiKeyId !== null && tokenWeight(line) > 0)
        .map((line) => line.apiKeyId!),
    }));
  }

  const splits = new Map<string, OrgDaySplit>();
  const fetchedDays = new Set(input.reports.days.map((day) => `${day.orgId}|${day.day}`));
  for (const orgId of orgIds) {
    for (const day of input.days) {
      if (!fetchedDays.has(`${orgId}|${day}`)) continue;
      splits.set(`${orgId}|${day}`, splitOrgDay({
        costs: input.reports.costs.filter((cost) => cost.orgId === orgId && cost.day === day),
        usage: input.reports.usage.filter((line) => line.orgId === orgId && line.day === day),
      }));
    }
  }

  const yesterday = utcDay(new Date(utcDayStart(input.now).getTime() - DAY_MS));
  const rows: AdminAiReconciliationRow[] = [];
  for (const day of input.days) {
    for (const account of input.accounts) {
      const hubRows = input.hub.filter((row) => row.accountId === account.id && row.day === day);
      const hubMicroUsd = hubRows.reduce((total, row) => total + row.costMicroUsd, 0);
      const hubRequests = hubRows.reduce((total, row) => total + row.requests, 0);
      const orgId = orgOfLabel.get(account.label);
      const split = orgId ? splits.get(`${orgId}|${day}`) : undefined;
      const keyIds = orgId
        ? [...(labelOfKey.get(orgId) ?? [])].filter(([, label]) => label === account.label).map(([keyId]) => keyId)
        : [];
      const providerMicroUsd = split
        ? keyIds.reduce((total, keyId) =>
          total + [...(split.keys.get(keyId)?.values() ?? [])].reduce((sum, value) => sum + value, 0), 0)
        : null;
      const status = !orgOfLabel.has(account.label)
        ? "no_admin_key" as const
        : providerMicroUsd === null
          ? "not_synced" as const
          : reconciliationStatus({ day, now: input.now, hubMicroUsd, providerMicroUsd });

      const providerLines = orgId && split
        ? input.reports.usage.filter((line) => line.orgId === orgId && line.day === day
          && line.apiKeyId !== null && keyIds.includes(line.apiKeyId))
        : [];
      const models = [...new Set([
        ...hubRows.map((row) => row.model.replace(/^anthropic:/, "")),
        ...providerLines.filter((line) => tokenWeight(line) > 0).map((line) => line.model),
        ...(split ? keyIds.flatMap((keyId) => [...(split.keys.get(keyId)?.keys() ?? [])]) : []),
      ])].sort();

      rows.push({
        day,
        accountId: account.id,
        label: account.label,
        status,
        hubMicroUsd,
        hubRequests,
        providerMicroUsd,
        diffMicroUsd: providerMicroUsd === null ? null : hubMicroUsd - providerMicroUsd,
        diffPct: providerMicroUsd === null ? null : diffPercent(hubMicroUsd, providerMicroUsd),
        split: Boolean(split?.shared),
        models: models.map((model) => {
          const hubModel = hubRows.filter((row) => row.model.replace(/^anthropic:/, "") === model);
          const lines = providerLines.filter((line) => line.model === model);
          const providerCost = split
            ? keyIds.reduce((total, keyId) => total + (split.keys.get(keyId)?.get(model) ?? 0), 0)
            : 0;
          return {
            model,
            hub: hubModel.length === 0 ? null : {
              requests: hubModel.reduce((total, row) => total + row.requests, 0),
              costMicroUsd: hubModel.reduce((total, row) => total + row.costMicroUsd, 0),
              inputTokens: hubModel.reduce((total, row) => total + row.inputTokens, 0),
              cacheReadTokens: hubModel.reduce((total, row) => total + row.cacheReadTokens, 0),
              cacheWriteTokens: hubModel.reduce((total, row) => total + row.cacheWriteTokens, 0),
              cacheWrite5mTokens: knownSum(hubModel.map((row) => row.cacheWrite5mTokens)),
              cacheWrite1hTokens: knownSum(hubModel.map((row) => row.cacheWrite1hTokens)),
              outputTokens: hubModel.reduce((total, row) => total + row.outputTokens, 0),
            },
            provider: !split || (lines.length === 0 && providerCost === 0) ? null : {
              costMicroUsd: providerCost,
              inputTokens: lines.reduce((total, line) => total + line.uncachedInputTokens, 0),
              cacheReadTokens: lines.reduce((total, line) => total + line.cacheReadInputTokens, 0),
              cacheWriteTokens: lines.reduce((total, line) => total + line.cacheWrite5mTokens + line.cacheWrite1hTokens, 0),
              cacheWrite5mTokens: lines.reduce((total, line) => total + line.cacheWrite5mTokens, 0),
              cacheWrite1hTokens: lines.reduce((total, line) => total + line.cacheWrite1hTokens, 0),
              outputTokens: lines.reduce((total, line) => total + line.outputTokens, 0),
              webSearchRequests: lines.reduce((total, line) => total + line.webSearchRequests, 0),
            },
          };
        }),
      });
    }
  }

  const otherKeys: AdminAiReconciliationResponse["otherKeys"] = [];
  for (const day of input.days) {
    for (const orgId of orgIds) {
      const split = splits.get(`${orgId}|${day}`);
      if (!split) continue;
      const sync = orgSync(orgId);
      const mapped = labelOfKey.get(orgId) ?? new Map<string, string>();
      for (const [keyId, models] of split.keys) {
        if (keyId !== "" && mapped.has(keyId)) continue;
        const providerMicroUsd = [...models.values()].reduce((total, value) => total + value, 0);
        if (providerMicroUsd === 0) continue;
        const listed = sync?.apiKeys.find((key) => key.id === keyId);
        otherKeys.push({
          day,
          orgId,
          orgName: sync?.orgName ?? null,
          kind: keyId === "" ? "console" : "key",
          apiKeyId: keyId === "" ? null : keyId,
          keyName: listed?.name ?? null,
          keyHint: listed?.hint ?? null,
          providerMicroUsd,
          open: day >= yesterday,
        });
      }
      if (split.unsplitMicroUsd !== 0) {
        otherKeys.push({
          day, orgId, orgName: sync?.orgName ?? null, kind: "unsplit", apiKeyId: null, keyName: null,
          keyHint: null, providerMicroUsd: split.unsplitMicroUsd, open: day >= yesterday,
        });
      }
    }
  }

  const labelsOf = (fingerprint: string) =>
    input.adminKeys.filter((entry) => adminKeyFingerprint(entry.adminKey) === fingerprint).map((entry) => entry.label);
  const fingerprints = [...new Set(input.adminKeys.map((entry) => adminKeyFingerprint(entry.adminKey)))];
  return {
    configured: input.adminKeys.length > 0,
    syncs: fingerprints.map((fingerprint) => {
      const sync = syncByFingerprint.get(fingerprint);
      return {
        labels: labelsOf(fingerprint),
        orgId: sync?.orgId ?? null,
        orgName: sync?.orgName ?? null,
        lastAttemptAt: sync?.lastAttemptAt?.toISOString() ?? null,
        lastSuccessAt: sync?.lastSuccessAt?.toISOString() ?? null,
        lastError: sync?.lastError ?? null,
        lastErrorAt: sync?.lastErrorAt?.toISOString() ?? null,
      };
    }),
    rows,
    otherKeys,
  };
}

type ReconciliationApp = Pick<AppContext, "db" | "config">;

/** Every account × day of [fromDay, today], read from the database. */
export async function loadReconciliation(app: ReconciliationApp, input: { days: number; now: Date }) {
  const days = utcDaysBack(input.now, input.days);
  const fromDay = days[days.length - 1]!;
  const toDay = days[0]!;
  const adminKeys = app.config.anthropicAdminKeys ?? [];
  const [accounts, syncs, hub] = await Promise.all([
    listAiProviderAccounts(app.db, "anthropic"),
    adminKeys.length > 0 ? listAiProviderReportSyncs(app.db) : Promise.resolve([]),
    listHubAnthropicSpendByDay(app.db, { fromDay, toDay }),
  ]);
  const orgIds = [...new Set(syncs.map((sync) => sync.orgId).filter((id): id is string => id !== null))];
  const reports = await listAiProviderReports(app.db, { orgIds, fromDay, toDay });
  return buildReconciliation({
    now: input.now,
    days,
    accounts,
    apiKeys: anthropicKeyPoolEntries(app.config),
    adminKeys,
    syncs,
    reports,
    hub,
  });
}

export async function getAdminAiReconciliation(
  app: ReconciliationApp,
  query: { days: number },
  now = new Date(),
): Promise<AdminAiReconciliationResponse> {
  const result = await loadReconciliation(app, { days: query.days, now });
  return {
    generatedAt: now.toISOString(),
    days: query.days,
    ...result,
    rows: result.rows.filter((row) => row.hubMicroUsd !== 0 || (row.providerMicroUsd ?? 0) !== 0),
  };
}

// ─── The balance by Anthropic's bill ────────────────────────────────────────

/**
 * What Anthropic billed an account since the owner's balance reading: the
 * days after the reading's day whole, the reading's own day in the share of
 * Hub's spend that day that came after the reading (by the clock when Hub
 * spent nothing that day). Null unless every day since is in the reports.
 */
export function providerSpendSinceReading(input: {
  readAt: Date;
  now: Date;
  rows: ReadonlyArray<Pick<AdminAiReconciliationRow, "day" | "hubMicroUsd" | "providerMicroUsd">>;
  hubSpentSinceMicroUsd: number;
}): number | null {
  const readDay = utcDay(input.readAt);
  const days = utcDaysBack(input.now, Math.floor((utcDayStart(input.now).getTime() - utcDayStart(input.readAt).getTime()) / DAY_MS) + 1);
  let spent = 0;
  let hubAfterReadDay = 0;
  let readRow: (typeof input.rows)[number] | undefined;
  for (const day of days) {
    const row = input.rows.find((candidate) => candidate.day === day);
    if (!row || row.providerMicroUsd === null) return null;
    if (day === readDay) {
      readRow = row;
    } else {
      spent += row.providerMicroUsd;
      hubAfterReadDay += row.hubMicroUsd;
    }
  }
  if (!readRow || readRow.providerMicroUsd === null) return null;
  const hubAfterReading = Math.max(0, input.hubSpentSinceMicroUsd - hubAfterReadDay);
  const fraction = readRow.hubMicroUsd > 0
    ? Math.min(1, hubAfterReading / readRow.hubMicroUsd)
    : Math.max(0, (utcDayStart(input.readAt).getTime() + DAY_MS - input.readAt.getTime()) / DAY_MS);
  return spent + Math.floor(readRow.providerMicroUsd * fraction);
}
