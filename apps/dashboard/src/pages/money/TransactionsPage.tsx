import { Link, useLocation, useSearchParams } from "react-router";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { CrossPageTransactionItem, CrossPageTransactionListQuery } from "@agency_hub_core/contracts";
import { reportableTransactionTypes } from "@agency_hub_core/shared";
import { useAuthMe } from "@/api/queries";
import { useRevenueTransactions } from "@/api/transactions";
import { useOfapiStatus } from "@/api/waiting";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Pagination } from "@/components/shared/Pagination";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatCount, formatDateTime, formatMills, formatUtcWindowRange } from "@/lib/format";
import { buildFanProfileNavigation, buildPageRoute } from "@/lib/navigation";
import { safeBackTo } from "@/lib/overviewNavigation";
import { PERIOD_LABELS } from "@/lib/period";
import { SOURCE_LABELS } from "@/lib/revenueDisplay";
import { OFAPI_FEED_NOTE, TRANSACTION_STATUS } from "@/lib/statusWords";
import { matchesTransactionScope, parseTransactionUrl } from "@/lib/transactionNavigation";
import { usePeriodStore, type PeriodOption } from "@/stores/periodStore";

type Query = CrossPageTransactionListQuery;
type PeriodChoice = PeriodOption | "custom";

const PERIODS: readonly PeriodOption[] = ["today", "7d", "30d", "all"];
const STATES = ["posted", "pending", "unknown"] as const;
const STATE_WORD: Record<(typeof STATES)[number], string> = { posted: "Проведена", pending: "Ожидает", unknown: "Неизвестно" };

const UTC_TIME = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const isUtcMidnight = (iso: string) => new Date(iso).toISOString().endsWith("T00:00:00.000Z");

/** The window in words: whole UTC days as dates, anything else as its two instants in Moscow. */
function windowWords(query: Query): string {
  if (!query.from || !query.to) return "вся сохранённая история";
  if (isUtcMidnight(query.from) && isUtcMidnight(query.to)) return `${formatUtcWindowRange(query.from, query.to)}, сутки с 03:00 по Москве`;
  return `с ${formatDateTime(query.from)} до ${formatDateTime(query.to)}`;
}

function FanCell({ item, backTo }: { item: CrossPageTransactionItem; backTo: string }) {
  const fan = item.fan;
  if (!fan) return <span className="text-text-muted">—</span>;
  const handle = fan.username ? `@${fan.username}` : null;
  const name = fan.displayName || handle || "Фан без имени";
  // The row's own page and platform: the fan opens on the page he paid on.
  const navigation = buildFanProfileNavigation(item.pageLabel, item.platform, fan.platformUserId, backTo, name);
  return (
    <div className="min-w-0">
      <Link className="money-link font-medium" to={navigation.to} state={navigation.state}>{name}</Link>
      {fan.displayName && handle && <div className="tx-sub">{handle}</div>}
    </div>
  );
}

function StateCell({ state }: { state: string }) {
  const word = TRANSACTION_STATUS[state];
  if (word === null) return <span>{STATE_WORD.posted}</span>;
  return word ? <StatusBadge status={word} /> : <span className="text-text-secondary">{state}</span>;
}

