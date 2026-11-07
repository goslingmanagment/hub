import { useMemo } from "react";
import { useLocation } from "react-router";
import { Bar, Button, Card, Disclosure, Drawer, EmptyState, LinkButton, Mark, Money, Section, Table, type Column } from "@agency_hub_core/ui";
import { formatCount, formatPercent } from "@agency_hub_core/ui/format";
import { personPath } from "@/shared/links";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import {
  MAX_DAYS,
  MIN_SAMPLE,
  bestPrice,
  cheapShare,
  perMessageMills,
  priceView,
  readWindow,
  share,
  useSalesPpv,
  type PpvCell,
  type PpvLine,
  type PriceView,
} from "./data";
import { BySwitch, HowItCounts, LineName, NoAnswer, RateCell, SalesHeader, WindowNotice, panelColumns, SCALE_SAMPLE, scaleOf, useSalesParams, windowWords } from "./parts";

/**
 * Цена: which price of a paid message brings money — by the money one sent
 * message brings, not only by how often it is bought (critic S1) — for the
 * team, then page by page or chatter by chatter, bars instead of matrices.
 */

const rateOf = (counts: { sent: number; bought: number }) => ({ hits: counts.bought, of: counts.sent });

/** The shape of a line before anything is read: for the skeleton's columns. */
const EMPTY_LINE: PpvLine = { key: "all", kind: "page", name: "", userId: null, platform: null, total: { sent: 0, bought: 0, netMills: 0 }, byPrice: [], withoutAuthor: null };

/** «$15.79» on a bar of the column's largest; the best price marked. */
function PerMessage({ cell, max, best }: { cell: { sent: number; bought: number; netMills: number }; max: number; best: boolean }) {
  const value = perMessageMills(cell);
  if (value === null) return <span className="sales-quiet">—</span>;
  const weak = cell.sent < MIN_SAMPLE.ppv;
  return (
    <span className={weak ? "sales-rate sales-rate--weak" : "sales-rate"} title={weak ? "Мало сообщений, чтобы судить" : undefined}>
      <Bar value={value} max={max} tone={weak ? "muted" : best ? "mark" : "neutral"} className="sales-rate__bar" />
      <span className="sales-rate__num sales-rate__num--money">{best ? <Mark title="Больше всего денег на одно сообщение">{<Money mills={value} />}</Mark> : <Money mills={value} muted={weak} />}</span>
    </span>
  );
}

function priceColumns(cells: readonly PpvCell[], options: { compare?: readonly PpvCell[] } = {}): Column<PpvCell>[] {
  const best = bestPrice(cells);
  const rateMax = scaleOf(cells.map((cell) => (cell.sent >= SCALE_SAMPLE ? share(rateOf(cell)) : null)).concat(options.compare?.map((cell) => share(rateOf(cell))) ?? []));
  const moneyMax = Math.max(1, ...cells.map((cell) => perMessageMills(cell) ?? 0));
  const teamOf = (bucket: string) => options.compare?.find((cell) => cell.bucket === bucket);
  return [
    {
      key: "price",
      header: "Цена",
      cell: (cell) => <span className="sales-name__main">{cell.label}</span>,
      width: "16%",
    },
    { key: "sent", header: "Отправили", numeric: true, cell: (cell) => formatCount(cell.sent), width: "12%" },
    {
      key: "bought",
      header: "Купили",
      cell: (cell) => {
        const team = teamOf(cell.bucket);
        return <RateCell rate={rateOf(cell)} min={MIN_SAMPLE.ppv} max={rateMax} compare={team ? share(rateOf(team)) : null} />;
      },
      width: "28%",
    },
    {
      key: "per",
      header: "На одно сообщение",
      title: "Деньги после комиссии, делённые на все отправленные платные этой цены",
      cell: (cell) => <PerMessage cell={cell} max={moneyMax} best={best?.bucket === cell.bucket} />,
      width: "28%",
    },
    {
      key: "net",
      header: "Получили",
      numeric: true,
      cell: (cell) => (cell.sent === 0 ? <span className="sales-quiet">—</span> : <Money mills={cell.bought > 0 ? cell.netMills : 0} muted={cell.bought === 0} />),
      width: "16%",
    },
  ];
}

