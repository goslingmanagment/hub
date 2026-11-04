import { useNotificationsSettings, useSendTestMessage, useUpdateNotificationsSettings } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { StaleNotice } from "../StaleNotice.js";
import { AlertsCard } from "./AlertsCard.js";
import { DailyReportCard } from "./DailyReportCard.js";
import { TelegramCard } from "./TelegramCard.js";

function CardsSkeleton() {
  return (
    <div className="stack" aria-hidden="true">
      {[2, 3, 2].map((lines, index) => (
        <div key={index} className="card">
          <div className="card-header"><Skeleton width={180} /></div>
          <div className="card-body space-y-4">
            {Array.from({ length: lines }, (_, line) => <Skeleton key={line} width={line === 0 ? 420 : 300} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * «Оповещения»: where and what Hub sends to Telegram, and the daily revenue
 * report (design/screens/settings.md §7). Every write is the form's. While a write
 * goes or the settings did not refresh, nothing else is written.
 */
export function NotificationsPage() {
  const { data: settings, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useNotificationsSettings();
  const update = useUpdateNotificationsSettings();
  const sendTest = useSendTestMessage();
  const writesUnavailable = update.isPending || sendTest.isPending || isError;

  const header = (
    <PageHeader fresh={dataUpdatedAt ? { at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: isFetching } : undefined} />
  );

  if (isLoading && !settings) return <>{header}<CardsSkeleton /></>;
  if (!settings) {
    return (
      <>
        {header}
        <StatusPanel
          tone="error"
          title="Hub не ответил"
          description="Настройки оповещений не пришли."
          action={<button type="button" className="btn btn-sm" disabled={isFetching} onClick={() => void refetch()}>Повторить</button>}
        />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="stack">
        {isError && <StaleNotice at={dataUpdatedAt} retry={() => refetch()} extra="Введённое сохранено." />}
        <div className="settings-telegram">
          <TelegramCard settings={settings} isError={isError} update={update} sendTest={sendTest} />
          {!settings.enabled && (
            <Notice tone="off">
              <b>Оповещения выключены.</b> Автоматические сообщения и отчёт по расписанию не уходят. Настройки ниже сохранены.
            </Notice>
          )}
        </div>
        <DailyReportCard settings={settings} writesUnavailable={writesUnavailable} update={update} muted={!settings.enabled} />
        <AlertsCard settings={settings} writesUnavailable={writesUnavailable} update={update} muted={!settings.enabled} />
      </div>
    </>
  );
}
