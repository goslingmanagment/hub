import type { SyncUxSummary } from "@agency_hub_core/contracts";
import { SYNC_STATE_LABELS } from "./syncUxDisplay.js";

type SyncUxState = SyncUxSummary["state"];

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

// A page's sync summary as a badge, in the theme's tones and the console's
// words (the server's English `label` is not shown).

const SYNC_UX_TONES: Record<SyncUxState, {
  badge: string;
  dot: string;
  panel: string;
  text: string;
}> = {
  healthy: { badge: "badge badge-success", dot: "status-dot status-dot-ok", panel: "notice notice-success", text: "text-green" },
  syncing: { badge: "badge badge-info", dot: "status-dot status-dot-ok", panel: "notice", text: "text-text-secondary" },
  catching_up: { badge: "badge badge-warning", dot: "status-dot status-dot-warn", panel: "notice notice-warning", text: "text-warning-dark" },
  retrying: { badge: "badge badge-warning", dot: "status-dot status-dot-warn", panel: "notice notice-warning", text: "text-warning-dark" },
  attention: { badge: "badge badge-danger", dot: "status-dot status-dot-error", panel: "notice notice-danger", text: "text-danger" },
  setup: { badge: "badge", dot: "status-dot", panel: "notice", text: "text-text-secondary" },
  off: { badge: "badge", dot: "status-dot", panel: "notice", text: "text-text-muted" },
};

export function getSyncUxTone(state: SyncUxState) {
  return SYNC_UX_TONES[state];
}

function formatSyncUxTime(iso: string) {
  const diffMs = new Date(iso).getTime() - Date.now();
  const future = diffMs > 0;
  const absMs = Math.abs(diffMs);
  const mins = Math.floor(absMs / 60_000);

  if (mins < 1) {
    return future ? "меньше чем через минуту" : "только что";
  }

  if (mins < 60) {
    return future ? `через ${mins} мин` : `${mins} мин назад`;
  }

  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return future ? `через ${hours} ч` : `${hours} ч назад`;
  }

  const days = Math.floor(hours / 24);
  return future ? `через ${days} дн` : `${days} дн назад`;
}

export function formatSyncUxMeta(
  summary: SyncUxSummary,
  input?: {
    updatedPrefix?: string;
    retryPrefix?: string;
  },
) {
  if (summary.nextRetryAt) {
    return `${input?.retryPrefix ?? "Повтор"} ${formatSyncUxTime(summary.nextRetryAt)}`;
  }

  if (summary.updatedAt) {
    return `${input?.updatedPrefix ?? "Обновлено"} ${formatSyncUxTime(summary.updatedAt)}`;
  }

  return null;
}

export function SyncUxBadge(
  { summary, className }: { summary: SyncUxSummary; className?: string },
) {
  const tone = getSyncUxTone(summary.state);

  return (
    <span className={joinClasses(tone.badge, className)} data-sync-ux-state={summary.state}>
      {SYNC_STATE_LABELS[summary.state]}
    </span>
  );
}
