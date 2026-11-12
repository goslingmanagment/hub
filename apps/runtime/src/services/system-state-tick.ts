import { z } from "zod";

import { MATTER_SERVER_KINDS, ROUTINE_PERIOD_MAX_SECONDS } from "@agency_hub_core/contracts";
import {
  closeMatter,
  listOpenMattersOfKinds,
  listSystemCopies,
  listSystemReporters,
  listSystemRoutines,
  markReporterUnchecked,
  matterChanges,
  openMatter,
  readScheduleRuns,
  touchMatters,
  type MatterActor,
  type MatterOpenInput,
  type ScheduleRunRow,
  type SystemCopyRow,
  type SystemRoutineRow,
} from "@agency_hub_core/db";
import { MOSCOW_TIME_ZONE } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { ledgerGet } from "./ledger-payouts.ts";
import { opsLiveRevision } from "./ops-live.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";
import {
  COPY_STALE_MS,
  copyVerdict,
  cronMaxGapSeconds,
  HUB_REPORTER,
  HUB_WRITTEN_REPORTERS,
  LEDGER_REPORTER,
  reporterViews,
  routineVerdict,
  writeRoutineReports,
  type RoutineReportInput,
} from "./system-state.ts";

/**
 * «Состояние», Hub's own pass (package P), every five minutes: Hub reports its
 * own facts as the reporter `hub` — each job schedule's newest finished job,
 * and the ledger's health read GET-only with Hub's payouts key — then makes
 * the matters of every routine, copy and reporter what they are now: one
 * writer per kind, each closes itself when its cause goes. A place whose
 * reporter is silent keeps its matters as they were: not verified is not
 * fixed. Nothing here talks to a platform or sends anything.
 */

export const SYSTEM_STATE_QUEUE = "system.state";

/** What a person reads for each of Hub's schedules. */
const HUB_SCHEDULE_TITLES: Readonly<Record<string, string>> = {
  "agent.hydration.execute": "Догрузка истории по одобренным заявкам",
  "ai.balance.watch": "Баланс Anthropic",
  "ai.media.describe.sweep": "Описание медиа ИИ",
  "ai.provider-reports.sync": "Отчёты Anthropic о тратах",
  "canonicalize.sweep": "Разбор наблюдений в события",
  "capture.payload.parity.verify": "Проверка каталога захвата",
  "chat-memory.fan-facts": "Факты о фанах (ИИ)",
  "chat-memory.history.top-up": "Догрузка истории активных чатов",
  "client.send-custody.archive-sweep": "Закрытие отложенных отправок",
  "db.disk-usage.check": "Место на диске базы",
  "fan-marks.blocklist.read": "Чтение группы FANSLY BLOCKLIST",
  "fansly.raw-payload-cleanup": "Ночная уборка сырых ответов Fansly",
  "matters.mirror": "Дела: зеркало «Ждут вас» и «Решений»",
  "model-applications.abandon.sweep": "Брошенные анкеты моделей",
  "notifications.delivery-outbox.sweep": "Отправка оповещений в Telegram",
  "notifications.paging.sweep": "Оповещения о сбоях",
  "observations.partitions.ensure": "Разделы журнала наблюдений",
  "ofapi.binding.reconcile": "OnlyFans API: привязка страниц",
  "ofapi.chargebacks.reconcile": "OnlyFans API: чарджбэки",
  "ofapi.collection.sweep": "OnlyFans API: плановые чтения",
  "ofapi.credits.accrual": "OnlyFans API: начисление кредитов",
  "ofapi.credits.balance-ping": "OnlyFans API: баланс кредитов",
  "ofapi.credits.reconcile": "OnlyFans API: сверка кредитов",
  "ofapi.events.cleanup": "OnlyFans API: уборка событий",
  "ofapi.events.sweep": "OnlyFans API: приём событий",
  "ofapi.fan-account-check": "OnlyFans API: аккаунты платящих фанов",
  "ofapi.link-stats.reconcile": "OnlyFans API: статистика ссылок",
  "ofapi.media.sweep": "OnlyFans API: загрузки медиа",
  "ofapi.pending.reconcile": "OnlyFans API: зависшие операции",
  "ofapi.typed-export.sweep": "OnlyFans API: выгрузки",
  "ops.metrics.sample": "Замеры работы Hub",
  "projections.dm-reconcile.sweep": "Сверка личных сообщений",
  "projections.message-archive.sweep": "Архив сообщений",
  "publications.fansly": "Публикации на Fansly",
  "publications.files.retention": "Уборка файлов публикаций",
  "publications.onlyfans": "Публикации на OnlyFans",
  "publications.onlyfans.checks": "Проверка публикаций OnlyFans",
  "publications.onlyfans.vault": "Альбомы волта OnlyFans",
  "sync.planner": "Старый сбор OnlyFans",
  "system.state": "Состояние: рутины, копии и дела",
  "team.sale-homes": "Чья продажа: дома продаж",
  "team.shift-rows": "Смены строками",
  "telegram.daily-report": "Отчёт о доходе в Telegram",
  "voice.notes.sweep": "Голосовые",
  "voice.provider.health": "Голос: проверка ElevenLabs",
};

