import { HUB_FEATURES } from "./featureCatalog.js";

export const CONFIG_MODE_CHOICES: Record<string, readonly { value: string; label: string }[]> = {
  aiTranscriptFreshUnionMode: [{ value: "off", label: "Только архив" }, { value: "shadow", label: "Проверять свежие данные" }, { value: "serve", label: "Использовать свежие данные" }],
  chatMuseAiFanProfileContextFeatures: [{ value: "none", label: "Не передавать досье" }, { value: "fast-reply", label: "Только быстрый ответ" }, { value: "fast-reply,ping", label: "Быстрый ответ и Ping" }, { value: "all", label: "Все поддерживаемые функции" }],
  agentReadPlaneMode: [{ value: "off", label: "Выключен" }, { value: "read_only", label: "Проверочный доступ" }, { value: "full", label: "Обычный доступ по выданным правам" }],
  agentSearchBackend: [{ value: "off", label: "Поиск выключен" }, { value: "fts", label: "Поиск по тексту" }, { value: "fts_trgm", label: "Текстовый поиск с поиском похожих фрагментов" }],
  agentHydrationMode: [{ value: "off", label: "Выключена" }, { value: "request_only", label: "Только заявки, без исполнения" }, { value: "dispatch", label: "Исполнять одобренные заявки" }],
  agentHydrationAutoApproveMode: [{ value: "off", label: "Только ручное одобрение" }, { value: "shadow", label: "Проверять правила, не одобрять" }, { value: "enforce", label: "Автоодобрение в пределах бюджета" }],
  fanslyReplayMode: [{ value: "off", label: "Выключена" }, { value: "shadow", label: "Проверить без записи результатов" }, { value: "on", label: "Обработать и записать результаты" }],
  captureCasReadMode: [{ value: "inline", label: "Прежняя копия" }, { value: "shadow", label: "Прежняя копия с проверкой общей" }, { value: "serve", label: "Общая копия с запасным чтением" }],
};

export function configPageScope(key: string) {
  // Storage scopes use numeric page IDs, not labels. Keep their expert editor.
  return HUB_FEATURES.find((feature) => feature.scope?.key === key && feature.group !== "Система")?.scope;
}

export function selectedConfigPages(value: string, key: string, labels: readonly string[], isDraft: boolean): string[] {
  const scope = configPageScope(key);
  if (!scope) return [];
  if (value.trim() === "" && scope.empty === "all" && !isDraft) return [...labels];
  if (value.trim() === scope.none) return [];
  return [...new Set(value.split(",").map((label) => label.trim()).filter(Boolean))];
}

export function serializeConfigPages(key: string, labels: readonly string[]): string {
  const unique = [...new Set(labels)].sort();
  return unique.length ? unique.join(",") : configPageScope(key)?.none ?? "";
}

export function humanConfigValue(key: string, value: string | number | boolean | null): string {
  if (value === null) return "Нет подтверждённого значения";
  const mode = CONFIG_MODE_CHOICES[key]?.find((entry) => entry.value === String(value));
  if (mode) return mode.label;
  const scope = configPageScope(key);
  if (scope) {
    if (value === "") return scope.empty === "all" ? "Все страницы Fansly" : "Ни одной страницы";
    if (value === scope.none) return "Ни одной страницы";
    return String(value).split(",").map((part) => part.trim()).join(", ");
  }
  if (typeof value === "boolean") return value ? "Включено" : "Выключено";
  return value === "" ? "Пустая строка" : String(value);
}