function SortHeader({ label, column, query, onSort, num = false }: {
  label: string;
  column: Query["sortBy"];
  query: Query;
  onSort: (column: Query["sortBy"]) => void;
  num?: boolean;
}) {
  const active = query.sortBy === column;
  return (
    <th
      scope="col"
      className={`${num ? "num " : ""}${active ? "is-sorted" : ""}`.trim() || undefined}
      aria-sort={active ? (query.sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" className="tx-sort" data-active={active} onClick={() => onSort(column)}>
        {label}
        {active && (query.sortDir === "asc" ? <ArrowUp size={16} aria-hidden="true" /> : <ArrowDown size={16} aria-hidden="true" />)}
      </button>
    </th>
  );
}

/**
 * Деньги → Операции: which operations a sum is made of. Reads only. The page of a
 * row is the row's own; the filter only narrows what is shown.
 */
export function TransactionsPage() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const filter = usePageFilter();
  const { pages } = useDashboardShell();
  const { data: auth } = useAuthMe();
  const ofapi = useOfapiStatus(auth?.user.role ?? "team_lead");
  // The operations of OnlyFans go on from the feed: said once under them (build-rules R8).
  const feed = ofapi === "off" && (filter.item ? filter.item.platform === "onlyfans" : pages.some((page) => page.platform === "onlyfans"));
  const screenPeriod = useScreenPeriod();
  const setStored = usePeriodStore((state) => state.setPeriod);
  const period = screenPeriod.key as PeriodOption;
  const exact = search.has("from") || search.has("to");
  const platform = filter.item?.platform === "onlyfans" || (!filter.item && !pages.some((page) => page.platform === "fansly") && pages.some((page) => page.platform === "onlyfans"))
    ? "onlyfans" as const
    : "fansly" as const;
  const parsed = parseTransactionUrl(search, { pageLabel: filter.page, platform, period });
  const params = parsed.success ? parsed.data : undefined;
  const query = useRevenueTransactions(params);
  const data = query.data;
  const compatible = Boolean(data && params && (query.isPlaceholderData || matchesTransactionScope(data, params)));
  const back = search.has("backTo") ? safeBackTo(search) : null;
  const here = `${location.pathname}${location.search}`;
  const showPage = !params?.pageLabel;
  const columns = showPage ? 6 : 5;
  const bothPlatforms = pages.some((page) => page.platform === "fansly") && pages.some((page) => page.platform === "onlyfans");
  const scopeWord = params?.pageLabel ?? "Все страницы";

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    if (!("offset" in changes)) next.delete("offset");
    setSearch(next, { state: location.state });
  }
  function choosePeriod(key: PeriodChoice) {
    if (key === "custom") return;
    // A choice by hand: remembered, and the exact window of a clicked sum goes.
    setStored(key);
    update({ period: key, from: null, to: null });
  }
  function sort(column: Query["sortBy"]) {
    if (!params) return;
    update({ sortBy: column, sortDir: params.sortBy === column && params.sortDir === "desc" ? "asc" : "desc" });
  }

  const periodControl = (
    <Segmented<PeriodChoice>
      className="tx-period"
      label="Период"
      value={exact ? "custom" : period}
      onChange={choosePeriod}
      options={[
        ...PERIODS.map((key) => ({ value: key as PeriodChoice, label: PERIOD_LABELS[key] })),
        { value: "custom" as const, label: "Свои даты", disabled: true, title: exact ? "Окно из ссылки: выберите период, чтобы его сменить" : "Открывается по сумме с Главной" },
      ]}
    />
  );
  const backLink = back && (
    <Link className="btn btn-ghost btn-sm" to={back}>{new URL(back, "http://hub").pathname === "/" ? "На Главную" : "Назад"}</Link>
  );

  let body;
  if (!params) {
    body = (
      <StatusPanel
        title="Некорректная ссылка на операции"
        description="В ссылке нет периода или он задан неверно."
        action={<Link to="/" className="btn btn-sm">К доходу</Link>}
      />
    );
  } else if (!data && query.isError) {
    body = <NoAnswerPanel retry={query.refetch} />;
  } else if (!data) {
    body = <div className="card"><TableSkeleton rows={8} columns={columns} /></div>;
  } else if (!compatible) {
    body = <StatusPanel title="Сервер не подтвердил выбранные фильтры" description="По такому ответу сумму не сверить, поэтому список скрыт." />;
  } else {
    const types = [...reportableTransactionTypes, ...(!params.reportableOnly ? ["payout_reversal"] : [])];
    const filtered = Boolean(params.type || params.state);
    const mayDiffer = !params.pageLabel && !exact && (period === "7d" || period === "30d") && bothPlatforms;
    body = (
      <>
        <StatGrid className="tx-tiles">
          <Stat
            label="Сумма после комиссии"
            value={formatMills(data.summary!.netAmountMills)}
            meta={<>{scopeWord}, {windowWords(params)}{mayDiffer && <span className="tx-differ">Может отличаться от Главной: там у OnlyFans окно на день длиннее.</span>}</>}
          />
          <Stat label="Операций" value={formatCount(data.total)} meta="С учётом выбранных фильтров" />
        </StatGrid>
        <div className="tx-filters">
          <label className="tx-field">
            <span className="field-label">Вид дохода</span>
            <select className="select" value={params.type ?? ""} onChange={(event) => update({ type: event.target.value })}>
              <option value="">Все виды дохода</option>
              {types.map((type) => <option key={type} value={type}>{SOURCE_LABELS[type] ?? type}</option>)}
            </select>
          </label>
          <div className="tx-field">
            <span className="field-label">Статус</span>
            <Segmented<"" | (typeof STATES)[number]>
              label="Статус"
              value={params.state ?? ""}
              onChange={(value) => update({ state: value })}
              options={[{ value: "", label: "Все" }, ...STATES.map((state) => ({ value: state, label: STATE_WORD[state] }))]}
            />
          </div>
          <p className="tx-reportable">
            {params.reportableOnly ? "Только операции, входящие в доход" : "Все операции, и те, что не входят в доход"}
            {" · "}
            <button
              type="button"
              className="link"
              onClick={() => update(params.reportableOnly
                ? { reportableOnly: "false" }
                : { reportableOnly: "true", ...(params.type === "payout_reversal" ? { type: null } : {}) })}
            >
              {params.reportableOnly ? "Показать все" : "Только входящие в доход"}
            </button>
          </p>
        </div>
        <QueryNotice error={query.isError} stale retry={query.refetch} at={query.dataUpdatedAt} />
        {data.items.length === 0 ? (
          data.total > 0 ? (
            <StatusPanel title="На этой странице списка записей нет" action={<button type="button" className="btn btn-sm" onClick={() => update({ offset: null })}>К первой странице</button>} />
          ) : !filtered && params.pageLabel ? (
            <StatusPanel
              title={`На ${params.pageLabel} за ${exact ? "эти дни" : PERIOD_LABELS[period].toLowerCase()} операций нет`}
              action={<button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Показать все страницы</button>}
            />
          ) : (
            <StatusPanel
              title="С этими фильтрами операций нет"
              action={filtered ? <button type="button" className="btn btn-sm" onClick={() => update({ type: null, state: null })}>Сбросить фильтры</button> : undefined}
            />
          )
        ) : (
          <section className={`card${query.isPlaceholderData ? " is-refreshing" : ""}`}>
            <div className="table-wrap">
              <table className="data-table data-table-sticky data-table-page tx-table" aria-label="Операции">
                <thead>
                  <tr>
                    <SortHeader label="Время" column="occurredAt" query={params} onSort={sort} />
                    <th scope="col">Фан</th>
                    {showPage && <th scope="col">Страница</th>}
                    <th scope="col">Вид дохода</th>
                    <th scope="col">Статус</th>
                    <SortHeader label="После комиссии" column="netAmountMills" query={params} onSort={sort} num />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={`${item.pageLabel}:${item.transactionId}`}>
                      <td className="whitespace-nowrap" title={`ID операции: ${item.transactionId} · ${UTC_TIME.format(new Date(item.occurredAt))} UTC`}>
                        {formatDateTime(item.occurredAt, { yearUnlessCurrent: true })}
                      </td>
                      <td><FanCell item={item} backTo={here} /></td>
                      {showPage && <td><Link className="money-link" to={buildPageRoute(item.pageLabel)}>{item.pageLabel}</Link></td>}
                      <td>{SOURCE_LABELS[item.canonicalType] ?? item.canonicalType}</td>
                      <td className="status-col"><StateCell state={item.transactionState} /></td>
                      <td className={`num${item.netAmountMills < 0 ? " delta-down" : ""}`} title={`До комиссии: ${formatMills(item.amountMills)}`}>
                        {formatMills(item.netAmountMills)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination offset={params.offset} limit={params.limit} total={data.total} onPageChange={(offset) => update({ offset: String(offset) })} />
          </section>
        )}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={<>{periodControl}{backLink}</>}
        window={params ? `${scopeWord} · ${windowWords(params)}` : undefined}
        fresh={data?.summary ? { at: data.summary.readAt, refreshing: query.isFetching, onRefresh: () => void query.refetch() } : undefined}
      />
      {body}
      {feed && <p className="home-footnote">{OFAPI_FEED_NOTE}</p>}
      <Disclosure>
        <p>
          Операции, которые сохранил Hub, после комиссии площадок. Сутки считаются по UTC, поэтому операция в 02:40 по
          Москве относится к предыдущим суткам. Сумма совпадает со строкой страницы на Главной за тот же период. У всех
          страниц вместе может быть разница: у OnlyFans окно на день длиннее.
        </p>
      </Disclosure>
    </div>
  );
}
