// Russian copy for the Collection screen. Keys are the registry ids from the
// GET catalog; anything the server returns that has no entry falls back to
// the server's own label so a new category never renders blank. The shell
// stays English (tab names), the content Russian, as on Credits/Configuration.

export interface CategoryCopy {
  /** Row title. */
  label: string;
  /** One line: what the data is for. */
  why: string;
}

export const CATEGORY_COPY_RU: Record<string, CategoryCopy> = {
  core_messages: {
    label: "Сообщения",
    why: "Чат в десктопе, needs-reply, история переписки",
  },
  core_payments: {
    label: "Оплаты и подписки",
    why: "Леджер, статусы подписок, продления и истечения",
  },
  core_audience: {
    label: "Аудитория",
    why: "Карточки фанов, подписчики и истёкшие, топ-спендеры",
  },
  posts_comments: {
    label: "Посты и комментарии",
    why: "История публикаций и обсуждений под ними",
  },
  visitors: {
    label: "Посещаемость профиля",
    why: "Количество посещений профиля по дням; без списка посетителей",
  },
  tracking_links: {
    label: "Tracking links",
    why: "Результат источников трафика: клики, подписки, доход",
  },
  smart_links: {
    label: "Smart links",
    why: "Переходы и конверсия умных ссылок",
  },
  vault_catalog: {
    label: "Vault: каталог",
    why: "Поиск медиа и связи с постами, без скачивания файлов",
  },
  vault_files: {
    label: "Загрузка своих медиа",
    why: "Загрузка своего файла в vault или CDN с отдельным подтверждением",
  },
  balances: {
    label: "Балансы и выплаты",
    why: "Доступный и ожидаемый баланс модели, история выплат",
  },
  profile_notifications: {
    label: "Профиль и уведомления",
    why: "Данные профиля модели и лента уведомлений",
  },
  content_history: {
    label: "Сторис, хайлайты и очередь",
    why: "История сторис, хайлайтов и запланированных публикаций",
  },
  media_previews: {
    label: "Картинки в десктопе",
    why: "Превью и фото в треде, галерее и волте ChatGoose Desktop; бесплатные ссылки работают и без включения",
  },
  account_settings: {
    label: "Приветственное сообщение",
    why: "Снимок автоприветствия новым подписчикам (включено ли, текст, медиа, цена) для панели «Новые»; раз в сутки — 1 кредит",
  },
};

export const CONSUMER_LABELS_RU: Record<string, string> = {
  chatters: "Чаттеры",
  dashboard: "Дашборд",
  "Agent Read": "Agent Read",
};

export const MODE_LABELS_RU: Record<string, string> = {
  off: "Выключено",
  on_demand: "По запросу",
  scheduled: "Расписание",
};

export const MODE_DESCRIPTIONS_RU: Record<string, string> = {
  off: "Новых запросов нет. Сохранённое читается с его реальной свежестью.",
  on_demand: "Только после явного действия: кнопка на экране или разрешённый запрос агента. Открытие страницы не считается запросом.",
  scheduled: "Фоновый обход с интервалом и лимитом. Повторное включение продолжает с чекпоинта, пропущенное не догружается само.",
};

export const SOURCE_LABELS_RU: Record<string, string> = {
  page: "настройка страницы",
  default: "общая настройка",
  legacy_baseline: "baseline · прежняя конфигурация",
  default_off: "выключено по умолчанию",
};

export const JOB_STATE_LABELS_RU: Record<string, string> = {
  queued: "в очереди",
  running: "выполняется",
  paused: "пауза",
  completed: "завершена",
  failed: "ошибка",
};

/** The job list's state filter (server `jobState`); "" = no filter. */
export const JOB_STATE_FILTER_OPTIONS_RU: ReadonlyArray<{ value: "" | "unfinished" | "paused" | "queued" | "running" | "failed" | "completed"; label: string }> = [
  { value: "", label: "Все задачи" },
  { value: "unfinished", label: "Незавершённые" },
  { value: "paused", label: "На паузе" },
  { value: "queued", label: "В очереди" },
  { value: "running", label: "Выполняются" },
  { value: "failed", label: "С ошибкой" },
  { value: "completed", label: "Завершённые" },
];

export const PREREQUISITE_LABELS_RU: Record<string, string> = {
  "active OFAPI page binding": "активная привязка страницы к OFAPI",
  "owned source and explicit upload approval": "свой файл и отдельное подтверждение загрузки",
  "explicit bounded file selection": "явный ограниченный список файлов",
};

export const PRICE_UNIT_LABELS_RU: Record<string, string> = {
  physical_calls: "за физический запрос",
  calls_and_bytes: "за запрос и объём файлов",
};

export const WEBHOOK_STATE_LABELS_RU: Record<string, string> = {
  stable: "стабильна",
  create_prepared: "создание подготовлено",
  create_dispatching: "создаётся у провайдера",
  create_indeterminate: "создание не подтверждено",
  create_failed: "ошибка создания",
  update_prepared: "обновление подготовлено",
  update_dispatching: "перерегистрация · ждём readback",
  update_indeterminate: "обновление не подтверждено",
};

export function categoryLabel(id: string, serverLabel?: string) {
  return CATEGORY_COPY_RU[id]?.label ?? serverLabel ?? id;
}

export function categoryWhy(id: string) {
  return CATEGORY_COPY_RU[id]?.why ?? "";
}

export function consumerLabel(consumer: string) {
  return CONSUMER_LABELS_RU[consumer] ?? consumer;
}

export function modeLabel(mode: string) {
  return MODE_LABELS_RU[mode] ?? mode;
}

export function sourceLabel(source: string) {
  return SOURCE_LABELS_RU[source] ?? source;
}

export function jobStateLabel(state: string) {
  return JOB_STATE_LABELS_RU[state] ?? state;
}

export function prerequisiteLabel(value: string) {
  return PREREQUISITE_LABELS_RU[value] ?? value;
}

export function webhookStateLabel(state: string | null) {
  if (state === null) return "не зарегистрирована";
  return WEBHOOK_STATE_LABELS_RU[state] ?? state;
}
