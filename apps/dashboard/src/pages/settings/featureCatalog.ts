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
const fanslySync = { evidenceHref: "/settings?tab=engine", evidenceLabel: "Проверить сбор данных" };
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
    id: "ai-core", title: "AI для сотрудников", group: "AI и агенты", advice: "keep",
    summary: "Генерация ответов и помощь в диалогах через Hub.",
    reason: "Оставить как основной путь AI в клиентах. Ненужные функции оцениваются отдельно от общего доступа к AI.",
    consequence: "Отключится шлюз AI для клиентов. Это затронет обычную работу сотрудников.",
    check: "Посмотреть использование по функциям, ошибки и качество ответов. Расход сам по себе не доказывает пользу.",
    limitation: "Отдельных выключателей Fast Reply, Help Me, Chat Review и Coach в текущей конфигурации нет. Общий переключатель отключает шлюз целиком. Лимиты по функциям меняются через настройки сервера и не скрывают кнопки в клиенте.",
    keys: ["chatMuseAiGatewayEnabled", "chatMuseAiGatewayDailyMicroUsdLimit", "chatMuseAiGatewayFeatureDailyMicroUsdLimits"], gates: [gate("chatMuseAiGatewayEnabled")], ...ai,
  },
  {
    id: "agent-read", title: "Поиск и исследования по архиву", group: "AI и агенты", advice: "keep",
    summary: "Даёт агентам ограниченный доступ к сохранённым данным Hub.",
    reason: "Оставить, если агентские проверки входят в работу. Они читают архив с учётом прав и полноты данных.",
    consequence: "Агенты не смогут читать данные. Сбор и хранение продолжатся.",
    check: "Проверять полезность выполненных разборов; доступность чтения не означает полноту архива.",
    keys: ["agentSearchBackend"], gates: [],
    evidenceHref: "/settings?tab=agentKeys", evidenceLabel: "Проверить доступ агентов",
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
