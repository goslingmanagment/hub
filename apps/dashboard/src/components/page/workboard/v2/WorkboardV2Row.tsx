import type { WorkboardV2Item } from "@agency_hub_core/contracts";
import { Check } from "lucide-react";

import { formatMills } from "@/lib/format";

import { QuadrantGlyph } from "./QuadrantGlyph";
import {
  closingVerdictLabel,
  coverageTone,
  qualityLabel,
  reasonTone,
  urgencyRailClass,
  valueTierTone,
  whyNowLabel,
  type UrgencySeverity,
  type ValueTier,
} from "./tone";

const MAX_CHIPS = 3;

function fanName(item: WorkboardV2Item): string {
  return item.fan.displayName || item.fan.username || item.fan.pageAlias || `#${item.fanId}`;
}

function Chip({ label, icon: Icon, className }: { label: string; icon: React.ComponentType<{ size?: number }>; className: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${className}`}>
      <Icon size={11} />
      {label}
    </span>
  );
}

function CoverageDots({ filled }: { filled: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={`h-1.5 w-1.5 rounded-full ${i < filled ? "bg-current" : "bg-border"}`} />
      ))}
    </span>
  );
}

function ExpandedPanel({ item }: { item: WorkboardV2Item }) {
  const ql = qualityLabel(item.quality.qScore);
  const cov = coverageTone(item.conversation.coverageStatus);
  const verdict = closingVerdictLabel(item.closingVerdict);
  return (
    <div className="grid grid-cols-1 gap-3 border-b border-border bg-hover-alt/40 px-4 py-3 text-[12px] sm:grid-cols-3">
      <div>
        <div className="mb-0.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">Почему сейчас</div>
        <div className="text-text-primary">{whyNowLabel(item.whyNow.code, item.whyNow.value)}</div>
        {item.serviceReason && <div className="mt-0.5 text-text-muted">Сервис: {item.serviceReason}</div>}
      </div>
      <div>
        <div className="mb-0.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">Диалог</div>
        <div className={ql.className}>
          {ql.label}
          {item.quality.qScore != null && ` · Q ${item.quality.qScore.toFixed(2)}`}
        </div>
        <div className={`mt-1 inline-flex items-center gap-1.5 ${cov.className}`}>
          <CoverageDots filled={cov.filled} />
          <span className="text-text-muted">{cov.label}</span>
        </div>
      </div>
      <div>
        <div className="mb-0.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">Детектор ответа</div>
        {verdict ? (
          <div className={verdict.className}>{verdict.label}</div>
        ) : (
          <div className="text-text-muted">—</div>
        )}
        {item.conversation.preview && (
          <div className="mt-0.5 truncate text-text-muted">«{item.conversation.preview}»</div>
        )}
        <div className="mt-0.5 text-text-secondary">
          LTV {formatMills(item.ltv.creatorNetAmountMills)}
          {item.subscription.autoRenew === false && " · автопродление выкл"}
        </div>
      </div>
    </div>
  );
}

export function WorkboardV2Row({
  item,
  expanded,
  onToggle,
  onHandled,
  isHandling,
}: {
  item: WorkboardV2Item;
  expanded: boolean;
  onToggle: (fanId: number) => void;
  onHandled: (fanId: number) => void;
  isHandling: boolean;
}) {
  const rail = urgencyRailClass(item.urgency.severity as UrgencySeverity);
  const valueChip = valueTierTone(item.value.tier as ValueTier);
  const purchaseWash = item.isPurchaseFollowup ? "bg-accent/[0.04]" : "";

  const chips = item.reasonChips
    .map((code) => ({ code, tone: reasonTone(code) }))
    .filter((c): c is { code: string; tone: NonNullable<ReturnType<typeof reasonTone>> } => c.tone != null);
  const shownChips = chips.slice(0, MAX_CHIPS);
  const overflow = chips.length - shownChips.length;

  return (
    <div className={`border-l-[3px] ${rail} border-b border-border ${purchaseWash}`}>
      <div className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-hover/50">
        <QuadrantGlyph
          value={item.value.score}
          urgency={item.urgency.score}
          severity={item.urgency.severity as UrgencySeverity}
          tier={item.value.tier as ValueTier}
          estimated={item.value.confidence === "low"}
        />
        <button type="button" onClick={() => onToggle(item.fanId)} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="max-w-[180px] truncate text-[13px] font-medium text-text-primary">{fanName(item)}</span>
            {valueChip && <Chip label={valueChip.label} icon={valueChip.icon} className={valueChip.className} />}
            {shownChips.map(({ code, tone }) => (
              <Chip key={code} label={tone.label} icon={tone.icon} className={tone.className} />
            ))}
            {overflow > 0 && (
              <span className="rounded-md bg-hover px-1.5 py-0.5 text-[10px] font-bold text-text-muted">+{overflow}</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-text-secondary">
            {whyNowLabel(item.whyNow.code, item.whyNow.value)}
          </div>
        </button>

        <div className="shrink-0 text-right text-[12px] font-semibold tabular-nums text-text-secondary">
          {formatMills(item.ltv.creatorNetAmountMills)}
        </div>

        <button
          type="button"
          onClick={() => onHandled(item.fanId)}
          disabled={isHandling}
          className="inline-flex shrink-0 items-center gap-1 rounded-button bg-green/15 px-2.5 py-1 text-[11px] font-semibold text-green transition-colors hover:bg-green/25 disabled:opacity-50"
        >
          <Check size={13} />
          Готово
        </button>
      </div>
      {expanded && <ExpandedPanel item={item} />}
    </div>
  );
}
