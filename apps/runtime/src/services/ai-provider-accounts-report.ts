import type { AdminAiAccountUpdateBody, AdminAiAccountsResponse } from "@agency_hub_core/contracts";
import {
  findAiProviderAccount,
  getAnthropicSpendTotals,
  insertAiProviderAccountCredit,
  insertAuditEvent,
  listAiProviderAccountCredits,
  listAiProviderAccountUsage,
  listAiProviderAccounts,
  swapAiProviderAccountPriorities,
  updateAiProviderAccountSettings,
} from "@agency_hub_core/db";
import { aiAccountCreditsOf } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import {
  CREDIT_EXPECTED_AFTER_MS,
  forecastPool,
  moscowDate,
  renewalsFrom,
  topUpUnknown,
  upcomingCredits,
} from "./ai-account-balance.ts";
import { loadReconciliation, providerSpendSinceReading, utcDay } from "./ai-provider-reconciliation.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { ConflictError, NotFoundError } from "./errors.ts";

type AccountsApp = Pick<AppContext, "db" | "config" | "anthropicAccountPool">;

const DAY_MS = 86_400_000;
/** Anthropic's reports are compared back this far at most (one report page). */
const PROVIDER_LOOKBACK_DAYS = 31;

/** The days a balance lasts at the pace, and the moment it runs out. */
export function balanceRunway(input: { estimatedMicroUsd: number; dailyBurnMicroUsd: number; now: Date }) {
  if (input.dailyBurnMicroUsd <= 0) {
    return { daysLeft: null, runsOutAt: null };
  }
  const days = input.estimatedMicroUsd / input.dailyBurnMicroUsd;
  return {
    daysLeft: Math.round(days * 10) / 10,
    runsOutAt: new Date(input.now.getTime() + days * DAY_MS).toISOString(),
  };
}

/** The usage screen's accounts block: each account's state, Hub's spend
 * through it, its balance (the last reading or zero + money in since − Hub's
 * spend since, ai-account-balance.ts) and the pool's forecast. */
