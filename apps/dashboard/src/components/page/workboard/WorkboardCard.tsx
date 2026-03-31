import { useState, type MouseEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { TouchpointBadge } from "@/components/page/crm/TouchpointBadge";
import { ChatPreviewPanel } from "@/components/page/crm/ChatPreviewPanel";
import type { WorkboardCardVm } from "@/pages/workboard/viewModel";
import { OVERDUE_BG } from "@/pages/workboard/viewModel";

/* ── Tier color badge (Fansly-native palette) ────────────────────── */

const TIER_COLORS: Record<string, string> = {
  basic:    "bg-pink-400/15 text-pink-400",
  main:     "bg-red-400/15 text-red-400",
  advanced: "bg-yellow-400/15 text-yellow-500",
  master:   "bg-cyan-400/15 text-cyan-400",
  gfe:      "bg-zinc-500/15 text-zinc-300",
};
const TIER_COLOR_DEFAULT = "bg-zinc-500/15 text-zinc-400";

function resolveTierColor(tierShortName: string): string {
  const key = tierShortName.replace(/[^\p{L}\p{N}\s]/gu, "").trim().toLowerCase();
  for (const [prefix, color] of Object.entries(TIER_COLORS)) {
    if (key.startsWith(prefix)) return color;
  }
  return TIER_COLOR_DEFAULT;
}

/* ── Initial-letter avatar ───────────────────────────────────────── */

const AVATAR_BG = [
  "bg-red-400", "bg-orange-400", "bg-amber-400", "bg-emerald-400",
  "bg-cyan-400", "bg-sky-400", "bg-blue-400", "bg-indigo-400",
  "bg-violet-400", "bg-fuchsia-400", "bg-pink-400", "bg-teal-400",
];

function FanAvatar({ name }: { name: string }) {
  const chars = [...name];
  const firstAlpha = chars.find((c) => /\p{L}/u.test(c));
  const letter = firstAlpha ? firstAlpha.toUpperCase() : chars[0] ?? "?";
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash + name.charCodeAt(i)) | 0;
  const bg = AVATAR_BG[Math.abs(hash) % AVATAR_BG.length];
  return (
    <span className={`${bg} inline-flex items-center justify-center shrink-0 size-7 rounded-full text-[11px] font-bold text-white`}>
      {letter}
    </span>
  );
}

/* ── Recency color (metrics urgency) ─────────────────────────────── */

function recencyColor(daysAgo: number | null): string {
  if (daysAgo === null) return "text-text-muted";
  if (daysAgo >= 7) return "text-red-400";
  if (daysAgo >= 3) return "text-orange-400";
  return "text-text-secondary";
}

/* ── Snooze buttons ──────────────────────────────────────────────── */

interface SnoozeButtonsProps {
  onSnooze: (days: number) => void;
  isPending: boolean;
}

function SnoozeButtons({ onSnooze, isPending }: SnoozeButtonsProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-text-muted">Snooze</span>
      {[7, 14, 30].map((days) => (
        <button
          key={days}
          type="button"
          disabled={isPending}
          onClick={(e) => { e.stopPropagation(); onSnooze(days); }}
          className="px-2 py-0.5 text-[11px] font-medium rounded border border-border text-text-muted hover:text-text-secondary hover:bg-hover transition-colors disabled:opacity-50"
        >
          {days}d
        </button>
      ))}
    </div>
  );
}

/* ── Card ─────────────────────────────────────────────────────────── */

interface WorkboardCardProps {
  vm: WorkboardCardVm;
  pageLabel: string;
  isExpanded: boolean;
  onToggle: () => void;
  onSnooze: (days: number) => void;
  isSnoozePending: boolean;
}

