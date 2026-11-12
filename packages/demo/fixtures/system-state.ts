/**
 * Система → «Состояние» of the invented agency: Hub's own schedules, the
 * Mac's routines (an agent gateway's jobs, launchd collectors, scheduled
 * tasks), and the copies. Three states, by the `hub-demo-scenario` cookie:
 * none — one silent routine, one empty input and one stale copy on top (and
 * the ledger restarted a while ago: its hourly checks have not run since);
 * `healthy` — everything on time; `mac-silent` — the Mac's reporter silent
 * inside its hours, its lines «не проверено»; `ledger-off` — the ledger's
 * scheduler is off, its jobs «не проверено».
 */
import type { KernelOperationResponse, RoutineState, SystemLevel, SystemPlace } from "@agency_hub_core/contracts";

import { iso, type DemoRequest } from "../core.ts";

type StateAnswer = KernelOperationResponse<"systemState">;
type Routine = StateAnswer["routines"][number];
type Copy = StateAnswer["copies"][number];

const MINUTE = 60_000;
/** «12 нояб., 12:05», Moscow: as the hub's detail line says it. */
const MOMENT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Moscow" });
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const LEVEL: Readonly<Record<RoutineState, SystemLevel>> = {
  unchecked: "unchecked", silent: "problem", failing: "problem", empty_long: "problem", failed_once: "attention", empty: "attention",
  outcome_unknown: "healthy", pending: "healthy", skipped: "healthy", ok: "healthy",
};

interface Spec {
  key: string;
  place: SystemPlace;
  title: string;
  period: number;
  /** How long ago it last ran, in ms; null — never. */
  ranAgo: number | null;
  result: Routine["lastResult"];
  /** How long ago it last succeeded, when not its last run. */
  okAgo?: number;
  detail?: string;
  failed?: number;
  emptyFor?: number;
  emptyLimit?: number;
  reporter: string;
  by: string | null;
  /** The runner restarted this long ago and the routine has not run since. */
  awaiting?: number;
}

/** Hub's own schedules: each runs at its cron, its newest job completed. */
const SERVER: ReadonlyArray<[key: string, title: string, period: number]> = [
  ["agent.hydration.execute", "Догрузка истории по одобренным заявкам", 2 * MINUTE],
  ["ai.balance.watch", "Баланс Anthropic", 30 * MINUTE],
  ["ai.media.describe.sweep", "Описание медиа ИИ", MINUTE],
  ["canonicalize.sweep", "Разбор наблюдений в события", MINUTE],
  ["chat-memory.history.top-up", "Догрузка истории активных чатов", 15 * MINUTE],
  ["client.send-custody.archive-sweep", "Закрытие отложенных отправок", 5 * MINUTE],
  ["db.disk-usage.check", "Место на диске базы", HOUR],
  ["fansly.raw-payload-cleanup", "Ночная уборка сырых ответов Fansly", DAY],
  ["matters.mirror", "Дела: зеркало «Ждут вас» и «Решений»", MINUTE],
  ["notifications.delivery-outbox.sweep", "Отправка оповещений в Telegram", MINUTE],
  ["notifications.paging.sweep", "Оповещения о сбоях", MINUTE],
  ["observations.partitions.ensure", "Разделы журнала наблюдений", DAY],
  ["ops.metrics.sample", "Замеры работы Hub", MINUTE],
  ["projections.message-archive.sweep", "Архив сообщений", MINUTE],
  ["publications.fansly", "Публикации на Fansly", MINUTE],
  ["publications.files.retention", "Уборка файлов публикаций", HOUR],
  ["system.state", "Состояние: рутины, копии и дела", 5 * MINUTE],
  ["team.sale-homes", "Чья продажа: дома продаж", HOUR],
  ["team.shift-rows", "Смены строками", 10 * MINUTE],
  ["telegram.daily-report", "Отчёт о доходе в Telegram", HOUR],
];

