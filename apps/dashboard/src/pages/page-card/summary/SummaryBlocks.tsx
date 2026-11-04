import { useMemo } from "react";
import { Link, useLocation } from "react-router";
import { BUSINESS_TIME_ZONE, toBusinessDate, type Platform } from "@agency_hub_core/shared";
import {
  usePageFollowersDaily,
  usePageRevenue,
  usePageSubscribers,
  usePageSubscribersDaily,
  usePageTransactions,
  useSpenders,
} from "@/api/queries";
import { useTeamShifts } from "@/api/team";
import { DayChart } from "@/components/creator-stats/DayChart";
import { ChartTable } from "@/components/charts/ChartTable";
import { MoneyDelta } from "@/components/money/Delta";
import { IncomeKinds, incomeKindRows } from "@/components/money/IncomeKinds";
import { RevenueDailyCard } from "@/components/money/RevenueDailyCard";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TransactionState } from "@/components/shared/TransactionsPreviewPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatBusinessDateShort, formatCount, formatDateTime, formatDuration, formatMills, formatUpdated, transactionTypeLabel } from "@/lib/format";
import { buildFanProfileNavigation, buildFansRoute, buildPageCollectionRoute, buildPageSectionRoute } from "@/lib/navigation";
import { buildRevenueTransactionsRoute } from "@/lib/overviewNavigation";
import { revenuePreviousLabel, revenueWindowLabel } from "@/lib/revenueWindow";
import { OFAPI_FEED_NOTE, OFAPI_FROZEN_NOTE, STAFF_STATUS, TEAM_STATUS, type OfapiStatus } from "@/lib/statusWords";
import { fanName, isAwaitingReply } from "@/pages/fans/fanWords";
import { useStaffList } from "@/pages/fans/fan-card/FanNotes";
import { useAllPayers } from "@/pages/fans/useAllPayers";
import type { PageCollection } from "../usePageCollection.js";

export interface SummaryPage {
  id: number;
  label: string;
  platform: Platform;
  followerCount: { value: number | null; available: boolean } | null | undefined;
  lastLightSyncAt: string | null;
}

const PERIOD_WORDS: Readonly<Record<string, string>> = { today: "сегодня", "7d": "за 7 дней", "30d": "за 30 дней", all: "за всё время" };

function periodWords(period: string): string {
  return PERIOD_WORDS[period] ?? "за период";
}

