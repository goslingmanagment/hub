import { useState } from "react";
import { Link, useParams } from "react-router";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { useOfLinkChannels, useOfLinks } from "@/api/ofLinks";
import { KernelApiError } from "@/api/sdk";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { formatMills } from "@/lib/format";
import { SOURCE_PAYMENTS_SHOWN, sourceChart, sourcePageView, sourceRange, SOURCE_WEEKS, type SourceMetric, type SourcePageView } from "./sourceView.js";
import { WeeksChart } from "./WeeksChart.js";

const METRICS: ReadonlyArray<{ value: SourceMetric; label: string; title: string }> = [
  { value: "fans", label: "Фаны", title: "Новые фаны по дням" },
  { value: "clicks", label: "Клики", title: "Клики по дням" },
  { value: "money", label: "Доход", title: "Доход по дням" },
];

/**
 * The page of one source (Трафик → Источники → a source): what it brought against what its contractor was paid,
 * its days over eight weeks, its links, the journal's payments and its contractors. Reads of the link series
 * (`ofLinksChannelsGet` with `channelKey`; the all-time one asks the ledger what was paid) and the links' latest
 * read (`ofLinksGet`): no request reaches OnlyFans. What is drawn comes from sourceView.ts.
 */
export function TrafficSourcePage() {
  const key = useParams().key ?? "";
  const valid = /^[a-z0-9][a-z0-9_-]{0,63}\.[a-z0-9][a-z0-9_-]{0,63}$/.test(key);
  const range = sourceRange(moscowToday());
  const recent = useOfLinkChannels({ ...range, days: true, channelKey: key }, { enabled: valid });
  const counter = recent.data?.channels[0]?.counterPage != null;
  // All time, with what was paid and the journal's rows; a counter source's days too (its total is their sum).
  const allTime = useOfLinkChannels({ paid: true, payments: true, channelKey: key, days: counter }, { enabled: valid && recent.data !== undefined });
  const links = useOfLinks(undefined, { enabled: valid });
  const [metric, setMetric] = useState<SourceMetric>("fans");
  const [allPayments, setAllPayments] = useState(false);

  if (!valid) return <StatusPanel title="Такого источника нет" />;
  if (!recent.data) {
    if (recent.error instanceof KernelApiError && recent.error.status === 404) return <StatusPanel title="Такого источника нет" />;
    return recent.isError ? <NoAnswerPanel retry={recent.refetch} /> : <TableSkeleton rows={6} columns={4} />;
  }
  const view = sourcePageView({
    channelKey: key,
    recent: recent.data,
    allTime: allTime.data,
    links: links.data?.links,
    pageLabels: new Map((links.data?.pages ?? []).map((page) => [page.pageId, page.pageLabel])),
  });
  const shown = view.counter ? "fans" : metric;
  const chosen = METRICS.find((item) => item.value === shown)!;
  const chart = sourceChart(recent.data, shown);
  const chartTitle = view.counter ? "Новые подписчики по дням" : chosen.title;

  return (
    <div className="ts-screen">
      <PageHeader
        title={view.title}
        description={view.facts.length > 0 ? <span className="tl-facts">{view.facts.join(" · ")}</span> : undefined}
        fresh={{ at: view.dataAt ?? recent.data.generatedAt }}
      />
      <QueryNotice
        error={recent.isError || allTime.isError || links.isError}
        stale
        retry={() => Promise.all([recent.refetch(), allTime.refetch(), links.refetch()])}
        at={recent.dataUpdatedAt}
      />
      <div className="ts-sheet tl-sheet tsrc-sheet card">
        <div className="tl-figures">
          {allTime.data ? (
            <>
              <div className="tl-figure-row">
                {view.figures.map((figure) => (
                  <p key={figure.word} className={figure.value === null ? "tl-figure tl-figure-unknown" : "tl-figure"}>
                    {figure.value !== null && <b>{figure.value}</b>} {figure.word}
                    {figure.flag && <span className="tsrc-flag"> {figure.flag}</span>}
                  </p>
                ))}
              </div>
              {view.clicks && <p className="tl-clicks">{view.clicks} за всё время</p>}
            </>
          ) : allTime.isError ? <NoAnswerPanel retry={allTime.refetch} /> : <TableSkeleton rows={1} columns={3} />}
        </div>

        <section className="tl-section" aria-label={chartTitle}>
          <div className="tl-section-head">
            <h2 className="tl-section-title">{chartTitle}</h2>
            {!view.counter && <Segmented label="Что показывает линия" value={metric} onChange={setMetric} options={METRICS} />}
          </div>
          <WeeksChart
            key={shown}
            slots={chart.slots}
            values={chart.values}
            hints={chart.hints}
            max={chart.max}
            weeks={chart.weeks.map((week) => ({ label: week.label, text: week.text, note: week.note, running: week.figure.running }))}
            title={`${chartTitle} за ${SOURCE_WEEKS} недель`}
            {...(shown === "money" ? { format: formatMills } : {})}
          />
        </section>

        <LinksSection view={view} />
        <PaymentsSection view={view} all={allPayments} showAll={() => setAllPayments(true)} loading={!allTime.data} />
        {view.contractors.length > 0 && <ContractorsSection view={view} />}
      </div>
    </div>
  );
}

