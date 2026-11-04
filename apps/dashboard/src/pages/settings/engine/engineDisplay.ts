import type { AgentHistoryRequest, AgentSyncPageStatus, SyncEngineStop } from "@agency_hub_core/contracts";

import { formatDateTime, formatTimeOfDay } from "@/lib/format";
import { ruPlural } from "@/lib/plural";

// The words of the Fansly screen (System → «Сбор данных → Fansly»): the Fansly Sync Engine's page status
// (`/api/v1/sync/pages`) and its history requests
// (`/api/v1/sync/history-requests`) as the owner reads them. No engine rule
// lives here: every count, bound and estimate is the server's; the tab names
// them, adds the three classes up and turns instants into ages and spans.

export type EnginePageStatus = AgentSyncPageStatus;
export type EngineWorkClass = keyof EnginePageStatus["queue"];
export type EngineHistoryRequest = AgentHistoryRequest;
/** One thing that stops keys of a page from sending now (the server's
 *  `engineStops`: the owner's pauses and the engine's hold evaluator). */
export type EngineStop = SyncEngineStop;
export type EngineStopped = "none" | "some" | "all";

/** The engine status of a page as the tab holds it: the status of a page the
 *  engine reads, still loading, failed, or `idle` — the engine has no row for
 *  the page, or holds it in a mode in which it sends nothing (`mode`). */
export type EngineStatusState =
  | { kind: "ready"; status: EnginePageStatus }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "idle"; mode: EnginePageStatus["mode"] | null };

/** The modes in which the engine is the page's sender. */
const ENGINE_READING_MODES: ReadonlySet<EnginePageStatus["mode"]> = new Set(["handover", "live"]);

export function engineStatusState(status: EnginePageStatus | undefined): EngineStatusState {
  if (status === undefined) return { kind: "idle", mode: null };
  return ENGINE_READING_MODES.has(status.mode) ? { kind: "ready", status } : { kind: "idle", mode: status.mode };
}

/** The classes in the order the scheduler serves them. */
export const ENGINE_WORK_CLASSES: readonly EngineWorkClass[] = ["urgent", "requests", "planned"];

export const ENGINE_CLASS_LABELS: Record<EngineWorkClass, string> = {
  urgent: "Срочное",
  requests: "Заявки",
  planned: "Плановое",
};

/** Who reads the engine's words: the «Синк» tab is Russian, the analytics
 *  Coverage panel English. */
export type EngineWordsLanguage = "ru" | "en";

/** "Почему ждёт" (plan §10), the engine's closed dictionary — the one place a
 *  reason gets its words, for every surface that shows one. A route (an
 *  endpoint of Fansly) puts work off in two ways: `route_budget` is its own
 *  pace, `route_hold` a 429's hold of it — the one place the page's status
 *  shows such a hold. In English the three reasons of work that only waits for
 *  its turn (`RUNNABLE_REASONS`) read the same: queued. */
const WAIT_LABELS: Record<string, Record<EngineWordsLanguage, string>> = {
  not_due: { ru: "ждёт срока", en: "not due" },
  pacer: { ru: "пауза между запросами", en: "queued" },
  class_share: { ru: "ждёт очереди", en: "queued" },
  page_hold: { ru: "страница ждёт", en: "page held" },
  route_budget: { ru: "темп Fansly", en: "queued" },
  route_hold: { ru: "Fansly просит подождать", en: "endpoint held (429)" },
  resource_hold: { ru: "повтор после ошибок", en: "resource held" },
  subject_breaker: { ru: "повтор после ошибок", en: "backing off" },
  blocked_by_vendor: { ru: "Fansly отказывает", en: "refused by Fansly" },
  quarantined: { ru: "отложено на разбор", en: "quarantined" },
  paused: { ru: "на паузе", en: "paused" },
  dependency: { ru: "ждёт другую работу", en: "waiting for other work" },
  ownership_unconfirmed: { ru: "нет сервера сбора", en: "no owner" },
  running: { ru: "читает", en: "reading" },
};

