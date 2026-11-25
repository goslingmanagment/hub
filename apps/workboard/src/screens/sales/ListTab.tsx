import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { TeamSaleHomeFilterWire, TeamSalesListResponse, TeamSalesListSale } from "@agency_hub_core/contracts";
import { Button, EmptyState, Money, PageLabel, Section, Segmented, Table, cx, type Column } from "@agency_hub_core/ui";
import { formatCount, formatDateTime } from "@agency_hub_core/ui/format";
import { kernel } from "@/shared/hub";
import { ChainMoney } from "@/shared/saleChain";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { Folds, HowItCounts, NoAnswer, SalesHeader, skeletonColumns } from "./parts";

/**
 * Список продаж (products plan §2.3): every sale of the viewer's teams in the period, the newest first — whose it is
 * and why in the chain's words, the report it is in, and the sale's amount that opens its chain (a chatter's: only of
 * a sale of theirs). Hub reads and cuts it (`teamSalesList`); the filter by whose a sale is travels in the address
 * (`?home=owner`).
 */

const KIND_WORDS: Readonly<Record<string, string>> = {
  message_purchase: "PPV",
  post_purchase: "пост",
  tip: "чаевые",
  stream_tip: "чаевые",
  subscription: "подписка",
};

/** The filters in the row, with their words; a filter with nothing in it is left out (but «Все» and the one chosen). */
const FILTERS: ReadonlyArray<{ value: TeamSaleHomeFilterWire; label: string }> = [
  { value: "all", label: "Все" },
  { value: "mine", label: "Мои" },
  { value: "people", label: "По сменам" },
  { value: "owner", label: "Решает владелец" },
  { value: "waiting", label: "Ждут смены" },
  { value: "pot", label: "Общак" },
  { value: "nobody", label: "Ничьи" },
  { value: "none", label: "Без правила" },
];

const isFilter = (value: string | null): value is TeamSaleHomeFilterWire => FILTERS.some((one) => one.value === value);

function useHomeFilter(): [TeamSaleHomeFilterWire, (value: TeamSaleHomeFilterWire) => void] {
  const [search, setSearch] = useSearchParams();
  const raw = search.get("home");
  const value = isFilter(raw) ? raw : "all";
  const set = (next: TeamSaleHomeFilterWire) => setSearch((current) => {
    const updated = new URLSearchParams(current);
    if (next === "all") updated.delete("home");
    else updated.set("home", next);
    return updated;
  }, { replace: true });
  return [value, set];
}

