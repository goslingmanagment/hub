import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { CheckCircle2, MessageSquareDot, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  useWorkboardV2,
  useWorkboardV2Contact,
  useWorkboardV2Recompute,
  useWorkboardV2Snooze,
  useWorkboardV2Unsnooze,
  useWorkboardV2UndoContact,
  type WorkboardV2Tab,
} from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { CapMeter } from "@/components/page/workboard/v2/CapMeter";
import { FocusStrip } from "@/components/page/workboard/v2/FocusStrip";
import { WorkboardV2Row } from "@/components/page/workboard/v2/WorkboardV2Row";
import {
  STATUS_ORDER,
  STATUS_TONES,
  TAB_LABELS,
  type SecondaryStatus,
} from "@/components/page/workboard/v2/tone";
import { buildAiAnalyticsRoute } from "@/lib/navigation";

const TABS: WorkboardV2Tab[] = ["subscribers", "spenders", "fresh_mass", "old_mass", "service"];

// Snooze durations per tab; the first is the smart default (also used by the `s` shortcut).
const SNOOZE_DAYS: Record<WorkboardV2Tab, number[]> = {
  subscribers: [3, 1, 7],
  spenders: [7, 3, 14],
  fresh_mass: [3, 1, 7],
  old_mass: [30, 14, 60],
  service: [14, 7, 30],
};

