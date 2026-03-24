import type { SyncUxSummary } from "@agency_hub_core/contracts";

export type SyncUxDisplayMode = "hidden" | "badge" | "compact" | "full";
export type SyncUxDisplaySurface =
  | "topbar"
  | "overview_banner"
  | "overview_row"
  | "page_detail"
  | "credentials"
  | "sync_settings"
  | "crm_header";

function isAlertState(summary: SyncUxSummary) {
  return summary.requiresAction || summary.state === "attention" || summary.state === "off";
}

function isTransientState(summary: SyncUxSummary) {
  return summary.state === "syncing" ||
    summary.state === "retrying" ||
    summary.state === "catching_up" ||
    summary.state === "setup";
}

export function getSyncUxDisplayMode(
  summary: SyncUxSummary,
  surface: SyncUxDisplaySurface,
  input?: {
    hasIncompleteData?: boolean;
  },
): SyncUxDisplayMode {
  const hasIncompleteData = input?.hasIncompleteData ?? false;

  switch (surface) {
    case "topbar":
      return summary.state === "healthy" ? "badge" : "compact";
    case "overview_banner":
      return summary.requiresAction ||
          summary.state === "attention" ||
          summary.state === "off" ||
          summary.state === "retrying" ||
          summary.state === "setup"
        ? "full"
        : "hidden";
    case "overview_row":
      if (summary.state === "healthy") {
        return "badge";
      }
      return isAlertState(summary) ? "full" : "compact";
    case "page_detail":
      return summary.state === "healthy" ? "compact" : "full";
    case "credentials":
      if (summary.state === "healthy") {
        return "badge";
      }
      return isAlertState(summary) ? "full" : "compact";
    case "sync_settings":
      return isAlertState(summary) ? "full" : "compact";
    case "crm_header":
      if (!hasIncompleteData && summary.state === "healthy") {
        return "hidden";
      }
      if (isAlertState(summary)) {
        return "full";
      }
      return hasIncompleteData || isTransientState(summary) ? "compact" : "hidden";
  }
}
