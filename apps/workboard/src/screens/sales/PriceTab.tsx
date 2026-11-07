import { useMemo } from "react";
import { useLocation } from "react-router";
import { Button, Disclosure, Drawer, EmptyState, LinkButton, Mark, Money, RateBar, Section, Table, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatCount, formatMills, formatOf, formatPercent } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { personPath, useBackState } from "@/shared/links";
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
  richerSmallPrice,
  share,
  useSalesPpv,
  type PpvCell,
  type PpvCounts,
  type PpvLine,
  type PriceView,
} from "./data";
import { BACK_LABEL, barWidth, BeyondReach, BySwitch, Folds, HowItCounts, LineName, MoneyBar, NoAnswer, SalesHeader, WindowNotice, openColumn, panelColumns, skeletonColumns, useSalesParams, windowWords } from "./parts";

/**
 * Цена: which price of a paid message brings money — by the money one sent
 * message brings, not only by how often it is bought — for the team, then page
 * by page or chatter by chatter, bars instead of matrices. The best price is
 * bold ink and a word (spec r2), never the warm mark: that one means «worse».
 * «The best» is chosen among prices sent 20 times or more, and the sentence
 * above the table says so; a smaller one says «мало данных» in the same slot
 * (E3). A share's bar runs from 0 to 100 %: 26 % looks like a quarter.
 */

const rateOf = (counts: { sent: number; bought: number }) => ({ hits: counts.bought, of: counts.sent });

/** The shape of a line before anything is read: for the skeleton's columns. */
const EMPTY_LINE: PpvLine = { key: "all", kind: "page", name: "", userId: null, platform: null, total: { sent: 0, bought: 0, netMills: 0 }, byPrice: [], withoutAuthor: null };

const SMALL_HINT = (sent: number) => `Всего ${formatCount(sent)} ${ruPlural(sent, "сообщение", "сообщения", "сообщений")} — мало, чтобы судить`;

/** The money scale of a column: only fair samples set it (a pale «$19.99 из 18» may not outgrow the best). */
function moneyScale(counts: readonly PpvCounts[], extra: ReadonlyArray<number | null> = []): number {
  return Math.max(1, ...counts.map((one) => (one.sent >= MIN_SAMPLE.ppv ? perMessageMills(one) ?? 0 : 0)), ...extra.map((value) => value ?? 0));
}

function priceColumns(cells: readonly PpvCell[], options: { compare?: readonly PpvCell[]; compareLabel?: string; word?: boolean } = {}): Column<PpvCell>[] {
  const best = bestPrice(cells);
  const teamOf = (bucket: string) => options.compare?.find((cell) => cell.bucket === bucket);
  const moneyMax = moneyScale(cells, options.compare?.map((cell) => (cell.sent >= MIN_SAMPLE.ppv ? perMessageMills(cell) : null)) ?? []);
  const compareLabel = options.compareLabel ?? "все вместе";
  return [
    {
      key: "price",
      header: "Цена",
      cell: (cell) => <span className="sales-name__main">{cell.label}</span>,
      grow: true,
    },
    { key: "sent", header: "Отправили", numeric: true, cell: (cell) => formatCount(cell.sent) },
    {
      key: "bought",
      header: "Купили",
      cell: (cell) => {
        const team = teamOf(cell.bucket);
        return <RateBar {...rateOf(cell)} min={MIN_SAMPLE.ppv} compare={team ? share(rateOf(team)) : null} compareLabel={compareLabel} />;
      },
      width: barWidth(30, 460),
      className: "sales-bar-col",
    },
    {
      key: "per",
      header: "На одно сообщение",
      hint: "Деньги после комиссии, делённые на все отправленные платные этой цены: и доля купивших, и сама цена",
      cell: (cell) => {
        const value = perMessageMills(cell);
        const team = teamOf(cell.bucket);
        const teamValue = team && team.sent >= MIN_SAMPLE.ppv ? perMessageMills(team) : null;
        const weak = cell.sent < MIN_SAMPLE.ppv;
        return (
          <MoneyBar
            mills={value}
            max={moneyMax}
            weak={weak}
            best={best?.bucket === cell.bucket}
            wordSlot={options.word !== false}
            compare={teamValue}
            {...(weak && value !== null ? { hint: SMALL_HINT(cell.sent) } : {})}
            {...(value === null ? { emptyHint: "Таких платных не отправляли" } : {})}
          />
        );
      },
      width: barWidth(34, options.word === false ? 420 : 540),
      className: "sales-bar-col",
    },
    {
      key: "net",
      header: "Получили",
      numeric: true,
      cell: (cell) => (cell.sent === 0 ? <span className="sales-quiet">—</span> : <Money mills={cell.bought > 0 ? cell.netMills : 0} muted={cell.bought === 0} />),
    },
  ];
}