const CLOCK = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: MOSCOW_TIME_ZONE });
/** «12 нояб., 08:51 (мск)»: a moment in a detail line. */
export function moscowMoment(at: Date): string {
  return `${CLOCK.format(at)} (мск)`;
}

/** Hub's schedules as routines: the newest finished job of each, the failures after its last success. */
export function hubScheduleRoutines(runs: readonly ScheduleRunRow[]): RoutineReportInput[] {
  return runs.map((run) => {
    const result = run.lastState === "completed" ? "ok" as const : run.lastState === "failed" ? "failed" as const : null;
    return {
      key: `server.hub.${run.name}`.slice(0, 120),
      place: "server" as const,
      title: HUB_SCHEDULE_TITLES[run.name] ?? `Задача ${run.name}`,
      periodSeconds: cronMaxGapSeconds(run.cron) ?? 3600,
      lastRunAt: run.lastRunAt,
      lastSuccessAt: run.lastSuccessAt,
      lastResult: result,
      detail: result === "failed" && run.lastError ? `Ошибка: ${run.lastError}`.slice(0, 500) : null,
      failedRuns: result === null ? null : run.failedAfterSuccess,
      emptySince: null,
      emptyThresholdSeconds: null,
      runCount: null,
    };
  });
}

const LEDGER_PERIOD_SECONDS = 300;
const ledgerHealthSchema = z.object({ ok: z.boolean().optional(), build: z.string().optional(), uptimeSeconds: z.number().optional() }).passthrough();
const instantText = z.string().nullable();
/** GET /v1/health/jobs (ledger, the payouts key): every job of its scheduler with its last outcome since the process started. */
export const ledgerJobsSchema = z.object({
  at: z.string(),
  startedAt: z.string(),
  scheduler: z.boolean(),
  jobs: z.array(z.object({
    job: z.string(),
    intervalSeconds: z.number().int().positive(),
    lastStartedAt: instantText,
    lastDoneAt: instantText,
    lastFailedAt: instantText,
    lastError: z.string().nullable(),
    failedInRow: z.number().int().nonnegative(),
  }).passthrough()),
}).passthrough();
export type LedgerJobsAnswer = z.infer<typeof ledgerJobsSchema>;

