import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, RefreshCcw } from "lucide-react";
import { toast } from "sonner";

import { useWorkboardV2Ai, useWorkboardV2AiClassify, useWorkboardV2AiSettings } from "@/api/workboard";

type AiReport = NonNullable<ReturnType<typeof useWorkboardV2Ai>["data"]>;
type EnabledChoice = "inherit" | "on" | "off";

const STATE_META: Record<string, { label: string; bar: string; dot: string }> = {
  buy_signal: { label: "Готов купить", bar: "bg-accent", dot: "bg-accent" },
  question: { label: "Вопрос", bar: "bg-fansly", dot: "bg-fansly" },
  complaint: { label: "Жалоба", bar: "bg-warning-dark", dot: "bg-warning-dark" },
  smalltalk: { label: "Болтовня", bar: "bg-text-secondary", dot: "bg-text-secondary" },
  cold: { label: "Остыл", bar: "bg-text-muted", dot: "bg-text-muted" },
  closing: { label: "Закрытие", bar: "bg-border", dot: "bg-text-muted/50" },
  model_last: { label: "Модель ответила", bar: "bg-green", dot: "bg-green" },
  unknown_sender: { label: "Неясный автор", bar: "bg-warning-dark", dot: "bg-warning-dark" },
  no_visible_dialog: { label: "Нет видимого диалога", bar: "bg-border", dot: "bg-border" },
  missing_message_id: { label: "Нет id сообщения", bar: "bg-border", dot: "bg-border" },
  pending_ai: { label: "Ждёт ИИ", bar: "bg-warning", dot: "bg-warning" },
  "(unset)": { label: "Без состояния (старое)", bar: "bg-border", dot: "bg-border" },
};

function stateMeta(state: string) {
  return STATE_META[state] ?? { label: state, bar: "bg-border", dot: "bg-border" };
}