/**
 * The answer above the table, then its rule (E3): «Больше всего денег на одно
 * сообщение приносит цена $50–100 — $13.91. Сравниваем цены, отправленные
 * 20 раз и больше; у «от $100» больше — $39.99, но её отправили всего 9 раз:
 * мало данных.» Pure.
 */
export function verdictOf(cells: readonly PpvCell[]): string {
  const best = bestPrice(cells);
  if (!best) return `Сравнивать рано: ни у двух цен не набралось ${MIN_SAMPLE.ppv} отправленных. Бледные строки — мало данных.`;
  const value = perMessageMills(best);
  const answer = `Больше всего денег на одно сообщение приносит цена ${best.label}${value !== null ? ` — ${formatMills(value)}` : ""}.`;
  const richer = richerSmallPrice(cells, best);
  const rule = `Сравниваем цены, отправленные ${MIN_SAMPLE.ppv}\u00a0раз и больше`;
  if (!richer) return `${answer} ${rule}.`;
  const richerValue = perMessageMills(richer);
  return `${answer} ${rule}; у «${richer.label}» больше${richerValue !== null ? ` — ${formatMills(richerValue)}` : ""}, но её отправили всего ${formatCount(richer.sent)}\u00a0${ruPlural(richer.sent, "раз", "раза", "раз")}: мало данных.`;
}

/** The team's (or the chosen page's) prices: five rows, the best one in bold with its word. */
function TeamPrices({ view, onAllPages }: { view: PriceView; onAllPages: (() => void) | null }) {
  const { all } = view;
  const columns = priceColumns(all.byPrice).map((column): Column<PpvCell> => {
    switch (column.key) {
      case "price":
        return { ...column, footer: <span className="sales-total">Всего</span> };
      case "sent":
        return { ...column, footer: <span className="sales-total-num">{formatCount(all.total.sent)}</span> };
      case "bought":
        return { ...column, footer: <RateBar value={null} empty={all.total.sent > 0 ? formatPercent((100 * all.total.bought) / all.total.sent) : "—"} className="sales-total-rate" /> };
      case "per":
        return { ...column, footer: <MoneyBar mills={perMessageMills(all.total)} max={1} weak={false} total wordSlot /> };
      default:
        return { ...column, footer: <Money mills={all.total.netMills} strong /> };
    }
  });
  const withoutAuthor = all.withoutAuthor ?? 0;
  return (
    <Section title={onAllPages ? `Какая цена приносит больше на ${all.name}` : "Какая цена приносит больше"} description={verdictOf(all.byPrice)}>
      <Table label="Платные сообщения по цене" columns={columns} rows={all.byPrice} rowKey={(cell) => cell.bucket} stickyHeader={false} />
      {(withoutAuthor > 0 || onAllPages) && (
        <div className="sales-after">
          {withoutAuthor > 0 && <p>Из {formatCount(all.total.sent)} платных {formatCount(withoutAuthor)} без автора: ушли не из расширения, поэтому по чаттерам их не видно.</p>}
          {onAllPages && <Button size="sm" variant="ghost" onClick={onAllPages}>Сравнить с другими страницами</Button>}
        </div>
      )}
    </Section>
  );
}

