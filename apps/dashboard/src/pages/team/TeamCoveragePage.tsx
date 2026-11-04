import type { TeamEmptyHoursResponse, TeamGreetingsResponse } from "@agency_hub_core/contracts";
import { sumMills } from "@agency_hub_core/shared";
import { useAuthMe } from "@/api/queries";
import { useTeamEmptyHours, useTeamGreetings } from "@/api/team";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { DisclosureCard } from "@/components/ui/DisclosureCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatCount, formatDateTime, formatDay, formatDuration, formatMills, formatPercent, formatWindowRange } from "@/lib/format";
import { HourMap } from "./HourMap.js";
import { PageLink } from "./teamLinks.js";

/**
 * Команда → Смены → Кто ждал: when fans wrote and nobody was there, who was not
 * greeted, whether broadcasts are answered. Read-only; the owner and team leads.
 * The server reads every page; a chosen page narrows the rows here. Two reads,
 * each its own: the slow greetings never hold the top of the screen.
 */

type EmptyPage = TeamEmptyHoursResponse["pages"][number];
type GreetingsPage = TeamGreetingsResponse["pages"][number];
type Broadcast = TeamGreetingsResponse["broadcasts"][number];

const BROADCASTS_SHOWN = 100;

function share(part: number, whole: number): string {
  return whole === 0 ? "—" : formatPercent((100 * part) / whole);
}

/** «23 мин», «3 ч 5 мин»: no leading zero. */
function delayOf(seconds: number | null): string {
  return seconds === null ? "—" : formatDuration(Math.max(1, Math.round(seconds / 60)));
}

function periodWords(days: number): string {
  return days === 30 ? "за 30 дней" : "за 7 дней";
}

