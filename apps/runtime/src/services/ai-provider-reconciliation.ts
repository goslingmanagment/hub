import type {
  AdminAiReconciliationResponse,
  AdminAiReconciliationRow,
} from "@agency_hub_core/contracts";
import {
  listAiProviderAccountOrgs,
  listAiProviderAccounts,
  listAiProviderKeyMappings,
  listAiProviderReports,
  listAiProviderReportSyncs,
  listHubAnthropicSpendByDay,
  listLatestAiProviderCsvImports,
  type AiProviderCsvImportRow,
  type AiProviderKeyMappingRow,
  type AiProviderReportApiKey,
  type AiProviderReportSyncRow,
  type AiProviderUsageRow,
  type HubAnthropicSpendRow,
} from "@agency_hub_core/db";
import { anthropicKeyPoolEntries, microUsdFromCents } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { estimateAiGatewayUsageCost } from "./ai-gateway-pricing.ts";
import { adminKeyFingerprint, hintMatches, parseKeyHint, utcDayStart } from "./ai-provider-reports.ts";

// Hub's ledger (ai_usage_events) against Anthropic's bill, per account and
// UTC day. The bill comes from the Admin API sync (ai-provider-reports.ts:
// the organization's cost, split between its keys by their usage priced
// with Hub's catalog, model by model) or from the console's Cost CSV the
// owner imports (ai-provider-csv-import.ts: each key's own dollars). Whose a
// key is comes from its kept decision first (ai_provider_key_mappings), so a
// rotated key's history stays its account's; a key nobody decided on is
// shown as undecided, never as $0 or as spend outside Hub.

const DAY_MS = 86_400_000;
/** |diff| within 1% of the bill, or under a cent, is a match. */
const TOLERANCE_PERCENT = 1;
const TOLERANCE_FLOOR_MICRO_USD = 10_000;
/** The model of a cost that is no model's tokens (web search, code execution). */
const NO_MODEL = "";
/** The Console's workbench: usage with no API key. Never Hub's. */
const CONSOLE = "";

export function utcDay(at: Date) {
  return at.toISOString().slice(0, 10);
}

export function utcDaysBack(now: Date, days: number) {
  const today = utcDayStart(now).getTime();
  return Array.from({ length: days }, (_, index) => utcDay(new Date(today - index * DAY_MS)));
}

// ─── API key → account ──────────────────────────────────────────────────────

/**
 * The fallback for keys with no kept decision (Admin API data only): a
 * listed key whose hint fits exactly one account's configured key is that
 * account's; failing that, an organization only one account lives in, whose
 * usage shows exactly one key that no hint contradicts, is that account's.
 */
