import type { ReactNode } from "react";
import { Link } from "react-router";
import type { TeamSalesPpvResponse, TeamSalesRepliesResponse } from "@agency_hub_core/contracts";
import { sumMills } from "@agency_hub_core/shared";
import { useTeamSalesPpv, useTeamSalesReplies } from "@/api/team-sales";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { DisclosureCard } from "@/components/ui/DisclosureCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatCount, formatMills, formatPercent, formatWindowRange } from "@/lib/format";
import { DELAY_LABELS, PRICE_LABELS, bestPriceBucket, replyContrast } from "@/pages/account/stats/statsView";
import { PageLink } from "./teamLinks.js";

/**
 * Команда → Продажи → Цена и скорость: which price of a paid message and which
 * speed of a reply bring purchases, page by page. Read-only; the owner and team
 * leads. The server reads every page; a chosen page narrows the rows here.
 */

type PpvPage = TeamSalesPpvResponse["pages"][number];
type PpvCell = PpvPage["byPrice"][number];
type ReplyPage = TeamSalesRepliesResponse["pages"][number];
type ReplyCell = ReplyPage["byDelay"][number];

interface Ppv { sent: number; bought: number; netMills: number | bigint }
interface Replies { replies: number; bought: number }

function percentOf(part: number, whole: number): string {
  return formatPercent((100 * part) / whole);
}

/** The counts of a column summed over pages; the money through sumMills. */
function sumPpv(cells: readonly Ppv[]): Ppv {
  return {
    sent: cells.reduce((sum, cell) => sum + cell.sent, 0),
    bought: cells.reduce((sum, cell) => sum + cell.bought, 0),
    netMills: sumMills(cells.map((cell) => cell.netMills)),
  };
}

function sumReplies(cells: readonly Replies[]): Replies {
  return { replies: cells.reduce((sum, cell) => sum + cell.replies, 0), bought: cells.reduce((sum, cell) => sum + cell.bought, 0) };
}

/** Every page's buckets added together, bucket by bucket. */
function allPpv(rows: ReadonlyArray<readonly PpvCell[]>): Array<Ppv & { bucket: string }> {
  return (rows[0] ?? []).map((cell, index) => ({ bucket: cell.bucket, ...sumPpv(rows.map((row) => row[index] ?? { sent: 0, bought: 0, netMills: 0 })) }));
}

function allReplies(rows: ReadonlyArray<readonly ReplyCell[]>): Array<Replies & { bucket: string }> {
  return (rows[0] ?? []).map((cell, index) => ({ bucket: cell.bucket, ...sumReplies(rows.map((row) => row[index] ?? { replies: 0, bought: 0 })) }));
}

function PpvTd({ cell, strong }: { cell: Ppv; strong?: boolean }) {
  if (cell.sent === 0) return <td className="num muted">—</td>;
  return (
    <td className="num num-wrap">
      <span className={strong ? "font-semibold" : undefined}>{percentOf(cell.bought, cell.sent)}</span>
      <span className="team-sub">{formatCount(cell.bought)} из {formatCount(cell.sent)}{cell.bought > 0 ? `, ${formatMills(cell.netMills)}` : ""}</span>
    </td>
  );
}

function ReplyTd({ cell, strong }: { cell: Replies; strong?: boolean }) {
  if (cell.replies === 0) return <td className="num muted">—</td>;
  return (
    <td className="num">
      <span className={strong ? "font-semibold" : undefined}>{percentOf(cell.bought, cell.replies)}</span>
      <span className="team-sub">{formatCount(cell.bought)} из {formatCount(cell.replies)}</span>
    </td>
  );
}

interface MatrixRow<T> { key: string; label: ReactNode; cells: readonly T[]; total: T; all?: boolean }

