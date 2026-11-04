import type { ConfigItem } from "@agency_hub_core/contracts";
import { CONFIG_COPY_RU, SUBSYSTEM_COPY_RU } from "./configCopyRu.js";

export const CONFIG_SUBSYSTEM_LABELS: Record<string, string> = {
  Sync: "Сбор данных", Fansly: "Fansly", ChatMuse: "ИИ", AI: "ИИ",
  OFAPI: "OnlyFans API", Telegram: "Telegram",
  Agent: "Агенты", Core: "Система и хранилище", Security: "Безопасность",
};

export function configSubsystemOrder(subsystem: string): number {
  const index = Object.keys(CONFIG_SUBSYSTEM_LABELS).indexOf(subsystem);
  return index < 0 ? 100 : index;
}

export const CONFIG_FILTERS = [
  { key: "editable", label: "Можно менять" },
  { key: "attention", label: "Нужно проверить" },
  { key: "server", label: "Только на сервере" },
  { key: "all", label: "Все" },
] as const;

export type ConfigFilter = typeof CONFIG_FILTERS[number]["key"];

export function matchesConfigFilter(item: ConfigItem, filter: ConfigFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "editable": return item.runtimeApply !== "none";
    case "server": return item.runtimeApply === "none";
    case "attention":
      return item.pendingApply || item.drift || item.running.length === 0
        || (item.runtimeApply === "boot" && item.runningState === "unknown")
        || item.running.some((instance) => instance.state === "unknown");
  }
}

export function matchesConfigSearch(item: ConfigItem, query: string): boolean {
  const copy = CONFIG_COPY_RU[item.key];
  // Metadata only: never index a secret or a running/desired value.
  const haystack = [item.key, item.envName, item.label, item.subsystem, CONFIG_SUBSYSTEM_LABELS[item.subsystem], copy?.title,
    SUBSYSTEM_COPY_RU[item.subsystem], copy?.short, copy?.long, item.note]
    .filter(Boolean).join(" ").toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every((term) => haystack.includes(term));
}

export function runningDiffersFromDefault(item: ConfigItem): boolean {
  const first = item.running[0];
  if (!first || item.secret || first.masked || first.state === "unknown" || first.value === null) return false;
  return String(first.value) !== item.default;
}

export interface ConfigRiskBadge {
  text: string;
  tone: "badge-warning" | "badge-danger";
}

/**
 * The warnings of a setting's row, in place of the one «влияет на расходы»: the
 * risk of a block for Fansly, money for the OnlyFans API, ИИ and publishing, a
 * plain warning otherwise; «Может удалить данные» takes their place. Display
 * only: the write and its confirmations do not read this.
 */
export function configRiskBadges(item: ConfigItem): ConfigRiskBadge[] {
  const badges: ConfigRiskBadge[] = [];
  if (item.destructive) badges.push({ text: "Может удалить данные", tone: "badge-danger" });
  else if (item.costWarning || item.key === "publishingEnabled") {
    if (item.subsystem === "Fansly" && item.costWarning) badges.push({ text: "Риск блокировки", tone: "badge-warning" });
    else if (["OFAPI", "ChatMuse", "AI"].includes(item.subsystem) || item.key === "publishingEnabled") badges.push({ text: "Деньги", tone: "badge-warning" });
    else badges.push({ text: "С предупреждением", tone: "badge-warning" });
  }
  if (item.drift) badges.push({ text: "Значения различаются", tone: "badge-danger" });
  return badges;
}
