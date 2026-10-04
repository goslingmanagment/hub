import type { AgentSyncPageStatus } from "@agency_hub_core/contracts";
import { useSyncEnginePages } from "@/api/queries";

// A page the Fansly Sync Engine owns (design step 3 §3.2 item 3): the Settings
// tab says who serves the page and shows the engine's own view of it — mode,
// owner, holds, socket and the queue by why it waits — from
// `/api/v1/sync/pages` (owner session; a session without it simply sees no
// engine detail).

type EnginePageStatus = AgentSyncPageStatus;
type WorkClass = keyof EnginePageStatus["queue"];

const CLASS_LABELS: Record<WorkClass, string> = {
  urgent: "срочное",
  requests: "заявки",
  planned: "плановое",
};

const WAIT_LABELS: Record<string, string> = {
  not_due: "ждёт срока",
  pacer: "пауза между запросами",
  class_share: "очередь класса",
  page_hold: "удержание страницы",
  route_budget: "пауза эндпоинта",
  route_hold: "удержание эндпоинта (429)",
  resource_hold: "удержание ресурса",
  subject_breaker: "пауза после ошибок",
  blocked_by_vendor: "Fansly отказывает",
  quarantined: "карантин",
  paused: "пауза владельца",
  dependency: "ждёт другую работу",
  ownership_unconfirmed: "нет владельца",
  running: "читает",
};

/** Reasons of work that is ready to run: it waits only for its turn — the
 *  page's pause, its endpoint's own pace, or other work. */
const RUNNABLE_REASONS: ReadonlySet<string> = new Set(["pacer", "route_budget", "class_share"]);

const HOLD_LABELS: Record<string, string> = {
  auth: "Fansly не принимает данные входа",
  identity_mismatch: "данные входа другого аккаунта",
  network: "сеть",
};

/** "12 с", "4 мин", "3 ч" since an instant (null: never). */
export function engineAgeText(iso: string | null, now: number = Date.now()): string | null {
  if (iso === null) return null;
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 120) return `${seconds} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} мин`;
  return `${Math.round(minutes / 60)} ч`;
}

function holdText(status: EnginePageStatus): string | null {
  const hold = status.holds.page;
  if (hold === null) return null;
  const until = hold.until === "infinity" ? "до новых данных входа" : `до ${new Date(hold.until).toLocaleTimeString()}`;
  return `${HOLD_LABELS[hold.kind] ?? hold.kind}, ${until}`;
}

function ownerText(status: EnginePageStatus, now: number): string {
  if (!status.owner.running) return "владельца нет";
  const age = engineAgeText(status.owner.heartbeatAt, now);
  return age === null ? "владелец работает" : `владелец отвечал ${age} назад`;
}

function socketText(status: EnginePageStatus): string {
  if (status.ws === null) return "сокет: нет данных";
  return status.ws.connected ? "сокет подключён" : "сокет отключён";
}

/** The one-line engine summary of a page (the Settings overview). */
export function formatEngineSummaryLine(status: EnginePageStatus, now: number = Date.now()): string {
  const parts = [
    status.mode === "handover" ? "переключение" : status.mode,
    ownerText(status, now),
    socketText(status),
  ];
  const hold = holdText(status);
  if (hold !== null) parts.push(`удержание: ${hold}`);
  if (status.quarantined > 0) parts.push(`в карантине: ${status.quarantined}`);
  return parts.join(" · ");
}

function useEnginePageStatus(pageLabel: string): EnginePageStatus | null {
  const { data } = useSyncEnginePages();
  return data?.pages.find((page) => page.pageLabel === pageLabel) ?? null;
}

/** The engine notice of a page card in the Settings overview. */
export function SyncEngineNotice({ pageLabel }: { pageLabel: string }) {
  const status = useEnginePageStatus(pageLabel);
  return (
    <div className="mt-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5 text-xs">
      <p className="font-medium text-text-primary">Управляется Fansly Sync Engine</p>
      {status !== null && (
        <p className="mt-0.5 text-[11px] text-text-secondary">{formatEngineSummaryLine(status)}</p>
      )}
    </div>
  );
}

