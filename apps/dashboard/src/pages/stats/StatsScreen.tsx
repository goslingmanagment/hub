import type { ReactNode } from "react";
import { Link } from "react-router";
import { RefreshCw } from "lucide-react";

import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatMomentAgo } from "@/lib/format";
import { buildPageCollectionRoute } from "@/lib/navigation";
import { formatStatsDay, formatStatsRange, previousWindow, sentence, type StatsWindow } from "@/components/creator-stats/creator-stats-model";

/** Fansly is read every hour: older than three, and something is wrong with the collection. */
const STALE_AFTER_MS = 3 * 3_600_000;

export function CollectionLink({ pageLabel }: { pageLabel: string }) {
  return <Link className="btn btn-sm" to={buildPageCollectionRoute(pageLabel)}>Сбор данных страницы</Link>;
}

/**
 * The dates of the window beside the header, and «Обновлено …», which reads the
 * tab's queries anew. `compare`: the tabs whose totals Fansly compares
 * (Главное, Доход Fansly) say what with; the others only the dates.
 */
export function StatsHeader({ window, compare, totalsWindow, updatedAt, onRefresh, refreshing, extraNote }: {
  window: StatsWindow;
  compare?: boolean;
  totalsWindow?: { fromDay: string; toDay: string } | null | undefined;
  updatedAt: string | null;
  onRefresh: () => void;
  refreshing: boolean;
  /** A line that would be a third notice, said quietly here instead. */
  extraNote?: string | null | undefined;
}) {
  const dates = formatStatsRange(window.fromDay, window.toDay);
  let text: ReactNode = dates;
  if (compare) {
    if (window.days > 90) {
      text = `${dates}, без сравнения`;
    } else if (totalsWindow === null) {
      text = <>{dates}, без сравнения <span className="page-window-note">· Сводки Fansly за этот период ещё нет: итоги — сумма по дням</span></>;
    } else if (totalsWindow && (totalsWindow.fromDay !== window.fromDay || totalsWindow.toDay !== window.toDay)) {
      text = <>{dates} <span className="page-window-note">· Итоги — за {formatStatsRange(totalsWindow.fromDay, totalsWindow.toDay)}: сводку за новые сутки Fansly ещё не отдал</span></>;
    } else if (totalsWindow) {
      const previous = previousWindow(window);
      text = `${dates}, сравнение с ${formatStatsRange(previous.fromDay, previous.toDay)}`;
    }
  }
  if (extraNote) text = <>{text} <span className="page-window-note">· {extraNote}</span></>;
  // Nothing says when it was read: the same quiet button, only «Обновить».
  if (!updatedAt) {
    text = (
      <>
        {text}
        {typeof text === "string" && text.endsWith(".") ? " " : ". "}
        <button type="button" className="page-fresh" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? "Обновляем…" : "Обновить"}
          <RefreshCw size={14} aria-hidden="true" className={refreshing ? "animate-spin" : ""} />
        </button>
      </>
    );
  }
  return <PageHeader window={text} fresh={updatedAt ? { at: updatedAt, onRefresh, refreshing } : undefined} />;
}

export interface StatsNoticeInput {
  pageLabel: string;
  updatedAt: string | null;
  /** The sentence of an incomplete tab, or null when the data are whole. */
  incomplete: string | null;
  substituted: boolean;
}

/** Whether the stale notice applies: the newest update is older than three hours. */
export function isStale(updatedAt: string | null, now = Date.now()): boolean {
  return updatedAt !== null && now - Date.parse(updatedAt) > STALE_AFTER_MS;
}

/** No more than two notices over the content, the frame's substitution counted:
 *  substitution, stale, incomplete. A third one goes quietly beside the dates. */
export function incompleteGoesQuiet({ updatedAt, incomplete, substituted }: StatsNoticeInput): boolean {
  return incomplete !== null && substituted && isStale(updatedAt);
}

export function StatsNotices(input: StatsNoticeInput) {
  const { pageLabel, updatedAt, incomplete } = input;
  const stale = isStale(updatedAt);
  const quiet = incompleteGoesQuiet(input);
  if (!stale && (incomplete === null || quiet)) return null;
  return (
    <div className="stats-notices">
      {stale && updatedAt && (
        <Notice tone="warning" role="status" action={<CollectionLink pageLabel={pageLabel} />}>
          Статистика {pageLabel} не обновлялась с {formatMomentAgo(updatedAt)}.
        </Notice>
      )}
      {incomplete !== null && !quiet && (
        <Notice tone="warning" role="status" action={<CollectionLink pageLabel={pageLabel} />}>
          {incomplete}
        </Notice>
      )}
    </div>
  );
}

/** «Данные неполные: Hub собирает … с 24 сент. …» when the reading starts inside the window. */
export function incompleteText(pageLabel: string, readFrom: string | null, window: StatsWindow, what: "статистику" | "доход"): string | null {
  if (readFrom === null || readFrom <= window.fromDay) return null;
  return `Данные неполные: Hub собирает ${what} ${pageLabel} с ${sentence(formatStatsDay(readFrom))} Дни раньше — пропуск${what === "статистику" ? " на графиках" : ""}, а не ноль.`;
}

/**
 * One query's state at the top of a tab: the skeleton the first time, «Hub не
 * ответил» without data, the stale notice with data, «ещё не собирал» when
 * there is nothing and nothing was ever read.
 */
export function QueryGate<T>({ query, pageLabel, neverCollected, skeleton, children }: {
  query: { data: T | undefined; isPending: boolean; isError: boolean; isPlaceholderData: boolean; refetch: () => unknown; dataUpdatedAt: number };
  pageLabel: string;
  neverCollected?: ((data: T) => boolean) | undefined;
  skeleton: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.data === undefined) {
    if (query.isError) return <NoAnswerPanel retry={() => query.refetch()} />;
    return <>{skeleton}</>;
  }
  if (neverCollected?.(query.data)) {
    return (
      <StatusPanel
        title={`Hub ещё не собирал статистику ${pageLabel}`}
        description="Как только сбор прочитает страницу, числа появятся здесь."
        action={<CollectionLink pageLabel={pageLabel} />}
      />
    );
  }
  return (
    <>
      <QueryNotice error={query.isError} stale retry={query.refetch} at={query.dataUpdatedAt} />
      <div className={query.isPlaceholderData ? "is-refreshing" : undefined}>{children(query.data)}</div>
    </>
  );
}

/** A strip of tiles on its way: the same four places. */
export function TilesSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="stat-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="stat">
          <Skeleton width={96} />
          <div className="mt-2"><Skeleton width={120} className="stats-skeleton-value" /></div>
          <div className="mt-2"><Skeleton width={80} /></div>
        </div>
      ))}
    </div>
  );
}

/** A card with a chart on its way. */
export function CardSkeleton({ height = 260, wide = false }: { height?: number; wide?: boolean }) {
  return (
    <div className={`card${wide ? " stats-wide" : ""}`} aria-hidden="true">
      <div className="card-header"><Skeleton width={180} /></div>
      <div className="card-body"><Skeleton width="100%" className="stats-skeleton-chart" /><div style={{ height: height - 12 }} /></div>
    </div>
  );
}

/** «Как это считается» at the bottom of a tab, closed. */
export function HowCounted({ children }: { children: ReactNode }) {
  return <Disclosure label="Как это считается">{children}</Disclosure>;
}
