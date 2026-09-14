import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { WorkboardV2Item } from "@agency_hub_core/contracts";
import { Check, MessageSquare, MoonStar } from "lucide-react";

import { usePageConversationPreview } from "@/api/queries";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { formatMills } from "@/lib/format";

import { QuadrantGlyph } from "./QuadrantGlyph.js";
import {
  closingVerdictLabel,
  coverageTone,
  lastContactLabel,
  ruAgo,
  ruAgoCompact,
  qualityLabel,
  reasonTone,
  urgencyRailClass,
  valueTierTone,
  whyNowLabel,
  type UrgencySeverity,
  type ValueTier,
} from "./tone.js";

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

// When the full message history isn't synced into the workboard, still surface the
// timing that matters — when the fan last wrote and when we last replied — plus the
// last known message snippet from the thread.
function ConversationFallback({ item }: { item: WorkboardV2Item }) {
  const fan = item.conversation.lastFanMessageAt;
  const model = item.conversation.lastModelMessageAt;
  const preview = item.conversation.preview;
  if (!fan && !model && !preview) {
    return <div className="text-text-muted">Сохранённая переписка недоступна.</div>;
  }
  const fanLast = (fan ? new Date(fan).getTime() : 0) >= (model ? new Date(model).getTime() : 0);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-text-secondary">
        <span>
          Фан писал: <b className={fan ? "text-text-primary" : "text-text-muted"}>{fan ? ruAgo(fan) : "—"}</b>
        </span>
        <span>
          Вы писали: <b className={model ? "text-text-primary" : "text-text-muted"}>{model ? ruAgo(model) : "—"}</b>
        </span>
      </div>
      {preview && (
        <div className="text-text-muted">
          Последнее ({fanLast ? "фан" : "вы"}): «{preview}»
        </div>
      )}
    </div>
  );
}

