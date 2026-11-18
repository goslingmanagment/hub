import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { useOfLinkChannels } from "@/api/ofLinks";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { formatMills } from "@/lib/format";
import { DayLine } from "./DayLine.js";
import { coverageLine, SLOT_COUNT, sourcesRange, sourcesView, type RestLine, type SourceView } from "./sourcesView.js";
import { fansWord, linkPagePath, type DaySlot } from "./trafficDays.js";

/**
 * Трафик → Источники: for each source of the OnlyFans pages, which of its
 * links brought fans and on which day, over this week and the last. Two local
 * reads of the link series (`ofLinksChannelsGet`): no request reaches
 * OnlyFans. What is drawn comes from sourcesView.ts; this file only draws it.
 */
export function TrafficSourcesPage() {
  const range = sourcesRange(moscowToday());
  const recent = useOfLinkChannels({ ...range, days: true });
  const allTime = useOfLinkChannels({});
  const { pages } = useDashboardShell();
  const [refreshing, setRefreshing] = useState(false);

  if (!recent.data) {
    return recent.isError ? <NoAnswerPanel retry={recent.refetch} /> : <TableSkeleton rows={8} columns={3} />;
  }
  const view = sourcesView(recent.data, allTime.data);
  const todayIndex = view.slots.findIndex((slot) => slot.when === "today");
  const sheetStyle = { "--ts-slots": SLOT_COUNT, "--ts-today": todayIndex } as CSSProperties;
  const covered = coverageLine(view.pages, (label) => pages.find((page) => page.label === label)?.modelName ?? null);
  const nothing = view.sources.length === 0 && view.silent.length === 0 && view.linkless.length === 0
    && view.stopped.length === 0 && view.unread.length === 0 && view.unbound === null;

  return (
    <div className="ts-screen">
      <PageHeader
        window={covered ?? undefined}
        fresh={{
          at: view.dataAt ?? recent.data.generatedAt,
          refreshing,
          onRefresh: () => {
            setRefreshing(true);
            void Promise.all([recent.refetch(), allTime.refetch()]).finally(() => setRefreshing(false));
          },
        }}
      />
      <QueryNotice error={recent.isError || allTime.isError} stale retry={() => Promise.all([recent.refetch(), allTime.refetch()])} at={recent.dataUpdatedAt} />
      <div className="ts-sheet card" style={sheetStyle}>
        <div className="ts-grid ts-top">
          <span className="ts-top-label">Новые фаны по дням</span>
          <div className="ts-weeks">
            <span><b>Прошлая неделя</b> {view.lastWeek}</span>
            <span><b>Эта неделя</b> {view.thisWeek}</span>
          </div>
          <span />
        </div>
        {nothing && <StatusPanel title="Источников пока нет" />}
        {view.sources.map((source) => <Source key={source.key} source={source} slots={view.slots} since={view.since} />)}
        <Rest view={view} />
      </div>
    </div>
  );
}

function Money({ source, since }: { source: SourceView; since: string }) {
  const money = source.money;
  if (money === null) return null;
  const same = money.allMills === null ? false : money.allMills === money.recentMills;
  return (
    <span className="ts-source-money">
      {same
        ? <>принесли <b>{formatMills(money.recentMills)}</b></>
        : <>принесли {since} <b>{formatMills(money.recentMills)}</b>{money.allMills !== null && <>, всего <b>{formatMills(money.allMills)}</b></>}</>}
      {money.partial && <span className="ts-source-partial"> не по всем ссылкам</span>}
    </span>
  );
}

function WeekSum({ week }: { week: SourceView["weeks"][number] }) {
  if (week.fans === null) return <span>—</span>;
  const [count, ...word] = fansWord(week.fans).split(" ");
  return <span><b>{count}</b> {word.join(" ")}{week.running ? ", идёт" : ""}</span>;
}

