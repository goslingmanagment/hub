import { Link } from "react-router";
import { TouchpointBadge } from "@/components/page/crm/TouchpointBadge";
import { ChatPreviewPanel } from "@/components/page/crm/ChatPreviewPanel";
import type { WorkboardSubscriberVm, WorkboardSpenderVm } from "@/pages/workboard/viewModel";
import { OVERDUE_BG } from "@/pages/workboard/viewModel";

interface SnoozeButtonsProps {
  onSnooze: (days: number) => void;
  isPending: boolean;
}

function SnoozeButtons({ onSnooze, isPending }: SnoozeButtonsProps) {
  return (
    <div className="flex items-center gap-1.5">
      {[7, 14, 30].map((days) => (
        <button
          key={days}
          type="button"
          disabled={isPending}
          onClick={(e) => { e.stopPropagation(); onSnooze(days); }}
          className="px-2 py-1 text-[11px] font-medium rounded border border-border text-text-muted hover:text-text-secondary hover:bg-hover transition-colors disabled:opacity-50"
        >
          {days}d
        </button>
      ))}
    </div>
  );
}

interface SubscriberCardProps {
  vm: WorkboardSubscriberVm;
  pageLabel: string;
  isExpanded: boolean;
  onToggle: () => void;
  onSnooze: (days: number) => void;
  isSnoozePending: boolean;
}

export function SubscriberCard({
  vm, pageLabel, isExpanded, onToggle, onSnooze, isSnoozePending,
}: SubscriberCardProps) {
  return (
    <div>
      <div
        onClick={onToggle}
        className={`${OVERDUE_BG[vm.overdueSeverity]} border border-border rounded-lg p-4 cursor-pointer hover:border-accent/40 transition-colors`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <TouchpointBadge touchpointCode={vm.touchpointCode} touchpointLabel={vm.touchpointCode} />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-text-primary truncate">{vm.fanLabel}</div>
              {vm.fanSubLabel && (
                <div className="text-[12px] text-text-muted truncate">{vm.fanSubLabel}</div>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-semibold text-text-primary">{vm.ltvLabel}</div>
            {vm.overdueDays > 0 && (
              <div className={`text-[11px] font-bold ${vm.overdueSeverity === "red" ? "text-red-400" : vm.overdueSeverity === "yellow" ? "text-yellow-400" : "text-text-muted"}`}>
                overdue {vm.overdueDays}d
              </div>
            )}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] text-text-muted">
          <div>Fan msg: {vm.lastFanMessageLabel ?? "never"}</div>
          <div>Model msg: {vm.lastModelMessageLabel ?? "never"}</div>
          <div>Last spend: {vm.lastTransactionLabel ?? "never"}</div>
          <div>
            Expires: {vm.expiryLabel}
            {vm.autoRenew !== null && (
              <span className={vm.autoRenew ? "text-green" : "text-warning"}>
                {" "}· Auto-renew: {vm.autoRenew ? "On" : "Off"}
              </span>
            )}
          </div>
          {vm.tierName && <div>Tier: {vm.tierName}</div>}
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <SnoozeButtons onSnooze={onSnooze} isPending={isSnoozePending} />
          <Link
            to={vm.profileHref}
            onClick={(e) => e.stopPropagation()}
            className="px-2 py-1 text-[11px] font-medium rounded border border-border text-accent hover:bg-hover transition-colors"
          >
            Chat
          </Link>
        </div>
      </div>

      {isExpanded && vm.canPreview && vm.platformConversationId && (
        <div className="mt-1 rounded-lg overflow-hidden border border-border">
          <ChatPreviewPanel
            pageLabel={pageLabel}
            platformConversationId={vm.platformConversationId}
            profileHref={vm.profileHref}
            limit={25}
          />
        </div>
      )}
    </div>
  );
}

interface SpenderCardProps {
  vm: WorkboardSpenderVm;
  pageLabel: string;
  isExpanded: boolean;
  onToggle: () => void;
  onSnooze: (days: number) => void;
  isSnoozePending: boolean;
}

export function SpenderCard({
  vm, pageLabel, isExpanded, onToggle, onSnooze, isSnoozePending,
}: SpenderCardProps) {
  return (
    <div>
      <div
        onClick={onToggle}
        className={`${OVERDUE_BG[vm.overdueSeverity]} border border-border rounded-lg p-4 cursor-pointer hover:border-accent/40 transition-colors`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary truncate">{vm.fanLabel}</div>
            {vm.fanSubLabel && (
              <div className="text-[12px] text-text-muted truncate">{vm.fanSubLabel}</div>
            )}
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-semibold text-text-primary">{vm.ltvLabel}</div>
            {vm.overdueDays > 0 && (
              <div className={`text-[11px] font-bold ${vm.overdueSeverity === "red" ? "text-red-400" : vm.overdueSeverity === "yellow" ? "text-yellow-400" : "text-text-muted"}`}>
                overdue {vm.overdueDays}d
              </div>
            )}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] text-text-muted">
          <div>Fan msg: {vm.lastFanMessageLabel ?? "never"}</div>
          <div>Model msg: {vm.lastModelMessageLabel ?? "never"}</div>
          <div>Last spend: {vm.lastTransactionLabel ?? "never"}</div>
          <div>
            Sub: {vm.subscriptionStatus === "expired"
              ? `Expired${vm.subscriptionExpiresLabel ? ` (${vm.subscriptionExpiresLabel})` : ""}`
              : "Never subscribed"}
          </div>
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <SnoozeButtons onSnooze={onSnooze} isPending={isSnoozePending} />
          <Link
            to={vm.profileHref}
            onClick={(e) => e.stopPropagation()}
            className="px-2 py-1 text-[11px] font-medium rounded border border-border text-accent hover:bg-hover transition-colors"
          >
            Chat
          </Link>
        </div>
      </div>

      {isExpanded && vm.canPreview && vm.platformConversationId && (
        <div className="mt-1 rounded-lg overflow-hidden border border-border">
          <ChatPreviewPanel
            pageLabel={pageLabel}
            platformConversationId={vm.platformConversationId}
            profileHref={vm.profileHref}
            limit={25}
          />
        </div>
      )}
    </div>
  );
}