function ConversationPreview({ pageLabel, item }: { pageLabel: string; item: WorkboardV2Item }) {
  const convId = item.conversation.platformConversationId;
  const { data, isLoading, isError, refetch } = usePageConversationPreview(pageLabel, convId, { limit: 10 });
  const messages = [...(data?.messages ?? [])].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  if (convId && isLoading && !data) {
    return <div className="text-text-muted">Загрузка переписки…</div>;
  }
  // No synced messages (or no conversation id) → fall back to the thread's denormalized timing.
  if (messages.length === 0) {
    return <><QueryNotice error={isError} stale={Boolean(data)} retry={refetch} /><ConversationFallback item={item} /></>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <QueryNotice error={isError} stale={Boolean(data)} retry={refetch} />
      {messages.map((m) => {
        const mine = m.senderRole === "model";
        return (
          <div key={m.platformMessageId} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
            <div
              className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 ${
                mine ? "rounded-br-sm bg-accent text-white" : "rounded-bl-sm bg-hover text-text-primary"
              }`}
            >
              {m.content ? m.content : <span className="italic opacity-70">[вложение]</span>}
            </div>
            <span className="mt-0.5 text-[10px] text-text-muted">
              {mine ? "Вы" : "Фан"} · {ruAgoCompact(m.createdAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Hover to reveal a floating card (portaled, so the list's overflow-hidden doesn't
// clip it). A short close grace lets the cursor cross the gap into the card to read/scroll.
function ChatHoverCard({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const show = () => {
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 560;
      setCoords({ x: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), y: rect.bottom + 4 });
    }
    setOpen(true);
  };
  const scheduleHide = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  };

  return (
    <>
      <span ref={triggerRef} onMouseEnter={show} onMouseLeave={scheduleHide} className="inline-flex">
        {trigger}
      </span>
      {open &&
        createPortal(
          <div
            className="fixed z-[100]"
            style={{ left: coords.x, top: coords.y }}
            onMouseEnter={show}
            onMouseLeave={scheduleHide}
          >
            <div className="max-h-[420px] w-[560px] max-w-[92vw] overflow-y-auto rounded-card border border-border bg-card p-3 text-[12px] shadow-xl">
              {children}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function ExpandedPanel({ item, pageLabel, showConversation }: { item: WorkboardV2Item; pageLabel: string; showConversation: boolean }) {
  const ql = qualityLabel(item.quality.qScore);
  const cov = coverageTone(item.conversation.coverageStatus);
  const verdict = closingVerdictLabel(item.closingVerdict);
  return (
    <div className="border-b border-border bg-hover-alt/40">
      <div className="grid grid-cols-1 gap-3 px-4 py-3 text-[12px] sm:grid-cols-3">
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
          {item.closingVerdict?.reason && (
            <div className="mt-0.5 italic text-text-muted">ИИ: {item.closingVerdict.reason}</div>
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
      {showConversation && (
        <div className="border-t border-border px-4 py-2 text-[12px]">
          <ChatHoverCard
            trigger={
              <span className="inline-flex cursor-default items-center gap-1.5 rounded-button border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-text-secondary transition-colors hover:bg-hover hover:text-text-primary">
                <MessageSquare size={12} />
                Переписка
              </span>
            }
          >
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">Последние сообщения</div>
            <ConversationPreview pageLabel={pageLabel} item={item} />
          </ChatHoverCard>
        </div>
      )}
    </div>
  );
}

export function WorkboardV2Row({
  item,
  pageLabel,
  expanded,
  focused,
  snoozeDays,
  secondaryVariant = "whyNow",
  showConversation = false,
  onToggle,
  onHandled,
  onSnooze,
  isHandling,
}: {
  item: WorkboardV2Item;
  pageLabel: string;
  expanded: boolean;
  focused: boolean;
  snoozeDays: number[];
  secondaryVariant?: "whyNow" | "lastContact";
  showConversation?: boolean;
  onToggle: (fanId: number) => void;
  onHandled: (fanId: number) => void;
  onSnooze: (fanId: number, days: number) => void;
  isHandling: boolean;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const rail = urgencyRailClass(item.urgency.severity as UrgencySeverity);
  const valueChip = valueTierTone(item.value.tier as ValueTier);
  const purchaseWash = item.isPurchaseFollowup ? "bg-accent/[0.04]" : "";
  const focusRing = focused ? "bg-active-bg ring-1 ring-inset ring-accent/40" : "";

  const chips = item.reasonChips
    .map((code) => ({ code, tone: reasonTone(code) }))
    .filter((c): c is { code: string; tone: NonNullable<ReturnType<typeof reasonTone>> } => c.tone != null);
  const shownChips = chips.slice(0, MAX_CHIPS);
  const overflow = chips.length - shownChips.length;

  return (
    <div data-fan-id={item.fanId} className={`border-l-[3px] ${rail} border-b border-border ${purchaseWash} ${focusRing}`}>
      <div className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-hover/50">
        <QuadrantGlyph
          value={item.value.score}
          urgency={item.urgency.score}
          severity={item.urgency.severity as UrgencySeverity}
          tier={item.value.tier as ValueTier}
          estimated={item.value.confidence === "low"}
        />
        <button type="button" onClick={() => onToggle(item.fanId)} aria-expanded={expanded} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="max-w-[180px] truncate text-[13px] font-medium text-text-primary">{fanName(item)}</span>
            {item.online && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-green">
                <span className="h-1.5 w-1.5 rounded-full bg-green" />онлайн
              </span>
            )}
            {valueChip && <Chip label={valueChip.label} icon={valueChip.icon} className={valueChip.className} />}
            {shownChips.map(({ code, tone }) => (
              <Chip key={code} label={tone.label} icon={tone.icon} className={tone.className} />
            ))}
            {overflow > 0 && (
              <span className="rounded-md bg-hover px-1.5 py-0.5 text-[10px] font-bold text-text-muted">+{overflow}</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-text-secondary">
            {secondaryVariant === "lastContact"
              ? lastContactLabel(item.conversation)
              : whyNowLabel(item.whyNow.code, item.whyNow.value)}
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

        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setSnoozeOpen((open) => !open)}
            disabled={isHandling}
            className="inline-flex items-center gap-0.5 rounded-button border border-border px-1.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-hover"
            aria-label="Отложить"
          >
            <MoonStar size={13} />▾
          </button>
          {snoozeOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setSnoozeOpen(false)} />
              <div className="absolute right-0 z-20 mt-1 overflow-hidden rounded-md border border-border bg-card shadow-lg">
                {snoozeDays.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    disabled={isHandling}
                    onClick={() => {
                      setSnoozeOpen(false);
                      onSnooze(item.fanId, d);
                    }}
                    className={`block w-full whitespace-nowrap px-3 py-1.5 text-left text-[12px] hover:bg-hover ${i === 0 ? "font-semibold text-text-primary" : "text-text-secondary"}`}
                  >
                    Отложить {d}д
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {expanded && <ExpandedPanel item={item} pageLabel={pageLabel} showConversation={showConversation} />}
    </div>
  );
}
