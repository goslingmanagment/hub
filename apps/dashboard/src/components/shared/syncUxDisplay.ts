import type { SyncUxSummary } from "@agency_hub_core/contracts";

export type SyncUxDisplayMode = "hidden" | "exception" | "home" | "diagnostic";
export type SyncUxDisplaySurface =
  | "topbar"
  | "overview_banner"
  | "overview_row"
  | "page_detail"
  | "credentials"
  | "sync_settings"
  | "crm_header"
  | "sync_diagnostics";

export type SyncUxExceptionKind = "credentials" | "attention" | "off";

export function isAlertState(summary: SyncUxSummary) {
  return summary.requiresAction || summary.state === "attention" || summary.state === "off";
}

export function isTransientState(summary: SyncUxSummary) {
  return summary.state === "syncing" ||
    summary.state === "retrying" ||
    summary.state === "catching_up" ||
    summary.state === "setup";
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

export function getSyncUxSettingsTab(summary: SyncUxSummary): "credentials" | "sync" | null {
  const kind = getSyncUxExceptionKind(summary);
  if (kind === "credentials") {
    return "credentials";
  }
  if (kind === "attention" || kind === "off") {
    return "sync";
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
    case "topbar":
      return "hidden";
    case "overview_banner":
      return "hidden";
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
    case "sync_diagnostics":
      return "diagnostic";
  }
}