export async function getAdminAiAccountsReport(
  app: AccountsApp,
  now = new Date(),
): Promise<AdminAiAccountsResponse> {
  await app.anthropicAccountPool?.ensureRegistered();
  const configured = new Set(app.anthropicAccountPool?.labels ?? []);
  const [rows, usage, totals] = await Promise.all([
    listAiProviderAccounts(app.db, "anthropic"),
    listAiProviderAccountUsage(app.db, { provider: "anthropic", now }),
    getAnthropicSpendTotals(app.db, { now }),
  ]);
  const anchors = rows.flatMap((row) => (row.balanceSnapshotAt ? [row.balanceSnapshotAt.getTime()] : []));
  const credits = await listAiProviderAccountCredits(app.db, {
    provider: "anthropic",
    since: new Date(Math.min(now.getTime(), ...anchors)),
    cycleSince: moscowDate(new Date(now.getTime() - 40 * DAY_MS)),
  });
  const usageById = new Map(usage.map((row) => [row.accountId, row]));
  const dailyBurnMicroUsd = Math.round(totals.spent3dMicroUsd / 3);
  const serving = rows.find((row) => row.enabled && row.status === "active" && configured.has(row.label));
  const effective = await loadEffectiveConfig(app.db, app.config);
  const balanceWarnDays = effective.aiBalanceWarnDays ?? 2;
  const schedules = aiAccountCreditsOf(effective.aiAccountCredits);

  // Anthropic's own bill since each reading, where its reports reach back.
  const readings = rows.flatMap((row) => (row.balanceSnapshotAt ? [row.balanceSnapshotAt] : []))
    .filter((at) => now.getTime() - at.getTime() < (PROVIDER_LOOKBACK_DAYS - 1) * DAY_MS);
  const reconciliation = readings.length > 0
    ? await loadReconciliation(app, {
      now,
      days: Math.ceil((now.getTime() - Math.min(...readings.map((at) => at.getTime()))) / DAY_MS) + 1,
    })
    : null;

  const accounts = rows.map((row) => {
      const spent = usageById.get(row.id);
      const schedule = schedules[row.label];
      const nextRenewal = schedule
        ? renewalsFrom(schedule.day, now, 2).find((renewal) => renewal.getTime() + CREDIT_EXPECTED_AFTER_MS > now.getTime()
          && !credits.some((credit) => credit.accountId === row.id && credit.kind === "monthly" && credit.cycleDate === moscowDate(renewal)))
        : undefined;
      const balance = row.balanceSnapshotMicroUsd !== null && row.balanceSnapshotAt !== null
        ? (() => {
          const spentSince = spent?.spentSinceSnapshotMicroUsd ?? 0;
          const creditsSince = credits.filter((credit) => credit.accountId === row.id && credit.creditedAt > row.balanceSnapshotAt!);
          const creditedSince = creditsSince.reduce((sum, credit) => sum + credit.amountMicroUsd, 0);
          const estimated = Math.max(row.balanceSnapshotMicroUsd! + creditedSince - spentSince, 0);
          const runway = balanceRunway({ estimatedMicroUsd: estimated, dailyBurnMicroUsd, now });
          const providerSpent = reconciliation && utcDay(row.balanceSnapshotAt!) >= utcDay(new Date(now.getTime() - (PROVIDER_LOOKBACK_DAYS - 1) * DAY_MS))
            ? providerSpendSinceReading({
              readAt: row.balanceSnapshotAt!,
              now,
              rows: reconciliation.rows.filter((candidate) => candidate.accountId === row.id),
              hubSpentSinceMicroUsd: spentSince,
            })
            : null;
          const providerEstimated = providerSpent === null ? null : Math.max(row.balanceSnapshotMicroUsd! + creditedSince - providerSpent, 0);
          return {
            readMicroUsd: row.balanceSnapshotMicroUsd!,
            readAt: row.balanceSnapshotAt!.toISOString(),
            readSource: row.balanceSnapshotSource ?? "reading",
            creditedSinceMicroUsd: creditedSince,
            credits: creditsSince.slice(-5).map((credit) => ({
              kind: credit.kind,
              microUsd: credit.amountMicroUsd,
              at: credit.creditedAt.toISOString(),
              source: credit.source,
            })),
            unknownTopUp: topUpUnknown(row, creditsSince.length),
            spentSinceMicroUsd: spentSince,
            estimatedMicroUsd: estimated,
            ...runway,
            low: estimated === 0 || (runway.daysLeft !== null && runway.daysLeft < balanceWarnDays),
            provider: providerSpent === null || providerEstimated === null ? null : {
              spentSinceMicroUsd: providerSpent,
              estimatedMicroUsd: providerEstimated,
              ...balanceRunway({ estimatedMicroUsd: providerEstimated, dailyBurnMicroUsd, now }),
            },
          };
        })()
        : null;
      return {
        id: row.id,
        label: row.label,
        priority: row.priority,
        enabled: row.enabled,
        status: row.status,
        statusReason: row.statusReason,
        statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
        configured: configured.has(row.label),
        serving: serving?.id === row.id,
        keyHint: row.keyHint,
        lastUsedAt: spent?.lastUsedAt?.toISOString() ?? null,
        spent: {
          last24hMicroUsd: spent?.spent1dMicroUsd ?? 0,
          last7dMicroUsd: spent?.spent7dMicroUsd ?? 0,
          last30dMicroUsd: spent?.spent30dMicroUsd ?? 0,
        },
        requests: {
          last24h: spent?.requests1d ?? 0,
          last30d: spent?.requests30d ?? 0,
        },
        monthlyCredit: schedule
          ? {
            day: schedule.day,
            microUsd: schedule.microUsd,
            nextExpectedAt: nextRenewal
              ? new Date(Math.max(nextRenewal.getTime() + CREDIT_EXPECTED_AFTER_MS, now.getTime())).toISOString()
              : null,
          }
          : null,
        balance,
      };
    });

  // The pool: accounts that spend or will once their credit comes.
  const pool = accounts.filter((account) => account.enabled && account.configured && account.status !== "invalid");
  const forecast = forecastPool({
    now,
    dailyBurnMicroUsd,
    balances: pool.map((account) => ({
      label: account.label,
      estimatedMicroUsd: account.balance && !account.balance.unknownTopUp ? account.balance.estimatedMicroUsd : null,
    })),
    upcoming: upcomingCredits({ accounts: pool, credits: schedules, recorded: credits, now }),
  });
  return {
    generatedAt: now.toISOString(),
    dailyBurnMicroUsd,
    unattributed30dMicroUsd: totals.unattributed30dMicroUsd,
    balanceWarnDays,
    accounts,
    forecast: {
      leftMicroUsd: forecast.leftMicroUsd,
      missing: forecast.missing,
      runsOutAt: forecast.runsOutAt?.toISOString() ?? null,
      nextCredit: forecast.nextCredit
        ? { label: forecast.nextCredit.label, microUsd: forecast.nextCredit.microUsd, expectedAt: forecast.nextCredit.expectedAt.toISOString() }
        : null,
      gap: forecast.gap
        ? { label: forecast.gap.label, untilAt: forecast.gap.untilAt.toISOString(), shortfallMicroUsd: forecast.gap.shortfallMicroUsd }
        : null,
      low: forecast.missing.length === 0
        && balanceWarnDays > 0
        && forecast.runsOutAt !== null
        && forecast.runsOutAt.getTime() - now.getTime() < balanceWarnDays * DAY_MS,
    },
  };
}

