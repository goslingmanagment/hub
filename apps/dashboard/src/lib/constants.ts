export const PLATFORM_COLORS = {
  fansly: { bg: "#e8f0fe", text: "#3b6fc4", label: "Fansly" },
  onlyfans: { bg: "#fef3e2", text: "#c27a1a", label: "OnlyFans" },
} as const;

export const CONNECTION_STATUS_COLORS: Record<string, { dot: string; label: string }> = {
  active: { dot: "#4ead6b", label: "Active" },
  stale: { dot: "#f59e0b", label: "Stale" },
  error: { dot: "#d14343", label: "Error" },
  expired: { dot: "#d14343", label: "Expired" },
  never_synced: { dot: "#a8a29e", label: "Never Synced" },
  unverified: { dot: "#3b6fc4", label: "Unverified" },
};

export const TRANSACTION_STATE_COLORS: Record<string, string> = {
  posted: "#4ead6b",
  pending: "#b5711a",
  unknown: "#a8a29e",
};