function Source({ source, slots, since }: { source: SourceView; slots: readonly DaySlot[]; since: string }) {
  // A narrow sheet scrolls the plot sideways: it opens on the latest days, today at the right edge.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    const today = box?.querySelector(".ts-day-today");
    const plot = box?.querySelector(".ts-day-labels");
    const name = box?.querySelector(".ts-name");
    if (!box || !today || !plot || !name || box.scrollWidth <= box.clientWidth) return;
    const boxRect = box.getBoundingClientRect();
    const want = box.scrollLeft + today.getBoundingClientRect().right - boxRect.right + 16;
    if (want <= 0) return;
    // Snapped to a whole day: the first day beside the names is never half under them.
    const plotLeft = plot.getBoundingClientRect().left - boxRect.left + box.scrollLeft;
    const slot = plot.getBoundingClientRect().width / SLOT_COUNT;
    const covered = name.getBoundingClientRect().width;
    box.scrollLeft = Math.max(0, plotLeft + Math.ceil((want + covered - plotLeft) / slot) * slot - covered);
  }, []);
  return (
    <section className="ts-source" aria-label={source.title}>
      <header className="ts-source-head">
        <h2 className="ts-source-title">{source.title}</h2>
        {source.contractor && <span className="ts-source-contractor">{source.contractor}</span>}
        {source.attention && <span className="ts-source-attention">{source.attention}</span>}
        <Money source={source} since={since} />
      </header>
      <div className="ts-scroll" ref={scroller}>
        <div className="ts-grid ts-days">
          <span className="ts-name" />
          <div className="ts-plot ts-day-labels">
            <div className="ts-week-sums">
              {source.weeks.map((week, index) => <WeekSum key={index} week={week} />)}
            </div>
            <div className="ts-day-row" aria-hidden="true">
              {slots.map((slot) => {
                const [weekday, day] = slot.label.split(" ");
                return <span key={slot.date} className={`ts-day ts-day-${slot.when}`}><span className="ts-day-weekday">{weekday}</span> {day}</span>;
              })}
            </div>
          </div>
          <span className="ts-total ts-caption">{since}</span>
        </div>
        {source.rows.map((row) => {
          const body = (
            <>
              <span className="ts-name">
                {row.name}
                {row.page && <span className="ts-name-page">{row.page}</span>}
              </span>
              <div className="ts-plot">
                <DayLine
                  values={row.fans}
                  slots={slots}
                  max={row.large ? Math.max(1, ...row.fans.map((value) => value ?? 0)) : source.smallMax}
                  size={row.large ? "large" : "small"}
                  labels={row.large ? "all" : "nonzero"}
                  area={row.large}
                  hints={row.hints}
                  title={`${row.name}: новые фаны по дням, ${since} ${row.total ?? "нет данных"}`}
                />
              </div>
              <span className="ts-total">{row.total ?? "—"}</span>
            </>
          );
          const className = `ts-grid ts-row${row.large ? " ts-row-large" : ""}`;
          return row.link === null
            ? <div key={row.key} className={className}>{body}</div>
            : <Link key={row.key} className={`${className} ts-row-link`} to={linkPagePath(row.link)}>{body}</Link>;
        })}
      </div>
      {(source.noFans || source.noClicks) && (
        <div className="ts-quiet">
          {source.noFans && <p>{source.noFans}</p>}
          {source.noClicks && <p>{source.noClicks}</p>}
        </div>
      )}
    </section>
  );
}

function RestBlock({ title, lines, attention = false, tail }: { title: string; lines: readonly RestLine[]; attention?: boolean; tail?: string | null }) {
  if (lines.length === 0 && !tail) return null;
  return (
    <section className="ts-rest-block" aria-label={title}>
      <h3 className={attention ? "ts-rest-title ts-rest-attention" : "ts-rest-title"}>{title}</h3>
      <ul className="ts-rest-lines">
        {lines.map((line) => (
          <li key={line.key} className="ts-rest-line">
            <span className="ts-rest-name">{line.name}</span>
            <span className="ts-rest-fact">{line.fact}</span>
            <span className="ts-rest-figures">
              {line.figures.map((figure, index) => <span key={index}>{figure}</span>)}
            </span>
          </li>
        ))}
        {tail && (
          <li className="ts-rest-line ts-rest-tail">
            <span className="ts-rest-name" />
            <span className="ts-rest-fact">{tail}</span>
            <span />
          </li>
        )}
      </ul>
    </section>
  );
}

function Rest({ view }: { view: ReturnType<typeof sourcesView> }) {
  const rest = view.unbound?.rest ?? 0;
  return (
    <div className="ts-rest">
      <RestBlock title="Молчат" lines={view.silent} attention />
      <RestBlock title="Без ссылки" lines={view.linkless} />
      <RestBlock title="Нет чтений" lines={view.unread} />
      <RestBlock title="Остановлены" lines={view.stopped} />
      {view.unbound && (
        <RestBlock
          title="Без источника"
          lines={view.unbound.lines}
          tail={rest > 0 ? `${view.unbound.lines.length > 0 ? "ещё " : ""}${rest} без движения` : null}
        />
      )}
    </div>
  );
}
