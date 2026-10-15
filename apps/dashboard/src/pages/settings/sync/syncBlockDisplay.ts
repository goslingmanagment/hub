import type { SyncBlockStatus, SyncBlocksPage, SyncDiagnosis } from "@agency_hub_core/contracts";
import { formatRelativeTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import type { PageStatus } from "./SyncPageParts.js";
import { SYNC_BLOCK_LABELS, syncCadenceText, syncStreamLabel } from "./syncVocabulary.js";

type SyncBlockKey = SyncBlockStatus["block"];
type SyncBlockState = SyncBlockStatus["state"];
type SyncBlockSubstream = SyncBlockStatus["substreams"][number];
type SyncReasonCarrier = Pick<SyncBlockStatus, "statusReason" | "error"> |
  Pick<SyncBlockSubstream, "statusReason" | "error">;

export type { SyncBlockKey, SyncBlockState, SyncBlockSubstream };

// The OnlyFans screen of System («Сбор данных → OnlyFans»): the pages the
// legacy page-sync executor serves, in the console's language. The server
// describes a block in English (its reasons, its diagnosis); the words here are
// chosen from the codes, and only a reason with no code of ours falls back to
// the server's own text.

interface BlockTone {
  badge: string;
  dot: string;
  text: string;
}

const NEUTRAL: BlockTone = { badge: "badge", dot: "status-dot", text: "text-text-secondary" };
const OK: BlockTone = { badge: "badge badge-success", dot: "status-dot status-dot-ok", text: "text-green" };
const WORKING: BlockTone = { badge: "badge badge-info", dot: "status-dot status-dot-ok", text: "text-text-secondary" };
const WARN: BlockTone = { badge: "badge badge-warning", dot: "status-dot status-dot-warn", text: "text-warning-dark" };
const DANGER: BlockTone = { badge: "badge badge-danger", dot: "status-dot status-dot-error", text: "text-danger" };
const QUIET: BlockTone = { badge: "badge", dot: "status-dot", text: "text-text-muted" };

const BLOCK_STATE_TONES: Record<SyncBlockState, BlockTone> = {
  not_started: NEUTRAL,
  scheduled: NEUTRAL,
  up_to_date: OK,
  syncing: WORKING,
  backfilling: WORKING,
  retrying: WARN,
  delayed: WARN,
  failed: DANGER,
  paused: QUIET,
  not_available: QUIET,
  // A block of a Fansly page: the Fansly screen shows it with its own cards
  // (`engine/EngineBlocks.tsx`); nothing here formats one.
  engine: { badge: "badge badge-accent", dot: "status-dot", text: "text-text-secondary" },
};

const BLOCK_STATE_LABELS: Record<SyncBlockState, string> = {
  not_started: "Не запускался",
  scheduled: "В очереди",
  up_to_date: "Актуально",
  syncing: "Обновляется",
  backfilling: "Догружает историю",
  retrying: "Повторяет попытку",
  delayed: "Отстаёт",
  failed: "Ошибка",
  paused: "На паузе",
  not_available: "Недоступно",
  engine: "Сбор Fansly",
};

// A legacy block (any state but the Fansly one) belongs to a page the legacy
// page-sync executor serves: OnlyFans. A Fansly page's blocks are worded by
// the Fansly screen itself (`engine/engineBlockDisplay.ts`), and nothing here
// formats a Fansly block or stream.

const BLOCK_DESCRIPTIONS: Record<SyncBlockKey, string> = {
  connection: "Проверяет, что аккаунт страницы подключён и вход действует.",
  financials: "Операции и рейтинг топ фанов.",
  audience: "Подписчики и фолловеры страницы.",
  messages_live: "Список чатов: новые чаты и последнее сообщение каждого.",
  messages_history: "Полный текст сообщений каждого чата.",
};

// English: the analytics Coverage panel's words for a stream (it reads them
// from here). This screen names streams in Russian (`syncStreamLabel`).
const COVERAGE_STREAM_LABELS: Record<string, string> = {
  light: "connection",
  fan_identities: "fan identities",
  transactions: "transactions",
  top_spenders: "top spenders",
  subscribers: "subscribers",
  followers: "followers",
  followers_reconcile: "follower reconcile",
  dm_conversations: "conversation sync",
  dm_messages: "message history",
  media_stats: "media statistics",
  stats_snapshot: "account statistics",
};

/** The stream a block's progress belongs to, when it is not the block's own. */
const PROGRESS_STREAM_LABELS: Record<string, string> = {
  fan_identities: "профили фанов",
  top_spenders: "рейтинг топ фанов",
  dm_conversations: "список чатов",
};

/** What the server counts progress in, as "из N …" takes it: [one, many]. */
const PROGRESS_UNITS: Record<string, readonly [string, string]> = {
  conversations: ["чата", "чатов"],
  identities: ["профиля", "профилей"],
  items: ["элемента", "элементов"],
  messages: ["сообщения", "сообщений"],
  months: ["месяца", "месяцев"],
  subscribers: ["подписчика", "подписчиков"],
  followers: ["фолловера", "фолловеров"],
  transactions: ["операции", "операций"],
};

/** The server's reasons in the screen's words, by their code. */
const REASON_WORDS: Record<string, string> = {
  credentials_invalid: "Данные входа больше не действуют",
  progress_stalled: "Загрузка перестала продвигаться",
  unmet_dependency: "Ждёт, пока закончатся другие потоки",
  queue_waiting: "В очереди: начнётся после текущей загрузки",
  queue_delayed: "Слишком долго в очереди, загрузка не идёт",
  stale: "Последнее обновление старше нормы",
  physical_attempt_stuck: "Запросы не завершились к сроку",
  physical_attempts_without_success: "Запросы раз за разом без успеха",
  webhook_live: "Новые сообщения приходят через вебхуки OnlyFans API",
  webhook_waiting: "Ждём первое событие сообщений от OnlyFans API",
  webhook_silent: "Давно не было событий сообщений от OnlyFans API",
  ofapi_financials_live: "Операции приходят из OnlyFans API",
  ofapi_financials_waiting: "Ждём первую операцию страницы из OnlyFans API",
  ofapi_auth: "OnlyFans API сообщает, что аккаунту нужна проверка",
  ofapi_auth_connected: "Вход через OnlyFans API подключён",
  fansly_sync_engine_off: "Сбор Fansly эту страницу не ведёт",
};

const BLOCK_ORDER: SyncBlockKey[] = [
  "connection",
  "financials",
  "audience",
  "messages_live",
  "messages_history",
];

/** Counts the Russian way: 1 234 567. */
function count(value: number): string {
  return value.toLocaleString("ru-RU");
}

/** "из 1 чата", "из 5 чатов": the genitive after "из". */
function ofUnit(total: number, unit: string): string {
  const words = PROGRESS_UNITS[unit];
  if (!words) return unit;
  return total % 10 === 1 && total % 100 !== 11 ? words[0] : words[1];
}

function progressCounts(progress: NonNullable<SyncBlockStatus["progress"]>): string | null {
  if (progress.total == null || progress.total <= 0) return null;
  return `${count(progress.current)} из ${count(progress.total)} ${ofUnit(progress.total, progress.unit)}`;
}

function isHealthyQueueWaitingBlock(block: SyncBlockStatus): boolean {
  return block.state === "scheduled" && isQueueWaiting(block) && block.primaryFresh;
}

function isHealthyQueueWaitingSubstream(substream: SyncBlockSubstream): boolean {
  return substream.state === "scheduled" && isQueueWaiting(substream) && substream.isFresh;
}

function getDisplayBlockState(blockOrState: SyncBlockStatus | SyncBlockState): SyncBlockState {
  if (typeof blockOrState === "string") {
    return blockOrState;
  }

  return isHealthyQueueWaitingBlock(blockOrState) ? "up_to_date" : blockOrState.state;
}

export function getBlockTone(blockOrState: SyncBlockStatus | SyncBlockState): BlockTone {
  return BLOCK_STATE_TONES[getDisplayBlockState(blockOrState)];
}

export function getBlockStateLabel(blockOrState: SyncBlockStatus | SyncBlockState): string {
  return BLOCK_STATE_LABELS[getDisplayBlockState(blockOrState)];
}

export function getBlockLabel(block: SyncBlockKey): string {
  return SYNC_BLOCK_LABELS[block];
}

export function getBlockDescription(block: SyncBlockKey): string {
  return BLOCK_DESCRIPTIONS[block];
}

export function getBlockOrder(): SyncBlockKey[] {
  return BLOCK_ORDER;
}

/** A stream in English, for the analytics Coverage panel (not this screen). */
export function getStreamLabel(stream: string): string {
  return COVERAGE_STREAM_LABELS[stream] ?? stream.replaceAll("_", " ");
}

function getProgressStreamLabel(stream: string | null): string | null {
  if (!stream) return null;
  return PROGRESS_STREAM_LABELS[stream] ?? syncStreamLabel(stream);
}

export function formatCadence(seconds: number): string {
  return syncCadenceText(seconds);
}

function formatRelativeFuture(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "сейчас";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "меньше чем через минуту";
  if (mins < 60) return `через ${mins} мин`;
  const hours = Math.floor(mins / 60);
  return `через ${hours} ч`;
}

export function formatNextTime(iso: string | null): string | null {
  if (!iso) return null;
  return formatRelativeFuture(iso);
}

function parseDependencyWait(summary: string | null | undefined): string[] {
  if (!summary) return [];
  const prefix = "Waiting for ";
  if (!summary.startsWith(prefix)) return [];
  return summary
    .slice(prefix.length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function formatDependencyList(streams: string[]): string {
  return streams.map((stream) => syncStreamLabel(stream)).join(", ");
}

function getWaitingStreams(item: SyncReasonCarrier): string[] {
  if (item.statusReason?.waitingFor && item.statusReason.waitingFor.length > 0) {
    return item.statusReason.waitingFor;
  }
  if (item.statusReason?.code === "unmet_dependency") {
    return parseDependencyWait(item.statusReason.summary ?? item.error?.summary);
  }
  return [];
}

function getReasonCode(item: SyncReasonCarrier): string | null {
  return item.statusReason?.code ?? item.error?.code ?? null;
}

/** The reason in the screen's words; the server's own text only for a code
 *  this screen has no words for. */
export function getReasonSummary(item: SyncReasonCarrier): string | null {
  const code = getReasonCode(item);
  const words = code === null ? undefined : REASON_WORDS[code];
  if (words !== undefined) return words;
  return item.statusReason?.summary ?? item.error?.summary ?? null;
}

/** The server's own text of a reason, when the screen's words replaced it
 *  (shown as a secondary line). Null: nothing beyond the words. */
export function getServerReasonText(item: SyncReasonCarrier): string | null {
  const code = getReasonCode(item);
  if (code === null || REASON_WORDS[code] === undefined) return null;
  return item.statusReason?.summary ?? item.error?.summary ?? null;
}

function getDependencyStreams(item: SyncReasonCarrier): string[] {
  return getWaitingStreams(item);
}

export function isDependencyWait(item: SyncReasonCarrier): boolean {
  return getReasonCode(item) === "unmet_dependency";
}

function isQueueWaiting(item: SyncReasonCarrier): boolean {
  return getReasonCode(item) === "queue_waiting";
}

export function getDependencyWaitDetail(item: SyncReasonCarrier): string | null {
  if (!isDependencyWait(item)) return null;
  const streams = getDependencyStreams(item);
  if (streams.length === 0) return null;
  return formatDependencyList(streams);
}

function hasCompletedMessagesLiveProgress(block: SyncBlockStatus): boolean {
  return (
    block.block === "messages_live" &&
    block.progress != null &&
    block.progress.total != null &&
    block.progress.total > 0 &&
    block.progress.current >= block.progress.total
  );
}

function formatSupportingProgressSummary(block: SyncBlockStatus): string | null {
  if (!block.primaryFresh || block.progressRole !== "supporting") {
    return null;
  }

  const label = getProgressStreamLabel(block.progressStream);
  if (!label) {
    return null;
  }

  if (block.block === "financials") {
    if (block.state === "backfilling") {
      return `Операции актуальны; ${label} догружается`;
    }
    if (block.state === "scheduled") {
      return `Операции актуальны; ${label} в очереди`;
    }
    if (block.state === "retrying") {
      return `Операции актуальны; ${label}: повторная попытка`;
    }
  }

  return null;
}

export function formatBlockProgressCaption(block: SyncBlockStatus): string | null {
  if (!block.progress) return null;

  const source = getProgressStreamLabel(block.progressStream);
  const counts = progressCounts(block.progress) ?? block.progress.label;
  if (!counts) return source;
  return source ? `${source} · ${counts}` : counts;
}

export function getBlockProgressFillClass(block: SyncBlockStatus): string {
  if (isHealthyQueueWaitingBlock(block)) {
    return "bg-green";
  }
  return "bg-accent";
}

export function getBlockProgressBarMode(block: SyncBlockStatus): "hidden" | "determinate" | "indeterminate" {
  if (!block.progress) {
    return "hidden";
  }
  if (!["syncing", "backfilling", "scheduled", "retrying"].includes(block.state)) {
    return "hidden";
  }

  if (hasCompletedMessagesLiveProgress(block)) {
    return "hidden";
  }

  if (
    isHealthyQueueWaitingBlock(block) &&
    block.progressRole === "supporting" &&
    block.progress.total != null &&
    block.progress.total > 0 &&
    block.progress.current >= block.progress.total
  ) {
    return "hidden";
  }

  if (block.progress.total != null && block.progress.total > 0) {
    return "determinate";
  }

  if (block.progress.label && ["syncing", "backfilling", "retrying"].includes(block.state)) {
    return "indeterminate";
  }

  return "hidden";
}

export function shouldShowBlockProgressBar(block: SyncBlockStatus): boolean {
  return getBlockProgressBarMode(block) !== "hidden";
}

/** The share of a block's progress that is done, for its bar. */
export function getBlockProgressPercent(block: SyncBlockStatus): number {
  const progress = block.progress;
  if (!progress) return 0;
  const percent = progress.percent ?? (progress.total && progress.total > 0 ? (progress.current / progress.total) * 100 : 0);
  return Math.min(100, percent);
}

export function formatBlockSummary(block: SyncBlockStatus): string {
  if (block.state === "not_available") return "Недоступно";

  if (block.block === "connection") {
    if (block.connectionStatus === "connected") {
      const checked = block.succeededAt
        ? `проверено ${formatRelativeTime(block.succeededAt)}`
        : "";
      return `Подключено${checked ? ` · ${checked}` : ""}`;
    }
    if (block.connectionStatus === "error" || block.state === "failed") {
      const reason = getReasonSummary(block) ?? "ошибка подключения";
      return `Подключение не удалось: ${lowerFirst(reason)}`;
    }
    if (block.connectionStatus === "not_connected") {
      return "Не подключено";
    }
  }

  if (block.state === "paused") {
    return block.succeededAt
      ? `На паузе · последнее обновление ${formatRelativeTime(block.succeededAt)}`
      : "На паузе";
  }

  if (block.state === "not_started") {
    return "Ещё не запускался";
  }

  if (block.state === "failed") {
    if (getReasonCode(block) === "progress_stalled") {
      const counts = block.progress ? progressCounts(block.progress) : null;
      if (counts) {
        return `Загрузка остановилась на ${counts}`;
      }
      if (block.progress?.label) {
        return `Загрузка остановилась: ${block.progress.label}`;
      }
      return "Загрузка остановилась";
    }
    const reason = getReasonSummary(block) ?? "Ошибка сбора";
    const failures = block.error?.consecutiveFailures ?? 0;
    return failures > 1 ? `${reason} (ошибок подряд: ${failures})` : reason;
  }

  if (block.state === "delayed") {
    if (isDependencyWait(block)) {
      const waitingOn = getDependencyStreams(block);
      if (waitingOn.length === 1) {
        return `Ждёт, пока закончится «${syncStreamLabel(waitingOn[0]!)}»`;
      }
      return "Ждёт, пока закончатся другие потоки";
    }
    if (getReasonCode(block) === "queue_delayed") {
      return "Слишком долго в очереди, загрузка не идёт";
    }
    return getReasonSummary(block) ?? "Сбор отстаёт";
  }

  if (isHealthyQueueWaitingBlock(block)) {
    const waitingOn = getWaitingStreams(block);
    if (waitingOn.length === 1) {
      return `Актуально · ждёт, пока закончится «${syncStreamLabel(waitingOn[0]!)}»`;
    }
    return "Актуально · в очереди за текущей загрузкой";
  }

  if (block.state === "scheduled" && isQueueWaiting(block)) {
    const waitingOn = getWaitingStreams(block);
    if (waitingOn.length === 1) {
      return `В очереди — сейчас идёт «${syncStreamLabel(waitingOn[0]!)}»`;
    }
    return "В очереди — начнётся после текущей загрузки";
  }

  const supportingProgressSummary = formatSupportingProgressSummary(block);
  if (supportingProgressSummary) {
    return supportingProgressSummary;
  }

  const progressPrefix = block.state === "backfilling"
    ? "Догружает историю…"
    : block.state === "scheduled"
      ? "В очереди…"
      : block.state === "retrying"
      ? "Повторяет попытку…"
      : "Обновляется…";

  if (hasCompletedMessagesLiveProgress(block)) {
    if (block.state === "syncing") {
      return "Завершает обновление списка чатов…";
    }
    if (block.state === "backfilling") {
      return "Просматривает чаты…";
    }
    if (block.state === "scheduled") {
      return "Обновление списка чатов в очереди";
    }
    if (block.state === "retrying") {
      const nextRetry = block.nextRetryAt ? formatRelativeFuture(block.nextRetryAt) : null;
      return nextRetry ? `Повторит обновление списка чатов ${nextRetry}` : "Повторяет обновление списка чатов…";
    }
  }

  if (
    (block.state === "syncing" || block.state === "backfilling" || block.state === "retrying" || block.state === "scheduled") &&
    block.progress
  ) {
    const counts = progressCounts(block.progress);
    if (counts) return `${progressPrefix} ${counts}`;
    if (block.progress.label) return `${progressPrefix} ${block.progress.label}`;
    return progressPrefix;
  }

  if (block.state === "syncing") {
    return "Обновляется…";
  }

  if (block.state === "backfilling") {
    return "Догружает историю…";
  }

  if (block.state === "scheduled") {
    return "В очереди на продолжение";
  }

  if (block.state === "retrying") {
    const nextRetry = block.nextRetryAt ? formatRelativeFuture(block.nextRetryAt) : null;
    return nextRetry ? `Повторная попытка ${nextRetry}` : "Повторяет попытку…";
  }

  const metricCount = getMetricCount(block);
  const updated = block.succeededAt
    ? `Обновлено ${formatRelativeTime(block.succeededAt)}`
    : "Ещё не обновлялось";
  return metricCount ? `${updated} · ${metricCount}` : updated;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function getMetricCount(block: SyncBlockStatus): string | null {
  const m = block.metrics;
  if (!m || typeof m !== "object") return null;

  const keys = BLOCK_METRIC_KEYS[block.block] ?? ["count"];
  for (const key of keys) {
    const value = m[key as keyof typeof m];
    if (typeof value === "number" && value >= 0) {
      const words = METRIC_WORDS[block.block];
      return words ? `${count(value)} ${ruPlural(value, ...words)}` : count(value);
    }
  }
  return null;
}

const METRIC_WORDS: Partial<Record<SyncBlockKey, readonly [string, string, string]>> = {
  financials: ["операция", "операции", "операций"],
  audience: ["подписчик", "подписчика", "подписчиков"],
  messages_live: ["чат", "чата", "чатов"],
};

const BLOCK_METRIC_KEYS: Partial<Record<SyncBlockKey, readonly string[]>> = {
  financials: ["transactionCount", "count"],
  audience: ["subscriberCount", "count"],
  messages_live: ["visibleConversationCount", "count"],
};

export function getSubstreamTone(substream: SyncBlockSubstream): BlockTone {
  if (isHealthyQueueWaitingSubstream(substream)) {
    return BLOCK_STATE_TONES.up_to_date;
  }
  if (isDependencyWait(substream)) {
    return BLOCK_STATE_TONES.scheduled;
  }
  if (substream.state === "delayed") {
    const code = getReasonCode(substream);
    if (code === "queue_delayed" || code === "progress_stalled" || code === "stale") {
      return BLOCK_STATE_TONES.delayed;
    }
  }
  if (substream.state === "scheduled") {
    return BLOCK_STATE_TONES.scheduled;
  }
  return getBlockTone(substream.state);
}

export function formatSubstreamStateLabel(substream: SyncBlockSubstream): string {
  const code = getReasonCode(substream);

  if (substream.state === "delayed") {
    if (code === "unmet_dependency") {
      const detail = getDependencyWaitDetail(substream);
      return detail ? `Ждёт · ${detail}` : "Ждёт";
    }
    if (code === "queue_delayed") {
      return "Отстаёт · очередь стоит";
    }
    if (code === "progress_stalled") {
      return "Остановилось · нет движения";
    }
    if (code === "stale") {
      return "Устарело";
    }
    return "Отстаёт";
  }

  if (substream.state === "scheduled") {
    if (code === "queue_waiting") {
      const waitingOn = getWaitingStreams(substream);
      if (isHealthyQueueWaitingSubstream(substream)) {
        if (waitingOn.length === 1) {
          return `Актуально · ждёт «${syncStreamLabel(waitingOn[0]!)}»`;
        }
        return "Актуально · в очереди за текущей загрузкой";
      }
      if (waitingOn.length === 1) {
        return `Ждёт · ${syncStreamLabel(waitingOn[0]!)}`;
      }
      return "Ждёт";
    }
    return "В очереди";
  }

  if (substream.state === "failed") {
    return code === "credentials_invalid" ? "Нужен вход" : "Ошибка";
  }

  return getBlockStateLabel(substream.state);
}

export function needsVisualAttention(block: SyncBlockStatus): boolean {
  if (isDependencyWait(block)) {
    return false;
  }

  return (
    block.needsAttention ||
    block.state === "failed" ||
    block.state === "delayed"
  );
}

/** The server's HTTP attempts of a block over the day, in one secondary line;
 *  null when it made none. */
export function formatAttemptsLine(block: SyncBlockStatus): string | null {
  const metric = (key: string) => {
    const value = block.metrics[key as keyof typeof block.metrics];
    return typeof value === "number" ? value : 0;
  };
  const attempts = metric("physicalAttemptCount24h");
  const succeeded = metric("physicalSuccessCount24h");
  const stuck = metric("stalePhysicalAttemptCount");
  const withoutSuccess = metric("maxPhysicalAttemptsSinceLastSuccess");
  const parts: string[] = [];
  if (attempts > 0) {
    parts.push(`HTTP-запросов за сутки: ${count(succeeded)} из ${count(attempts)} успешно (${Math.round((succeeded / attempts) * 100)} %)`);
  }
  if (stuck > 0) parts.push(`зависших: ${count(stuck)}`);
  if (withoutSuccess > 0) parts.push(`подряд без успеха: ${count(withoutSuccess)}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Whether the day's HTTP attempts of a block are in trouble (the line is
 *  then in the warning colour). */
export function attemptsInTrouble(block: SyncBlockStatus): boolean {
  const stuck = block.metrics.stalePhysicalAttemptCount;
  const withoutSuccess = block.metrics.maxPhysicalAttemptsSinceLastSuccess;
  return (typeof stuck === "number" && stuck > 0) || (typeof withoutSuccess === "number" && withoutSuccess > 0);
}

/** What the reset's confirmation says: the block is read again from the
 *  start, and what else of it goes (the server's `resetSyncBlock`). */
export function syncResetConfirmText(block: SyncBlockKey, pageLabel: string): string {
  const label = getBlockLabel(block);
  const base = `Hub забудет, докуда загружен блок «${label}» страницы ${pageLabel}, и загрузит его заново с самого начала.`;
  if (block === "financials") return `${base} Рейтинг топ фанов страницы будет собран заново.`;
  if (block === "messages_history") {
    return `${base} Сейчас сервер отклоняет этот сброс: он удалил бы все сохранённые сообщения страницы.`;
  }
  return `${base} Уже загруженные данные остаются.`;
}

// ── a page in one line ───────────────────────────────────────────────────────

const DIAGNOSIS_HEADLINES: Record<SyncDiagnosis["code"], string> = {
  auth_blocked: "Нужно обновить данные входа",
  stalled_run: "Загрузка остановилась и не продвигается",
  worker_offline: "Сбор отстаёт: работа стоит в очереди, но не выполняется",
};

export function getDiagnosisHeadline(diagnosis: SyncDiagnosis): string {
  return DIAGNOSIS_HEADLINES[diagnosis.code];
}

function blocksPhrase(labels: string[]): string {
  const quoted = labels.map((label) => `«${label}»`);
  return `${quoted.length === 1 ? "блок" : "блоки"} ${quoted.join(", ")}`;
}

/**
 * What an OnlyFans page is now, in one line: it needs a login, a block has
 * failed, it is paused, it lags, it is loading, it has not started, or it
 * works. The same words as the Fansly screen where they mean the same.
 */
export function syncPageStatus(page: SyncBlocksPage): PageStatus {
  const blocks = BLOCK_ORDER.map((key) => page.blocks[key]);
  const live = blocks.filter((block) => block.state !== "not_available");
  const credentials = page.diagnosis?.actionKind === "credentials"
    || blocks.some((block) => block.statusReason?.code === "credentials_invalid" && needsVisualAttention(block));
  if (credentials) {
    return { kind: "login", label: "Нужен вход", tone: "danger", reason: "Данные входа больше не действуют" };
  }
  const failed = live.filter((block) => block.state === "failed");
  if (failed.length > 0) {
    return { kind: "failed", label: "Ошибка", tone: "danger", reason: blocksPhrase(failed.map((block) => getBlockLabel(block.block))) };
  }
  if (live.length > 0 && live.every((block) => block.state === "paused")) {
    return { kind: "paused", label: "На паузе", tone: "neutral", reason: "пауза владельца" };
  }
  const lagging = live.filter((block) => needsVisualAttention(block) || block.state === "retrying");
  if (page.diagnosis !== null || lagging.length > 0) {
    return {
      kind: "lagging",
      label: "Отстаёт",
      tone: "warning",
      reason: lagging.length > 0 ? blocksPhrase(lagging.map((block) => getBlockLabel(block.block))) : null,
    };
  }
  if (live.some((block) => block.state === "syncing" || block.state === "backfilling")) {
    return { kind: "syncing", label: "Обновляется", tone: "info", reason: null };
  }
  if (live.length === 0 || live.every((block) => block.state === "not_started" || block.succeededAt === null)) {
    return { kind: "not_started", label: "Ещё не запускался", tone: "neutral", reason: "данных пока нет" };
  }
  const paused = live.filter((block) => block.state === "paused");
  return {
    kind: "working",
    label: "Работает",
    tone: "success",
    reason: paused.length > 0 ? `на паузе: ${blocksPhrase(paused.map((block) => getBlockLabel(block.block)))}` : null,
  };
}