export function WorkboardV2Page() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const label = pageLabel ?? "";
  const [tab, setTab] = useState<WorkboardV2Tab>("subscribers");
  const [expandedFanId, setExpandedFanId] = useState<number | null>(null);
  const [focusedFanId, setFocusedFanId] = useState<number | null>(null);

  const { data, isLoading, isError } = useWorkboardV2(label, { tab, limit: 100 }, { enabled: Boolean(pageLabel) });
  const contact = useWorkboardV2Contact(label);
  const recompute = useWorkboardV2Recompute(label);
  const snooze = useWorkboardV2Snooze(label);
  const unsnooze = useWorkboardV2Unsnooze(label);
  const undoContact = useWorkboardV2UndoContact(label);

  const counts = data?.counts ?? [];
  const tabCount = useMemo(() => {
    return (target: WorkboardV2Tab, status?: SecondaryStatus) =>
      counts
        .filter((c) => c.tab === target && (status ? c.secondaryStatus === status : true))
        .reduce((sum, c) => sum + c.count, 0);
  }, [counts]);
  const totalNeedReply = useMemo(
    () => counts.filter((c) => c.secondaryStatus === "need_reply").reduce((sum, c) => sum + c.count, 0),
    [counts],
  );

  const sections = useMemo(() => {
    const items = data?.items ?? [];
    return STATUS_ORDER.map((status) => ({
      status,
      items: items.filter((item) => item.secondaryStatus === status),
    })).filter((section) => section.items.length > 0);
  }, [data]);
  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  const onRecompute = () => {
    recompute.mutate(undefined, {
      onSuccess: (r) => toast.success(`Очередь обновлена · ${r.evaluated} фанов`),
      onError: () => toast.error("Не удалось пересчитать очередь"),
    });
  };

  const handleDone = (fanId: number) => {
    contact.mutate(
      { fanId, action: "handled", wasProductive: true },
      {
        onSuccess: () => toast.success("Готово", { action: { label: "Отменить", onClick: () => undoContact.mutate(fanId) } }),
        onError: () => toast.error("Не удалось отметить"),
      },
    );
  };

  const handleSnooze = (fanId: number, days: number) => {
    snooze.mutate(
      { fanId, days },
      {
        onSuccess: () => toast.success(`Отложено на ${days}д`, { action: { label: "Отменить", onClick: () => unsnooze.mutate(fanId) } }),
        onError: () => toast.error("Не удалось отложить"),
      },
    );
  };

  // Keyboard triage (bind once; read latest via ref).
  const kbd = useRef({ flatItems, focusedFanId, tab, handleDone, handleSnooze, setFocusedFanId, setExpandedFanId });
  kbd.current = { flatItems, focusedFanId, tab, handleDone, handleSnooze, setFocusedFanId, setExpandedFanId };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const s = kbd.current;
      if (s.flatItems.length === 0) return;
      const idx = s.flatItems.findIndex((i) => i.fanId === s.focusedFanId);
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        s.setFocusedFanId(s.flatItems[idx < 0 ? 0 : Math.min(idx + 1, s.flatItems.length - 1)]!.fanId);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        s.setFocusedFanId(s.flatItems[idx <= 0 ? 0 : idx - 1]!.fanId);
      } else if (s.focusedFanId != null && event.key === "e") {
        event.preventDefault();
        s.handleDone(s.focusedFanId);
      } else if (s.focusedFanId != null && event.key === "s") {
        event.preventDefault();
        s.handleSnooze(s.focusedFanId, SNOOZE_DAYS[s.tab][0]!);
      } else if (s.focusedFanId != null && event.key === "Enter") {
        event.preventDefault();
        s.setExpandedFanId((prev) => (prev === s.focusedFanId ? null : s.focusedFanId));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Scroll the focused row into view; reset focus when the tab changes.
  useEffect(() => {
    if (focusedFanId != null) {
      document.querySelector(`[data-fan-id="${focusedFanId}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }, [focusedFanId]);
  useEffect(() => {
    setFocusedFanId(null);
    setExpandedFanId(null);
  }, [tab]);

  if (!pageLabel) {
    return null;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Workboard v2</h1>
          <p className="flex items-center gap-2 text-[13px] text-text-secondary">
            <span>@{pageLabel} · приоритетная очередь</span>
            {totalNeedReply > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md bg-accent/12 px-1.5 py-0.5 text-[11px] font-bold text-accent">
                <MessageSquareDot size={11} />
                {totalNeedReply} ждут ответа
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onRecompute}
          disabled={recompute.isPending}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-button border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-hover disabled:opacity-50"
        >
          <RefreshCw size={13} className={recompute.isPending ? "animate-spin" : ""} />
          Пересчитать
        </button>
      </header>

      {data?.aiCoverage && (
        <Link
          to={buildAiAnalyticsRoute(pageLabel)}
          className="mb-3 flex flex-wrap items-center gap-2 rounded-card border border-border bg-card px-3 py-2 text-[12px] transition-colors hover:bg-hover/50"
        >
          <Sparkles size={14} className={data.aiCoverage.enabled ? "text-accent" : "text-text-muted"} />
          <span className="font-semibold text-text-primary">ИИ-детектор ответа</span>
          {data.aiCoverage.enabled ? (
            <span className="text-text-secondary">
              спендеров{" "}
              <b className="tabular-nums text-text-primary">
                {data.aiCoverage.spenderDiagnosed}/{data.aiCoverage.spenderTotal}
              </b>
              {data.aiCoverage.spenderPending > 0 && (
                <>
                  {" "}
                  · ждут ИИ <b className="tabular-nums text-text-primary">{data.aiCoverage.spenderPending}</b>
                </>
              )}
              {" "}
              · вызовов сегодня{" "}
              <b className="tabular-nums text-text-primary">{data.aiCoverage.callsToday}</b>
            </span>
          ) : (
            <span className="text-text-muted">выключен — работает только список L1</span>
          )}
          <span className="ml-auto text-[11px] font-semibold text-accent">Дашборд →</span>
        </Link>
      )}

      <FocusStrip counts={counts} activeTab={tab} onOpen={setTab} />

      {/* Tab bar with per-tab counters */}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((target) => {
          const total = tabCount(target);
          const needReply = tabCount(target, "need_reply");
          const dueNow = tabCount(target, "due_now");
          const active = target === tab;
          return (
            <button
              key={target}
              type="button"
              onClick={() => setTab(target)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors ${
                active
                  ? "border-accent font-semibold text-text-primary"
                  : "border-transparent text-text-secondary hover:bg-hover hover:text-text-primary"
              }`}
            >
              <span>{TAB_LABELS[target]}</span>
              {needReply > 0 && (
                <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-accent">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  {needReply}
                </span>
              )}
              {dueNow > 0 && (
                <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-warning-dark">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning-dark" />
                  {dueNow}
                </span>
              )}
              <span className="text-[11px] tabular-nums text-text-muted">{total}</span>
            </button>
          );
        })}
      </div>

      {tab === "old_mass" && data?.oldMassBudget && (
        <CapMeter used={data.oldMassBudget.used} total={data.oldMassBudget.total} resetsAt={data.oldMassBudget.resetsAt} />
      )}

      {/* Work list */}
      {isLoading && !data ? (
        <StatusPanel title="Загрузка" />
      ) : isError && !data ? (
        <StatusPanel title="Ошибка загрузки" tone="error" />
      ) : sections.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-card border border-border bg-card px-4 py-12 text-center">
          <CheckCircle2 className="mb-2 text-green" size={28} />
          <p className="text-sm font-semibold text-text-primary">На сегодня всё</p>
          <p className="text-[13px] text-text-secondary">В этой вкладке нет задач.</p>
          <button
            type="button"
            onClick={onRecompute}
            disabled={recompute.isPending}
            className="mt-3 inline-flex items-center gap-1.5 rounded-button border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-hover disabled:opacity-50"
          >
            <RefreshCw size={13} className={recompute.isPending ? "animate-spin" : ""} />
            Пересчитать очередь
          </button>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-card border border-border bg-card">
            {sections.map(({ status, items }) => {
              const tone = STATUS_TONES[status];
              const Icon = tone.icon;
              return (
                <section key={status}>
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-hover-alt/80 px-3 py-1.5 backdrop-blur">
                    <Icon size={13} className={tone.pill} />
                    <span className={`text-[11px] font-bold uppercase tracking-wide ${tone.pill}`}>{tone.label}</span>
                    <span className="text-[11px] tabular-nums text-text-muted">{items.length}</span>
                  </div>
                  {items.map((item) => (
                    <WorkboardV2Row
                      key={item.fanId}
                      item={item}
                      expanded={expandedFanId === item.fanId}
                      focused={focusedFanId === item.fanId}
                      snoozeDays={SNOOZE_DAYS[tab]}
                      onToggle={(id) => setExpandedFanId((prev) => (prev === id ? null : id))}
                      onHandled={handleDone}
                      onSnooze={handleSnooze}
                      isHandling={contact.isPending}
                    />
                  ))}
                </section>
              );
            })}
          </div>
          <p className="mt-2 text-center text-[11px] text-text-muted">
            Клавиши: <b>j/k</b> — навигация · <b>e</b> — Готово · <b>s</b> — отложить · <b>Enter</b> — детали
          </p>
        </>
      )}
    </div>
  );
}