function lineColumns(lines: readonly PpvLine[], all: PpvLine, by: "pages" | "chatters"): Column<PpvLine>[] {
  const teamPer = perMessageMills(all.total);
  const teamCheap = cheapShare(all);
  const moneyMax = moneyScale(lines.map((line) => line.total), [teamPer]);
  const together = by === "pages" ? "все страницы" : "вся команда";
  return [
    {
      key: "name",
      header: by === "pages" ? "Страница" : "Чаттер",
      cell: (line) => <LineName kind={line.kind} name={line.name} platform={line.platform} />,
      sortValue: (line) => line.name,
      grow: true,
    },
    { key: "sent", header: "Отправили", numeric: true, cell: (line) => formatCount(line.total.sent), sortValue: (line) => line.total.sent },
    {
      key: "bought",
      header: "Купили",
      numeric: true,
      cell: (line) => {
        if (line.total.sent === 0) return <span className="sales-quiet">—</span>;
        if (line.total.sent < MIN_SAMPLE.ppv) {
          return <Tooltip content={SMALL_HINT(line.total.sent)}><span className="sales-quiet">{formatOf(line.total.bought, line.total.sent)}</span></Tooltip>;
        }
        return formatPercent((100 * line.total.bought) / line.total.sent);
      },
      sortValue: (line) => (line.total.sent >= MIN_SAMPLE.ppv ? share(rateOf(line.total)) : null),
      sortFirst: "desc",
    },
    {
      key: "per",
      header: "На одно сообщение",
      hint: `Деньги после комиссии, делённые на все отправленные платные. Черта — ${together}: ${formatMills(teamPer ?? 0)}`,
      cell: (line) => {
        const value = perMessageMills(line.total);
        const weak = line.total.sent < MIN_SAMPLE.ppv;
        return <MoneyBar mills={value} max={moneyMax} weak={weak} compare={teamPer} {...(weak && value !== null ? { hint: SMALL_HINT(line.total.sent) } : {})} />;
      },
      sortValue: (line) => (line.total.sent >= MIN_SAMPLE.ppv ? perMessageMills(line.total) : null),
      sortFirst: "desc",
      width: barWidth(34, 440),
      className: "sales-bar-col",
    },
    { key: "net", header: "Получили", numeric: true, cell: (line) => <Money mills={line.total.netMills} />, sortValue: (line) => line.total.netMills },
    {
      key: "cheap",
      header: "Дешевле $10",
      hint: "Доля платных дешевле $10 среди всех отправленных. Отмечено, когда заметно больше, чем у всех вместе",
      numeric: true,
      cell: (line) => {
        const value = cheapShare(line);
        if (value === null) return <span className="sales-quiet">—</span>;
        const text = formatPercent(value * 100);
        const outlier = teamCheap !== null && line.total.sent >= 2 * MIN_SAMPLE.ppv && value >= teamCheap + 0.15;
        return outlier ? <Mark hint={`У ${by === "pages" ? "всех страниц" : "команды"} вместе — ${formatPercent(teamCheap * 100)}`}>{text}</Mark> : text;
      },
      sortValue: (line) => cheapShare(line),
    },
    openColumn<PpvLine>(),
  ];
}

/** One page's or chatter's prices against everyone together: the same answer, the same rule as the table above. */
function LineDrawer({ line, all, onClose, windowLabel }: { line: PpvLine; all: PpvLine; onClose: () => void; windowLabel: string }) {
  const location = useLocation();
  const back = useBackState(BACK_LABEL);
  const together = line.kind === "chatter" ? "вся команда" : "все страницы";
  const columns = panelColumns(priceColumns(line.byPrice, { compare: all.byPrice, compareLabel: together }), { price: "19%", sent: "14%", bought: "27%", per: "40%" }, { nowrapFirst: true });
  const bought = line.total.sent > 0 ? formatPercent((100 * line.total.bought) / line.total.sent) : "—";
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={line.name}
      subtitle={`Платные сообщения по цене · ${windowLabel}`}
      {...(line.userId !== null
        ? { footer: <LinkButton to={personPath(line.userId, location.search, "sales")} state={back}>Открыть карточку {line.name}</LinkButton> }
        : {})}
    >
      <div className="sales-drawer">
        <p className="sales-drawer__lead">
          Отправлено {formatCount(line.total.sent)}, купили {line.total.sent >= MIN_SAMPLE.ppv ? bought : formatOf(line.total.bought, line.total.sent)},
          получено <Money mills={line.total.netMills} />.{" "}
          {verdictOf(line.byPrice)}
          {line.withoutAuthor ? ` Без автора ${formatCount(line.withoutAuthor)}: ушли не из расширения.` : ""}
        </p>
        <Table label={`${line.name}: платные по цене`} columns={columns} rows={line.byPrice} rowKey={(cell) => cell.bucket} stickyHeader={false} fit={false} />
        <p className="sales-sub">Черта на полосе — {together}.</p>
      </div>
    </Drawer>
  );
}

