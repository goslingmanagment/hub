import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useParams } from "react-router";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { useOfLinkHistory, useOfLinks } from "@/api/ofLinks";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { formatMills } from "@/lib/format";
import { LinkDetails } from "@/pages/marketing/OfLinksTable";
import { DayLine } from "./DayLine.js";
import { LinkFacts } from "./LinkFacts.js";
import { LinkFans } from "./LinkFans.js";
import { linkChartView, linkHead, linkRange, LINK_WEEKS, type LinkMetric } from "./linkView.js";

const METRICS: ReadonlyArray<{ value: LinkMetric; label: string; title: string }> = [
  { value: "fans", label: "Фаны", title: "Новые фаны по дням" },
  { value: "clicks", label: "Клики", title: "Клики по дням" },
  { value: "money", label: "Доход", title: "Доход по дням" },
];

/**
 * The page of one OnlyFans link (Трафик → Источники → a link): what it is, what
 * it brought over its life, its days over eight weeks, its money as OnlyFans
 * and Hub count it, its fans, and the table of days; a link without a source
 * gets its first one here. Local reads only (`ofLinksGet`, `ofLinksHistoryGet`,
 * `ofLinkFansGet`, `ofLinkSourceGet`): no request reaches OnlyFans.
 */
export function TrafficLinkPage() {
  const params = useParams();
  const pageId = Number(params.pageId);
  const linkKind = params.kind === "trial" ? "trial" : "tracking";
  const linkRef = params.ref ?? "";
  const valid = Number.isInteger(pageId) && pageId > 0 && (params.kind === "trial" || params.kind === "tracking") && /^[0-9]{1,20}$/.test(linkRef);
  const range = linkRange(moscowToday());
  const links = useOfLinks(valid ? pageId : undefined, { enabled: valid });
  const history = useOfLinkHistory({ pageId, linkKind, linkRef, ...range }, { enabled: valid });
  const [metric, setMetric] = useState<LinkMetric>("fans");

  if (!valid) return <StatusPanel title="Такой ссылки нет" />;
  if (!links.data) {
    return links.isError ? <NoAnswerPanel retry={links.refetch} /> : <TableSkeleton rows={6} columns={4} />;
  }
  const link = links.data.links.find((item) => item.pageId === pageId && item.linkKind === linkKind && item.linkRef === linkRef);
  if (!link) return <StatusPanel title="Такой ссылки нет" description="Сбор ссылок OnlyFans её не видел." />;
  const pageLabel = links.data.pages.find((page) => page.pageId === pageId)?.pageLabel ?? null;
  const head = linkHead(link, pageLabel);
  const now = Date.parse(links.data.generatedAt);
  const chosen = METRICS.find((item) => item.value === metric)!;

  return (
    <div className="ts-screen">
      <PageHeader
        title={head.name}
        description={<LinkFacts head={head} link={{ pageId, linkKind, linkRef }} />}
        fresh={{ at: link.observedAt }}
      />
      <QueryNotice error={links.isError || history.isError} stale retry={() => Promise.all([links.refetch(), history.refetch()])} at={links.dataUpdatedAt} />
      <div className="ts-sheet tl-sheet card">
        {link.url && (
          <p className="tl-url">
            <a className="link" href={link.url} target="_blank" rel="noreferrer">{link.url.replace(/^https?:\/\//, "")}</a>
            <button
              type="button"
              className="btn btn-sm btn-ghost tl-copy"
              onClick={() => {
                void navigator.clipboard.writeText(link.url ?? "").then(
                  () => toast.success("Ссылка скопирована"),
                  () => toast.error("Не удалось скопировать"),
                );
              }}
            >
              <Copy size={14} aria-hidden="true" />
              Копировать
            </button>
          </p>
        )}

        <div className="tl-figures">
          <div className="tl-figure-row">
            {head.figures.map((figure) => (
              <p key={figure.word} className={figure.value === null ? "tl-figure tl-figure-unknown" : "tl-figure"}>
                {figure.value !== null && <b>{figure.value}</b>} {figure.word}
              </p>
            ))}
          </div>
          <p className="tl-clicks">{head.clicks} за всё время ссылки</p>
        </div>

        <section className="tl-section" aria-label={chosen.title}>
          <div className="tl-section-head">
            <h2 className="tl-section-title">{chosen.title}</h2>
            <Segmented label="Что показывает линия" value={metric} onChange={setMetric} options={METRICS} />
          </div>
          {history.data ? <Chart history={history.data} metric={metric} /> : history.isError
            ? <NoAnswerPanel retry={history.refetch} />
            : <TableSkeleton rows={3} columns={LINK_WEEKS} />}
        </section>

        <section className="tl-section" aria-label="Деньги">
          <h2 className="tl-section-title">Деньги</h2>
          <LinkDetails link={link} now={now} withHub />
        </section>

        <LinkFans pageId={pageId} linkKind={linkKind} linkRef={linkRef} pageLabel={pageLabel} />

        {history.data && <DaysTable history={history.data} />}
      </div>
    </div>
  );
}

function Chart({ history, metric }: { history: NonNullable<ReturnType<typeof useOfLinkHistory>["data"]>; metric: LinkMetric }) {
  const view = linkChartView(history, metric);
  const todayIndex = view.slots.findIndex((slot) => slot.when === "today");
  const style = { "--ts-slots": view.slots.length, "--ts-today": todayIndex } as CSSProperties;
  // A narrow sheet scrolls the chart sideways: it opens on the latest weeks.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && box.scrollWidth > box.clientWidth) box.scrollLeft = box.scrollWidth;
  }, []);
  return (
    <div className="tl-chart-scroll" ref={scroller}>
      <div className="tl-chart" style={style}>
        <div className="ts-plot">
          <DayLine
            values={view.values}
            slots={view.slots}
            max={view.max}
            size="page"
            labels="weekPeak"
            area
            hints={view.hints}
            title={`${METRICS.find((item) => item.value === metric)!.title} за восемь недель`}
            format={metric === "money" ? formatMills : String}
          />
        </div>
        <div className="ts-plot tl-weeks">
          {view.weeks.map((week) => (
            <div key={week.label} className={week.running ? "tl-week tl-week-running" : "tl-week"}>
              <span className="tl-week-sum">{week.sum}{week.running ? ", идёт" : ""}</span>
              <span className="tl-week-dates">{week.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DaysTable({ history }: { history: NonNullable<ReturnType<typeof useOfLinkHistory>["data"]> }) {
  const rows = linkChartView(history, "fans").table;
  return (
    <section className="tl-section" aria-label="По дням">
      <h2 className="tl-section-title">По дням</h2>
      <div className="table-wrap">
        <table className="data-table tl-days">
          <thead>
            <tr>
              <th scope="col">День</th>
              <th scope="col" className="num">Клики</th>
              <th scope="col" className="num">Фаны</th>
              <th scope="col" className="num">Доход</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date}>
                <td>{row.label}</td>
                {row.missing
                  ? <td className="num tl-missing" colSpan={3}>{row.missing}</td>
                  : <>
                    <td className="num">{row.clicks}</td>
                    <td className="num">{row.fans}</td>
                    <td className="num">{row.money}</td>
                  </>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
