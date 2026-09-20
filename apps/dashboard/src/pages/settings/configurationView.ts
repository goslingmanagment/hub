import type { ConfigItem } from "@agency_hub_core/contracts";
import { CONFIG_COPY_RU, SUBSYSTEM_COPY_RU } from "./configCopyRu.js";

export const CONFIG_SUBSYSTEM_LABELS: Record<string, string> = {
  Sync: "Синхронизация", Fansly: "Fansly", ChatMuse: "AI и ChatMuse",
  OFAPI: "OnlyFans API", Telegram: "Telegram",
  Agent: "Агенты", Core: "Система и хранилище", Security: "Безопасность",
};

export function configSubsystemOrder(subsystem: string): number {
  const index = Object.keys(CONFIG_SUBSYSTEM_LABELS).indexOf(subsystem);
  return index < 0 ? 100 : index;
}

export const CONFIG_FILTERS = [
  { key: "live", label: "Без перезапуска" },
  { key: "staged", label: "После перезапуска" },
  { key: "all", label: "Все настройки" },
  { key: "attention", label: "Нужно проверить" },
] as const;

export type ConfigFilter = typeof CONFIG_FILTERS[number]["key"];

export function matchesConfigFilter(item: ConfigItem, filter: ConfigFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "live": return item.runtimeApply === "live";
    case "staged": return item.runtimeApply === "boot";
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
