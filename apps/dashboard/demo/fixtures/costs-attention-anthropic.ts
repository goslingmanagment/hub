/**
 * The Anthropic accounts the demo hub spends, their reconciliation with
 * Anthropic's bill, and the ElevenLabs account behind voice notes. The spend
 * comes from the same AI cells as «Траты на ИИ» (costs-attention-ai.ts).
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { between, daysAgo, iso, microUsd, queryNumber, rng, type DemoRequest } from "../core.ts";
import {
  ACCOUNT_LABELS,
  aiDayCells,
  aiSpendBetween,
  daysBetween,
  moscowDay,
  moscowDayStart,
  shiftDay,
  type AiCell,
} from "./costs-attention-ai.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// --- Anthropic accounts (adminAiAccountsList) ----------------------------------

const BALANCE_WARN_DAYS = 3;

type Accounts = KernelOperationResponse<"adminAiAccountsList">;

export function adminAiAccountsList(request: DemoRequest): Accounts {
  const now = request.now;
  const today = moscowDay(now);
  const burn3d = aiSpendBetween(new Date(now.getTime() - 3 * DAY_MS), now, now).cost;
  const dailyBurn = Math.round(burn3d / 3);
  const spentOf = (account: number | null, days: number) =>
    aiSpendBetween(new Date(now.getTime() - days * DAY_MS), now, now, (cell) => cell.account === account);

  const balanceOf = (account: number, read: number, readAt: Date, withProvider: boolean): NonNullable<Accounts["accounts"][number]["balance"]> => {
    const spentSince = aiSpendBetween(readAt, now, now, (cell) => cell.account === account).cost;
    const estimated = Math.max(0, read - spentSince);
    const daysLeft = dailyBurn > 0 ? Math.round((estimated / dailyBurn) * 100) / 100 : null;
    const providerSpent = Math.round(spentSince * 0.986);
    const providerEstimated = Math.max(0, read - providerSpent);
    const providerDays = dailyBurn > 0 ? Math.round((providerEstimated / dailyBurn) * 100) / 100 : null;
    return {
      readMicroUsd: read,
      readAt: iso(readAt),
      spentSinceMicroUsd: spentSince,
      estimatedMicroUsd: estimated,
      daysLeft,
      runsOutAt: daysLeft === null ? null : iso(new Date(now.getTime() + daysLeft * DAY_MS)),
      low: estimated === 0 || (daysLeft !== null && daysLeft < BALANCE_WARN_DAYS),
      provider: withProvider
        ? {
          spentSinceMicroUsd: providerSpent,
          estimatedMicroUsd: providerEstimated,
          daysLeft: providerDays,
          runsOutAt: providerDays === null ? null : iso(new Date(now.getTime() + providerDays * DAY_MS)),
        }
        : null,
    };
  };

  const mainReadAt = new Date(moscowDayStart(shiftDay(today, -3)).getTime() + 9.2 * HOUR_MS);
  const reserveReadAt = new Date(moscowDayStart(shiftDay(today, -13)).getTime() + 15.6 * HOUR_MS);
  const reserveLastUse = new Date(moscowDayStart(shiftDay(today, -10)).getTime() + 22.7 * HOUR_MS);
  const legacyLastUse = new Date(moscowDayStart(shiftDay(today, -25)).getTime() + 23.4 * HOUR_MS);

  const account = (id: number) => {
    const day = spentOf(id, 1);
    const week = spentOf(id, 7);
    const month = spentOf(id, 30);
    return { day, week, month };
  };
  const main = account(1);
  const reserve = account(2);
  const legacy = account(3);

  return {
    generatedAt: iso(now),
    accounts: [
      {
        id: 1,
        label: ACCOUNT_LABELS[1]!,
        priority: 1,
        enabled: true,
        status: "active",
        statusReason: null,
        statusChangedAt: iso(new Date(moscowDayStart(shiftDay(today, -9)).getTime() + 10.1 * HOUR_MS)),
        configured: true,
        serving: true,
        keyHint: "x7Qa",
        lastUsedAt: iso(new Date(now.getTime() - 2 * 60_000)),
        spent: { last24hMicroUsd: main.day.cost, last7dMicroUsd: main.week.cost, last30dMicroUsd: main.month.cost },
        requests: { last24h: main.day.calls, last30d: main.month.calls },
        balance: balanceOf(1, microUsd(140), mainReadAt, true),
      },
      {
        id: 2,
        label: ACCOUNT_LABELS[2]!,
        priority: 2,
        enabled: true,
        status: "active",
        statusReason: null,
        statusChangedAt: null,
        configured: true,
        serving: false,
        keyHint: "M2rd",
        lastUsedAt: iso(reserveLastUse),
        spent: { last24hMicroUsd: reserve.day.cost, last7dMicroUsd: reserve.week.cost, last30dMicroUsd: reserve.month.cost },
        requests: { last24h: reserve.day.calls, last30d: reserve.month.calls },
        balance: balanceOf(2, microUsd(200), reserveReadAt, false),
      },
      {
        id: 3,
        label: ACCOUNT_LABELS[3]!,
        priority: 3,
        enabled: true,
        status: "invalid",
        statusReason: "401 authentication_error: invalid x-api-key",
        statusChangedAt: iso(new Date(legacyLastUse.getTime() + 0.4 * HOUR_MS)),
        configured: false,
        serving: false,
        keyHint: "9fLe",
        lastUsedAt: iso(legacyLastUse),
        spent: { last24hMicroUsd: legacy.day.cost, last7dMicroUsd: legacy.week.cost, last30dMicroUsd: legacy.month.cost },
        requests: { last24h: legacy.day.calls, last30d: legacy.month.calls },
        balance: null,
      },
    ],
    dailyBurnMicroUsd: dailyBurn,
    unattributed30dMicroUsd: spentOf(null, 30).cost,
    balanceWarnDays: BALANCE_WARN_DAYS,
  };
}

// --- Reconciliation with Anthropic (adminAiReconciliation) -------------------------

type Reconciliation = KernelOperationResponse<"adminAiReconciliation">;
type Row = Reconciliation["rows"][number];

const ORG_MAIN = "org_01JB7Q2W9XKT4M3N8V5P6R1S0D";
const ORG_RESERVE = "org_01JC3H8Z6YFD2K9L4M7N1Q5T8W";
const ORG_MAIN_NAME = "Northlight Media";
const ORG_RESERVE_NAME = "Northlight Reserve";

/** Days ago (Moscow) where the bench key spent in the main organization too: Anthropic's figure is a share. */
const BENCH_DAYS = new Set([3, 6, 9]);
const MISMATCH_DAY = 5;
const UNMAPPED_DAY = 8;
const CONSOLE_DAY = 4;