function finiteNumber(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function fmtUsd(v: number | null | undefined): string {
  const amount = finiteNumber(v);
  if (amount == null) return "—";
  if (amount === 0) return "$0";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

export function fmtNum(n: number | null | undefined): string {
  const amount = finiteNumber(n);
  return amount == null ? "—" : amount.toLocaleString("ru-RU");
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-hover-alt/30 px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wide text-text-muted">{label}</div>
      <div className="text-[15px] font-semibold tabular-nums text-text-primary">{value}</div>
      {hint && <div className="text-[10px] text-text-muted">{hint}</div>}
    </div>
  );
}

function StateDistribution({ states }: { states: AiReport["states"] }) {
  const total = states.reduce((a, s) => a + (finiteNumber(s.count) ?? 0), 0);
  if (total === 0) {
    return <div className="text-[12px] text-text-muted">Пока нет классифицированных диалогов.</div>;
  }
  const max = Math.max(...states.map((s) => finiteNumber(s.count) ?? 0), 1);
  return (
    <div className="space-y-1.5">
      {states.map((s) => {
        const m = stateMeta(s.state);
        const count = finiteNumber(s.count) ?? 0;
        return (
          <div key={s.state} className="flex items-center gap-2 text-[12px]">
            <span className="w-[150px] shrink-0 truncate text-text-secondary">{m.label}</span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-hover">
              <div className={`h-full rounded-full ${m.bar}`} style={{ width: `${Math.round((count / max) * 100)}%` }} />
            </div>
            <span className="w-12 shrink-0 text-right font-semibold tabular-nums text-text-primary">{fmtNum(count)}</span>
            <span className="w-10 shrink-0 text-right tabular-nums text-text-muted">{Math.round((count / total) * 100)}%</span>
          </div>
        );
      })}
    </div>
  );
}

function RecentVerdicts({ recent }: { recent: AiReport["recent"] }) {
  if (recent.length === 0) {
    return <div className="text-[12px] text-text-muted">Ещё нет вердиктов.</div>;
  }
  return (
    <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
      {recent.map((r) => {
        const m = r.state ? stateMeta(r.state) : { label: "—", dot: "bg-border", bar: "" };
        return (
          <div key={r.messageId} className="flex items-start gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px]">
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${m.dot}`} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-text-primary">«{r.tail || "—"}»</div>
              <div className="text-[11px] text-text-muted">
                <span className="font-semibold text-text-secondary">{m.label}</span>
                {" · "}
                {r.needsReply ? <span className="text-accent">нужен ответ</span> : <span>ответ не нужен</span>}
                {r.reason && <span className="italic"> · {r.reason}</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SettingsForm({ report, pageLabel }: { report: AiReport; pageLabel: string }) {
  const settings = useWorkboardV2AiSettings(pageLabel);
  const ov = report.settings.override;
  const [enabledChoice, setEnabledChoice] = useState<EnabledChoice>("inherit");
  const [capInput, setCapInput] = useState("");
  const [modelInput, setModelInput] = useState("");

  useEffect(() => {
    setEnabledChoice(ov.enabled == null ? "inherit" : ov.enabled ? "on" : "off");
    setCapInput(ov.dailyCapMax == null ? "" : String(ov.dailyCapMax));
    setModelInput(ov.model ?? "");
  }, [ov.enabled, ov.dailyCapMax, ov.model]);

  const onSave = () => {
    const dailyCapMax = capInput.trim() === "" ? null : Math.max(1, Math.min(5000, Number(capInput) || 0));
    settings.mutate(
      {
        enabled: enabledChoice === "inherit" ? null : enabledChoice === "on",
        dailyCapMax,
        model: modelInput.trim() === "" ? null : modelInput.trim(),
      },
      {
        onSuccess: () => toast.success("Настройки ИИ сохранены"),
        onError: () => toast.error("Не удалось сохранить настройки"),
      },
    );
  };

  const choices: { key: EnabledChoice; label: string }[] = [
    { key: "inherit", label: `Наследовать (${report.settings.envEnabled ? "вкл" : "выкл"})` },
    { key: "on", label: "Включено" },
    { key: "off", label: "Выключено" },
  ];

  return (
    <div className="space-y-3 rounded-md border border-border bg-hover-alt/20 p-3">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-text-muted">Статус (эта страница)</div>
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            {choices.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setEnabledChoice(c.key)}
                className={`px-2.5 py-1 text-[12px] transition-colors ${
                  enabledChoice === c.key ? "bg-accent/15 font-semibold text-accent" : "bg-card text-text-secondary hover:bg-hover"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-text-muted">Дневной лимит вызовов</div>
          <input
            type="number"
            min={1}
            max={5000}
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            placeholder={`${report.settings.dailyCapMax} (env)`}
            className="w-32 rounded-md border border-border bg-card px-2 py-1 text-[12px] tabular-nums text-text-primary"
          />
        </div>

        <div className="min-w-[200px] flex-1">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-text-muted">Модель</div>
          <input
            type="text"
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            placeholder={`${report.settings.model} (env)`}
            className="w-full rounded-md border border-border bg-card px-2 py-1 text-[12px] text-text-primary"
          />
        </div>

        <button
          type="button"
          onClick={onSave}
          disabled={settings.isPending}
          className="rounded-button bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          Сохранить
        </button>
      </div>
      <div className="text-[11px] text-text-muted">
        Эффективно: <b className="text-text-secondary">{report.settings.enabled ? "включено" : "выключено"}</b> · модель{" "}
        <b className="text-text-secondary">{report.settings.model}</b> · лимит{" "}
        <b className="text-text-secondary">{report.settings.dailyCapMax}</b>/день
      </div>
      {!report.settings.hasApiKey && (
        <div className="text-[11px] text-warning-dark">
          Нет ANTHROPIC_API_KEY — фича не запустится, пока ключ не задан в окружении.
        </div>
      )}
    </div>
  );
}

export function AiPageDashboard({ pageLabel, running = false }: { pageLabel: string; running?: boolean }) {
  // While a run is in flight, poll the report so coverage / states / verdicts fill in live.
  const { data: report, isLoading } = useWorkboardV2Ai(pageLabel, { refetchInterval: running ? 3000 : false });
  const classify = useWorkboardV2AiClassify(pageLabel);
  const qc = useQueryClient();

  // When a run finishes (running: true → false), force one final refresh of the report + board.
  const prevRunning = useRef(running);
  useEffect(() => {
    if (prevRunning.current && !running) {
      qc.invalidateQueries({ queryKey: ["workboard-v2-ai", pageLabel] });
      qc.invalidateQueries({ queryKey: ["workboard-v2", pageLabel] });
    }
    prevRunning.current = running;
  }, [running, pageLabel, qc]);

  const runClassify = (reclassify: boolean) => {
    if (
      reclassify
      && !window.confirm("Очистить кэш вердиктов этой страницы и переклассифицировать всё заново? Это потратит вызовы API.")
    ) {
      return;
    }
    classify.mutate(
      { reclassify },
      {
        onSuccess: (r) =>
          toast.success(
            r.alreadyRunning
              ? "Запуск уже выполняется — смотрите журнал внизу"
              : "Запущено в фоне — прогресс в журнале запусков ниже",
          ),
        onError: () => toast.error("Не удалось запустить классификацию"),
      },
    );
  };

  const busy = running || classify.isPending;

  if (isLoading || !report) {
    return <div className="rounded-card border border-border bg-card py-10 text-center text-[12px] text-text-muted">Загрузка…</div>;
  }

  return (
    <div className="space-y-4 rounded-card border border-border bg-card p-4">
      <SettingsForm report={report} pageLabel={pageLabel} />

      <div>
        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">Расход</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Вызовов сегодня" value={fmtNum(report.usage.today.calls)} hint={`лимит ${report.settings.dailyCapMax}`} />
          <Stat label="Стоимость сегодня" value={fmtUsd(report.usage.today.costUsd)} />
          <Stat
            label="Токены сегодня"
            value={`${fmtNum(report.usage.today.inputTokens)}/${fmtNum(report.usage.today.outputTokens)}`}
            hint="вход/выход"
          />
          <Stat label="Стоимость 30д" value={fmtUsd(report.usage.last30d.costUsd)} hint={`${fmtNum(report.usage.last30d.calls)} вызовов`} />
        </div>
        <div className="mt-1 text-[10px] text-text-muted">
          * стоимость — оценка по текущей цене модели ({report.settings.model}); скидки batch/кэша не учтены
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">Покрытие</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Спендеров" value={fmtNum(report.coverage.spenders)} />
          <Stat
            label="Диагностировано"
            value={fmtNum(report.coverage.spenderDiagnosed)}
            hint={`${fmtNum(report.coverage.spenderPending)} ждут ИИ`}
          />
          <Stat
            label="Fan-last ИИ"
            value={fmtNum(report.coverage.spenderL2Classified)}
            hint={`${fmtNum(report.coverage.spenderFanLast)} хвостов`}
          />
          <Stat label="Без видимого диалога" value={fmtNum(report.coverage.spenderNoVisibleDialog)} />
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">Что происходит в чатах</div>
        <StateDistribution states={report.states} />
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">Последние вердикты</div>
        <RecentVerdicts recent={report.recent} />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => runClassify(false)}
          disabled={busy || !report.settings.hasApiKey}
          className="inline-flex items-center gap-1.5 rounded-button border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-hover disabled:opacity-50"
        >
          <Play size={13} />
          Классифицировать сейчас
        </button>
        <button
          type="button"
          onClick={() => runClassify(true)}
          disabled={busy || !report.settings.hasApiKey}
          className="inline-flex items-center gap-1.5 rounded-button border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-warning-dark transition-colors hover:bg-hover disabled:opacity-50"
        >
          <RefreshCcw size={13} />
          Переклассифицировать всё
        </button>
        {running && (
          <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-accent">
            <Loader2 size={13} className="animate-spin" />
            выполняется…
          </span>
        )}
      </div>
    </div>
  );
}
