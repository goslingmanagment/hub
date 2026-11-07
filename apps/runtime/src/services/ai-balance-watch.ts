// The half-hourly Anthropic balance check (worker): counts the monthly credits
// that came in and pages the owner once when the money on all accounts runs
// out within aiBalanceWarnDays (ai-account-balance.ts has the rules).

import { aiAccountCreditsOf, formatUsdFromMicroUsd } from "@agency_hub_core/shared";
import {
  insertAiProviderAccountCredit,
  listAiProviderAccountCredits,
  listAiProviderAccounts,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { DAY_MS, dueMonthlyCredit, moscowDate, MSK_OFFSET_MS, renewalsFrom } from "./ai-account-balance.ts";
import { getAdminAiAccountsReport } from "./ai-provider-accounts-report.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import {
  AI_BALANCE_LOW_SUBKEY,
  openCriticalNotificationIncident,
  resolveCriticalNotificationIncident,
} from "./notification-incidents.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const AI_BALANCE_WATCH_QUEUE = "ai.balance.watch";

type WatchApp = Pick<AppContext, "db" | "config" | "anthropicAccountPool"> & {
  logger: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
};

/** Record the monthly credits that came in (one per renewal). */
export async function recordMonthlyCredits(app: WatchApp, now = new Date()) {
  const effective = await loadEffectiveConfig(app.db, app.config);
  const schedules = aiAccountCreditsOf(effective.aiAccountCredits);
  if (Object.keys(schedules).length === 0) return 0;
  const rows = await listAiProviderAccounts(app.db, "anthropic");
  const recorded = await listAiProviderAccountCredits(app.db, {
    provider: "anthropic",
    since: now,
    cycleSince: moscowDate(new Date(now.getTime() - 40 * DAY_MS)),
  });
  let added = 0;
  for (const row of rows) {
    const schedule = schedules[row.label];
    if (!schedule) continue;
    const [renewal] = renewalsFrom(schedule.day, now, 1);
    const cycleDate = moscowDate(renewal!);
    const due = dueMonthlyCredit({
      row,
      renewal: renewal!,
      recorded: recorded.some((credit) => credit.accountId === row.id && credit.kind === "monthly" && credit.cycleDate === cycleDate),
      now,
    });
    if (!due) continue;
    const inserted = await insertAiProviderAccountCredit(app.db, {
      accountId: row.id,
      kind: "monthly",
      amountMicroUsd: schedule.microUsd,
      creditedAt: due.at,
      cycleDate,
      source: due.source,
      actorUserId: null,
    });
    if (inserted) {
      added += 1;
      app.logger.info({
        component: "ai_balance_watch",
        account: row.label,
        cycleDate,
        source: due.source,
        microUsd: schedule.microUsd,
      }, "Anthropic monthly credit counted in the balance");
    }
  }
  return added;
}

function moscowTime(at: Date) {
  const msk = new Date(at.getTime() + MSK_OFFSET_MS).toISOString();
  return `${msk.slice(8, 10)}.${msk.slice(5, 7)} ${msk.slice(11, 16)} MSK`;
}

/** The half-hourly check: count the credits that came in, then page the owner
 * once when the pool's money runs out within aiBalanceWarnDays (and once when
 * it no longer does). A forecast that leaves an account out moves nothing:
 * unknown is not healthy. */
export async function runAiBalanceWatch(app: WatchApp, now = new Date()) {
  if (!app.anthropicAccountPool) return;
  await recordMonthlyCredits(app, now);
  const report = await getAdminAiAccountsReport(app, now);
  const forecast = report.forecast;
  const incident = {
    kind: "ai_provider_billing" as const,
    platformAccountId: null,
    pageLabel: null,
    platform: null,
    subKey: AI_BALANCE_LOW_SUBKEY,
  };
  app.logger.info({
    component: "ai_balance_watch",
    leftMicroUsd: forecast.leftMicroUsd,
    missing: forecast.missing.length,
    low: forecast.low,
  }, "Anthropic balance check");
  if (forecast.missing.length > 0) return;
  if (forecast.low && forecast.runsOutAt) {
    const next = forecast.nextCredit;
    const gap = forecast.gap;
    await openCriticalNotificationIncident(app, {
      ...incident,
      errorCode: "provider_billing",
      errorSummary: [
        `Hub's AI money on the Anthropic accounts (about ${formatUsdFromMicroUsd(forecast.leftMicroUsd)},`,
        `${formatUsdFromMicroUsd(report.dailyBurnMicroUsd)}/day over 3 days) runs out about ${moscowTime(new Date(forecast.runsOutAt))}.`,
        gap
          ? `The next credit is ${gap.label} about ${moscowTime(new Date(gap.untilAt))}: top up about ${formatUsdFromMicroUsd(gap.shortfallMicroUsd)} on any account to last until it, then note it on the usage screen.`
          : next
            ? `Credits to come are counted (next: ${next.label} about ${moscowTime(new Date(next.expectedAt))}).`
            : "No monthly credit is due: top up, then note it on the usage screen.",
      ].join(" "),
      occurredAt: now,
    });
  } else {
    await resolveCriticalNotificationIncident(app, { ...incident, recoveredAt: now });
  }
}

export async function ensureAiBalanceWatchQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, AI_BALANCE_WATCH_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureAiBalanceWatchSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  // Every 30 min, at :22 and :52 — clear of the voice check (:07/:37).
  await boss.schedule(AI_BALANCE_WATCH_QUEUE, "22,52 * * * *", null, { tz: "UTC" });
}
