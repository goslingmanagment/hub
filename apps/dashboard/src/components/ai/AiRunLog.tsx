import { useMemo, useState } from "react";
import type { WorkboardV2AiRun } from "@agency_hub_core/contracts";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { fmtNum, fmtUsd } from "./AiPageDashboard";

const TRIGGER_META: Record<string, { label: string; className: string }> = {
  cron: { label: "Cron", className: "bg-fansly/15 text-fansly" },
  manual: { label: "Вручную", className: "bg-accent/15 text-accent" },
  reclassify: { label: "Переклассиф.", className: "bg-warning/15 text-warning-dark" },
};

type TriggerFilter = "all" | "cron" | "manual" | "reclassify";

function triggerMeta(t: string) {
  return TRIGGER_META[t] ?? { label: t, className: "bg-hover text-text-muted" };
}

function timeAgo(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}с назад`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ч назад`;
  return `${Math.round(hr / 24)} дн назад`;
}

function absTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function RunRow({ run }: { run: WorkboardV2AiRun }) {
  const t = triggerMeta(run.trigger);
  const running = run.status === "running";
  return (
    <div className={`flex items-start gap-3 border-b border-border px-3 py-2 text-[12px] last:border-b-0 hover:bg-hover/40 ${running ? "bg-accent/[0.04]" : ""}`}>
      <span className="w-[92px] shrink-0 text-text-muted" title={absTime(run.createdAt)}>
        {timeAgo(run.createdAt)}
      </span>
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${t.className}`}>{t.label}</span>
      <span className="w-[120px] shrink-0 truncate font-medium text-text-primary" title={run.pageLabel ?? ""}>
        {run.pageLabel ?? "—"}
      </span>
      <div className="min-w-0 flex-1 text-text-secondary">
        {running ? (
          <span className="inline-flex items-center gap-1.5 font-semibold text-accent">
            <Loader2 size={12} className="animate-spin" />
            выполняется…
          </span>
        ) : (
          <span className="tabular-nums">
            классиф. <b className="text-text-primary">{fmtNum(run.classified)}</b> · вызовов{" "}
            <b className="text-text-primary">{fmtNum(run.calls)}</b> · <b className="text-text-primary">{fmtUsd(run.costUsd)}</b>
            {" · "}токены {fmtNum(run.inputTokens)}/{fmtNum(run.outputTokens)}
            {run.deferred > 0 && <> · отложено {fmtNum(run.deferred)}</>}
            {run.cleared > 0 && <> · очищено {fmtNum(run.cleared)}</>}
          </span>
        )}
        {run.model && <span className="ml-1 text-text-muted">· {run.model.replace(/^claude-/, "")}</span>}
        {run.status === "error" && (
          <span className="ml-1 inline-flex items-center gap-1 text-danger">
            <AlertTriangle size={11} />
            {run.error ?? "ошибка"}
          </span>
        )}
      </div>
    </div>
  );
}

export function AiRunLog({
  runs,
  isLoading,
  isFetching,
  onRefresh,
}: {
  runs: WorkboardV2AiRun[];
  isLoading: boolean;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const [trigger, setTrigger] = useState<TriggerFilter>("all");
  const [page, setPage] = useState<string>("all");

  const pages = useMemo(() => {
    const set = new Set<string>();
    for (const r of runs) if (r.pageLabel) set.add(r.pageLabel);
    return [...set].sort();
  }, [runs]);

  const filtered = runs.filter(
    (r) => (trigger === "all" || r.trigger === trigger) && (page === "all" || r.pageLabel === page),
  );
  const liveCount = runs.filter((r) => r.status === "running").length;

  const triggers: { key: TriggerFilter; label: string }[] = [
    { key: "all", label: "Все" },
    { key: "cron", label: "Cron" },
    { key: "manual", label: "Вручную" },
    { key: "reclassify", label: "Переклассиф." },
  ];

  return (
    <div className="rounded-card border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-text-primary">
          <span className={`h-1.5 w-1.5 rounded-full ${isFetching || liveCount > 0 ? "animate-pulse bg-green" : "bg-text-muted"}`} />
          Журнал запусков классификатора
        </span>
        <span className="text-[11px] text-text-muted">
          {filtered.length} записей{liveCount > 0 && ` · ${liveCount} выполняется`}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            {triggers.map((tt) => (
              <button
                key={tt.key}
                type="button"
                onClick={() => setTrigger(tt.key)}
                className={`px-2 py-1 text-[11px] transition-colors ${
                  trigger === tt.key ? "bg-accent/15 font-semibold text-accent" : "bg-card text-text-secondary hover:bg-hover"
                }`}
              >
                {tt.label}
              </button>
            ))}
          </div>
          {pages.length > 1 && (
            <select
              value={page}
              onChange={(e) => setPage(e.target.value)}
              className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-text-secondary"
            >
              <option value="all">Все страницы</option>
              {pages.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1 rounded-button border border-border px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-hover"
          >
            <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
            Обновить
          </button>
        </div>
      </div>

      <div className="max-h-[460px] overflow-y-auto">
        {isLoading ? (
          <div className="py-10 text-center text-[12px] text-text-muted">Загрузка…</div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-text-muted">
            Пока нет запусков. Нажмите «Классифицировать сейчас» или дождитесь ночного прогона (03:00 UTC).
          </div>
        ) : (
          filtered.map((r) => <RunRow key={r.id} run={r} />)
        )}
      </div>
    </div>
  );
}