/** The owner's change to one account; answers with the whole block. */
export async function updateAdminAiAccount(
  app: AccountsApp,
  input: { actorUserId: number; accountId: number; body: AdminAiAccountUpdateBody },
  now = new Date(),
): Promise<AdminAiAccountsResponse> {
  const account = await findAiProviderAccount(app.db, input.accountId);
  if (!account) {
    throw new NotFoundError("Anthropic account not found");
  }
  const configured = new Set(app.anthropicAccountPool?.labels ?? []);
  const rows = await listAiProviderAccounts(app.db, account.provider);

  if (input.body.enabled === false && account.enabled) {
    const othersEnabled = rows.some((row) => row.id !== account.id && row.enabled && configured.has(row.label));
    if (!othersEnabled) {
      throw new ConflictError("The last enabled Anthropic account cannot be turned off");
    }
  }
  if (input.body.move !== undefined) {
    const index = rows.findIndex((row) => row.id === account.id);
    const neighbour = rows[input.body.move === "up" ? index - 1 : index + 1];
    if (neighbour) {
      await swapAiProviderAccountPriorities(app.db, { id: account.id, otherId: neighbour.id, at: now });
    }
  }
  if (input.body.topUpMicroUsd !== undefined) {
    await insertAiProviderAccountCredit(app.db, {
      accountId: account.id,
      kind: "topup",
      amountMicroUsd: input.body.topUpMicroUsd,
      creditedAt: now,
      cycleDate: null,
      source: "dashboard",
      actorUserId: input.actorUserId,
    });
  }
  if (input.body.enabled !== undefined || input.body.balanceMicroUsd !== undefined) {
    await updateAiProviderAccountSettings(app.db, {
      id: account.id,
      ...(input.body.enabled !== undefined ? { enabled: input.body.enabled } : {}),
      ...(input.body.balanceMicroUsd !== undefined
        ? {
          balanceSnapshot: input.body.balanceMicroUsd === null
            ? null
            : { microUsd: input.body.balanceMicroUsd, at: now },
        }
        : {}),
      at: now,
    });
  }
  await insertAuditEvent(app.db, {
    actorUserId: input.actorUserId,
    source: "dashboard",
    eventType: "admin.ai_account_update",
    metadata: { accountId: account.id, label: account.label, ...input.body },
  });
  app.anthropicAccountPool?.invalidate();
  return getAdminAiAccountsReport(app, now);
}