/** The ledger's scheduler: its twelve jobs, each at its interval. */
const LEDGER: ReadonlyArray<[job: string, title: string, period: number]> = [
  ["bybit", "Ledger: движения Bybit", 15 * MINUTE],
  ["bybit-balance", "Ledger: остатки на Bybit", HOUR],
  ["hub", "Ledger: продажи из Hub", HOUR],
  ["hub-team", "Ledger: смены команды из Hub", HOUR],
  ["brief-sweep", "Ledger: уборка брифа и предложений", 15 * MINUTE],
  ["cards", "Ledger: события карт", 15 * MINUTE],
  ["free", "Ledger: сколько можно вывести", HOUR],
  ["month-cards", "Ledger: карточка месяца", HOUR],
  ["transit", "Ledger: деньги в пути", HOUR],
  ["payroll", "Ledger: долги и «К выплате»", HOUR],
  ["report-posts", "Ledger: разбор постов «Отчётности»", 15 * MINUTE],
  ["checks", "Ledger: проверки", HOUR],
];

/** The Mac: the agent gateway's jobs, launchd's collectors and copies, the scheduled tasks of the desktop app. */
const MAC: ReadonlyArray<[key: string, title: string, period: number, result: Routine["lastResult"]]> = [
  ["mac.openclaw.watchdog", "Сторож сбоев", 5 * MINUTE, "ok"],
  ["mac.openclaw.fan-watch", "Слежка за фанами", 10 * MINUTE, "ok"],
  ["mac.openclaw.shift-audit", "Аудит смены", 5 * MINUTE, "skipped"],
  ["mac.openclaw.heartbeat-owner", "Проактивная проверка (агент владельца)", 2 * MINUTE, "skipped"],
  ["mac.openclaw.heartbeat-team", "Проактивная проверка (агент команды)", 2 * MINUTE, "skipped"],
  ["mac.openclaw.group-tails", "Хвосты в группах", 5 * MINUTE, "skipped"],
  ["mac.openclaw.report-nudge", "Отчёт не сходится", 15 * MINUTE, "ok"],
  ["mac.openclaw.content-queue", "Контент: отложка", 10 * MINUTE, "ok"],
  ["mac.openclaw.ledger-nightly", "Ledger: ночной бриф", DAY, "ok"],
  ["mac.openclaw.ledger-urgent", "Ledger: срочное", 15 * MINUTE, "skipped"],
  ["mac.openclaw.night-shift", "Ночная смена доски задач", DAY, "ok"],
  ["mac.openclaw.backup", "Копия настроек агентов", DAY, "ok"],
  ["mac.launchd.ledger-reports", "Ledger: посты из чата отчётности", 15 * MINUTE, "ok"],
  ["mac.launchd.ledger-cards", "Ledger: события карт", 30 * MINUTE, "ok"],
  ["mac.launchd.ledger-sheets", "Ledger: таблицы выплат", HOUR, "ok"],
  ["mac.launchd.ledger-backup", "Копия ledger", 6 * HOUR, "ok"],
  ["mac.launchd.taskindex-backup", "Копия доски задач", DAY, "ok"],
  ["mac.launchd.tasks-render", "Список задач в базе знаний", HOUR, "ok"],
  ["mac.launchd.contentops-tunnel", "Туннель к ContentOps", 5 * MINUTE, "ok"],
  ["mac.claude.hiring-daily", "Найм: утренний разбор", DAY, null],
  ["mac.claude.customs-daily", "Кастомы: несданные", DAY, null],
  ["mac.claude.traffic-daily", "Трафик за день", DAY, null],
];