function Matrix<T>({ columns, rows, cell }: { columns: readonly string[]; rows: readonly MatrixRow<T>[]; cell: (value: T, strong?: boolean) => ReactNode }) {
  return (
    <div className="table-wrap">
      <table className="data-table team-sticky-first">
        <thead>
          <tr>
            <th scope="col">Страница</th>
            {columns.map((column) => <th key={column} scope="col" className="num">{column}</th>)}
            <th scope="col" className="num">Всего</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={`align-top ${row.all ? "row-group" : ""}`}>
              <td>{row.label}</td>
              {row.cells.map((value, index) => <Cellular key={columns[index] ?? index}>{cell(value)}</Cellular>)}
              {cell(row.total, true)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cellular({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function ppvTotalOf(cells: readonly PpvCell[]): Ppv {
  return sumPpv(cells);
}

function ppvRows(pages: readonly PpvPage[], cellsOf: (page: PpvPage) => readonly PpvCell[], totalOf: (page: PpvPage) => Ppv, withAuthorless: boolean): MatrixRow<Ppv>[] {
  const rows: MatrixRow<Ppv>[] = pages.map((page) => ({
    key: page.pageLabel,
    label: (
      <>
        <PageLink label={page.pageLabel} />
        {withAuthorless && page.withoutAuthor > 0 && <span className="team-sub">без автора {formatCount(page.withoutAuthor)}</span>}
      </>
    ),
    cells: cellsOf(page),
    total: totalOf(page),
  }));
  if (pages.length < 2) return rows;
  const all = allPpv(pages.map(cellsOf));
  return [{ key: "all", label: <span className="font-medium">Все страницы</span>, cells: all, total: sumPpv(all), all: true }, ...rows];
}

function PpvBlock({ days, page, onAllPages }: { days: number; page: string | null; onAllPages: () => void }) {
  const query = useTeamSalesPpv(days);
  const { data, isLoading, isError, refetch, dataUpdatedAt } = query;
  const pages = (data?.pages ?? []).filter((one) => page === null || one.pageLabel === page);
  const columns = (data?.pages[0]?.byPrice ?? []).map((cell) => PRICE_LABELS[cell.bucket] ?? cell.bucket);
  let body: ReactNode;
  if (!data) body = isLoading ? <TableSkeleton rows={4} columns={7} /> : <NoAnswerPanel retry={refetch} />;
  else if (pages.length === 0) {
    body = page !== null
      ? <StatusPanel title={`На ${page} за ${days} дней платных сообщений не было`} action={<button type="button" className="btn btn-sm" onClick={onAllPages}>Показать все страницы</button>} />
      : <StatusPanel title="Платных сообщений не было" description="За это время страницы не отправили ни одного личного платного сообщения." />;
  } else body = <div className={query.isPlaceholderData ? "is-refreshing" : ""}><Matrix columns={columns} rows={ppvRows(pages, (one) => one.byPrice, (one) => one.total, true)} cell={(value, strong) => <PpvTd cell={value} strong={strong} />} /></div>;
  return (
    <>
      {data && <PageHeader window={formatWindowRange(data.from, data.to)} fresh={{ at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: query.isFetching }} />}
      <section className="card" aria-labelledby="sales-ppv">
        <header className="card-header">
          <div>
            <h2 id="sales-ppv" className="card-title">Платные сообщения: сколько купили, по цене</h2>
            <p className="card-description">
              Купили из отправленных и деньги после комиссии. Свежие платные сообщения ещё могут купить, поэтому последние дни
              занижают долю. <Link to="/team/chatters" className="link">По чаттерам</Link>
            </p>
          </div>
        </header>
        {data && <div className="team-card-inner"><QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} /></div>}
        {body}
      </section>
      {data && pages.length > 0 && (
        <DisclosureCard title="Первое платное сообщение в чате" description="Купил ли фан своё первое платное сообщение, по его цене.">
          <Matrix columns={columns} rows={ppvRows(pages, (one) => one.firstPpv, (one) => ppvTotalOf(one.firstPpv), false)} cell={(value, strong) => <PpvTd cell={value} strong={strong} />} />
        </DisclosureCard>
      )}
    </>
  );
}

function RepliesBlock({ days, page }: { days: number; page: string | null }) {
  const query = useTeamSalesReplies(days);
  const { data, isLoading, isError, refetch, dataUpdatedAt } = query;
  const pages = (data?.pages ?? []).filter((one) => page === null || one.pageLabel === page);
  const columns = (data?.pages[0]?.byDelay ?? []).map((cell) => DELAY_LABELS[cell.bucket] ?? cell.bucket);
  const rows: MatrixRow<Replies>[] = pages.map((one) => ({ key: one.pageLabel, label: <PageLink label={one.pageLabel} />, cells: one.byDelay, total: one.total }));
  if (pages.length > 1) {
    const all = allReplies(pages.map((one) => one.byDelay));
    rows.unshift({ key: "all", label: <span className="font-medium">Все страницы</span>, cells: all, total: sumReplies(all), all: true });
  }
  return (
    <section className="card" aria-labelledby="sales-replies">
      <header className="card-header">
        <div>
          <h2 id="sales-replies" className="card-title">Скорость ответа и покупки</h2>
          <p className="card-description">Доля ответов, после которых фан купил за 24 часа. Ответы последних суток ещё не считаются.</p>
        </div>
      </header>
      {data && <div className="team-card-inner"><QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} /></div>}
      {!data
        ? (isLoading ? <TableSkeleton rows={4} columns={7} /> : <NoAnswerPanel retry={refetch} />)
        : pages.length === 0
          ? <StatusPanel title="Ответов нет" description="За это время страницы не ответили ни одному фану (ответы последних суток ещё не считаются)." />
          : <div className={query.isPlaceholderData ? "is-refreshing" : ""}><Matrix columns={columns} rows={rows} cell={(value, strong) => <ReplyTd cell={value} strong={strong} />} /></div>}
    </section>
  );
}

function Findings({ days, page }: { days: number; page: string | null }) {
  const ppv = useTeamSalesPpv(days);
  const replies = useTeamSalesReplies(days);
  const ppvPages = (ppv.data?.pages ?? []).filter((one) => page === null || one.pageLabel === page);
  const replyPages = (replies.data?.pages ?? []).filter((one) => page === null || one.pageLabel === page);
  const best = ppv.data ? bestPriceBucket(allPpv(ppvPages.map((one) => one.byPrice)), 5) : null;
  const contrast = replies.data ? replyContrast(allReplies(replyPages.map((one) => one.byDelay)), 10) : null;
  if (!ppv.data && !replies.data && (ppv.isLoading || replies.isLoading)) return <StatCardSkeleton count={2} />;
  return (
    <StatGrid className="team-stats-2">
      <Stat
        label="Лучшая цена"
        value={!ppv.data ? "—" : best ? PRICE_LABELS[best.bucket] ?? best.bucket : "—"}
        meta={!ppv.data
          ? (ppv.isError ? "Hub не ответил" : "…")
          : best ? `купили ${formatPercent(best.rate * 100)}: ${formatCount(best.bought)} из ${formatCount(best.sent)}` : "Меньше 5 платных сообщений в каждой цене."}
      />
      <Stat
        label="Быстрый ответ"
        value={!replies.data ? "—" : contrast ? `${formatPercent(contrast.fast * 100)} против ${formatPercent(contrast.slow * 100)}` : "—"}
        meta={!replies.data
          ? (replies.isError ? "Hub не ответил" : "…")
          : contrast ? "покупают за сутки после ответа до 5 минут и через час и дольше" : "Меньше 10 ответов для сравнения."}
      />
    </StatGrid>
  );
}

export function TeamSalesPage() {
  const { days: shownDays } = useScreenPeriod();
  const days = shownDays === 30 ? 30 : 7;
  const filter = usePageFilter();
  return (
    <div className="team-screen">
      <Findings days={days} page={filter.page} />
      <PpvBlock days={days} page={filter.page} onAllPages={() => filter.select(null)} />
      <RepliesBlock days={days} page={filter.page} />
      <Disclosure>
        <p>
          Платное сообщение — личное сообщение за деньги: без рассылок Fansly и без одинакового текста, ушедшего пяти и больше
          фанам за час.
        </p>
        <p>
          Куплено — Fansly отметил покупку, на OnlyFans у сообщения есть время покупки. Сумма — после комиссии: на Fansly из
          статистики продаж платных сообщений, на OnlyFans — покупка этого фана в пределах 3 минут. Свежие платные сообщения
          ещё могут купить, поэтому последние дни занижают долю.
        </p>
        <p>
          Первое платное сообщение — первое платное в чате, которое знает Hub: если история чата загружена не целиком, первым
          может оказаться не самое первое.
        </p>
        <p>
          Ответ — первое личное сообщение страницы после сообщений фана; время ответа считается от первого из них (кто ждал
          больше 3 суток, не считается). Купил — чаевые или покупка сообщения, поста или стрима этим фаном на этой странице
          в 24 часа после ответа; продление подписки не считается. Ответы последних суток ещё не считаются.
        </p>
        <p>По чаттерам — только сообщения, у которых Hub знает автора: на странице каждого чаттера.</p>
        <p>Это ориентир, а не основание для оплаты.</p>
      </Disclosure>
    </div>
  );
}
