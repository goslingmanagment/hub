import {
  ENGINE_CLASS_LABELS,
  ENGINE_WORK_CLASSES,
  engineAgeText,
  engineClockText,
  engineCount,
  engineHoldText,
  engineModeLabel,
  engineOwnerText,
  engineSendsByResource,
  engineSendsLastHour,
  engineSocketText,
  engineWaitingText,
  type EnginePageStatus,
} from "./engineDisplay.js";

// A page as the Fansly Sync Engine sees it (`/api/v1/sync/pages`, plan §10):
// who owns it, what holds it, its socket, the pause and how it was kept, and
// the queue with the hour's requests by class.

export function EngineModeChip({ mode }: { mode: EnginePageStatus["mode"] }) {
  const live = mode === "live";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
        live ? "border-green/30 bg-green/10 text-green" : "border-warning/30 bg-warning/10 text-warning-dark"
      }`}
    >
      {engineModeLabel(mode)}
    </span>
  );
}

function pauseText(status: EnginePageStatus): string {
  const parts = [`${engineCount(status.pause.settingMs)} мс`];
  if (status.pause.minGapLastHourMs !== null) {
    parts.push(`наименьший промежуток за час ${engineCount(status.pause.minGapLastHourMs)} мс`);
  }
  if (status.pause.violationsLastDay > 0) parts.push(`нарушений за сутки: ${status.pause.violationsLastDay}`);
  return parts.join(" · ");
}

/** Owner, holds, socket and the pause record of a page. */
export function EngineStatusGrid({
  status,
  pageLabel,
  now = Date.now(),
}: {
  status: EnginePageStatus;
  pageLabel: string;
  now?: number;
}) {
  const lastSend = engineAgeText(status.pause.lastSendAt, now);
  const breakers = [
    status.breakers.open > 0 ? `пауза после ошибок: ${engineCount(status.breakers.open)}` : null,
    status.breakers.blockedByVendor > 0 ? `Fansly отказывает: ${engineCount(status.breakers.blockedByVendor)}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
      <span className="text-text-muted">Владелец</span>
      <span className="text-text-secondary">{engineOwnerText(status, now)}</span>
      <span className="text-text-muted">Удержание</span>
      <span className={status.holds.page === null ? "text-text-secondary" : "text-warning-dark font-medium"}>
        {engineHoldText(status, now) ?? "нет"}
      </span>
      {status.holds.resources.length > 0 && (
        <>
          <span className="text-text-muted">Удержание ресурсов</span>
          <span className="text-warning-dark font-medium">
            {status.holds.resources.map((hold) => `${hold.file} до ${engineClockText(hold.until, now)}`).join(", ")}
          </span>
        </>
      )}
      <span className="text-text-muted">Сокет</span>
      <span className={status.ws?.connected === false ? "text-warning-dark font-medium" : "text-text-secondary"}>
        {engineSocketText(status, now)}
      </span>
      <span className="text-text-muted">Пауза между запросами</span>
      <span className={status.pause.violationsLastDay > 0 ? "text-warning-dark font-medium" : "text-text-secondary"}>
        {pauseText(status)}
      </span>
      <span className="text-text-muted">Последний запрос</span>
      <span className="text-text-secondary">{lastSend === null ? "не было" : `${lastSend} назад`}</span>
      {breakers.length > 0 && (
        <>
          <span className="text-text-muted">Предохранители</span>
          <span className="text-text-secondary">{breakers.join(" · ")}</span>
        </>
      )}
      {status.quarantined > 0 && (
        <>
          <span className="text-text-muted">В карантине</span>
          <span className="text-warning-dark font-medium">
            {status.quarantined} · pnpm cli sync work list --page {pageLabel} --state quarantined
          </span>
        </>
      )}
    </div>
  );
}

/** The queue by class — ready to run, waiting and why — with the requests
 *  each class sent over the last hour. */
export function EngineQueueTable({ status }: { status: EnginePageStatus }) {
  const runnable = ENGINE_WORK_CLASSES.reduce((sum, workClass) => sum + status.queue[workClass].runnable, 0);
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-hover-alt">
            <th className="px-3 py-1.5 text-left font-medium text-text-muted">Класс</th>
            <th className="px-3 py-1.5 text-left font-medium text-text-muted">Готово к запуску</th>
            <th className="px-3 py-1.5 text-left font-medium text-text-muted">Ждёт</th>
            <th className="px-3 py-1.5 text-right font-medium text-text-muted">Запросов за час</th>
          </tr>
        </thead>
        <tbody>
          {ENGINE_WORK_CLASSES.map((workClass) => {
            const queue = status.queue[workClass];
            return (
              <tr key={workClass} className="border-t border-border">
                <td className="px-3 py-1.5 text-text-primary font-medium">{ENGINE_CLASS_LABELS[workClass]}</td>
                <td className="px-3 py-1.5 text-text-secondary tabular-nums">{engineCount(queue.runnable)}</td>
                <td className="px-3 py-1.5 text-text-secondary">{engineWaitingText(queue) || "—"}</td>
                <td
                  className="px-3 py-1.5 text-right text-text-secondary tabular-nums"
                  data-sends-class={workClass}
                >
                  {engineCount(status.sendsLastHour[workClass])}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-border bg-hover-alt">
            <td className="px-3 py-1.5 text-text-primary font-medium">всего</td>
            <td className="px-3 py-1.5 text-text-secondary tabular-nums">{engineCount(runnable)}</td>
            <td className="px-3 py-1.5 text-text-secondary" />
            <td className="px-3 py-1.5 text-right text-text-primary font-medium tabular-nums" data-sends-class="all">
              {engineCount(engineSendsLastHour(status))}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** The hour's requests by resource, the busiest first (the page's detail). */
export function EngineSendsByResource({ status }: { status: EnginePageStatus }) {
  const resources = engineSendsByResource(status);
  if (resources.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1.5">
        Запросов за час по ресурсам
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {resources.map(({ resource, sends }) => (
          <li
            key={resource}
            className="rounded-md border border-border bg-hover-alt px-2 py-0.5 text-[11px] text-text-secondary"
          >
            {resource} <span className="font-semibold text-text-primary tabular-nums">{engineCount(sends)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