export function mapApiKeysToLabels(input: {
  labels: ReadonlyArray<{ label: string; apiKey: string | null }>;
  listedKeys: readonly AiProviderReportApiKey[];
  usedKeyIds: readonly string[];
}): Map<string, string> {
  const mapped = hintMatches(input.labels, input.listedKeys);
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

export interface KeyResolution {
  /** Null: not Hub's key. */
  accountId: number | null;
  /** hint / name / owner: a kept decision; guess: the fallback, not kept. */
  source: "hint" | "name" | "owner" | "guess";
}

/** An organization's keys → accounts: kept decisions first, then the
 * fallback. A key in neither is undecided (absent from the map). */
export function resolveOrgKeys(input: {
  orgId: string;
  mappings: readonly AiProviderKeyMappingRow[];
  fallback: ReadonlyMap<string, number>;
}): Map<string, KeyResolution> {
  const resolved = new Map<string, KeyResolution>();
  for (const [keyId, accountId] of input.fallback) {
    resolved.set(keyId, { accountId, source: "guess" });
  }
  for (const mapping of input.mappings) {
    if (mapping.orgId === input.orgId) {
      resolved.set(mapping.apiKeyId, { accountId: mapping.accountId, source: mapping.source });
    }
  }
  return resolved;
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
  /** The organization's cost was split between several keys: the shares
   * are estimates (Admin API data; a CSV names each key's own). */
  shared: boolean;
}

export function splitOrgDay(input: {
  /** apiKeyId: the key a CSV line names ("" = the Console); null or absent:
   * the organization's cost, split here. */
  costs: ReadonlyArray<{ model: string | null; amountCents: string; apiKeyId?: string | null }>;
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

  // A key's own lines (CSV) are its own: no split.
  const own = new Map<string, string[]>();
  for (const cost of input.costs) {
    if (cost.apiKeyId === null || cost.apiKeyId === undefined) continue;
    const key = `${cost.apiKeyId}\u0000${cost.model ?? NO_MODEL}`;
    own.set(key, [...(own.get(key) ?? []), cost.amountCents]);
  }
  for (const [key, amounts] of own) {
    const [keyId, model] = key.split("\u0000") as [string, string];
    add(keyId, model, microUsdFromCents(amounts));
  }

  let unsplitMicroUsd = 0;
  const byModel = new Map<string, string[]>();
  for (const cost of input.costs) {
    if (cost.apiKeyId !== null && cost.apiKeyId !== undefined) continue;
    const model = cost.model ?? NO_MODEL;
    byModel.set(model, [...(byModel.get(model) ?? []), cost.amountCents]);
  }
  const splitAny = byModel.size > 0;
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
  return {
    totalMicroUsd,
    keys,
    unsplitMicroUsd,
    shared: splitAny && new Set(active.map((line) => line.apiKeyId ?? "")).size > 1,
  };
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
  /** The organization each account's key lives in, as last resolved. */
  accountOrgs: ReadonlyArray<{ accountId: number; orgId: string }>;
  mappings: readonly AiProviderKeyMappingRow[];
  imports: readonly AiProviderCsvImportRow[];
  reports: Awaited<ReturnType<typeof listAiProviderReports>>;
  hub: readonly HubAnthropicSpendRow[];
}

type Reconciliation = Omit<AdminAiReconciliationResponse, "generatedAt" | "days">;

/** Every account × day (empty ones too: the balance runway reads them). */
export function buildReconciliation(input: ReconciliationInput): Reconciliation {
  const syncByFingerprint = new Map(input.syncs.map((sync) => [sync.adminKeyFingerprint, sync]));
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));

  // The organizations an account's configured key lives in (its admin key's,
  // or as resolved on CSV import), and those its kept keys belong to.
  const configOrgs = new Map<number, Set<string>>();
  const link = (target: Map<number, Set<string>>, accountId: number, orgId: string) => {
    target.set(accountId, (target.get(accountId) ?? new Set()).add(orgId));
  };
  for (const entry of input.adminKeys) {
    const orgId = syncByFingerprint.get(adminKeyFingerprint(entry.adminKey))?.orgId;
    const account = input.accounts.find((candidate) => candidate.label === entry.label);
    if (orgId && account) link(configOrgs, account.id, orgId);
  }
  for (const entry of input.accountOrgs) link(configOrgs, entry.accountId, entry.orgId);
  const linkedOrgs = new Map<number, Set<string>>();
  for (const [accountId, orgs] of configOrgs) for (const orgId of orgs) link(linkedOrgs, accountId, orgId);
  for (const mapping of input.mappings) {
    if (mapping.accountId !== null) link(linkedOrgs, mapping.accountId, mapping.orgId);
  }
  const orgIds = [...new Set([
    ...[...linkedOrgs.values()].flatMap((orgs) => [...orgs]),
    ...input.mappings.map((mapping) => mapping.orgId),
    ...input.imports.map((entry) => entry.orgId),
  ])].sort();
  const orgSync = (orgId: string) => input.syncs
    .filter((sync) => sync.orgId === orgId)
    .sort((a, b) => (b.lastSuccessAt?.getTime() ?? 0) - (a.lastSuccessAt?.getTime() ?? 0))[0];

  // Each organization's keys → accounts, over the whole window.
  const keysOf = new Map<string, Map<string, KeyResolution>>();
  for (const orgId of orgIds) {
    const labels = input.accounts
      .filter((account) => configOrgs.get(account.id)?.has(orgId))
      .map((account) => ({ label: account.label, apiKey: input.apiKeys.find((entry) => entry.label === account.label)?.apiKey ?? null }));
    const guessed = mapApiKeysToLabels({
      labels,
      listedKeys: orgSync(orgId)?.apiKeys ?? [],
      usedKeyIds: input.reports.usage
        .filter((line) => line.orgId === orgId && line.apiKeyId !== null && tokenWeight(line) > 0)
        .map((line) => line.apiKeyId!),
    });
    const fallback = new Map<string, number>();
    for (const [keyId, label] of guessed) {
      const account = input.accounts.find((candidate) => candidate.label === label);
      if (account) fallback.set(keyId, account.id);
    }
    keysOf.set(orgId, resolveOrgKeys({ orgId, mappings: input.mappings, fallback }));
  }

  const dayOf = new Map(input.reports.days.map((day) => [`${day.orgId}|${day.day}`, day]));
  const splits = new Map<string, OrgDaySplit>();
  for (const orgId of orgIds) {
    for (const day of input.days) {
      if (!dayOf.has(`${orgId}|${day}`)) continue;
      splits.set(`${orgId}|${day}`, splitOrgDay({
        costs: input.reports.costs.filter((cost) => cost.orgId === orgId && cost.day === day),
        usage: input.reports.usage.filter((line) => line.orgId === orgId && line.day === day),
      }));
    }
  }
  const sum = (values: Iterable<number>) => [...values].reduce((total, value) => total + value, 0);
  const undecidedMicroUsd = (orgId: string, split: OrgDaySplit) => sum([...split.keys]
    .filter(([keyId]) => keyId !== CONSOLE && !keysOf.get(orgId)?.has(keyId))
    .map(([, models]) => sum(models.values())));

  const yesterday = utcDay(new Date(utcDayStart(input.now).getTime() - DAY_MS));
  const rows: AdminAiReconciliationRow[] = [];
  for (const day of input.days) {
    for (const account of input.accounts) {
      const hubRows = input.hub.filter((row) => row.accountId === account.id && row.day === day);
      const hubMicroUsd = sum(hubRows.map((row) => row.costMicroUsd));
      const hubRequests = sum(hubRows.map((row) => row.requests));
      const orgs = [...(linkedOrgs.get(account.id) ?? [])].sort();
      const read = orgs.filter((orgId) => splits.has(`${orgId}|${day}`));
      // The account's keys in each organization read that day.
      const owned = read.map((orgId) => ({
        orgId,
        split: splits.get(`${orgId}|${day}`)!,
        keyIds: [...(keysOf.get(orgId) ?? [])].filter(([, key]) => key.accountId === account.id).map(([keyId]) => keyId),
      }));
      const providerMicroUsd = read.length === 0
        ? null
        : sum(owned.flatMap(({ split, keyIds }) => keyIds.map((keyId) => sum(split.keys.get(keyId)?.values() ?? []))));
      const unmappedMicroUsd = sum(owned.map(({ orgId, split }) => undecidedMicroUsd(orgId, split)));
      const status = orgs.length === 0 && !input.adminKeys.some((entry) => entry.label === account.label)
        ? "no_source" as const
        : providerMicroUsd === null
          ? "not_synced" as const
          : unmappedMicroUsd !== 0
            ? "unmapped" as const
            : reconciliationStatus({ day, now: input.now, hubMicroUsd, providerMicroUsd });
      const sources = read.map((orgId) => dayOf.get(`${orgId}|${day}`)!.source);

      const providerLines = owned.flatMap(({ orgId, keyIds }) => input.reports.usage
        .filter((line) => line.orgId === orgId && line.day === day && line.apiKeyId !== null && keyIds.includes(line.apiKeyId)));
      const providerCost = (model: string) =>
        sum(owned.flatMap(({ split, keyIds }) => keyIds.map((keyId) => split.keys.get(keyId)?.get(model) ?? 0)));
      const models = [...new Set([
        ...hubRows.map((row) => row.model.replace(/^anthropic:/, "")),
        ...providerLines.filter((line) => tokenWeight(line) > 0).map((line) => line.model),
        ...owned.flatMap(({ split, keyIds }) => keyIds.flatMap((keyId) => [...(split.keys.get(keyId)?.keys() ?? [])])),
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
        unmappedMicroUsd,
        split: owned.some(({ split }) => split.shared),
        source: sources.includes("csv") ? "csv" : sources.length > 0 ? "admin_api" : null,
        providerTokensEstimated: sources.includes("csv"),
        models: models.map((model) => {
          const hubModel = hubRows.filter((row) => row.model.replace(/^anthropic:/, "") === model);
          const lines = providerLines.filter((line) => line.model === model);
          const cost = providerCost(model);
          return {
            model,
            hub: hubModel.length === 0 ? null : {
              requests: sum(hubModel.map((row) => row.requests)),
              costMicroUsd: sum(hubModel.map((row) => row.costMicroUsd)),
              inputTokens: sum(hubModel.map((row) => row.inputTokens)),
              cacheReadTokens: sum(hubModel.map((row) => row.cacheReadTokens)),
              cacheWriteTokens: sum(hubModel.map((row) => row.cacheWriteTokens)),
              cacheWrite5mTokens: knownSum(hubModel.map((row) => row.cacheWrite5mTokens)),
              cacheWrite1hTokens: knownSum(hubModel.map((row) => row.cacheWrite1hTokens)),
              outputTokens: sum(hubModel.map((row) => row.outputTokens)),
            },
            provider: read.length === 0 || (lines.length === 0 && cost === 0) ? null : {
              costMicroUsd: cost,
              inputTokens: sum(lines.map((line) => line.uncachedInputTokens)),
              cacheReadTokens: sum(lines.map((line) => line.cacheReadInputTokens)),
              cacheWriteTokens: sum(lines.map((line) => line.cacheWrite5mTokens + line.cacheWrite1hTokens)),
              cacheWrite5mTokens: sum(lines.map((line) => line.cacheWrite5mTokens)),
              cacheWrite1hTokens: sum(lines.map((line) => line.cacheWrite1hTokens)),
              outputTokens: sum(lines.map((line) => line.outputTokens)),
              webSearchRequests: sum(lines.map((line) => line.webSearchRequests)),
            },
          };
        }),
      });
    }
  }

  // Names and hints: the kept decision's, else the Admin API's key list.
  const keyInfo = (orgId: string, keyId: string) => {
    const mapping = input.mappings.find((candidate) => candidate.orgId === orgId && candidate.apiKeyId === keyId);
    const listed = orgSync(orgId)?.apiKeys.find((key) => key.id === keyId);
    return { name: mapping?.keyName ?? listed?.name ?? null, hint: mapping?.keyHint ?? listed?.hint ?? null };
  };
  const orgName = (orgId: string) => orgSync(orgId)?.orgName ?? null;

  const otherKeys: Reconciliation["otherKeys"] = [];
  const windowSpend = new Map<string, number>();
  for (const day of input.days) {
    for (const orgId of orgIds) {
      const split = splits.get(`${orgId}|${day}`);
      if (!split) continue;
      const resolved = keysOf.get(orgId) ?? new Map<string, KeyResolution>();
      for (const [keyId, models] of split.keys) {
        const providerMicroUsd = sum(models.values());
        if (keyId !== CONSOLE) windowSpend.set(`${orgId}|${keyId}`, (windowSpend.get(`${orgId}|${keyId}`) ?? 0) + providerMicroUsd);
        const resolution = resolved.get(keyId);
        if (keyId !== CONSOLE && resolution?.accountId != null) continue;
        if (providerMicroUsd === 0) continue;
        const info = keyInfo(orgId, keyId);
        otherKeys.push({
          day,
          orgId,
          orgName: orgName(orgId),
          kind: keyId === CONSOLE ? "console" : resolution ? "key" : "unknown",
          apiKeyId: keyId === CONSOLE ? null : keyId,
          keyName: info.name,
          keyHint: info.hint,
          providerMicroUsd,
          open: day >= yesterday,
        });
      }
      if (split.unsplitMicroUsd !== 0) {
        otherKeys.push({
          day, orgId, orgName: orgName(orgId), kind: "unsplit", apiKeyId: null, keyName: null,
          keyHint: null, providerMicroUsd: split.unsplitMicroUsd, open: day >= yesterday,
        });
      }
    }
  }

  const latestImport = new Map(input.imports.map((entry) => [entry.orgId, entry]));
  const orgs: Reconciliation["orgs"] = orgIds.map((orgId) => {
    const sync = orgSync(orgId);
    const imported = latestImport.get(orgId);
    const syncedAt = sync?.lastSuccessAt ?? null;
    const source = imported && (!syncedAt || imported.importedAt >= syncedAt)
      ? {
        kind: "csv" as const, at: imported.importedAt.toISOString(), periodFrom: imported.periodFrom,
        periodTo: imported.periodTo, fileName: imported.fileName,
      }
      : syncedAt
        ? { kind: "admin_api" as const, at: syncedAt.toISOString(), periodFrom: null, periodTo: null, fileName: null }
        : null;
    const resolved = keysOf.get(orgId) ?? new Map<string, KeyResolution>();
    const keyIds = [...new Set([
      ...input.mappings.filter((mapping) => mapping.orgId === orgId).map((mapping) => mapping.apiKeyId),
      ...[...windowSpend.keys()].filter((key) => key.startsWith(`${orgId}|`)).map((key) => key.slice(orgId.length + 1)),
    ])].sort();
    return {
      orgId,
      orgName: sync?.orgName ?? null,
      accountIds: input.accounts.filter((account) => linkedOrgs.get(account.id)?.has(orgId)).map((account) => account.id),
      source,
      keys: keyIds.map((apiKeyId) => {
        const resolution = resolved.get(apiKeyId);
        const info = keyInfo(orgId, apiKeyId);
        return {
          apiKeyId,
          name: info.name,
          hint: info.hint,
          decided: resolution !== undefined && resolution.source !== "guess",
          accountId: resolution?.accountId ?? null,
          label: resolution?.accountId != null ? accountById.get(resolution.accountId)?.label ?? null : null,
          source: resolution?.source ?? null,
          providerMicroUsd: windowSpend.get(`${orgId}|${apiKeyId}`) ?? 0,
        };
      }),
    };
  });

  const unattributed = new Map<string, { hubMicroUsd: number; requests: number }>();
  for (const row of input.hub) {
    if (row.accountId !== null) continue;
    const entry = unattributed.get(row.day) ?? { hubMicroUsd: 0, requests: 0 };
    entry.hubMicroUsd += row.costMicroUsd;
    entry.requests += row.requests;
    unattributed.set(row.day, entry);
  }

  const labelsOf = (fingerprint: string) =>
    input.adminKeys.filter((entry) => adminKeyFingerprint(entry.adminKey) === fingerprint).map((entry) => entry.label);
  const fingerprints = [...new Set(input.adminKeys.map((entry) => adminKeyFingerprint(entry.adminKey)))];
  return {
    configured: input.adminKeys.length > 0 || orgIds.length > 0,
    accounts: input.accounts.map((account) => ({ id: account.id, label: account.label })),
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
    orgs,
    rows,
    otherKeys,
    hubUnattributed: input.days.flatMap((day) => {
      const entry = unattributed.get(day);
      return entry && entry.hubMicroUsd !== 0 ? [{ day, ...entry }] : [];
    }),
  };
}

type ReconciliationApp = Pick<AppContext, "db" | "config">;

/** Every account × day of [fromDay, today], read from the database. */
export async function loadReconciliation(app: ReconciliationApp, input: { days: number; now: Date }) {
  const days = utcDaysBack(input.now, input.days);
  const fromDay = days[days.length - 1]!;
  const toDay = days[0]!;
  const adminKeys = app.config.anthropicAdminKeys ?? [];
  const [accounts, syncs, accountOrgs, mappings, imports, hub] = await Promise.all([
    listAiProviderAccounts(app.db, "anthropic"),
    listAiProviderReportSyncs(app.db),
    listAiProviderAccountOrgs(app.db),
    listAiProviderKeyMappings(app.db),
    listLatestAiProviderCsvImports(app.db),
    listHubAnthropicSpendByDay(app.db, { fromDay, toDay }),
  ]);
  const orgIds = [...new Set([
    ...syncs.map((sync) => sync.orgId).filter((id): id is string => id !== null),
    ...accountOrgs.map((entry) => entry.orgId),
    ...mappings.map((mapping) => mapping.orgId),
    ...imports.map((entry) => entry.orgId),
  ])];
  const reports = await listAiProviderReports(app.db, { orgIds, fromDay, toDay });
  return buildReconciliation({
    now: input.now,
    days,
    accounts,
    apiKeys: anthropicKeyPoolEntries(app.config),
    adminKeys,
    syncs,
    accountOrgs,
    mappings,
    imports,
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
    rows: result.rows.filter((row) => row.hubMicroUsd !== 0 || (row.providerMicroUsd ?? 0) !== 0 || row.unmappedMicroUsd !== 0),
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
  // With no Hub spend that day, by the clock — over the part of the day the
  // report can cover (it ends now on today), so a reading taken now has had
  // nothing billed after it yet.
  const readDayStart = utcDayStart(input.readAt).getTime();
  const coveredEnd = Math.min(readDayStart + DAY_MS, input.now.getTime());
  const fraction = readRow.hubMicroUsd > 0
    ? Math.min(1, hubAfterReading / readRow.hubMicroUsd)
    : coveredEnd > readDayStart
      ? Math.min(1, Math.max(0, (coveredEnd - input.readAt.getTime()) / (coveredEnd - readDayStart)))
      : 0;
  return spent + Math.floor(readRow.providerMicroUsd * fraction);
}
