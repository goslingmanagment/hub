import { useMemo } from "react";

import type {
  ContentCommentsResponse,
  StatsMediaResponse,
  StatsTagsResponse,
} from "@agency_hub_core/contracts";
import { ANALYTICS_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { bucketKey, bucketTimeline } from "@/components/charts/scale";
import { TrendSparkline } from "@/components/shared/TrendSparkline";
import { formatMills } from "@/lib/format";
import {
  panelData,
  type AnalyticsPanelState,
} from "@/pages/analytics-query-state";

import {
  ANALYTICS_TABLE_WRAP,
  AnalyticsEmpty,
  AnalyticsError,
  AnalyticsLoading,
  AnalyticsPanel,
  CachedBadge,
  CoverageBadge,
} from "./AnalyticsPanel.js";
import { formatCompactCount, formatCount, formatPercent } from "./analytics-words.js";
import {
  coverageBadgeVerdict,
  coverageRequestVerdict,
  emptyPanelReason,
  type AnalyticsCoverageWindow,
  type CoverageRow,
  type CoverageVerdict,
} from "./coverage.js";

/** `—` rather than `0`: an unserved metric is not a measurement of nothing. */
function metric(value: number | null): string {
  return value === null ? "—" : formatCount(value);
}

/** A platform-wide counter: compact on screen, exact on hover. */
function GlobalCount({ value }: { value: number | null }) {
  if (value === null) return <>—</>;
  return <span title={formatCount(value)}>{formatCompactCount(value)}</span>;
}

function money(value: number | null): string {
  return value === null ? "—" : formatMills(value);
}

/**
 * Panel 3 — top media, each with the sparkline of its own buckets.
 *
 * The ranking rows and the series come from the same response but are DIFFERENT
 * facts: `stats_top_media` is what the platform ranked over its window, and the
 * sparkline is what our own per-media buckets hold. Missing series are labelled
 * by what the response can actually prove; absence alone never means unpolled.
 */
export function TopMediaPanel({
  state,
  coverage,
  selectedWindow,
  onRetry,
}: {
  state: AnalyticsPanelState<StatsMediaResponse>;
  coverage: AnalyticsPanelState<readonly CoverageRow[]>;
  selectedWindow: AnalyticsCoverageWindow;
  onRetry: () => void;
}) {
  const verdict = coverageBadgeVerdict(coverage, ANALYTICS_COVERAGE_PLANES.topMedia, selectedWindow);
  const data = panelData(state);

  const rows = useMemo(() => {
    // A bucket carries one row PER SOURCE (FYP and direct), so the day's views
    // are their sum — plotting the rows one after another drew a zig-zag
    // between the two sources instead of a trend.
    const viewsByMedia = new Map<string, Map<string, number>>();
    const mediaWithHeads = new Set<string>();
    const servedKeys = new Set<string>();
    let earliest: string | null = null;
    for (const media of data?.media ?? []) {
      mediaWithHeads.add(media.mediaOfferRef);
      const byBucket = new Map<string, number>();
      for (const bucket of media.buckets) {
        if (bucket.views === null) continue;
        const key = bucketKey(bucket.bucketStart);
        byBucket.set(key, (byBucket.get(key) ?? 0) + bucket.views);
        servedKeys.add(key);
        if (earliest === null || key < earliest) earliest = key;
      }
      viewsByMedia.set(media.mediaOfferRef, byBucket);
    }
    // One timeline for every row, so the sparklines line up by date. When the
    // response ran out of bucket budget, each media got its NEWEST buckets
    // first, so the shared line starts where the oldest served one does —
    // a hole before it would be a cut, not a quiet day.
    const window = data?.window;
    const timeline = window === undefined
      ? []
      : bucketTimeline(
        data?.bucketsTruncated && earliest !== null ? { from: earliest, to: window.to } : window,
        window.periodMs,
        servedKeys,
      );
    const seriesFor = (ref: string): Array<number | null> => {
      const byBucket = viewsByMedia.get(ref);
      if (byBucket === undefined || byBucket.size === 0) return [];
      return timeline.map((key) => byBucket.get(key) ?? null);
    };
    return (data?.top ?? []).slice(0, 15).map((entry) => ({
      ...entry,
      series: seriesFor(entry.mediaOfferRef),
      missingSeriesLabel: !mediaWithHeads.has(entry.mediaOfferRef)
        ? "нет в каталоге"
        : data?.bucketsTruncated === true
          ? "не вошло в ответ"
          : "нет данных за период",
    }));
  }, [data]);

  return (
    <AnalyticsPanel
      title="Топ медиа"
      verdict={verdict}
      cached={state.status === "ready" && state.refreshFailed}
      help={(
        <>
          <p>
            Место в рейтинге — из окна, которое ранжировал сам Fansly. График рядом —
            из данных Hub по каждому медиа за выбранный период.
          </p>
          <p>
            Если графика нет, указано почему: медиа нет в каталоге Hub, данные не вошли
            в ответ из-за его размера, или за период данных нет.
          </p>
        </>
      )}
    >
      {state.status === "loading" ? (
        <AnalyticsLoading />
      ) : state.status === "error" ? (
        <AnalyticsError message={state.message} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <AnalyticsEmpty
          reason={emptyPanelReason(verdict, "Рейтинг медиа за этот период не собран.")}
        />
      ) : (
        <div className={ANALYTICS_TABLE_WRAP}>
          <table className="data-table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Медиа</th>
                <th className="num">Просмотры</th>
                <th className="num">Превью</th>
                <th>Динамика</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.plane}:${row.requestedEnd}:${row.mediaOfferRef}`}>
                  <td className="num muted">{row.rank + 1}</td>
                  <td className="muted font-mono text-xs">{row.mediaOfferRef}</td>
                  <td className="num">{metric(row.views)}</td>
                  <td className="num">{metric(row.previewViews)}</td>
                  <td>
                    {row.series.length > 0
                      ? (
                        <TrendSparkline
                          values={row.series}
                          width={120}
                          height={32}
                          color="var(--color-chart-blue)"
                          label="Просмотры по дням"
                        />
                      )
                      : <span className="text-xs text-text-muted">{row.missingSeriesLabel}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

/**
 * Panel 4 — the page's top FYP tags, and the platform-global counters beside
 * them.
 *
 * Two different populations on one card, deliberately: the left is this page's
 * attribution, the right is how big the tag is on Fansly as a whole. A tag the
 * page ranks for and the platform barely uses is a different opportunity from
 * one where the reverse is true.
 */
export function TopTagsPanel({
  state,
  coverage,
  selectedWindow,
  onRetry,
}: {
  state: AnalyticsPanelState<StatsTagsResponse>;
  coverage: AnalyticsPanelState<readonly CoverageRow[]>;
  selectedWindow: AnalyticsCoverageWindow;
  onRetry: () => void;
}) {
  const verdict = coverageBadgeVerdict(coverage, ANALYTICS_COVERAGE_PLANES.topTags, selectedWindow);
  const data = panelData(state);

  const globalByTag = useMemo(() => {
    const map = new Map<string, { viewCount: number | null; postCount: number | null }>();
    for (const row of data?.platformTags ?? []) {
      // Latest business date wins; the route already ordered them that way.
      if (!map.has(row.tagRef)) {
        map.set(row.tagRef, { viewCount: row.viewCount, postCount: row.postCount });
      }
    }
    return map;
  }, [data]);

  const tags = (data?.topTags ?? []).slice(0, 20);

  return (
    <AnalyticsPanel
      title="Топ тегов FYP"
      verdict={verdict}
      cached={state.status === "ready" && state.refreshFailed}
      help={(
        <>
          <p>
            «Просмотры» — просмотры этой страницы из ленты FYP по тегу. Столбцы
            «Fansly» — общие цифры тега по всей платформе (точное число — при наведении).
          </p>
          <p>
            «Без названия» — тег, название которого Fansly не прислал. Hub не подставляет
            название по номеру, чтобы не выдумывать данные.
          </p>
        </>
      )}
    >
      {state.status === "loading" ? (
        <AnalyticsLoading />
      ) : state.status === "error" ? (
        <AnalyticsError message={state.message} onRetry={onRetry} />
      ) : tags.length === 0 ? (
        <AnalyticsEmpty
          reason={emptyPanelReason(verdict, "Рейтинг тегов за этот период не собран.")}
        />
      ) : (
        // Bounded, with its header pinned: twenty rows at full height made this
        // card a page tall and stretched the FYP chart beside it into a void.
        <div className={`${ANALYTICS_TABLE_WRAP} max-h-[520px] overflow-y-auto`}>
          <table className="data-table data-table-sticky">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Тег</th>
                <th className="num">Просмотры</th>
                <th className="num">Fansly: просмотры</th>
                <th className="num">Fansly: посты</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((tag) => {
                const global = globalByTag.get(tag.tagRef);
                return (
                  <tr key={`${tag.requestedEnd}:${tag.tagRef}`}>
                    <td className="num muted">{tag.rank + 1}</td>
                    <td>
                      {tag.tagName ?? (
                        <span className="whitespace-nowrap text-text-muted" title={`Номер тега: ${tag.tagRef}`}>
                          Без названия
                        </span>
                      )}
                    </td>
                    <td className="num">{metric(tag.views)}</td>
                    <td className="num muted"><GlobalCount value={global?.viewCount ?? null} /></td>
                    <td className="num muted"><GlobalCount value={global?.postCount ?? null} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

/**
 * Panel 6 — content performance.
 *
 * Price, sales count, NET (as served) and GROSS (ours). A12 settled that
 * `saleStats.total` is the creator's net share, so the gross column is a
 * read-time derivation and carries the word "derived" in its own header rather
 * than in a footnote nobody scrolls to. The two are never added together.
 *
 * There is deliberately NO average-watch column here. [E5]: the per-media route
 * serves no video fields at all — the account-level figure lives on the traffic
 * card, where its components actually exist.
 */
/** Appended to anything read off a response whose refresh failed. */
const CACHED_SUFFIX = " (из кэша — не удалось обновить)";

/**
 * What the average-watch header says in each state of ITS query.
 *
 * "not served" is a claim about Fansly's payload and is reserved for a
 * SUCCEEDED request that carried no components. Pending and failed say so —
 * and so does a CACHED response whose refresh failed, which is why the stale
 * check comes before the null one: `{ data: null, refreshFailed: true }` means
 * "the last response we could get carried no components", not "Fansly serves
 * none". The panel's own `cached` badge is about the `media` query and cannot
 * qualify this figure, so the qualifier travels with the label.
 */
function accountWatchLabel(state: AnalyticsPanelState<number | null>): string {
  if (state.status === "loading") {
    return "загружаем…";
  }
  if (state.status === "error") {
    return "недоступно";
  }
  const suffix = state.refreshFailed ? CACHED_SUFFIX : "";
  if (state.data === null) {
    return `Fansly не передаёт${suffix}`;
  }
  return `${formatPercent(state.data)}${suffix}`;
}

export function ContentPerformancePanel({
  state,
  coverage,
  accountWatch,
  selectedWindow,
  onRetry,
}: {
  state: AnalyticsPanelState<StatsMediaResponse>;
  coverage: AnalyticsPanelState<readonly CoverageRow[]>;
  selectedWindow: AnalyticsCoverageWindow;
  /**
   * The account-level watch figure, in the state of the query that carries it.
   *
   * It comes from a DIFFERENT request than this panel's table (`mediaTraffic`,
   * not `media`), and that hidden edge is why it is a state and not a number:
   * `accountWatchPercent === null` used to render "not served" — a verdict
   * about the platform — while the request was merely in flight or failed.
   * `null` inside a succeeded state still means "not served", and only then.
   */
  accountWatch: AnalyticsPanelState<number | null>;
  onRetry: () => void;
}) {
  const verdict = coverageBadgeVerdict(
    coverage,
    ANALYTICS_COVERAGE_PLANES.contentPerformance,
    selectedWindow,
  );
  const data = panelData(state);

  const rows = useMemo(() => (data?.media ?? []).map((media) => {
    let views: number | null = null;
    for (const bucket of media.buckets) {
      if (bucket.views !== null) {
        views = (views ?? 0) + bucket.views;
      }
    }
    return { media, views };
  }), [data]);

  return (
    <AnalyticsPanel
      title="Эффективность контента"
      verdict={verdict}
      cached={state.status === "ready" && state.refreshFailed}
      wide
      headerExtra={(
        <span className="text-[13px] text-text-secondary">
          Средний досмотр{" "}
          <span
            className={
              accountWatch.status === "error"
                ? "font-semibold text-warning-dark"
                : "font-semibold tabular-nums text-text-primary"
            }
          >
            {accountWatchLabel(accountWatch)}
          </span>
          <span className="ml-1 text-text-muted">· по аккаунту, рассчитано Hub</span>
        </span>
      )}
      help={(
        <>
          <p>
            «Доход» — сумма после комиссии, как её отдаёт Fansly. «До комиссии»
            рассчитана в Hub из неё (Fansly берёт 20&nbsp;%): она не хранится и никогда
            не складывается с суммой после комиссии.
          </p>
          <p>
            Средний досмотр — только по аккаунту в целом. По отдельным медиа Fansly
            не отдаёт данных о видео, поэтому число на каждое медиа было бы выдумкой.
          </p>
        </>
      )}
    >
      {state.status === "loading" ? (
        <AnalyticsLoading />
      ) : state.status === "error" ? (
        <AnalyticsError message={state.message} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <AnalyticsEmpty
          reason={emptyPanelReason(verdict, "Медиа этой страницы ещё не собраны.")}
        />
      ) : (
        <div className={ANALYTICS_TABLE_WRAP}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Медиа</th>
                <th className="num">Цена</th>
                <th className="num">Продажи</th>
                <th className="num">Доход после комиссии</th>
                <th className="num">До комиссии (расчёт)</th>
                <th className="num">Просмотры за период</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ media, views }) => (
                <tr key={media.mediaOfferRef}>
                  <td className="muted font-mono text-xs">{media.mediaOfferRef}</td>
                  <td className="num">{money(media.priceMills)}</td>
                  <td className="num">{metric(media.sales.count)}</td>
                  <td className="num">{money(media.sales.netMills)}</td>
                  <td className="num muted">{money(media.sales.grossMills?.value ?? null)}</td>
                  <td className="num">{metric(views)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

/**
 * Panel 7 — comments per post.
 *
 * `possiblyTruncated` is carried per post rather than summarised away: the
 * comment route has no established pagination, so a full page means the WINDOW
 * was captured, never the whole surface, and the doubt belongs to the row that
 * outlives the sweep that created it.
 */
export function CommentsPanel({
  state,
  coverage,
  selectedWindow,
  onRetry,
}: {
  state: AnalyticsPanelState<ContentCommentsResponse>;
  coverage: AnalyticsPanelState<readonly CoverageRow[]>;
  selectedWindow: AnalyticsCoverageWindow;
  onRetry: () => void;
}) {
  const verdict = coverageBadgeVerdict(coverage, ANALYTICS_COVERAGE_PLANES.comments, selectedWindow);
  const data = panelData(state);
  const perPost = (data?.perPost ?? []).slice(0, 20);

  return (
    <AnalyticsPanel
      title="Комментарии к постам"
      verdict={verdict}
      cached={state.status === "ready" && state.refreshFailed}
      help={(
        <>
          <p>
            «Возможно, не все» — у поста была подозрительно полная страница ответов,
            а надёжного способа листать дальше у Fansly нет. Полнота таких постов
            неизвестна, а не подтверждена.
          </p>
          <p>
            «Пропали» — комментарии, которых больше нет на Fansly. Пустые ответы тоже
            считаются: фан, ответивший только вложением, всё равно ответил.
          </p>
        </>
      )}
    >
      {state.status === "loading" ? (
        <AnalyticsLoading />
      ) : state.status === "error" ? (
        <AnalyticsError message={state.message} onRetry={onRetry} />
      ) : perPost.length === 0 ? (
        <AnalyticsEmpty
          reason={emptyPanelReason(verdict, "За этот период комментариев не собрано.")}
        />
      ) : (
        <div className={ANALYTICS_TABLE_WRAP}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Пост</th>
                <th className="num">Комментарии</th>
                <th className="num">Пропали</th>
                <th>Полнота</th>
              </tr>
            </thead>
            <tbody>
              {perPost.map((row) => (
                <tr key={row.postRef}>
                  <td className="muted font-mono text-xs">{row.postRef}</td>
                  <td className="num">{formatCount(row.commentCount)}</td>
                  <td className="num">{formatCount(row.missingCount)}</td>
                  <td>
                    {row.possiblyTruncatedCount > 0 ? (
                      <span className="badge badge-warning">
                        Возможно, не все ({formatCount(row.possiblyTruncatedCount)})
                      </span>
                    ) : (
                      <span className="text-xs text-text-muted">собрано</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

/** No Fansly like code is live-confirmed, so nothing reads likers. */
const LIKERS_VERDICT: CoverageVerdict = {
  state: "not_started",
  label: "Сбор не начат",
  detail:
    "Fansly не подтверждает способ получать лайки, поэтому Hub их не собирает. "
    + "Это известный пробел, а не страница без лайков.",
};

/**
 * Likers — a few lines inside the coverage card, not a panel: the list is
 * empty by design, and a permanently empty chart in the grid says nothing.
 *
 * It reads the SAME request as the comments panel. "Not collected" is a claim
 * about Fansly, and it may only be made once that request has answered — a
 * failed comments request rendering it would turn a network error into a
 * statement about the platform.
 */
export function LikersNote({
  state,
  coverage,
  onRetry,
}: {
  state: AnalyticsPanelState<ContentCommentsResponse>;
  coverage: AnalyticsPanelState<readonly CoverageRow[]>;
  onRetry: () => void;
}) {
  // The likers' verdict is a CONSTANT — no capture-coverage row proves it
  // — but it is still a definitive claim about Fansly, and stating it under a
  // coverage request that is pending or failed is the same lie as a chart that
  // quietly reads "complete". So it goes through the same wrapper as every
  // other badge on the page.
  const likersVerdict = coverageRequestVerdict(coverage, () => LIKERS_VERDICT);
  return (
    <div className="space-y-2" data-likers>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="section-title">Лайки</h3>
        <CoverageBadge verdict={likersVerdict} />
        {state.status === "ready" && state.refreshFailed ? <CachedBadge /> : null}
      </div>
      {state.status === "loading" ? (
        <p className="text-[13px] text-text-muted">Загружаем…</p>
      ) : state.status === "error" ? (
        <AnalyticsError compact message={state.message} onRetry={onRetry} />
      ) : (
        <p className="text-[13px] text-text-secondary">
          {state.data.likers.rows.length
            ? `Записей о лайках: ${formatCount(state.data.likers.rows.length)} (из вебхуков OnlyFans).`
            : "Лайки не собираются: Fansly не подтверждает способ их получать, поэтому "
              + "список лайкнувших всегда пуст. Это известный пробел, а не страница без лайков."}
        </p>
      )}
    </div>
  );
}
