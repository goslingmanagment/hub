// An Anthropic account's balance without waiting for the owner (2026-11-07).
//
// Anthropic has no API for an account's remaining credit, and the owner's
// console reading — the only anchor the usage screen had — was never typed in:
// the screen showed no balance, no forecast and no warning, and on 30.10 all
// three accounts ran dry unannounced. Hub now keeps the balance itself:
//   * zero: the first refusal for credit sets the balance to exactly $0 at that
//     moment (markAiProviderAccountUnavailable);
//   * money in: the subscription's monthly credit (`aiAccountCredits`: renewal
//     day + amount) is recorded here — when the account answers again after a
//     zero within CREDIT_WINDOW of its renewal, or, if it never ran dry, at the
//     window's end — and the owner's purchases come from the usage screen;
//   * balance = the last reading or zero + money in since − Hub's spend since.
// The forecast walks the pool's money down at the last 3 days' pace, adding
// the monthly credits still to come, and the half-hourly check pages the owner
// once when it runs out within aiBalanceWarnDays (ai-balance-watch.ts).

import type { AiAccountCredits } from "@agency_hub_core/shared";
import type { AiProviderAccountCreditRow, AiProviderAccountRow } from "@agency_hub_core/db";

export const DAY_MS = 86_400_000;
export const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
/** A renewal's credit lands within this long of it (seen: 1–2 days). */
export const CREDIT_WINDOW_MS = 3 * DAY_MS;
/** The forecast expects a credit this long after its renewal. */
export const CREDIT_EXPECTED_AFTER_MS = 2 * DAY_MS;
/** The forecast looks this far ahead. */
const FORECAST_HORIZON_MS = 40 * DAY_MS;

/** Moscow midnight of `day` in the given (UTC-numbered) month; a short month
 * renews on its last day. */
export function renewalAt(year: number, month: number, day: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last)) - MSK_OFFSET_MS);
}

/** The renewals of a monthly `day`, from the last one at or before `now`
 * onward, `count` of them. */
export function renewalsFrom(day: number, now: Date, count: number): Date[] {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const year = msk.getUTCFullYear();
  let month = msk.getUTCMonth();
  if (renewalAt(year, month, day) > now) {
    month -= 1;
  }
  const out: Date[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = new Date(Date.UTC(year, month + index, 1));
    out.push(renewalAt(at.getUTCFullYear(), at.getUTCMonth(), day));
  }
  return out;
}

