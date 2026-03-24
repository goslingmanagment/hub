import type { SyncUxSummary } from "@agency_hub_core/contracts";

type SyncUxState = SyncUxSummary["state"];

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const SYNC_UX_TONES: Record<SyncUxState, {
  badge: string;
  dot: string;
  panel: string;
  text: string;
}> = {
  healthy: {
    badge: "border-green/30 bg-green/10 text-green",
    dot: "bg-green",
    panel: "border-green/20 bg-green/[0.04]",
    text: "text-green",
  },
  syncing: {
    badge: "border-[#bfdbfe] bg-[#dbeafe] text-[#1d4ed8]",
    dot: "bg-[#2563eb]",
    panel: "border-[#bfdbfe] bg-[#eff6ff]",
    text: "text-[#1d4ed8]",
  },
  catching_up: {
    badge: "border-warning/25 bg-warning/10 text-warning-dark",
    dot: "bg-warning-dark",
    panel: "border-warning/20 bg-warning/[0.05]",
    text: "text-warning-dark",
  },
  retrying: {
    badge: "border-warning/35 bg-warning/12 text-warning-dark",
    dot: "bg-warning-dark",
    panel: "border-warning/25 bg-warning/[0.06]",
    text: "text-warning-dark",
  },
  attention: {
    badge: "border-danger/30 bg-danger/10 text-danger",
    dot: "bg-danger",
    panel: "border-danger/20 bg-danger/[0.04]",
    text: "text-danger",
  },
  setup: {
    badge: "border-border bg-hover-alt text-text-secondary",
    dot: "bg-text-muted",
    panel: "border-border bg-hover-alt/50",
    text: "text-text-secondary",
  },
  off: {
    badge: "border-border bg-card text-text-muted",
    dot: "bg-text-muted",
    panel: "border-border bg-card",
    text: "text-text-muted",
  },
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
    return future ? "in under a minute" : "just now";
  }

  if (mins < 60) {
    return future ? `in ${mins}m` : `${mins}m ago`;
  }

  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return future ? `in ${hours}h` : `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

export function formatSyncUxMeta(
  summary: SyncUxSummary,
  input?: {
    updatedPrefix?: string;
    retryPrefix?: string;
  },
) {
  if (summary.nextRetryAt) {
    return `${input?.retryPrefix ?? "Retrying"} ${formatSyncUxTime(summary.nextRetryAt)}`;
  }

  if (summary.updatedAt) {
    return `${input?.updatedPrefix ?? "Updated"} ${formatSyncUxTime(summary.updatedAt)}`;
  }

  return null;
}

export function SyncUxBadge(
  { summary, className }: { summary: SyncUxSummary; className?: string },
) {
  const tone = getSyncUxTone(summary.state);

  return (
    <span className={joinClasses(
      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
      tone.badge,
      className,
    )}
    >
      <span className={joinClasses("h-1.5 w-1.5 rounded-full", tone.dot)} />
      {summary.label}
    </span>
  );
}
