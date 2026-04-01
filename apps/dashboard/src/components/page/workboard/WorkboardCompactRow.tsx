import { useState, type MouseEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { TouchpointBadge } from "@/components/shared/TouchpointBadge";
import type { WorkboardCardVm } from "@/pages/workboard/viewModel";
import { OVERDUE_BADGE, OVERDUE_BG } from "@/pages/workboard/theme";

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

interface WorkboardCompactRowProps {
  vm: WorkboardCardVm;
  showTierColumn: boolean;
  onContacted: () => void;
  onSnooze: (days: number) => void;
  isSnoozePending: boolean;
}

export function WorkboardCompactRow({
  vm, showTierColumn, onContacted, onSnooze, isSnoozePending,
}: WorkboardCompactRowProps) {
  const [copied, setCopied] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const externalLinkLabel = vm.fanslyExternalKind === "profile" ? "Профиль" : "Чат";
  const externalLinkTitle = vm.fanslyExternalKind === "profile"
    ? "Скопировать ссылку на профиль Fansly"
    : "Скопировать ссылку на чат Fansly";

  async function handleCopyFanslyLink(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!vm.fanslyExternalUrl) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast.error("Буфер обмена недоступен");
      return;
    }
    try {
      await navigator.clipboard.writeText(vm.fanslyExternalUrl);
      setCopied(true);
      toast.success(vm.fanslyExternalKind === "chat" ? "Ссылка на чат скопирована" : "Ссылка на профиль скопирована");
      globalThis.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Не удалось скопировать ссылку");
    }
  }

  return (
    <tr className={`${OVERDUE_BG[vm.overdueSeverity]} border-b border-border text-[12px] hover:bg-hover/50 transition-colors`}>
      {/* Fan */}
      <td className="py-2 px-3">
        <div className="flex items-center gap-1.5 min-w-0">
          {vm.kind === "subscriber" && (
            <TouchpointBadge touchpointCode={vm.touchpointCode} touchpointLabel={vm.touchpointLabel} />
          )}
          <span className="font-medium text-text-primary truncate max-w-[140px]">{vm.fanLabel}</span>
          {vm.fanSubLabel && (
            <span className="text-text-muted truncate max-w-[100px]">{vm.fanSubLabel}</span>
          )}
        </div>
      </td>

      {/* Tier */}
      {showTierColumn && (
        <td className="py-2 px-2">
          {vm.kind === "subscriber" && vm.tierShortName && (
            <span className={`${resolveTierColor(vm.tierShortName)} inline-flex px-1.5 py-0.5 rounded-md text-[10px] font-bold`}>
              {vm.tierShortName}
            </span>
          )}
        </td>
      )}

      {/* LTV */}
      <td className="py-2 px-2 text-right font-semibold text-text-primary tabular-nums whitespace-nowrap">
        {vm.ltvLabel}
      </td>

      {/* Renew / Status */}
      <td className="py-2 px-2 text-center">
        {vm.kind === "subscriber" ? (
          vm.autoRenew !== null && (
            <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ${vm.autoRenew ? "bg-green/10 text-green" : "bg-warning/10 text-warning"}`}>
              {vm.autoRenew ? "Да" : "Нет"}
            </span>
          )
        ) : (
          <span className="text-text-muted text-[10px]">
            {vm.subscriptionStatus === "active"
              ? "Активна"
              : vm.subscriptionStatus === "expired"
                ? "Истекла"
                : "Не было"}
          </span>
        )}
      </td>

      {/* Expires / Why now */}
      <td className="py-2 px-2 text-text-muted whitespace-nowrap">
        {vm.kind === "subscriber" ? (
          <span>{vm.expiryLabel} <span className="text-text-secondary">({vm.expiryRelativeLabel})</span></span>
        ) : (
          <span>{vm.whyNowLabel}</span>
        )}
      </td>

      {/* Overdue */}
      <td className="py-2 px-2">
        <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${OVERDUE_BADGE[vm.overdueSeverity]}`}>
          {vm.overdueLabel}
        </span>
      </td>

      {/* Last contact */}
      <td className="py-2 px-2 text-text-muted whitespace-nowrap">
        <span title="Последнее сообщение фана">Ф: {vm.lastFanMessageLabel ?? "–"}</span>
        <span className="mx-1 text-border">·</span>
        <span title="Последнее сообщение модели">М: {vm.lastModelMessageLabel ?? "–"}</span>
      </td>

      {/* Actions */}
      <td className="py-2 px-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={isSnoozePending}
            onClick={() => onContacted()}
            className="px-2 py-0.5 text-[10px] font-semibold rounded bg-green/15 text-green hover:bg-green/25 transition-colors disabled:opacity-50"
          >
            {isSnoozePending ? "..." : "Написал"}
          </button>
          <div className="relative">
            <button
              type="button"
              disabled={isSnoozePending}
              onClick={() => setSnoozeOpen(!snoozeOpen)}
              className="px-1.5 py-0.5 text-[10px] font-medium rounded border border-border text-text-muted hover:text-text-secondary hover:bg-hover transition-colors disabled:opacity-50"
            >
              Отложить ▾
            </button>
            {snoozeOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setSnoozeOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[72px]">
                  {([7, 14, 30] as const).map((days) => (
                    <button
                      key={days}
                      type="button"
                      onClick={() => { onSnooze(days); setSnoozeOpen(false); }}
                      className="w-full px-3 py-1 text-left text-[11px] text-text-secondary hover:bg-hover transition-colors"
                    >
                      {days} дн.
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {vm.fanslyExternalUrl && (
            <button
              type="button"
              onClick={handleCopyFanslyLink}
              className="px-1.5 py-0.5 text-[10px] font-medium rounded border border-border text-text-secondary hover:bg-hover transition-colors"
              title={externalLinkTitle}
              aria-label={externalLinkTitle}
            >
              {copied ? "Скопировано!" : externalLinkLabel}
            </button>
          )}
          <Link
            to={vm.profileHref}
            className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent text-white hover:bg-accent/85 transition-colors"
          >
            Профиль
          </Link>
        </div>
      </td>
    </tr>
  );
}
