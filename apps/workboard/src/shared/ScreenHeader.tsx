import { useEffect, type ReactNode } from "react";
import { PeriodControl, useFullWindow } from "@agency_hub_core/ui";
import { Freshness } from "./Freshness.js";
import { BackLink, type BackTarget } from "./links.js";
import { PageFilter, PageFilterSlot } from "./PageFilter.js";
import { usePeriod } from "./usePeriod.js";

export interface ScreenHeaderProps {
  /** h1: the screen's name («Смены»), or the object itself on a deep screen («alex.k»). Never «Команда». */
  title: ReactNode;
  /** The browser tab: «Смены — Workboard». Defaults to the title when it is text. */
  documentTitle?: string;
  /** «←» of a deep screen (useBackTarget). */
  back?: BackTarget;
  /** Show the period control (most screens). */
  period?: boolean;
  /** Show the page filter. */
  pageFilter?: boolean;
  /**
   * The screen's one main action (or a menu). Without a page filter it stands at
   * the right end, in the filter's place (D15) — keep it short (a verb and an
   * icon, ≤ ~150 px: «Скопировать», «Пригласить»), or the period moves on this
   * screen; the longer words go into its tooltip or the line under the title.
   * With a filter it stands left of the period.
   */
  actions?: ReactNode;
  /** Under the title, left: one sentence of purpose, or facts of a deep screen. Defaults to the period's dates. */
  meta?: ReactNode;
  /** `dataUpdatedAt` of the screen's main read. */
  updatedAt?: number;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** The screen's last read again failed: «Не обновилось — данные на 23:41». */
  stale?: boolean;
  /** Below the header line, still above the content: tabs of the screen. */
  tabs?: ReactNode;
  /**
   * A working screen that fills the window (Разбор): the frame is the window's
   * height, the page does not scroll, `.wb-content` takes the rest and the
   * screen's panes scroll inside it (`useFullWindow` of packages/ui).
   */
  fill?: boolean;
}

/**
 * The header of every screen (spec §3): the title on the left; the period and
 * the page filter's place on the right. That place is as wide as the closed
 * filter everywhere and holds the filter, or the screen's one action when the
 * screen has no filter (D15), so the period stands in one spot on every screen.
 * The bar sticks while the page scrolls; the dates and «Обновлено …» stand under it.
 */
export function ScreenHeader({ title, documentTitle, back, period = false, pageFilter = false, actions, meta, updatedAt, onRefresh, refreshing, stale = false, tabs, fill = false }: ScreenHeaderProps) {
  const { spec, period: resolved, today, setPeriod } = usePeriod();
  useFullWindow(fill);
  const name = documentTitle ?? (typeof title === "string" ? title : undefined);
  useEffect(() => {
    if (name) document.title = `${name} — Workboard`;
  }, [name]);

  // The dates themselves stand in the period control; here only what they are compared with.
  const dates = period ? (
    <span>
      {resolved.current && spec.kind === "week" ? "Эта неделя · сравнение" : "Сравнение"} с {resolved.previousLabel}
    </span>
  ) : null;

  return (
    <>
      <header className="wb-header">
        <div className="wb-header__bar">
          <div className="wb-header__titles">
            {back && <BackLink back={back} />}
            <h1 className="wb-header__title">{title}</h1>
          </div>
          <div className="wb-header__controls">
            {pageFilter && actions}
            {period && <PeriodControl value={spec} today={today} onChange={setPeriod} />}
            {/*
              The right end is the page filter's place, as wide as the closed filter on every screen (D15): the filter;
              on a screen without one, the screen's action; else empty. So the period never moves — not between
              screens, not when a page is picked, not when the period changes.
            */}
            {(pageFilter || period || actions !== undefined) && (
              <span className="wb-header__slot">
                <PageFilterSlot />
                {pageFilter ? <PageFilter /> : actions}
              </span>
            )}
          </div>
        </div>
      </header>
      {(meta !== undefined || dates !== null || updatedAt) && (
        <div className="wb-meta">
          <div className="wb-meta__left">{meta ?? dates}</div>
          <Freshness updatedAt={updatedAt} {...(onRefresh ? { onRefresh } : {})} refreshing={refreshing ?? false} stale={stale} />
        </div>
      )}
      {tabs !== undefined && <div className="wb-tabs">{tabs}</div>}
    </>
  );
}
