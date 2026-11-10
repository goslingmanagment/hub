import type { SyncUxSummary } from "@agency_hub_core/contracts";
import { platformSyncKind, type Platform } from "@agency_hub_core/shared";
import { COLLECTION_STATUS, type OfapiStatus, type StatusWord } from "@/lib/statusWords";

export function isAlertState(summary: SyncUxSummary) {
  return summary.requiresAction || summary.state === "attention" || summary.state === "off";
}

/**
 * The collection state of a page by the server's summary, for who has only that
 * (a team lead: `overview`). The words are the dictionary's (lib/statusWords.ts,
 * `collectionWord`). An OnlyFans page is reached through its API: while that is off
 * it is grey and never an alarm; while nobody can tell, nothing is claimed.
 */
export function syncStatusWord(summary: SyncUxSummary, platform?: Platform, ofapi: OfapiStatus = "unknown"): StatusWord {
  if (platform !== undefined && platformSyncKind(platform) === "none") return COLLECTION_STATUS.notNeeded;
  if (platform === "onlyfans" && ofapi === "off") return COLLECTION_STATUS.ofapiOff;
  if (platform === "onlyfans" && ofapi === "unknown") return COLLECTION_STATUS.unknown;
  if (summary.requiresAction) return COLLECTION_STATUS.requiresAction;
  if (summary.state === "off") return COLLECTION_STATUS.attention;
  return COLLECTION_STATUS[summary.state];
}