function routineOf(spec: Spec, now: number, reporterFresh: boolean, onlineSince: number): Routine {
  const lastRunAt = spec.ranAgo === null ? null : now - spec.ranAgo;
  const lastSuccessAt = spec.okAgo !== undefined ? now - spec.okAgo : spec.result === "ok" && lastRunAt !== null ? lastRunAt : null;
  const emptySince = spec.emptyFor === undefined ? null : now - spec.emptyFor;
  const awaitingSince = spec.awaiting === undefined ? null : now - spec.awaiting;
  const base = awaitingSince !== null ? Math.max(awaitingSince, onlineSince) : Math.max(lastRunAt ?? now - 7 * DAY, onlineSince);
  const silentAfter = base + 2 * spec.period + 10 * MINUTE;
  let state: RoutineState;
  if (!reporterFresh) state = "unchecked";
  else if (now > silentAfter) state = "silent";
  else if (awaitingSince !== null) state = "pending";
  else if (spec.result === "failed") state = (spec.failed ?? 1) >= 2 ? "failing" : "failed_once";
  else if (spec.result === "empty_input") state = spec.emptyLimit !== undefined && (spec.emptyFor ?? 0) > spec.emptyLimit ? "empty_long" : "empty";
  else if (spec.result === null) state = lastRunAt === null ? "pending" : "outcome_unknown";
  else state = spec.result;
  return {
    key: spec.key,
    reporter: spec.reporter,
    place: spec.place,
    title: spec.title,
    periodSeconds: spec.period / 1000,
    lastRunAt: lastRunAt === null ? null : iso(new Date(lastRunAt)),
    lastSuccessAt: lastSuccessAt === null ? null : iso(new Date(lastSuccessAt)),
    lastResult: awaitingSince !== null ? null : spec.result,
    detail: spec.detail ?? null,
    failedStreak: spec.failed ?? 0,
    emptySince: emptySince === null ? null : iso(new Date(emptySince)),
    emptyThresholdSeconds: spec.emptyLimit === undefined ? null : spec.emptyLimit / 1000,
    reportedAt: iso(new Date(now - (spec.reporter !== "mac" ? 2 * MINUTE : reporterFresh ? 3 * MINUTE : 47 * MINUTE))),
    reportedBy: spec.by,
    state,
    level: LEVEL[state],
    silentAfter: iso(new Date(silentAfter)),
  };
}

const ORDER: Readonly<Record<SystemLevel, number>> = { problem: 0, attention: 1, unchecked: 2, healthy: 3 };
const PLACE_ORDER: Readonly<Record<SystemPlace, number>> = { server: 0, mac: 1, pc: 2 };

