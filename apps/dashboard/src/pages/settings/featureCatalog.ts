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
const ai = { evidenceHref: "/money/costs/ai", evidenceLabel: "Посмотреть траты на ИИ" };
/** The new AI entries (design/screens/settings.md §4.3): paid on every call. */
const paid = {
  advice: "optional" as const,
  reason: "Оставить, пока польза стоит этих денег: каждый вызов оплачивается.",
  check: "Сравнить траты с качеством ответов.",
};

export const HUB_FEATURES: readonly HubFeature[] = [
  {
    id: "ai-core", title: "ИИ для сотрудников", group: "AI и агенты", advice: "keep",
    summary: "Генерация ответов и помощь в диалогах через Hub.",
    reason: "Оставить как основной путь ИИ в расширении и приложениях. Ненужные функции оцениваются отдельно от общего доступа к ИИ.",
    consequence: "Отключится ИИ в расширении и приложениях. Это затронет обычную работу сотрудников.",
    check: "Посмотреть траты по функциям, ошибки и качество ответов. Расход сам по себе не доказывает пользу.",
    limitation: "Отдельных выключателей Reply, Help, Review и Coach нет: общий переключатель отключает ИИ целиком. Потолки по функциям меняются только в настройках сервера и не скрывают кнопки в расширении.",
    keys: ["chatMuseAiGatewayEnabled", "chatMuseAiGatewayDailyMicroUsdLimit", "chatMuseAiGatewayRequestMicroUsdLimit", "chatMuseAiGatewayFeatureDailyMicroUsdLimits"],
    gates: [gate("chatMuseAiGatewayEnabled")], ...ai,
  },
  {
    id: "fan-context", title: "Досье фана в ответах ИИ", group: "AI и агенты", advice: "optional",
    summary: "Передаёт сохранённые факты о фане в выбранные функции ИИ.",
    reason: "Оставить в уже выбранных функциях до сравнения качества. Не расширять автоматически: лишний или устаревший контекст может мешать ответу.",
    consequence: "Reply и Ping перестанут получать досье. Coach получает его при любом выборе. Сами профили останутся.",
    check: "Сравнить ответы с досье и без него на одинаковых диалогах; проверить ошибки из устаревших фактов.",
    keys: ["chatMuseAiFanProfileContextFeatures", "aiLiteDossierMaxChars", "aiTranscriptDeepMaxRows"],
    gates: [gate("chatMuseAiFanProfileContextFeatures", "none", "")], ...ai,
  },
  {
    id: "fan-facts", title: "Факты из чата", group: "AI и агенты", ...paid,
    summary: "После разговора Hub записывает, что фан рассказал, что обещали и о чём договорились.",
    consequence: "Новые факты записываться не будут. Записанные останутся.",
    keys: ["fanFactsEnabled", "fanFactsPages", "fanFactsModel", "fanFactsDailyMicroUsdLimit"],
    gates: [gate("fanFactsEnabled")], scope: { key: "fanFactsPages", empty: "none" }, ...ai,
  },
  {
    id: "media-describe", title: "Описание картинок", group: "AI и агенты", ...paid,
    summary: "Hub описывает картинки из чатов, чтобы ИИ понимал, что на них.",
    consequence: "За минуту остановятся новые описания и уйдут из запросов ИИ. Сохранённые описания останутся.",
    keys: ["aiMediaDescribeEnabled", "aiMediaDescribePagePolicies", "aiMediaDescribeModel", "aiMediaDescribeDailyImageLimit", "aiMediaDescribeDailyMicroUsdLimit", "aiMediaDescribeLiveChatOnly", "aiMediaDescribeModelMedia", "aiMediaDescribeLoopEnabled"],
    gates: [gate("aiMediaDescribeEnabled")], ...ai,
  },
  {
    id: "live-images", title: "ИИ смотрит фото фана", group: "AI и агенты", ...paid,
    summary: "Свежие фото фана из открытого чата уходят в Reply, Fix и Coach картинкой.",
    consequence: "Расширение перестанет слать фото, Hub их не возьмёт.",
    keys: ["aiLiveImagesEnabled"], gates: [gate("aiLiveImagesEnabled")], ...ai,
  },
  {
    id: "draft-media", title: "ИИ видит медиа в черновике", group: "AI и агенты", ...paid,
    summary: "Медиа, прикреплённое к сообщению, уходит в ИИ вместе с запросом.",
    consequence: "Расширение перестанет слать медиа из черновика, текст пойдёт без него.",
    keys: ["aiDraftMediaEnabled"], gates: [gate("aiDraftMediaEnabled")], ...ai,
  },
  {
    id: "notes-trim", title: "ИИ убирает воду из анкеты", group: "AI и агенты", ...paid,
    summary: "Вторым коротким вызовом вырезает воду из заполненной анкеты.",
    consequence: "Анкета придёт такой, как её написала модель.",
    keys: ["aiNotesTrimEnabled"], gates: [gate("aiNotesTrimEnabled")], ...ai,
  },
  {
    id: "voice", title: "Голосовые сообщения", group: "AI и агенты", advice: "optional",
    summary: "Создаёт голосовые по тексту на выбранных страницах.",
    reason: "Оставить ограниченный запуск, пока не подтверждены использование и результат. Расширять на остальные страницы по одному решению.",
    consequence: "Новые голосовые создаваться не будут. Доступ к готовым управляется отдельной настройкой.",
    check: "Сравнить число созданных и реально использованных голосовых, затраты и результат. Один включённый выключатель не подтверждает готовность голоса страницы.",
    limitation: "Траты показывают генерации текста для голосовых. Сколько аудио создано и отправлено, эта таблица не подтверждает.",
    keys: ["voiceNotesEnabled", "voiceNotesPageAllowlist", "voiceNotesDailyCharBudget", "voiceNotesGlobalDailyCharBudget", "voiceNotesScriptMaxChars", "voiceNotesMaxConcurrentSyntheses", "voiceNotesRetrievalEnabled"],
    gates: [gate("voiceNotesEnabled")], scope: { key: "voiceNotesPageAllowlist", empty: "none" }, ...ai,
  },
  {
    id: "prompt-debug", title: "Показ полного запроса ИИ", group: "AI и агенты", advice: "off",
    summary: "Сотрудник в режиме отладки видит собранный запрос, персону и досье фана.",
    reason: "Отключить после завершения отладки. Для обычной генерации раскрывать внутренние инструкции не требуется.",
    consequence: "Пропадёт отладочный просмотр запроса. Генерация ответов продолжит работать.",
    check: "Уточнить, есть ли сейчас незакрытая проблема, для которой сотруднику нужен этот просмотр.",
    keys: ["chatMuseAiPromptDebugEchoEnabled"], gates: [gate("chatMuseAiPromptDebugEchoEnabled")], ...ai,
  },
  {
    id: "agent-read", title: "Поиск и исследования по архиву", group: "AI и агенты", advice: "keep",
    summary: "Даёт агентам ограниченный доступ к сохранённым данным Hub.",
    reason: "Оставить, если проверки агентами входят в работу. Они читают архив с учётом прав и полноты данных.",
    consequence: "Агенты не смогут читать данные. Сбор и хранение продолжатся.",
    check: "Проверять полезность выполненных разборов; доступность чтения не означает полноту архива.",
    // Was without a switch: «Включено» even when the search is off.
    keys: ["agentSearchBackend"], gates: [gate("agentSearchBackend", "off")],
    evidenceHref: "/system/agent-keys", evidenceLabel: "Проверить доступ агентов",
  },
];