export function PriceTab() {
  const { period, today } = usePeriod();
  const { page, setPage } = usePageFilter();
  const { by, open, setBy, setOpen } = useSalesParams();
  const window = readWindow(period, today, MAX_DAYS.sales);
  const query = useSalesPpv(window);
  const view = useMemo(() => (query.data ? priceView(query.data, page) : null), [query.data, page]);
  const lines = view ? (by === "pages" ? view.pages : view.chatters) : [];
  const openLine = view ? [...view.pages, ...view.chatters].find((line) => line.key === open) ?? null : null;
  const label = view ? windowWords(view.from, view.to) : "";

  let body;
  if (window.beyond) {
    body = <BeyondReach maxDays={MAX_DAYS.sales} />;
  } else if (!view) {
    body = query.isError
      ? <NoAnswer onRetry={() => void query.refetch()} retrying={query.isFetching} />
      : (
        <>
          <Section title="Какая цена приносит больше" description="Считаем деньги на одно отправленное сообщение…">
            <Table label="Платные сообщения по цене" columns={priceColumns([])} rows={[]} rowKey={(cell) => cell.bucket} fit={false} loading skeletonRows={6} stickyHeader={false} />
          </Section>
          {page === null && (
            <Section title={by === "pages" ? "По страницам" : "По чаттерам"} actions={<BySwitch value={by} onChange={setBy} />}>
              <Table label="Платные по страницам" columns={skeletonColumns(lineColumns([], EMPTY_LINE, by))} rows={[]} rowKey={(line) => line.key} fit={false} loading skeletonRows={6} />
            </Section>
          )}
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
        <TeamPrices view={view} onAllPages={page !== null ? () => setPage(null) : null} />
        {/* One page chosen: its prices are the answer; pages and chatters are compared without the filter (Ц5). */}
        {page === null && (
          <Section
            title={by === "pages" ? "По страницам" : "По чаттерам"}
            {...(by === "chatters" ? { description: "Только платные, у которых Hub знает автора." } : {})}
            actions={<BySwitch value={by} onChange={setBy} />}
          >
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
          </Section>
        )}
      </>
    );
  }

  const firstBest = view ? bestPrice(view.firstPpv) : null;
  const firstBestValue = firstBest ? perMessageMills(firstBest) : null;
  return (
    <>
      <SalesHeader updatedAt={query.dataUpdatedAt} onRefresh={() => void query.refetch()} refreshing={query.isFetching} />
      <div className="wb-content">
        <WindowNotice window={window} maxDays={MAX_DAYS.sales} {...(label ? { shown: label } : {})} />
        {body}
        <Folds>
          {view && view.all.total.sent > 0 && (
            <Disclosure
              summary="Первое платное в чате"
              hint={firstBest && firstBestValue !== null
                ? `больше всего денег — у ${firstBest.label}: ${formatMills(firstBestValue)} на сообщение`
                : "купил ли фан своё первое платное, по его цене"}
            >
              <div className="sales-fold">
                <Table label="Первое платное в чате по цене" columns={priceColumns(view.firstPpv)} rows={view.firstPpv} rowKey={(cell) => cell.bucket} stickyHeader={false} />
              </div>
            </Disclosure>
          )}
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
              «Больше всего» выбирается только среди цен, отправленных {MIN_SAMPLE.ppv} раз и больше, и только если таких цен хотя
              бы две. Цена, отправленная реже, — «мало данных»: она бледнее, её доля показана как «2 из 14», полосы денег у
              неё нет. Свежие платные ещё могут купить, поэтому последние дни занижают долю. Полоса доли — от 0 до 100 %; черта
              на полосе — все страницы (или вся команда) вместе.
            </p>
            <p>
              Первое платное в чате — первое платное, которое знает Hub: если история чата загружена не целиком, первым может
              оказаться не самое первое.
            </p>
            <p>
              Без автора — платные, отправленные не из расширения (с телефона или сайта): Hub не знает, кто их написал. По чаттерам
              их нет, поэтому сумма по чаттерам меньше суммы по страницам. «Дешевле $10» отмечено, когда у страницы или чаттера
              таких заметно больше, чем у всех вместе.
            </p>
            <p>Это ориентир, а не основание для оплаты.</p>
          </HowItCounts>
        </Folds>
      </div>
      {openLine && view && <LineDrawer line={openLine} all={view.all} onClose={() => setOpen(null)} windowLabel={label} />}
    </>
  );
}
