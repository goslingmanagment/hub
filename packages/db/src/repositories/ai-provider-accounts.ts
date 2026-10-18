import { asc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { aiProviderAccounts } from "../schema.ts";

export type AiProviderAccountProvider = "anthropic";
export type AiProviderAccountStatus = "active" | "exhausted" | "invalid";
export type AiProviderAccountRow = typeof aiProviderAccounts.$inferSelect;

type NumericValue = number | bigint | string | null | undefined;

function toNumber(value: NumericValue) {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

function rowsOf<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

/**
 * One row per configured label. A new label is appended after the existing
 * order; a label whose key changed (another fingerprint) starts over as
 * active — a replaced key is a new chance, whatever the old one's status.
 * Rows of labels no longer configured are kept (their ledger history stays
 * attributed) and simply never offered.
 */
export async function syncAiProviderAccounts(
  db: Database,
  input: {
    provider: AiProviderAccountProvider;
    accounts: Array<{ label: string; keyFingerprint: string; keyHint: string }>;
    at: Date;
  },
) {
  for (const [index, account] of input.accounts.entries()) {
    await db.execute(sql`
      insert into ai_provider_accounts (provider, label, priority, key_fingerprint, key_hint)
      values (
        ${input.provider},
        ${account.label},
        coalesce((select max(priority) from ai_provider_accounts where provider = ${input.provider}), 0)
          + ${index + 1},
        ${account.keyFingerprint},
        ${account.keyHint}
      )
      on conflict (provider, label) do update set
        key_fingerprint = excluded.key_fingerprint,
        key_hint = excluded.key_hint,
        status = 'active',
        status_reason = null,
        status_changed_at = ${input.at},
        next_probe_at = null,
        updated_at = ${input.at}
      where ai_provider_accounts.key_fingerprint is distinct from excluded.key_fingerprint
    `);
  }
}

export async function listAiProviderAccounts(db: Database, provider: AiProviderAccountProvider) {
  return db.select()
    .from(aiProviderAccounts)
    .where(eq(aiProviderAccounts.provider, provider))
    .orderBy(asc(aiProviderAccounts.priority), asc(aiProviderAccounts.id));
}

export async function findAiProviderAccount(db: Database, id: number) {
  const [row] = await db.select().from(aiProviderAccounts).where(eq(aiProviderAccounts.id, id));
  return row ?? null;
}

/**
 * Anthropic refused the account (no credit, or a key it does not know).
 * Returns the status the account had before, so only the first refusal of a
 * streak opens an alert; a repeat (a failed probe) only moves next_probe_at.
 */
export async function markAiProviderAccountUnavailable(
  db: Database,
  input: {
    id: number;
    status: Exclude<AiProviderAccountStatus, "active">;
    reason: string;
    at: Date;
    nextProbeAt: Date | null;
  },
): Promise<AiProviderAccountStatus | null> {
  const result = await db.execute(sql`
    with previous as (
      select id, status from ai_provider_accounts where id = ${input.id} for update
    )
    update ai_provider_accounts as account set
      status = ${input.status},
      status_reason = ${input.reason},
      status_changed_at = case
        when previous.status = ${input.status} then account.status_changed_at
        else ${input.at}
      end,
      next_probe_at = ${input.nextProbeAt},
      updated_at = ${input.at}
    from previous
    where account.id = previous.id
    returning previous.status as "previousStatus"
  `);
  const [row] = rowsOf<{ previousStatus: AiProviderAccountStatus }>(result);
  return row?.previousStatus ?? null;
}

/**
 * The one call that may try an exhausted account again: the first caller
 * after next_probe_at wins and pushes it forward, everyone else keeps the
 * account out of their order until the probe has spoken.
 */
export async function claimAiProviderAccountProbe(
  db: Database,
  input: { id: number; at: Date; nextProbeAt: Date },
) {
  const result = await db.execute(sql`
    update ai_provider_accounts set next_probe_at = ${input.nextProbeAt}, updated_at = ${input.at}
    where id = ${input.id}
      and status = 'exhausted'
      and enabled
      and (next_probe_at is null or next_probe_at <= ${input.at})
    returning id
  `);
  return rowsOf<{ id: number }>(result).length === 1;
}

/** The account accepted a call. Returns its status before (null: no row). */
export async function markAiProviderAccountServing(
  db: Database,
  input: { id: number; at: Date },
): Promise<AiProviderAccountStatus | null> {
  const result = await db.execute(sql`
    with previous as (
      select id, status from ai_provider_accounts where id = ${input.id} for update
    )
    update ai_provider_accounts as account set
      status = 'active',
      status_reason = null,
      status_changed_at = case
        when previous.status = 'active' then account.status_changed_at
        else ${input.at}
      end,
      next_probe_at = null,
      last_success_at = ${input.at},
      updated_at = ${input.at}
    from previous
    where account.id = previous.id
    returning previous.status as "previousStatus"
  `);
  const [row] = rowsOf<{ previousStatus: AiProviderAccountStatus }>(result);
  return row?.previousStatus ?? null;
}

/** The owner's settings: on/off, place in the order, the balance read in the
 * Anthropic console (null clears it). */
export async function updateAiProviderAccountSettings(
  db: Database,
  input: {
    id: number;
    enabled?: boolean;
    priority?: number;
    balanceSnapshot?: { microUsd: number; at: Date } | null;
    at: Date;
  },
) {
  const [row] = await db.update(aiProviderAccounts)
    .set({
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.balanceSnapshot !== undefined
        ? {
          balanceSnapshotMicroUsd: input.balanceSnapshot?.microUsd ?? null,
          balanceSnapshotAt: input.balanceSnapshot?.at ?? null,
        }
        : {}),
      updatedAt: input.at,
    })
    .where(eq(aiProviderAccounts.id, input.id))
    .returning();
  return row ?? null;
}

/** Swap two accounts' places in the order (the owner's up/down arrows). */
export async function swapAiProviderAccountPriorities(
  db: Database,
  input: { id: number; otherId: number; at: Date },
) {
  await db.transaction(async (tx) => {
    const rows = await tx.select({ id: aiProviderAccounts.id, priority: aiProviderAccounts.priority })
      .from(aiProviderAccounts)
      .where(inArray(aiProviderAccounts.id, [input.id, input.otherId]))
      .for("update");
    const first = rows.find((row) => row.id === input.id);
    const second = rows.find((row) => row.id === input.otherId);
    if (!first || !second) {
      return;
    }
    await tx.update(aiProviderAccounts)
      .set({ priority: second.priority, updatedAt: input.at })
      .where(eq(aiProviderAccounts.id, first.id));
    await tx.update(aiProviderAccounts)
      .set({ priority: first.priority, updatedAt: input.at })
      .where(eq(aiProviderAccounts.id, second.id));
  });
}

export interface AiProviderAccountUsageRow {
  accountId: number;
  spent1dMicroUsd: number;
  spent3dMicroUsd: number;
  spent7dMicroUsd: number;
  spent30dMicroUsd: number;
  spentSinceSnapshotMicroUsd: number;
  requests1d: number;
  requests30d: number;
  lastUsedAt: Date | null;
}

/** What Hub spent through each account over rolling windows ending at `now`,
 * and since the owner's last balance reading. */
export async function listAiProviderAccountUsage(
  db: Database,
  input: { provider: AiProviderAccountProvider; now: Date },
): Promise<AiProviderAccountUsageRow[]> {
  const result = await db.execute(sql`
    with windows as (
      select ${input.now}::timestamptz as now
    )
    select account.id as "accountId",
           coalesce(sum(event.cost_micro_usd) filter (
             where event.completed_at >= windows.now - interval '1 day'), 0) as "spent1d",
           coalesce(sum(event.cost_micro_usd) filter (
             where event.completed_at >= windows.now - interval '3 days'), 0) as "spent3d",
           coalesce(sum(event.cost_micro_usd) filter (
             where event.completed_at >= windows.now - interval '7 days'), 0) as "spent7d",
           coalesce(sum(event.cost_micro_usd) filter (
             where event.completed_at >= windows.now - interval '30 days'), 0) as "spent30d",
           coalesce(sum(event.cost_micro_usd) filter (
             where account.balance_snapshot_at is not null
               and event.completed_at >= account.balance_snapshot_at), 0) as "spentSinceSnapshot",
           count(event.id) filter (
             where event.completed_at >= windows.now - interval '1 day') as "requests1d",
           count(event.id) filter (
             where event.completed_at >= windows.now - interval '30 days') as "requests30d",
           max(event.completed_at) as "lastUsedAt"
    from ai_provider_accounts account
    cross join windows
    left join ai_usage_events event
      on event.provider_account_id = account.id
     and event.completed_at >= least(
       windows.now - interval '30 days',
       coalesce(account.balance_snapshot_at, windows.now - interval '30 days')
     )
    where account.provider = ${input.provider}
    group by account.id
  `);
  return rowsOf<{
    accountId: NumericValue;
    spent1d: NumericValue;
    spent3d: NumericValue;
    spent7d: NumericValue;
    spent30d: NumericValue;
    spentSinceSnapshot: NumericValue;
    requests1d: NumericValue;
    requests30d: NumericValue;
    lastUsedAt: Date | string | null;
  }>(result).map((row) => ({
    accountId: toNumber(row.accountId),
    spent1dMicroUsd: toNumber(row.spent1d),
    spent3dMicroUsd: toNumber(row.spent3d),
    spent7dMicroUsd: toNumber(row.spent7d),
    spent30dMicroUsd: toNumber(row.spent30d),
    spentSinceSnapshotMicroUsd: toNumber(row.spentSinceSnapshot),
    requests1d: toNumber(row.requests1d),
    requests30d: toNumber(row.requests30d),
    lastUsedAt: row.lastUsedAt === null ? null : new Date(row.lastUsedAt),
  }));
}

/** All Anthropic spend of the last 3 days (the pace a balance is spent at),
 * and that of the last 30 days that names no account (rows from before
 * accounts were tracked). */
export async function getAnthropicSpendTotals(
  db: Database,
  input: { now: Date },
) {
  const result = await db.execute(sql`
    select coalesce(sum(cost_micro_usd) filter (
             where completed_at >= ${input.now}::timestamptz - interval '3 days'), 0) as "spent3d",
           coalesce(sum(cost_micro_usd) filter (where provider_account_id is null), 0) as "unattributed30d"
    from ai_usage_events
    where provider = 'anthropic'
      and completed_at >= ${input.now}::timestamptz - interval '30 days'
  `);
  const [row] = rowsOf<{ spent3d: NumericValue; unattributed30d: NumericValue }>(result);
  return {
    spent3dMicroUsd: toNumber(row?.spent3d),
    unattributed30dMicroUsd: toNumber(row?.unattributed30d),
  };
}
