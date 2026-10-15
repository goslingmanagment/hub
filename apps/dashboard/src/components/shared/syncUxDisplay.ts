import type { SyncUxSummary } from "@agency_hub_core/contracts";

export type SyncUxDisplayMode = "hidden" | "exception" | "home";
export type SyncUxDisplaySurface =
  | "overview_row"
  | "page_detail"
  | "credentials"
  | "sync_settings";

export type SyncUxExceptionKind = "credentials" | "attention" | "off";

export function isAlertState(summary: SyncUxSummary) {
  return summary.requiresAction || summary.state === "attention" || summary.state === "off";
}

export function getSyncUxExceptionKind(summary: SyncUxSummary): SyncUxExceptionKind | null {
  if (summary.requiresAction) {
    return "credentials";
  }

  if (summary.state === "attention") {
    return "attention";
  }

  if (summary.state === "off") {
    return "off";
  }

  return null;
}

export function getSyncUxDisplayMode(
  summary: SyncUxSummary,
  surface: SyncUxDisplaySurface,
): SyncUxDisplayMode {
  switch (surface) {
    case "overview_row":
      return getSyncUxExceptionKind(summary) ? "exception" : "hidden";
    case "page_detail":
      return getSyncUxExceptionKind(summary) ? "exception" : "hidden";
    case "credentials":
      return summary.requiresAction ? "exception" : "hidden";
    case "sync_settings":
      return "home";
  }
}

/** The server describes a sync in English; the console speaks Russian. The
 *  state is the contract, so the words are chosen here from it. */
export const SYNC_STATE_LABELS: Readonly<Record<SyncUxSummary["state"], string>> = {
  healthy: "Данные обновляются",
  syncing: "Идёт обновление",
  catching_up: "Догоняет",
  retrying: "Повторяет попытку",
  attention: "Нужна проверка",
  setup: "Первая загрузка",
  off: "Не обновляется",
};

/** An OnlyFans page is reached through OFAPI, so "needs action" there means
 *  the OFAPI connection, not a login the owner can renew in Hub. */
export function syncStateLabel(summary: SyncUxSummary, platform?: "fansly" | "onlyfans"): string {
  if (summary.requiresAction) return platform === "onlyfans" ? "Проверьте OnlyFans API" : "Нужен вход";
  return SYNC_STATE_LABELS[summary.state];
}

export type SyncTone = "ok" | "warn" | "error" | "muted";

export function syncTone(summary: SyncUxSummary): SyncTone {
  if (summary.requiresAction || summary.state === "attention") return "error";
  if (summary.state === "off") return "warn";
  if (summary.state === "retrying" || summary.state === "setup" || summary.state === "catching_up") return "muted";
  return "ok";
}
