import type { AdminAiAccountUpdateBody, AdminAiAccountsResponse } from "@agency_hub_core/contracts";
import {
  findAiProviderAccount,
  getAnthropicSpendTotals,
  insertAuditEvent,
  listAiProviderAccountUsage,
  listAiProviderAccounts,
  swapAiProviderAccountPriorities,
  updateAiProviderAccountSettings,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { ConflictError, NotFoundError } from "./errors.ts";

type AccountsApp = Pick<AppContext, "db" | "anthropicAccountPool">;

/** The usage screen's accounts block: each account's state, Hub's spend
 * through it and the balance left by the owner's last console reading. */
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
  const usageById = new Map(usage.map((row) => [row.accountId, row]));
  const dailyBurnMicroUsd = Math.round(totals.spent3dMicroUsd / 3);
  const serving = rows.find((row) => row.enabled && row.status === "active" && configured.has(row.label));

  return {
    generatedAt: now.toISOString(),
    dailyBurnMicroUsd,
    unattributed30dMicroUsd: totals.unattributed30dMicroUsd,
    accounts: rows.map((row) => {
      const spent = usageById.get(row.id);
      const balance = row.balanceSnapshotMicroUsd !== null && row.balanceSnapshotAt !== null
        ? (() => {
          const spentSince = spent?.spentSinceSnapshotMicroUsd ?? 0;
          const estimated = Math.max(row.balanceSnapshotMicroUsd! - spentSince, 0);
          return {
            readMicroUsd: row.balanceSnapshotMicroUsd!,
            readAt: row.balanceSnapshotAt!.toISOString(),
            spentSinceMicroUsd: spentSince,
            estimatedMicroUsd: estimated,
            daysLeft: dailyBurnMicroUsd > 0
              ? Math.round((estimated / dailyBurnMicroUsd) * 10) / 10
              : null,
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
        balance,
      };
    }),
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