/** The Moscow date (YYYY-MM-DD) of a renewal: the cycle's name. */
export function moscowDate(at: Date): string {
  return new Date(at.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

type Anchor = { microUsd: number; at: Date; zero: boolean };

function anchorOf(row: AiProviderAccountRow): Anchor | null {
  if (row.balanceSnapshotMicroUsd === null || row.balanceSnapshotAt === null) return null;
  return {
    microUsd: row.balanceSnapshotMicroUsd,
    at: row.balanceSnapshotAt,
    zero: row.balanceSnapshotSource === "credit_refusal" || row.balanceSnapshotMicroUsd === 0,
  };
}

/**
 * The monthly credit of the account's last renewal, if it is due now and not
 * yet recorded: when (and why) it came in. Null: nothing to record — no anchor
 * to count it from, the anchor already holds it, the account ran dry since the
 * renewal and has not answered again inside the window (the credit did not
 * land, or something else revived it later), or the window is still open.
 */
export function dueMonthlyCredit(input: {
  row: Pick<AiProviderAccountRow, "status" | "statusChangedAt" | "balanceSnapshotMicroUsd" | "balanceSnapshotAt" | "balanceSnapshotSource">;
  renewal: Date;
  recorded: boolean;
  now: Date;
}): { at: Date; source: "revived" | "schedule" } | null {
  const { row, renewal, now } = input;
  const anchor = anchorOf(row as AiProviderAccountRow);
  const windowEnd = new Date(renewal.getTime() + CREDIT_WINDOW_MS);
  if (input.recorded || !anchor || anchor.at >= windowEnd) return null;
  // The owner's reading after the renewal is taken as holding its credit.
  if (!anchor.zero && anchor.at >= renewal) return null;
  const changedAt = row.statusChangedAt;
  if (
    anchor.zero
    && row.status === "active"
    && changedAt !== null
    && changedAt > anchor.at
    && changedAt >= renewal
    && changedAt < windowEnd
  ) {
    return { at: changedAt, source: "revived" };
  }
  // Never ran dry since the renewal and served through the window's end: the
  // credit landed unseen.
  if (
    now >= windowEnd
    && row.status === "active"
    && anchor.at < renewal
    && (changedAt === null || changedAt <= windowEnd)
  ) {
    return { at: windowEnd, source: "schedule" };
  }
  return null;
}

/** The account answered again after its zero and no money in since is known:
 * the owner bought credit, Hub does not know how much. */
export function topUpUnknown(row: AiProviderAccountRow, creditsSinceAnchor: number): boolean {
  const anchor = anchorOf(row);
  return anchor !== null
    && anchor.zero
    && row.status === "active"
    && row.statusChangedAt !== null
    && row.statusChangedAt > anchor.at
    && creditsSinceAnchor === 0;
}

export interface UpcomingCredit {
  label: string;
  microUsd: number;
  expectedAt: Date;
}

/** The monthly credits still to come over the horizon, oldest first: the
 * current renewal's while its window is open and it is not recorded, then the
 * next ones. */
export function upcomingCredits(input: {
  accounts: Array<{ id: number; label: string }>;
  credits: AiAccountCredits;
  recorded: Array<Pick<AiProviderAccountCreditRow, "accountId" | "kind" | "cycleDate">>;
  now: Date;
}): UpcomingCredit[] {
  const out: UpcomingCredit[] = [];
  for (const account of input.accounts) {
    const schedule = input.credits[account.label];
    if (!schedule) continue;
    for (const renewal of renewalsFrom(schedule.day, input.now, 3)) {
      const windowEnd = renewal.getTime() + CREDIT_WINDOW_MS;
      if (windowEnd <= input.now.getTime()) continue;
      const cycle = moscowDate(renewal);
      if (input.recorded.some((row) => row.accountId === account.id && row.kind === "monthly" && row.cycleDate === cycle)) continue;
      const expectedAt = new Date(Math.max(renewal.getTime() + CREDIT_EXPECTED_AFTER_MS, input.now.getTime()));
      if (expectedAt.getTime() - input.now.getTime() > FORECAST_HORIZON_MS) continue;
      out.push({ label: account.label, microUsd: schedule.microUsd, expectedAt });
    }
  }
  return out.sort((a, b) => a.expectedAt.getTime() - b.expectedAt.getTime());
}

export interface PoolForecast {
  /** Money on the working accounts now (those whose balance is known). */
  leftMicroUsd: number;
  /** Working accounts whose balance Hub does not know: the forecast leaves
   *  them out. */
  missing: string[];
  /** When the money is gone at the pace (credits to come included); null
   *  without spend. */
  runsOutAt: Date | null;
  nextCredit: UpcomingCredit | null;
  /** The money is gone before a credit comes: how much to buy to last until it. */
  gap: { untilAt: Date; label: string; shortfallMicroUsd: number } | null;
}

/** The pool's money walked down at the daily pace, credits added as they come. */
export function forecastPool(input: {
  now: Date;
  dailyBurnMicroUsd: number;
  balances: Array<{ label: string; estimatedMicroUsd: number | null }>;
  upcoming: UpcomingCredit[];
}): PoolForecast {
  const missing = input.balances.filter((row) => row.estimatedMicroUsd === null).map((row) => row.label);
  const left = input.balances.reduce((sum, row) => sum + (row.estimatedMicroUsd ?? 0), 0);
  const nextCredit = input.upcoming[0] ?? null;
  const burnPerMs = input.dailyBurnMicroUsd / DAY_MS;
  if (burnPerMs <= 0) {
    return { leftMicroUsd: left, missing, runsOutAt: null, nextCredit, gap: null };
  }
  let money = left;
  let at = input.now.getTime();
  for (const credit of input.upcoming) {
    const creditAt = credit.expectedAt.getTime();
    const zeroAt = at + money / burnPerMs;
    if (zeroAt < creditAt) {
      return {
        leftMicroUsd: left,
        missing,
        runsOutAt: new Date(zeroAt),
        nextCredit,
        gap: {
          untilAt: credit.expectedAt,
          label: credit.label,
          shortfallMicroUsd: Math.ceil((creditAt - zeroAt) * burnPerMs),
        },
      };
    }
    money -= (creditAt - at) * burnPerMs;
    money += credit.microUsd;
    at = creditAt;
  }
  return { leftMicroUsd: left, missing, runsOutAt: new Date(at + money / burnPerMs), nextCredit, gap: null };
}
