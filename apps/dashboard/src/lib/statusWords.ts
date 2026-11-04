/**
 * The one dictionary of states (design/design-language.md §2.5): six tones and
 * the word of every state, so no screen keeps a table of its own. A tone answers
 * "do I have to do something": silence (good, moving, off) or a job (waiting,
 * attention, broken). The word and the shape of the dot work without the colour.
 */
export type StatusTone = "good" | "attention" | "broken" | "off" | "moving" | "waiting";

export const STATUS_TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  good: "badge-success",
  attention: "badge-warning",
  broken: "badge-danger",
  off: "badge-off",
  moving: "badge-info",
  waiting: "badge-accent",
};

export interface StatusWord {
  word: string;
  tone: StatusTone;
}

const status = (word: string, tone: StatusTone): StatusWord => ({ word, tone });

/** Whether the OnlyFans API is on: `useOfapiStatus` (api/waiting.ts) answers it. */
export type OfapiStatus = "on" | "off" | "unknown";

/** Switched off by the owner on 2026-11-01: never red, never "no access". */
export const OFAPI_OFF_WORD = "Выключено с 1 ноября";
/**
 * Beside what only came through the vendor and stopped with it: a page's count of
 * subscribers, the credits, the links. Decided by the platform and the status `off`.
 * Never on OnlyFans money: the ChatSpace feed keeps writing it, see the footnote.
 */
export const OFAPI_FROZEN_NOTE = "по 1 ноября";
/** The quiet footnote under money that has OnlyFans pages in it. */
export const OFAPI_FEED_NOTE = "OnlyFans с 1 ноября — из ленты ChatSpace";
export const OFAPI_OFF_REASON = "OnlyFans API выключен с 1 ноября";
export const OFAPI_UNKNOWN_REASON = "Не удалось проверить OnlyFans API";

/** Why a write of the vendor is disabled. Null only when the key is known to be set. */
export function ofapiWriteBlock(status: OfapiStatus): string | null {
  return status === "on" ? null : status === "off" ? OFAPI_OFF_REASON : OFAPI_UNKNOWN_REASON;
}

/** Data collection: the six words of ia.md §9 and their neighbours. */
export const COLLECTION_STATUS = {
  healthy: status("Работает", "good"),
  syncing: status("Работает", "good"),
  setup: status("Первый сбор", "moving"),
  catching_up: status("Собирает историю", "moving"),
  retrying: status("Отстаёт", "attention"),
  delayed: status("Отстаёт", "attention"),
  attention: status("Не читается", "broken"),
  requiresAction: status("Нужен вход", "broken"),
  paused: status("На паузе", "off"),
  ofapiOff: status(OFAPI_OFF_WORD, "off"),
  notNeeded: status("Сбор не нужен", "off"),
  unknown: status("Нет данных", "off"),
} as const satisfies Record<string, StatusWord>;

/**
 * A page's collection in one word, the one function of every screen (design/screens/
 * system.md §0.3). `kind` is what `enginePageStatus` or `syncPageStatus` answered;
 * the reason beside the word is theirs too. Null: still loading, draw a skeleton.
 */
export function collectionWord(page:
  | { platform: "fansly"; kind: string }
  | { platform: "onlyfans"; ofapi: OfapiStatus; kind?: string | undefined }
  | { platform: "telegram" }): StatusWord | null {
  if (page.platform === "telegram") return COLLECTION_STATUS.notNeeded;
  if (page.platform === "onlyfans") {
    if (page.ofapi === "off") return COLLECTION_STATUS.ofapiOff;
    if (page.ofapi === "unknown") return COLLECTION_STATUS.unknown;
  }
  switch (page.kind) {
    case "loading": return null;
    case "login": return COLLECTION_STATUS.requiresAction;
    case "proxy":
    case "off":
    case "failed": return COLLECTION_STATUS.attention;
    case "lagging":
    case "switching": return COLLECTION_STATUS.delayed;
    case "paused": return COLLECTION_STATUS.paused;
    case "working":
    case "syncing": return COLLECTION_STATUS.healthy;
    case "not_started": return COLLECTION_STATUS.setup;
    default: return COLLECTION_STATUS.unknown;
  }
}

export const PUBLICATION_STATUS: Readonly<Record<string, StatusWord>> = {
  draft: status("Ждёт утверждения", "waiting"),
  approved: status("Утверждён", "moving"),
  submitting: status("Ставится", "moving"),
  scheduled: status("В расписании", "moving"),
  processing: status("Обрабатывается", "moving"),
  published: status("Вышел", "good"),
  unknown: status("Исход неизвестен", "attention"),
  missed: status("Пропущен", "attention"),
  not_published: status("Не вышел", "broken"),
  rejected: status("Отклонён", "broken"),
  withdrawn: status("Убран из расписания", "off"),
  /** `withdrawn` with the reason `deleted_after_publish`: it left the wall, not the schedule. */
  deletedFromWall: status("Удалён со стены", "off"),
  cancelled: status("Отменён", "off"),
};

export const TRANSACTION_STATUS: Readonly<Record<string, StatusWord | null>> = {
  // Plain text: a posted operation is the normal case, not a status.
  posted: null,
  pending: status("Ожидает", "moving"),
  unknown: status("Неизвестно", "off"),
};