/** «Деньги»: the same parts as on Главная, for one page. Nothing is summed here. */
export function MoneyBlock({ page, period, onShowThirty, onShowWeek }: { page: SummaryPage; period: string; onShowThirty: () => void; onShowWeek: () => void }) {
  const location = useLocation();
  const revenue = usePageRevenue(page.label, period);
  const report = revenue.data;
  const backTo = `${location.pathname}${location.search}`;
  const compare = period !== "all" && period !== "today";
  const previousLabel = report ? revenuePreviousLabel(report.platformWindows) : null;

  const header = report
    ? <PageHeader window={revenueWindowLabel({ windows: report.platformWindows, period })} />
    : null;

  if (!report) {
    return (
      <section className="card" aria-label="Деньги">
        <div className="card-header"><h2 className="card-title">Деньги</h2><span className="fan-card-meta">{periodWords(period)}</span></div>
        <div className="card-body">{revenue.isError ? <NoAnswerPanel retry={revenue.refetch} /> : <><Skeleton width={180} className="!h-9" /><div className="mt-4"><TableSkeleton rows={4} columns={4} /></div></>}</div>
      </section>
    );
  }
  const rows = incomeKindRows(report);
  const window = report.platformWindows[0] ?? null;
  const empty = report.netEarningsMills === 0 && rows.every((row) => row.currentNetMills === 0);

  return (
    <>
      {header}
      <section className="card" aria-labelledby="summary-money-title">
        <div className="card-header">
          <h2 id="summary-money-title" className="card-title">Деньги</h2>
          <span className="fan-card-meta">{periodWords(period)}</span>
        </div>
        {empty ? (
          <div className="card-body">
            <StatusPanel
              title={`На ${page.label} ${periodWords(period)} операций нет`}
              action={period !== "30d" && period !== "all" ? <button type="button" className="btn btn-sm" onClick={onShowThirty}>Показать 30 дней</button> : undefined}
            />
          </div>
        ) : (
          <>
            <div className="summary-money-head">
              <p className="summary-money-value">{formatMills(report.netEarningsMills)}</p>
              <p className="summary-money-meta">
                после комиссии
                {compare && report.comparison
                  ? <> · <MoneyDelta mills={report.comparison.deltaNetMills} pct={report.comparison.deltaPct} />{previousLabel ? ` к ${previousLabel}` : ""}</>
                  : null}
              </p>
            </div>
            <IncomeKinds
              rows={rows}
              label={`Виды дохода ${page.label}`}
              compare={compare}
              amountLink={(row, previous) => {
                const value = previous ? row.previousNetMills : row.currentNetMills;
                if (value === null || !window) return null;
                return buildRevenueTransactionsRoute({
                  pageLabel: page.label,
                  from: previous ? window.comparisonFrom : window.from,
                  to: previous ? window.comparisonTo : window.to,
                  type: row.canonicalType as Parameters<typeof buildRevenueTransactionsRoute>[0]["type"],
                  backTo,
                });
              }}
            />
          </>
        )}
        <div className="card-footer">
          <span>{page.platform === "onlyfans" ? OFAPI_FEED_NOTE : "После комиссии площадки, по операциям, которые сохранил Hub."}</span>
          <Link className="link" to={`/?${new URLSearchParams({ page: page.label, period })}`}>Открыть на Главной</Link>
        </div>
      </section>
      {!empty && (
        <RevenueDailyCard
          scope={`page:${page.label}`}
          period={period}
          windowAt={report.windowAt}
          windows={report.platformWindows}
          totalMills={report.netEarningsMills}
          allowMonthly
          onShowWeek={onShowWeek}
        />
      )}
    </>
  );
}

function CountRow({ label, value, note, to }: { label: string; value: React.ReactNode; note?: string | null | undefined; to?: string | undefined }) {
  const body = (
    <>
      <span className="summary-row-label">{label}</span>
      <span className="summary-row-value">
        {value}
        {note && <span className="summary-row-note">{note}</span>}
      </span>
    </>
  );
  return <li>{to ? <Link to={to} className="summary-row">{body}</Link> : <div className="summary-row">{body}</div>}</li>;
}

function countOf(query: { data?: { total: number } | undefined; isError: boolean; refetch: () => unknown }) {
  if (query.data) return formatCount(query.data.total);
  if (query.isError) return <span className="summary-row-failed">не удалось проверить <button type="button" className="link" onClick={(event) => { event.preventDefault(); void query.refetch(); }}>Повторить</button></span>;
  return <Skeleton width={40} />;
}