/** The reasons of work that is ready to run — the server counts those rows
 *  in `runnable` (`isRunnableReason`, `engine/status.ts`): it waits only for
 *  its turn — the page's pause, its endpoint's own pace, or other work. */
const RUNNABLE_REASONS: ReadonlySet<string> = new Set(["pacer", "route_budget", "class_share"]);

/** What holds a page. A 429 never does: it holds its route (`route_hold`).
 *  `unreadable`: rows of the page's hold set the running build cannot read —
 *  the engine admits nothing while they stand. */
const PAGE_HOLD_WORDS: Record<string, Record<EngineWordsLanguage, string>> = {
  auth: { ru: "Fansly не принимает вход", en: "Fansly refuses its credentials" },
  identity_mismatch: { ru: "Вход от другого аккаунта", en: "its credentials are another account's" },
  network: { ru: "Нет сети", en: "network errors" },
  unreadable: { ru: "Записи ожидания не читаются этой версией Hub", en: "its hold rows cannot be read by this build" },
};

/** The page holds only new credentials end. */
const CREDENTIALS_HOLDS: ReadonlySet<string> = new Set(["auth", "identity_mismatch"]);

const REQUESTER_LABELS: Record<EngineHistoryRequest["requesterKind"], string> = {
  agent_key: "агент",
  owner_session: "владелец",
  owner_cli: "владелец, из консоли",
  legacy_hydration_wrapper: "старый маршрут заявок",
  switch_migration: "перенос при переключении",
};

/** The budget that sets a request's rate (step 3b ruling 11). */
const LIMITED_BY_LABELS: Record<EngineHistoryRequest["eta"]["limitedBy"], string> = {
  page: "пауза страницы",
  route: "лимит чтения сообщений",
  family: "общий лимит запросов к сообщениям",
};

/** The words of a waiting reason; null for a code the dictionary does not hold. */
export function engineWaitWords(reason: string, language: EngineWordsLanguage): string | null {
  return WAIT_LABELS[reason]?.[language] ?? null;
}

export function engineWaitLabel(reason: string, language: EngineWordsLanguage = "ru"): string {
  return engineWaitWords(reason, language) ?? reason;
}

/** 1 234 567: the page's numbers are counts, grouped the Russian way. */
export function engineCount(value: number): string {
  return Math.round(value).toLocaleString("ru-RU");
}