function EmptyHoursTable({ pages }: { pages: readonly EmptyPage[] }) {
  const rows = [...pages].sort((a, b) => {
    if ((a.shiftsSince === null) !== (b.shiftsSince === null)) return a.shiftsSince === null ? 1 : -1;
    return b.emptyHours - a.emptyHours;
  });
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Страница</th>
            <th scope="col" className="num">Часов с фанами</th>
            <th scope="col" className="num">Пустых</th>
            <th scope="col" className="num">Фаны писали</th>
            <th scope="col" className="num">Ждали больше часа</th>
            <th scope="col" className="num">Их траты за 30 дней</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((page) => (
            <tr key={page.pageLabel} className="align-top">
              <td>
                <PageLink label={page.pageLabel} />
                <span className="team-sub">
                  {page.shiftsSince === null ? "смен в расширении ещё не было" : `смены в расширении с ${formatDay(page.shiftsSince)}`}
                </span>
              </td>
              {page.shiftsSince === null ? (
                <>
                  <td className="num muted">—</td><td className="num muted">—</td><td className="num muted">—</td>
                  <td className="num muted">—</td><td className="num muted">—</td>
                </>
              ) : (
                <>
                  <td className="num">{formatCount(page.hoursWithFans)}</td>
                  <td className="num">
                    <span className="font-medium">{formatCount(page.emptyHours)}</span>
                    <span className="team-sub">{share(page.emptyHours, page.hoursWithFans)}</span>
                  </td>
                  <td className="num">
                    {formatCount(page.fans)}
                    <span className="team-sub">платили {formatCount(page.payers)}</span>
                  </td>
                  <td className="num">{formatCount(page.waitedOverHour)}</td>
                  <td className="num">{page.waitedOverHour > 0 ? formatMills(page.waitedNetMills) : "—"}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyHours({ days, page, onAllPages }: { days: number; page: string | null; onAllPages: () => void }) {
  const query = useTeamEmptyHours(days);
  const { data, isLoading, isError, refetch, dataUpdatedAt } = query;
  const pages = (data?.pages ?? []).filter((one) => page === null || one.pageLabel === page);
  const counted = pages.filter((one) => one.shiftsSince !== null);
  const hoursWithFans = counted.reduce((sum, one) => sum + one.hoursWithFans, 0);
  const empty = counted.reduce((sum, one) => sum + one.emptyHours, 0);
  const fans = counted.reduce((sum, one) => sum + one.fans, 0);
  const payers = counted.reduce((sum, one) => sum + one.payers, 0);
  const waited = counted.reduce((sum, one) => sum + one.waitedOverHour, 0);
  const waitedMoney = sumMills(counted.map((one) => one.waitedNetMills));

  return (
    <>
      {data && <PageHeader window={formatWindowRange(data.from, data.to)} fresh={{ at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: query.isFetching }} />}
      {data && <QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} />}
      {!data ? (
        isLoading
          ? <><StatCardSkeleton count={3} /><TableSkeleton rows={4} columns={6} /></>
          : <NoAnswerPanel retry={refetch} />
      ) : pages.length === 0 ? (
        page !== null ? (
          <StatusPanel
            title={`На ${page} ${periodWords(days)} фаны не писали`}
            action={<button type="button" className="btn btn-sm" onClick={onAllPages}>Показать все страницы</button>}
          />
        ) : (
          <StatusPanel title="Фаны не писали" description="За это время ни на одну страницу не пришло сообщений." />
        )
      ) : (
        <div className={`team-stack ${query.isPlaceholderData ? "is-refreshing" : ""}`}>
          <StatGrid className="team-stats-3">
            <Stat
              label="Пустых часов"
              value={<>{formatCount(empty)} <span className="team-of">из {formatCount(hoursWithFans)}</span></>}
              meta={`${share(empty, hoursWithFans)} часов, когда фаны писали`}
            />
            <Stat label="Фаны писали в пустые часы" value={formatCount(fans)} meta={`платили за 30 дней: ${formatCount(payers)}`} />
            <Stat
              label="Ждали больше часа"
              value={formatCount(waited)}
              meta={`их траты за 30 дней ${formatMills(waitedMoney)}: это кто ждал, а не потерянные деньги`}
            />
          </StatGrid>
          <section className="card" aria-labelledby="coverage-map">
            <header className="card-header">
              <div>
                <h2 id="coverage-map" className="card-title">В какие часы пусто</h2>
                <p className="card-description">Сколько раз за период этот час суток был пустым. Время московское.</p>
              </div>
            </header>
            <div className="card-body team-card-flush"><HourMap pages={pages} /></div>
          </section>
          <section className="card" aria-labelledby="coverage-pages">
            <header className="card-header"><h2 id="coverage-pages" className="card-title">По страницам</h2></header>
            <EmptyHoursTable pages={pages} />
          </section>
        </div>
      )}
    </>
  );
}

function GreetingsTable({ pages }: { pages: readonly GreetingsPage[] }) {
  return (
    <div className="table-wrap">
      <table className="data-table team-wrap-head">
        <thead>
          <tr>
            <th scope="col">Страница</th>
            <th scope="col" className="num">Новых подписчиков</th>
            <th scope="col" className="num">Автоприветствие</th>
            <th scope="col" className="num">Лично за 24 ч</th>
            <th scope="col" className="num">Ответили за час</th>
            <th scope="col" className="num">Купили за 7 дней</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((page) => {
            const notGreeted = page.newSubscribers - page.greeted;
            return (
              <tr key={page.pageLabel} className="align-top">
                <td>
                  <PageLink label={page.pageLabel} />
                  {page.recent > 0 && <span className="team-sub whitespace-nowrap">у {formatCount(page.recent)} из них 7 дней ещё не прошли</span>}
                </td>
                <td className="num font-medium">{formatCount(page.newSubscribers)}</td>
                <td className="num">{page.newSubscribers === 0 ? "—" : share(page.autoWelcomed, page.newSubscribers)}</td>
                <td className="num num-wrap">
                  {formatCount(page.greeted)}
                  {page.greeted > 0 && <span className="team-sub">{share(page.greeted, page.newSubscribers)}, медиана {delayOf(page.greetingMedianSeconds)}</span>}
                </td>
                <td className="num">
                  {formatCount(page.repliedWithinHour)}
                  {page.greeted > 0 && <span className="team-sub">{share(page.repliedWithinHour, page.greeted)}</span>}
                </td>
                <td className="num num-wrap">
                  <span className="team-line">{page.greeted > 0 ? `с личным ${share(page.boughtGreeted, page.greeted)}: ${page.boughtGreeted} из ${page.greeted}` : "с личным —"}</span>
                  <span className="team-sub">{notGreeted > 0 ? `без личного ${share(page.boughtNotGreeted, notGreeted)}: ${page.boughtNotGreeted} из ${notGreeted}` : "без личного —"}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BroadcastsBlock({ pages, broadcasts, owner }: { pages: readonly GreetingsPage[]; broadcasts: readonly Broadcast[]; owner: boolean }) {
  const sending = pages.filter((page) => page.broadcasts.sent > 0);
  return (
    <DisclosureCard
      title="Рассылки: отвечают ли"
      description="Рассылки Fansly и один текст пяти и больше фанам за час: ответили ли за сутки, купили ли за 7 дней."
      meta={`${formatCount(broadcasts.length)} за период`}
    >
      <div className="team-fold-tables">
        {sending.length === 0 ? <p className="team-card-inner team-card-top team-muted">Рассылок не было.</p> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Страница</th>
                  <th scope="col" className="num">Рассылок</th>
                  <th scope="col" className="num">Доставок</th>
                  <th scope="col" className="num">Ответили</th>
                  <th scope="col" className="num">Купили</th>
                </tr>
              </thead>
              <tbody>
                {sending.map((page) => (
                  <tr key={page.pageLabel}>
                    <td><PageLink label={page.pageLabel} /></td>
                    <td className="num">{formatCount(page.broadcasts.sent)}</td>
                    <td className="num">{formatCount(page.broadcasts.deliveries)}</td>
                    <td className="num">{share(page.broadcasts.replied, page.broadcasts.deliveries)}</td>
                    <td className="num">{formatCount(page.broadcasts.bought)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {broadcasts.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Когда и где</th>
                  <th scope="col">Текст</th>
                  <th scope="col" className="num">Цена</th>
                  <th scope="col" className="num">Доставок</th>
                  <th scope="col" className="num">Ответили за 24 ч</th>
                  <th scope="col" className="num">Купили за 7 дней</th>
                </tr>
              </thead>
              <tbody>
                {broadcasts.slice(0, BROADCASTS_SHOWN).map((cast) => (
                  <tr key={`${cast.pageLabel}:${cast.sentAt}:${cast.priceMills ?? 0}`} className="align-top">
                    <td className="whitespace-nowrap">
                      {formatDateTime(cast.sentAt)}
                      <span className="team-sub">{cast.pageLabel}, {cast.massMessage ? "рассылка Fansly" : "один текст многим"}</span>
                    </td>
                    <td className="team-text-cell">
                      {cast.preview ? <details className="team-clamp"><summary>{cast.preview}</summary>{cast.preview}</details> : <span className="team-muted">без текста</span>}
                      {cast.files > 0 && <span className="team-sub">файлов: {cast.files}</span>}
                    </td>
                    <td className="num">{cast.priceMills === null ? "—" : formatMills(cast.priceMills)}</td>
                    <td className="num">{formatCount(cast.deliveries)}</td>
                    <td className="num">
                      {formatCount(cast.replied)}
                      <span className="team-sub">{share(cast.replied, cast.deliveries)}</span>
                    </td>
                    <td className="num">
                      {formatCount(cast.bought)}
                      {cast.priceMills !== null && <span className="team-sub">именно эту: {cast.ppvBought}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(broadcasts.length >= BROADCASTS_SHOWN || owner) && (
          <div className="team-card-inner team-card-top">
            {broadcasts.length >= BROADCASTS_SHOWN && <p className="team-muted">Показаны последние {BROADCASTS_SHOWN}.</p>}
            {owner && <p className="team-muted">Рассылки по данным Fansly — на карточке страницы, вкладка «Рассылки». Там другие числа.</p>}
          </div>
        )}
      </div>
    </DisclosureCard>
  );
}

function Greetings({ days, page, owner }: { days: number; page: string | null; owner: boolean }) {
  const query = useTeamGreetings(days);
  const { data, isLoading, isError, refetch, dataUpdatedAt } = query;
  const pages = (data?.pages ?? []).filter((one) => page === null || one.pageLabel === page);
  const broadcasts = (data?.broadcasts ?? []).filter((one) => page === null || one.pageLabel === page);
  return (
    <>
      <section className="card" aria-labelledby="coverage-greetings">
        <header className="card-header">
          <div>
            <h2 id="coverage-greetings" className="card-title">Приветствия новых подписчиков</h2>
            <p className="card-description">Кого поприветствовали лично, как быстро, и купили ли после этого.</p>
          </div>
        </header>
        {data && <div className="team-card-inner"><QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} /></div>}
        {!data
          ? (isLoading ? <TableSkeleton rows={4} columns={6} /> : <NoAnswerPanel retry={refetch} />)
          : pages.length === 0
            ? <StatusPanel title="Новых подписчиков и рассылок нет" description="За это время никто не подписался и рассылок не было." />
            : <div className={query.isPlaceholderData ? "is-refreshing" : ""}><GreetingsTable pages={pages} /></div>}
      </section>
      {data && pages.length > 0 && <BroadcastsBlock pages={pages} broadcasts={broadcasts} owner={owner} />}
    </>
  );
}

function HowItCounts() {
  return (
    <Disclosure>
      <p>
        Час пустой, если фаны в нём писали, а на этой странице ни одной минуты никто из команды не был на смене: расширение
        ChatGoose открыто, и чаттер что-то делал на странице не больше часа назад. Расширение, забытое открытым на ночь,
        смены не делает. Считается с первой смены страницы в расширении: раньше Hub не отличит пустой час от работы с
        телефона.
      </p>
      <p>
        «Ждали больше часа» — после сообщения в пустой час личный ответ пришёл позже чем через час или его ещё нет (рассылка
        Fansly и один текст пяти и больше фанам за час ответом не считаются). Траты — сколько фан потратил на этой странице
        за последние 30 дней, после комиссии: это кто ждал, а не потерянные деньги.
      </p>
      <p>
        Новые подписчики — подписки, начавшиеся за период, у фанов, которые раньше ничего не покупали на странице и не
        переписывались с ней: продление и возвращение не считаются. Сообщение страницы в первые 2 минуты после подписки
        без автора из команды — автоприветствие. Личное приветствие — первое сообщение за 24 часа после подписки,
        написанное чаттером или пришедшее позже 2 минут, не рассылка Fansly и не один текст пяти и больше фанам за час.
      </p>
      <p>
        «Ответили за час» — фан написал в течение часа после личного приветствия. «Купили за 7 дней» — любая покупка, кроме
        подписки, в 7 дней после подписки: отдельно у поприветствованных лично и у остальных. У подписавшихся в последние
        7 дней срок ещё идёт.
      </p>
      <p>
        Рассылки — массовые сообщения Fansly и один текст пяти и больше фанам за час, одна строка на текст и день.
        «Ответили» — фан написал в 24 часа после неё, «купили» — любая покупка, кроме подписки, за 7 дней; у платной —
        купил ли фан её саму: Hub связал покупку с ней, или фан купил сообщение по её цене за 7 дней, и до покупки ему
        не приходило другое платное по той же цене.
      </p>
      <p>Это ориентир, а не основание для оплаты.</p>
    </Disclosure>
  );
}

export function TeamCoveragePage() {
  const { data: me } = useAuthMe();
  const owner = me?.user.role === "owner";
  const { days: shownDays } = useScreenPeriod();
  const days = shownDays === 30 ? 30 : 7;
  const filter = usePageFilter();
  return (
    <div className="team-screen">
      <EmptyHours days={days} page={filter.page} onAllPages={() => filter.select(null)} />
      <Greetings days={days} page={filter.page} owner={owner} />
      <HowItCounts />
    </div>
  );
}