/** «Аудитория сейчас»: subscriptions, followers, the new ones by day. */
export function AudienceBlock({ page, period, ofapi }: { page: SummaryPage; period: string; ofapi: OfapiStatus }) {
  const fansly = page.platform === "fansly";
  const frozen = page.platform === "onlyfans" && ofapi === "off" ? OFAPI_FROZEN_NOTE : null;
  const paid = usePageSubscribers(page.label, { limit: 1, paid: true }, { suppressGlobalError: true });
  const free = usePageSubscribers(page.label, { limit: 1, paid: false }, { suppressGlobalError: true });
  const chartPeriod = period === "today" ? "7d" : period;
  const followersDaily = usePageFollowersDaily(page.label, chartPeriod, { enabled: fansly });
  const subscribersDaily = usePageSubscribersDaily(page.label, chartPeriod, { enabled: !fansly });
  const daily = fansly ? followersDaily : subscribersDaily;
  const rows = useMemo(() => fansly
    ? (followersDaily.data?.items ?? []).map((item) => ({ bucketStart: item.businessDate, value: item.newFollowers }))
    : (subscribersDaily.data?.items ?? []).map((item) => ({ bucketStart: item.businessDate, value: item.newSubscribers })), [fansly, followersDaily.data, subscribersDaily.data]);
  const today = rows.at(-1);
  const chartTitle = fansly ? "Новые фолловеры" : "Новые подписки";

  return (
    <section className="card" aria-labelledby="summary-audience-title">
      <div className="card-header">
        <h2 id="summary-audience-title" className="card-title">Аудитория</h2>
        <span className="fan-card-meta">сейчас</span>
      </div>
      <ul className="summary-rows">
        <CountRow label="Платные подписки" value={countOf(paid)} note={frozen} to={buildFansRoute("subscribers", page.label, { filter: "paid" })} />
        <CountRow label="Бесплатные подписки" value={countOf(free)} note={frozen} to={buildFansRoute("subscribers", page.label, { filter: "free" })} />
        {fansly && (
          <CountRow
            label="Фолловеры"
            value={page.followerCount?.available && page.followerCount.value !== null ? formatCount(page.followerCount.value) : "—"}
            to={buildFansRoute("followers", page.label)}
          />
        )}
      </ul>
      <div className="summary-chart">
        <h3 className="fan-subtitle">{chartTitle}{frozen && <span className="summary-row-note"> · {frozen}</span>}</h3>
        {!daily.data ? (
          daily.isError ? <NoAnswerPanel retry={daily.refetch} /> : <Skeleton width="100%" className="!h-[160px]" />
        ) : period === "today" ? (
          <p className="summary-today">Новых сегодня: <span className="tabular-nums">{formatCount(today?.bucketStart === toBusinessDate(new Date(), BUSINESS_TIME_ZONE) ? Number(today.value) : 0)}</span></p>
        ) : rows.length === 0 ? (
          <p className="fan-muted-line">Данных по дням пока нет.</p>
        ) : (
          <>
            <DayChart lines rows={rows} series={[{ key: "value", label: chartTitle, color: "var(--color-chart-blue)" }]} height={180} />
            <ChartTable
              rows={rows}
              rowKey={(row) => row.bucketStart}
              caption={chartTitle}
              columns={[
                { key: "day", label: "День", value: (row) => formatBusinessDateShort(row.bucketStart) },
                { key: "value", label: fansly ? "Новых фолловеров" : "Новых подписок", num: true, value: (row) => formatCount(Number(row.value)) },
              ]}
            />
          </>
        )}
      </div>
    </section>
  );
}

/** «На этой странице»: what the team should look at. Not the owner's queue: no accent. */
export function OnPageBlock({ page, ofapi }: { page: SummaryPage; ofapi: OfapiStatus }) {
  const expiring = usePageSubscribers(page.label, { limit: 1, expiringWithinDays: 7, autoRenew: false }, { suppressGlobalError: true });
  const payers = useAllPayers(page.label);
  const silent = useSpenders({ scope: "page", pageLabel: page.label, period: "lifetime", limit: 1, retentionStatus: "needs_reactivation" });
  const awaiting = payers.data ? payers.data.items.filter((row) => isAwaitingReply(row.conversation)).length : null;
  const muted = (value: number | null | undefined) => value === 0 ? "summary-zero" : undefined;
  const frozen = page.platform === "onlyfans" && ofapi === "off" ? OFAPI_FROZEN_NOTE : null;

  return (
    <section className="card" aria-labelledby="summary-onpage-title">
      <div className="card-header"><h2 id="summary-onpage-title" className="card-title">На этой странице</h2></div>
      <ul className="summary-rows">
        <CountRow
          label="Кончаются за 7 дней, без автопродления"
          value={<span className={muted(expiring.data?.total)}>{countOf(expiring)}</span>}
          note={frozen}
          to={buildFansRoute("subscribers", page.label, { filter: "expiring7d", norenew: "1" })}
        />
        <CountRow
          label="Платящие ждут ответа"
          value={awaiting !== null
            ? <span className={muted(awaiting)}>{formatCount(awaiting)}</span>
            : countOf({ data: undefined, isError: payers.isError, refetch: payers.refetch })}
          to={buildFansRoute("paying", page.label, { awaiting: "1" })}
        />
        <CountRow
          label="Ценные молчат"
          value={<span className={muted(silent.data?.total)}>{countOf(silent)}</span>}
          to={buildFansRoute("paying", page.label, { filter: "needs_reactivation" })}
        />
      </ul>
    </section>
  );
}

