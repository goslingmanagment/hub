import type { SyncBlockStatus } from "@agency_hub_core/contracts";
import { formatRelativeTime } from "@/lib/format";
import { SyncBlockBadge, SyncBlockProgress } from "./SyncBlockRow.js";
import { SyncBlockActions } from "./SyncBlockActions.js";
import {
  attemptsInTrouble,
  formatAttemptsLine,
  formatBlockSummary,
  formatCadence,
  formatNextTime,
  formatSubstreamStateLabel,
  getBlockDescription,
  getBlockLabel,
  getBlockTone,
  getDependencyWaitDetail,
  getReasonSummary,
  getServerReasonText,
  getSubstreamTone,
  isDependencyWait,
} from "./syncBlockDisplay.js";
import { syncStreamLabel } from "./syncVocabulary.js";

/** One block of an OnlyFans page in detail — its state, timing, streams and
 *  buttons. The server's raw figures (HTTP attempts, error code) stay, as a
 *  secondary line. */
export function SyncBlockDetailCard({
  block,
  pageLabel,
}: {
  block: SyncBlockStatus;
  pageLabel: string;
}) {
  const label = getBlockLabel(block.block);
  const description = getBlockDescription(block.block);

  if (block.state === "not_available") {
    return (
      <section className="card" data-sync-block={block.block}>
        <div className="card-header">
          <div>
            <h4 className="card-title text-text-secondary">{label}</h4>
            <p className="card-description">{getReasonSummary(block) ?? "На этой платформе недоступно"}</p>
          </div>
          <SyncBlockBadge block={block} />
        </div>
      </section>
    );
  }

  const summary = formatBlockSummary(block);
  const dependencyWait = isDependencyWait(block);
  const statusSummary = getReasonSummary(block) ??
    (block.state === "delayed"
      ? summary
      : block.state === "failed"
        ? `${label}: нужна проверка`
        : null);
  const statusTitle = dependencyWait
    ? "Ждёт, пока закончатся другие потоки"
    : statusSummary ?? (block.state === "failed" ? `${label}: нужна проверка` : "Сбор отстаёт");
  const queueWaiting = block.statusReason?.code === "queue_waiting";
  const hasStatusNotice = dependencyWait || block.state === "failed" || block.state === "delayed";
  const dependencyDetail = getDependencyWaitDetail(block);
  const serverText = getServerReasonText(block);
  const noticeTone = dependencyWait || queueWaiting
    ? "notice"
    : block.state === "failed"
    ? "notice notice-danger"
    : "notice notice-warning";
  const attempts = formatAttemptsLine(block);
  const technical = [
    serverText && serverText !== statusTitle ? serverText : null,
    block.error?.code ? `код ${block.error.code}` : null,
    block.error?.failedAt ? `последняя ошибка ${formatRelativeTime(block.error.failedAt)}` : null,
    block.error && block.error.consecutiveFailures > 0 ? `ошибок подряд: ${block.error.consecutiveFailures}` : null,
  ].filter((part): part is string => part !== null);

  return (
    <section className="card" data-sync-block={block.block}>
      <div className="card-header">
        <div className="min-w-0">
          <h4 className="card-title">{label}</h4>
          <p className="card-description">{description}</p>
        </div>
        <SyncBlockBadge block={block} />
      </div>

      <div className="card-body space-y-3 text-sm">
        <p className={getBlockTone(block).text}>{summary}</p>
        <SyncBlockProgress block={block} width="max-w-[260px]" />

        {hasStatusNotice && (
          <div className={noticeTone}>
            <div className="min-w-0 space-y-0.5">
              <p className="font-semibold">{statusTitle}</p>
              {dependencyWait && dependencyDetail && <p>Сначала: {dependencyDetail}</p>}
              {technical.length > 0 && <p className="break-words text-xs opacity-80">{technical.join(" · ")}</p>}
            </div>
          </div>
        )}

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          <dt className="text-text-muted">Последнее обновление</dt>
          <dd className="text-text-secondary">{block.succeededAt ? formatRelativeTime(block.succeededAt) : "ещё не было"}</dd>
          {block.nextDueAt && (
            <>
              <dt className="text-text-muted">Следующее</dt>
              <dd className="text-text-secondary">{formatNextTime(block.nextDueAt)}</dd>
            </>
          )}
          {block.nextRetryAt && (
            <>
              <dt className="text-text-muted">Следующая попытка</dt>
              <dd className="text-text-secondary">{formatNextTime(block.nextRetryAt)}</dd>
            </>
          )}
          {block.intervals.length > 0 && (
            <>
              <dt className="text-text-muted">Как часто</dt>
              <dd className="text-text-secondary">
                {block.intervals
                  .map((interval) => `${syncStreamLabel(interval.stream)} — ${formatCadence(interval.cadenceSeconds)}`)
                  .join(", ")}
              </dd>
            </>
          )}
        </dl>

        {attempts && (
          <p className={`text-xs ${attemptsInTrouble(block) ? "text-warning-dark" : "text-text-muted"}`} data-sync-attempts>
            {attempts}
          </p>
        )}

        {block.substreams.length > 1 && (
          <details className="help">
            <summary>Потоки блока ({block.substreams.length})</summary>
            <div className="mt-2 overflow-x-auto rounded-lg border border-border">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Поток</th>
                    <th>Состояние</th>
                    <th>Последнее обновление</th>
                    <th>Следующее</th>
                    <th>Как часто</th>
                  </tr>
                </thead>
                <tbody>
                  {block.substreams.map((sub) => {
                    const subTone = getSubstreamTone(sub);
                    return (
                      <tr key={sub.stream}>
                        <td className="font-medium">{syncStreamLabel(sub.stream)}</td>
                        <td>
                          <span className="flex items-center gap-2">
                            <span className={subTone.dot} />
                            <span className={subTone.text}>{formatSubstreamStateLabel(sub)}</span>
                          </span>
                        </td>
                        <td className="muted">{sub.succeededAt ? formatRelativeTime(sub.succeededAt) : "—"}</td>
                        <td className="muted">{formatNextTime(sub.nextDueAt) ?? "—"}</td>
                        <td className="muted">{sub.cadenceSeconds > 0 ? formatCadence(sub.cadenceSeconds) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>

      <div className="card-footer justify-end">
        <SyncBlockActions pageLabel={pageLabel} block={block} />
      </div>
    </section>
  );
}
