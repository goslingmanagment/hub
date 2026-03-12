export const PLATFORM_LABELS: Record<string, string> = {
  fansly: "Fansly",
  onlyfans: "OnlyFans",
};

export const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  subscription: "Subscription",
  tip: "Tip",
  message_purchase: "Message",
  post_purchase: "Post Unlock",
  stream_tip: "Stream Tip",
  chargeback: "Chargeback",
  refund: "Refund",
  payout_reversal: "Payout Reversal",
  other: "Other",
};

export const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  team_lead: "Team Lead",
  chatter: "Chatter",
  content_manager: "Content Manager",
};

export const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400",
  success: "bg-emerald-500/20 text-emerald-400",
  posted: "bg-emerald-500/20 text-emerald-400",
  running: "bg-amber-500/20 text-amber-400",
  pending: "bg-amber-500/20 text-amber-400",
  stale: "bg-amber-500/20 text-amber-400",
  never_synced: "bg-zinc-500/20 text-zinc-400",
  unverified: "bg-zinc-500/20 text-zinc-400",
  failed: "bg-red-500/20 text-red-400",
  error: "bg-red-500/20 text-red-400",
  expired: "bg-red-500/20 text-red-400",
  partial: "bg-amber-500/20 text-amber-400",
  skipped: "bg-zinc-500/20 text-zinc-400",
};

export const CONNECTION_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  stale: "Stale",
  error: "Error",
  expired: "Expired",
  never_synced: "Never Synced",
  unverified: "Unverified",
};