function useSalesList(input: { from: string; to: string; page: string | null; home: TeamSaleHomeFilterWire }) {
  return useInfiniteQuery({
    meta: { suppressGlobalError: true },
    queryKey: ["sales", "list", input.from, input.to, input.page, input.home],
    queryFn: ({ pageParam }) => kernel.teamSalesList({
      query: { from: input.from, to: input.to, home: input.home, offset: pageParam, ...(input.page ? { pageLabel: input.page } : {}) },
    }),
    initialPageParam: 0,
    getNextPageParam: (last: TeamSalesListResponse) => last.nextOffset ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

function HomeCell({ sale }: { sale: TeamSalesListSale }) {
  const { home } = sale;
  return (
    <span className="sales-list__home">
      <span className={cx("sales-list__words", home.state === "open" && "sales-list__words--open", (home.state === "none" || home.state === "unknown") && "sales-list__words--quiet")}>
        {home.words}
      </span>
      {home.above !== null && <span className="sales-sub">{home.above}</span>}
      {home.dispute !== null && <span className="sales-sub sales-list__words--open">{home.dispute}</span>}
    </span>
  );
}

function ReportCell({ sale }: { sale: TeamSalesListSale }) {
  const { report } = sale;
  const words = <span className={cx("sales-list__words sales-list__report", report.state !== "done" && "sales-list__words--quiet")}>{report.words}</span>;
  if (report.link === null || !report.link.startsWith("/workboard/")) return words;
  return <Link to={report.link.slice("/workboard".length)} className="sales-list__link">{words}</Link>;
}

function columns(): Column<TeamSalesListSale>[] {
  return [
    {
      key: "at",
      header: "Когда",
      cell: (sale) => (
        <span className="sales-name">
          <span className="sales-list__when">{formatDateTime(sale.occurredAt)}</span>
          <PageLabel label={sale.pageLabel} platform={sale.platform} className="sales-sub" />
        </span>
      ),
      width: 150,
    },
    {
      key: "what",
      header: "Фан и что",
      cell: (sale) => (
        <span className="sales-name">
          <span className="sales-name__main">{sale.fan.name ?? (sale.fan.username ? `@${sale.fan.username}` : "фан без имени")}</span>
          <span className="sales-sub">{KIND_WORDS[sale.kind] ?? sale.kind}</span>
        </span>
      ),
      width: 160,
    },
    { key: "home", header: "Чья и почему", cell: (sale) => <HomeCell sale={sale} />, grow: true },
    { key: "report", header: "Отчёт", cell: (sale) => <ReportCell sale={sale} />, width: "28%" },
    {
      key: "amount",
      header: "Сумма",
      hint: "Нажмите на сумму: откроется цепочка продажи — чья, смена, отчёт, начисление",
      numeric: true,
      cell: (sale) => (sale.chain ? <ChainMoney saleId={sale.transactionId}><Money mills={sale.netMills} /></ChainMoney> : <Money mills={sale.netMills} />),
      width: 96,
    },
  ];
}

export function ListTab() {
  const { period } = usePeriod();
  const { page, setPage } = usePageFilter();
  const [rawHome, setHome] = useHomeFilter();
  const { isOwner } = useMe();
  // Nobody's sales are hidden from chatters and team leads (H8): never offer or query the «Ничьи» chip for them.
  const home: TeamSaleHomeFilterWire = !isOwner && rawHome === "nobody" ? "all" : rawHome;
  const query = useSalesList({ from: period.from, to: period.to, page, home });
  const first = query.data?.pages[0] ?? null;
  const rows = query.data?.pages.flatMap((one) => one.sales) ?? [];
  const counts = first?.counts ?? null;
  const shown = FILTERS.filter((one) => {
    if (one.value === "nobody" && !isOwner) return false;
    return one.value === "all" || one.value === home || (counts !== null && counts[one.value] > 0 && !(one.value === "mine" && isOwner));
  });

  let body;
  if (first === null) {
    body = query.isError
      ? <NoAnswer onRetry={() => void query.refetch()} retrying={query.isFetching} />
      : <Table label="Продажи" columns={skeletonColumns(columns())} rows={[]} rowKey={(sale) => String(sale.transactionId)} loading skeletonRows={8} fit={false} />;
  } else if (counts !== null && counts.all === 0) {
    body = (
      <EmptyState
        title={page ? `На ${page} за ${period.label} продаж нет` : `За ${period.label} продаж нет`}
        action={page ? <Button onClick={() => setPage(null)}>Показать все страницы</Button> : undefined}
      >
        Здесь каждая продажа страниц ваших команд: подписки, чаевые, PPV и посты.
      </EmptyState>
    );
  } else {
    body = (
      <Section
        title={`${formatCount(counts?.[home] ?? rows.length)} продаж`}
        description="Чья продажа и почему, по правилу Hub. Сумма открывает цепочку: смена, отчёт, начисление."
        actions={shown.length > 1
          ? (
            <div className="sales-list__filters">
              <Segmented<TeamSaleHomeFilterWire> label="Чьи продажи" value={home} onChange={setHome} options={shown.map((one) => ({ value: one.value, label: `${one.label} ${formatCount(counts?.[one.value] ?? 0)}` }))} />
              {/* The owner's list of the sales nobody claimed: no longer a line of «Ждут вас» (owner, 2026-11-26). */}
              {isOwner && home === "nobody" && <Link to="/waiting?nobody=1" className="sales-list__link">Отдать или оставить ничьими</Link>}
            </div>
          )
          : undefined}
      >
        <Table
          label="Продажи"
          columns={columns()}
          rows={rows}
          rowKey={(sale) => String(sale.transactionId)}
          refreshing={query.isPlaceholderData}
          empty={<EmptyState compact title="Таких продаж нет">За эти дни под этот фильтр ничего не подошло.</EmptyState>}
        />
        {query.hasNextPage && (
          <div className="sales-after">
            <Button size="sm" variant="ghost" onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>Показать ещё</Button>
          </div>
        )}
      </Section>
    );
  }

  return (
    <>
      <SalesHeader
        updatedAt={query.dataUpdatedAt}
        stale={query.isRefetchError}
        onRefresh={() => void query.refetch()}
        refreshing={query.isFetching}
      />
      <div className="wb-content">
        {body}
        <Folds>
          <HowItCounts>
            <p>
              Чья продажа, решает одно правило Hub: смена, которая держала страницу; из нескольких — тот, кто последним
              писал фану; PPV — его отправителю. Над правилом стоят решение владельца и согласие сторон. Правило
              пересчитывает продажи раз в час, поэтому у самых свежих может стоять «правило ещё не посчитало».
            </p>
            <p>
              Отчёт — сданная доской версия, в которой есть эта продажа, иначе отчёт человека за этот день в ledger. Пост в
              Telegram не перечисляет продажи по одной, поэтому про пост сказано, отправлен ли он за этот день.
            </p>
            <p>
              Сумма — чистыми, после комиссии площадки. Цепочка открывается у ваших продаж; у продаж коллег видно, чья она
              и есть ли отчёт, но не их деньги.
            </p>
          </HowItCounts>
        </Folds>
      </div>
    </>
  );
}
