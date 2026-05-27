import { useState, type MouseEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ChatPreviewPanel } from "@/components/shared/ChatPreviewPanel";
import { TouchpointBadge } from "@/components/shared/TouchpointBadge";
import type { WorkboardCardVm } from "@/pages/workboard/viewModel";
import { OVERDUE_BADGE, OVERDUE_BG } from "@/pages/workboard/theme";

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

interface ActionButtonsProps {
  onContacted: () => void;
  onSnooze: (days: number) => void;
  isPending: boolean;
}

function ActionButtons({ onContacted, onSnooze, isPending }: ActionButtonsProps) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={isPending}
        onClick={(e) => { e.stopPropagation(); onContacted(); }}
        className="px-2.5 py-0.5 text-[11px] font-semibold rounded bg-green/15 text-green hover:bg-green/25 transition-colors disabled:opacity-50"
      >
        {isPending ? "Сохраняю..." : "Написал"}
      </button>
      <div className="relative">
        <button
          type="button"
          disabled={isPending}
          onClick={(e) => { e.stopPropagation(); setSnoozeOpen(!snoozeOpen); }}
          className="px-2 py-0.5 text-[11px] font-medium rounded border border-border text-text-muted hover:text-text-secondary hover:bg-hover transition-colors disabled:opacity-50"
        >
          Отложить ▾
        </button>
        {snoozeOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setSnoozeOpen(false); }} />
            <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[80px]">
              {([7, 14, 30] as const).map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onSnooze(days); setSnoozeOpen(false); }}
                  className="w-full px-3 py-1.5 text-left text-[12px] text-text-secondary hover:bg-hover transition-colors"
                >
                  {days} дн.
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Card ─────────────────────────────────────────────────────────── */

interface WorkboardCardProps {
  vm: WorkboardCardVm;
  pageLabel: string;
  isExpanded: boolean;
  onToggle: () => void;
  onContacted: () => void;
  onSnooze: (days: number) => void;
  isSnoozePending: boolean;
}

export function WorkboardCard({
  vm, pageLabel, isExpanded, onToggle, onContacted, onSnooze, isSnoozePending,
}: WorkboardCardProps) {
  const [copied, setCopied] = useState(false);
  const platformConversationId = vm.platformConversationId;
  const canPreview = vm.canPreview && platformConversationId !== null;
  const externalLinkLabel = vm.fanslyExternalKind === "chat" ? "Скопировать чат" : "Скопировать профиль";
  const externalLinkTitle = vm.fanslyExternalKind === "chat"
    ? "Скопировать ссылку на чат Fansly"
    : "Скопировать ссылку на профиль Fansly";

  async function handleCopyFanslyLink(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();

    if (!vm.fanslyExternalUrl) {
      return;
    }

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
              <span title={`До истечения подписки: ${vm.touchpointLabel}`}>
                <TouchpointBadge touchpointCode={vm.touchpointCode} touchpointLabel={vm.touchpointLabel} />
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
            <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${OVERDUE_BADGE[vm.overdueSeverity]}`}>
              {vm.overdueLabel}
            </span>
            <span className="text-[12px] text-text-muted">LTV</span>
            <span className="text-sm font-semibold text-text-primary tabular-nums">{vm.ltvLabel}</span>
          </div>
        </div>

        {/* Row 2: Communication + spend */}
        <div className="mt-1.5 text-[13px] text-text-muted">
          <span className="font-semibold text-text-primary">{vm.whyNowLabel}</span>
          <span className="mx-1.5 text-border">·</span>
          Фан: <span className="font-semibold text-text-secondary">{vm.lastFanMessageLabel ?? "никогда"}</span>
          <span className="mx-1.5 text-border">·</span>
          Модель: <span className="font-semibold text-text-secondary">{vm.lastModelMessageLabel ?? "никогда"}</span>
          <span className="mx-1.5 text-border">·</span>
          Траты: <span className="font-semibold text-text-secondary">{vm.lastTransactionLabel ?? "никогда"}</span>
        </div>

        {/* Row 3: Subscription details + actions */}
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <div className="text-[12px] text-text-muted flex items-center gap-1.5 min-w-0">
            {vm.kind === "subscriber" ? (
              <>
                <span>
                  Истекает {vm.expiryLabel}
                  <span className="ml-1 text-text-secondary">({vm.expiryRelativeLabel})</span>
                </span>
                {vm.autoRenew !== null && (
                  <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ${vm.autoRenew ? "bg-green/10 text-green" : "bg-warning/10 text-warning"}`}>
                    {vm.autoRenew ? "Автопродление" : "Отключил продление"}
                  </span>
                )}
                {vm.autoRenew === false && vm.autoRenewOffDetectedLabel && (
                  <span className="text-warning-dark">
                    замечено {vm.autoRenewOffDetectedLabel}
                  </span>
                )}
              </>
            ) : (
              <span>
                {vm.subscriptionStatus === "active"
                  ? `Подписка активна${vm.subscriptionExpiresLabel ? ` до ${vm.subscriptionExpiresLabel}` : ""}`
                  : vm.subscriptionStatus === "expired"
                    ? `Подписка истекла${vm.subscriptionExpiresLabel ? ` (${vm.subscriptionExpiresLabel})` : ""}`
                    : "Не подписывался"}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <ActionButtons onContacted={onContacted} onSnooze={onSnooze} isPending={isSnoozePending} />
            {vm.fanslyExternalUrl && (
              <button
                type="button"
                onClick={handleCopyFanslyLink}
                className="px-3 py-0.5 text-[11px] font-semibold rounded border border-border text-text-secondary hover:bg-hover transition-colors"
                title={externalLinkTitle}
                aria-label={externalLinkTitle}
              >
                {copied ? "Скопировано!" : externalLinkLabel}
              </button>
            )}
            <Link
              to={vm.profileHref}
              onClick={(e) => e.stopPropagation()}
              className="ml-2 px-3 py-0.5 text-[11px] font-semibold rounded bg-accent text-white hover:bg-accent/85 transition-colors"
            >
              Профиль
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