export function demoSystemState(request: DemoRequest): StateAnswer {
  const now = request.now.getTime();
  const scenario = request.scenario === "healthy" || request.scenario === "mac-silent" || request.scenario === "ledger-off"
    ? request.scenario : "problems";
  const macFresh = scenario !== "mac-silent";
  const ledgerFresh = scenario !== "ledger-off";
  const macReportedAt = macFresh ? now - 3 * MINUTE : now - 47 * MINUTE;
  const macOnlineSince = now - 10 * DAY;
  // Every routine ran within a fraction of its period: a stable spread, so a reload shows the same screen.
  const spread = (period: number, index: number) => Math.round(period * (0.15 + ((index * 37) % 60) / 100));

  const specs: Spec[] = [
    ...SERVER.map(([name, title, period], index): Spec => ({
      key: `server.hub.${name}`, place: "server", title, period, ranAgo: spread(period, index), result: "ok", reporter: "hub", by: null,
    })),
    { key: "server.ledger.service", place: "server", title: "Ledger отвечает", period: 5 * MINUTE, ranAgo: 2 * MINUTE, result: "ok",
      detail: "Сборка 2608c1737ade", reporter: "hub", by: null },
    ...LEDGER.map(([job, title, period], index): Spec => {
      // In the problems' state the ledger restarted 20 minutes ago: its hourly checks have not run since.
      const restarted = scenario === "problems" && job === "checks";
      return {
        key: `server.ledger.${job}`, place: "server", title, period, ranAgo: restarted ? 52 * MINUTE : spread(period, index + 7), result: "ok",
        ...(restarted ? { awaiting: 20 * MINUTE, detail: `Ещё не запускалась после запуска ledger ${MOMENT.format(new Date(now - 20 * MINUTE))} (мск)` } : {}),
        reporter: "ledger", by: null,
      };
    }),
    ...MAC.map(([key, title, period, result], index): Spec => ({
      key, place: "mac", title, period, ranAgo: spread(period, index + 3) + (macFresh ? 0 : 47 * MINUTE),
      result, reporter: "mac", by: "Сборщик мака",
    })),
    {
      key: "mac.openclaw.of-mail", place: "mac", title: "Почта OnlyFans", period: 2 * HOUR, ranAgo: 37 * MINUTE,
      result: scenario === "healthy" ? "ok" : "empty_input", emptyFor: scenario === "healthy" ? undefined : 8 * DAY + 3 * HOUR,
      emptyLimit: 3 * DAY, okAgo: scenario === "healthy" ? undefined : 8 * DAY + 3 * HOUR, reporter: "mac", by: "Сборщик мака",
    },
    {
      key: "mac.launchd.model-mirror", place: "mac", title: "Зеркало файлов модели на ПК", period: DAY,
      ranAgo: scenario === "healthy" ? 7 * HOUR : 3 * DAY + 2 * HOUR, result: "ok",
      reporter: "mac", by: "Сборщик мака",
    },
  ];

  const routines = specs
    .map((spec) => routineOf(
      spec, now,
      spec.reporter === "hub" || (spec.reporter === "ledger" ? ledgerFresh : macFresh),
      spec.reporter === "mac" ? macOnlineSince : now - 5 * DAY,
    ))
    .sort((left, right) => ORDER[left.level] - ORDER[right.level] || PLACE_ORDER[left.place] - PLACE_ORDER[right.place] || left.title.localeCompare(right.title, "ru"));

  const copy = (key: string, title: string, source: string, destination: string, takenAgo: number, bytes: number, kept: number, detail: string | null): Copy => {
    const state = !macFresh ? "unchecked" : takenAgo > 36 * HOUR ? "stale" : "fresh";
    return {
      key, reporter: "mac", title, source, destination, takenAt: iso(new Date(now - takenAgo)), bytes, kept, detail,
      reportedAt: iso(new Date(macReportedAt)), reportedBy: "Сборщик мака", state,
      level: state === "stale" ? "problem" : state === "unchecked" ? "unchecked" : "healthy",
    };
  };
  const copies: Copy[] = [
    copy("copy.agency-hub", "База Hub", "agency-de", "мак: ~/Backups/agency-hub", 5 * HOUR + 20 * MINUTE, 3_733_291_202, 5, "Таблиц: 437, с данными 313"),
    copy("copy.contentops", "База ContentOps", "ВМ ContentOps", "мак: ~/Backups/contentops", scenario === "healthy" ? 4 * HOUR : 2 * DAY + 6 * HOUR, 241_509_113, 2, "Таблиц: 69"),
    copy("copy.ledger", "База ledger", "agency-de", "мак: ~/Backups/ledger", 2 * HOUR + 10 * MINUTE, 17_850_368, 98, null),
    copy("copy.taskindex", "База доски задач", "agency-de", "мак: ~/Backups/taskindex", 9 * HOUR, 1_204_224, 36, null),
  ].sort((left, right) => ORDER[left.level] - ORDER[right.level] || left.title.localeCompare(right.title, "ru"));

  return {
    server: {
      revision: "f4ff5ae34552661e4cc65b07f8be77994c2df00e",
      processes: [
        { role: "api", state: "active", lastSeenAt: iso(new Date(now - 20_000)) },
        { role: "worker", state: "active", lastSeenAt: iso(new Date(now - 35_000)) },
        { role: "scheduler", state: "active", lastSeenAt: iso(new Date(now - 12_000)) },
        { role: "sync", state: "active", lastSeenAt: iso(new Date(now - 41_000)) },
      ],
      queue: { waiting: 2, oldestWaitingAgeMs: 4_000, failedLastHour: 0 },
      openIncidents: scenario === "healthy" ? 0 : 2,
    },
    reporters: [
      { reporter: "hub", place: "server", lastReportAt: iso(new Date(now - 2 * MINUTE)), onlineSince: iso(new Date(now - 5 * DAY)), version: "f4ff5ae34552",
        uncheckedSince: null, uncheckedReason: null, fresh: true, hours: null, silentProblem: false },
      { reporter: "ledger", place: "server", lastReportAt: iso(new Date(now - (ledgerFresh ? 2 : 27) * MINUTE)), onlineSince: iso(new Date(now - 5 * DAY)),
        version: null, uncheckedSince: ledgerFresh ? null : iso(new Date(now - 25 * MINUTE)),
        uncheckedReason: ledgerFresh ? null : "Планировщик ledger выключен: его задачи не идут", fresh: ledgerFresh, hours: null, silentProblem: false },
      { reporter: "mac", place: "mac", lastReportAt: iso(new Date(macReportedAt)), onlineSince: iso(new Date(macOnlineSince)), version: "1",
        uncheckedSince: null, uncheckedReason: null, fresh: macFresh, hours: { from: 10, to: 3 }, silentProblem: !macFresh },
    ],
    routines,
    copies,
    limits: { copyStaleHours: 36, reporterSilentMinutes: 30 },
    serverNow: iso(new Date(now)),
  };
}