function modelSides(cells: readonly AiCell[], costRatio: number, tokenRatio: number, estimated: boolean): Row["models"] {
  const models = new Map<string, AiCell[]>();
  for (const cell of cells) models.set(cell.model, [...(models.get(cell.model) ?? []), cell]);
  return [...models.entries()].map(([model, list]) => {
    const sum = (pick: (cell: AiCell) => number) => list.reduce((total, cell) => total + pick(cell), 0);
    const input = sum((cell) => cell.tokens.input);
    const cacheRead = sum((cell) => cell.tokens.cacheRead);
    const write5m = sum((cell) => cell.tokens.cacheWrite5m);
    const write1h = sum((cell) => cell.tokens.cacheWrite1h);
    const output = sum((cell) => cell.tokens.output);
    const cost = sum((cell) => cell.cost);
    const scale = (value: number) => Math.round(value * tokenRatio);
    return {
      model,
      hub: {
        inputTokens: input,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: write5m + write1h,
        cacheWrite5mTokens: write5m,
        cacheWrite1hTokens: write1h,
        outputTokens: output,
        requests: sum((cell) => cell.calls),
        costMicroUsd: cost,
      },
      provider: {
        inputTokens: scale(input),
        cacheReadTokens: scale(cacheRead),
        cacheWriteTokens: scale(write5m) + scale(write1h),
        cacheWrite5mTokens: estimated ? null : scale(write5m),
        cacheWrite1hTokens: estimated ? null : scale(write1h),
        outputTokens: scale(output),
        webSearchRequests: 0,
        costMicroUsd: Math.round(cost * costRatio),
      },
    };
  }).sort((left, right) => (right.hub?.costMicroUsd ?? 0) - (left.hub?.costMicroUsd ?? 0));
}

