import type { NotificationsIncidentItem } from "@agency_hub_core/contracts";

/**
 * The failures that are only the switched-off OnlyFans API: while it is off there
 * is nothing to repair, so they wait for nobody. One rule for the count on Главная
 * and the grey group on «Сбои» (design/screens/system.md §4, block 5): the two
 * cannot differ. The rest of the failures' words is the system group's and lives
 * here too.
 */
export function isOfapiOffFailure(item: Pick<NotificationsIncidentItem, "kind" | "platform" | "incidentKey">): boolean {
  // A late answer to OnlyFans' letter can freeze the page's money.
  if (item.kind === "ofapi_platform_notice") return false;
  if (item.kind.startsWith("ofapi_")) return true;
  if (item.platform === "onlyfans" && item.kind !== "chatspace_tab") return true;
  // golden_signal_lag:global:ofapi_delivery_history_age opened half an hour after the key went.
  return item.incidentKey.includes(":ofapi_");
}