/** «Вход и сбор»: the word, why, and the owner's way to fix it. */
export function CollectionBlock({ page, collection, owner, compact = false }: { page: SummaryPage; collection: PageCollection; owner: boolean; compact?: boolean }) {
  if (page.platform === "telegram" || collection.hidden) return null;
  const word = collection.word;
  const fresh = collection.kind === "working" && page.lastLightSyncAt ? formatUpdated(page.lastLightSyncAt) : null;
  return (
    <section className={`card ${compact ? "summary-collection-compact" : ""}`} aria-labelledby="summary-collection-title">
      <div className="card-header"><h2 id="summary-collection-title" className="card-title">Вход и сбор</h2></div>
      <div className="card-body summary-collection">
        <div className="summary-collection-word">
          {word === null ? <Skeleton width={96} /> : <StatusBadge status={word} />}
          {collection.reason && collection.kind !== "working" && <span className="summary-row-note">{collection.reason}</span>}
          {fresh && <span className="summary-row-note">{fresh}</span>}
        </div>
        {owner && (
          <div className="summary-collection-actions">
            {page.platform === "fansly" && <Link className="btn btn-sm" to={buildPageSectionRoute(page.label, "browser-login")}>Войти в Fansly</Link>}
            {page.platform === "onlyfans" && <Link className="link" to="/system/onlyfans-api">OnlyFans API</Link>}
            <Link className="link" to={buildPageCollectionRoute(page.label)}>Сбор данных страницы</Link>
          </div>
        )}
      </div>
    </section>
  );
}

