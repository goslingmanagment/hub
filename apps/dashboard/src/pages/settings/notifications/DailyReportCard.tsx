import { useState } from "react";
import type { NotificationsSettingsResponse } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import { useReportHistory, useReportPreview, useSendReport, useUpdateNotificationsSettings } from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Switch } from "@/components/ui/Switch";
import { formatBusinessDateShort, formatDateTime } from "@/lib/format";
import { REPORT_STATUS } from "@/lib/statusWords";
import { toastError } from "../settingsFeedback.js";
import { hourLabel, moscowHourFromUtc, skippedReasonRu, telegramErrorRu, telegramHtml, utcHourFromMoscow } from "./notificationsView.js";

const MOSCOW_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** The report's history: what went, how, and why one did not. */
function ReportHistory() {
  const { data: history, isLoading, isError, refetch } = useReportHistory();
  if (isLoading && !history) return <p className="settings-second">Загружаем историю…</p>;
  if (!history) {
    return (
      <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void refetch()}>Повторить</button>}>
        История отправок не загрузилась.
      </Notice>
    );
  }
  if (history.items.length === 0) {
    return <p className="settings-second">Отчёты ещё не отправлялись. Здесь появится каждая отправка: по расписанию или вручную.</p>;
  }
  return (
    <>
      {isError && (
        <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void refetch()}>Повторить</button>}>
          Не удалось обновить историю. Показана прежняя.
        </Notice>
      )}
      <div className="table-wrap settings-history">
        <table className="data-table data-table-dense">
          <thead>
            <tr>
              <th>За день</th>
              <th>Как</th>
              <th>Статус</th>
              <th>Когда</th>
            </tr>
          </thead>
          <tbody>
            {history.items.map((item) => {
              const skipped = item.status === "skipped";
              const word = item.status === "sent" ? REPORT_STATUS.sent : skipped ? REPORT_STATUS.skipped : REPORT_STATUS.notSent;
              const reason = item.status === "sent" ? null : skipped ? skippedReasonRu(item.error) : telegramErrorRu(item.error);
              return (
                <tr key={item.id}>
                  <td className="tabular-nums">{item.reportDate ? formatBusinessDateShort(item.reportDate) : "—"}</td>
                  <td className="muted">{item.kind === "daily_report_scheduled" ? "По расписанию" : "Вручную"}</td>
                  <td className="status-col">
                    <StatusBadge status={word} title={item.error ?? undefined} />
                    {reason && <span className="settings-second" title={item.error ?? undefined}>{reason}</span>}
                  </td>
                  <td className="muted whitespace-nowrap tabular-nums">{formatDateTime(item.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * The daily revenue report: on or off, its hour by Moscow (sent to the hub in
 * UTC, as it is stored), what the next one says and «Отправить сейчас», which asks
 * first: the report goes to a chat people read.
 */
export function DailyReportCard({ settings, writesUnavailable, update, muted }: {
  settings: NotificationsSettingsResponse;
  writesUnavailable: boolean;
  update: ReturnType<typeof useUpdateNotificationsSettings>;
  /** The main switch is off: the row is quieter, and still works. */
  muted: boolean;
}) {
  const preview = useReportPreview();
  const sendReport = useSendReport();
  const [confirming, setConfirming] = useState(false);
  const moscowHour = moscowHourFromUtc(settings.reportHourUtc);

  function toggleReport(value: boolean) {
    if (writesUnavailable) return;
    update.mutate({ dailyReportEnabled: value }, { onError: () => toastError("Настройка не сохранилась") });
  }

  function changeHour(hour: number) {
    if (writesUnavailable) return;
    update.mutate({ reportHourUtc: utcHourFromMoscow(hour) }, { onError: () => toastError("Час отчёта не сохранился") });
  }

  function sendNow() {
    sendReport.mutate(undefined, {
      onSuccess: (result) => {
        setConfirming(false);
        const day = result.reportDate ? ` за ${formatBusinessDateShort(result.reportDate)}` : "";
        if (result.status === "sent") toast.success(`Отчёт${day} отправлен в Telegram`);
        else toastError(`Отчёт не отправился: ${skippedReasonRu(result.error) ?? telegramErrorRu(result.error)}`);
      },
      onError: () => {
        setConfirming(false);
        toastError("Отчёт не отправился: Hub не ответил, неизвестно, ушёл ли он. Посмотрите историю отправок.");
      },
    });
  }

  const shownDate = preview.data ? formatBusinessDateShort(preview.data.reportDate) : null;

  return (
    <section className={`card ${muted ? "settings-muted" : ""}`} aria-labelledby="daily-report-title">
      <div className="card-header">
        <h2 id="daily-report-title" className="card-title">Ежедневный отчёт о доходе</h2>
      </div>
      <div className="settings-card-switches">
        <div className="switch-row settings-switch-row">
          <div className="switch-text">
            <span className="font-medium">Присылать каждый день</span>
            <small>Сводка дохода за прошедшие сутки, они закрываются в 02:00 по Москве. В этот же час приходит сводка сбоев.</small>
          </div>
          <div className="switch-control">
            <select
              aria-label="Час ежедневного отчёта, по Москве"
              className="select w-auto"
              disabled={writesUnavailable}
              value={moscowHour}
              onChange={(event) => changeHour(Number(event.target.value))}
            >
              {MOSCOW_HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
            </select>
            <span className="settings-state-word">{settings.dailyReportEnabled ? "Включён" : "Выключен"}</span>
            <Switch
              checked={settings.dailyReportEnabled}
              label="Присылать отчёт каждый день"
              disabled={writesUnavailable}
              onChange={toggleReport}
            />
          </div>
        </div>
      </div>
      <div className="card-body settings-report-body">
        <div className="settings-report-actions">
          <button type="button" className="btn" disabled={preview.isFetching} onClick={() => void preview.refetch()}>
            {preview.isFetching ? "Загружаем…" : "Показать следующий отчёт"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={sendReport.isPending || !settings.configured}
            onClick={() => setConfirming(true)}
          >
            {sendReport.isPending ? "Отправляем…" : "Отправить сейчас"}
          </button>
          {!settings.configured && <span className="settings-header-reason">Сначала подключите Telegram</span>}
        </div>

        {preview.isError && (
          <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void preview.refetch()}>Повторить</button>}>
            {preview.data ? "Не удалось обновить предпросмотр, ниже прежний." : "Предпросмотр не загрузился."}
          </Notice>
        )}
        {preview.data && (
          <div className="settings-preview">
            <p className="field-label">Отчёт за {shownDate}</p>
            <div className="settings-preview-text">{telegramHtml(preview.data.text)}</div>
            <Notice>В Telegram отчёт приходит картинкой с теми же числами. Если картинка не соберётся, придёт этот текст.</Notice>
          </div>
        )}

        <Disclosure label="История отправок" lazy>
          <ReportHistory />
        </Disclosure>
      </div>

      {confirming && (
        <ConfirmModal
          title="Отправить отчёт сейчас?"
          message="Отчёт о доходе уйдёт в Telegram. Если чат групповой, его увидят все участники."
          facts={[
            { label: "Куда", value: settings.chatId ? `чат ${settings.chatId}` : "чат не задан" },
            { label: "Что именно", value: shownDate ? `отчёт за ${shownDate}` : "отчёт за последние закрытые сутки" },
            { label: "Отменить", value: "Нельзя: сообщение останется в чате" },
          ]}
          confirmLabel="Отправить отчёт"
          pendingLabel="Отправляем…"
          tone="primary"
          isPending={sendReport.isPending}
          onConfirm={sendNow}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
