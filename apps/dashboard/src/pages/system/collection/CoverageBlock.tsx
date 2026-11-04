import type { StatsCoverageResponse } from "@agency_hub_core/contracts";
import { ChevronDown } from "lucide-react";
import { useStatsCoverage } from "@/api/insights";
import { captureProofWords, captureStatusWords, planeLabel, projectionLabel } from "@/components/analytics/analytics-words";
import { coverageSummary, engineStreamBadge } from "@/components/analytics/CoveragePanel";
import { Disclosure } from "@/components/ui/Disclosure";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatCount, formatDateTime } from "@/lib/format";
import { engineStopText, engineWaitLabel } from "@/pages/settings/engine/engineDisplay";
import { syncStreamLabel } from "@/pages/settings/sync/syncVocabulary";
import { analyticsPanelState } from "@/pages/analytics-query-state";

type FloorRow = StatsCoverageResponse["planes"][number];
type Engine = NonNullable<StatsCoverageResponse["engine"]>;

/** The names this screen gives the floors the stats tab names otherwise or not at all (design/screens/system.md §3.1, block 5). */
const PLANE_NAMES: Readonly<Record<string, string>> = {
  creator_stats_account: "Статистика Fansly: аккаунт",
  creator_stats_audience: "Статистика Fansly: аудитория",
  creator_stats_media: "Статистика Fansly: контент",
  catalog_vault_media: "Медиа в медиатеке",
};

function plane(planeKey: string): string {
  return PLANE_NAMES[planeKey] ?? planeLabel(planeKey);
}

function instant(value: string | null): string {
  return value === null ? "—" : formatDateTime(value, { yearUnlessCurrent: true });
}

function count(value: number | null): string {
  return value === null ? "—" : formatCount(value);
}

function scopeText(row: FloorRow, pageId: number): string {
  if (row.scopeRef === String(pageId)) return "эта страница";
  if (row.scopeRef === "steady") return "свежие данные";
  return row.scopeRef;
}

/** «Что держит»: a stop, the attention sentence or why its work waits. */
function holdText(stream: Engine["streams"][number]): string {
  const stop = stream.stops[0];
  if (stop) return engineStopText(stop, { language: "ru", until: instant, listKeys: false });
  if (stream.needsAttention && stream.reason) return stream.reason.split(/;\s*pnpm\s/)[0]!.trim();
  if (stream.waiting) return `${engineWaitLabel(stream.waiting.reason, "ru")}${stream.waiting.until ? ` до ${instant(stream.waiting.until)}` : ""}`;
  return "—";
}

/**
 * «Полнота данных», moved from «Аналитика»: how far back each kind of data reaches,
 * what Hub holds and what is being collected now. Collapsed; its one line stays.
 */
export function CoverageBlock({ pageLabel, pageId }: { pageLabel: string; pageId: number }) {
  const query = useStatsCoverage(pageLabel);
  const state = analyticsPanelState(query);
  const summary = coverageSummary(state)
    .replace("Сбор данных Fansly не ведёт эту страницу — новые данные не поступают.", "Сбор данных Fansly не ведёт эту страницу: новые данные не поступают.")
    .replace("на паузе, удержаны или требуют внимания", "на паузе, ждут или требуют внимания");
  const data = state.status === "ready" ? state.data : null;
  return (
    <details className="card sys-fold" data-coverage>
      <summary className="sys-fold-summary">
        <span className="min-w-0 flex-1">
          <span className="card-title block">Полнота данных</span>
          <span className="card-description block">{summary}</span>
        </span>
        <ChevronDown size={18} aria-hidden="true" className="sys-fold-chevron" />
      </summary>
      <div className="sys-fold-body sys-stack">
        {state.status === "loading" ? (
          <Skeleton width={360} />
        ) : state.status === "error" || data === null ? (
          <div className="sys-pause-missing">
            <span>Сведения о сборе не загрузились.</span>
            <button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>
          </div>
        ) : (
          <>
            <div>
              <h3 className="sys-subtitle">Глубина собранных данных</h3>
              {data.planes.length === 0 ? (
                <p className="cell-second mt-2">Сведений о глубине сбора для этой страницы пока нет.</p>
              ) : (
                <div className="table-wrap mt-3">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Раздел</th>
                        <th>Область</th>
                        <th>Статус</th>
                        <th>Подтверждение</th>
                        <th>Собрано с</th>
                        <th className="num">Получено / ожидалось</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.planes.map((row) => (
                        <tr key={`${row.plane}:${row.scopeRef}`}>
                          <td className="whitespace-nowrap">{plane(row.plane)}</td>
                          <td className="muted">{scopeText(row, pageId)}</td>
                          <td>{captureStatusWords(row.status)}</td>
                          <td className="muted">{captureProofWords(row.proof)}</td>
                          <td className="whitespace-nowrap tabular-nums">{instant(row.oldestCapturedAt)}</td>
                          <td className="num">{count(row.observedUniqueCount)} / {count(row.expectedCount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <h3 className="sys-subtitle">Хранится в Hub</h3>
              {data.holdings.filter((row) => row.rowCount > 0).length === 0 ? (
                <p className="cell-second mt-2">Для этой страницы пока ничего не сохранено.</p>
              ) : (
                <div className="sys-chips mt-3">
                  {data.holdings.filter((row) => row.rowCount > 0).map((row) => (
                    <span key={row.projection} className="badge">
                      {projectionLabel(row.projection)} · {formatCount(row.rowCount)}
                    </span>
                  ))}
                </div>
              )}
              {data.holdings.some((row) => row.rowCount === 0) && (
                <p className="cell-second mt-3">
                  Пока пусто: {data.holdings.filter((row) => row.rowCount === 0).map((row) => projectionLabel(row.projection)).join(", ")}.
                  Ноль записей — это факт о Hub, а не о Fansly.
                </p>
              )}
            </div>

            <div>
              <h3 className="sys-subtitle">Лайки</h3>
              <p className="cell-second mt-2">
                Лайки не собираются: Fansly не подтверждает способ их получать, поэтому список лайкнувших всегда пуст. Это известный пробел,
                а не страница без лайков.
              </p>
            </div>

            <Disclosure label="Подробнее">
              <h3 className="sys-subtitle">Что сейчас собирается</h3>
              {data.engine === null ? (
                <p>Сбор данных Fansly не ведёт эту страницу: её данные никто не читает.</p>
              ) : (
                <div className="table-wrap mt-3">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Поток</th>
                        <th>Состояние</th>
                        <th>Последний сбор</th>
                        <th>Следующий сбор</th>
                        <th className="num">Ошибок подряд</th>
                        <th>Что держит</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.engine.streams.map((stream) => {
                        const badge = engineStreamBadge(data.engine!, stream);
                        return (
                          <tr key={stream.stream}>
                            <td className="whitespace-nowrap">{syncStreamLabel(stream.stream)}</td>
                            <td className="status-col">
                              <span className={`badge badge-bare ${badge.tone === "off" ? "badge-warning" : "badge-success"}`}>{badge.text.charAt(0).toUpperCase() + badge.text.slice(1)}</span>
                            </td>
                            <td className="whitespace-nowrap tabular-nums">{instant(stream.succeededAt)}</td>
                            <td className="whitespace-nowrap tabular-nums">{instant(stream.nextDueAt)}</td>
                            <td className="num">{count(stream.consecutiveFailures)}</td>
                            <td className="muted">{holdText(stream)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Disclosure>
          </>
        )}
      </div>
    </details>
  );
}