/** «Кто работает»: the people of the page and who is on a shift now. The owner's. */
export function PeopleBlock({ page }: { page: SummaryPage }) {
  const staff = useStaffList(true);
  const range = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - 24 * 3_600_000).toISOString(), to: to.toISOString() };
  }, []);
  const shifts = useTeamShifts({ ...range, pageLabel: page.label });
  const people = (staff.data ?? [])
    .filter((user) => user.role !== "owner" && !user.disabledAt && !user.deletedAt && user.assignedPages.some((item) => item.label === page.label));
  const onShift = new Map((shifts.data?.shifts ?? []).filter((shift) => shift.ongoing).map((shift) => [shift.userId, shift]));
  const sorted = [...people].sort((a, b) => Number(onShift.has(b.id)) - Number(onShift.has(a.id)) || a.username.localeCompare(b.username));

  return (
    <section className="card" aria-labelledby="summary-people-title">
      <div className="card-header"><h2 id="summary-people-title" className="card-title">Кто работает</h2></div>
      {!staff.data ? (
        <div className="card-body">{staff.isError ? <NoAnswerPanel retry={staff.refetch} /> : <Skeleton width="60%" />}</div>
      ) : sorted.length === 0 ? (
        <div className="card-body"><p className="fan-muted-line">На этой странице никого не назначили. <Link className="link" to="/team/people">Сотрудники</Link></p></div>
      ) : (
        <ul className="summary-rows">
          {sorted.map((user) => {
            const shift = onShift.get(user.id);
            const to = user.role === "chatter" ? `/team/chatters/${user.id}` : `/team/people/${user.id}`;
            return (
              <li key={user.id}>
                <div className="summary-row">
                  <span>
                    <Link className="fan-link" to={to}>{user.username}</Link>
                    <span className="summary-row-note">
                      {user.role === "chatter" ? "чаттер" : "тимлид"}
                      {user.registrationState === "invited" && ` · ${STAFF_STATUS.invited!.word}`}
                    </span>
                  </span>
                  {shift && (
                    <span className="summary-shift">
                      <StatusBadge status={TEAM_STATUS.onShift} />
                      <span className="tabular-nums">{formatDuration(shift.workedMinutes)}</span>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {staff.data && shifts.isError && <p className="card-footer">Смены не пришли</p>}
    </section>
  );
}

/** «Последние операции»: five rows and the way to all of them. */
export function LastOperationsBlock({ page }: { page: SummaryPage }) {
  const location = useLocation();
  const query = usePageTransactions(page.label, { limit: 5 });
  const here = `${location.pathname}${location.search}`;
  return (
    <section className="card" aria-labelledby="summary-ops-title">
      <div className="card-header"><h2 id="summary-ops-title" className="card-title">Последние операции</h2></div>
      {!query.data ? (
        query.isError ? <div className="card-body"><NoAnswerPanel retry={query.refetch} /></div> : <TableSkeleton rows={5} columns={5} />
      ) : query.data.items.length === 0 ? (
        <div className="card-body"><p className="fan-muted-line">Операций пока нет.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="data-table fan-table">
            <thead>
              <tr>
                <th scope="col">Когда</th>
                <th scope="col">Фан</th>
                <th scope="col">Вид дохода</th>
                <th scope="col">Статус</th>
                <th scope="col" className="num">После комиссии</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((item) => {
                const fan = item.fan ? fanName({ ...item.fan, platform: page.platform }) : null;
                const nav = item.fan && fan && !fan.deleted ? buildFanProfileNavigation(page.label, page.platform, item.fan.platformUserId, here, fan.label) : null;
                return (
                  <tr key={item.transactionId}>
                    <td>{formatDateTime(item.occurredAt, { yearUnlessCurrent: true })}</td>
                    <td>{nav && fan ? <Link className="fan-link" to={nav.to} state={nav.state}>{fan.label}</Link> : fan ? <span className="muted">{fan.label}</span> : "—"}</td>
                    <td>{transactionTypeLabel(item.canonicalType)}</td>
                    <td className="status-col"><TransactionState state={item.transactionState} /></td>
                    <td className="num">{formatMills(item.netAmountMills)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-footer">
        <span />
        <Link className="link" to={`/money/transactions?${new URLSearchParams({ page: page.label })}`}>Все операции</Link>
      </div>
    </section>
  );
}

/** «Перейти»: one line of links. They narrow the screens they open; the remembered filter stays. */
export function GoLinks({ page, owner }: { page: SummaryPage; owner: boolean }) {
  const q = (path: string, extra: Record<string, string> = {}) => `${path}?${new URLSearchParams({ page: page.label, ...extra })}`;
  const links: Array<{ label: string; to: string }> = [];
  if (page.platform !== "telegram") {
    links.push({ label: "Фаны этой страницы", to: q("/fans") });
    links.push({ label: "Списки по сумме трат", to: q("/fans/by-spend") });
    links.push({ label: "Операции", to: q("/money/transactions") });
  }
  if (owner && page.platform === "fansly") links.push({ label: "Статистика", to: q("/stats") });
  if (owner && page.platform !== "telegram") {
    links.push({ label: "Публикации", to: q("/publications") });
    links.push({ label: "Настройки публикации", to: q("/publications", { panel: "settings" }) });
  }
  if (page.platform === "onlyfans") {
    links.push({ label: "Медиатека OnlyFans", to: "/system/onlyfans-api/media" });
    links.push({ label: "Выгрузки", to: "/system/onlyfans-api/exports" });
  }
  if (owner) links.push({ label: "Изменить страницу", to: `/settings/pages#page-${page.label}` });
  if (links.length === 0) return null;
  return (
    <nav className="summary-go" aria-label="Перейти">
      <span className="summary-go-label">Перейти</span>
      {links.map((link) => <Link key={link.label} className="link" to={link.to}>{link.label}</Link>)}
    </nav>
  );
}
