import type { ConfigViewResponse } from "@agency_hub_core/contracts";
import { CONFIG_COPY_RU } from "../configCopyRu.js";
import { seedValue } from "../ConfigurationEditors.js";
import { configHomeHref } from "../featureCatalog.js";

/**
 * Where a page's name is written in the hub's parameters. Renaming a page changes
 * only its row in `pages`; these parameters keep the old name and quietly stop
 * applying to it (design/screens/settings.md, «Что нашлось», п. 1). Only reads.
 */
export const PAGE_LABEL_KEYS: readonly { key: string; name: string }[] = [
  { key: "chatExtensionFeatures", name: "Функции расширения" },
  { key: "voiceNotesPageAllowlist", name: "Голосовые сообщения" },
  { key: "fanFactsPages", name: "Факты из чата" },
  { key: "fanslyVaultHeadWalkPages", name: CONFIG_COPY_RU.fanslyVaultHeadWalkPages?.title ?? "Сейф: обход от начала альбома" },
  { key: "aiMediaDescribePagePolicies", name: "Описание картинок" },
  { key: "crossSpendersLists", name: CONFIG_COPY_RU.crossSpendersLists?.title ?? "Спендеры других страниц" },
  { key: "chatExtensionHostBindings", name: CONFIG_COPY_RU.chatExtensionHostBindings?.title ?? "Привязка аккаунтов расширения" },
  { key: "telegramProxyPageLabel", name: CONFIG_COPY_RU.telegramProxyPageLabel?.title ?? "Прежний прокси для Telegram" },
];

export interface PageLabelUse {
  key: string;
  name: string;
  to: string;
}

/** A JSON value names the page as a key or a value, anywhere inside it. */
function jsonNames(value: unknown, label: string): boolean {
  if (typeof value === "string") return value === label;
  if (Array.isArray(value)) return value.some((entry) => jsonNames(entry, label));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, entry]) => key === label || jsonNames(entry, label));
  }
  return false;
}

/** Whether a stored value names the page: a list item exactly, a JSON key or value, or the whole string. */
export function valueNamesPage(raw: string, label: string): boolean {
  const text = raw.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return jsonNames(JSON.parse(text), label);
    } catch {
      return false;
    }
  }
  return text.split(",").some((entry) => entry.trim() === label);
}

/** The parameters that hold the page's name now, each with its home. */
export function pageLabelUses(config: ConfigViewResponse, label: string): PageLabelUse[] {
  const items = new Map(config.subsystems.flatMap((group) => group.items).map((item) => [item.key, item]));
  return PAGE_LABEL_KEYS.flatMap(({ key, name }) => {
    const item = items.get(key);
    if (!item || item.secret) return [];
    return valueNamesPage(seedValue(item), label) ? [{ key, name, to: configHomeHref(key).to }] : [];
  });
}