/** The team's (or the chosen page's) prices: five rows, the best one marked. */
function TeamPrices({ view }: { view: PriceView }) {
  const { all } = view;
  const columns = priceColumns(all.byPrice).map((column): Column<PpvCell> => {
    switch (column.key) {
      case "price":
        return { ...column, footer: <span className="sales-total">Всего</span> };
      case "sent":
        return { ...column, footer: formatCount(all.total.sent) };
      case "bought":
        return { ...column, footer: <span className="sales-total-num">{all.total.sent > 0 ? formatPercent((100 * all.total.bought) / all.total.sent) : "—"}</span> };
      case "per":
        return { ...column, footer: <span className="sales-total-num"><Money mills={perMessageMills(all.total)} /></span> };
      default:
        return { ...column, footer: <Money mills={all.total.netMills} strong /> };
    }
  });
  const best = bestPrice(all.byPrice);
  const withoutAuthor = all.withoutAuthor ?? 0;
  return (
    <Card
      title="Какая цена приносит больше"
      description={best
        ? `Больше всего денег на одно отправленное сообщение — у цены ${best.label}. Свежие платные ещё могут купить: последние дни занижают долю.`
        : "Свежие платные ещё могут купить: последние дни занижают долю."}
      padding="none"
      {...(withoutAuthor > 0
        ? { footer: `Из ${formatCount(all.total.sent)} платных ${formatCount(withoutAuthor)} без автора: ушли не из расширения, поэтому по чаттерам их не видно.` }
        : {})}
    >
      <Table label="Платные сообщения по цене" columns={columns} rows={all.byPrice} rowKey={(cell) => cell.bucket} frame="bare" stickyHeader={false} />
    </Card>
  );
}

function lineColumns(lines: readonly PpvLine[], all: PpvLine, by: "pages" | "chatters"): Column<PpvLine>[] {
  const teamRate = share(rateOf(all.total));
  const teamCheap = cheapShare(all);
  const rateMax = scaleOf(lines.map((line) => (line.total.sent >= SCALE_SAMPLE ? share(rateOf(line.total)) : null)).concat(teamRate));
  return [
    {
      key: "name",
      header: by === "pages" ? "Страница" : "Чаттер",
      cell: (line) => <LineName kind={line.kind} name={line.name} />,
      sortValue: (line) => line.name,
      width: "18%",
    },
    { key: "sent", header: "Отправили", numeric: true, cell: (line) => formatCount(line.total.sent), sortValue: (line) => line.total.sent, width: "11%" },
    {
      key: "bought",
      header: "Купили",
      cell: (line) => <RateCell rate={rateOf(line.total)} min={MIN_SAMPLE.ppv} max={rateMax} compare={teamRate} />,
      sortValue: (line) => (line.total.sent >= MIN_SAMPLE.ppv ? share(rateOf(line.total)) : null),
      sortFirst: "desc",
      width: "22%",
    },
    {
      key: "per",
      header: "На одно сообщение",
      headerWrap: false,
      numeric: true,
      cell: (line) => <Money mills={perMessageMills(line.total)} muted={line.total.sent < MIN_SAMPLE.ppv} />,
      sortValue: (line) => (line.total.sent >= MIN_SAMPLE.ppv ? perMessageMills(line.total) : null),
      width: "13%",
    },
    { key: "net", header: "Получили", numeric: true, cell: (line) => <Money mills={line.total.netMills} />, sortValue: (line) => line.total.netMills, width: "12%" },
    {
      key: "best",
      header: "Лучшая цена",
      title: "Цена, где одно отправленное сообщение принесло больше всего (если таких сообщений хотя бы 20)",
      cell: (line) => {
        const best = bestPrice(line.byPrice);
        return best ? best.label : <span className="sales-quiet" title="Мало сообщений, чтобы судить">—</span>;
      },
      width: "12%",
    },
    {
      key: "cheap",
      header: "До $10",
      title: "Доля платных дешевле $10 среди всех отправленных",
      numeric: true,
      cell: (line) => {
        const value = cheapShare(line);
        if (value === null) return <span className="sales-quiet">—</span>;
        const text = formatPercent(value * 100);
        const outlier = teamCheap !== null && line.total.sent >= 2 * MIN_SAMPLE.ppv && value >= teamCheap + 0.15;
        return outlier ? <Mark title={`У ${by === "pages" ? "страниц" : "команды"} вместе — ${formatPercent(teamCheap * 100)}`}>{text}</Mark> : text;
      },
      sortValue: (line) => cheapShare(line),
      width: "12%",
    },
  ];
}

