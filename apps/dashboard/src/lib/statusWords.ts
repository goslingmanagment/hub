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

/** Switched off by the owner on 2026-11-01: never red, never "no access". */
export const OFAPI_OFF_WORD = "Выключено с 1 ноября";
/** Beside what only came through the vendor and stopped with it. */
export const OFAPI_FROZEN_NOTE = "по 1 ноября";

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
} as const satisfies Record<string, StatusWord>;

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