/** What a person reads for each of the ledger's jobs (its own words: internal/*, `server.Every`). */
const LEDGER_JOB_TITLES: Readonly<Record<string, string>> = {
  "bybit": "Ledger: движения Bybit",
  "bybit-balance": "Ledger: остатки на Bybit",
  "hub": "Ledger: продажи из Hub",
  "hub-team": "Ledger: смены команды из Hub",
  "brief-sweep": "Ledger: уборка брифа и предложений",
  "cards": "Ledger: события карт",
  "free": "Ledger: сколько можно вывести",
  "month-cards": "Ledger: карточка месяца",
  "transit": "Ledger: деньги в пути",
  "payroll": "Ledger: долги и «К выплате»",
  "report-posts": "Ledger: разбор постов «Отчётности»",
  "checks": "Ledger: проверки",
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const JOB_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/;

function instantOf(text: string | null): Date | null {
  if (text === null) return null;
  const value = new Date(text);
  return Number.isNaN(value.getTime()) ? null : value;
}

/**
 * The ledger's jobs as routines `server.ledger.<job>`: period = its interval,
 * last success = its last done, failed after two failures in a row; a job that
 * has not finished a run since the ledger started awaits from that start
 * («ещё не запускалась», then silent).
 */
export function ledgerJobRoutines(answer: LedgerJobsAnswer): RoutineReportInput[] {
  const started = instantOf(answer.startedAt);
  return answer.jobs.filter((job) => JOB_NAME.test(job.job)).map((job) => {
    const done = instantOf(job.lastDoneAt);
    const failed = instantOf(job.lastFailedAt);
    const result = failed !== null && (done === null || failed.getTime() > done.getTime()) ? "failed" as const : done !== null ? "ok" as const : null;
    const awaiting = done === null && failed === null ? started : null;
    const lastRunAt = done === null ? failed : failed === null ? done : (failed.getTime() > done.getTime() ? failed : done);
    let detail: string | null = null;
    if (result === "failed") detail = job.lastError ? `Ошибка: ${job.lastError}`.slice(0, 500) : "Ошибка без текста";
    else if (awaiting !== null) detail = `Ещё не запускалась после запуска ledger ${moscowMoment(awaiting)}`;
    return {
      key: `server.ledger.${job.job}`.slice(0, 120),
      place: "server" as const,
      title: LEDGER_JOB_TITLES[job.job] ?? `Ledger: ${job.job}`,
      periodSeconds: Math.min(Math.max(60, job.intervalSeconds), ROUTINE_PERIOD_MAX_SECONDS),
      lastRunAt,
      lastSuccessAt: done,
      lastResult: result,
      detail,
      failedRuns: job.failedInRow,
      emptySince: null,
      emptyThresholdSeconds: null,
      runCount: null,
      awaitingSince: awaiting,
    };
  });
}

export interface LedgerRead {
  /** «Ledger отвечает», in Hub's own batch. */
  service: RoutineReportInput[];
  /** The ledger's jobs (its reporter's batch), or null with why they are not checked now. */
  jobs: { routines: RoutineReportInput[]; readAt: Date | null } | null;
  uncheckedReason: string | null;
}

/**
 * The ledger as Hub sees it with its payouts key (GET only): whether it
 * answers (`/health`), and its scheduler's jobs (`/v1/health/jobs`). Not
 * connected — nothing. No answer about the jobs, or its scheduler off — the
 * jobs are «не проверено», never green.
 */
export async function readLedger(app: Pick<AppContext, "config" | "logger">, now: Date, fetchImpl?: typeof fetch): Promise<LedgerRead | null> {
  if (!app.config.ledgerPayoutsKey) return null;
  const read = { client: "system-state", ...(fetchImpl === undefined ? {} : { fetchImpl }) };
  const service: RoutineReportInput = {
    key: "server.ledger.service", place: "server", title: "Ledger отвечает", periodSeconds: LEDGER_PERIOD_SECONDS,
    lastRunAt: now, lastSuccessAt: null, lastResult: "failed", detail: null, failedRuns: null, emptySince: null,
    emptyThresholdSeconds: null, runCount: null,
  };
  try {
    const health = ledgerHealthSchema.parse(await ledgerGet(app, "/health", {}, read));
    const ok = health.ok !== false;
    service.lastResult = ok ? "ok" : "failed";
    service.lastSuccessAt = ok ? now : null;
    service.detail = ok ? (health.build ? `Сборка ${health.build.slice(0, 12)}` : null) : "Ledger отвечает, но говорит о сбое базы";
  } catch (error) {
    service.detail = `Не отвечает: ${errorText(error)}`;
  }
  if (service.lastResult !== "ok") return { service: [service], jobs: null, uncheckedReason: "Ledger не ответил" };
  try {
    const raw = await ledgerGet(app, "/v1/health/jobs", {}, { ...read, absentOn: [404] });
    if (raw === undefined) return { service: [service], jobs: null, uncheckedReason: "Ledger пока не отдаёт свои задачи" };
    const answer = ledgerJobsSchema.parse(raw);
    if (!answer.scheduler) return { service: [service], jobs: null, uncheckedReason: "Планировщик ledger выключен: его задачи не идут" };
    return { service: [service], jobs: { routines: ledgerJobRoutines(answer), readAt: instantOf(answer.at) }, uncheckedReason: null };
  } catch (error) {
    app.logger.warn({ err: error }, "system state: the ledger's jobs did not answer; they read «не проверено»");
    return { service: [service], jobs: null, uncheckedReason: "Ledger не ответил о своих задачах" };
  }
}

// ── Matters ────────────────────────────────────────────────────────────────

const SYSTEM: MatterActor = { door: "system" };
const LINK = "/system/state";
const PLACE_WORD = { server: "Сервер", mac: "Мак", pc: "ПК" } as const;

interface Finding {
  key: string;
  kind: (typeof MATTER_SERVER_KINDS)[number];
  title: string;
  object: { type: string; id: string };
  evidence: Record<string, unknown>;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

/**
 * What should be open now, each condition on its own (a failing routine that
 * then goes silent keeps both), and the keys left as they are: those of a
 * place whose reporter is silent, and a reporter's own silence outside its
 * hours.
 */
export function systemFindings(input: {
  routines: readonly SystemRoutineRow[];
  copies: readonly SystemCopyRow[];
  reporters: ReturnType<typeof reporterViews>;
  now: Date;
}): { want: Finding[]; keep: Set<string> } {
  const { now } = input;
  const want: Finding[] = [];
  const keep = new Set<string>();
  const viewOf = new Map(input.reporters.map((view) => [view.row.reporter, view]));

  for (const row of input.routines) {
    if (row.retiredAt !== null) continue;
    const view = viewOf.get(row.reporter);
    const keys = { silent: `routine.silent:${row.key}`, failed: `routine.failed:${row.key}`, empty: `routine.empty:${row.key}` };
    if (!view?.fresh) {
      for (const key of Object.values(keys)) keep.add(key);
      continue;
    }
    const verdict = routineVerdict(row, { fresh: true, onlineSince: view.row.onlineSince }, now);
    const object = { type: "routine", id: row.key };
    if (now.getTime() > verdict.silentAfter.getTime()) {
      want.push({ key: keys.silent, kind: "routine.silent", title: `Молчит: ${row.title}`, object,
        evidence: { routineKey: row.key, place: row.place, periodSeconds: row.periodSeconds, lastRunAt: iso(row.lastRunAt) } });
    }
    if (row.lastResult === "failed" && row.failedStreak >= 2) {
      want.push({ key: keys.failed, kind: "routine.failed", title: `Два сбоя подряд: ${row.title}`, object,
        evidence: { routineKey: row.key, place: row.place, failedStreak: row.failedStreak, lastRunAt: iso(row.lastRunAt), detail: row.detail } });
    }
    if (row.lastResult === "empty_input" && row.emptyThresholdSeconds !== null) {
      const since = row.emptySince ?? row.lastRunAt ?? row.firstSeenAt;
      if (now.getTime() - since.getTime() > row.emptyThresholdSeconds * 1000) {
        want.push({ key: keys.empty, kind: "routine.empty", title: `Пустой вход: ${row.title}`, object,
          evidence: { routineKey: row.key, place: row.place, emptySince: since.toISOString(), thresholdSeconds: row.emptyThresholdSeconds } });
      }
    }
  }

  for (const row of input.copies) {
    if (row.retiredAt !== null) continue;
    const key = `copy.stale:${row.key}`;
    const view = viewOf.get(row.reporter);
    if (!view?.fresh) {
      keep.add(key);
      continue;
    }
    if (copyVerdict(row, true, now).state === "stale") {
      want.push({ key, kind: "copy.stale", title: `Копия старше ${COPY_STALE_MS / 3_600_000} ч: ${row.title}`,
        object: { type: "copy", id: row.key }, evidence: { copyKey: row.key, takenAt: iso(row.takenAt) } });
    }
  }

  for (const view of input.reporters) {
    if (HUB_WRITTEN_REPORTERS.has(view.row.reporter)) continue;
    const key = `reporter.silent:${view.row.reporter}`;
    if (view.silentProblem) {
      want.push({ key, kind: "reporter.silent", title: `${PLACE_WORD[view.row.place]} не присылает состояние`,
        object: { type: "reporter", id: view.row.reporter }, evidence: { reporter: view.row.reporter, lastReportAt: view.row.lastReportAt.toISOString() } });
    } else if (!view.fresh) {
      // Silent outside its hours: what was open stays open until it reports again.
      keep.add(key);
    }
  }
  return { want, keep };
}

export interface SystemMattersTally {
  opened: number;
  closed: number;
}

/** Makes the matters of «Состояние» what the findings say: opens or updates, closes what went (cause gone). */
export async function reconcileSystemMatters(app: Pick<AppContext, "db" | "logger">, findings: { want: Finding[]; keep: Set<string> }, now: Date): Promise<SystemMattersTally> {
  const open = new Map((await listOpenMattersOfKinds(app.db, [...MATTER_SERVER_KINDS])).map((matter) => [matter.key, matter]));
  const seen = new Set<string>();
  const touched: string[] = [];
  const tally: SystemMattersTally = { opened: 0, closed: 0 };
  for (const finding of findings.want) {
    if (seen.has(finding.key)) continue;
    seen.add(finding.key);
    const input: MatterOpenInput = {
      key: finding.key, kind: finding.kind, source: "server", title: finding.title.slice(0, 300), object: finding.object,
      pageIds: [], owner: { role: "owner" }, money: false, evidence: finding.evidence, link: LINK,
    };
    const existing = open.get(finding.key);
    if (existing !== undefined && matterChanges(existing, input).length === 0) {
      touched.push(finding.key);
      continue;
    }
    try {
      const result = await openMatter(app.db, input, SYSTEM, now);
      if (result.transition === "opened" || result.transition === "reopened") tally.opened += 1;
    } catch (error) {
      app.logger.error({ err: error, key: finding.key }, "system state: a matter could not be opened");
    }
  }
  for (const [key, matter] of open) {
    if (seen.has(key) || findings.keep.has(key)) continue;
    try {
      const result = await closeMatter(app.db, { key, how: "cause_gone", writer: matter.source }, SYSTEM, now);
      if (result.transition === "closed") tally.closed += 1;
    } catch (error) {
      app.logger.error({ err: error, key }, "system state: a matter could not be closed");
    }
  }
  await touchMatters(app.db, touched, now);
  return tally;
}

/** One pass: Hub's own facts reported, the ledger's jobs as its reporter, then the matters made what they are now. */
export async function runSystemStateTick(
  app: AppContext,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<SystemMattersTally & { routines: number }> {
  const now = options.now ?? new Date();
  const own = hubScheduleRoutines(await readScheduleRuns(app.db));
  const ledger = await readLedger(app, now, options.fetchImpl);
  const written = await writeRoutineReports(app, {
    reporter: HUB_REPORTER, place: "server", agentKeyId: null, readAt: now, version: opsLiveRevision()?.slice(0, 12) ?? null,
    routines: [...own, ...(ledger?.service ?? [])],
  }, now);
  if (ledger?.jobs) {
    await writeRoutineReports(app, {
      reporter: LEDGER_REPORTER, place: "server", agentKeyId: null, readAt: ledger.jobs.readAt, version: null, routines: ledger.jobs.routines,
    }, now);
  } else if (ledger?.uncheckedReason) {
    await markReporterUnchecked(app.db, { reporter: LEDGER_REPORTER, at: now, reason: ledger.uncheckedReason });
  }

  const [config, reporters, routines, copies] = await Promise.all([
    loadEffectiveConfig(app.db, app.config),
    listSystemReporters(app.db),
    listSystemRoutines(app.db),
    listSystemCopies(app.db),
  ]);
  const findings = systemFindings({ routines, copies, reporters: reporterViews(reporters, config, now), now });
  const tally = await reconcileSystemMatters(app, findings, now);
  return { ...tally, routines: written.accepted };
}

export async function ensureSystemStateQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, SYSTEM_STATE_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureSystemStateSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(SYSTEM_STATE_QUEUE, "*/5 * * * *", null, { tz: "UTC" });
}
