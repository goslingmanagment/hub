import type { SyncUxSummary } from "@agency_hub_core/contracts";

export type SyncUxDisplayMode = "hidden" | "exception" | "home";
export type SyncUxDisplaySurface =
  | "overview_row"
  | "page_detail"
  | "credentials"
  | "sync_settings"
  | "crm_header";

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
  input?: {
    hasIncompleteData?: boolean;
  },
): SyncUxDisplayMode {
  const hasIncompleteData = input?.hasIncompleteData ?? false;

  switch (surface) {
    case "overview_row":
      return getSyncUxExceptionKind(summary) ? "exception" : "hidden";
    case "page_detail":
      return getSyncUxExceptionKind(summary) ? "exception" : "hidden";
    case "credentials":
      return summary.requiresAction ? "exception" : "hidden";
    case "sync_settings":
      return "home";
    case "crm_header":
      return summary.requiresAction || summary.state === "off" || hasIncompleteData
        ? "exception"
        : "hidden";
  }
}