/** One page's or chatter's prices against everyone together. */
function LineDrawer({ line, all, onClose, windowLabel }: { line: PpvLine; all: PpvLine; onClose: () => void; windowLabel: string }) {
  const location = useLocation();
  const columns = panelColumns(priceColumns(line.byPrice, { compare: all.byPrice }), { price: "18%", sent: "14%", bought: "34%", per: "34%" });
  return (
    <Drawer
      open
      onClose={onClose}
      title={line.name}
      subtitle={`Платные сообщения по цене · ${windowLabel}`}
      width={720}
      {...(line.userId !== null
        ? { footer: <LinkButton to={personPath(line.userId, location.search, "sales")}>Открыть карточку {line.name}</LinkButton> }
        : {})}
    >
      <div className="sales-drawer">
        <p className="sales-drawer__lead">
          {formatCount(line.total.sent)} отправлено, купили {line.total.sent > 0 ? formatPercent((100 * line.total.bought) / line.total.sent) : "—"},
          получено <Money mills={line.total.netMills} />.
          {line.withoutAuthor ? ` Без автора ${formatCount(line.withoutAuthor)}: ушли не из расширения.` : ""}
          {" "}Чёрточка на полосе — {line.kind === "chatter" ? "вся команда" : "все страницы"}.
        </p>
        <Table label={`${line.name}: платные по цене`} columns={columns} rows={line.byPrice} rowKey={(cell) => cell.bucket} frame="bare" stickyHeader={false} />
      </div>
    </Drawer>
  );
}

