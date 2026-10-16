import type { ReactNode } from "react";

import { ruPlural } from "@/lib/plural";
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
// the processing host that runs it, what holds it, its event channel, the
// pause and how it was kept, and the queue with the hour's requests by class.
// The details of a page — the owner reads its one status line first.

/** The page's mode. A page reads as on — green — only while a processing
 *  host runs it: `live` of a page nobody runs says so beside the mode. */
export function EngineModeChip({ mode, ownerRunning }: { mode: EnginePageStatus["mode"]; ownerRunning: boolean }) {
  const running = mode === "live" && ownerRunning;
  return (
    <span
      className={`badge ${running ? "badge-success" : "badge-warning"}`}
      data-engine-mode={mode}
      data-engine-running={running}
    >
      {mode === "live" && !ownerRunning ? `${engineModeLabel(mode)} · нет обработчика` : engineModeLabel(mode)}
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

function Row({ label, warn = false, children }: { label: string; warn?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className={`min-w-0 break-words ${warn ? "font-medium text-warning-dark" : "text-text-secondary"}`}>{children}</dd>
    </>
  );
}

/** The processing host, holds, event channel and the pause record of a page. */
export function EngineStatusGrid({
  status,
  now = Date.now(),
}: {
  status: EnginePageStatus;
  /** Kept for callers; the commands of a page are in the screen's «Для разработчика». */
  pageLabel?: string | undefined;
  now?: number;
}) {
  const lastSend = engineAgeText(status.pause.lastSendAt, now);
  const breakers = [
    status.breakers.open > 0 ? `пауза после ошибок: ${engineCount(status.breakers.open)}` : null,
    status.breakers.blockedByVendor > 0 ? `Fansly отказывает: ${engineCount(status.breakers.blockedByVendor)}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      <Row label="Режим">
        <EngineModeChip mode={status.mode} ownerRunning={status.owner.running} />
      </Row>
      <Row label="Обработчик" warn={!status.owner.running}>{engineOwnerText(status, now)}</Row>
      <Row label="Удержание" warn={status.holds.page !== null}>{engineHoldText(status, now) ?? "нет"}</Row>
      {status.holds.resources.length > 0 && (
        <Row label="Удержание ресурсов" warn>
          {status.holds.resources.map((hold) => `${hold.file} до ${engineClockText(hold.until, now)}`).join(", ")}
        </Row>
      )}
      <Row label="Канал событий" warn={status.ws?.connected === false}>{engineSocketText(status, now)}</Row>
      <Row label="Пауза между запросами" warn={status.pause.violationsLastDay > 0}>{pauseText(status)}</Row>
      <Row label="Последний запрос">{lastSend === null ? "не было" : `${lastSend} назад`}</Row>
      {breakers.length > 0 && <Row label="Защита от ошибок">{breakers.join(" · ")}</Row>}
      {status.quarantined > 0 && (
        <Row label="В карантине" warn>
          {engineCount(status.quarantined)} {ruPlural(status.quarantined, "строка", "строки", "строк")}
        </Row>
      )}
    </dl>
  );
}

/** The queue by class — ready to run, waiting and why — with the requests
 *  each class sent over the last hour. */
export function EngineQueueTable({ status }: { status: EnginePageStatus }) {
  const runnable = ENGINE_WORK_CLASSES.reduce((sum, workClass) => sum + status.queue[workClass].runnable, 0);
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Очередь</th>
            <th className="num">Готово к запуску</th>
            <th>Ждёт</th>
            <th className="num">Запросов за час</th>
          </tr>
        </thead>
        <tbody>
          {ENGINE_WORK_CLASSES.map((workClass) => {
            const queue = status.queue[workClass];
            return (
              <tr key={workClass}>
                <td className="font-medium">{ENGINE_CLASS_LABELS[workClass]}</td>
                <td className="num">{engineCount(queue.runnable)}</td>
                <td className="muted">{engineWaitingText(queue) || "—"}</td>
                <td className="num" data-sends-class={workClass}>{engineCount(status.sendsLastHour[workClass])}</td>
              </tr>
            );
          })}
          <tr>
            <td className="font-semibold">Всего</td>
            <td className="num font-semibold">{engineCount(runnable)}</td>
            <td />
            <td className="num font-semibold" data-sends-class="all">{engineCount(engineSendsLastHour(status))}</td>
          </tr>
        </tbody>
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
      <p className="mb-1.5 text-sm font-medium text-text-secondary">Запросов за час по ресурсам</p>
      <ul className="flex flex-wrap gap-1.5">
        {resources.map(({ resource, sends }) => (
          <li key={resource} className="badge font-mono">
            {resource} <span className="font-semibold text-text-primary tabular-nums">{engineCount(sends)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