export function WorkboardCard({
  vm, pageLabel, isExpanded, onToggle, onSnooze, isSnoozePending,
}: WorkboardCardProps) {
  const [copied, setCopied] = useState(false);
  const platformConversationId = vm.platformConversationId;
  const canPreview = vm.canPreview && platformConversationId !== null;
  const externalLinkLabel = vm.fanslyExternalKind === "chat" ? "Copy chat" : "Copy profile";
  const externalLinkTitle = vm.fanslyExternalKind === "chat"
    ? "Copy Fansly chat link"
    : "Copy Fansly profile link";

  async function handleCopyFanslyLink(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();

    if (!vm.fanslyExternalUrl) {
      return;
    }

    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast.error("Clipboard is not available");
      return;
    }

    try {
      await navigator.clipboard.writeText(vm.fanslyExternalUrl);
      setCopied(true);
      toast.success(vm.fanslyExternalKind === "chat" ? "Fansly chat link copied" : "Fansly profile link copied");
      globalThis.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(vm.fanslyExternalKind === "chat" ? "Failed to copy Fansly chat link" : "Failed to copy Fansly profile link");
    }
  }

  return (
    <div>
      <div
        onClick={onToggle}
        className={`${OVERDUE_BG[vm.overdueSeverity]} border border-border rounded-lg p-3 cursor-pointer hover:border-accent/40 transition-colors`}
      >
        {/* Row 1: Avatar + Identity + Tier badge + LTV */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <FanAvatar name={vm.fanLabel} />
            {vm.kind === "subscriber" && (
              <span title={`Follow-up schedule: every ${vm.touchpointCode}${vm.overdueDays > 0 ? ` (overdue ${vm.overdueDays}d)` : ""}`}>
                <TouchpointBadge touchpointCode={vm.touchpointCode} touchpointLabel={vm.touchpointCode} />
              </span>
            )}
            <span className="text-sm font-semibold text-text-primary truncate">{vm.fanLabel}</span>
            {vm.fanSubLabel && (
              <span className="text-[12px] text-text-muted truncate">{vm.fanSubLabel}</span>
            )}
            {vm.kind === "subscriber" && vm.tierShortName && (
              <span
                className={`${resolveTierColor(vm.tierShortName)} inline-flex shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-bold`}
                title={vm.tierName ?? undefined}
              >
                {vm.tierShortName}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[12px] text-text-muted">LTV</span>
            <span className="text-sm font-semibold text-text-primary tabular-nums">{vm.ltvLabel}</span>
          </div>
        </div>

        {/* Row 2: Communication + spend */}
        <div className="mt-1.5 text-[13px] text-text-muted">
          Fan: <span className="font-semibold text-text-secondary">{vm.lastFanMessageLabel ?? "never"}</span>
          <span className="mx-1.5 text-border">·</span>
          Model: <span className="font-semibold text-text-secondary">{vm.lastModelMessageLabel ?? "never"}</span>
          <span className="mx-1.5 text-border">·</span>
          Spend: <span className="font-semibold text-text-secondary">{vm.lastTransactionLabel ?? "never"}</span>
        </div>

        {/* Row 3: Subscription details + actions */}
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <div className="text-[12px] text-text-muted flex items-center gap-1.5 min-w-0">
            {vm.kind === "subscriber" ? (
              <>
                <span>
                  Expires {vm.expiryLabel}
                  <span className="ml-1 text-text-secondary">({vm.expiryRelativeLabel})</span>
                </span>
                {vm.autoRenew !== null && (
                  <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ${vm.autoRenew ? "bg-green/10 text-green" : "bg-warning/10 text-warning"}`}>
                    {vm.autoRenew ? "Auto-renew" : "No renew"}
                  </span>
                )}
              </>
            ) : (
              <span>
                {vm.subscriptionStatus === "expired"
                  ? `Sub expired${vm.subscriptionExpiresLabel ? ` (${vm.subscriptionExpiresLabel})` : ""}`
                  : "Never subscribed"}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <SnoozeButtons onSnooze={onSnooze} isPending={isSnoozePending} />
            {vm.fanslyExternalUrl && (
              <button
                type="button"
                onClick={handleCopyFanslyLink}
                className="px-3 py-0.5 text-[11px] font-semibold rounded border border-border text-text-secondary hover:bg-hover transition-colors"
                title={externalLinkTitle}
                aria-label={externalLinkTitle}
              >
                {copied ? "Copied!" : externalLinkLabel}
              </button>
            )}
            <Link
              to={vm.profileHref}
              onClick={(e) => e.stopPropagation()}
              className="ml-2 px-3 py-0.5 text-[11px] font-semibold rounded bg-accent text-white hover:bg-accent/85 transition-colors"
            >
              Profile
            </Link>
          </div>
        </div>
      </div>

      {isExpanded && canPreview && (
        <div className="mt-1 rounded-lg overflow-hidden border border-border">
          <ChatPreviewPanel
            pageLabel={pageLabel}
            platformConversationId={platformConversationId!}
            profileHref={vm.profileHref}
            limit={25}
          />
        </div>
      )}
    </div>
  );
}