export function PriceTab() {
  const { period, today } = usePeriod();
  const { page, setPage } = usePageFilter();
  const { by, open, setBy, setOpen } = useSalesParams();
  const window = readWindow(period, today, MAX_DAYS.sales);
  const query = useSalesPpv(window.days);
  const view = useMemo(() => (query.data ? priceView(query.data, page) : null), [query.data, page]);
  const lines = view ? (by === "pages" ? view.pages : view.chatters) : [];
  const openLine = view ? [...view.pages, ...view.chatters].find((line) => line.key === open) ?? null : null;
  const label = view ? windowWords(view.from, view.to) : "";

  let body;
  if (!view) {
    body = query.isError
      ? <NoAnswer onRetry={() => void query.refetch()} retrying={query.isFetching} />
      : (
        <>
          <Card title="Какая цена приносит больше" padding="none">
            <Table label="Платные сообщения по цене" columns={priceColumns([])} rows={[]} rowKey={(cell) => cell.bucket} loading skeletonRows={5} frame="bare" stickyHeader={false} />
          </Card>
          <Section title={by === "pages" ? "По страницам" : "По чаттерам"} actions={<BySwitch value={by} onChange={setBy} />}>
            <Table label="Платные по страницам" columns={lineColumns([], EMPTY_LINE, by)} rows={[]} rowKey={(line) => line.key} loading skeletonRows={6} />
          </Section>
        </>
      );
  } else if (view.all.total.sent === 0) {
    body = (
      <EmptyState
        title={page ? `На ${page} за ${label} платных сообщений не было` : `За ${label} платных сообщений не было`}
        action={page ? <Button onClick={() => setPage(null)}>Показать все страницы</Button> : undefined}
      >
        {page ? undefined : "Страницы не отправили ни одного личного платного сообщения."}
      </EmptyState>
    );
  } else {
    body = (
      <>
        <TeamPrices view={view} />
        <Section
          title={by === "pages" ? "По страницам" : "По чаттерам"}
          description={by === "pages"
            ? page !== null ? undefined : "Нажмите на строку — цены этой страницы рядом со всеми страницами."
            : page
              ? `По всем страницам, не только ${page}: Hub пока не делит чаттера по страницам. Без сообщений без автора.`
              : "Только платные, у которых Hub знает автора. Нажмите на строку — цены этого чаттера рядом с командой."}
          actions={<BySwitch value={by} onChange={setBy} />}
        >
          {by === "pages" && page !== null ? (
            <EmptyState compact title={`Выбрана одна страница — цены ${page} выше`} action={<Button onClick={() => setPage(null)}>Сравнить все страницы</Button>} />
          ) : (
          <Table
            label={by === "pages" ? "Платные по страницам" : "Платные по чаттерам"}
            columns={lineColumns(lines, view.all, by)}
            rows={lines}
            rowKey={(line) => line.key}
            onRowClick={(line) => setOpen(line.key)}
            selectedKey={openLine?.key ?? null}
            defaultSort={{ key: "net", direction: "desc" }}
            refreshing={query.isPlaceholderData}
            empty={<EmptyState compact title={by === "pages" ? "Страниц с платными нет" : "Платных с известным автором нет"}>За эти дни Hub не нашёл таких сообщений.</EmptyState>}
          />
          )}
        </Section>
        <Disclosure size="md" summary="Первое платное сообщение в чате" hint="купил ли фан своё первое платное, по его цене">
          <Card padding="none">
            <Table label="Первое платное в чате по цене" columns={priceColumns(view.firstPpv)} rows={view.firstPpv} rowKey={(cell) => cell.bucket} frame="bare" stickyHeader={false} />
          </Card>
        </Disclosure>
      </>
    );
  }

  return (
    <>
      <SalesHeader
        meta={view ? `Платные сообщения ${label}${page ? ` · ${page}` : " · все страницы"}` : "Платные сообщения"}
        updatedAt={query.dataUpdatedAt}
        onRefresh={() => void query.refetch()}
        refreshing={query.isFetching}
      />
      <div className="wb-content">
        <WindowNotice window={window} maxDays={MAX_DAYS.sales} {...(label ? { shown: label } : {})} />
        {body}
        <HowItCounts>
          <p>
            Платное сообщение — личное сообщение за деньги: без рассылок Fansly и без одинакового текста, ушедшего пяти и
            больше фанам за час.
          </p>
          <p>
            Куплено — Fansly отметил покупку, на OnlyFans у сообщения есть время покупки. Деньги — после комиссии: на Fansly
            из статистики продаж платных сообщений, на OnlyFans — покупка этого фана в пределах 3 минут. «На одно сообщение» —
            эти деньги, делённые на все отправленные платные этой цены: так видно и долю купивших, и саму цену.
          </p>
          <p>
            Свежие платные сообщения ещё могут купить, поэтому последние дни занижают долю. Меньше 20 сообщений — слишком мало,
            чтобы судить: такие строки бледнее и показаны как «2 из 14».
          </p>
          <p>
            Первое платное сообщение — первое платное в чате, которое знает Hub: если история чата загружена не целиком, первым
            может оказаться не самое первое.
          </p>
          <p>
            Без автора — платные, отправленные не из расширения (с телефона или сайта): Hub не знает, кто их написал. По чаттерам
            их нет, поэтому сумма по чаттерам меньше суммы по страницам. «До $10» отмечено, когда у страницы или чаттера таких
            заметно больше, чем у всех вместе.
          </p>
          <p>Это ориентир, а не основание для оплаты.</p>
        </HowItCounts>
      </div>
      {openLine && view && <LineDrawer line={openLine} all={view.all} onClose={() => setOpen(null)} windowLabel={label} />}
    </>
  );
}