function reconciliationRow(day: string, ago: number, accountId: number, cells: readonly AiCell[]): Row {
  const hub = cells.reduce((sum, cell) => sum + cell.cost, 0);
  const requests = cells.reduce((sum, cell) => sum + cell.calls, 0);
  const random = rng(`recon:${day}:${accountId}`);
  const base = { day, accountId, label: ACCOUNT_LABELS[accountId]!, hubMicroUsd: hub, hubRequests: requests };

  if (accountId === 3) {
    return {
      ...base,
      status: "no_source",
      providerMicroUsd: null,
      diffMicroUsd: null,
      diffPct: null,
      unmappedMicroUsd: 0,
      split: false,
      source: null,
      providerTokensEstimated: false,
      models: modelSides(cells, 1, 1, false).map((model) => ({ ...model, provider: null })),
    };
  }

  const csv = accountId === 2;
  let costRatio = between(random, 0.9965, 1.0035);
  let tokenRatio = between(random, 0.998, 1.002);
  let status: Row["status"] = "ok";
  let unmapped = 0;
  if (accountId === 1 && ago <= 1) {
    status = "open";
    costRatio = ago === 0 ? between(random, 0.55, 0.7) : between(random, 0.9, 0.95);
    tokenRatio = costRatio;
  } else if (accountId === 1 && ago === MISMATCH_DAY) {
    // The tokens agree, the dollars do not: Hub priced the 1-hour cache writes as 5-minute ones.
    status = "mismatch";
    costRatio = 1.031;
    tokenRatio = 1;
  } else if (accountId === 1 && ago === UNMAPPED_DAY) {
    status = "unmapped";
    unmapped = microUsd(0.74);
  }
  const provider = Math.round(hub * costRatio);
  const diff = hub - provider;
  return {
    ...base,
    status,
    providerMicroUsd: provider,
    diffMicroUsd: diff,
    diffPct: provider === 0 ? null : Math.round((diff / provider) * 1000) / 10,
    unmappedMicroUsd: unmapped,
    split: accountId === 1 && BENCH_DAYS.has(ago),
    source: csv ? "csv" : "admin_api",
    providerTokensEstimated: csv,
    models: modelSides(cells, costRatio, tokenRatio, csv),
  };
}