function QueueTable({ status }: { status: EnginePageStatus }) {
  const classes = Object.keys(CLASS_LABELS) as WorkClass[];
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-hover-alt">
            <th className="px-3 py-1.5 text-left font-medium text-text-muted">Класс</th>
            <th className="px-3 py-1.5 text-left font-medium text-text-muted">Готово к запуску</th>
            <th className="px-3 py-1.5 text-left font-medium text-text-muted">Ждёт</th>
            <th className="px-3 py-1.5 text-left font-medium text-text-muted">Запросов за час</th>
          </tr>
        </thead>
        <tbody>
          {classes.map((workClass) => {
            const queue = status.queue[workClass];
            const waiting = Object.entries(queue.waitingByReason)
              .filter(([reason, count]) => (count ?? 0) > 0 && !RUNNABLE_REASONS.has(reason))
              .map(([reason, count]) => `${WAIT_LABELS[reason] ?? reason}: ${count}`)
              .join(", ");
            return (
              <tr key={workClass} className="border-t border-border">
                <td className="px-3 py-1.5 text-text-primary font-medium">{CLASS_LABELS[workClass]}</td>
                <td className="px-3 py-1.5 text-text-secondary">{queue.runnable}</td>
                <td className="px-3 py-1.5 text-text-secondary">{waiting || "—"}</td>
                <td className="px-3 py-1.5 text-text-secondary">{status.sendsLastHour[workClass]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The engine card of a page's Settings detail. */
export function SyncEngineCard({ pageLabel }: { pageLabel: string }) {
  const status = useEnginePageStatus(pageLabel);
  const now = Date.now();
  return (
    <div className="rounded-xl border border-accent/30 bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-text-primary">Управляется Fansly Sync Engine</span>
        {status !== null && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent">
            {status.mode === "handover" ? "переключение" : status.mode}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-text-muted">
        Страницу читает движок синхронизации Fansly; блоки ниже показывают его работу, кнопки управляют его ресурсами.
      </p>
      {status === null
        ? <p className="mt-2 text-xs text-text-muted">Подробности движка недоступны.</p>
        : (
          <>
            <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
              <span className="text-text-muted">Владелец</span>
              <span className="text-text-secondary">{ownerText(status, now)}</span>
              <span className="text-text-muted">Удержание</span>
              <span className={status.holds.page === null ? "text-text-secondary" : "text-warning-dark font-medium"}>
                {holdText(status) ?? "нет"}
              </span>
              {status.holds.resources.length > 0 && (
                <>
                  <span className="text-text-muted">Удержание ресурсов</span>
                  <span className="text-text-secondary">
                    {status.holds.resources.map((hold) => hold.file).join(", ")}
                  </span>
                </>
              )}
              <span className="text-text-muted">Сокет</span>
              <span className="text-text-secondary">
                {socketText(status)}
                {status.ws?.gapSince ? ` · разрыв с ${new Date(status.ws.gapSince).toLocaleTimeString()}` : ""}
              </span>
              <span className="text-text-muted">Пауза между запросами</span>
              <span className="text-text-secondary">
                {status.pause.settingMs} мс
                {status.pause.violationsLastDay > 0 ? ` · нарушений за сутки: ${status.pause.violationsLastDay}` : ""}
              </span>
              {status.quarantined > 0 && (
                <>
                  <span className="text-text-muted">В карантине</span>
                  <span className="text-warning-dark font-medium">
                    {status.quarantined} · pnpm cli sync work list --page {pageLabel} --state quarantined
                  </span>
                </>
              )}
            </div>
            <div className="mt-3">
              <QueueTable status={status} />
            </div>
          </>
        )}
    </div>
  );
}
