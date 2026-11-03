import type { SyncUxSummary } from "@agency_hub_core/contracts";
import { platformSyncKind, type Platform } from "@agency_hub_core/shared";
import { COLLECTION_STATUS, type StatusWord } from "@/lib/statusWords";

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
  healthy: COLLECTION_STATUS.healthy.word,
  syncing: COLLECTION_STATUS.syncing.word,
  catching_up: COLLECTION_STATUS.catching_up.word,
  retrying: COLLECTION_STATUS.retrying.word,
  attention: COLLECTION_STATUS.attention.word,
  setup: COLLECTION_STATUS.setup.word,
  off: "Не читается",
};

/**
 * The collection state of a page as the dictionary says it (lib/statusWords.ts).
 * An OnlyFans page is reached through its API, switched off by the owner since
 * 1 November: what the server reports as "needs action" or "off" there is that,
 * grey, and never an alarm. A platform the hub does not collect has nothing to
 * show but that. When the API returns this is the one place to change.
 */
export function syncStatusWord(summary: SyncUxSummary, platform?: Platform): StatusWord {
  if (platform !== undefined && platformSyncKind(platform) === "none") return COLLECTION_STATUS.notNeeded;
  if (platform === "onlyfans" && (summary.requiresAction || summary.state === "off" || summary.state === "attention")) {
    return COLLECTION_STATUS.ofapiOff;
  }
  if (summary.requiresAction) return COLLECTION_STATUS.requiresAction;
  if (summary.state === "off") return { word: "Не читается", tone: "broken" };
  return COLLECTION_STATUS[summary.state];
}

export function syncStateLabel(summary: SyncUxSummary, platform?: Platform): string {
  return syncStatusWord(summary, platform).word;
}

export type SyncTone = "ok" | "warn" | "error" | "muted";

export function syncTone(summary: SyncUxSummary, platform?: Platform): SyncTone {
  const { tone } = syncStatusWord(summary, platform);
  if (tone === "good") return "ok";
  if (tone === "broken") return "error";
  if (tone === "attention") return "warn";
  return "muted";
}