export function findHubFeature(id: string | null | undefined): HubFeature | undefined {
  return HUB_FEATURES.find((feature) => feature.id === id);
}

/** The AI's own tables on «Функции ИИ»: a value per feature, not a feature's switch. */
const FEATURE_TUNING_KEYS: ReadonlySet<string> = new Set(["aiFeatureModels", "aiFeatureEfforts", "aiFeatureWindows"]);

/**
 * Where a setting of the hub is worked with (design/ia.md §6): a setting that
 * has a screen of its own opens there, the rest on «Все параметры». Only a
 * navigation: the search writes nothing.
 */
export function configHomeHref(key: string): { to: string; hint: string } {
  if (key === "fanslyDefaultDelayMs") return { to: `/system/collection#config-${key}`, hint: "Сбор данных" };
  if (key === "publishingEnabled" || key === "publishingOnlyfansEnabled") return { to: "/publications?panel=settings", hint: "Настройки публикации" };
  if (FEATURE_TUNING_KEYS.has(key)) return { to: "/settings/ai/features#tuning", hint: "Функции ИИ" };
  const feature = HUB_FEATURES.find((candidate) => candidate.keys.includes(key));
  if (feature) return { to: `/settings/ai/features/${encodeURIComponent(feature.id)}#config-${key}`, hint: "Функции ИИ" };
  return { to: `/system/dev/config#config-${key}`, hint: "Все параметры" };
}

/** A feature's own parameters. The list's `?view=` and `?q=` no longer act and are not carried. */
export function featureSettingsHref(feature: HubFeature, _source?: URLSearchParams): string {
  return `/settings/ai/features/${encodeURIComponent(feature.id)}`;
}

/** Back to the list with the feature's row open. */
export function featureReturnHref(feature: HubFeature, _source?: URLSearchParams): string {
  return `/settings/ai/features?feature=${encodeURIComponent(feature.id)}`;
}