/** "12 с", "4 мин", "3 ч", "5 сут" since an instant (null: never). */
export function engineAgeText(iso: string | null, now: number = Date.now()): string | null {
  if (iso === null) return null;
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 120) return `${seconds} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  return `${Math.round(hours / 24)} сут`;
}

/** A span of the ETA: "40 с", "12 мин", "1 ч 5 мин", "2 сут 3 ч". Rounded
 *  down, so a lower bound stays a lower bound. */
export function engineDurationText(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} ч` : `${hours} ч ${minutes % 60} мин`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} сут` : `${days} сут ${hours % 24} ч`;
}

/** An instant as a clock time, with its date when it is not today's. */
export function engineClockText(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const moscowDay = (value: Date) => value.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
  return moscowDay(at) === moscowDay(new Date(now)) ? formatTimeOfDay(at) : formatDateTime(iso, { yearUnlessCurrent: true });
}

const MODE_LABELS: Record<EnginePageStatus["mode"], string> = {
  live: "включён",
  handover: "переключение",
  shadow: "пробный режим",
  off: "выключен",
};

/** The page's mode in the screen's words. */
export function engineModeLabel(mode: EnginePageStatus["mode"]): string {
  return MODE_LABELS[mode] ?? mode;
}

export function engineHoldText(status: EnginePageStatus, now: number = Date.now()): string | null {
  const hold = status.holds.page;
  if (hold === null) return null;
  if (hold.until === "infinity") return "до нового входа";
  const words = hold.kind === "network" ? "сеть" : PAGE_HOLD_WORDS[hold.kind]?.ru ?? hold.kind;
  return `${words}, до ${engineClockText(hold.until, now)}`;
}

/** Who runs the page: the sync host, «сервер сбора» on screen. Without a running
 *  one nothing of the page is read, whatever its mode says: the last heartbeat is
 *  given so its age is plain. */
export function engineOwnerText(status: EnginePageStatus, now: number): string {
  const age = engineAgeText(status.owner.heartbeatAt, now);
  if (!status.owner.running) {
    return age === null
      ? "нет: страницу никто не читает"
      : `нет: страницу никто не читает (последний ответ ${age} назад)`;
  }
  return age === null ? "работает" : `отвечал ${age} назад`;
}

/** «Новые сообщения приходят сразу»: the page's socket, whether it is up, since
 *  when, and how long intake had stopped before this connection (`gapSince` is
 *  the gap every connection opens with, not a break in the one that runs). */
export function engineSocketText(status: EnginePageStatus, now: number = Date.now()): string {
  const ws = status.ws;
  if (ws === null) return "нет данных";
  if (!ws.connected) {
    return ws.since === null ? "нет, отключено" : `нет, отключено · последнее подключение в ${engineClockText(ws.since, now)}`;
  }
  const parts: string[] = [];
  if (ws.since === null) parts.push("да");
  else {
    parts.push(`да, с ${engineClockText(ws.since, now)}`);
    const gapSeconds = ws.gapSince === null
      ? 0
      : (new Date(ws.since).getTime() - new Date(ws.gapSince).getTime()) / 1000;
    if (gapSeconds >= 1) parts.push(`перед этим перерыв ${engineDurationText(gapSeconds)}`);
  }
  if (ws.decodeDebt > 0) parts.push(`не разобрано кадров: ${engineCount(ws.decodeDebt)}`);
  return parts.join(" · ");
}

/** What a class waits for, without the reasons that mean "its turn has not
 *  come" (those rows are counted as ready to run). */
export function engineWaitingText(queue: EnginePageStatus["queue"][EngineWorkClass]): string {
  return Object.entries(queue.waitingByReason)
    .filter(([reason, count]) => (count ?? 0) > 0 && !RUNNABLE_REASONS.has(reason))
    .map(([reason, count]) => `${engineWaitLabel(reason)}: ${engineCount(count ?? 0)}`)
    .join(", ");
}

/** Requests the page sent over the last hour, all classes. */
export function engineSendsLastHour(status: EnginePageStatus): number {
  return ENGINE_WORK_CLASSES.reduce((sum, workClass) => sum + status.sendsLastHour[workClass], 0);
}

/** The hour's requests by resource, the busiest first. */
export function engineSendsByResource(status: EnginePageStatus): Array<{ resource: string; sends: number }> {
  return Object.entries(status.sendsLastHour.byResource)
    .filter(([, sends]) => sends > 0)
    .map(([resource, sends]) => ({ resource, sends }))
    .sort((a, b) => b.sends - a.sends || a.resource.localeCompare(b.resource));
}

// ── what stops work, and what is true of a stream ────────────────────────────

/** The stop is the page's refused credentials: only new ones end it. */
export function isCredentialsStop(stop: EngineStop): boolean {
  return stop.reason === "page_hold" && stop.by.some((kind) => CREDENTIALS_HOLDS.has(kind));
}

/**
 * A stop in words: what stops the keys, until when and — with `listKeys` —
 * which keys. `until` writes an instant the way the surface writes its times.
 */
export function engineStopText(
  stop: EngineStop,
  options: { language: EngineWordsLanguage; until: (iso: string) => string; listKeys?: boolean; keysOf?: number | undefined },
): string {
  const ru = options.language === "ru";
  const end = stop.until === null ? "" : `${ru ? " до " : " until "}${options.until(stop.until)}`;
  const named = stop.resources.join(", ");
  const keys = options.listKeys === false || named === "" ? "" : `: ${named}`;
  switch (stop.reason) {
    case "paused": {
      if (!ru) {
        if (stop.by.includes("page")) return "Paused by the owner: the whole page";
        if (stop.by.includes("requests")) return `Paused by the owner: history requests${keys === "" ? "" : ` (${named})`}`;
        return `Paused by the owner${keys}`;
      }
      if (stop.by.includes("page")) return "На паузе: вся страница";
      if (stop.by.includes("requests")) return "На паузе: заявки на историю";
      // The codes of the keys are for «Подробнее».
      return options.keysOf !== undefined && options.listKeys !== false
        ? `На паузе: ${engineCount(stop.resources.length)} из ${engineCount(options.keysOf)} ${ruPlural(options.keysOf, "задачи", "задач", "задач")}`
        : "На паузе";
    }
    case "page_hold": {
      const kind = stop.by[0] ?? "";
      const words = PAGE_HOLD_WORDS[kind]?.[options.language] ?? kind;
      if (!ru) return `Page held: ${words}${isCredentialsStop(stop) ? " — until new ones are saved" : end}`;
      if (isCredentialsStop(stop)) return `${words}: ждёт нового входа`;
      if (kind === "network") return `${words}, ждёт${end}`;
      return `${words}${end}`;
    }
    case "resource_hold":
      if (!ru) return `Resource ${stop.by.join(", ")} held after errors${end}${keys}`;
      return `Повтор после ошибок${stop.until === null ? "" : ` в ${options.until(stop.until)}`}`;
    case "route_hold":
      return ru
        ? `Fansly просит подождать${end}`
        : `Endpoint ${stop.by.join(", ")} held (429)${end}${keys}`;
  }
}

/** The one thing that is true of a set of keys the engine reads — a stream, a
 *  block — now. "reading" is a claim, not a default. */
export type EngineReadingState =
  | "no_owner"
  | "switching"
  | "paused"
  | "page_held"
  | "held"
  | "attention"
  | "partly_paused"
  | "partly_held"
  | "reading"
  | "idle"
  | "never_read";

export interface EngineReadingFacts {
  mode: "handover" | "live";
  /** A sync host runs the page. */
  ownerRunning: boolean;
  /** How many of the keys can send nothing now, and what stops them. */
  stopped: EngineStopped;
  stops: readonly EngineStop[];
  /** The owner's pause stops every one of the keys, whatever else does. */
  paused: boolean;
  /** Some of their work is quarantined or refused by Fansly. */
  needsAttention: boolean;
  /** Their work that is open. */
  activeWork: number;
  /** Something of them was applied before. */
  everRead: boolean;
}

/**
 * What a badge says, first match: no host runs the page; every key is stopped
 * — by the owner's pause (the engine judges it first too), by the page's
 * hold, by a breaker or a 429's hold; work needs the owner; some keys are
 * stopped; work is open; nothing is.
 */
export function engineReadingState(facts: EngineReadingFacts): EngineReadingState {
  if (!facts.ownerRunning) return facts.mode === "handover" ? "switching" : "no_owner";
  if (facts.stopped === "all") {
    if (facts.paused) return "paused";
    return facts.stops.some((stop) => stop.reason === "page_hold") ? "page_held" : "held";
  }
  if (facts.needsAttention) return "attention";
  if (facts.stopped === "some") {
    return facts.stops.every((stop) => stop.reason === "paused") ? "partly_paused" : "partly_held";
  }
  if (facts.activeWork > 0) return "reading";
  return facts.everRead ? "idle" : "never_read";
}

const READING_STATE_WORDS: Record<EngineReadingState, Record<EngineWordsLanguage, { text: string; detail: string }>> = {
  no_owner: {
    ru: { text: "сервер сбора не ведёт страницу", detail: "Страницу не ведёт ни один сервер сбора: из неё ничего не читается." },
    en: { text: "not running: no owner", detail: "No sync host owns the page: nothing of it is read." },
  },
  switching: {
    ru: { text: "сервер сбора не ведёт страницу", detail: "Страница переключается на новый сбор: до конца переключения из неё ничего не читается." },
    en: { text: "not running: switching", detail: "The page is switching to the engine: nothing of it is read until the switch completes." },
  },
  paused: {
    ru: { text: "на паузе", detail: "Вы поставили на паузу всю страницу или все потоки блока." },
    en: { text: "paused", detail: "The owner paused the page or every key of this stream." },
  },
  page_held: {
    ru: { text: "страница ждёт", detail: "Сбор придержал страницу целиком: пока она ждёт, запросы не уходят." },
    en: { text: "page held", detail: "The engine holds the whole page: nothing of it is sent until the hold ends." },
  },
  held: {
    ru: { text: "ждёт", detail: "Сейчас ни один поток блока не может отправить запрос: что их держит, сказано ниже." },
    en: { text: "held", detail: "No key of this stream can send now: what holds them is said below." },
  },
  attention: {
    ru: { text: "нужно внимание", detail: "Часть работы отложена на разбор или Fansly в ней отказывает." },
    en: { text: "needs attention", detail: "Some of its work is quarantined or refused by Fansly." },
  },
  partly_paused: {
    ru: { text: "частично на паузе", detail: "Часть потоков на паузе, остальные читаются." },
    en: { text: "partly paused", detail: "The owner paused some of its keys; the others are read." },
  },
  partly_held: {
    ru: { text: "частично ждёт", detail: "Часть потоков сейчас не может отправить запрос, остальные читаются." },
    en: { text: "partly held", detail: "Some of its keys cannot send now; the others are read." },
  },
  reading: {
    ru: { text: "читается", detail: "Сервер сбора ведёт страницу, работа открыта, и её ничто не держит." },
    en: { text: "reading", detail: "A sync host runs the page, work of this stream is open and nothing holds it." },
  },
  idle: {
    ru: { text: "нет открытой работы", detail: "Открытой работы сейчас нет; раньше читалось." },
    en: { text: "idle", detail: "No work of this stream is open now; it was read before." },
  },
  never_read: {
    ru: { text: "ничего не запрошено", detail: "Работа ещё не заводилась." },
    en: { text: "nothing asked yet", detail: "No work has been filed for this stream on this page." },
  },
};

export function engineReadingWords(state: EngineReadingState, language: EngineWordsLanguage): { text: string; detail: string } {
  return READING_STATE_WORDS[state][language];
}

/** How a state reads at a glance: `ok` — it is read; `quiet` — there is
 *  nothing to read, or the owner paused it; `warn` — it sends nothing, or less
 *  than it should, and nobody chose that. */
export type EngineReadingTone = "ok" | "quiet" | "warn";

export function engineReadingTone(state: EngineReadingState): EngineReadingTone {
  if (state === "reading") return "ok";
  // A part the owner paused himself does not make the page lag.
  return state === "paused" || state === "partly_paused" || state === "idle" || state === "never_read" ? "quiet" : "warn";
}

// ── history requests ────────────────────────────────────────────────────────

export function historyDepthText(depth: EngineHistoryRequest["depth"]): string {
  if (depth.kind === "all") return "вся история";
  if (depth.kind === "latest") return `последние ${engineCount(depth.count ?? 0)} сообщений`;
  return "до прежней границы";
}

export function historyRequesterText(kind: EngineHistoryRequest["requesterKind"]): string {
  return REQUESTER_LABELS[kind];
}

/** Fans whose reading is over, of all the request names: «26 из 40 фанов». */
export function historyFansText(request: EngineHistoryRequest): string {
  const { counts } = request;
  return `${engineCount(counts.ready)} из ${engineCount(counts.total)} ${ruPlural(counts.total, "фана", "фанов", "фанов")}`;
}

/** Where the other fans are: «читается 1 · в очереди 8 · Fansly отказывает 1». */
export function historyCountsText(request: EngineHistoryRequest): string {
  const { counts } = request;
  return [
    counts.loading > 0 ? `читается ${engineCount(counts.loading)}` : null,
    counts.queued > 0 ? `в очереди ${engineCount(counts.queued)}` : null,
    counts.blocked > 0 ? `Fansly отказывает ${engineCount(counts.blocked)}` : null,
    counts.refused > 0 ? `отклонено ${engineCount(counts.refused)}` : null,
    counts.cancelled > 0 ? `отменено ${engineCount(counts.cancelled)}` : null,
  ].filter((part): part is string => part !== null).join(" · ");
}

/** The share of the request's fans that are ready, for its bar. */
export function historyReadyPercent(request: EngineHistoryRequest): number {
  if (request.counts.total === 0) return 0;
  return Math.min(100, (request.counts.ready / request.counts.total) * 100);
}

/** Reads made and still needed: always "не меньше", and "по оценке" when the
 *  server has one (plan §4.3). */
export function historyReadsText(request: EngineHistoryRequest): string {
  const { reads } = request;
  const done = `сделано ${engineCount(reads.done)}`;
  if (request.state !== "open") return done;
  const estimate = reads.remainingEstimate === null ? "оценки нет" : `по оценке ${engineCount(reads.remainingEstimate)}`;
  return `${done} · осталось не меньше ${engineCount(reads.remainingMin)}, ${estimate}`;
}

/** The two numbers of the ETA and the rate they are counted at. */
export function historyEtaText(request: EngineHistoryRequest): string {
  const { eta } = request;
  const estimate = eta.estimateSeconds === null ? "оценки нет" : `по оценке ${engineDurationText(eta.estimateSeconds)}`;
  return `не меньше ${engineDurationText(eta.lowerBoundSeconds)}, ${estimate}`;
}

export function historyRateText(request: EngineHistoryRequest): string {
  const { eta } = request;
  return `${engineCount(eta.ratePerHour)} чтений в час · доля заявок ${eta.sharePercent} % · ограничивает ${LIMITED_BY_LABELS[eta.limitedBy]}`;
}

/** A hold in force: nothing is read until it ends, and its span is not in the
 *  ETA's seconds. Null: none. */
export function historyHoldText(request: EngineHistoryRequest, now: number = Date.now()): string | null {
  const hold = request.eta.hold;
  if (hold === null) return null;
  const scope = hold.scope === "page" ? "Страница ждёт" : "Чтение сообщений ждёт";
  const until = hold.until === null ? "без срока" : `до ${engineClockText(hold.until, now)}`;
  return `${scope} ${until}: чтения стоят, в оценку времени это не входит.`;
}

/** The `/message` route reads slower than its budget since a 429. */
export function historySlowdownText(request: EngineHistoryRequest): string | null {
  const slowdown = request.eta.slowdown;
  if (slowdown === null) return null;
  const perMinute = (rate: number) => rate.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return `Чтение замедлено после 429: ${perMinute(slowdown.effectivePerMin)} в минуту вместо ${perMinute(slowdown.currentPerMin)} (уже в оценке)`;
}

export function historyWaitingText(request: EngineHistoryRequest, now: number = Date.now()): string | null {
  if (request.waitingReason === null) return null;
  const until = request.waitingUntil === null ? "" : ` до ${engineClockText(request.waitingUntil, now)}`;
  return `${engineWaitLabel(request.waitingReason)}${until}`;
}

/** When the request stopped being open, in the owner's words. */
export function historyClosedText(request: EngineHistoryRequest): string | null {
  const when = (iso: string | null) => (iso === null ? "—" : formatDateTime(iso, { yearUnlessCurrent: true }));
  if (request.state === "done") return `выполнена ${when(request.doneAt)}`;
  if (request.state === "cancelled") return `отменена ${when(request.cancelledAt)}`;
  return null;
}

/** Open requests in the order the page serves them (its round robin; the
 *  server lists them newest first). */
export function openHistoryRequests(requests: readonly EngineHistoryRequest[]): EngineHistoryRequest[] {
  const position = (request: EngineHistoryRequest) => request.queuePosition ?? Number.MAX_SAFE_INTEGER;
  return requests.filter((request) => request.state === "open")
    .sort((a, b) => position(a) - position(b) || a.createdAt.localeCompare(b.createdAt));
}
