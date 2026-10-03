// Product guidance, not runtime configuration. Applied values always come from
// adminConfig. Research and consumer evidence: investigations/feature-controls-2026-09-11.
export type FeatureAdvice = "keep" | "optional" | "diagnostic" | "off";
export type FeatureGroup = "Fansly" | "OnlyFans" | "AI и агенты" | "Система";
export interface FeatureGate { key: string; off?: readonly (string | boolean)[]; }
export interface FeatureScope { key: string; empty: "all" | "none"; none?: string; all?: string; }
export interface HubFeature {
  id: string;
  title: string;
  summary: string;
  group: FeatureGroup;
  advice: FeatureAdvice;
  reason: string;
  consequence: string;
  check: string;
  limitation?: string;
  keys: string[];
  gates: FeatureGate[];
  scope?: FeatureScope;
  evidenceHref: string;
  evidenceLabel: string;
}

const gate = (key: string, ...off: (string | boolean)[]): FeatureGate => ({ key, off: off.length ? off : [false] });
const sync = { evidenceHref: "/settings?tab=sync", evidenceLabel: "Проверить сбор данных" };
const ai = { evidenceHref: "/usage", evidenceLabel: "Посмотреть использование AI" };

export const HUB_FEATURES: readonly HubFeature[] = [
  {
    id: "prompt-debug", title: "Показ полного запроса AI", group: "AI и агенты", advice: "off",
    summary: "Сотрудник в режиме отладки видит собранный запрос, персону и досье фана.",
    reason: "Отключить после завершения отладки. Для обычной генерации раскрывать внутренние инструкции не требуется.",
    consequence: "Пропадёт отладочный просмотр запроса. Генерация ответов продолжит работать.",
    check: "Уточнить, есть ли сейчас незакрытая проблема, для которой сотруднику нужен этот просмотр.",
    keys: ["chatMuseAiPromptDebugEchoEnabled"], gates: [gate("chatMuseAiPromptDebugEchoEnabled")], ...ai,
  },
  {
    id: "voice", title: "Голосовые сообщения", group: "AI и агенты", advice: "optional",
    summary: "Создаёт голосовые по тексту на выбранных страницах.",
    reason: "Оставить ограниченный запуск, пока не подтверждены использование и результат. Расширять на остальные страницы по одному решению.",
    consequence: "Новые голосовые создаваться не будут. Доступ к уже готовым управляется отдельной настройкой.",
    check: "Сравнить число созданных и реально использованных голосовых, затраты и результат. Один включённый флаг не подтверждает готовность голоса страницы.",
    limitation: "Usage показывает генерации текста для голосовых. Число синтезированных и отправленных аудио эта таблица не подтверждает.",
    keys: ["voiceNotesEnabled", "voiceNotesPageAllowlist", "voiceNotesDailyCharBudget", "voiceNotesGlobalDailyCharBudget", "voiceNotesScriptMaxChars", "voiceNotesMaxConcurrentSyntheses", "voiceNotesRetrievalEnabled"],
    gates: [gate("voiceNotesEnabled")], scope: { key: "voiceNotesPageAllowlist", empty: "none" }, ...ai,
  },
  {
    id: "fan-context", title: "Досье фана в ответах AI", group: "AI и агенты", advice: "optional",
    summary: "Передаёт сохранённые факты о фане в выбранные функции AI.",
    reason: "Оставить в уже выбранных функциях до сравнения качества. Не расширять автоматически: лишний или устаревший контекст может мешать ответу.",
    consequence: "AI перестанет получать досье. Сами профили и генерация ответов останутся.",
    check: "Сравнить ответы с досье и без него на одинаковых диалогах; проверить ошибки из устаревших фактов.",
    keys: ["chatMuseAiFanProfileContextFeatures"], gates: [gate("chatMuseAiFanProfileContextFeatures", "none", "")], ...ai,
  },
  {
    id: "earnings", title: "Траты фанов", group: "Fansly", advice: "keep",
    summary: "Доход от каждого фана за всё время и по месяцам.",
    reason: "Оставить для работы со спендерами и проверки доходов. Важна точность и актуальность, а не просто наличие таблицы.",
    consequence: "Итоги по фанам перестанут обновляться. Основной поток транзакций этим флагом не выключается.",
    check: "Сверять свежесть полного обхода и совпадение выборочных итогов с сохранёнными платежами.",
    keys: ["fanslyFanEarningsSyncEnabled", "fanslyNewStreamPageAllowlist"], gates: [gate("fanslyFanEarningsSyncEnabled")],
    scope: { key: "fanslyNewStreamPageAllowlist", empty: "all" }, ...sync,
  },
  {
    id: "purchases", title: "Покупки платного контента", group: "Fansly", advice: "keep",
    summary: "Сохраняет, какой контент покупали фаны.",
    reason: "Оставить для истории продаж и проверки выдачи контента. Покупка материала и запись о денежной операции дают разные сведения.",
    consequence: "Остановится отдельная проверка истории покупок. Уже полученные записи останутся.",
    check: "Проверить свежесть потока и разбор покупок у выбранного фана.",
    keys: ["fanslyPurchaseHistorySyncEnabled", "fanslyNewStreamPageAllowlist"], gates: [gate("fanslyPurchaseHistorySyncEnabled")],
    scope: { key: "fanslyNewStreamPageAllowlist", empty: "all" }, ...sync,
  },
  {
    id: "ai-core", title: "AI для сотрудников", group: "AI и агенты", advice: "keep",
    summary: "Генерация ответов и помощь в диалогах через Hub.",
    reason: "Оставить как основной путь AI в клиентах. Ненужные функции оцениваются отдельно от общего доступа к AI.",
    consequence: "Отключится шлюз AI для клиентов. Это затронет обычную работу сотрудников.",
    check: "Посмотреть использование по функциям, ошибки и качество ответов. Расход сам по себе не доказывает пользу.",
    limitation: "Отдельных выключателей Fast Reply, Help Me, Chat Review и Coach в текущей конфигурации нет. Общий переключатель отключает шлюз целиком. Лимиты по функциям меняются через настройки сервера и не скрывают кнопки в клиенте.",
    keys: ["chatMuseAiGatewayEnabled", "chatMuseAiGatewayDailyRequestLimit", "chatMuseAiGatewayDailyMicroUsdLimit", "chatMuseAiGatewayFeatureDailyMicroUsdLimits"], gates: [gate("chatMuseAiGatewayEnabled")], ...ai,
  },
  {
    id: "fresh-context", title: "Свежая переписка для AI", group: "AI и агенты", advice: "keep",
    summary: "Добавляет к архиву недавно полученные сообщения OnlyFans.",
    reason: "Оставить действующий проверенный режим: без свежих сообщений AI может отвечать по устаревшему диалогу.",
    consequence: "Для OnlyFans в режиме «Только архив» останутся архивные сообщения. В режиме проверки свежие данные вычисляются, но не передаются AI. Переписка Fansly этим режимом не управляется.",
    check: "Сопоставить последние сообщения с контекстом генерации и проверить время ответа.",
    keys: ["aiTranscriptFreshUnionMode"], gates: [gate("aiTranscriptFreshUnionMode", "off")], ...ai,
  },
  {
    id: "agent-read", title: "Поиск и исследования по архиву", group: "AI и агенты", advice: "keep",
    summary: "Даёт агентам ограниченный доступ к сохранённым данным Hub.",
    reason: "Оставить, если агентские проверки входят в работу. Они читают архив с учётом прав и полноты данных.",
    consequence: "Агенты не смогут читать данные. Сбор и хранение продолжатся.",
    check: "Проверять полезность выполненных разборов; доступность чтения не означает полноту архива.",
    keys: ["agentReadPlaneMode", "agentSearchBackend", "agentObservationsEnabled"], gates: [gate("agentReadPlaneMode", "off")],
    evidenceHref: "/settings?tab=agentKeys", evidenceLabel: "Проверить доступ агентов",
  },
  {
    id: "hydration", title: "Дозагрузка по запросу агента", group: "AI и агенты", advice: "optional",
    summary: "Загружает недостающую историю с площадки в пределах разрешений.",
    reason: "Оставить ограниченную дозагрузку для конкретных вопросов. Автоодобрение и общий доступ — отдельные решения.",
    consequence: "Режим «Только заявки» принимает запросы без исполнения; «Выключено» закрывает маршрут. Уже начатая ограниченная попытка может завершиться.",
    check: "Посмотреть заявки, число реально полезных загрузок и использованные запросы.",
    keys: ["agentHydrationMode", "agentHydrationAutoApproveMode", "agentHydrationAutoDailyCallBudget", "agentReadPlaneMode"], gates: [gate("agentHydrationMode", "off"), gate("agentReadPlaneMode", "off")],
    evidenceHref: "/agent-hydration", evidenceLabel: "Посмотреть заявки на дозагрузку",
  },
  {
    id: "of-messages", title: "Переписка OnlyFans", group: "OnlyFans", advice: "keep",
    summary: "Получает сообщения, сохраняет архив и сверяет свежие изменения.",
    reason: "Оставить базовую цепочку переписки. Выключение раннего этапа может отключить зависимые функции.",
    consequence: "Может остановиться обновление чатов и связанных функций клиента. Полный список зависимостей показывается перед сохранением.",
    check: "Проверять свежесть сообщений, события и успешную сверку; зелёный флаг не заменяет проверку доставки данных.",
    keys: ["ofapiDmProjectionEnabled", "ofapiDmSyncEnabled", "ofapiDmColdArchiveEnabled", "ofapiDmCorrectionsReconcileEnabled", "ofapiDmReadthroughReconcileEnabled", "ofapiDmReconcileIntervalMinutes"],
    gates: [gate("ofapiDmProjectionEnabled"), gate("ofapiDmSyncEnabled"), gate("ofapiDmColdArchiveEnabled")], ...sync,
  },
  {
    id: "of-money", title: "Транзакции и контроль кредитов", group: "OnlyFans", advice: "keep",
    summary: "Учитывает платежи, возвраты и расход сервиса OnlyFans.",
    reason: "Оставить. Слово shadow в названии одного из флагов не делает его лишним: от него зависит запись транзакций.",
    consequence: "Отключение может остановить учёт денег и зависимые операции. Это не подходящий способ экономить запросы.",
    check: "Проверять сверку платежей и кредитов; для сокращения платных запросов использовать политику сбора OnlyFans.",
    keys: ["ofapiCreditLedgerEnabled", "ofapiSpendProjectionShadowEnabled", "ofapiSpendTransactionIngestEnabled", "ofapiChargebacksReconcileEnabled", "ofapiBalancePingEnabled", "ofapiAccountHealthEnabled", "ofapiBindingReconcileEnabled"],
    gates: [gate("ofapiCreditLedgerEnabled"), gate("ofapiSpendProjectionShadowEnabled"), gate("ofapiSpendTransactionIngestEnabled")],
    evidenceHref: "/ofapi-credits", evidenceLabel: "Проверить кредиты OnlyFans",
  },
  {
    id: "of-client", title: "Работа клиента OnlyFans", group: "OnlyFans", advice: "keep",
    summary: "Чтение чатов и исполнение команд сотрудников через Hub.",
    reason: "Оставить рабочую цепочку клиента. Очередь и исполнение — разные этапы одной команды.",
    consequence: "Отключение исполнения остановит новые команды; отключение шлюза затронет зависимые функции. Для аварии есть отдельный порядок остановки.",
    check: "Проверять исходы команд. Не повторять отправку автоматически, если её результат неизвестен.",
    keys: ["ofapiDesktopReadGatewayEnabled", "ofapiDesktopCommandOutboxEnabled", "ofapiDesktopCommandExecutionEnabled", "ofapiQueuedCommandTtlMs"],
    gates: [gate("ofapiDesktopReadGatewayEnabled"), gate("ofapiDesktopCommandOutboxEnabled"), gate("ofapiDesktopCommandExecutionEnabled")],
    evidenceHref: "/ofapi-actions", evidenceLabel: "Открыть управление OnlyFans",
  },
  {
    id: "of-audience", title: "Аудитория и спендеры OnlyFans", group: "OnlyFans", advice: "keep",
    summary: "Обновляет состав аудитории и рейтинг покупателей.",
    reason: "Оставить для работы со списками фанов. Снизить частоту сбора можно отдельно от отключения всей цепочки.",
    consequence: "Списки и рейтинг перестанут обновляться. Связанные этапы могут потребовать отдельного возобновления.",
    check: "Проверять завершённость обхода аудитории; пустой непроверенный ответ не доказывает исчезновение подписчиков.",
    keys: ["ofapiAudienceSyncEnabled", "ofapiPresenceProjectionEnabled", "onlyFansTopSpendersEnabled", "ofapiFanIdentitiesSyncEnabled", "ofapiAudienceSweepIntervalMinutes"],
    gates: [gate("ofapiAudienceSyncEnabled"), gate("ofapiPresenceProjectionEnabled"), gate("onlyFansTopSpendersEnabled")], ...sync,
  },
  {
    id: "of-history", title: "Сохранение чтений клиента", group: "OnlyFans", advice: "keep",
    summary: "Сохраняет прочитанные клиентом данные и использует архив истории.",
    reason: "Оставить: повторное использование сохранённых ответов и проверки истории связаны между собой. Shadow здесь — часть цепочки с зависимостями.",
    consequence: "Может остановиться пополнение архива и отключиться чтение истории из базы. Платный фоновый сбор настраивается отдельно.",
    check: "Посмотреть политику сбора и фактическое использование запросов; технические флаги не показывают всю политику по страницам.",
    keys: ["ofapiMirrorInteractiveCaptureEnabled", "ofapiMirrorBackgroundCaptureEnabled", "ofapiMessageHistoryShadowEnabled", "ofapiMessageHistoryDbFallbackEnabled"],
    gates: [gate("ofapiMirrorInteractiveCaptureEnabled"), gate("ofapiMirrorBackgroundCaptureEnabled"), gate("ofapiMessageHistoryShadowEnabled"), gate("ofapiMessageHistoryDbFallbackEnabled")],
    evidenceHref: "/settings?tab=collection", evidenceLabel: "Настроить платный сбор OnlyFans",
  },
  {
    id: "of-marketing", title: "Статистика ссылок OnlyFans", group: "OnlyFans", advice: "optional",
    summary: "Дополнительная сверка статистики маркетинговых ссылок.",
    reason: "Оставить для действующих кампаний; оценивать по используемым ссылкам и фактическим запросам.",
    consequence: "Остановится эта сверка. Политики других маркетинговых сборов задаются отдельно и этим флагом не выключаются.",
    check: "Проверить, по каким ссылкам принимаются решения и нужны ли дополнительные обновления.",
    keys: ["ofapiLinkStatsReconcileEnabled", "ofapiLinkStatsDailyCreditBudget"], gates: [gate("ofapiLinkStatsReconcileEnabled")],
    evidenceHref: "/ofapi-marketing", evidenceLabel: "Открыть маркетинг OnlyFans",
  },
  {
    id: "ws-capture", title: "Журнал событий Fansly", group: "Fansly", advice: "diagnostic",
    summary: "Сохраняет входящие события для проверки доставки и будущего ускорения обновлений.",
    reason: "Включать после проверки сессии и совместной работы с браузером на одной странице.",
    consequence: "Приём остановится в течение минуты. Сохранённые события и сведения о пропусках останутся.",
    check: "Проверить доставку, неизвестные типы и пропуски до использования событий для обновления данных.",
    keys: ["fanslyWsCaptureEnabled", "fanslyWsCapturePageAllowlist"], gates: [gate("fanslyWsCaptureEnabled")],
    scope: { key: "fanslyWsCapturePageAllowlist", empty: "none", none: "none" }, ...sync,
  },
  {
    id: "dm-shadow", title: "Проверка ускорения чатов", group: "Fansly", advice: "diagnostic",
    summary: "Измеряет, можно ли сократить полный обход диалогов.",
    reason: "Оставить до завершения текущей проверки, затем отключить по её результату. Режим сам по себе не сокращает запросы.",
    consequence: "Прекратятся диагностические измерения. Полный обход диалогов продолжится.",
    check: "Получить итог проверки со всеми долгами и полнотой обходов, прежде чем менять алгоритм сбора.",
    keys: ["fanslyDmShadowPageAllowlist"], gates: [], scope: { key: "fanslyDmShadowPageAllowlist", empty: "none", none: "none" }, ...sync,
  },
  {
    id: "earnings-shadow", title: "Проверка обновления трат", group: "Fansly", advice: "diagnostic",
    summary: "Сопоставляет изменения платежей с ответами о суммарных тратах фанов.",
    reason: "Включать для ограниченного исследования. Экономия запросов и ускорение этим режимом ещё не доказаны.",
    consequence: "Прекратится сопоставление сигналов. Ежедневный обход трат останется прежним.",
    check: "Сверить отдельные ответы за месяц и за всё время, неподтверждённые изменения и полный обход.",
    keys: ["fanslyFanEarningsShadowPageAllowlist"], gates: [], scope: { key: "fanslyFanEarningsShadowPageAllowlist", empty: "none", none: "none" }, ...sync,
  },
  {
    id: "head-catchup", title: "Докачка последних сообщений", group: "Fansly", advice: "diagnostic",
    summary: "Ищет известные сообщения, которые ещё не попали в архив.",
    reason: "Использовать по результатам проверки полноты на выбранных страницах. Не включать на всех только потому, что функция появилась.",
    consequence: "Остановится отдельная докачка известных сообщений; незакрытые пропуски останутся видимыми.",
    check: "Сверить точные недостающие сообщения и результат ограниченных попыток.",
    keys: ["fanslyDmHeadCatchupPageAllowlist"], gates: [], scope: { key: "fanslyDmHeadCatchupPageAllowlist", empty: "none", none: "none" }, ...sync,
  },
  {
    id: "deep-history", title: "Массовая загрузка старых чатов", group: "Fansly", advice: "off",
    summary: "Обходит старую переписку вне точечных запросов на дозагрузку.",
    reason: "Держать выключенной без конкретной задачи по истории. Для отдельного вопроса доступна ограниченная дозагрузка агента.",
    consequence: "Старая история не будет загружаться этим фоновым путём. Уже сохранённая переписка останется.",
    check: "Определить страницы и глубину нужной истории до включения; флаг снятия лимита сам по себе не запускает загрузку.",
    keys: ["fanslyDmDeepBackfillEnabled", "fanslyDeepBackfillIgnoreRetentionLimit", "fanslyDmDeepBackfillMaxRequestsPerRun"], gates: [gate("fanslyDmDeepBackfillEnabled")], ...sync,
  },
  {
    id: "replay", title: "Повторная обработка архива", group: "Fansly", advice: "off",
    summary: "Повторно разбирает ранее сохранённые ответы площадки.",
    reason: "Держать выключенной после завершения конкретного восстановления. Это инструмент ремонта, а не повседневная функция.",
    consequence: "Этот повторный разбор остановится. Уже захваченные данные останутся; новые запросы к площадке этот режим не экономит.",
    check: "Проверить наличие незавершённого восстановления и его отдельный план.",
    keys: ["fanslyReplayMode"], gates: [gate("fanslyReplayMode", "off")], ...sync,
  },
  {
    id: "storage", title: "Общее хранилище ответов", group: "Система", advice: "keep",
    summary: "Общая копия исходных данных, источник чтения и уменьшение дублей.",
    reason: "Сохранить проверенную конфигурацию. Это основа хранения; выключение по названию флага может увеличить объём базы.",
    consequence: "Изменятся запись и источник чтения исходных ответов. Возврат режима чтения не удаляет уже сохранённые данные.",
    check: "Перед изменением сверить полноту общей копии, доступность чтения и фактический объём хранения.",
    keys: ["captureCasDualWritePages", "captureCasReadMode", "captureCasPointerOnlyPages"], gates: [],
    scope: { key: "captureCasDualWritePages", empty: "none", all: "*" }, evidenceHref: "/dev/db-stats", evidenceLabel: "Проверить хранилище",
  },
  {
    id: "tiering", title: "Перенос старых периодов из базы", group: "Система", advice: "off",
    summary: "Плановый перенос старых периодов в отдельный архив.",
    reason: "Держать выключенным до отдельной проверки читателей архива. Он влияет на доступность данных для агентов и повторной обработки.",
    consequence: "Плановый перенос остановится. Само хранение и ручные операции переноса этим флагом не выключаются.",
    check: "Подтвердить чтение всех нужных периодов после переноса и возможность восстановления.",
    keys: ["retentionTieringEnabled", "pageDmPruneEnabled"], gates: [gate("retentionTieringEnabled")], evidenceHref: "/dev/db-stats", evidenceLabel: "Проверить хранилище",
  },
  {
    id: "legacy", title: "Прежний опрос чатов OnlyFans", group: "OnlyFans", advice: "off",
    summary: "Старый путь периодического чтения переписки.",
    reason: "Держать выключенным: рабочая цепочка использует события OFAPI и собственную сверку.",
    consequence: "Прежний путь опроса останется выключенным. Текущая цепочка переписки настраивается отдельно.",
    check: "Проверить актуальную переписку через действующую цепочку OFAPI.",
    keys: ["onlyFansDmPollingEnabled"], gates: [gate("onlyFansDmPollingEnabled")], ...sync,
  },
];

export function findHubFeature(id: string | null | undefined): HubFeature | undefined {
  return HUB_FEATURES.find((feature) => feature.id === id);
}

export function featureSettingsHref(feature: HubFeature, source?: URLSearchParams): string {
  const next = new URLSearchParams({ tab: "configuration", feature: feature.id });
  if (source) {
    next.set("view", source.get("view") ?? "review");
    if (source.get("q")) next.set("q", source.get("q")!);
  }
  return `/settings?${next.toString()}`;
}

export function featureReturnHref(feature: HubFeature, source: URLSearchParams): string {
  const next = new URLSearchParams({ tab: "features", view: source.get("view") ?? "all", feature: feature.id });
  if (source.get("q")) next.set("q", source.get("q")!);
  return `/settings?${next.toString()}`;
}