export function adminAiReconciliation(request: DemoRequest): Reconciliation {
  const now = request.now;
  const days = Math.min(31, Math.max(1, Math.round(queryNumber(request, "days", 14))));
  const today = moscowDay(now);
  const rows: Row[] = [];
  const otherKeys: Reconciliation["otherKeys"] = [];
  const hubUnattributed: Reconciliation["hubUnattributed"] = [];
  const keySpend = { hub: 0, bench: 0, tmp: 0, reserve: 0 };

  for (let ago = 0; ago < days; ago += 1) {
    const day = shiftDay(today, -ago);
    const cells = aiDayCells(day, now);
    for (const accountId of [1, 2, 3]) {
      const mine = cells.filter((cell) => cell.account === accountId);
      if (mine.length === 0) continue;
      const row = reconciliationRow(day, ago, accountId, mine);
      rows.push(row);
      if (accountId === 1) keySpend.hub += row.providerMicroUsd ?? 0;
      if (accountId === 2) keySpend.reserve += row.providerMicroUsd ?? 0;
    }
    const unattributed = cells.filter((cell) => cell.account === null);
    if (unattributed.length > 0) {
      hubUnattributed.push({
        day,
        hubMicroUsd: unattributed.reduce((sum, cell) => sum + cell.cost, 0),
        requests: unattributed.reduce((sum, cell) => sum + cell.calls, 0),
      });
    }
    const random = rng(`recon-other:${day}`);
    if (BENCH_DAYS.has(ago)) {
      const spend = microUsd(between(random, 1.3, 2.9));
      keySpend.bench += spend;
      otherKeys.push({ day, orgId: ORG_MAIN, orgName: ORG_MAIN_NAME, kind: "key", apiKeyId: "apikey_01K2B8bench7Rq", keyName: "bench", keyHint: "sk-ant-…demo-b4Qa", providerMicroUsd: spend, open: ago <= 1 });
    }
    if (ago === CONSOLE_DAY) {
      otherKeys.push({ day, orgId: ORG_MAIN, orgName: ORG_MAIN_NAME, kind: "console", apiKeyId: null, keyName: null, keyHint: null, providerMicroUsd: microUsd(0.36), open: false });
    }
    if (ago === UNMAPPED_DAY) {
      keySpend.tmp += microUsd(0.74);
      otherKeys.push({ day, orgId: ORG_MAIN, orgName: ORG_MAIN_NAME, kind: "unknown", apiKeyId: "apikey_01K3F5tmp2Xw", keyName: "tmp-test", keyHint: "sk-ant-…demo-Tz1m", providerMicroUsd: microUsd(0.74), open: false });
    }
  }

  const csvFrom = shiftDay(today, -16);
  const csvTo = shiftDay(today, -5);
  return {
    generatedAt: iso(now),
    configured: true,
    days,
    accounts: [1, 2, 3].map((id) => ({ id, label: ACCOUNT_LABELS[id]! })),
    orgs: [
      {
        orgId: ORG_MAIN,
        orgName: ORG_MAIN_NAME,
        accountIds: [1],
        source: { kind: "admin_api", at: iso(new Date(now.getTime() - 14 * 60_000)), periodFrom: null, periodTo: null, fileName: null },
        keys: [
          { apiKeyId: "apikey_01J9ZhubMain4Kq", name: "hub", hint: "sk-ant-…demo-x7Qa", decided: true, accountId: 1, label: ACCOUNT_LABELS[1]!, source: "hint", providerMicroUsd: keySpend.hub },
          { apiKeyId: "apikey_01K2B8bench7Rq", name: "bench", hint: "sk-ant-…demo-b4Qa", decided: true, accountId: null, label: null, source: "owner", providerMicroUsd: keySpend.bench },
          ...(keySpend.tmp > 0
            ? [{ apiKeyId: "apikey_01K3F5tmp2Xw", name: "tmp-test", hint: "sk-ant-…demo-Tz1m", decided: false, accountId: null, label: ACCOUNT_LABELS[1]!, source: "guess" as const, providerMicroUsd: keySpend.tmp }]
            : []),
        ],
      },
      {
        orgId: ORG_RESERVE,
        orgName: ORG_RESERVE_NAME,
        accountIds: [2],
        source: { kind: "csv", at: iso(new Date(moscowDayStart(shiftDay(today, -4)).getTime() + 12.3 * HOUR_MS)), periodFrom: csvFrom, periodTo: csvTo, fileName: "cost_report_northlight_reserve.csv" },
        keys: [
          { apiKeyId: "apikey_01JA4hubRsv9Mn", name: "hub-reserve", hint: "sk-ant-…demo-M2rd", decided: true, accountId: 2, label: ACCOUNT_LABELS[2]!, source: "name", providerMicroUsd: keySpend.reserve },
        ],
      },
    ],
    syncs: [
      {
        labels: [ACCOUNT_LABELS[1]!],
        orgId: ORG_MAIN,
        orgName: ORG_MAIN_NAME,
        lastAttemptAt: iso(new Date(now.getTime() - 14 * 60_000)),
        lastSuccessAt: iso(new Date(now.getTime() - 14 * 60_000)),
        lastError: null,
        lastErrorAt: null,
      },
    ],
    rows,
    otherKeys,
    hubUnattributed,
  };
}

// --- ElevenLabs (adminVoiceAccount) ------------------------------------------------

export function adminVoiceAccount(request: DemoRequest): KernelOperationResponse<"adminVoiceAccount"> {
  const now = request.now;
  const checkedAt = new Date(now.getTime() - ((now.getTime() / 60_000) % 30) * 60_000);
  const resetAt = daysAgo(now, -12, 7);
  const voiceDays = 18;
  const used = Math.round(3_400 * voiceDays + (daysBetween(moscowDay(daysAgo(now, voiceDays)), moscowDay(now)) % 3) * 120);
  return {
    generatedAt: iso(now),
    configured: true,
    enabled: true,
    check: {
      state: "healthy",
      checkedAt: iso(checkedAt),
      httpStatus: null,
      readAt: iso(checkedAt),
      tier: "creator",
      subscriptionStatus: "active",
      charactersUsed: used,
      charactersLimit: 100_000,
      nextResetAt: iso(resetAt),
      lowThresholdChars: 10_000,
    },
  };
}