export const ANTHROPIC_RECONCILIATION_STATUS: Readonly<Record<string, StatusWord>> = {
  ok: status("Сходится", "good"),
  mismatch: status("Расходится", "attention"),
  unmapped: status("Ключ не решён", "attention"),
  open: status("Досчитывается", "moving"),
  no_source: status("Нет данных Anthropic", "off"),
  not_synced: status("Нет данных за день", "off"),
};

export const AI_ACCOUNT_STATUS: Readonly<Record<string, StatusWord>> = {
  serving: status("Тратится сейчас", "good"),
  queued: status("В очереди", "moving"),
  exhausted: status("Кончились деньги", "broken"),
  invalid: status("Ключ не принят", "broken"),
  disabled: status("Выключен", "off"),
  missing: status("Нет ключа", "off"),
};

export const AI_LIMIT_STATUS = {
  exhausted: status("ИИ выключен до 00:00", "attention"),
  sharedPool: status("Тратит из общего запаса", "moving"),
  // A past day, the same two facts.
  wasExhausted: status("ИИ выключался", "attention"),
  wasSharedPool: status("Брал из запаса", "moving"),
} as const satisfies Record<string, StatusWord>;

export const VOICE_STATUS: Readonly<Record<string, StatusWord>> = {
  healthy: status("В порядке", "good"),
  characters_low: status("Символы на исходе", "attention"),
  unreadable: status("Ключ не видит аккаунт", "attention"),
  characters_out: status("Символы кончились", "broken"),
  subscription_inactive: status("Подписка не активна", "broken"),
  key_rejected: status("Ключ не принят", "broken"),
  check_failed: status("Проверка не удалась", "off"),
};

export const TEAM_STATUS = {
  onShift: status("На смене", "good"),
  reportConfirmed: status("Подтверждён", "good"),
  reportNotConfirmed: status("Не подтверждён", "attention"),
  dispute: status("Ждёт решения", "waiting"),
  customPaid: status("Оплачен, не отдан", "waiting"),
  customUnpaid: status("Ждёт оплаты", "moving"),
  customDelivered: status("Отдан", "good"),
} as const satisfies Record<string, StatusWord>;

/** «Просрочен на N дней». */
export function customOverdue(days: number): StatusWord {
  const mod10 = days % 10;
  const mod100 = days % 100;
  const word = mod10 === 1 && mod100 !== 11 ? "день" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "дня" : "дней";
  return status(`Просрочен на ${days} ${word}`, "attention");
}

/** «Модели и страницы» → «Незавершённые подключения». */
export const CONNECT_STATUS = {
  waitingServer: status("Ждёт создания на сервере", "moving"),
  noEnvironment: status("Нет окружения", "attention"),
  noProxy: status("У страницы нет прокси", "broken"),
  loginRunning: status("Идёт вход", "moving"),
  stopping: status("Останавливаем", "moving"),
  loggedIn: status("Вход выполнен", "good"),
  needProxy: status("Нужен прокси", "attention"),
  needExitIp: status("Нужен выходной IP", "attention"),
  readyToLogin: status("Готов ко входу", "moving"),
} as const satisfies Record<string, StatusWord>;

export const HELD_SEND_STATUS = {
  held: status("Ждёт разбора", "waiting"),
} as const satisfies Record<string, StatusWord>;

export const HISTORY_REQUEST_STATUS: Readonly<Record<string, StatusWord>> = {
  requested: status("Ждёт решения", "waiting"),
  approved: status("Одобрена", "moving"),
  dispatching: status("Выполняется", "moving"),
  completed: status("Выполнена", "good"),
  partially_completed: status("Выполнена частично", "attention"),
  rejected: status("Отклонена", "off"),
  expired: status("Истекла", "off"),
  failed: status("Ошибка", "broken"),
};

export const STAFF_STATUS: Readonly<Record<string, StatusWord>> = {
  active: status("Активен", "good"),
  invited: status("Ждёт регистрации", "moving"),
  disabled: status("Отключён", "off"),
};

export const AGENT_KEY_STATUS: Readonly<Record<string, StatusWord>> = {
  active: status("Активен", "good"),
  revoked: status("Отозван", "off"),
  expired: status("Истёк", "off"),
};

export const FAILURE_CLOSED = status("Закрыт", "off");

/** Настройки → Оповещения: the bot's chat and the daily report's history. */
export const TELEGRAM_STATUS = {
  connected: status("Подключён", "good"),
  notDelivered: status("Последнее сообщение не доставлено", "broken"),
  unchecked: status("Ещё не проверен", "off"),
} as const satisfies Record<string, StatusWord>;

export const REPORT_STATUS = {
  sent: status("Отправлен", "good"),
  notSent: status("Не отправлен", "attention"),
  skipped: status("Пропущен", "off"),
} as const satisfies Record<string, StatusWord>;

/** Настройки → Функции ИИ. */
export const FEATURE_STATUS = {
  on: status("Включено", "good"),
  off: status("Выключено", "off"),
  noPages: status("Нет выбранных страниц", "off"),
  notInBuild: status("Нет в этой версии", "off"),
  adviceOn: status("Стоит включить", "attention"),
  adviceOff: status("Стоит выключить", "attention"),
  mixed: status("Нет единого значения", "attention"),
  pendingApply: status("Ждёт применения", "moving"),
} as const satisfies Record<string, StatusWord>;
