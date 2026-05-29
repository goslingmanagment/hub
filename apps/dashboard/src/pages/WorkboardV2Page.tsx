import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { CheckCircle2, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  useWorkboardV2,
  useWorkboardV2Contact,
  useWorkboardV2Recompute,
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

const TABS: WorkboardV2Tab[] = ["subscribers", "spenders", "fresh_mass", "old_mass", "service"];

export function WorkboardV2Page() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const [tab, setTab] = useState<WorkboardV2Tab>("subscribers");
  const [expandedFanId, setExpandedFanId] = useState<number | null>(null);

  const { data, isLoading, isError } = useWorkboardV2(pageLabel ?? "", { tab, limit: 100 }, {
    enabled: Boolean(pageLabel),
  });
  const contact = useWorkboardV2Contact(pageLabel ?? "");
  const recompute = useWorkboardV2Recompute(pageLabel ?? "");

  const onRecompute = () => {
    recompute.mutate(undefined, {
      onSuccess: (r) => toast.success(`Очередь обновлена · ${r.evaluated} фанов`),
      onError: () => toast.error("Не удалось пересчитать очередь"),
    });
  };

  const counts = data?.counts ?? [];
  const tabCount = useMemo(() => {
    return (target: WorkboardV2Tab, status?: SecondaryStatus) =>
      counts
        .filter((c) => c.tab === target && (status ? c.secondaryStatus === status : true))
        .reduce((sum, c) => sum + c.count, 0);
  }, [counts]);

  const sections = useMemo(() => {
    const items = data?.items ?? [];
    return STATUS_ORDER.map((status) => ({
      status,
      items: items.filter((item) => item.secondaryStatus === status),
    })).filter((section) => section.items.length > 0);
  }, [data]);

  const handleDone = (fanId: number) => {
    contact.mutate(
      { fanId, action: "handled", wasProductive: true },
      {
        onSuccess: () => toast.success("Готово"),
        onError: () => toast.error("Не удалось отметить"),
      },
    );
  };

  if (!pageLabel) {
    return null;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Workboard v2</h1>
          <p className="text-[13px] text-text-secondary">@{pageLabel} · приоритетная очередь</p>
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
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-card border border-border bg-card px-3 py-2 text-[12px]">
          <Sparkles size={14} className={data.aiCoverage.enabled ? "text-accent" : "text-text-muted"} />
          <span className="font-semibold text-text-primary">ИИ-детектор ответа</span>
          {data.aiCoverage.enabled ? (
            <span className="text-text-secondary">
              проверено <b className="tabular-nums text-text-primary">{data.aiCoverage.classified}</b> · из них закрывающих{" "}
              <b className="tabular-nums text-text-primary">{data.aiCoverage.closingsFound}</b> (убраны из «Ответить») · вызовов сегодня{" "}
              <b className="tabular-nums text-text-primary">{data.aiCoverage.callsToday}</b>
            </span>
          ) : (
            <span className="text-text-muted">выключен — работает только список L1</span>
          )}
        </div>
      )}

      <FocusStrip counts={data?.counts ?? []} activeTab={tab} onOpen={setTab} />

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
                    onToggle={(id) => setExpandedFanId((prev) => (prev === id ? null : id))}
                    onHandled={handleDone}
                    isHandling={contact.isPending}
                  />
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