function LinksSection({ view }: { view: SourcePageView }) {
  return (
    <section className="tl-section" aria-label="Ссылки">
      <h2 className="tl-section-title">Ссылки</h2>
      {view.links.length === 0 ? <p className="tsrc-quiet">Ссылок нет</p> : (
        <div className="table-wrap">
          <table className="data-table tsrc-links">
            <thead>
              <tr>
                <th scope="col">Ссылка</th>
                <th scope="col">Страница</th>
                <th scope="col">Состояние</th>
                <th scope="col" className="num">Клики</th>
                <th scope="col" className="num">Фаны</th>
                <th scope="col" className="num">Принесли</th>
              </tr>
            </thead>
            <tbody>
              {view.links.map((link) => (
                <tr key={link.key} className={link.quiet ? "tsrc-link-quiet" : undefined}>
                  <td><Link className="link" to={link.to}>{link.name}</Link></td>
                  <td>{link.page}</td>
                  <td>{link.state ?? "—"}</td>
                  <td className="num">{link.clicks}</td>
                  <td className="num">{link.fans}</td>
                  <td className="num">{link.brought}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PaymentsSection({ view, all, showAll, loading }: { view: SourcePageView; all: boolean; showAll: () => void; loading: boolean }) {
  const payments = view.payments;
  if (!loading && payments.state === "quiet" && payments.text === null) return null;
  return (
    <section className="tl-section" aria-label="Оплаты">
      <h2 className="tl-section-title">Оплаты</h2>
      {loading ? <TableSkeleton rows={2} columns={3} /> : payments.state === "quiet" ? <p className="tsrc-quiet">{payments.text}</p> : (
        <>
          <ul className="tsrc-payments">
            {(all ? payments.rows : payments.rows.slice(0, SOURCE_PAYMENTS_SHOWN)).map((row) => (
              <li key={row.key} className="tsrc-payment">
                <span className="tsrc-payment-date">{row.date}</span>
                <span className={row.refund ? "tsrc-payment-amount tsrc-refund" : "tsrc-payment-amount"}>
                  {row.amount}
                  {row.pending && <span className="tsrc-pending"> ждёт оплаты</span>}
                </span>
                <span className="tsrc-payment-note" title={row.note ?? undefined}>
                  {row.contractor && <span className="tsrc-payment-who">{row.contractor}{row.note ? " · " : ""}</span>}
                  {row.note}
                </span>
              </li>
            ))}
          </ul>
          {!all && payments.rows.length > SOURCE_PAYMENTS_SHOWN && (
            <button type="button" className="btn btn-sm btn-ghost tsrc-more" onClick={showAll}>
              Показать все {payments.rows.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ContractorsSection({ view }: { view: SourcePageView }) {
  return (
    <section className="tl-section" aria-label="Подрядчики">
      <h2 className="tl-section-title">Подрядчики</h2>
      <ul className="tsrc-contractors">
        {view.contractors.map((row) => (
          <li key={row.key} className="tsrc-contractor">
            <span className="tsrc-contractor-name">{row.name}</span>
            <span className="tsrc-contractor-when">{row.when}</span>
            <span className="tsrc-contractor-figures">
              <span>{row.fans}</span>
              <span>{row.brought}</span>
              <span>{row.paid}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
