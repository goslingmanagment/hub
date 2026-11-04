/**
 * The page's Fansly settings in the console's words. Their summaries are stored as
 * ready text (`fansly_page_settings_versions.summary`), so a fix on the server would
 * not reach the old versions: the words change here, for the current and the earlier.
 */

export const SETTING_ROUTES: ReadonlyArray<{ route: string; label: string }> = [
  { route: "settings.account", label: "Аккаунт и приватность" },
  { route: "settings.geo_blocks", label: "Гео-блок" },
  { route: "settings.timeline_permissions", label: "Кто видит ленту" },
  { route: "settings.dm_permissions", label: "Кто пишет в личные сообщения" },
  { route: "settings.watermark", label: "Водяной знак" },
  { route: "settings.alerts", label: "Уведомления (почта, пуш)" },
  { route: "referrals.stats", label: "Реферальные коды" },
  { route: "tipgoals.account", label: "Цели по чаевым" },
  { route: "discovery.content", label: "Метки ленты For You" },
  { route: "discovery.tags", label: "Теги для поиска и For You" },
];

export const SETTING_LABELS: Readonly<Record<string, string>> = Object.fromEntries(SETTING_ROUTES.map((item) => [item.route, item.label]));

const REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/ЛС без ограничений/g, "личные сообщения без ограничений"],
  [/в ЛС пишут/g, "в личные сообщения пишут"],
  [/вотермарка выключена/g, "водяной знак выключен"],
  [/вотермарка включена/g, "водяной знак включён"],
  [/вотермарка/g, "водяной знак"],
  [/каналов алертов/g, "каналов уведомлений"],
  [/алертов нет/g, "уведомлений нет"],
  [/целей типов нет/g, "целей по чаевым нет"],
  [/целей типов/g, "целей по чаевым"],
  [/(^|[^а-яё])типы(?=[^а-яё]|$)/gi, "$1чаевые"],
];

export function fanslySettingWords(summary: string): string {
  return REPLACEMENTS.reduce((text, [pattern, word]) => text.replace(pattern, word), summary);
}
